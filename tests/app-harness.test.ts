import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {createAppHarness} from '../server/app-harness.js';
import {createPersonalization} from '../server/personalization.js';
import {createNativeHarnessBindings} from '../server/native-harness.js';
import {createRuntimeSettings} from '../server/runtime-settings.js';
import {createRichWorkspaces} from '../server/rich-workspaces.js';
import {harnessCatalog,type HarnessId} from '../server/harness-catalog.js';

const models:Record<HarnessId,string>={native:'DeepSeek-V4.1-Flash',codex:'gpt-6-astra',dsh:'DeepSeek-V4.1-Flash',qwen:'Qwen3.8-Flash',kimi:'Kimi-K3',zcode:'GLM-5.3-FlashX'};
const fixtureTree={type:'Stack',children:[{type:'Text',text:'Saved data'},{type:'Checklist',recordId:'tuesday',checked:true},{type:'Plot',plot:{kind:'line',series:[{name:'Minutes',color:'#2255cc',points:[[1,20],[2,35],[3,15]]}]}}]};
const fixtureState={app:{id:'visual_shared',name:'Existing app',description:'Keep the weekly records visible',harness:'native',model:models.native,revision:2},version:2,tree:fixtureTree,records:[{id:'tuesday',value:35}],interactionState:{checked:{tuesday:true}},requestHistory:[{prompt:'original complete request'}],lastRequest:'original request'};
async function fixture(t:any){
 const db=new Database(':memory:');db.exec(`CREATE TABLE agent_apps(app_id TEXT PRIMARY KEY,owner TEXT,package_json TEXT,data_json TEXT,runtime_state_json TEXT,version TEXT,name TEXT DEFAULT 'Fixture',description TEXT DEFAULT 'Fixture description',updated_at TEXT DEFAULT '2026');
 CREATE TABLE rich_workspaces(owner TEXT,app_id TEXT,snapshot_json TEXT,PRIMARY KEY(owner,app_id));
 CREATE TABLE complete_apps(owner TEXT,app_id TEXT,info_json TEXT,updated_at TEXT,PRIMARY KEY(owner,app_id));`);
 db.prepare('INSERT INTO agent_apps(app_id,owner,package_json,data_json,runtime_state_json,version) VALUES (?,?,?,?,?,?)').run('native_existing','alice','{"actions":{"saved":true}}','{"items":[1,2]}','{"open":true}','3');
 db.prepare('INSERT INTO rich_workspaces VALUES (?,?,?)').run('alice','visual_shared',JSON.stringify(fixtureState));
 db.prepare('INSERT INTO complete_apps VALUES (?,?,?,?)').run('alice','dsh_existing','{"id":"existing"}','2026');
 const binding=createNativeHarnessBindings(db),userOf=(req:any)=>String(req.headers['x-owner']||'');
 const requests:any[]=[];let block:Promise<void>|undefined,bad=false,available=true,capabilityBlock:Promise<void>|undefined;
 const modelOf=async(_req:any,id:HarnessId)=>{await capabilityBlock;return {id:models[id],models:[models[id]]};};
 const choicesOf=()=>harnessCatalog.map(x=>({id:x.id,label:x.label,available:available||x.id!=='codex'}));
 const manager=createAppHarness(db,{userOf,binding,choicesOf,modelOf,connect:(_req,harness,model)=>{assert.equal(model,models[harness]);return {model};}});
 const runtime=createRuntimeSettings(db,{userOf,choicesOf,modelOf,appHarnessOf:(req,id)=>binding.get(userOf(req),id)});
 const rich=createRichWorkspaces(db,{userOf,harnessFor:(req,id)=>runtime.forRequest(req,id),bindHarness:(owner,id,h)=>binding.save(owner,id,h as HarnessId),llmOf:(req,id)=>{
   const harness=runtime.forRequest(req,id),model=manager.modelFor(userOf(req),id!)||models[harness];
   return {model,chatCompletion:async(request:any)=>{requests.push({harness,model,request});await block;return {choices:[{message:{content:JSON.stringify({text:'done',data:{tree:bad?{type:'Invalid'}:fixtureTree}})}}]};}};
 }});
 const app=express();app.use(express.json());manager.install(app);rich.install(app);
 const personal=createPersonalization(db,userOf,req=>({model:manager.modelFor(userOf(req),req.body.appId)||models.native,chatCompletion:async()=>{await block;return {choices:[{message:{content:JSON.stringify({title:'Fixture',background:'#ffffff',surface:'#f0f0f0',text:'#111111',accent:'#2255cc',radius:8,density:'comfortable',font:'sans',layout:'cards'})}}]};}}),(req,id,work)=>manager.during(req,id,work));personal.install(app);
 app.post('/native-action',async(req,res,next)=>{try{await manager.during(req,'native_existing',async()=>{requests.push({harness:runtime.forRequest(req,'native_existing'),model:manager.modelFor(userOf(req),'native_existing')});await block;});res.json({ok:true});}catch(e){next(e);}});
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message,code:e.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.close();db.close();});
 const base='http://127.0.0.1:'+(server.address() as any).port;
 async function call(path:string,body?:any,method=body?'PATCH':'GET',owner='alice'){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-owner':owner},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json() as any};}
 const get=(id='visual_shared')=>call('/agent/apps/'+id+'/harness');
 const change=async(h:HarnessId,id='visual_shared',extra:any={})=>call('/agent/apps/'+id+'/harness',{harness:h,model:models[h],expectedToken:(await get(id)).token,...extra});
 const snapshot=()=>JSON.parse((db.prepare('SELECT snapshot_json FROM rich_workspaces WHERE owner=? AND app_id=?').get('alice','visual_shared') as any).snapshot_json);
 const wait=async(id:string)=>{for(let i=0;i<200;i++){const result=await call('/agent/workspaces/jobs/'+id);if(result.status!=='running')return result;await new Promise(r=>setTimeout(r,5));}throw Error('job did not finish');};
 return {db,binding,runtime,manager,rich,call,get,change,snapshot,wait,requests,setBlock:(v:Promise<void>|undefined)=>block=v,setBad:(v:boolean)=>bad=v,setAvailable:(v:boolean)=>available=v,setCapabilityBlock:(v:Promise<void>|undefined)=>capabilityBlock=v};
}

