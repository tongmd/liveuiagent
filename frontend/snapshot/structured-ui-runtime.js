// Self-contained: bootstrap embeds this function's toString into the sandbox iframe.
window.__liveuiStructuredRuntime = function structuredUiRuntime(sdk) {
  'use strict';
  // BEGIN GENERATED STYLE CONTRACT
/** Canonical style validator. scripts/sync-ui-style.mjs embeds this exact function in the iframe. */
function validateStructuredUiStyle(raw, version = 1) {
    const fail = (message) => { throw new Error('Invalid structured UI style: ' + message); };
    const plain = (x) => x && typeof x === 'object' && !Array.isArray(x)
        && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
    if (!plain(raw))
        fail('expected object');
    const enums = { direction: ['row', 'column'], tone: ['default', 'muted', 'accent'], align: ['start', 'center', 'end'] };
    const ranges = { gap: [0, 32], padding: [0, 32], columns: [1, 4] };
    if (version === 2) {
        Object.assign(enums, { fontFamily: ['sans', 'serif', 'mono'] });
        Object.assign(ranges, { width: [160, 1920], maxWidth: [160, 1920], widthPercent: [20, 100], span: [1, 4], radius: [0, 32], borderWidth: [0, 2], fontSize: [16, 36], fontWeight: [400, 700], lineHeight: [1.3, 2], height: [180, 640], aspectRatio: [.5, 3] });
    }
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
        if (Object.hasOwn(enums, key)) {
            if (typeof value !== 'string' || !enums[key].includes(value))
                fail(key);
        }
        else if (Object.hasOwn(ranges, key)) {
            const [min, max] = ranges[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
                || !['lineHeight', 'aspectRatio', 'widthPercent'].includes(key) && !Number.isInteger(value))
                fail(key);
            if (key === 'fontWeight' && Number(value) % 100 !== 0)
                fail(key);
        }
        else if (version === 2 && ['color', 'background', 'borderColor'].includes(key)) {
            if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
                fail(key);
        }
        else if (version === 2 && key === 'columnWeights') {
            if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < .25 || n > 4))
                fail(key);
        }
        else if (version === 2 && key === 'mobile') {
            if (!plain(value) || Object.hasOwn(value, 'mobile'))
                fail('nested mobile');
            result.mobile = validateStructuredUiStyle(value, 2);
            continue;
        }
        else
            fail('unsupported property ' + key);
        result[key] = Array.isArray(value) ? [...value] : value;
    }
    if (result.width !== undefined && result.widthPercent !== undefined)
        fail('choose width or widthPercent');
    if (result.columnWeights && result.columns !== undefined && result.columns !== result.columnWeights.length)
        fail('columns must match columnWeights');
    if (result.color && result.background) {
        const luminance = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const a = luminance(result.color), b = luminance(result.background);
        if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) < 4.5)
            fail('text/background contrast');
    }
    return result;
}
  // END GENERATED STYLE CONTRACT
  const generations = new WeakMap(), active = new WeakSet(), richSaveQueues = new WeakMap();
  function validateRich(raw) {
 const bad=m=>{throw Error('Invalid rich component: '+m);};
 const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
 const exact=(x,keys)=>{if(!obj(x)||Object.keys(x).some(k=>!keys.includes(k)))bad('unknown property');};
 const num=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
 const text=x=>typeof x==='string'&&x.length<=160;
 const color=x=>typeof x==='string'&&/^#[0-9a-f]{6}$/i.test(x);
 const vec=(x,a,b)=>Array.isArray(x)&&x.length===3&&x.every(v=>num(v,a,b));
 if(raw.type==='Scene3D'){
  exact(raw.scene,['objects','background','grid','title']);const s=raw.scene;
  if(!Array.isArray(s.objects)||!s.objects.length||s.objects.length>48||s.background!==undefined&&!color(s.background)||s.grid!==undefined&&typeof s.grid!=='boolean'||s.title!==undefined&&!text(s.title))bad('scene');
  const ids=new Set();for(const o of s.objects){exact(o,['id','shape','position','scale','color','label','rotation']);if(!text(o.id)||!o.id||ids.has(o.id)||!['box','sphere','cylinder','cone','torus'].includes(o.shape)||!vec(o.position,-20,20)||!vec(o.scale,.05,10)||!color(o.color)||o.label!==undefined&&!text(o.label)||o.rotation!==undefined&&!vec(o.rotation,-360,360))bad('object');ids.add(o.id);}
 }else if(raw.type==='Plot'){
  exact(raw.plot,['series','kind','title','xLabel','yLabel']);const p=raw.plot;
  if(!['line','scatter','bar'].includes(p.kind)||!Array.isArray(p.series)||!p.series.length||p.series.length>6||['title','xLabel','yLabel'].some(k=>p[k]!==undefined&&!text(p[k])))bad('plot');
  for(const s of p.series){exact(s,['name','color','points']);if(!text(s.name)||!color(s.color)||!Array.isArray(s.points)||s.points.length<1||s.points.length>160||s.points.some(v=>!Array.isArray(v)||v.length!==2||!v.every(n=>num(n,-1e9,1e9))))bad('series');}
 }else if(raw.type==='Diagram'){
  exact(raw.diagram,['nodes','edges','title']);const d=raw.diagram;
  if(!Array.isArray(d.nodes)||!d.nodes.length||d.nodes.length>24||!Array.isArray(d.edges)||d.edges.length>48||d.title!==undefined&&!text(d.title))bad('diagram');
  const ids=new Set();for(const n of d.nodes){exact(n,['id','label','x','y','color']);if(!text(n.id)||!n.id||ids.has(n.id)||!text(n.label)||!num(n.x,0,1)||!num(n.y,0,1)||!color(n.color))bad('diagram node');ids.add(n.id);}
  for(const e of d.edges){exact(e,['from','to','label']);if(!ids.has(e.from)||!ids.has(e.to)||e.label!==undefined&&!text(e.label))bad('edge');}
 }else bad('type');
 return JSON.parse(JSON.stringify(raw.type==='Scene3D'?raw.scene:raw.type==='Plot'?raw.plot:raw.diagram));
}

  const types = new Set(['Stack', 'Grid', 'Card', 'Text', 'Image', 'List', 'Checklist', 'Scene3D', 'Plot', 'Diagram']);
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
  async function flushRichSaves(callback, queue) {
    if(queue.running)return;queue.running=true;
    try {
      while(queue.pending.size){
        const [key,entry]=queue.pending.entries().next().value;queue.pending.delete(key);
        if(!entry.active())continue;
        try { await callback(key,entry.view); }
        catch(error){if(entry.active())entry.host.dispatchEvent(new CustomEvent('liveui:error',{bubbles:true,detail:{message:String(error.message||error)}}));}
      }
    } finally {queue.running=false;if(queue.pending.size)void flushRichSaves(callback,queue);}
  }
