import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function hostController() {
  const form = document.getElementById('liveui-task-form');
  const input = document.getElementById('liveui-task');
  const submit = document.getElementById('liveui-task-submit');
  const status = document.getElementById('liveui-task-status');
  const result = document.getElementById('liveui-task-result');
  const entities = document.getElementById('liveui-task-entities');
  const stats = document.getElementById('liveui-task-stats');
  const records = document.querySelector('[data-liveui-view="records"][data-liveui-default-projection]');
  const key = 'liveui.observed-service-result.v1';
  let busy = false, observed;
  const text = value => typeof value === 'string' ? value : String(value ?? '');
  function render(value, notify = true) {
    result.textContent = text(value.text);
    entities.replaceChildren(); stats.replaceChildren();
    if (records) records.replaceChildren();
    for (const item of Array.isArray(value.data?.entities) ? value.data.entities : []) {
      const row = document.createElement('li');
      row.textContent = [item.name, item.detail, item.group].filter(value => value !== undefined && value !== null && value !== '').map(text).join(' · ');
      entities.append(row);
      if (records) records.append(row.cloneNode(true));
    }
    for (const item of Array.isArray(value.data?.stats) ? value.data.stats : []) {
      const term = document.createElement('dt'), detail = document.createElement('dd');
      term.textContent = text(item.label); detail.textContent = text(item.value); stats.append(term, detail);
    }
    if (notify) document.dispatchEvent(new CustomEvent('liveui:result', {detail: value}));
  }
  async function perform(task, context = {}) {
    if (busy) throw Error('Wait for the current task to finish');
    const request = text(task).trim();
    if (!request) { status.textContent = 'Enter a task'; status.dataset.state = 'error'; return; }
    busy = true; submit.disabled = true; status.textContent = 'Working…'; status.dataset.state = 'pending';
    try {
      if (typeof window.liveuiagent?.ai !== 'function') throw Error('The application service is unavailable');
      const applicationContext = {...(context && typeof context === 'object' ? context : {input: context}), ...(observed ? {lastVerified: {text: observed.text, data: observed.data}} : {})};
      const response = await window.liveuiagent.ai(request, applicationContext);
      if (response?.ok !== true) throw Error(response?.error || response?.data?.error || response?.text || 'The requested outcome was not verified');
      observed = response;
      // This is a visible cache of an actual successful host response, never a
      // user-input echo or a substitute for the host's execution audit.
      let cacheError = '';
      try { localStorage.setItem(key, JSON.stringify({schemaVersion: 1, observedAt: new Date().toISOString(), result: response})); }
      catch { cacheError = 'Completed, but this result could not be saved for reopening.'; }
      render(response);
      status.textContent = cacheError; status.dataset.state = 'ready';
      status.dataset.cache = cacheError ? 'unavailable' : 'saved';
      return response;
    } catch (error) {
      status.textContent = error?.message || 'The task could not be completed'; status.dataset.state = 'error';
      // Keep the draft and last observed cache. Never turn a failed call into a
      // browser-only mutation or silently repeat a possibly completed write.
      return {ok: false, error: status.textContent};
    } finally { busy = false; submit.disabled = false; }
  }
  const api = {perform, getContext: () => ({}), get lastResult() { return observed; }};
  window.liveuiapp = api;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached?.schemaVersion === 1 && cached.result?.ok === true && typeof cached.result.text === 'string') {
      observed = cached.result; render(observed, false);
    }
  } catch { /* An invalid cache is not evidence of a service outcome. */ }
  const ready = () => { document.dispatchEvent(new CustomEvent('liveui:ready', {detail: api})); if (observed) document.dispatchEvent(new CustomEvent('liveui:result', {detail: observed})); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true}); else queueMicrotask(ready);
  form.addEventListener('submit', event => { event.preventDefault(); void perform(input.value, api.getContext()); });
}

/** Working SDK boundary for new connected apps; the model owns the domain view. */
export function connectedStarterHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace</title>
<style> *{box-sizing:border-box}body{margin:0;background:#fff;color:#202723;font:16px/1.5 system-ui,sans-serif}main{max-width:1080px;margin:0 auto;padding:24px}h1{font-size:26px;margin:0 0 18px}form{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end}label{grid-column:1/-1;font-weight:600}textarea{width:100%;min-height:84px;padding:12px;border:1px solid #9ba79e;border-radius:8px;font:inherit;resize:vertical}button{padding:12px 22px;border:0;border-radius:8px;background:#284f3a;color:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #739b83;outline-offset:3px}#liveui-task-status{margin:10px 0;min-height:24px}#liveui-task-status[data-state=error]{color:#a02a22}#liveui-task-result{white-space:pre-wrap}#liveui-task-entities{padding-left:22px}#liveui-task-stats{display:grid;grid-template-columns:auto 1fr;gap:6px 18px}#liveui-domain-view{margin-top:22px}@media(max-width:600px){main{padding:16px}form{grid-template-columns:1fr}button{width:100%}}</style></head><body><main>
<header><h1 id="liveui-app-title">Workspace</h1></header>
<!-- Keep this primary workflow visible outside domain tabs. Style it without removing its SDK behavior. -->
<section id="liveui-host-workflow"><form id="liveui-task-form" data-liveui-action="agent.invoke"><label for="liveui-task">Task</label><textarea id="liveui-task" name="task" placeholder="What would you like to do?" required></textarea><button id="liveui-task-submit" type="submit" data-liveui-action="agent.invoke">Run</button></form><p id="liveui-task-status" role="status" aria-live="polite"></p><div id="liveui-task-result" aria-live="polite"></div><ul id="liveui-task-entities"></ul><dl id="liveui-task-stats"></dl></section>
<!-- Build the requested task-specific views here. Listen for liveui:result and read window.liveuiapp.lastResult. Domain actions can call window.liveuiapp.perform(task,fields). -->
<section id="liveui-domain-view"><ul data-liveui-view="records" data-liveui-default-projection></ul></section></main><script>(${hostController.toString()})();</script></body></html>`;
}

export async function seedConnectedApp(work) {
  await fs.mkdir(work, {recursive: true});
  const starter = connectedStarterHtml();
  // Refresh an immutable reference even when an older revision owns index.html.
  // Rename a new file so refreshing a prior read-only reference never follows
  // a model-created symlink or requires making the old reference writable.
  const reference = path.join(work, '.liveui-host-reference.html');
  const temporary = path.join(work, `.liveui-host-reference-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, starter, {flag: 'wx', mode: 0o444});
    await fs.rename(temporary, reference);
  } finally { await fs.rm(temporary, {force: true}); }
  try { await fs.writeFile(path.join(work, 'index.html'), starter, {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { await fs.writeFile(path.join(work, 'app.json'), JSON.stringify({name: 'Workspace', description: 'Run and review your tasks', features: [], checks: []}, null, 2), {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return true;
}