test('all six executors take over one persisted workspace through HTTP and run the next generation with full data',async t=>{
 const x=await fixture(t);
 for(const {id} of harnessCatalog){
   const before=x.snapshot(),result=await x.change(id);assert.equal(result.status,200);assert.equal(result.harness,id);assert.equal(result.model,models[id]);
   const switched=x.snapshot();for(const field of ['tree','records','interactionState','requestHistory','lastRequest'])assert.deepEqual(switched[field],before[field],field);
   assert.equal(switched.app.id,before.app.id);assert.equal(switched.version,before.version+1);
   const job=await x.call('/agent/workspaces/visual_shared/generate',{prompt:'Keep all saved values; change the layout',expectedVersion:switched.version,clientRequestId:'after-switch-'+id},'POST');
   assert.equal(job.status,'running');const done=await x.wait(job.id);assert.equal(done.status,'done',JSON.stringify(done));assert.equal(done.execution.harness,id);assert.equal(done.execution.model,models[id]);
   assert.equal(x.requests.at(-1).harness,id);assert.equal(x.requests.at(-1).model,models[id]);
   const input=JSON.stringify(x.requests.at(-1).request.messages);assert.match(input,/tuesday/);assert.match(input,/35/);assert.match(input,/checked/);assert.match(input,/original request|Keep all saved values/);
   assert.deepEqual(x.snapshot().records,fixtureState.records);assert.deepEqual(x.snapshot().interactionState,fixtureState.interactionState);
 }
 assert.equal(x.requests.length,6);assert.equal(x.db.prepare('SELECT count(*) n FROM app_executor_events').get().n,6);
});

test('native package, runtime and data remain byte-identical while the next action uses the chosen executor',async t=>{
 const x=await fixture(t),before=x.db.prepare('SELECT * FROM agent_apps').get();
 for(const {id} of harnessCatalog){assert.equal((await x.change(id,'native_existing')).status,200);const called=await x.call('/native-action',{},'POST');assert.equal(called.status,200);assert.equal(x.requests.at(-1).harness,id);assert.equal(x.requests.at(-1).model,models[id]);assert.deepEqual(x.db.prepare('SELECT * FROM agent_apps').get(),before);}
 assert.equal(x.binding.get('alice','native_existing'),'zcode');
});