// Embed this function inside structuredUiRuntime: the iframe serializes that runtime.
// enqueueSave(key, view, active) must use the runtime's existing rich save queue.
function enhanceRichSelection(host, svg, raw, doc, options = {}, enqueueSave) {
  const data = raw.plot || raw.diagram;
  if (!data || !['Plot', 'Diagram'].includes(raw.type)) return { dispose() {} };
  const zh = /^zh/i.test(options.locale || doc.documentElement.lang || '') ||
    (!options.locale && /[\u3400-\u9fff]/.test(data.title || ''));
  const fingerprint = JSON.stringify([raw.type, data]);
  // Compact deterministic content identity keeps unrelated plots/diagrams separate.
  const hash = seed => { let h = seed; for (let i = 0; i < fingerprint.length; i++) h = Math.imul(h ^ fingerprint.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
  const key = 'rich-selection-v1:' + raw.type + ':' + hash(2166136261) + hash(3339675911);
  let disposed = false;
  const listeners = [];
  const on = (el, name, fn) => { el.addEventListener(name, fn); listeners.push(() => el.removeEventListener(name, fn)); };
  const panel = doc.createElement('div');
  panel.dataset.richDetails = raw.type.toLowerCase();
  panel.style.cssText = 'padding:12px 16px;background:#fff;border-top:1px solid #dce4ee;font:14px/1.6 system-ui;overflow-wrap:anywhere;min-width:0;';
  const details = doc.createElement('div');
  details.setAttribute('role', 'status'); details.setAttribute('aria-live', 'polite'); details.setAttribute('aria-atomic', 'true');
  const select = doc.createElement('select');
  select.setAttribute('aria-label', zh ? (raw.type === 'Plot' ? '选择数据点' : '选择节点') : (raw.type === 'Plot' ? 'Choose data point' : 'Choose node'));
  select.style.cssText = 'display:block;width:100%;max-width:100%;min-height:44px;margin-top:8px;border:1px solid #c9d3e0;border-radius:8px;background:#fff;color:#172033;font:14px system-ui;padding:8px;';
  const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = zh ? '请选择' : 'Select'; select.append(placeholder);
  panel.append(details, select); host.append(panel);
  svg.setAttribute('role', 'group');
  host.dataset.richStateKey = key;
  const commit = view => {
    host.dataset.selection = JSON.stringify(view);
    if (!disposed && typeof enqueueSave === 'function') enqueueSave(key, { ...view }, () => !disposed);
  };
  const saved = options.richState?.[key];
  if (raw.type === 'Plot') {
    const marks = [...svg.querySelectorAll('circle,rect')];
    const entries = []; let markIndex = 0;
    for (let seriesIndex = 0; seriesIndex < data.series.length; seriesIndex++) {
      const series = data.series[seriesIndex];
      for (let pointIndex = 0; pointIndex < series.points.length; pointIndex++) {
        const [x, y] = series.points[pointIndex]; const mark = marks[markIndex++];
        if (!mark) continue;
        const value = seriesIndex + ':' + pointIndex;
        const description = series.name + ' · ' + (data.xLabel || 'x') + ' = ' + x + ' · ' + (data.yLabel || 'y') + ' = ' + y;
        const group = doc.createElementNS(svg.namespaceURI, 'g');
        group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0'); group.setAttribute('aria-label', description);
        group.style.cssText = 'cursor:pointer;touch-action:manipulation;';
        const hit = doc.createElementNS(svg.namespaceURI, mark.tagName.toLowerCase() === 'rect' ? 'rect' : 'circle');
        if (mark.tagName.toLowerCase() === 'rect') {
          const width = +mark.getAttribute('width'), height = +mark.getAttribute('height');
          hit.setAttribute('x', String(+mark.getAttribute('x') - Math.max(0, 28 - width) / 2));
          hit.setAttribute('y', String(+mark.getAttribute('y') - Math.max(0, 28 - height) / 2));
          hit.setAttribute('width', String(Math.max(28, width))); hit.setAttribute('height', String(Math.max(28, height)));
        } else { hit.setAttribute('cx', mark.getAttribute('cx')); hit.setAttribute('cy', mark.getAttribute('cy')); hit.setAttribute('r', '16'); }
        hit.setAttribute('fill', 'transparent'); hit.setAttribute('pointer-events', 'all'); hit.setAttribute('aria-hidden', 'true');
        mark.replaceWith(group); group.append(hit, mark);
        const option = doc.createElement('option'); option.value = value; option.textContent = description; select.append(option);
        const entry = { seriesIndex, pointIndex, x, y, value, description, group, mark }; entries.push(entry);
        on(group, 'click', () => choose(entry, true));
        on(group, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(entry, true); } });
      }
    }
    function choose(entry, persist) {
      if (disposed) return;
      for (const other of entries) {
        const selected = other === entry;
        other.group.setAttribute('aria-pressed', String(selected));
        other.mark.setAttribute('stroke', selected ? doc.defaultView.getComputedStyle(host).color : 'none'); other.mark.setAttribute('stroke-width', selected ? '3' : '0');
      }
      details.textContent = entry ? entry.description : (zh ? '点选图中的数据点查看数值。' : 'Select a point to see its values.');
      select.value = entry?.value || '';
      const view = entry ? { kind: 'plot-selection-v1', seriesIndex: entry.seriesIndex, pointIndex: entry.pointIndex, x: entry.x, y: entry.y } : { kind: 'plot-selection-v1' };
      host.dataset.selection = JSON.stringify(view);
      if (persist) commit(view);
    }
    on(select, 'change', () => choose(entries.find(e => e.value === select.value), true));
    const restored = saved?.kind === 'plot-selection-v1' ? entries.find(e => e.seriesIndex === saved.seriesIndex && e.pointIndex === saved.pointIndex && e.x === saved.x && e.y === saved.y) : undefined;
    choose(restored, false);
  } else {
    const groups = [...svg.querySelectorAll('g[role="button"]')];
    const lines = [...svg.querySelectorAll('line')];
    const nodes = new Map(data.nodes.map(n => [n.id, n]));
    const list = doc.createElement('ul'); list.style.cssText = 'padding-left:20px;margin:8px 0 0;'; panel.append(list);
    data.nodes.forEach((node, index) => {
      const option = doc.createElement('option'); option.value = node.id; option.textContent = node.label; select.append(option);
      const group = groups[index]; if (!group) return;
      // Native Diagram already turns Enter/Space into click; reuse that handler.
      on(group, 'click', () => choose(node.id, true));
    });
    function choose(nodeId, persist) {
      if (disposed) return;
      const selected = nodes.get(nodeId); const edges = selected ? data.edges.filter(e => e.from === nodeId || e.to === nodeId) : [];
      const neighbors = new Set(edges.flatMap(e => [e.from, e.to]));
      groups.forEach((group, i) => {
        const current = data.nodes[i]; if (!current) return;
        const active = selected?.id === current.id;
        group.setAttribute('aria-pressed', String(active)); group.style.opacity = !selected || active || neighbors.has(current.id) ? '1' : '.35';
        const circle = group.querySelector('circle'); circle?.setAttribute('stroke', active ? doc.defaultView.getComputedStyle(host).color : 'none'); circle?.setAttribute('stroke-width', active ? '4' : '0');
      });
      lines.forEach((line, i) => { const edge = data.edges[i]; const direct = edge && (edge.from === nodeId || edge.to === nodeId); line.setAttribute('stroke', selected && direct ? doc.defaultView.getComputedStyle(host).color : '#a0adbd'); line.setAttribute('stroke-width', selected && direct ? '3' : '2'); line.style.opacity = !selected || direct ? '1' : '.2'; });
      details.textContent = selected ? selected.label + (zh ? '：直接关系（' : ': direct relationships (') + edges.length + (zh ? '）' : ')') : (zh ? '选择节点查看它的直接关系。' : 'Select a node to see its direct relationships.');
      list.replaceChildren(); list.hidden = !selected;
      for (const edge of edges) { const item = doc.createElement('li'); item.textContent = nodes.get(edge.from).label + ' → ' + nodes.get(edge.to).label + (edge.label ? ' · ' + edge.label : ''); list.append(item); }
      if (selected && !edges.length) { const item = doc.createElement('li'); item.textContent = zh ? '没有直接连接。' : 'No direct connections.'; list.append(item); }
      select.value = selected?.id || '';
      const view = selected ? { kind: 'diagram-selection-v1', nodeId: selected.id } : { kind: 'diagram-selection-v1' };
      host.dataset.selection = JSON.stringify(view); if (persist) commit(view);
    }
    on(select, 'change', () => choose(select.value, true));
    choose(saved?.kind === 'diagram-selection-v1' && nodes.has(saved.nodeId) ? saved.nodeId : undefined, false);
  }
  return { key, dispose() { disposed = true; for (const remove of listeners) remove(); } };
}

