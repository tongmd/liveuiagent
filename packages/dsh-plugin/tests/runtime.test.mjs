import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveUIAgentRuntime } from '../runtime.mjs';

const frontendDir = fileURLToPath(new URL('../public/', import.meta.url));
const html = '<!doctype html><html><head><title>Counter</title></head><body><button id="add">Add</button><output>0</output><script>document.querySelector("#add").onclick=()=>document.querySelector("output").value++;</script><!--' + 'fixture '.repeat(200) + '--></body></html>';

async function fixture(t, runner, options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(path.join(tmpdir(), 'liveuiagent-runtime-test-'));
  const runtime = await createLiveUIAgentRuntime({ basePath: '/nested/apps', dataDir, frontendDir, owner: 'operator', model: 'fixture', maxPending: 3, timeoutMs: 3000, runner, ...options });
  const server = createServer(runtime.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.dispose(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(route, method = 'GET', body, headers = {}) {
    const res = await fetch(origin + '/nested/apps/api/' + route, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  }
  async function finished(id) {
    const deadline = Date.now() + 60000;
    for (;;) {
      const { data } = await api('jobs/' + id);
      if (!['queued', 'running'].includes(data.status)) return data;
      assert.ok(Date.now() < deadline, 'job should finish');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return { runtime, api, finished, origin, dataDir };
}

function writer() {
  return { async run({ work, onEvent }) {
    onEvent({ type: 'tool_call', name: 'write_file' });
    await writeFile(path.join(work, 'index.html'), html);
    await writeFile(path.join(work, 'app.json'), JSON.stringify({ name: 'Counter', description: 'A local counter', accent: '#008A8A', features: ['Count'], checks: ['Fixture output'] }));
    await writeFile(path.join(work, 'memory-updates.json'), JSON.stringify([{ condition: '界面布局', preference: '清爽布局', quote: '我喜欢清爽布局' }]));
    return {};
  } };
}

test('model overrides reach real job execution while provider keys stay out of state and public jobs',async t=>{
  const generate=writer();const received=[];
  const f=await fixture(t,{modelSelection:true,providerOverride:true,modelOnly:true,async run(input){received.push(input);return generate.run(input);}});
  const capability=await f.api('runtime-settings');assert.equal(capability.data.modelSelection,true);
  const request=await f.api('generate','POST',{prompt:'fixture',model:'new-model',provider:{apiBase:'https://provider.example/v1',apiKey:'secret-fixture-value'}});
  assert.equal(request.status,202);assert.equal(request.data.model,'new-model');
  const job=await f.finished(request.data.id);assert.equal(job.status,'done');assert.equal(received[0].model,'new-model');assert.equal(received[0].provider.apiKey,'secret-fixture-value');
  const state=await f.api('state');assert.equal(state.data.apps[0].model,'new-model');assert.ok(!JSON.stringify(state).includes('secret-fixture-value'));
  const dirs=await fs.readdir(path.join(f.dataDir,'accounts'));
  assert.ok(!(await readFile(path.join(f.dataDir,'accounts',dirs[0],'state.json'),'utf8')).includes('secret-fixture-value'));
  const invalid=await f.api('generate','POST',{prompt:'bad',model:'new-model',provider:{apiBase:'file:///etc/config',apiKey:'fixture'}});assert.equal(invalid.status,400);
});

test('generation, revision, app storage, memory, and restart preserve the same application', async t => {
  const f = await fixture(t, writer());
  const request = await f.api('generate', 'POST', { prompt: '做计数器，我喜欢清爽布局' });
  assert.equal(request.status, 202);
  const first = await f.finished(request.data.id);
  assert.equal(first.status, 'done');
  const state = await f.api('state', 'GET', undefined, { 'x-liveuiagent-user': 'other-person' });
  assert.equal(state.data.user, 'operator');
  assert.equal(state.data.apps[0].revision, 1);
  assert.equal(state.data.memory.entries.length, 1);
  await f.api(`apps/${first.appId}/store`, 'PUT', { count: '7', note: '<hello>' });
  const second = await f.api('generate', 'POST', { prompt: '把按钮加大', appId: first.appId });
  assert.equal((await f.finished(second.data.id)).status, 'done');
  const reopened = await f.api('apps/' + first.appId);
  assert.equal(reopened.data.app.revision, 2);
  assert.deepEqual(reopened.data.store, { count: '7', note: '<hello>' });
  assert.equal(reopened.data.html, html);
  await f.runtime.dispose();
  const restarted = await fixture(t, writer(), { dataDir: f.dataDir });
  assert.equal((await restarted.api('state')).data.apps[0].id, first.appId);
  assert.deepEqual((await restarted.api('apps/' + first.appId)).data.store, { count: '7', note: '<hello>' });
  const separate = await fixture(t, writer(), { dataDir: f.dataDir, owner: 'another-workspace' });
  assert.deepEqual((await separate.api('state')).data.apps, []);
});

test('nested mount redirects to a trailing slash and assets/API remain relative', async t => {
  const f = await fixture(t, writer());
  const redirect = await fetch(f.origin + '/nested/apps', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/nested/apps/');
  const page = await (await fetch(f.origin + '/nested/apps/')).text();
  assert.match(page, /src="\.\/app\.js"/);
  assert.match(page, /href="\.\/style\.css"/);
  const js = await (await fetch(f.origin + '/nested/apps/app.js')).text();
  assert.match(js, /new URL\('api\/' \+ route, import\.meta\.url\)/);
  assert.doesNotMatch(js, /['"]\/dsh\//);
  assert.equal((await fetch(f.origin + '/nested/apps/missing.js')).status, 404);
  assert.equal((await f.api('generate', 'POST', null)).status, 400);
});

test('in-app actions return structured results without modifying the app or its store', async t => {
  const generate = writer();
  const f = await fixture(t, { async run(input) {
    if (input.task.includes('Write response.json')) {
      await writeFile(path.join(input.work, 'response.json'), JSON.stringify({ text: '已解释', data: { total: 3 } }));
      return {};
    }
    return generate.run(input);
  } });
  const created = await f.api('generate', 'POST', { prompt: '做计数器' });
  const job = await f.finished(created.data.id);
  const action = await f.api(`apps/${job.appId}/action`, 'POST', { prompt: '解释当前计数', context: { total: 3 } });
  const result = await f.finished(action.data.id);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.result, { text: '已解释', data: { total: 3 } });
  assert.equal((await f.api('apps/' + job.appId)).data.app.revision, 1);
});

test('cancellation and unload stop running work and reject new tasks', async t => {
  let aborted = false;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { async run({ signal }) {
    started();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    });
  } });
  const queued = await f.api('generate', 'POST', { prompt: '一个应用' });
  await entered;
  assert.equal((await f.api('generate', 'POST', { prompt: '第二个' })).status, 409);
  await f.runtime.dispose();
  assert.equal(aborted, true);
  assert.equal((await f.api('jobs/' + queued.data.id)).data.status, 'cancelled');
  assert.equal((await f.api('generate', 'POST', { prompt: '第三个' })).status, 503);
});

test('symlinked model output is rejected before publication', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'liveuiagent-output-target-'));
  await writeFile(path.join(outside, 'private.html'), html);
  const f = await fixture(t, { async run({ work, onEvent }) {
    onEvent({ type: 'tool_call', name: 'write_file' });
    await symlink(path.join(outside, 'private.html'), path.join(work, 'index.html'));
    await writeFile(path.join(work, 'app.json'), '{"name":"App"}');
    return {};
  } });
  const queued = await f.api('generate', 'POST', { prompt: '应用' });
  assert.equal((await f.finished(queued.data.id)).status, 'error');
  assert.deepEqual((await f.api('state')).data.apps, []);
});

test('cancelling during final output staging cannot publish a completed application', { timeout: 60000 }, async t => {
  const f = await fixture(t, writer());
  let staged;
  let release;
  const entered = new Promise(resolve => { staged = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalWrite = fs.writeFile;
  t.mock.method(fs, 'writeFile', async function(file, ...args) {
    const result = await originalWrite.call(this, file, ...args);
    if (path.basename(String(file)).startsWith('.pending-')) { staged(); await gate; }
    return result;
  });
  t.after(() => release());
  const queued = await f.api('generate', 'POST', { prompt: '应用' });
  try {
    await entered;
    const cancelled = await f.api('jobs/' + queued.data.id, 'DELETE', {});
    assert.equal(cancelled.data.status, 'cancelled');
  } finally { release(); }
  await f.runtime.dispose();
  assert.equal((await f.api('jobs/' + queued.data.id)).data.status, 'cancelled');
  assert.deepEqual((await f.api('state')).data.apps, []);
});