test('owner isolation, unavailable adapters, unsupported HTML and wrong model reject without changing anything',async t=>{
 const x=await fixture(t),before=x.snapshot(),current=await x.get();
 assert.equal((await x.call('/agent/apps/visual_shared/harness',undefined,'GET','bob')).status,404);
 assert.equal((await x.call('/agent/apps/visual_shared/harness',{harness:'codex',expectedToken:current.token},'PATCH','bob')).status,404);
 assert.equal((await x.call('/agent/apps/visual_shared/harness',undefined,'GET','')).status,401);
 assert.equal((await x.change('codex','dsh_existing')).code,'app_harness_format_unsupported');
 assert.equal((await x.change('qwen','visual_shared',{model:'gpt-6-astra'})).code,'harness_model_unavailable');
 x.setAvailable(false);assert.equal((await x.change('codex')).code,'harness_unavailable');
 assert.deepEqual(x.snapshot(),before);assert.equal(x.requests.length,0);assert.equal(x.db.prepare('SELECT count(*) n FROM app_executor_events').get().n,0);
});

test('CAS detects concurrent content changes, stale selections and A-to-B-to-A binding changes',async t=>{
 const x=await fixture(t),old=await x.get();await x.change('codex');await x.change('native');
 assert.equal((await x.call('/agent/apps/visual_shared/harness',{harness:'qwen',expectedToken:old.token})).code,'app_harness_conflict');
 const current=await x.get();let release!:()=>void;x.setCapabilityBlock(new Promise(r=>release=r));
 const pending=x.call('/agent/apps/visual_shared/harness',{harness:'qwen',expectedToken:current.token});await new Promise(r=>setTimeout(r,15));
 const snapshot=x.snapshot();snapshot.records.push({id:'new',value:10});x.db.prepare('UPDATE rich_workspaces SET snapshot_json=?').run(JSON.stringify(snapshot));release();
 assert.equal((await pending).code,'app_harness_conflict');assert.equal(x.snapshot().app.harness,'native');assert.deepEqual(x.snapshot().records,snapshot.records);
});

test('running rich and native actions prevent takeover until actual work finishes',async t=>{
 const x=await fixture(t);let release!:()=>void;x.setBlock(new Promise(r=>release=r));
 const job=await x.call('/agent/workspaces/visual_shared/generate',{prompt:'Change layout',expectedVersion:2},'POST');
 assert.equal((await x.change('codex')).code,'app_harness_busy');
 const native=x.call('/native-action',{},'POST');await new Promise(r=>setTimeout(r,15));assert.equal((await x.change('codex','native_existing')).code,'app_harness_busy');
 release();await native;await x.wait(job.id);assert.equal((await x.change('codex')).status,200);assert.equal((await x.change('codex','native_existing')).status,200);
});

test('failed model after a successful takeover preserves all app content and the original job is not replayed',async t=>{
 const x=await fixture(t);await x.change('codex');const before=x.snapshot();x.setBad(true);
 const body={prompt:'Change layout',expectedVersion:before.version,clientRequestId:'failed-codex-job'};
 const job=await x.call('/agent/workspaces/visual_shared/generate',body,'POST');const ended=await x.wait(job.id);assert.equal(ended.status,'error');assert.deepEqual(x.snapshot(),before);assert.equal(x.requests.length,2);
 const same=await x.call('/agent/workspaces/visual_shared/generate',body,'POST');assert.equal(same.id,job.id);assert.equal(x.requests.length,2);
});

 test('per-app model selection wins over stale global models and headers without changing defaults',async t=>{
 const x=await fixture(t);await x.change('native','native_existing');
 const req={headers:{'x-owner':'alice'},body:{appId:'native_existing',llm:{model:'Kimi-K3'}},header:()=> 'gpt-6-astra'} as any;
 assert.equal(x.manager.requestModel(req),models.native);
 assert.equal(x.manager.requestModel({...req,body:{selectedAppId:'native_existing',llm:{model:'Kimi-K3'}}}),models.native);
 assert.equal(x.manager.requestModel({...req,body:{llm:{model:'Kimi-K3'}}}),'Kimi-K3');
 assert.equal(x.manager.requestModel({...req,body:{appId:'native_other'}}),'gpt-6-astra');
 assert.equal(x.db.prepare('SELECT count(*) n FROM user_runtime_settings').get().n,0);
 });

 test('actual appearance route holds the executor through asynchronous model output and releases after save',async t=>{
 const x=await fixture(t);await x.change('native','native_existing');let release!:()=>void;x.setBlock(new Promise(r=>release=r));
 const pending=x.call('/agent/personal/appearance',{appId:'native_existing',brief:'Use readable colors'},'POST');
 for(let i=0;i<100&&!x.manager.busy('alice','native_existing');i++)await new Promise(r=>setTimeout(r,5));
 assert.equal((await x.change('codex','native_existing')).code,'app_harness_busy');release();assert.equal((await pending).status,200);
 assert.equal((await x.change('codex','native_existing')).status,200);
 });

