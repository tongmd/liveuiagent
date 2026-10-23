import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function allocatePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('compiled runtime serves the preserved frontend and isolates settings without model calls', { timeout: 30000 }, async () => {
  await mkdir(path.join(root, '.test-runs'), { recursive: true });
  const scratch = await mkdtemp(path.join(root, '.test-runs/runtime-'));
  const port = await allocatePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI|LIVEUIAGENT|APPWORLD|EXPO)_/.test(key)));
  Object.assign(env, {
    PORT: String(port), DB_PATH: path.join(scratch, 'runtime.db'), GENERATED_APPS_DIR: path.join(scratch, 'apps'),
    OPENAI_API_KEY: '', OPENAI_API_BASE: '', OPENAI_BASE_URL: '', LIVEUIAGENT_ORCHESTRATOR_MODEL: '',
    LIVEUIAGENT_MODEL_ROUTES: '', LIVEUIAGENT_MODEL_CHOICES: '', LIVEUIAGENT_APPWORLD_GROUNDING: 'off',
  });
  const child = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  async function request(method, route, body, user) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-LiveUIAgent-User': user } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  try {
    for (let attempt = 0; attempt < 80 && !output.includes('LIVEUIAGENT on'); attempt++) {
      if (child.exitCode !== null) throw new Error('Runtime exited before startup');
      await delay(100);
    }
    assert.match(output, /LIVEUIAGENT on/, 'Runtime startup must complete');
    const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    const manifest = JSON.parse(await readFile(path.join(root, 'frontend/snapshot/manifest.json'), 'utf8'));
    assert.equal(createHash('sha256').update(Buffer.from(await page.arrayBuffer())).digest('hex'), manifest.sha256);
    const initial = await request('POST', '/agent/query-state', {});
    assert.equal(initial.status, 200);
    assert.equal(initial.body.canvasState.canvasId, 'home');
    assert.deepEqual(initial.body.apps, []);
    assert.equal(initial.body.scheduler.operation, 'query_state');
    const missing = await request('POST', '/agent/run', { prompt: 'Create a notes app', platform: 'web', canvasState: initial.body.canvasState });
    assert.equal(missing.body.code, 'llm_config_required');
    assert.equal(missing.body.retryable, true);
    assert.deepEqual(new Set(missing.body.requiredConfig), new Set(['apiKey', 'apiBase', 'model']));
    const testKey = 'offline-test-key-0123456789abcdef';
    const saved = await request('PUT', '/agent/settings', { apiKey: testKey, apiBase: 'https://example.invalid/v1', model: 'test/model-a', models: ['test/model-a', 'test/model-b'] }, 'smoke-user');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.user.hasApiKey, true);
    assert.equal(saved.body.effective.keySource, 'user');
    assert.equal(saved.text.includes(testKey), false, 'Settings responses must not echo a saved credential');
    const models = await request('GET', '/agent/models', undefined, 'smoke-user');
    assert.deepEqual(models.body.models, ['test/model-a', 'test/model-b']);
    const other = await request('GET', '/agent/settings', undefined, 'other-user');
    assert.equal(other.body.user.hasApiKey, false);
    const invalid = await request('PUT', '/agent/settings', { apiBase: 'invalid-url' }, 'smoke-user');
    assert.equal(invalid.status, 400);
    const cleared = await request('DELETE', '/agent/settings', undefined, 'smoke-user');
    assert.equal(cleared.body.effective.keySource, 'none');
    const final = await request('POST', '/agent/query-state', {});
    assert.equal(final.body.summary.appCount, 0);
    const scheduler = await request('POST', '/agent/scheduler-state', {});
    assert.ok(scheduler.body.finished >= 3);
    console.log(`Offline smoke passed; retained scratch: ${path.relative(root, scratch)}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
  }
});
