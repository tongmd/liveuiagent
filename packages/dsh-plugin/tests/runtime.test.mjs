import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveUIAgentRuntime } from '../runtime.mjs';
import { connectedStarterHtml } from '../host-action-starter.mjs';

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
  assert.equal((await f.api('generate', 'POST', { prompt: '第二个' })).status, 202);
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


test('different apps overlap within the limit and same-app actions remain FIFO', async t => {
  const waiting = [];
  let active = 0, peak = 0, calls = 0;
  const dataDir = await mkdtemp(path.join(tmpdir(),'liveuiagent-parallel-'));
  const {createHash,randomUUID}=await import('node:crypto');
  const dir=path.join(dataDir,'accounts',createHash('sha256').update('operator').digest('hex'));
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'state.json'),JSON.stringify({apps:ids.map(id=>({id,name:'Fixture',revision:1,history:[]})),jobs:[],memory:{manual:'',entries:[]},memoryFormatVersion:1}));
  for(const id of ids){await mkdir(path.join(dir,'apps',id),{recursive:true});await writeFile(path.join(dir,'apps',id,'index.html'),html);}
  const f = await fixture(t, { async run(input) {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => { waiting.push(resolve); input.signal.addEventListener('abort',resolve,{once:true}); });
    active--; await writeFile(path.join(input.work, 'response.json'), JSON.stringify({text:'done'})); return writer().run(input);
  } }, { maxConcurrent: 2, dataDir });
  const first = await f.api('apps/'+ids[0]+'/action', 'POST', { prompt: 'first' });
  const second = await f.api('apps/'+ids[1]+'/action', 'POST', { prompt: 'second' });
  const third = await f.api('apps/'+ids[2]+'/action', 'POST', { prompt: 'third' });
  const until = async fn => { for (let i=0;i<6000&&!fn();i++) await new Promise(r=>setTimeout(r,10)); assert.ok(fn()); };
  await until(()=>calls===2);
  assert.equal(active,2); assert.equal((await f.api('jobs/'+third.data.id)).data.status,'queued');
  waiting.shift()(); waiting.shift()();
  await until(()=>calls===3); waiting.shift()();
  for (const request of [first,second,third]) assert.equal((await f.finished(request.data.id)).status,'done');
  const before = calls;
  const a = await f.api('apps/'+first.data.appId+'/action','POST',{prompt:'action one'});
  const b = await f.api('apps/'+first.data.appId+'/action','POST',{prompt:'action two'});
  const other = await f.api('apps/'+second.data.appId+'/action','POST',{prompt:'other app'});
  await until(()=>calls===before+2);
  assert.equal((await f.api('jobs/'+b.data.id)).data.status,'queued');
  waiting.shift()(); waiting.shift()();
  await until(()=>calls===before+3); waiting.shift()();
  for (const request of [a,b,other]) assert.equal((await f.finished(request.data.id)).status,'done');
  assert.equal(peak,2);
});

test('connected generation and revisions expose the current read-only host reference without replacing existing app data',async t=>{
  let calls=0, existingHtml;
  const context={connectedServices:[{name:'simple_note',description:'Notes'}]};
  const connected=await fixture(t,{async run({work,onEvent,task}){
    calls++;
    const initial=await readFile(path.join(work,'index.html'),'utf8');
    const reference=path.join(work,'.liveui-host-reference.html');
    assert.equal(await readFile(reference,'utf8'),connectedStarterHtml());
    assert.equal((await fs.stat(reference)).mode & 0o222,0);
    assert.match(task,/Read \.liveui-host-reference\.html/);
    assert.match(task,/preserving its design, functions, user drafts\/preferences and actual saved data/);
    if(calls===1){
      assert.equal(initial,connectedStarterHtml());
      existingHtml=initial.replace('<title>Workspace</title>','<title>Existing reading design</title>');
      await writeFile(path.join(work,'index.html'),existingHtml);
      await writeFile(path.join(work,'app.json'),JSON.stringify({name:'Reading shelves',description:'A service-backed reading view',features:['Run reading requests'],checks:[]}));
    }else{
      assert.equal(initial,existingHtml,'revision retains the existing interface instead of reseeding it');
      assert.equal(JSON.parse(await readFile(path.join(work,'app.json'),'utf8')).name,'Reading shelves');
    }
    onEvent({type:'tool_call',name:'write_file'});return {};
  }});
  const c=await connected.api('generate','POST',{prompt:'Keep my reading shelves in notes',context});
  const done=await connected.finished(c.data.id);assert.equal(done.status,'done',done.error);assert.equal(done.repairAttempts||0,0);
  const store={verified:'actual saved result',draft:'preserve this unfinished request'};
  await connected.api('apps/'+done.appId+'/store','PUT',store);
  const revision=await connected.api('generate','POST',{prompt:'Preserve my reading design and update the service wiring',appId:done.appId,context});
  const revised=await connected.finished(revision.data.id);assert.equal(revised.status,'done',revised.error);assert.equal(calls,2);
  const reopened=await connected.api('apps/'+done.appId);assert.equal(reopened.data.html,existingHtml);assert.deepEqual(reopened.data.store,store);
  const local=await fixture(t,{async run(input){
    await assert.rejects(()=>readFile(path.join(input.work,'index.html'),'utf8'),{code:'ENOENT'});
    await assert.rejects(()=>readFile(path.join(input.work,'.liveui-host-reference.html'),'utf8'),{code:'ENOENT'});
    return writer().run(input);
  }});
  const l=await local.api('generate','POST',{prompt:'A local counter',context:{connectedServices:[]}});assert.equal((await local.finished(l.data.id)).status,'done');
});
