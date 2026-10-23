const $ = selector => document.querySelector(selector);
let state; let activeId = null; let currentJob = null; let clockTimer; let toastTimer;
let frameStore = {}; let frameChannel = ''; let frameAppId = null;
const storeWrites = new Map();
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const randomChannel = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, '0')).join('');
async function api(route, options = {}) {
  const response = await fetch(new URL('api/' + route, import.meta.url), { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed');
  return data;
}
function toast(message, duration = 5000) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, duration);
}
function appSymbol(app) {
  return `<span class="app-symbol" style="--accent:${esc(app.accent)}">${esc(app.name.slice(0, 1))}</span>`;
}
function render() {
  $('#user-name').textContent = state.user;
  $('.sidebar-bottom small').textContent = state.engine.model;
  $('#app-count').textContent = state.apps.length;
  $('#memory-count').textContent = state.memory.entries.length + (state.memory.manual.trim() ? 1 : 0);
  $('#app-list').innerHTML = state.apps.length ? state.apps.map(app => `<button class="nav-app ${activeId === app.id ? 'active' : ''}" data-open-app="${app.id}">${appSymbol(app)}<span>${esc(app.name)}</span></button>`).join('') : '<p class="nav-empty">Your apps will appear here.<br>Start with a daily task.</p>';
  $('#home-apps').innerHTML = state.apps.length ? state.apps.map(app => `<button class="home-card" data-open-app="${app.id}" style="--accent:${esc(app.accent)}"><div class="card-visual"><div class="mini-window"><div class="mini-line"></div><div class="mini-line"></div><div class="mini-line" style="width:65%"></div><div class="mini-columns"><i></i><i></i><i></i></div></div></div><div class="card-info"><h3>${esc(app.name)}<span>↗</span></h3><p>${esc(app.description)}</p></div></button>`).join('') : '<div class="empty-space">No apps yet.<br>Describe a task above to create an app and save its data here.</div>';
  document.querySelectorAll('[data-open-app]').forEach(button => button.onclick = () => openApp(button.dataset.openApp).catch(error => toast(error.message)));
}
async function refresh() { state = await api('state'); render(); }
function home() {
  activeId = null; frameAppId = null; $('#home-view').hidden = false; $('#app-view').hidden = true;
  $('#view-title').textContent = 'Workspace'; $('#app-frame').srcdoc = ''; $('.sidebar').classList.remove('open'); render();
}
function frameBootstrap(initialStore, channel) {
  const values = Object.assign(Object.create(null), initialStore); let counter = 0; const pending = new Map();
  function request(type, payload) {
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The request timed out. Please try again.')); }, 930000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ channel, id, type, ...payload }, '*');
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.type !== 'reply') return;
    const p = pending.get(event.data.id); if (!p) return;
    pending.delete(event.data.id); clearTimeout(p.timer);
    if (event.data.error) p.reject(new Error(event.data.error)); else p.resolve(event.data.value);
  });
  const storage = {
    getItem(key) { key = String(key); return Object.hasOwn(values, key) ? values[key] : null; },
    setItem(key, value) { values[String(key)] = String(value); request('store', { store: values }).catch(error => console.error('Save failed', error)); },
    removeItem(key) { delete values[String(key)]; request('store', { store: values }).catch(error => console.error('Save failed', error)); },
    clear() { for (const key of Object.keys(values)) delete values[key]; request('store', { store: values }).catch(error => console.error('Save failed', error)); },
    key(index) { return Object.keys(values)[index] || null; }, get length() { return Object.keys(values).length; }
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: false });
  window.liveuiagent = {
    storage,
    ai(prompt, context) { return request('ai', { prompt, context }); },
    download(filename, content, mimeType = 'text/plain;charset=utf-8') {
      const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };
}
async function openApp(id) {
  const data = await api('apps/' + id);
  activeId = id; frameAppId = id; frameStore = data.store; frameChannel = randomChannel();
  $('#home-view').hidden = true; $('#app-view').hidden = false;
  $('#view-title').textContent = data.app.name; $('#active-name').textContent = data.app.name;
  $('#active-description').textContent = data.app.description; $('#revision-label').textContent = 'v' + data.app.revision;
  $('#edit-prompt').value = ''; $('#saved-status').textContent = 'Saved data is preserved when you update the app';
  const safeStore = JSON.stringify(data.store).replace(/</g, '\\u003c');
  const bootstrap = `<script>(${frameBootstrap.toString()})(${safeStore},${JSON.stringify(frameChannel)});<\/script>`;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
  const insertion = policy + bootstrap;
  $('#app-frame').srcdoc = insertion + data.html;
  $('.sidebar').classList.remove('open'); render();
}
window.addEventListener('message', async event => {
  if (event.source !== $('#app-frame').contentWindow || event.data?.channel !== frameChannel || !frameAppId) return;
  const { type, id, channel } = event.data; const appId = frameAppId; const source = event.source;
  let actionJobId;
  const reply = (value, error) => source.postMessage({ channel, type: 'reply', id, value, error }, '*');
  try {
    if (type === 'store') {
      const snapshot = event.data.store;
      if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object' || JSON.stringify(snapshot).length > 1000000) throw new Error('App data exceeds the storage limit');
      frameStore = snapshot; $('#saved-status').textContent = 'Saving…';
      const previous = storeWrites.get(appId) || Promise.resolve();
      const write = previous.catch(() => {}).then(() => api('apps/' + appId + '/store', { method: 'PUT', body: JSON.stringify(snapshot) }));
      storeWrites.set(appId, write); await write;
      if (storeWrites.get(appId) === write) storeWrites.delete(appId);
      if (frameAppId === appId) $('#saved-status').textContent = 'Saved';
      reply({ ok: true });
    } else if (type === 'ai') {
      if (typeof event.data.prompt !== 'string' || !event.data.prompt.trim()) throw new Error('Enter the task you want to complete');
      const job = await api('apps/' + appId + '/action', { method: 'POST', body: JSON.stringify({ prompt: event.data.prompt, context: event.data.context ?? frameStore }) });
      actionJobId = job.id;
      beginJob(job);
      const result = await waitJob(job.id);
      reply(result.result);
    }
  } catch (error) {
    if (type === 'store') { $('#saved-status').textContent = 'Save failed. Please try again.'; toast('App data could not be saved: ' + error.message); }
    if (type === 'ai' && actionJobId) recoverJob(error, actionJobId);
    reply(null, error.message);
  }
});
function beginJob(job) {
  currentJob = job; $('#job-panel').hidden = false;
  $('#create-submit').disabled = true; $('#edit-submit').disabled = true;
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(currentJob.createdAt)) / 1000));
    $('#job-time').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }, 1000);
  updateJob(job);
}
function updateJob(job) {
  currentJob = job; $('#job-stage').textContent = job.stage;
  $('#job-detail').textContent = job.toolCalls ? `${job.toolCalls} tool calls · ${job.mode === 'action' ? 'Running an app task' : 'Building and checking the app'}` : job.mode === 'action' ? 'Running an app task' : 'Preparing the interface and features';
}
function resetJobUI() {
  currentJob = null; clearInterval(clockTimer); $('#job-panel').hidden = true;
  $('#create-submit').disabled = false; $('#edit-submit').disabled = false;
}
function recoverJob(error, id) {
  const interrupted = currentJob?.id === id;
  if (!currentJob || interrupted) resetJobUI();
  toast(interrupted
    ? `Task progress is unavailable: ${error.message}. The task may still be running. Refresh the page to check its progress.`
    : error.message, 12000);
}
async function finishJob(job) {
  resetJobUI();
  await refresh();
  if (job.status === 'done' && job.mode === 'generate') { await openApp(job.appId); toast('Your app is ready to use. You can update it at any time.'); }
  if (job.status === 'error') toast(job.error || 'Generation did not finish. Please try again.', 12000);
}
async function waitJob(id) {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const job = await api('jobs/' + id); updateJob(job);
    if (!['queued', 'running'].includes(job.status)) {
      await finishJob(job);
      if (job.status !== 'done') throw new Error(job.error || 'Task cancelled');
      return job;
    }
  }
}
async function generate(prompt, appId) {
  if (appId && storeWrites.has(appId)) await storeWrites.get(appId);
  const job = await api('generate', { method: 'POST', body: JSON.stringify({ prompt, appId }) });
  beginJob(job);
  void waitJob(job.id).catch(error => recoverJob(error, job.id));
}
$('#create-form').addEventListener('submit', event => { event.preventDefault(); generate($('#create-prompt').value).catch(error => toast(error.message)); });
$('#edit-form').addEventListener('submit', event => { event.preventDefault(); if (activeId) generate($('#edit-prompt').value, activeId).catch(error => toast(error.message)); });
$('#new-app').onclick = () => { home(); $('#create-prompt').focus(); };
$('.brand').onclick = event => { event.preventDefault(); home(); };
$('#refresh-app').onclick = async () => { if (storeWrites.has(activeId)) await storeWrites.get(activeId); openApp(activeId).catch(error => toast(error.message)); };
$('#download-app').onclick = () => { if (activeId) window.open(new URL('api/apps/' + activeId + '/download', import.meta.url), '_blank', 'noopener'); };
$('#delete-app').onclick = async () => {
  if (!activeId || !confirm('Delete this app and its saved data?')) return;
  try { await api('apps/' + activeId, { method: 'DELETE', body: '{}' }); await refresh(); home(); } catch (error) { toast(error.message); }
};
$('#cancel-job').onclick = async () => { if (currentJob) try { await api('jobs/' + currentJob.id, { method: 'DELETE', body: '{}' }); } catch (error) { toast(error.message); } };
document.querySelectorAll('[data-suggestion]').forEach(button => button.onclick = () => { $('#create-prompt').value = button.dataset.suggestion; $('#create-prompt').focus(); });
function renderMemory() {
  $('#memory-text').value = state.memory.manual;
  $('#remembered-items').innerHTML = state.memory.entries.map(entry => `<div class="memory-entry"><strong>${esc(entry.condition)}</strong><p>${esc(entry.preference)}</p><small>From your request: ${esc(entry.quote)}</small><button class="icon-button" data-delete-memory="${entry.id}" title="Delete memory">×</button></div>`).join('');
  document.querySelectorAll('[data-delete-memory]').forEach(button => button.onclick = async () => {
    try { await api('memory/' + button.dataset.deleteMemory, { method: 'DELETE', body: '{}' }); await refresh(); renderMemory(); } catch (error) { toast(error.message); }
  });
}
function showMemory() { renderMemory(); $('#memory-save-status').textContent = ''; $('#memory-dialog').showModal(); }
$('#open-memory').onclick = showMemory; $('#composer-memory').onclick = showMemory;
$('#save-memory').onclick = async () => {
  try { await api('memory', { method: 'PUT', body: JSON.stringify({ manual: $('#memory-text').value }) }); await refresh(); $('#memory-save-status').textContent = 'Saved. Future apps will use these preferences.'; } catch (error) { toast(error.message); }
};
$('#mobile-nav').onclick = () => $('.sidebar').classList.toggle('open');
document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'n' && !/INPUT|TEXTAREA/.test(event.target.tagName) && !$('#memory-dialog').open) { home(); $('#create-prompt').focus(); event.preventDefault(); } });
try {
  await refresh(); home();
  const resumed = state.jobs.find(job => ['queued', 'running'].includes(job.status));
  if (resumed) { beginJob(resumed); void waitJob(resumed.id).catch(error => recoverJob(error, resumed.id)); }
} catch (error) { toast(error.message, 20000); }
