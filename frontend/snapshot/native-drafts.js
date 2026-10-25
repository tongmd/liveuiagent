// Native form drafts only. Business records remain authoritative on the server.
(function (global) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  function get(data, path) {
    let value = data;
    for (const key of path.replace(/^\//, '').split('/').filter(Boolean)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !value || typeof value !== 'object') return undefined;
      value = value[key];
    }
    return value;
  }
  function put(data, path, value) {
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    if (!parts.length || parts.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) return;
    let node = data;
    for (const key of parts.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) return;
      node = node[key];
    }
    node[parts.at(-1)] = value;
  }
  function schema(app) {
    const components = new Map();
    for (const message of app.appPackage?.ui?.meta?.a2ui?.messages || []) {
      for (const component of message.updateComponents?.components || []) components.set(component.id, component);
    }
    const fields = [...components.values()].filter(component => component.component === 'TextField' && typeof component.value?.path === 'string'
      && !/password|credential|secret|token|api[_-]?key/i.test([component.variant, component.label, component.id, component.value.path].map(value => String(value || '')).join(' ')));
    const actions = [...components.values()].filter(component => component.component === 'Button').map(component => {
      const event = component.action?.event;
      return { id: component.id, event: event && { name: event.name, context: Object.fromEntries(Object.entries(event.context || {}).map(([key, value]) => [key,
        value && typeof value.path === 'string' ? { path: value.path } : { literalType: typeof value }])) } };
    });
    const paths = [...new Set(fields.map(field => field.value.path))];
    const actionPaths = Object.fromEntries(actions.filter(action => action.event?.name).map(action => {
      const bindings = Object.values(action.event.context || {}).filter(value => value && typeof value.path === 'string').map(value => value.path);
      return [action.event.name.replace(/^actions\./, ''), paths.filter(path => bindings.some(binding => path === binding || path.startsWith(binding.replace(/\/$/, '') + '/')))];
    }));
    return { paths, actionPaths, signature: JSON.stringify(canonical({ fields: fields.map(field => ({ id: field.id, value: field.value, variant: field.variant, options: field.options })), actions })) };
  }
  async function ownerScope() {
    const base = new URL('.', global.location.href);
    const response = await global.fetch(new URL('agent/identity', base), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw Error('Draft identity unavailable');
    const data = await response.json();
    if (typeof data.ownerScope !== 'string' || !/^[a-f0-9]{64}$/i.test(data.ownerScope)) throw Error('Invalid draft identity');
    return data.ownerScope;
  }
  async function hash(text) {
    // HTTP deployments do not expose SubtleCrypto; the full canonical schema is collision-free.
    if (!global.crypto?.subtle) return 'schema:' + encodeURIComponent(text);
    const bytes = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  class Draft {
    constructor(app, data, notify, options = {}) {
      this.app = app; this.server = clone(data); this.data = clone(data); this.notify = notify;
      this.schema = schema(app); this.dirty = new Set(); this.revisions = new Map(); this.pendingClear = {}; this.closed = false; this.queue = Promise.resolve();
      this.identity = options.identity || ownerScope; this.storage = options.storage || (() => global.localStorage);
      this.hash = options.hash || hash; this.delay = options.delay ?? 250;
      this.ready = this.initialize();
      this.pageHide = () => this.flushStored();
      global.addEventListener?.('pagehide', this.pageHide);
    }
    values() { return Object.fromEntries(this.schema.paths.filter(path => typeof get(this.data, path) === 'string').map(path => [path, get(this.data, path)])); }
    read() {
      const raw = this.storage().getItem(this.key);
      if (!raw) return {};
      const stored = JSON.parse(raw);
      if (stored.version !== 1 || stored.ownerScope !== this.scope || stored.appId !== this.app.appId || stored.schema !== this.schemaHash || !stored.values || typeof stored.values !== 'object') return {};
      return Object.fromEntries(this.schema.paths.filter(path => typeof stored.values[path] === 'string').map(path => [path, stored.values[path]]));
    }
    write(values) {
      if (!Object.keys(values).length) { this.storage().removeItem(this.key); return; }
      this.storage().setItem(this.key, JSON.stringify({ version: 1, ownerScope: this.scope, appId: this.app.appId, schema: this.schemaHash, values, updatedAt: new Date().toISOString() }));
    }
    async initialize() {
      try {
        this.scope = await this.identity(); this.schemaHash = await this.hash(this.schema.signature);
        this.key = `liveui.native-draft.v1:${this.scope}:${encodeURIComponent(this.app.appId)}:${this.schemaHash}`;
        const stored = this.read();
        if (this.closed) return;
        for (const [path, value] of Object.entries(stored)) if (!this.dirty.has(path)) { put(this.data, path, value); this.dirty.add(path); }
        this.notify(clone(this.data));
      } catch { this.key = null; } // Read/identity failure keeps the current in-memory input.
    }
    updateServer(data) {
      this.server = clone(data); const next = clone(data);
      for (const path of this.dirty) if (typeof get(this.data, path) === 'string') put(next, path, get(this.data, path));
      this.data = next; this.notify(clone(next));
    }
    mutate(mutator) {
      const next = clone(this.data); mutator(next);
      for (const path of this.schema.paths) if (get(next, path) !== get(this.data, path)) { this.dirty.add(path); this.revisions.set(path, (this.revisions.get(path) || 0) + 1); }
      this.data = next; this.notify(clone(next)); this.schedule();
    }
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.persist(), this.delay); }
    flushStored() {
      if (!this.key) return;
      try {
        const stored = this.read();
        for (const [path, value] of Object.entries(this.pendingClear)) if (stored[path] === value) delete stored[path];
        for (const path of this.dirty) if (typeof get(this.data, path) === 'string') stored[path] = get(this.data, path);
        this.write(stored); this.pendingClear = {};
      } catch { /* Never replace current input when storage is unavailable. */ }
    }
    persist(completedSnapshot) {
      if (completedSnapshot) Object.assign(this.pendingClear, completedSnapshot);
      clearTimeout(this.timer);
      this.queue = this.queue.catch(() => {}).then(async () => {
        await this.ready;
        if (!this.key) return;
        try {
          // A stale tab must never write its input into a newly signed-in account.
          if (await this.identity() !== this.scope) { this.key = null; return; }
          this.flushStored();
        } catch { /* A storage failure must not replace or clear live input. */ }
      });
      return this.queue;
    }
    snapshot(actionId) {
      const allowed = actionId === undefined ? this.schema.paths : this.schema.actionPaths[actionId.replace(/^actions\./, '')] || [];
      const values = Object.fromEntries(Object.entries(this.values()).filter(([path]) => allowed.includes(path))); for (const path of Object.keys(values)) this.dirty.add(path);
      this.persist(); return { values, revisions: Object.fromEntries(this.revisions) };
    }
    complete(snapshot) {
      const cleared = {};
      for (const [path, value] of Object.entries(snapshot.values)) if (get(this.data, path) === value && (this.revisions.get(path) || 0) === (snapshot.revisions[path] || 0)) {
        this.dirty.delete(path); cleared[path] = value; const serverValue = get(this.server, path);
        if (typeof serverValue === 'string') put(this.data, path, serverValue);
      }
      this.notify(clone(this.data)); return this.persist(cleared);
    }
    close() { this.closed = true; clearTimeout(this.timer); this.flushStored(); this.persist(); global.removeEventListener?.('pagehide', this.pageHide); }
  }
  function useDraft(React, app, serverData, onAction) {
    const [data, setData] = React.useState(() => clone(serverData));
    const holder = React.useRef(null);
    const signature = schema(app).signature;
    React.useEffect(() => {
      const draft = new Draft(app, serverData, value => { if (!draft.closed) setData(value); });
      holder.current = draft; setData(clone(serverData));
      return () => { draft.close(); if (holder.current === draft) holder.current = null; };
    }, [app.appId, signature]);
    React.useEffect(() => { holder.current?.updateServer(serverData); }, [serverData]);
    function mutate(mutator) { holder.current?.mutate(mutator); }
    async function dispatch(actionId, payload) {
      const draft = holder.current; const snapshot = draft?.snapshot(actionId);
      const succeeded = await onAction(app.appId, actionId, payload);
      if (succeeded === true && snapshot) await draft.complete(snapshot);
      return succeeded;
    }
    return [data, mutate, dispatch];
  }
  global.LiveUINativeDrafts = { Draft, schema, useDraft };
})(typeof window === 'object' ? window : globalThis);
