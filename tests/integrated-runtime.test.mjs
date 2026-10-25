import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrontendSnapshot } from '../scripts/prepare-frontend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function scratchDirectory(prefix) {
  await mkdir(path.join(root, '.test-runs'), { recursive: true });
  return mkdtemp(path.join(root, `.test-runs/${prefix}-`));
}

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRuntime(t, dshBase = '') {
  const scratch = await scratchDirectory('integrated-runtime');
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI|LIVEUIAGENT|APPWORLD|EXPO|DSH)_/.test(key)));
  Object.assign(env, {
    PORT: String(port), DB_PATH: path.join(scratch, 'runtime.db'), GENERATED_APPS_DIR: path.join(scratch, 'apps'),
    OPENAI_API_KEY: '', OPENAI_API_BASE: '', OPENAI_BASE_URL: '', LIVEUIAGENT_ORCHESTRATOR_MODEL: '',
    LIVEUIAGENT_MODEL_ROUTES: '', LIVEUIAGENT_MODEL_CHOICES: '', LIVEUIAGENT_APPWORLD_GROUNDING: 'off', LIVEUIAGENT_DSH_API_BASE: dshBase,
    LIVEUI_DEFAULT_HARNESS:'native',HOST:'127.0.0.1',
  });
  const child = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
  });
  for (let i = 0; i < 100 && !output.includes('LIVEUIAGENT on'); i++) {
    if (child.exitCode !== null) throw new Error(`Isolated runtime exited before startup: ${output}`);
    await delay(100);
  }
  assert.match(output, /LIVEUIAGENT on/, 'Isolated runtime must start');
  const base = `http://127.0.0.1:${port}`;
  async function request(method, route, body, owner = 'alpha-user') {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(owner ? { 'X-LiveUIAgent-User': owner } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }
  return { base, request, scratch };
}

