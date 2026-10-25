import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { buildTask } from './prompts.mjs';
import { seedConnectedApp } from './host-action-starter.mjs';
import { validateDelivery } from './delivery.mjs';
import { validateBrowserDelivery } from './browser-delivery.mjs';
import { resolveJobModel } from './model-config.mjs';

/** Create one operator's LiveUIAgent application service; the Cordis entry owns HTTP authentication. */
export async function createLiveUIAgentRuntime(config) {
const { basePath: PREFIX, dataDir: ROOT, frontendDir, owner, model: MODEL, runner } = config;
const MAX_PENDING = config.maxPending;
const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(config.maxConcurrent) || 4));
const JOB_TIMEOUT = config.timeoutMs;
if (!path.isAbsolute(ROOT) || !path.isAbsolute(frontendDir)) throw new Error('LiveUIAgent requires absolute data and frontend directories');
if (typeof owner !== 'string' || !owner.trim()) throw new Error('LiveUIAgent requires a fixed operator identity');
let closed = false;
let pumpTask = Promise.resolve();
const accounts = new Map();
const queue = [];
const running = new Map();
let pumping = false;
let wakePump;

const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const clean = value => String(value).replace(/sk-[A-Za-z\d_-]{12,}/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function publicJob(job) {
  const { id, appId, status, stage, createdAt, updatedAt, finishedAt, prompt, mode, error, toolCalls, tools, result, elapsedMs, model } = job;
  return { id, appId, status, stage, createdAt, updatedAt, finishedAt, prompt, mode, error, toolCalls, tools, result, elapsedMs, model };
}
function mergeMemory(a, raw, prompt) {
  const updates = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  for (const update of updates.slice(0, 8)) {
    const preference = update.preference ?? update.text;
    if (![update.condition, preference, update.quote].every(v => typeof v === 'string' && v.trim() && v.length < 1500) || !prompt.includes(update.quote)) continue;
    const entry = { id: hash(update.condition + '\n' + preference).slice(0, 24), condition: update.condition.trim(), preference: preference.trim(), quote: update.quote, updatedAt: new Date().toISOString() };
    a.state.memory.entries = [...a.state.memory.entries.filter(x => x.id !== entry.id), entry].slice(-30);
  }
}
async function account(user) {
  const key = hash(user);
  if (accounts.has(key)) return accounts.get(key);
  const loading = (async () => {
    const dir = path.join(ROOT, 'accounts', key);
    const state = await readJson(path.join(dir, 'state.json'), { apps: [], jobs: [], memory: { manual: '', entries: [] } });
    const a = { key, dir, state };
    for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
      Object.assign(job, { status: 'error', stage: 'Service restarted. Please submit again.', error: 'The previous task was interrupted by a service restart.', finishedAt: new Date().toISOString() });
    }
    if (!state.memoryFormatVersion) {
      for (const app of state.apps) {
        const job = state.jobs.find(j => j.id === app.lastJobId && j.status === 'done');
        if (job) mergeMemory(a, await readJson(path.join(dir, 'runs', job.id, 'work', 'memory-updates.json'), []), job.prompt);
      }
      state.memoryFormatVersion = 1;
    }
    await save(a);
    return a;
  })();
  accounts.set(key, loading);
  try { return await loading; } catch (error) { accounts.delete(key); throw error; }
}
function save(a) {
  const snapshot = structuredClone(a.state);
  a.pendingSave = (a.pendingSave || Promise.resolve()).catch(() => {}).then(() => writeJson(path.join(a.dir, 'state.json'), snapshot));
  return a.pendingSave;
}
function findApp(a, id) {
  if (!validId(id)) fail(404, 'App not found');
  const app = a.state.apps.find(app => app.id === id);
  if (!app) fail(404, 'App not found');
  return app;
}
function appDir(a, id) { return path.join(a.dir, 'apps', id); }
async function body(req) {
  let data = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1100000) fail(413, 'Request body is too large');
    data += chunk;
  }
  try { return JSON.parse(data || '{}'); } catch { fail(400, 'Invalid request body'); }
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function submit(a, input, mode = 'generate') {
  if (closed) fail(503, 'The service is shutting down');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid request body');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) fail(400, 'Describe your app or changes using up to 16,000 characters');
  if (queue.length >= MAX_PENDING) fail(429, 'The task queue is full. Please try again later.');
  const selected=resolveJobModel(input,MODEL,{modelSelection:runner.modelSelection===true,providerOverride:runner.providerOverride===true,modelOnly:runner.modelOnly===true});
  let app;
  if (input.appId) app = findApp(a, input.appId);
  if (mode === 'action' && !app) fail(404, 'App not found');
  const recover = !app && mode === 'generate' ? a.state.jobs.find(j => j.status === 'error' && j.mode === 'generate' && j.prompt === clean(input.prompt.trim())) : undefined;
  const job = { id: randomUUID(), appId: app?.id || recover?.appId || randomUUID(), recoverFrom: recover?.id, status: 'queued', stage: 'Queued', mode, model:selected.model,
    prompt: clean(input.prompt.trim()), createdAt: new Date().toISOString(), toolCalls: 0, tools: [] };
  a.state.jobs.unshift(job);
  a.state.jobs = a.state.jobs.filter((j, index) => index < 80 || ['queued', 'running'].includes(j.status));
  await save(a);
  queue.push({ a, job, context: input.context, provider:selected.provider });
  wakePump?.();
  if (!pumping) pumpTask = pump();
  return publicJob(job);
}
async function pump() {
  if (pumping) return;
  pumping = true;
  const active = new Map();
  try {
    while ((queue.length || active.size) && !closed) {
      // Separate apps can run together; revisions/actions of one app retain FIFO.
      while (active.size < MAX_CONCURRENT) {
        const index = queue.findIndex(item => item.job.status === 'cancelled' || !active.has(item.a.key + ':' + item.job.appId));
        if (index < 0) break;
        const item = queue.splice(index, 1)[0];
        if (item.job.status === 'cancelled') continue;
        const key = item.a.key + ':' + item.job.appId;
        const task = execute(item).finally(() => active.delete(key));
        active.set(key, task);
      }
      if (active.size) {
        await Promise.race([...active.values(), new Promise(resolve => { wakePump = resolve; })]);
        wakePump = undefined;
      }
    }
  } finally {
    await Promise.allSettled(active.values());
    pumping = false;
  }
}
async function invokeDsh(a, job, work, home, task, provider, budget = JOB_TIMEOUT) {
  if (closed || job.status === 'cancelled') throw new Error('Task cancelled');
  job.timedOut = false;
  const controller = new AbortController();
  running.set(job.id, controller);
  const started = Date.now();
  const timer = setTimeout(() => { job.timedOut = true; controller.abort(new Error('DSH task timed out')); }, budget);
  try {
    const result = await runner.run({ work, home, task, model:job.model,provider,signal: controller.signal, onEvent(event) {
      if (event.type === 'tool_call') {
        job.toolCalls++;
        const name = String(event.name || event.toolName || event.tool || 'tool');
        if (!job.tools.includes(name)) job.tools.push(name);
        job.stage = /read|list|search|glob/.test(name) ? 'Reading the request and app code' : /write|edit|patch/.test(name) ? 'Building the interface and features' : 'DSH is working';
      }
      if (event.type === 'final') job.answer = clean(event.text || event.response || event.message || '');
    } });
    if (job.status === 'cancelled') throw new Error('Task cancelled');
    if (job.timedOut) throw new Error('Generation timed out. Try a smaller request or retry.');
    if (result?.diagnostics) await writeJson(path.join(a.dir, 'runs', job.id + '.json'), { engine: 'DSH', model: job.model, diagnostics: clean(result.diagnostics), toolCalls: job.toolCalls });
  } catch (error) {
    if (job.timedOut) throw new Error('Generation timed out. Try a smaller request or retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    running.delete(job.id);
    job.elapsedMs = (job.elapsedMs || 0) + Date.now() - started;
  }
}
async function outputFile(work, name, maxBytes) {
  const file = path.join(work, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('DSH returned an invalid app file');
  return fs.readFile(file, 'utf8');
}
async function verifyDelivery(work, job, context) {
  const delivery = await validateDelivery(work);
  if (!delivery.ok || closed || job.status === 'cancelled') return delivery;
  const controller = new AbortController();
  running.set(job.id, controller);
  try {
    const browser = await validateBrowserDelivery(delivery.html, { chrome: config.chrome, signal: controller.signal, requireAgentAction: Array.isArray(context?.connectedServices) && context.connectedServices.length > 0 });
    job.browserValidation = browser;
    (job.browserValidationAttempts ??= []).push(browser);
    return browser.ok ? delivery : { ok: false, errors: browser.errors };
  } finally { running.delete(job.id); }
}
async function execute({ a, job, context, provider }) {
  const work = path.join(a.dir, 'runs', job.id, 'work');
  const home = path.join(a.dir, 'runs', job.id, 'dsh-home');
  let pendingFile;
  try {
    Object.assign(job, { status: 'running', stage: 'DSH is reviewing your request', updatedAt: new Date().toISOString() }); await save(a);
    await fs.mkdir(work, { recursive: true, mode: 0o700 }); await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const previous = a.state.apps.find(app => app.id === job.appId);
    if (previous) {
      await fs.copyFile(path.join(appDir(a, job.appId), 'index.html'), path.join(work, 'index.html'));
      await writeJson(path.join(work, 'app.json'), previous);
    } else if (job.recoverFrom) {
      const source = path.join(a.dir, 'runs', job.recoverFrom, 'work');
      for (const file of ['index.html', 'app.json', 'memory-updates.json']) {
        try { await fs.copyFile(path.join(source, file), path.join(work, file)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (job.mode !== 'action' && Array.isArray(context?.connectedServices) && context.connectedServices.length) await seedConnectedApp(work);
    await writeJson(path.join(work, 'user-memory.json'), context?.personalContext ?? a.state.memory);
    if (job.status === 'cancelled') return;
    let task = buildTask({ prompt: job.prompt, mode: job.mode, memory: context?.personalContext ?? a.state.memory, history: previous?.history, context });
    if (job.recoverFrom) task += '\n\nFINALIZE EXISTING WORK: a prior run stopped while polishing. Read the files already present. Preserve the existing design and features. Run a syntax check and one focused logic check, repair only actual errors, ensure app.json is present, and finish. Do not redesign or add features.';
    if (job.mode === 'action') {
      await invokeDsh(a, job, work, home, task, provider);
    } else {
      job.phase = 'generate'; job.stage = '生成可运行版本'; await save(a);
      let generationError;
      try { await invokeDsh(a, job, work, home, task, provider, Math.min(JOB_TIMEOUT, 240000)); }
      catch (error) { if (!job.timedOut || job.status === 'cancelled') throw error; generationError = error; }
      if (job.status === 'cancelled') return;
      job.phase = 'validate'; job.stage = '校验应用文件与脚本'; await save(a);
      let delivery = await verifyDelivery(work, job, context);
      if (closed || job.status === 'cancelled') return;
      if (!delivery.ok && delivery.errors.some(error => error.code === 'browser_unavailable')) throw new Error('浏览器交付检查不可用：' + delivery.errors.map(error => error.message).join('; '));
      if (!delivery.ok) {
        job.phase = 'repair'; job.stage = '修复交付文件'; job.repairAttempts = 1; await save(a);
        const repairTask = task + '\n\nDELIVERY REPAIR ONLY (one attempt, 120 seconds). Existing files are the current draft. Do not redesign or research. Fix these host validation errors: ' + JSON.stringify(delivery.errors) + '. Write app.json first if missing, accurately describing only implemented features. Fix inline JavaScript syntax and preserve the user request and stored data. Finish immediately after writing the corrected files.' + (Array.isArray(context?.connectedServices) && context.connectedServices.length ? '\nCONNECTED SERVICE REPAIR: Preserve the existing interface, charts, stored data and implemented functions. Only wire the one primary natural-language task form and its submit button (both data-liveui-action="agent.invoke") to the host SDK. Forward the complete current task input and all relevant fields. Await the actual result and visibly render text/data. Handle ok:false (including data.ok:false) as an error, not a local success. Do not call on load. Minimal handler pattern, adapted to your existing controls: event.preventDefault(); const result = await window.liveuiagent.ai(currentRequest, currentFields); if (result.ok !== true || result.data?.ok === false) { resultArea.textContent = result.error || result.data?.error || result.text || "Service outcome was not verified"; return; } resultArea.textContent = result.text; Handle thrown errors visibly too. Do not redesign or replace the application.' : '');
        try { await invokeDsh(a, job, work, home, repairTask, provider, Math.min(JOB_TIMEOUT, 120000)); }
        catch (error) { if (!job.timedOut || job.status === 'cancelled') throw error; }
        if (job.status === 'cancelled') return;
        job.phase = 'validate'; job.stage = '复查修复结果'; await save(a);
        delivery = await verifyDelivery(work, job, context);
      }
      job.deliveryValidation = { ok: delivery.ok, errors: delivery.errors };
      if (!delivery.ok) throw new Error('应用交付校验未通过：' + delivery.errors.map(e => e.message).join('; '));
      if (generationError) job.generationDeadlineReached = true;
      job.timedOut = false;
      job.phase = 'publish'; job.stage = '保存可运行应用'; await save(a);
    }
    if (job.status === 'cancelled') return;
    if (job.mode === 'action') {
      const result = JSON.parse(await outputFile(work, 'response.json', 1100000));
      if (!result || typeof result.text !== 'string' || result.text.length > 100000) throw new Error('DSH did not return a valid result. Please try again.');
      if (closed || job.status === 'cancelled') return;
      job.result = result;
    } else {
      const html = await outputFile(work, 'index.html', 3000000);
      const meta = JSON.parse(await outputFile(work, 'app.json', 100000));
      if (!meta || typeof meta.name !== 'string' || !meta.name.trim() || !/<html[\s>]/i.test(html) || !/<script[\s>]/i.test(html) || html.length < 1000 || html.length > 3000000 || job.toolCalls < 1) {
        throw new Error('DSH did not deliver complete app files. Please try again.');
      }
      const dir = appDir(a, job.appId); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      if (previous) await fs.copyFile(path.join(dir, 'index.html'), path.join(dir, `revision-${previous.revision}.html`));
      const updates = await readJson(path.join(work, 'memory-updates.json'), []);
      pendingFile = path.join(dir, `.pending-${job.id}.html`);
      await fs.writeFile(pendingFile, html, { mode: 0o600 });
      const app = { id: job.appId, name: meta.name.trim().slice(0, 48), description: String(meta.description || '').slice(0, 180),
        accent: /^#[\da-f]{6}$/i.test(meta.accent) ? meta.accent : '#43745e', features: Array.isArray(meta.features) ? meta.features.slice(0, 12) : [],
        checks: Array.isArray(meta.checks) ? meta.checks.slice(0, 20) : [], revision: (previous?.revision || 0) + 1,
        createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
        history: [...(previous?.history || []), job.prompt].slice(-12), lastJobId: job.id, engine: 'DSH', model: job.model, example: false };
      if (closed || job.status === 'cancelled') return;
      // Publish the file and terminal state in one turn, with no cancellation window.
      renameSync(pendingFile, path.join(dir, 'index.html'));
      pendingFile = undefined;
      a.state.apps = [app, ...a.state.apps.filter(x => x.id !== app.id)];
      mergeMemory(a, updates, job.prompt);
      job.result = { appId: app.id, name: app.name };
    }
    Object.assign(job, { status: 'done', stage: job.mode === 'action' ? 'Task complete' : 'App updated', finishedAt: new Date().toISOString() });
  } catch (error) {
    if (job.status !== 'cancelled') Object.assign(job, { status: 'error', stage: 'Task incomplete', error: clean(error.message).slice(0, 1800), finishedAt: new Date().toISOString() });
  } finally {
    if (pendingFile) await fs.rm(pendingFile, { force: true });
    await save(a);
  }
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(PREFIX + '/') && pathname !== PREFIX) fail(404, 'Page not found');
    if (pathname === PREFIX && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(302, { location: PREFIX + '/' }); res.end(); return; }
    const route = pathname.slice(PREFIX.length) || '/';
    const api = route.startsWith('/api/');
    if (!api) {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[route]; if (!file) fail(404, 'Page not found');
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(path.join(frontendDir, file[0])));
    }
    const user = owner;
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) fail(403, 'Request origin does not match');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Use a JSON request body');
    }
    const a = await account(user);
    if(route==='/api/runtime-settings'&&req.method==='GET')return json(res,{model:MODEL,modelSelection:runner.modelSelection===true,providerOverride:runner.providerOverride===true,modelOnly:runner.modelOnly===true});
    if (route === '/api/state' && req.method === 'GET') return json(res, { apps: a.state.apps, jobs: a.state.jobs.map(publicJob), memory: a.state.memory,
      engine: { name: 'DeepSeek Harness', version: '0.2.0-rc.2', model: MODEL, onlyBackend: true }, user });
    if (route === '/api/health' && req.method === 'GET') return json(res, { status: 'ok', backend: 'DSH', model: MODEL, queue: queue.length });
    if (route === '/api/generate' && req.method === 'POST') return json(res, await submit(a, await body(req)), 202);
    if (route === '/api/memory' && req.method === 'PUT') {
      const input = await body(req); if (typeof input.manual !== 'string' || input.manual.length > 8000) fail(400, 'Memory must be at most 8,000 characters');
      a.state.memory.manual = clean(input.manual); await save(a); return json(res, a.state.memory);
    }
    const memoryMatch = /^\/api\/memory\/([a-f\d]{24})$/.exec(route);
    if (memoryMatch && req.method === 'DELETE') {
      a.state.memory.entries = a.state.memory.entries.filter(x => x.id !== memoryMatch[1]); await save(a); return json(res, { ok: true });
    }
    const jobMatch = /^\/api\/jobs\/([a-f\d-]{36})$/.exec(route);
    if (jobMatch) {
      const job = a.state.jobs.find(j => j.id === jobMatch[1]); if (!job) fail(404, 'Task not found');
      if (req.method === 'GET') return json(res, publicJob(job));
      if (req.method === 'DELETE') {
        if (['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; job.stage = 'Cancelled'; job.finishedAt = new Date().toISOString(); const controller = running.get(job.id); if (controller) controller.abort(new Error('Task cancelled')); await save(a); }
        return json(res, publicJob(job));
      }
    }
    const appMatch = /^\/api\/apps\/([a-f\d-]{36})(?:\/(store|action|download|history))?$/.exec(route);
    if (appMatch) {
      const app = findApp(a, appMatch[1]); const dir = appDir(a, app.id); const sub = appMatch[2];
      if (!sub && req.method === 'GET') return json(res, { app, html: await fs.readFile(path.join(dir, 'index.html'), 'utf8'), store: await readJson(path.join(dir, 'store.json'), {}) });
      if (!sub && req.method === 'DELETE') {
        if (a.state.jobs.some(j => j.appId === app.id && ['queued', 'running'].includes(j.status))) fail(409, 'Wait for or cancel the current app task first');
        a.state.apps = a.state.apps.filter(x => x.id !== app.id); await save(a); await fs.rm(dir, { recursive: true, force: true }); return json(res, { ok: true });
      }
      if (sub === 'store' && req.method === 'PUT') {
        const input = await body(req); if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length > 500) fail(400, 'Invalid app data');
        await writeJson(path.join(dir, 'store.json'), input); return json(res, { ok: true });
      }
      if (sub === 'action' && req.method === 'POST') return json(res, await submit(a, { ...(await body(req)), appId: app.id }, 'action'), 202);
      if (sub === 'download' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'attachment; filename="personal-app.html"', 'cache-control': 'no-store' });
        return res.end(await fs.readFile(path.join(dir, 'index.html')));
      }
    }
    fail(404, 'Endpoint not found');
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.status ? error.message : 'The request could not be completed. Please try again.' }, error.status || 500);
    else res.end();
    if (!error.status) console.error(clean(error.stack));
  }
}
await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
await account(owner);
return { handle, async dispose() {
  if (closed) return;
  closed = true;
  const a = await account(owner);
  for (const job of a.state.jobs) if (['queued', 'running'].includes(job.status)) {
    Object.assign(job, { status: 'cancelled', stage: 'Service stopped', finishedAt: new Date().toISOString() });
  }
  queue.length = 0;
  for (const controller of running.values()) controller.abort(new Error('LiveUIAgent plugin disposed'));
  await pumpTask;
  await save(a);
  await runner.dispose?.();
} };
}
