import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {createCompleteApps} from '../server/complete-apps.js';

async function serve(t:any,app:any) {
 const server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return `http://127.0.0.1:${(server.address()as any).port}`;
}
const id='12345678-1234-1234-1234-123456789abc',appId='dsh_'+id;
const context={uiProtocol:'liveui-tree-v1',requestId:'request-1',records:[{id:'r1',text:'Existing content'}],photos:[]};
const tree={type:'Text',recordId:'r1'};
async function fixture(t:any) {
 let store:any={record:JSON.stringify({id:'r1',text:'Existing content'})};let writes=0,actions=0,modelCalls=0;
 const completions:Array<(value:unknown)=>void>=[];
 const upstream=express();upstream.use(express.json());
 upstream.get('/api/runtime-settings',(_q,r)=>r.json({model:'fixture-model'}));
 upstream.get('/api/apps/'+id,(_q,r)=>r.json({app:{id,name:'Layout',description:'Presentation only',revision:1,lastJobId:'generation-1'},html:'<html><body>liveui-tree-v1</body></html>',store}));
 upstream.put('/api/apps/'+id+'/store',(q,r)=>{store=structuredClone(q.body);writes++;r.json({ok:true});});
 upstream.post('/api/apps/'+id+'/action',(_q,r)=>{actions++;r.status(500).json({error:'Unexpected coding agent execution'});});
 const upstreamBase=await serve(t,upstream);
 const env:any={LIVEUIAGENT_DSH_API_BASE:upstreamBase+'/api',APPWORLD_ENABLED:'false',LIVEUIAGENT_APPWORLD_GROUNDING:'off',LIVEUI_DSH_USER_PREFIX:undefined,LIVEUI_DSH_EMPTY_ACCOUNT_ROOT:undefined};
 const previous:any={};for(const [key,value]of Object.entries(env)){previous[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=String(value);}
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=String(value);}});
 const db=new Database(':memory:');t.after(()=>db.close());
 const llm={model:'fixture-model',chatCompletion:async()=>{modelCalls++;return new Promise(resolve=>completions.push(resolve));}};
 const bridge=createCompleteApps(db,{recall:()=>[]},req=>String(req.header('x-liveuiagent-user')||''),req=>{assert.equal(req.body.appId,appId,'URL app identity must be used for provider resolution');return llm;});
 const host=express();host.use(express.json());bridge.install(host);host.use((error:any,_q:any,r:any,_next:any)=>r.status(error.status||500).json({error:error.message,code:error.code}));
 const base=await serve(t,host);
 const request=async(path:string,method='GET',body?:unknown,owner='alice')=>fetch(base+'/agent/complete/'+path,{method,headers:{'X-LiveUIAgent-User':owner,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {db,request,store:()=>structuredClone(store),counts:()=>({writes,actions,modelCalls}),complete(value:unknown){assert.ok(completions.length);completions.shift()!({choices:[{message:{content:JSON.stringify(value)}}]});}};
}
async function terminal(f:any,jobId:string) {
 for(let i=0;i<40;i++){const r=await f.request('jobs/'+jobId);assert.equal(r.status,200);const job:any=await r.json();if(job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.fail('Fixture did not complete');
}
test('structured UI host persists running→done receipt and isolates owner queries without writing app data',async t=>{
 const f=await fixture(t),before=f.store();
 const started=await f.request('apps/'+appId+'/action','POST',{prompt:'Reorganize the content',context});assert.equal(started.status,202);
 const job:any=await started.json();assert.equal(job.status,'running');assert.match(job.id,/^host_/);
 assert.equal((await (await f.request('jobs/'+job.id)).json()as any).status,'running');
 assert.equal((await f.request('jobs/'+job.id,'GET',undefined,'bob')).status,404);
 assert.equal((await f.request('jobs/'+job.id,'GET',undefined,'')).status,401);
 f.complete({text:'Layout ready',data:{tree}});const done=await terminal(f,job.id);
 assert.equal(done.status,'done');assert.deepEqual(done.result.data.tree,tree);assert.equal(done.result.requestId,context.requestId);
 assert.deepEqual(f.store(),before);assert.deepEqual(f.counts(),{writes:0,actions:0,modelCalls:1});
 assert.equal((await f.request('jobs/'+job.id,'GET',undefined,'bob')).status,404);
});
test('bad output becomes durable error receipt and preserves existing store without fallback',async t=>{
 const f=await fixture(t),before=f.store();
 const started=await f.request('apps/'+appId+'/action','POST',{prompt:'Reorganize',context});const job:any=await started.json();
 f.complete({text:'Unsafe output',data:{tree:{type:'Text',recordId:'not-supplied'}}});const failed=await terminal(f,job.id);
 assert.equal(failed.status,'error');assert.match(failed.error,/unknown record reference/);assert.equal(failed.result,undefined);
 assert.deepEqual(f.store(),before);assert.deepEqual(f.counts(),{writes:0,actions:0,modelCalls:1});
});
test('concurrent compare-and-save requests allow one winner and ordinary PUT remains compatible',async t=>{
 const f=await fixture(t),expected=f.store();
 const candidates=[{...expected,layout:'first'},{...expected,layout:'second'}];
 const results=await Promise.all(candidates.map(store=>f.request('apps/'+appId+'/store-commit','POST',{expected,store})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const winner=results.findIndex(r=>r.status===200);assert.deepEqual(f.store(),candidates[winner]);assert.equal(f.counts().writes,1);
 const legacy={localPreference:'still supported'};const put=await f.request('apps/'+appId+'/store','PUT',legacy);
 assert.equal(put.status,200);assert.deepEqual(f.store(),legacy);assert.equal(f.counts().writes,2);
});

// A generated result is not a saved app: the interaction panel must distinguish them.
test('interaction history records request, generation, save conflict and confirmed save in one account-scoped row',async t=>{
 const f=await fixture(t),before=f.store();
 const job:any=await (await f.request('apps/'+appId+'/action','POST',{prompt:'重新排列这张页面',context})).json();
 const row=()=>f.db.prepare('SELECT * FROM chat_history WHERE owner=?').get('alice') as any;
 assert.equal(row().prompt,'重新排列这张页面');assert.equal(row().status,'running');
 f.complete({text:'Layout ready',data:{tree}});await terminal(f,job.id);
 assert.match(row().text,/尚未确认保存/);
 const store={...before,layout:JSON.stringify({tree})};
 const rejected=await f.request('apps/'+appId+'/store-commit','POST',{expected:{stale:'value'},store});
 assert.equal(rejected.status,409);assert.equal(row().status,'error');assert.match(row().text,/保存失败/);
 assert.equal((await f.request('apps/'+appId+'/store-commit','POST',{expected:before,store})).status,200);
 assert.equal(row().status,'done');assert.match(row().text,/已更新并保存/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_history').get().n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_history WHERE owner=?').get('bob').n,0);
});
