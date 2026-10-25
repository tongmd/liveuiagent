import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {createCompleteApps} from '../dist-server/server/complete-apps.js';

async function serve(t, app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('complete-app execution requests English defaults without changing original local chat or user data', async t => {
  const appId = '12345678-1234-1234-1234-123456789abc';
  const metadata = {id: appId, name: 'Notes', description: 'Your notes', revision: 1, createdAt: '2026-01-01'};
  const calls = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.get('/api/runtime-settings', (_req, res) => res.json({model: 'offline-fixture'}));
  upstream.get('/api/jobs/fixture-job', (_req,res)=>res.json({id:'fixture-job',status:'done',evidence:{schemaVersion:1,appId:'forged',toolResults:{forged:true}}}));
  upstream.get('/api/state', (_req, res) => res.json({apps: [metadata]}));
  upstream.get(`/api/apps/${appId}`, (_req, res) => res.json({app: metadata}));
  for (const route of ['/api/generate', `/api/apps/${appId}/action`]) {
    upstream.post(route, (req, res) => {
      calls.push({route, body: req.body});
      res.status(202).json({id: 'fixture-job', appId, status: 'done', evidence:{schemaVersion:1,appId:'forged'},toolCalls: 0, prompt: req.body.prompt});
    });
  }
  const remote = await serve(t, upstream);
  const envNames = ['LIVEUIAGENT_DSH_API_BASE', 'LIVEUI_DSH_USER_PREFIX', 'LIVEUI_DSH_EMPTY_ACCOUNT_ROOT'];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  process.env.LIVEUIAGENT_DSH_API_BASE = remote + '/api';
  t.after(() => {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE chat_history(id INTEGER PRIMARY KEY, owner TEXT, role TEXT, text TEXT, prompt TEXT, kind TEXT, status TEXT, label TEXT)');
  const personal = {prepare: async () => {}, recall: () => [], requestStatus: () => ({enabled: false})};
  const bridge = createCompleteApps(db, personal, () => 'fixture-owner', () => undefined);
  const app = express();
  app.use(express.json());
  bridge.install(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({error: error.message}));
  const base = await serve(t, app);
  async function post(route, body) {
    const response = await fetch(base + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  }
  const polled=await fetch(base+'/agent/complete/jobs/fixture-job');
  assert.equal((await polled.json()).evidence,undefined,'untrusted upstream evidence must be discarded');
  const merged=await bridge.merge({},{apps:[],canvasState:{nodes:[]},summary:{}});
  const pkg=merged.apps[0].appPackage;
  assert.equal(pkg.ui.meta.agentWorkflow[0].actionRoutes[0].actionId,'agent.invoke');
  assert.ok(pkg.actions.actions['agent.invoke']);
  const original = 'Build a notes app. Keep the sample title “日记” unchanged.';
  assert.equal((await post('/agent/run', {completeApp: true, prompt: original})).status, 200);
  assert.deepEqual(db.prepare('SELECT prompt, label FROM chat_history').get(), {prompt: original, label: 'Create: ' + original.slice(0, 60)});
  assert.match(calls[0].body.prompt, /^LiveUIAgent output preference: use English/);
  assert.match(calls[0].body.prompt, /unless the original request explicitly asks for another language/);
  assert.ok(calls[0].body.prompt.endsWith('\n\nOriginal user request:\n' + original));

  const revision = 'Add a search field. Please use French for the interface.';
  const revised = await post('/agent/patch-app', {appId: 'dsh_' + appId, prompt: revision});
  assert.equal(revised.status, 202);
  assert.equal(revised.body.evidence,undefined);
  assert.ok(calls[1].body.prompt.endsWith(revision));
  assert.equal(revised.body.prompt, calls[1].body.prompt, 'Upstream execution evidence is preserved verbatim');

  const action = 'Summarize the selected note. Reply in Spanish.';
  const eventPayload = {payload: {note: '原文 must remain unchanged'}};
  assert.equal((await post('/agent/action', {appId: 'dsh_' + appId, prompt: action, eventPayload})).status, 202);
  assert.ok(calls[2].body.prompt.endsWith(action));
  assert.match(calls[2].body.prompt, /^LiveUIAgent output preference: use English/);
  assert.deepEqual(calls[2].body.context.eventPayload, eventPayload);

  const before = calls.length;
  const tooLong = await post('/agent/patch-app', {appId: 'dsh_' + appId, prompt: 'x'.repeat(16000)});
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /Keep your request within/);
  assert.equal(calls.length, before, 'The bridge rejects excess length instead of truncating original content');
});
