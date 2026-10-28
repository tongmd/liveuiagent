// Self-contained: bootstrap embeds this function's toString into the sandbox iframe.
window.__liveuiStructuredRuntime = function structuredUiRuntime(sdk) {
  'use strict';
  const generations = new WeakMap(), active = new WeakSet();
  const types = new Set(['Stack', 'Grid', 'Card', 'Text', 'Image', 'List', 'Checklist']);
  const containers = new Set(['Stack', 'Grid', 'Card', 'List', 'Checklist']);
  const fail = message => { throw Error('Invalid structured UI: ' + message); };
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  function json(value, limit = 200000) {
    let text; try { text = JSON.stringify(value); } catch { fail('data must be JSON'); }
    if (!text || new TextEncoder().encode(text).length > limit) fail('data exceeds size limit');
    return text;
  }
  function references(values, label) {
    if (!Array.isArray(values) || values.length > 80) fail(label + ' must contain at most 80 records');
    const result = new Map();
    for (const value of values) {
      if (!plain(value) || typeof value.id !== 'string' || !/^[\w.-]{1,128}$/.test(value.id) || result.has(value.id)) fail(label + ' needs unique ids');
      result.set(value.id, value);
    }
    return result;
  }
  function build(tree, options = {}) {
    json(tree, 64000);
    const records = references(options.records || [], 'records'), photos = references(options.photos || [], 'photos');
    const seenRecords = new Set(), seenPhotos = new Set();
    let count = 0, textLength = 0;
    const doc = options.document || document;
    function recordContent(record, checklist) {
      const wrapper = doc.createElement(checklist ? 'label' : 'div');
      wrapper.style.cssText = 'display:flex;align-items:flex-start;gap:10px;min-width:0;max-width:100%;';
      if (checklist) {
        const input = doc.createElement('input'); input.type = 'checkbox';
        input.checked = typeof record.checked === 'boolean' ? record.checked : record.completed === true;
        let committedChecked = input.checked;
        input.disabled = typeof options.onToggle !== 'function';
        input.style.cssText = 'width:18px;height:18px;flex:0 0 auto;margin:3px 0;';
        input.addEventListener('change', async () => {
          const previous = committedChecked;
          const checked = input.checked; input.disabled = true;
          try { const result = await options.onToggle(record.id, checked); if (result === false) throw Error('Could not save this change'); committedChecked = checked; }
          catch (error) { input.checked = previous; wrapper.dispatchEvent(new CustomEvent('liveui:error', {bubbles:true,detail:{message:String(error.message || error)}})); }
          finally { input.disabled = false; }
        });
        wrapper.append(input);
      }
      const content = doc.createElement('div'); content.style.cssText = 'min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;';
      // Original record fields remain authoritative; no model text substitutes for them.
      const excluded = new Set(['id', 'checked', 'completed']);
      for (const [key, value] of Object.entries(record)) {
        if (excluded.has(key) || value === undefined || value === null || value === '') continue;
        const line = doc.createElement('div');
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        line.textContent = ['text','title','name','label','body','content','description','detail'].includes(key) ? text : key + ': ' + text;
        content.append(line);
      }
      if (!content.childNodes.length) content.textContent = record.id;
      wrapper.append(content); return wrapper;
    }
    function visit(raw, depth, checklist = false) {
      if (++count > 200 || depth > 10 || !plain(raw) || !types.has(raw.type)) fail('unsupported node or tree limit');
      const allowed = new Set(['type','style','recordId']);
      if (containers.has(raw.type)) allowed.add('children');
      if (raw.type === 'Text') { allowed.add('text'); allowed.add('checked'); }
      if (raw.type === 'Checklist') allowed.add('checked');
      if (raw.type === 'Image') { allowed.add('photoId'); allowed.add('text'); }
      for (const key of Object.keys(raw)) if (!allowed.has(key)) fail('unsupported property ' + key);
      const node = doc.createElement('div'); node.dataset.liveuiComponent = raw.type;
      node.style.cssText = 'box-sizing:border-box;min-width:0;max-width:100%;font-size:16px;line-height:1.5;overflow-wrap:anywhere;';
      if (raw.text !== undefined) {
        if (typeof raw.text !== 'string' || raw.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw.text) || (textLength += raw.text.length) > 16000) fail('invalid text');
      }
      if (raw.checked !== undefined && typeof raw.checked !== 'boolean') fail('invalid checked');
      if (raw.recordId !== undefined) {
        if (typeof raw.recordId !== 'string' || !records.has(raw.recordId)) fail('unknown record reference');
        seenRecords.add(raw.recordId); node.dataset.recordId = raw.recordId;
        node.append(recordContent(records.get(raw.recordId), checklist || raw.type === 'Checklist' || raw.checked !== undefined));
      }
      if (raw.type === 'Text') {
        if (!raw.text && !raw.recordId) fail('Text requires content');
        // Do not replace original record text with generated copy.
        if (raw.text && !raw.recordId) { const text = doc.createElement('span'); text.textContent = raw.text; text.style.whiteSpace = 'pre-wrap'; node.append(text); }
      }
      if (raw.type === 'Image') {
        if (typeof raw.photoId !== 'string' || !photos.has(raw.photoId)) fail('unknown photo reference');
        const photo = photos.get(raw.photoId), src = photo.src || photo.url;
        // SVG is excluded even as a data URI. Never accept a model-supplied source.
        if (typeof src !== 'string' || (!/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(src) && !/^blob:[^\s<>]+$/.test(src))) fail('photo must be a local raster or blob');
        const image = doc.createElement('img'); image.src = src; image.alt = raw.text || 'Photo';
        image.style.cssText = 'display:block;width:100%;max-width:100%;max-height:440px;object-fit:contain;height:auto;border-radius:10px;'; node.append(image);seenPhotos.add(raw.photoId);
      }
      let style = {};
      if (raw.style !== undefined) {
        if (!plain(raw.style)) fail('invalid style'); style = raw.style;
        const enums = {direction:['row','column'],tone:['default','muted','accent'],align:['start','center','end']};
        for (const [key,value] of Object.entries(style)) {
          if (Object.hasOwn(enums,key)) { if (typeof value !== 'string' || !enums[key].includes(value)) fail('invalid style ' + key); }
          else if (['gap','padding','columns'].includes(key)) { if (!Number.isInteger(value) || value < (key === 'columns' ? 1 : 0) || value > (key === 'columns' ? 4 : 32)) fail('invalid style ' + key); }
          else fail('unsupported style ' + key);
        }
      }
      const gap = style.gap ?? 12;
      if (containers.has(raw.type)) {
        if (!Array.isArray(raw.children) || raw.children.length > 80 || (!raw.children.length && !raw.recordId)) fail('container requires bounded children');
        node.style.display = 'flex'; node.style.flexDirection = style.direction || 'column'; node.style.gap = gap + 'px';
        if (style.direction === 'row') node.style.flexWrap = 'wrap';
        if (raw.type === 'Grid') {
          const columns = style.columns || 2;node.style.display = 'grid';node.style.alignItems = 'start';
          node.style.gridTemplateColumns = `repeat(auto-fit,minmax(min(100%,max(180px,calc((100% - ${gap * (columns - 1)}px) / ${columns}))),1fr))`;
        }
        if (raw.type === 'Card') { node.style.padding = '16px';node.style.border = '1px solid #dce2e8';node.style.borderRadius = '12px';node.style.backgroundColor = '#ffffff'; }
        for (const child of raw.children) node.append(visit(child,depth+1,checklist || raw.type === 'Checklist'));
      }
      if (style.padding !== undefined) node.style.padding = style.padding + 'px';
      if (style.align) node.style.textAlign = style.align;
      if (style.tone === 'muted') node.style.color = '#536176';
      if (style.tone === 'accent') node.style.color = '#2456a6';
      return node;
    }
    const root = visit(tree,1);
    if ([...records.keys()].some(id=>!seenRecords.has(id)) || [...photos.keys()].some(id=>!seenPhotos.has(id))) fail('omitted source content');
    return root;
  }
  function render(container, tree, options = {}) {
    if (!container || typeof container.replaceChildren !== 'function') fail('invalid container');
    const root = build(tree,{...options,document:container.ownerDocument});
    generations.set(container,(generations.get(container)||0)+1);container.replaceChildren(root);return root;
  }
  async function generate(container,prompt,options) {
    if (!container?.isConnected || !options || typeof options.getRecords !== 'function' || typeof options.storageKey !== 'string' || !options.storageKey) fail('invalid generation options');
    if (active.has(container)) throw Error('Wait for the current layout to finish');
    active.add(container);
    const version = (generations.get(container)||0)+1;generations.set(container,version);
    const requestId = 'ui-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
    const snapshot = () => json(options.getRecords());
    try {
      const originalChildren = Array.from(container.childNodes);
      const childrenUnchanged = () => container.childNodes.length === originalChildren.length && originalChildren.every((child,index)=>container.childNodes[index] === child);
      const fingerprint = snapshot(),records = JSON.parse(fingerprint),photos = (options.getPhotos ? options.getPhotos() : []).map(photo=>({...photo}));
      references(records,'records');references(photos,'photos');
      const photosUnchanged = () => { const latest = options.getPhotos ? options.getPhotos() : []; return latest.length === photos.length && latest.every((photo,index)=>photo.id === photos[index].id && (photo.src || photo.url) === (photos[index].src || photos[index].url)); };
      const current = () => container.isConnected && childrenUnchanged() && generations.get(container) === version && snapshot() === fingerprint && photosUnchanged();
      const previousTree = options.tree ?? options.previousTree;
      if (previousTree !== undefined) json(previousTree,64000); // Prior references may legitimately differ after source edits.
      const response = await sdk.ai(prompt,{uiProtocol:'liveui-tree-v1',requestId,records,photos:photos.map(photo=>({id:photo.id})),...(previousTree !== undefined ? {tree:previousTree} : {})});
      if (response?.requestId !== requestId) fail('mismatched generation response');
      const tree = response?.data?.tree;
      const candidate = build(tree,{records,photos,onToggle:options.onToggle,document:container.ownerDocument});
      if (!current()) throw Error('Content changed while generating. Generate again.');
      const state = {tree,requestId,updatedAt:new Date().toISOString(),recordsFingerprint:fingerprint};
      await sdk.save(options.storageKey,json(state,100000));
      if (!current()) throw Error('Content changed while saving. Reopen or generate again.');
      container.replaceChildren(candidate);return state;
    } finally { active.delete(container); }
  }
  function read(storageKey) {
    const raw = sdk.storage.getItem(storageKey);if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || raw.length > 100000) fail('saved state exceeds limit');
    let state;try { state = JSON.parse(raw); } catch { fail('saved state is not JSON'); }
    if (!plain(state) || !plain(state.tree) || typeof state.requestId !== 'string' || typeof state.updatedAt !== 'string') fail('invalid saved state');
    json(state.tree,64000);return state;
  }
  return {render,generate,read};
};
