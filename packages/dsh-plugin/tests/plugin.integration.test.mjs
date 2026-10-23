import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';
import { createLiveUIAgentPlugin, normalizeConfig } from '../index.mjs';

async function host(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveuiagent-dsh-integration-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const records = new Map();
  // Only durable storage is replaced; cookie generation and request validation are real DSH.
  ctx.provide('credentials', {
    async modifyRecord(key, change) {
      const next = await change(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
  });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(Connection, {});
  ctx.webServer.register({
    kind: 'exact', path: '/',
    handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res)) res.end('DSH test shell');
    },
  });
  const base = `http://127.0.0.1:${ctx.webServer.port}`;
  // The test launch token and cookie stay in memory, never snapshots or logs.
  const login = await fetch(ctx.connection.authenticatedUrl(`${base}/`), { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookieHeader = login.headers.get('set-cookie');
  assert.ok(cookieHeader, 'DSH issued a signed browser cookie');
  const cookie = cookieHeader.split(';')[0];
  const config = { dataDir, owner: 'integration-operator', basePath: '/tools/liveuiagent' };
  const request = (route, options = {}) => fetch(`${base}${config.basePath}${route}`, {
    ...options,
    headers: { cookie, ...options.headers },
  });
  const write = (route, value, headers = {}, method = 'PUT') => request(route, {
    method, headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(value),
  });
  return { ctx, base, cookie, config, request, write };
}

const unusedRunner = () => ({
  async run() { assert.fail('This integration case must not execute a model'); },
  async dispose() {},
});

test('real DSH authentication protects nested LIVEUIAGENT routes and fixes operator identity', { timeout: 15000 }, async t => {
  const h = await host(t);
  await h.ctx.plugin(createLiveUIAgentPlugin({ createRunner: unusedRunner }), h.config);
  for (const route of ['/', '/app.js', '/api/state', '/api/health']) {
    const denied = await fetch(`${h.base}${h.config.basePath}${route}`, { headers: { 'x-liveuiagent-user': 'forged-user' } });
    assert.equal(denied.status, 401, route);
    await denied.text();
  }
  const redirect = await h.request('', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/tools/liveuiagent/');
  const page = await h.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<html/i);
  const script = await h.request('/app.js');
  assert.equal(script.status, 200);
  assert.ok((await script.text()).length > 1000);
  const health = await h.request('/api/health');
  assert.deepEqual(await health.json(), { status: 'ok', backend: 'DSH', model: 'DSH profile', queue: 0 });
  const state = await h.request('/api/state', { headers: { 'x-liveuiagent-user': 'different-operator' } });
  assert.equal((await state.json()).user, h.config.owner);
  const sibling = await fetch(`${h.base}${h.config.basePath}-other/`, { headers: { cookie: h.cookie } });
  assert.equal(sibling.status, 404);
  await sibling.text();
  const shell = await fetch(`${h.base}/`, { headers: { cookie: h.cookie } });
  assert.equal(await shell.text(), 'DSH test shell');
});

test('native Host, Origin, Fetch Metadata and cookie fences reject writes without changing state', { timeout: 15000 }, async t => {
  const h = await host(t);
  await h.ctx.plugin(createLiveUIAgentPlugin({ createRunner: unusedRunner }), h.config);
  const accepted = await h.write('/api/memory', { manual: 'prefer readable charts' });
  assert.equal(accepted.status, 200);
  await accepted.json();
  for (const headers of [
    { origin: 'https://foreign.invalid' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'foreign.invalid', origin: 'http://foreign.invalid' },
  ]) {
    const denied = await h.write('/api/memory', { manual: 'untrusted overwrite' }, headers);
    assert.equal(denied.status, 403);
    await denied.text();
  }
  const anonymous = await fetch(`${h.base}${h.config.basePath}/api/memory`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: h.base, 'x-liveuiagent-user': h.config.owner },
    body: JSON.stringify({ manual: 'header impersonation' }),
  });
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  const tampered = await h.write('/api/memory', { manual: 'invalid cookie' }, { cookie: 'dsh-session=invalid' });
  assert.equal(tampered.status, 401);
  await tampered.text();
  const state = await (await h.request('/api/state')).json();
  assert.equal(state.memory.manual, 'prefer readable charts');
});