test('the frontend manifest verifies every sidecar and rejects tampering before copying', async () => {
  const { resources } = await verifyFrontendSnapshot();
  assert.deepEqual(new Set(resources.map((r) => r.file)), new Set([
    'index.html', 'complete-apps.js', 'complete-apps.css', 'personalization.js', 'personalization.css',
    'liveui-bootstrap.js', 'activity-model.js', 'runtime-controls.js', 'runtime-controls.css', 'material-catalog.js', 'material-catalog.css',
  ]));
  const fixture = await scratchDirectory('frontend-integrity');
  const snapshot = path.join(fixture, 'frontend/snapshot');
  await mkdir(snapshot, { recursive: true });
  await mkdir(path.join(fixture, 'scripts'));
  for (const file of [...resources.map((r) => r.file), 'manifest.json']) {
    await copyFile(path.join(root, 'frontend/snapshot', file), path.join(snapshot, file));
  }
  await copyFile(path.join(root, 'scripts/prepare-frontend.mjs'), path.join(fixture, 'scripts/prepare-frontend.mjs'));
  const html = await readFile(path.join(snapshot, 'index.html'), 'utf8');
  for (const resource of resources.filter((r) => r.file !== 'index.html')) assert.ok(html.includes(`/${resource.file}`));
  const valid = spawnSync(process.execPath, ['scripts/prepare-frontend.mjs', '--check'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  await writeFile(path.join(snapshot, 'personalization.js'), '// changed sidecar\n', { flag: 'a' });
  await assert.rejects(verifyFrontendSnapshot(snapshot), /hash mismatch: personalization\.js/);
  const invalid = spawnSync(process.execPath, ['scripts/prepare-frontend.mjs'], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /hash mismatch: personalization\.js/);
  await assert.rejects(access(path.join(fixture, 'dist')), { code: 'ENOENT' });
});

test('integrated runtime serves sidecars, isolates personal state, and uses the configured complete-app API', { timeout: 30000 }, async (t) => {
  const appId = '12345678-1234-1234-1234-123456789abc';
  const completeId = `dsh_${appId}`;
  const completeApp = { id: appId, name: 'Offline notes', description: 'A mock complete app', accent: '#426b57', features: ['Write notes'], revision: 1, createdAt: '2026-01-01T00:00:00Z' };
  const calls = [];
  let stateUnavailable = false;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const owner = req.headers['x-liveuiagent-user'];
    calls.push({ path: req.url, method: req.method, owner, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/dsh/api/state') {
      if (stateUnavailable) { res.writeHead(503).end(JSON.stringify({ error: 'Offline fixture unavailable' })); return; }
      res.end(JSON.stringify({ apps: owner === 'alpha-user' ? [completeApp] : [] })); return;
    }
    if (owner === 'alpha-user' && req.url === `/dsh/api/apps/${appId}`) {
      res.end(JSON.stringify({ app: completeApp })); return;
    }
    if (owner === 'alpha-user' && req.url === `/dsh/api/apps/${appId}/store` && req.method === 'PUT') {
      res.end(JSON.stringify({ ok: true, store: JSON.parse(body) })); return;
    }
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const runtime = await startRuntime(t, `http://127.0.0.1:${upstream.address().port}/dsh/api`);
  const { resources } = await verifyFrontendSnapshot();
  for (const resource of resources) {
    const response = await fetch(`${runtime.base}/${resource.file}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), resource.sha256);
  }
  const state = await runtime.request('POST', '/agent/query-state', {});
  assert.equal(state.status, 200);
  assert.equal(state.body.apps.length, 1);
  assert.equal(state.body.apps[0].appId, completeId);
  assert.equal(state.body.scheduler.operation, 'query_state');
  const otherState = await runtime.request('POST', '/agent/query-state', {}, 'beta-user');
  assert.deepEqual(otherState.body.apps, []);
  const node = state.body.canvasState.nodes.find((n) => n.appId === completeId);
  const move = await runtime.request('POST', '/agent/patch-canvas', { canvasId: state.body.canvasState.canvasId, nodeId: node.id, position: { x: 240, y: 360 } });
  assert.equal(move.status, 200);
  const moved = await runtime.request('POST', '/agent/query-state', {});
  assert.deepEqual(moved.body.canvasState.nodes.find((n) => n.id === node.id).position, { x: 240, y: 360 });
  const invalidMove = await runtime.request('POST', '/agent/patch-canvas', { canvasId: state.body.canvasState.canvasId, nodeId: node.id, position: { x: 'invalid', y: 1 } });
  assert.equal(invalidMove.status, 400, 'Invalid coordinates must not reach persisted personal layout');
  const saved = await runtime.request('PUT', '/agent/personal/memory', { content: 'Prefer larger text; password=offline-fixture-value', scope: 'global' });
  assert.equal(saved.status, 200);
  assert.equal(saved.text.includes('offline-fixture-value'), false, 'Credentials are redacted before persistence');
  const ownMemory = await runtime.request('GET', '/agent/personal');
  const otherMemory = await runtime.request('GET', '/agent/personal', undefined, 'beta-user');
  assert.equal(ownMemory.body.memories.length, 1);
  assert.deepEqual(otherMemory.body.memories, []);
  const disabled = await runtime.request('PUT', '/agent/personal/context-settings', { enabled: false });
  assert.equal(disabled.body.enabled, false);
  const app = await runtime.request('GET', `/agent/complete/apps/${completeId}`);
  assert.equal(app.body.app.name, 'Offline notes');
  const store = await runtime.request('PUT', `/agent/complete/apps/${completeId}/store`, { note: 'Offline fixture' });
  assert.equal(store.body.store.note, 'Offline fixture');
  const denied = await runtime.request('GET', `/agent/complete/apps/${completeId}`, undefined, 'beta-user');
  assert.equal(denied.status, 404);
  const deniedEvaluation=await runtime.request('POST','/evaluator/gui',{appId:completeId,appName:'Offline notes'},'beta-user');
  assert.equal(deniedEvaluation.status,404,'Evaluator must load the app through the authenticated owner before opening a browser');
  const callsBeforeNativeEvaluation=calls.length;
  const unsafeOut=path.join(runtime.scratch,'client-chosen-evaluation-output');
  const missingNative=await runtime.request('POST','/evaluator/gui',{appId:'nonexistent-native',appName:'Missing',apiBase:`http://127.0.0.1:${upstream.address().port}/client-target`,outDir:unsafeOut,chromePath:'/client-chosen-program'});
  assert.equal(missingNative.status,500);
  assert.equal(calls.length,callsBeforeNativeEvaluation,'HTTP evaluator must not send user identity to a client-supplied API target');
  await assert.rejects(access(unsafeOut),'Client-supplied output path must not be created');
  const anonymous = await runtime.request('GET', '/agent/complete/state', undefined, '');
  assert.equal(anonymous.status, 401);
  const hidden = await runtime.request('PUT', '/agent/personal/library', { visible: [] });
  assert.equal(hidden.status, 200);
  assert.deepEqual((await runtime.request('POST', '/agent/query-state', {})).body.apps, []);
  await runtime.request('PUT', '/agent/personal/library', { visible: [completeId] });
  stateUnavailable = true;
  const cached = await runtime.request('POST', '/agent/query-state', {});
  assert.equal(cached.body.apps[0].appId, completeId, 'Previously fetched account-scoped metadata survives an upstream outage');
  const otherCached = await runtime.request('POST', '/agent/query-state', {}, 'beta-user');
  assert.deepEqual(otherCached.body.apps, []);
  assert.ok(calls.every((call) => call.path.startsWith('/dsh/api/')));
  assert.ok(calls.some((call) => call.owner === 'alpha-user') && calls.some((call) => call.owner === 'beta-user'));
});

test('complete-app integration is optional and reports missing API configuration', { timeout: 15000 }, async (t) => {
  const runtime = await startRuntime(t);
  assert.equal((await runtime.request('GET','/health')).body.service,'liveuiagent');
  const unavailable=await runtime.request('PATCH','/agent/runtime-settings',{harness:'dsh'});
  assert.equal(unavailable.status,503);assert.equal(unavailable.body.code,'harness_unavailable');
  const state = await runtime.request('POST', '/agent/query-state', {});
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.apps, []);
  const complete = await runtime.request('GET', '/agent/complete/state');
  assert.equal(complete.status, 503);
  assert.equal(complete.body.code, 'dsh_config_required');
  assert.deepEqual(complete.body.requiredConfig, ['LIVEUIAGENT_DSH_API_BASE']);
});