// Embed this self-contained function inside structuredUiRuntime for iframe use.
function createWorkspace(sdk, ui, options) {
  const { container, requestInput, generateButton, status, storagePrefix } = options || {};
  if (!container?.ownerDocument || typeof storagePrefix !== 'string' || !storagePrefix || storagePrefix.length > 160) throw Error('A workspace needs a container and stable storagePrefix');
  const doc = container.ownerDocument;
  const zh = /^zh/i.test(options.locale || doc.documentElement.lang || '');
  const words = { saving: zh ? '正在保存…' : 'Saving…', generating: zh ? '正在生成布局…' : 'Generating layout…', saved: zh ? '已保存' : 'Saved', sources: zh ? '数据已保存，可生成新布局。' : 'Data saved. Generate a new layout when ready.', ready: zh ? '就绪' : 'Ready' };
  const keys = { source: storagePrefix + ':source:v1', view: storagePrefix + ':view:v1', layout: storagePrefix + ':layout:v1', history: storagePrefix + ':history:v1' };
  const photosFingerprint = value => {
    const text = JSON.stringify(value); let a = 2166136261, b = 3339675911;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 16777619); }
    return 'workspace-photos-v1:' + text.length + ':' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  };
  const plain = x => x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
  const clone = (value, limit = 1000000) => {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item) || item === undefined) throw Error('Workspace data must be finite JSON');
      return item;
    });
    if (!json || new TextEncoder().encode(json).length > limit) throw Error('Workspace data is too large to save');
    return JSON.parse(json);
  };
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const validateItems = (items, label) => {
    const result = clone(items); const ids = new Set();
    if (!Array.isArray(result) || result.length > 80) throw Error(label + ' must contain at most 80 items');
    for (const item of result) { if (!plain(item) || typeof item.id !== 'string' || !/^[\w.-]{1,128}$/.test(item.id) || ids.has(item.id)) throw Error(label + ' need unique stable ids'); ids.add(item.id); }
    return result;
  };
  const read = key => { const text = sdk.storage.getItem(key); if (text == null) return null; if (typeof text !== 'string' || text.length > 1000000) throw Error('Saved workspace data is invalid'); return clone(JSON.parse(text)); };
  let records = [], photos = [], preferences = {}, richState = {}, draft = '', tree = null, generatedTree = null, origin = 'source', error = null, viewRevision = '', snapshots = [], historyError = null;
  let errorEpoch = 0;
  let tail = Promise.resolve(), queued = 0, generationQueued = false, generating = false, disposed = false, draftTimer, draftEpoch = 0;
  const notify = (text, failed = false) => { if (error && !failed) return; if (status) { status.textContent = text; status.setAttribute('role', failed ? 'alert' : 'status'); } };
  const report = failure => { errorEpoch++; error = String(failure?.message || failure); notify(error, true); };
  const persist = async (key, value) => { const ack = await sdk.save(key, JSON.stringify(value)); if (ack === false || ack?.ok === false) throw Error(zh ? '保存失败，请重试。' : 'Saving failed. Please retry.'); };
  const queue = operation => {
    queued++; const requestedAtErrorEpoch = errorEpoch;
    const result = tail.then(async () => { if (disposed) throw Error('Workspace is closed'); if (errorEpoch === requestedAtErrorEpoch) error = null; try { return await operation(); } catch (failure) { report(failure); throw failure; } }).finally(() => { queued--; });
    tail = result.catch(() => {}); return result;
  };
  const fallback = (nextRecords, nextPhotos) => nextRecords.length || nextPhotos.length ? ({ type: 'Stack', children: [...(nextRecords.length ? [{type:'Stack',children:nextRecords.map(record => ({ type: 'List', recordId: record.id, children: [] }))}] : []), ...(nextPhotos.length ? [{type:'Stack',children:nextPhotos.map(photo => ({ type: 'Image', photoId: photo.id }))}] : [])] }) : ({type:'Text',text:zh?'添加内容或描述你想生成的界面。':'Add content or describe the view you want.'});
  const renderOptions = (nextRecords = records, nextPhotos = photos) => ({ records: nextRecords, photos: nextPhotos, richState, onRichStateChange, onToggle });
  const validateTree = (nextTree, nextRecords, nextPhotos, nextRichState = richState) => {
    const probe = doc.createElement('div');
    try { ui.render(probe, nextTree, {...renderOptions(nextRecords, nextPhotos),richState:nextRichState}); }
    finally { for (const canvas of probe.querySelectorAll('canvas,svg')) canvas.__liveuiDispose?.(); }
  };
  const paint = nextTree => { ui.render(container, nextTree, renderOptions()); tree = clone(nextTree, 64000); };
  const freshId = () => doc.defaultView.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const saveView = async next => { const saved = {...next,revision:freshId()}; await persist(keys.view, saved); preferences = saved.preferences; richState = saved.richState; draft = saved.draft; viewRevision = saved.revision; };
  const viewSnapshot = () => ({ version: 1, preferences: clone(preferences, 6000), richState: clone(richState, 100000), draft });
  function onRichStateChange(key, view) {
    const incoming = clone(view, 10000);
    return queue(async () => { const next = viewSnapshot(); next.richState = clone({ ...next.richState, [key]: incoming }, 100000); await saveView(next); });
  }
  function onToggle(id, checked) { return queue(async () => {
    const nextRecords = records.map(item => item.id === id ? {...item,checked} : item);
    validateTree(tree,nextRecords,photos);
    await persist(keys.source,{version:1,records:nextRecords,photos});
    if (disposed) throw Error('Workspace is closed');
    records = nextRecords; paint(tree); notify(words.saved);
  }); }
  async function setRecords(value) {
    let supplied; try { supplied = typeof value === 'function' ? value : validateItems(value, 'Records'); } catch (failure) { report(failure); throw failure; }
    return queue(async () => changeSource(validateItems(typeof supplied === 'function' ? supplied(clone(records)) : supplied, 'Records'), photos));
  }
  async function setPhotos(value) {
    let supplied; try { supplied = typeof value === 'function' ? value : validateItems(value, 'Photos'); } catch (failure) { report(failure); throw failure; }
    return queue(async () => changeSource(records, validateItems(typeof supplied === 'function' ? supplied(clone(photos)) : supplied, 'Photos')));
  }
  async function changeSource(nextRecords, nextPhotos) {
    if(JSON.stringify(nextRecords)===JSON.stringify(records)&&JSON.stringify(nextPhotos)===JSON.stringify(photos))return state();
    const nextTree = fallback(nextRecords, nextPhotos);
    validateTree(nextTree, nextRecords, nextPhotos);
    const next = clone({ version: 1, records: nextRecords, photos: nextPhotos });
    notify(words.saving); await persist(keys.source, next);
    if (disposed) throw Error('Workspace is closed');
    records = next.records; photos = next.photos;
    paint(nextTree); origin = 'source'; notify(words.sources);
    return state();
  }
  async function setPreferences(value) {
    let supplied; try { supplied = typeof value === 'function' ? value : clone(value, 6000); } catch (failure) { report(failure); throw failure; }
    return queue(async () => { const next = viewSnapshot(); next.preferences = clone(typeof supplied === 'function' ? supplied(clone(preferences)) : supplied, 6000); if (!plain(next.preferences)) throw Error('Preferences must be an object'); notify(words.saving); await saveView(next); notify(words.saved); return state(); });
  }
  function saveDraft(value) { const nextDraft = String(value), epoch=draftEpoch; return queue(async () => { if(epoch!==draftEpoch)return; const next = viewSnapshot(); next.draft = nextDraft; await saveView(next); }); }
  const matchesSnapshot = snapshot => snapshot.recordsFingerprint === JSON.stringify(records) && snapshot.photosFingerprint === photosFingerprint(photos);
  const snapshotLayout = snapshot => clone({tree:snapshot.tree,requestId:'snapshot-'+snapshot.id,requirement:snapshot.draft,updatedAt:new Date().toISOString(),recordsFingerprint:snapshot.recordsFingerprint,photosFingerprint:snapshot.photosFingerprint,workspaceOrigin:snapshot.origin,workspaceView:{version:1,baseRevision:viewRevision,preferences:snapshot.preferences,richState:snapshot.richState,draft:snapshot.draft}},100000);
  const historyValue = items => {
    if(items.length>6)throw Error(zh?'最多保存6个快照，请先删除一个。':'Keep at most 6 snapshots. Delete one before saving another.');
    return clone({version:1,snapshots:items},500000);
  };
  function listSnapshots() { return freeze(snapshots.map(({id,label,createdAt,origin,...item})=>({id,label,createdAt,origin,matchesSource:matchesSnapshot(item)}))); }
  function saveSnapshot(label) { return queue(async()=>{
    if(historyError)throw Error(historyError);
    if(label!==undefined&&(typeof label!=='string'||!label.trim()||label.length>160))throw Error(zh?'快照名称需为1至160个字符。':'Snapshot label must contain 1 to 160 characters.');
    if(!tree)throw Error(zh?'还没有可保存的界面。':'There is no view to save yet.');
    const snapshot=clone({id:freshId(),label:label===undefined?(String(requestInput?.value??draft).trim().slice(0,80)||(zh?'已保存界面':'Saved view')):label.trim(),createdAt:new Date().toISOString(),origin,tree:clone(tree,64000),recordsFingerprint:JSON.stringify(records),photosFingerprint:photosFingerprint(photos),preferences:clone(preferences,6000),richState:clone(richState,100000),draft:String(requestInput?.value??draft)});
    validateTree(snapshot.tree,records,photos,snapshot.richState);snapshotLayout(snapshot);
    const next=historyValue([...snapshots,snapshot]);await persist(keys.history,next);
    if(disposed)throw Error('Workspace is closed');snapshots=next.snapshots;notify(words.saved);
    return listSnapshots().find(item=>item.id===snapshot.id);
  }); }
  function restoreSnapshot(id) { return queue(async()=>{
    if(historyError)throw Error(historyError);
    const snapshot=snapshots.find(item=>item.id===id);if(!snapshot)throw Error(zh?'找不到这个快照。':'Snapshot not found.');
    if(!matchesSnapshot(snapshot))throw Error(zh?'源数据已变化，无法恢复这个快照。':'Source data changed. This snapshot cannot be restored.');
    validateTree(snapshot.tree,records,photos,snapshot.richState);
    const saved=snapshotLayout(snapshot);await persist(keys.layout,saved);
    if(disposed)throw Error('Workspace is closed');
    draftEpoch++;clearTimeout(draftTimer);
    preferences=clone(snapshot.preferences);richState=clone(snapshot.richState);draft=snapshot.draft;
    if(requestInput)requestInput.value=draft;
    generatedTree=clone(snapshot.tree,64000);paint(snapshot.tree);origin=snapshot.origin;notify(words.saved);return state();
  }); }
  function deleteSnapshot(id) { return queue(async()=>{
    if(historyError)throw Error(historyError);
    if(!snapshots.some(item=>item.id===id))throw Error(zh?'找不到这个快照。':'Snapshot not found.');
    const next=historyValue(snapshots.filter(item=>item.id!==id));await persist(keys.history,next);
    if(disposed)throw Error('Workspace is closed');snapshots=next.snapshots;notify(words.saved);return listSnapshots();
  }); }
  function generate(requirement) {
    const prompt = requirement === undefined ? String(requestInput?.value ?? draft) : String(requirement);
    if (!prompt.trim()) { const failure = Error(zh ? '请先输入布局要求。' : 'Enter a layout request first.'); report(failure); return Promise.reject(failure); }
    if (prompt.length > 4000) { const failure = Error('The layout request is too long'); report(failure); return Promise.reject(failure); }
    if (generationQueued) return Promise.reject(Error(zh ? '请等待当前布局完成。' : 'Wait for the current layout to finish.'));
    generationQueued = true; if (generateButton) generateButton.disabled = true;
    return queue(async () => {
      generating = true;
      if (generateButton) generateButton.disabled = true;
      try {
        const next = viewSnapshot(); next.draft = prompt; await saveView(next);
        notify(words.generating);
        const result = await ui.generate(container, prompt, { storageKey: keys.layout, isCurrent: () => !disposed, getRecords: () => clone(records), getPhotos: () => clone(photos), getPhotosFingerprint: () => photosFingerprint(photos), getContext: () => clone(preferences, 6000), previousTree: generatedTree || tree || undefined, layoutBrief: options.layoutBrief, richState, onRichStateChange, onToggle });
        generatedTree = clone(result.tree, 64000); tree = clone(result.tree, 64000); origin = 'generated'; notify(words.saved); return result;
      } finally { generating = false; }
    }).finally(() => { generationQueued = false; if (generateButton) generateButton.disabled = false; });
  }
  function state() { return freeze(clone({ records, photos, preferences, richState, tree, generatedTree, origin, draft: String(requestInput?.value ?? draft), busy: queued > 0, generating, error })); }
  try {
    const source = read(keys.source); if (source) { if (source.version !== 1) throw Error('Unknown workspace source version'); records = validateItems(source.records, 'Records'); photos = validateItems(source.photos, 'Photos'); }
    const view = read(keys.view); if (view) { if (view.version !== 1 || !plain(view.preferences) || !plain(view.richState) || typeof view.draft !== 'string') throw Error('Saved workspace preferences are invalid'); preferences = clone(view.preferences, 6000); richState = clone(view.richState, 100000); draft = view.draft; viewRevision=typeof view.revision==='string'?view.revision:''; }
    const saved = ui.read(keys.layout); generatedTree = saved?.tree ? clone(saved.tree, 64000) : null;
    const restoredView=saved?.workspaceView;
    if(plain(restoredView)&&restoredView.version===1&&restoredView.baseRevision===viewRevision){if(!plain(restoredView.preferences)||!plain(restoredView.richState)||typeof restoredView.draft!=='string')throw Error('Saved snapshot view is invalid');preferences=clone(restoredView.preferences,6000);richState=clone(restoredView.richState,100000);draft=restoredView.draft;}
    if (requestInput && !requestInput.value) requestInput.value = draft;
    const recordShape = value => JSON.stringify(value.map(({checked,...rest})=>rest));
    let sameRecords = saved?.recordsFingerprint === JSON.stringify(records);
    if (!sameRecords && saved?.recordsFingerprint) { try { sameRecords = recordShape(JSON.parse(saved.recordsFingerprint)) === recordShape(records); } catch {} }
    const matchingSource = saved && sameRecords && (saved.photosFingerprint === photosFingerprint(photos) || saved.photosFingerprint === JSON.stringify(photos) || !photos.length && saved.photosFingerprint === undefined);
    const candidate = matchingSource ? generatedTree : options.initialTree;
    if (candidate) { try { validateTree(candidate, records, photos); paint(candidate); origin = matchingSource ? (['source','initial','generated'].includes(saved.workspaceOrigin)?saved.workspaceOrigin:'generated') : 'initial'; } catch { paint(fallback(records, photos)); origin = 'source'; } }
    else paint(fallback(records, photos));
    notify(words.ready);
  } catch (failure) { try { paint(fallback(records, photos)); } catch {} report(failure); }
  try {
    const history=read(keys.history);
    if(history){if(history.version!==1||!Array.isArray(history.snapshots))throw Error('Saved snapshot history is invalid');historyValue(history.snapshots);const ids=new Set();for(const item of history.snapshots){if(!plain(item)||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.label!=='string'||!item.label||item.label.length>160||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||!['source','initial','generated'].includes(item.origin)||!plain(item.tree)||typeof item.recordsFingerprint!=='string'||typeof item.photosFingerprint!=='string'||!plain(item.preferences)||!plain(item.richState)||typeof item.draft!=='string')throw Error('Saved snapshot history is invalid');clone(item.tree,64000);clone(item.preferences,6000);clone(item.richState,100000);ids.add(item.id);}snapshots=history.snapshots;}
  } catch(failure){historyError=String(failure.message||failure);report(failure);}
  const onInput = () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveDraft(requestInput.value).catch(() => {}); }, 200); };
  const onGenerate = event => {
    event.preventDefault();
    const submitted = String(requestInput?.value ?? draft);
    void generate().then(() => {
      if (disposed || String(requestInput?.value ?? draft) !== submitted) return;
      if (![generateButton, requestInput, doc.body, null].includes(doc.activeElement)) return;
      const bounds = container.getBoundingClientRect();
      if (bounds.top < 0 || bounds.top > doc.defaultView.innerHeight * .5) {
        container.scrollIntoView({block:'start',behavior:'instant'});
      }
    }).catch(() => {});
  };
  if (generateButton) generateButton.disabled = false;
  requestInput?.addEventListener('input', onInput); generateButton?.addEventListener('click', onGenerate);
  return Object.freeze({ getRecords: () => clone(records), getPhotos: () => clone(photos), getPreferences: () => clone(preferences), getTree: () => tree && clone(tree, 64000), setRecords, setPhotos, setPreferences, generate, saveSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, get state() { return state(); }, dispose() { disposed = true; clearTimeout(draftTimer); requestInput?.removeEventListener('input', onInput); generateButton?.removeEventListener('click', onGenerate); } });
}

  function renderRich(raw,doc,options) {
    const host=doc.createElement('section');host.style.cssText='position:relative;min-width:0;overflow:hidden;border:1px solid #dce4ee;border-radius:18px;background:#f8fafc;color:#172033;';
    const data=raw.scene||raw.plot||raw.diagram;
    const zh=/^zh/i.test(options.locale||doc.documentElement.lang||'')||(!options.locale&&/[\u3400-\u9fff]/.test(data.title||''));
    if(data.title){const title=doc.createElement('h3');title.textContent=data.title;title.style.cssText='margin:16px;font:600 18px system-ui';host.append(title);}
    const label=(text)=>{const el=doc.createElement('span');el.textContent=text;return el;};
    const svgEl=(tag,attrs={})=>{const el=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));return el;};
    if(raw.type!=='Scene3D'){
      const svg=svgEl('svg',{viewBox:'0 0 640 360',role:'img','aria-label':data.title||raw.type});svg.style.cssText='display:block;width:100%;height:auto;min-height:180px';host.append(svg);
      const tx=(x,y,text,size=16)=>{const t=svgEl('text',{x,y,fill:'#536176','font-size':size,'font-family':'system-ui'});t.textContent=text;svg.append(t);return t;};
      let layoutVisual=()=>{};
      if(raw.type==='Plot'){
        const pts=data.series.flatMap(s=>s.points),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(0,...ys),maxY=Math.max(0,...ys);if(data.kind==='scatter'){minY=Math.min(...ys);maxY=Math.max(...ys);const pad=(maxY-minY||Math.max(1,Math.abs(maxY)*.05))*.08;minY-=pad;maxY+=pad;}if(maxX===minX)maxX++;if(maxY===minY)maxY++;
        const grids=[],marks=[],lines=[];
        for(let i=0;i<=4;i++){const line=svgEl('line',{stroke:'#e0e7ef'});svg.append(line);const text=tx(0,0,Number(maxY-(maxY-minY)*i/4).toPrecision(3));text.setAttribute('text-anchor','end');grids.push({line,text});}
        const axis=svgEl('line',{stroke:'#8090a3'});svg.append(axis);const minLabel=tx(0,0,String(minX)),maxLabel=tx(0,0,String(maxX)),xLabel=tx(0,0,data.xLabel||''),yLabel=tx(4,20,data.yLabel||'');maxLabel.setAttribute('text-anchor','end');xLabel.setAttribute('text-anchor','middle');
        const plotLegend=doc.createElement('div');plotLegend.dataset.plotLegend='true';plotLegend.style.cssText='display:flex;flex-wrap:wrap;gap:8px 16px;padding:0 16px 10px;font:16px system-ui;';for(const series of data.series){const item=doc.createElement('span');item.textContent=series.name;item.dataset.seriesColor=series.color;item.style.cssText='max-width:100%;overflow-wrap:anywhere;color:'+series.color;plotLegend.append(item);}host.insertBefore(plotLegend,svg);
        for(const series of data.series){if(data.kind==='line'){const line=svgEl('polyline',{fill:'none',stroke:series.color,'stroke-width':3});svg.append(line);lines.push({line,points:series.points});}for(const point of series.points){const mark=svgEl(data.kind==='bar'?'rect':'circle',{fill:series.color});const title=svgEl('title');title.textContent=series.name+': '+point[0]+', '+point[1];mark.append(title);svg.append(mark);marks.push({mark,point});}}
        layoutVisual=(width,height)=>{
          const left=Math.min(64,Math.max(48,width*.16)),right=width-18,top=32,bottom=Math.max(top+60,height-52);
          const barWidth=Math.max(4,Math.min(28,(right-left)*.7/pts.length)),xPad=data.kind==='bar'?barWidth/2+3:0;
          const X=x=>left+xPad+(x-minX)/(maxX-minX)*(right-left-2*xPad),Y=y=>bottom-(y-minY)/(maxY-minY)*(bottom-top);
          for(let i=0;i<grids.length;i++){const {line,text}=grids[i],y=top+i*(bottom-top)/4;for(const[k,v]of Object.entries({x1:left,y1:y,x2:right,y2:y}))line.setAttribute(k,String(v));text.setAttribute('x',String(left-8));text.setAttribute('y',String(y+5));}
          for(const[k,v]of Object.entries({x1:left,y1:bottom,x2:right,y2:bottom}))axis.setAttribute(k,String(v));
          for(const [text,x,y]of[[minLabel,left,bottom+25],[maxLabel,right,bottom+25],[xLabel,(left+right)/2,height-7]]){text.setAttribute('x',String(x));text.setAttribute('y',String(y));}
          for(const {line,points}of lines)line.setAttribute('points',points.map(p=>X(p[0])+','+Y(p[1])).join(' '));
          for(const {mark,point:p}of marks){const hit=mark.parentElement?.getAttribute('role')==='button'?mark.previousElementSibling:null;if(data.kind==='bar'){const attrs={x:X(p[0])-barWidth/2,y:Math.min(Y(p[1]),Y(0)),width:barWidth,height:Math.max(1,Math.abs(Y(p[1])-Y(0)))};for(const[k,v]of Object.entries(attrs))mark.setAttribute(k,String(v));if(hit){for(const[k,v]of Object.entries({x:attrs.x-Math.max(0,28-attrs.width)/2,y:attrs.y-Math.max(0,28-attrs.height)/2,width:Math.max(28,attrs.width),height:Math.max(28,attrs.height)}))hit.setAttribute(k,String(v));}}else{mark.setAttribute('cx',String(X(p[0])));mark.setAttribute('cy',String(Y(p[1])));mark.setAttribute('r','4.5');if(hit){hit.setAttribute('cx',String(X(p[0])));hit.setAttribute('cy',String(Y(p[1])));hit.setAttribute('r','16');}}}
        };
      }else{
        const nodes=new Map(data.nodes.map(n=>[n.id,n])),edgeEntries=[],nodeEntries=[];
        for(const edge of data.edges){const line=svgEl('line',{stroke:'#a0adbd','stroke-width':2});svg.append(line);const text=edge.label?tx(0,0,edge.label,14):null;if(text)text.dataset.edgeLabel='true';edgeEntries.push({edge,line,text});}
        for(const n of data.nodes){const g=svgEl('g',{tabindex:0,role:'button','aria-label':n.label});g.style.cursor='pointer';const circle=svgEl('circle',{r:20,fill:n.color}),text=svgEl('text',{'font-size':16,'font-family':'system-ui',fill:'#172033'});g.append(circle,text);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();g.dispatchEvent(new MouseEvent('click'));}});g.addEventListener('click',()=>{for(const el of svg.querySelectorAll('circle'))el.setAttribute('stroke','none');circle.setAttribute('stroke','#172033');circle.setAttribute('stroke-width','4');});svg.append(g);nodeEntries.push({n,circle,text});}
        layoutVisual=(width,height)=>{
          const X=n=>38+n.x*Math.max(40,width-76),Y=n=>34+n.y*Math.max(40,height-105);
          for(const{edge,line,text}of edgeEntries){const a=nodes.get(edge.from),b=nodes.get(edge.to);for(const[k,v]of Object.entries({x1:X(a),y1:Y(a),x2:X(b),y2:Y(b)}))line.setAttribute(k,String(v));if(text){text.style.display=width<600?'none':'';text.setAttribute('x',String((X(a)+X(b))/2));text.setAttribute('y',String((Y(a)+Y(b))/2-7));}}
          for(const{n,circle,text}of nodeEntries){const x=X(n),y=Y(n);circle.setAttribute('cx',String(x));circle.setAttribute('cy',String(y));const crowded=data.nodes.some(other=>other.id!==n.id&&Math.abs(other.x-n.x)<.12&&Math.abs(other.y-n.y)<.22),side=crowded?(x<width/2+1?1:-1):0,labelX=x+side*28,anchor=side?(side>0?'start':'end'):n.x<.18?'start':n.x>.82?'end':'middle',maxWidth=Math.max(48,Math.min(150,anchor==='middle'?Math.min(labelX,width-labelX)*2-8:anchor==='start'?width-labelX-6:labelX-6)),lines=[];let line='',size=0;for(const ch of n.label){const advance=/[\u3400-\u9fff]/.test(ch)?16:8; if(line&&size+advance>maxWidth){lines.push(line);line='';size=0;}line+=ch;size+=advance;}if(line)lines.push(line);text.replaceChildren();text.setAttribute('text-anchor',anchor);for(let i=0;i<lines.length;i++){const span=svgEl('tspan',{x:labelX,y:(side?y+5-(lines.length-1)*9.5:y+35)+i*19});span.textContent=lines[i];text.append(span);}}
        };
      }
      layoutVisual(640,360);
      const richSelection=enhanceRichSelection(host,svg,raw,doc,options,(key,view,active)=>{const callback=options.onRichStateChange;if(typeof callback!=='function')return;let queue=richSaveQueues.get(callback);if(!queue){queue={running:false,pending:new Map()};richSaveQueues.set(callback,queue);}queue.pending.set(key,{view,host,active});void flushRichSaves(callback,queue);});
      let resize=null,unmount=null,disposed=false;
      const fitLabels=()=>{const box=svg.getBoundingClientRect(),width=Math.max(120,box.width||640),height=Math.max(180,box.height||360);svg.setAttribute('viewBox','0 0 '+width+' '+height);layoutVisual(width,height);};
      svg.__liveuiMount=()=>{if(disposed)return;fitLabels();if(typeof ResizeObserver==='function'&&!resize){resize=new ResizeObserver(fitLabels);resize.observe(svg);}if(typeof MutationObserver==='function'&&!unmount){unmount=new MutationObserver(()=>{if(!host.isConnected)svg.__liveuiDispose();});unmount.observe(doc.documentElement,{childList:true,subtree:true});}};
      svg.__liveuiDispose=()=>{disposed=true;richSelection.dispose();const queue=richSaveQueues.get(options.onRichStateChange);if(queue?.pending.get(richSelection.key)?.host===host)queue.pending.delete(richSelection.key);resize?.disconnect();unmount?.disconnect();};return host;
    }
    const canvas=doc.createElement('canvas');canvas.setAttribute('aria-label',data.title||(zh?'可交互三维场景':'Interactive 3D scene'));canvas.setAttribute('role','img');canvas.tabIndex=0;canvas.style.cssText='width:100%;height:330px;display:block;touch-action:none;cursor:grab';host.append(canvas);
    const controls=doc.createElement('div');controls.style.cssText='display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px;background:#fff;font:14px system-ui';
    const spread=doc.createElement('input');spread.type='range';spread.min='.3';spread.max='2.5';spread.step='.05';spread.value='1';spread.setAttribute('aria-label',zh?'调整物体间距':'Spread objects');spread.style.cssText='min-width:100px;flex:1';
    const reset=doc.createElement('button');reset.type='button';reset.textContent=zh?'重置视角':'Reset view';reset.style.cssText='border:1px solid #d5dce6;border-radius:8px;background:white;padding:8px 12px;color:#172033';controls.append(label(zh?'间距':'Spread'),spread,reset);host.append(controls);
    const legend=doc.createElement('div');legend.style.cssText='display:flex;flex-wrap:wrap;gap:10px;padding:0 16px 12px;font:13px system-ui';const legendLabels=new Set();for(const o of data.objects){const text=typeof o.label==='string'?o.label.trim():'';if(!text||legendLabels.has(text))continue;legendLabels.add(text);const l=label(text);l.dataset.seriesColor=o.color;l.style.color=o.color;legend.append(l);}if(legend.childNodes.length)host.append(legend);
    const gl=canvas.getContext('webgl',{antialias:true,preserveDrawingBuffer:true});if(!gl){const msg=label(zh?'此设备暂不支持三维渲染。':'3D rendering is unavailable on this device.');host.append(msg);return host;}
    host.dataset.renderer='webgl';
    const shader=(kind,src)=>{const s=gl.createShader(kind);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))fail('3D shader');return s;};
    const program=gl.createProgram();const vertex=shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec3 c;varying vec3 col;void main(){gl_Position=vec4(p,1.0);col=c;}');const fragment=shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 col;void main(){gl_FragColor=vec4(col,1.0);}');gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(program,gl.LINK_STATUS))fail('3D program');gl.useProgram(program);
    const pLoc=gl.getAttribLocation(program,'p'),cLoc=gl.getAttribLocation(program,'c'),pb=gl.createBuffer(),cb=gl.createBuffer();
    const key=JSON.stringify(data.objects.map(o=>o.id));let view={yaw:.55,pitch:.58,zoom:1,spread:1,...(options.richState?.[key]||{})};
    for(const k of ['yaw','pitch','zoom','spread'])if(!Number.isFinite(view[k]))view[k]={yaw:.55,pitch:.58,zoom:1,spread:1}[k];view.zoom=Math.max(.4,Math.min(2.5,view.zoom));view.spread=Math.max(.3,Math.min(2.5,view.spread));spread.value=String(view.spread);
    const callback=options.onRichStateChange;let saveQueue=null;
    if(typeof callback==='function'){saveQueue=richSaveQueues.get(callback);if(!saveQueue){saveQueue={running:false,pending:new Map()};richSaveQueues.set(callback,saveQueue);}}
    const emit=()=>{host.dataset.view=JSON.stringify(view);if(disposed||!saveQueue)return;saveQueue.pending.set(key,{view:{...view},host,active:()=>!disposed});void flushRichSaves(callback,saveQueue);};
    function mesh(shape){const verts=[];const tri=(a,b,c)=>verts.push([a,b,c]);
      if(shape==='box'){const v=[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];for(const q of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[3,0,4,7]]){tri(v[q[0]],v[q[1]],v[q[2]]);tri(v[q[0]],v[q[2]],v[q[3]]);}}
      else{const torus=shape==='torus',sphere=shape==='sphere',N=20,M=sphere?12:torus?10:1;const at=(i,j)=>{const u=i/N*Math.PI*2,v=j/M*Math.PI*2;if(torus)return[(.65+.22*Math.cos(v))*Math.cos(u),.22*Math.sin(v),(.65+.22*Math.cos(v))*Math.sin(u)];if(sphere){const a=j/M*Math.PI;return[.6*Math.sin(a)*Math.cos(u),.6*Math.cos(a),.6*Math.sin(a)*Math.sin(u)];}const r=shape==='cone'?(1-j)*.6:.5;return[r*Math.cos(u),j-.5,r*Math.sin(u)];};for(let i=0;i<N;i++)for(let j=0;j<M;j++){const a=at(i,j),b=at(i+1,j),c=at(i+1,j+1),d=at(i,j+1);tri(a,b,c);tri(a,c,d);}if(!sphere&&!torus)for(let i=0;i<N;i++){tri([0,-.5,0],at(i+1,0),at(i,0));tri([0,.5,0],at(i,1),at(i+1,1));}}
      return verts;
    }
    const meshes=data.objects.map(o=>mesh(o.shape));
    const rot=(v,a,axis)=>{const c=Math.cos(a),s=Math.sin(a),[x,y,z]=v;return axis===0?[x,y*c-z*s,y*s+z*c]:axis===1?[x*c+z*s,y,-x*s+z*c]:[x*c-y*s,x*s+y*c,z];};
    function draw(){const width=Math.max(1,canvas.clientWidth||480),height=Math.max(180,canvas.clientHeight||330),dpr=Math.min(2,doc.defaultView.devicePixelRatio||1);canvas.width=width*dpr;canvas.height=height*dpr;gl.viewport(0,0,canvas.width,canvas.height);const computed=doc.defaultView.getComputedStyle(host).backgroundColor;const rgb=computed.match(/[\d.]+/g);const color=data.background||(rgb&&rgb.length>=3?'#'+rgb.slice(0,3).map(n=>Math.round(Number(n)).toString(16).padStart(2,'0')).join(''):'#eef3fa');gl.clearColor(parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
      const positions=[],colors=[];
      const world=meshes.map((mesh,k)=>mesh.map(face=>face.map(v=>{const o=data.objects[k];let a=v.map((n,i)=>n*o.scale[i]);for(let i=0;i<3;i++)a=rot(a,(o.rotation?.[i]||0)*Math.PI/180,i);return a.map((n,i)=>n+o.position[i]*view.spread);}))),vertices=world.flat(2);
      const low=[0,1,2].map(i=>Math.min(...vertices.map(v=>v[i]))),high=[0,1,2].map(i=>Math.max(...vertices.map(v=>v[i]))),center=low.map((n,i)=>(n+high[i])/2),extent=Math.max(.5,...low.map((n,i)=>high[i]-n));
      const project=q=>rot(rot(q.map((n,i)=>n-center[i]),view.yaw,1),view.pitch,0),transformed=world.map(mesh=>mesh.map(face=>face.map(project))),cameraVertices=transformed.flat(2),aspect=width/height;
      // Fit the actual rotated mesh bounds, centered on its own occupied volume.
      // Positive pitch exposes top surfaces under the renderer's rotation convention.
      const fitted=Math.max(.25,...cameraVertices.map(q=>q[2]+Math.max(Math.abs(q[0])*2.3/(.84*aspect),Math.abs(q[1])*2.3/.84,.15))),camera=fitted/view.zoom;
      for(let k=0;k<data.objects.length;k++){const o=data.objects[k],rgb=[1,3,5].map(i=>parseInt(o.color.slice(i,i+2),16)/255);for(const face of transformed[k]){const a=face[0],b=face[1],c=face[2],u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n)||1,shade=.4+.6*Math.abs((n[0]*.3+n[1]*.8+n[2]*.5)/len);for(const q of face){const dist=Math.max(.15,camera-q[2]);positions.push(q[0]/dist*2.3/aspect,q[1]/dist*2.3,Math.max(-.99,Math.min(.99,-q[2]/(extent*5))));colors.push(...rgb.map(n=>Math.min(1,n*shade)));}}}
      for(const[loc,buffer,values]of[[pLoc,pb,positions],[cLoc,cb,colors]]){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}gl.drawArrays(gl.TRIANGLES,0,positions.length/3);host.dataset.triangles=String(positions.length/9);
      if(data.grid!==false){const lines=[],gridColors=[];for(let i=-5;i<=5;i++)for(const axis of [0,1])for(const side of [-1,1]){const gridExtent=Math.max(high[0]-low[0],high[2]-low[2],1)*.65;let q=axis===0?[center[0]+i/5*gridExtent,low[1]-.02,center[2]+side*gridExtent]:[center[0]+side*gridExtent,low[1]-.02,center[2]+i/5*gridExtent];q=project(q);const dist=Math.max(.2,camera-q[2]);lines.push(q[0]/dist*2.3/(width/height),q[1]/dist*2.3,Math.max(-.99,Math.min(.99,-q[2]/(extent*5))));gridColors.push(.76,.80,.86);}for(const[loc,buffer,values]of[[pLoc,pb,lines],[cLoc,cb,gridColors]]){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}gl.drawArrays(gl.LINES,0,lines.length/3);}
      host.dataset.view=JSON.stringify(view);
    }
    let pointer=null;canvas.addEventListener('pointerdown',e=>{pointer=[e.clientX,e.clientY];canvas.setPointerCapture?.(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!pointer)return;view.yaw+=(e.clientX-pointer[0])*.009;view.pitch=Math.max(-1.4,Math.min(1.4,view.pitch+(e.clientY-pointer[1])*.009));pointer=[e.clientX,e.clientY];draw();});canvas.addEventListener('pointerup',()=>{pointer=null;emit();});canvas.addEventListener('pointercancel',()=>{pointer=null;emit();});canvas.addEventListener('wheel',e=>{e.preventDefault();view.zoom=Math.max(.4,Math.min(2.5,view.zoom*Math.exp(-e.deltaY*.001)));draw();emit();},{passive:false});canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')view.yaw-=.15;if(e.key==='ArrowRight')view.yaw+=.15;if(e.key==='ArrowUp')view.pitch-=.15;if(e.key==='ArrowDown')view.pitch+=.15;if(e.key==='+')view.zoom=Math.min(2.5,view.zoom+.1);if(e.key==='-')view.zoom=Math.max(.4,view.zoom-.1);draw();emit();});spread.addEventListener('input',()=>{view.spread=Number(spread.value);draw();});spread.addEventListener('change',emit);reset.addEventListener('click',()=>{view={yaw:.55,pitch:.58,zoom:1,spread:1};spread.value='1';draw();emit();});
    // Detached build renders once at a conservative size; connection/resize refines resolution without a perpetual animation loop.
    draw();let ro=null,mo=null,disposed=false;
    canvas.__liveuiMount=()=>{if(disposed)return;draw();if(!ro&&typeof ResizeObserver==='function'){ro=new ResizeObserver(()=>{if(host.isConnected&&!disposed)draw();});ro.observe(canvas);}if(!mo&&typeof MutationObserver==='function'){mo=new MutationObserver(()=>{if(!host.isConnected)canvas.__liveuiDispose();});mo.observe(doc.documentElement,{childList:true,subtree:true});}};
    canvas.__liveuiDispose=()=>{if(disposed)return;disposed=true;if(saveQueue?.pending.get(key)?.host===host)saveQueue.pending.delete(key);ro?.disconnect();mo?.disconnect();gl.deleteBuffer(pb);gl.deleteBuffer(cb);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.dataset.disposed='true';};

    return host;
  }

  // The tree owns only its workspace root. Resizing preserves DOM nodes, focus and control state.
  function adaptiveLayout(root, entries, doc) {
    let observer=null, removal=null, disposed=false;
    const fonts={sans:'system-ui, -apple-system, sans-serif',serif:'Georgia, "Times New Roman", serif',mono:'ui-monospace, SFMono-Regular, monospace'};
    const contrast=(a,b)=>{const lum=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const put=(node,props)=>{for(const [key,value] of Object.entries(props))if(node.style[key]!==String(value))node.style[key]=String(value);};
    function update(){
      if(disposed||!root.isConnected)return;
      const width=root.parentElement?.clientWidth||doc.documentElement.clientWidth;
      const mobile=width<=600;const byNode=new Map();
      for(const entry of entries){
        const {node,type,style,raw}=entry;
        const merged={...style,...(mobile?style.mobile:{})};delete merged.mobile;
        if(mobile&&style.mobile){
          if(style.mobile.columns!==undefined&&style.mobile.columnWeights===undefined)delete merged.columnWeights;
          if(style.mobile.columnWeights!==undefined&&style.mobile.columns===undefined)delete merged.columns;
          if(style.mobile.width!==undefined)delete merged.widthPercent;
          if(style.mobile.widthPercent!==undefined)delete merged.width;
          if(style.mobile.height!==undefined)delete merged.aspectRatio;
          if(style.mobile.aspectRatio!==undefined)delete merged.height;
        }
        const inherited=byNode.get(node.parentElement)||{color:'#172033',background:'#ffffff',fontSize:16,fontFamily:'sans',fontWeight:400,lineHeight:1.5,columns:1};
        const bg=merged.background||inherited.background;
        let color=merged.color||(merged.tone==='muted'?'#536176':merged.tone==='accent'?'#2456a6':inherited.color);
        // A partial nested palette must not create unreadable text against an inherited surface.
        if(contrast(color,bg)<4.5)color=contrast('#172033',bg)>=4.5?'#172033':'#ffffff';
        const appearance={color,background:bg,fontSize:merged.fontSize||inherited.fontSize,fontFamily:merged.fontFamily||inherited.fontFamily,fontWeight:merged.fontWeight||inherited.fontWeight,lineHeight:merged.lineHeight||inherited.lineHeight,columns:1};
        const gap=merged.gap??12,padding=merged.padding??(type==='Card'?16:0);
        const max=merged.maxWidth?Math.min(merged.maxWidth,width):width;
        put(node,{width:merged.width!==undefined?Math.min(merged.width,max)+'px':merged.widthPercent!==undefined?'min(100%, max(180px, '+merged.widthPercent+'%))':node===root?'100%':'auto',maxWidth:merged.maxWidth?'min(100%, '+merged.maxWidth+'px)':'100%',marginInline:node===root?'auto':'',padding:padding+'px',color,backgroundColor:merged.background||'transparent',fontFamily:fonts[appearance.fontFamily],fontSize:appearance.fontSize+'px',fontWeight:appearance.fontWeight,lineHeight:appearance.lineHeight,borderRadius:(merged.radius??(type==='Card'?12:0))+'px',borderWidth:(merged.borderWidth??(type==='Card'?1:0))+'px',borderStyle:'solid',borderColor:merged.borderColor||'#dce2e8',textAlign:merged.align||'start',gap:gap+'px'});
        if(node===root)node.style.backgroundColor=bg;
        if(containers.has(type)){
          put(node,{display:type==='Grid'?'grid':'flex',flexDirection:merged.direction||'column',flexWrap:merged.direction==='row'?'wrap':'nowrap',alignItems:type==='Grid'?'start':'stretch'});
          if(type==='Grid'){
            const available=Math.max(1,node.clientWidth-padding*2);
            const desired=merged.columnWeights?.length||merged.columns||2;
            let columns=Math.min(desired,Math.max(1,Math.floor((available+gap)/(180+gap))));
            if(columns===desired&&merged.columnWeights&&(available-gap*(columns-1))*Math.min(...merged.columnWeights)/merged.columnWeights.reduce((a,b)=>a+b,0)<180)columns=1;
            appearance.columns=columns;
            const weights=columns===desired&&merged.columnWeights?merged.columnWeights:Array(columns).fill(1);
            node.style.gridTemplateColumns=weights.map(n=>'minmax(0, '+n+'fr)').join(' ');
            node.dataset.layoutColumns=String(columns);
          }
        }
        node.style.gridColumn=inherited.columns>1?'span '+Math.min(merged.span||1,inherited.columns):'auto';
        byNode.set(node,appearance);
        const rich=node.querySelector(':scope > section');
        if(rich){
          // Preserve series/object colors. If a new page palette obscures them, give the
          // visualization its own readable surface rather than recoloring every series.
          const palette=raw.scene?.objects?.map(o=>o.color)||raw.plot?.series?.map(s=>s.color)||raw.diagram?.nodes?.map(n=>n.color)||[];
          const score=surface=>Math.min(...palette.map(c=>contrast(c,surface)));
          let surface=bg;
          if(palette.length&&score(bg)<2.2)surface=[bg,'#ffffff','#111111','#777777'].sort((a,b)=>score(b)-score(a))[0];
          const foreground=contrast(color,surface)>=4.5?color:contrast('#172033',surface)>=4.5?'#172033':'#ffffff';
          put(rich,{backgroundColor:surface,color:foreground,borderRadius:(merged.radius??18)+'px',borderColor:merged.borderColor||'#dce4ee'});
          for(const el of rich.querySelectorAll('[data-rich-details],select,button'))put(el,{backgroundColor:surface,color:foreground,fontFamily:fonts[appearance.fontFamily],fontSize:Math.max(16,Math.min(appearance.fontSize,20))+'px'});
          for(const el of rich.querySelectorAll('svg text'))el.setAttribute('fill',foreground);
          for(const el of rich.querySelectorAll('[data-series-color]')){put(el,{color:foreground,paddingInlineStart:'8px',borderInlineStart:'3px solid '+el.dataset.seriesColor});}
          for(const el of rich.querySelectorAll('div'))if(el.style.background)el.style.background=surface;
        }
        const visual=node.querySelector(':scope > section > canvas, :scope > section > svg, :scope > img');
        if(visual){
          const visualWidth=visual.clientWidth||node.clientWidth||width;
          const target=merged.height??(merged.aspectRatio?visualWidth/merged.aspectRatio:null);
          visual.style.height=target!==null?Math.max(180,Math.min(640,target,mobile?visualWidth*1.5:640))+'px':visual.tagName==='CANVAS'?'330px':'auto';
          if(visual.tagName==='IMG'){visual.style.maxHeight=target!==null?'640px':'440px';visual.style.objectFit='contain';}
        }
      }
    }
    root.__liveuiLayoutMount=()=>{
      if(disposed)return;update();
      if(!observer&&typeof ResizeObserver==='function'){observer=new ResizeObserver(update);observer.observe(root.parentElement||root);}
      if(!removal&&typeof MutationObserver==='function'){removal=new MutationObserver(()=>{if(!root.isConnected)root.__liveuiLayoutDispose();});removal.observe(doc.documentElement,{childList:true,subtree:true});}
    };
    root.__liveuiLayoutDispose=()=>{disposed=true;observer?.disconnect();removal?.disconnect();};
  }

  function build(tree, options = {}) {
    json(tree, 64000);
    const records = references(options.records || [], 'records'), photos = references(options.photos || [], 'photos');
    const seenRecords = new Set(), seenPhotos = new Set();
    let count = 0, textLength = 0, sceneCount = 0;
    const richRoots=[], layoutEntries=[];
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
      if(raw.type==='Scene3D'&&++sceneCount>4)fail('at most 4 Scene3D views per tree');
      const allowed = new Set(['type','style','recordId']);
      if (containers.has(raw.type)) allowed.add('children');
      if(raw.type==='Scene3D')allowed.add('scene');if(raw.type==='Plot')allowed.add('plot');if(raw.type==='Diagram')allowed.add('diagram');
      if (raw.type === 'Text') { allowed.add('text'); allowed.add('checked'); }
      if (raw.type === 'Checklist') allowed.add('checked');
      if (raw.type === 'Image') { allowed.add('photoId'); allowed.add('text'); }
      for (const key of Object.keys(raw)) if (!allowed.has(key)) fail('unsupported property ' + key);
      const node = doc.createElement('div'); node.dataset.liveuiComponent = raw.type;
      node.style.cssText = 'box-sizing:border-box;min-width:0;max-width:100%;font-size:inherit;line-height:inherit;overflow-wrap:anywhere;';
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
      if (['Scene3D','Plot','Diagram'].includes(raw.type)) { validateRich(raw); const rich=renderRich(raw,doc,options);richRoots.push(rich);node.append(rich); }
      const style = raw.style === undefined ? {} : validateStructuredUiStyle(raw.style,2);
      if(!['Image','Scene3D','Plot','Diagram'].includes(raw.type)&&[style,style.mobile||{}].some(s=>s.height!==undefined||s.aspectRatio!==undefined))fail('visual dimensions require a visual leaf');
      layoutEntries.push({node,type:raw.type,style,raw});
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
    let root;try {root = visit(tree,1);
    if ([...records.keys()].some(id=>!seenRecords.has(id)) || [...photos.keys()].some(id=>!seenPhotos.has(id))) fail('omitted source content');
    adaptiveLayout(root,layoutEntries,doc);
    return root;}catch(error){for(const rich of richRoots)disposeRich(rich);throw error;}
  }
  function mountRich(root){root.__liveuiLayoutMount?.();for(const canvas of root.querySelectorAll('canvas,svg'))canvas.__liveuiMount?.();}
  function disposeRich(root){root.__liveuiLayoutDispose?.();for(const child of root.children)child.__liveuiLayoutDispose?.();for(const canvas of root.querySelectorAll('canvas,svg'))canvas.__liveuiDispose?.();}
  function render(container, tree, options = {}) {
    if (!container || typeof container.replaceChildren !== 'function') fail('invalid container');
    const root = build(tree,{...options,document:container.ownerDocument});
    generations.set(container,(generations.get(container)||0)+1);disposeRich(container);container.replaceChildren(root);mountRich(root);return root;
  }
  async function generate(container,prompt,options) {
    if (!container?.isConnected || !options || typeof options.getRecords !== 'function' || typeof options.storageKey !== 'string' || !options.storageKey) fail('invalid generation options');
    if (active.has(container)) throw Error('Wait for the current layout to finish');
    active.add(container);
    let candidate=null;
    const version = (generations.get(container)||0)+1;generations.set(container,version);
    const requestId = 'ui-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
    const snapshot = () => json(options.getRecords());
    try {
      const originalChildren = Array.from(container.childNodes);
      const childrenUnchanged = () => container.childNodes.length === originalChildren.length && originalChildren.every((child,index)=>container.childNodes[index] === child);
      const fingerprint = snapshot(),records = JSON.parse(fingerprint),photos = (options.getPhotos ? options.getPhotos() : []).map(photo=>({...photo}));
      references(records,'records');references(photos,'photos');
      const photosUnchanged = () => { const latest = options.getPhotos ? options.getPhotos() : []; return latest.length === photos.length && latest.every((photo,index)=>photo.id === photos[index].id && (photo.src || photo.url) === (photos[index].src || photos[index].url)); };
      const current = () => (!options.isCurrent || options.isCurrent()) && container.isConnected && childrenUnchanged() && generations.get(container) === version && snapshot() === fingerprint && photosUnchanged();
      const previousTree = options.tree ?? options.previousTree;
      if (previousTree !== undefined) json(previousTree,64000); // Prior references may legitimately differ after source edits.
      const view = container.ownerDocument.defaultView;
      const bounds = container.getBoundingClientRect();
      const previous = read(options.storageKey);
      const presentationContext = {viewport:{width:Math.round(view.innerWidth),height:Math.round(view.innerHeight),contentWidth:Math.round(bounds.width)},components:[...types],styleVersion:2,
        previousRequest:typeof previous?.requirement==='string'?previous.requirement.slice(0,4000):'',
        ...(typeof options.layoutBrief==='string'?{layoutBrief:options.layoutBrief.slice(0,4000)}:{}),
        ...(typeof options.getContext==='function'?{appContext:JSON.parse(json(options.getContext(),6000))}:{})};
      const response = await sdk.ai(prompt,{uiProtocol:'liveui-tree-v1',requestId,records,photos:photos.map(photo=>({id:photo.id})),presentationContext,...(previousTree !== undefined ? {tree:previousTree} : {})});
      if (response?.requestId !== requestId) fail('mismatched generation response');
      const tree = response?.data?.tree;
      candidate = build(tree,{records,photos,onToggle:options.onToggle,richState:options.richState,onRichStateChange:options.onRichStateChange,document:container.ownerDocument});
      if (!current()) throw Error('Content changed while generating. Generate again.');
      const state = {tree,requestId,requirement:prompt,...(typeof options.getPhotosFingerprint==='function'?{photosFingerprint:options.getPhotosFingerprint()}:{}),updatedAt:new Date().toISOString(),recordsFingerprint:fingerprint};
      const ack = await sdk.save(options.storageKey,json(state,100000));
      if (ack === false || ack?.ok === false) throw Error('Saving failed. Please retry.');
      if (!current()) throw Error('Content changed while saving. Reopen or generate again.');
      disposeRich(container);container.replaceChildren(candidate);mountRich(candidate);candidate=null;return state;
    } finally { if(candidate)disposeRich(candidate);active.delete(container); }
  }
  function read(storageKey) {
    const raw = sdk.storage.getItem(storageKey);if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || raw.length > 100000) fail('saved state exceeds limit');
    let state;try { state = JSON.parse(raw); } catch { fail('saved state is not JSON'); }
    if (!plain(state) || !plain(state.tree) || typeof state.requestId !== 'string' || typeof state.updatedAt !== 'string') fail('invalid saved state');
    json(state.tree,64000);return state;
  }
  const api = {render,generate,read,capabilities:Object.freeze({protocol:'liveui-tree-v1',styleVersion:2,components:Object.freeze([...types])})};
  api.workspace = options => createWorkspace(sdk,api,options);
  return api;
};