test('all 36 ordered switching pairs preserve content, and a repeated exact choice is a no-op',async t=>{
 const x=await fixture(t);
 for(const from of harnessCatalog)for(const to of harnessCatalog){
   await x.change(from.id);const before=x.snapshot(),selected=await x.get();
   const result=await x.call('/agent/apps/visual_shared/harness',{harness:to.id,model:models[to.id],expectedToken:selected.token});
   assert.equal(result.status,200,from.id+' -> '+to.id);assert.equal(result.harness,to.id);assert.equal(result.changed,from.id!==to.id);
   const after=x.snapshot();for(const field of ['tree','records','interactionState','requestHistory','lastRequest'])assert.deepEqual(after[field],before[field]);
   assert.equal(after.version,before.version+(from.id===to.id?0:1));
 }
 assert.equal(x.requests.length,0);assert.equal(x.db.prepare('SELECT count(*) n FROM user_runtime_settings').get().n,0);
});

test('selected executor and model survive a real database close and reopen',async t=>{
 const x=await fixture(t);await x.change('kimi');const before=await x.get();
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-harness-persistence-'));
 const file=path.join(dir,'app.db');fs.writeFileSync(file,x.db.serialize(),{mode:0o600});
 const reopened=new Database(file);try{
  const binding=createNativeHarnessBindings(reopened);
  const manager=createAppHarness(reopened,{userOf:()=> 'alice',binding,choicesOf:()=>harnessCatalog.map(x=>({...x,available:true})),modelOf:async(_req,id)=>({id:models[id],models:[models[id]]}),connect:(_req,_id,model)=>({model})});
  const after=await manager.view({} as any,'visual_shared');assert.equal(after.harness,'kimi');assert.equal(after.model,models.kimi);assert.equal(after.token,before.token);assert.equal(after.revision,before.revision);
  const runtime=createRuntimeSettings(reopened,{userOf:()=> 'alice',choicesOf:()=>harnessCatalog.map(x=>({...x,available:true})),modelOf:async()=>({}),appHarnessOf:(_req,id)=>binding.get('alice',id)});
  assert.equal(runtime.forRequest({body:{}} as any,'visual_shared'),'kimi');assert.equal(manager.requestModel({body:{appId:'visual_shared',llm:{model:'gpt-6-astra'}},header:()=>''} as any),models.kimi);
 }finally{reopened.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a removed pinned model cannot silently fall back to another model in the same harness family',async t=>{
 const x=await fixture(t);await x.change('dsh','native_existing');
 const req={headers:{'x-owner':'alice'},body:{appId:'native_existing'}} as any;
 assert.throws(()=>x.manager.assertConnection(req,{model:'DeepSeek-Other'}),{code:'app_model_unavailable',status:409});
 assert.throws(()=>x.manager.assertConnection(req,undefined),{code:'app_model_unavailable'});
 const actual={model:models.dsh};assert.equal(x.manager.assertConnection(req,actual),actual);
 assert.equal(x.manager.assertConnection({...req,body:{}} as any,{model:'DeepSeek-Other'}).model,'DeepSeek-Other');
});