test('Cordis disposal aborts the task, persists cancellation, removes the route, and allows remount', { timeout: 15000 }, async t => {
  const h = await host(t);
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let aborted = false;
  let closed = 0;
  const plugin = createLiveUIAgentPlugin({ createRunner: () => ({
    run({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
        started();
      });
    },
    async dispose() { closed++; },
  }) });
  const fiber = h.ctx.plugin(plugin, h.config);
  await fiber;
  const response = await h.write('/api/generate', { prompt: 'Create a small chart app' }, {}, 'POST');
  assert.equal(response.status, 202);
  const job = await response.json();
  await running;
  await fiber.dispose();
  assert.equal(aborted, true);
  assert.equal(closed, 1);
  const unmounted = await h.request('/api/health');
  assert.equal(unmounted.status, 404);
  await unmounted.text();
  await h.ctx.plugin(createLiveUIAgentPlugin({ createRunner: unusedRunner }), h.config);
  const restored = await (await h.request(`/api/jobs/${job.id}`)).json();
  assert.equal(restored.status, 'cancelled');
  assert.ok(restored.finishedAt);
});

test('duplicate mount and failed startup release their resources', { timeout: 15000 }, async t => {
  const h = await host(t);
  await h.ctx.plugin(createLiveUIAgentPlugin({ createRunner: unusedRunner }), h.config);
  let closed = 0;
  const duplicate = h.ctx.plugin(createLiveUIAgentPlugin({
    createRunner: () => ({ ...unusedRunner(), async dispose() { closed++; } }),
  }), { ...h.config, dataDir: path.join(h.config.dataDir, 'duplicate') });
  await assert.rejects(async () => { await duplicate; }, /route|register|prefix|duplicate/i);
  assert.equal(closed, 1);
  await duplicate.dispose();
  const live = await h.request('/api/health');
  assert.equal(live.status, 200);
  await live.json();
  const broken = h.ctx.plugin(createLiveUIAgentPlugin({
    createRunner: () => ({ ...unusedRunner(), async dispose() { closed++; } }),
    createRuntime: async () => { throw new Error('deliberate runtime initialization failure'); },
  }), { ...h.config, basePath: '/broken' });
  await assert.rejects(async () => { await broken; }, /deliberate runtime initialization failure/);
  assert.equal(closed, 2);
  await broken.dispose();
});

test('the checked-in patch loads the native package through the real DSH loader', { timeout: 15000 }, async t => {
  const h = await host(t);
  await h.ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
  const patchText = await fs.readFile(new URL('../examples/liveuiagent.patch.yml', import.meta.url), 'utf8');
  const patches = yaml.load(patchText, { schema: entryListSchema });
  const warnings = [];
  const entries = applyEntryPatches([], patches, message => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '@liveuiagent/dsh-plugin');
  // Only local deployment values change; the real example module name and loader are used.
  entries[0].config = { ...entries[0].config, ...h.config };
  await h.ctx.loader.create(entries[0]);
  await h.ctx.loader.await();
  assert.ok(h.ctx.loader.resolve('liveuiagent').fiber);
  const response = await h.request('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).backend, 'DSH');
});

test('configuration rejects ambiguous mount paths and unsafe workspace locations', () => {
  const config = { dataDir: fileURLToPath(new URL('./', import.meta.url)), owner: 'operator' };
  for (const basePath of ['/', '/liveuiagent/', '/liveuiagent/../api', '/liveuiagent?mode=test', '//liveuiagent']) {
    assert.throws(() => normalizeConfig({ ...config, basePath }), /basePath/);
  }
  assert.throws(() => normalizeConfig({ ...config, dataDir: './relative' }), /absolute/);
  assert.throws(() => normalizeConfig({ ...config, frontendDir: './relative' }), /absolute/);
  assert.throws(() => normalizeConfig({ ...config, owner: '  ' }), /owner/);
  assert.throws(() => normalizeConfig({ ...config, owner: 'operator\nother' }), /owner/);
});

test('runner environment forwarding is explicit and validates variable names', () => {
  const config = { dataDir: fileURLToPath(new URL('./', import.meta.url)), owner: 'operator' };
  assert.deepEqual(normalizeConfig(config).runner.passEnv, ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']);
  assert.deepEqual(normalizeConfig({ ...config, runner: { passEnv: [] } }).runner.passEnv, []);
  const permitted = ['OPENAI_API_KEY', 'HTTPS_PROXY', 'NO_PROXY', '_CUSTOM_1'];
  assert.deepEqual(normalizeConfig({ ...config, runner: { passEnv: permitted } }).runner.passEnv, permitted);
  for (const key of ['', '1INVALID', 'KEY=value', 'WITH SPACE', 'BAD-NAME', 'NEW\nLINE']) {
    assert.throws(() => normalizeConfig({ ...config, runner: { passEnv: [key] } }), /passEnv/);
  }
});
