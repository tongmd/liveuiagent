import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveUIAgentRuntime } from '../runtime.mjs';
const html = script => `<html><body>${' '.repeat(1100)}<button>Count</button><script>${script}</script></body></html>`;
async function fixture(t, runner, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'liveui-flow-'));
  const runtime = await createLiveUIAgentRuntime({ basePath:'/apps', dataDir, frontendDir:fileURLToPath(new URL('../public/', import.meta.url)), owner:'operator', model:'fixture', maxPending:3, timeoutMs:3000, runner, ...options });
  const server = createServer(runtime.handle);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  const api = async (route, method='GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/apps/api/${route}`, {method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert(response.ok, `HTTP ${response.status}`); return response.json();
  };
  const finished = async id => {
    const deadline = Date.now()+90000;
    while (Date.now()<deadline) { const job=await api('jobs/'+id); if (!['queued','running'].includes(job.status)) return job; await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.fail('job did not finish');
  };
  return { api, finished };
}
test('missing metadata triggers exactly one repair, then publishes valid delivery', async t => {
  let calls=0;
  const f=await fixture(t,{async run({work,onEvent,task}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    if(calls===1) await writeFile(path.join(work,'index.html'),html('let count=0;'));
    else { assert.match(task,/DELIVERY REPAIR ONLY/); assert.match(task,/metadata_missing_or_invalid/); await writeFile(path.join(work,'app.json'),'{"name":"Counter"}'); }
    return {};
  }});
  const job=await f.api('generate','POST',{prompt:'Make a counter'});
  assert.equal((await f.finished(job.id)).status,'done');
  assert.equal(calls,2);
  assert.equal((await f.api('state')).apps.length,1);
});
test('syntax still invalid after repair does not publish or replace existing revision', async t => {
  let calls=0;
  const f=await fixture(t,{async run({work,onEvent}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    await writeFile(path.join(work,'index.html'),html(calls===1?'let count=0;':'const count = ;'));
    await writeFile(path.join(work,'app.json'),'{"name":"Counter"}'); return {};
  }});
  const first=await f.api('generate','POST',{prompt:'Make a counter'});
  assert.equal((await f.finished(first.id)).status,'done');
  const before=await f.api('apps/'+first.appId);
  const change=await f.api('generate','POST',{prompt:'Change counter',appId:first.appId});
  assert.equal((await f.finished(change.id)).status,'error');
  assert.equal(calls,3);
  const after=await f.api('apps/'+first.appId);
  assert.equal(after.app.revision,1);
  assert.deepEqual(after,before);
});
test('explicit cancellation does not trigger repair or publication', async t => {
  let calls=0, entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{async run({work,onEvent,signal}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    await writeFile(path.join(work,'index.html'),html('let count=0;'));
    entered();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const job=await f.api('generate','POST',{prompt:'Make a counter'});
  await ready;
  assert.equal((await f.api('jobs/'+job.id,'DELETE',{})).status,'cancelled');
  assert.equal((await f.finished(job.id)).status,'cancelled');
  assert.equal(calls,1);
  assert.equal((await f.api('state')).apps.length,0);
});

test('generation deadline preserves valid delivery without unnecessary repair', async t => {
  let calls = 0, aborts = 0;
  const f = await fixture(t, { async run({ work, onEvent, signal }) {
    calls++; onEvent({ type: 'tool_call', name: 'write_file' });
    await writeFile(path.join(work, 'index.html'), html('let count = 0;'));
    await writeFile(path.join(work, 'app.json'), '{"name":"Counter"}');
    await new Promise((resolve, reject) => {
      const abort = () => { aborts++; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } }, { timeoutMs: 100 });
  const queued = await f.api('generate', 'POST', { prompt: 'Make a counter' });
  const job = await f.finished(queued.id);
  assert.equal(job.status, 'done');
  assert.equal(calls, 1);
  assert.equal(aborts, 1);
  assert.equal((await f.api('state')).apps.length, 1);
});

test('browser startup error is repaired once before publication', async t => {
  let calls=0;
  const f=await fixture(t,{async run({work,onEvent,task}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    if(calls===2) assert.match(task,/browser_script_error/);
    await writeFile(path.join(work,'index.html'),html(calls===1?'missingElement.textContent="broken";':'document.querySelector("button").onclick=()=>{};'));
    await writeFile(path.join(work,'app.json'),'{"name":"Counter"}'); return {};
  }});
  const job=await f.api('generate','POST',{prompt:'Make a counter'});
  assert.equal((await f.finished(job.id)).status,'done');
  assert.equal(calls,2);
});
test('persistent browser startup errors never publish', async t => {
  let calls=0;
  const f=await fixture(t,{async run({work,onEvent}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    await writeFile(path.join(work,'index.html'),html('throw Error("Startup failed");'));
    await writeFile(path.join(work,'app.json'),'{"name":"Broken"}'); return {};
  }});
  const job=await f.api('generate','POST',{prompt:'Make an app'});
  assert.equal((await f.finished(job.id)).status,'error');
  assert.equal(calls,2); assert.equal((await f.api('state')).apps.length,0);
});
test('connected-service contract failures enter one focused repair before publication', async t => {
  let calls=0;
  const f=await fixture(t,{async run({work,onEvent,task}) {
    calls++; onEvent({type:'tool_call',name:'write_file'});
    if(calls===2) {
      assert.match(task,/CONNECTED SERVICE REPAIR/);
      assert.match(task,/agent.invoke/);
      assert.match(task,/Preserve the existing interface, charts, stored data/);
    }
    const connected='<html><body><form data-liveui-action="agent.invoke"><label>Task<textarea name="task"></textarea></label><button data-liveui-action="agent.invoke">Run</button></form><p id="result"></p><script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();const value=document.querySelector("textarea").value;const r=await window.liveuiagent.ai(value,{request:value});document.querySelector("#result").textContent=r.text;};</script><!--'+'fixture '.repeat(180)+'--></body></html>';
    await writeFile(path.join(work,'index.html'),calls===1?html('localStorage.setItem("draft","local");'):connected);
    await writeFile(path.join(work,'app.json'),'{"name":"Connected app"}');return {};
  }});
  const job=await f.api('generate','POST',{prompt:'Create a connected organizer',context:{connectedServices:[{name:'Records',description:'Manage the user records'}]}});
  assert.equal((await f.finished(job.id)).status,'done');assert.equal(calls,2);
  assert.equal((await f.api('state')).apps.length,1);
});
