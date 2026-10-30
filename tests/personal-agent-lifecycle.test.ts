import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import {createPersonalization} from '../server/personalization.js';
import {createRichWorkspaces} from '../server/rich-workspaces.js';
import {createNativeHarnessBindings} from '../server/native-harness.js';
import {createRuntimeSettings} from '../server/runtime-settings.js';
import {domesticHarnesses} from '../server/harness-catalog.js';

for(const harness of ['native','codex','dsh',...domesticHarnesses.map(h=>h.id)] as const){
 test(`${harness}: create, preferences, edit, correction, failure, reopen and owner isolation`,async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE agent_apps(app_id TEXT PRIMARY KEY,name TEXT,description TEXT,owner TEXT,updated_at TEXT)');
  const owner=(req:any)=>req.headers['x-owner']||'alice',bindings=createNativeHarnessBindings(db);
  const settings=createRuntimeSettings(db,{userOf:owner,choicesOf:()=>['native','codex','dsh','qwen','kimi','zcode'].map(id=>({id:id as any,label:id,available:true})),modelOf:async()=>({}),defaultHarness:harness,appHarnessOf:(req,id)=>bindings.get(owner(req),id)});
  const calls:any[]=[];let color='#2255cc',broken=false;
  const llm={model:'fixture',apiBase:'http://127.0.0.1:1/v1',apiKey:'must-not-be-used-directly',chatCompletion:async(request:any)=>{
   const system=request.messages[0].content;const input=JSON.parse(request.messages[1].content);calls.push({system,input});let answer:any;
   if(system.includes("contextual memory")){
    const correction=input.current.text.includes('更正'),preference=input.current.text.includes('大字号'),old=input.memories.find((m:any)=>m.dimension==='字号');
    answer={updates:preference?[{id:old?.id||null,preference:correction?'使用正常字号':'使用大字号',dimension:'字号',condition:'阅读',scope:'global',evidence:[{eventId:input.current.id,quote:input.current.text}],expiresAt:null}]:[],selected_ids:old?[old.id]:[],selected_update_indexes:preference?[0]:[],current_context:'阅读任务',forget_ids:[]};
   }else if(broken)answer={text:'invalid',data:{tree:{type:'Script'}}};
   else answer={text:'已调整',data:{tree:{type:'Stack',children:[{type:'Text',text:'阅读工作区',style:{fontSize:color==='#2255cc'?24:16}},{type:'Scene3D',scene:{objects:[{id:'book',shape:'box',position:[0,0,0],scale:[2,1,1],color}]}}]}}};
   return {choices:[{message:{content:JSON.stringify(answer)}}]};
  }};
  const personal=createPersonalization(db,owner,()=>({...llm}));
  const workspace=createRichWorkspaces(db,{userOf:owner,harnessFor:(req,id)=>settings.forRequest(req,id),llmOf:()=>({...llm}),prepare:(req,config)=>personal.prepare(req,config),memoryStatus:req=>personal.requestStatus(req),recall:(o,id)=>personal.recall(o,id),bindHarness:(o,id,h)=>bindings.save(o,id,h as any)});
  const app=express();app.use(express.json());workspace.install(app);personal.install(app);settings.install(app);app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status||500).json({error:err.message,code:err.code}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+(server.address() as any).port;
  async function req(url:string,body?:any,method=body?'POST':'GET',who='alice'){const response=await fetch(base+url,{method,headers:{'content-type':'application/json','x-owner':who},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
  async function done(id:string){for(let i=0;i<200;i++){const job=(await req('/agent/workspaces/jobs/'+id)).data;if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,5));}throw Error('job timeout');}
  const created=await req('/agent/workspaces/create',{prompt:'做一个阅读三维应用。我阅读时喜欢大字号',clientRequestId:'create'});assert.equal(created.status,202);const first=await done(created.data.id);assert.equal(first.status,'done');assert.equal(first.contextualMemory.remembered,1);assert.equal(first.execution.harness,harness);
  const id=first.appId;const before=(await req('/agent/workspaces/'+id)).data;
  assert.ok(calls.find(c=>c.input.context?.hostExperience)?.input.context.hostExperience.rememberedPreferences.some((p:any)=>p.preference==='使用大字号'));
  // Presentation-only interaction is persisted without inventing a preference.
  const memoryCount=()=>db.prepare('SELECT COUNT(*) n FROM personal_context_memory').get() as any;
  await req('/agent/workspaces/'+id+'/state',{expectedVersion:1,interactionState:{richState:{scene:{yaw:1.2}},checked:{}}},'PUT');assert.equal(memoryCount().n,1);
  await req('/agent/runtime-settings',{harness:harness==='qwen'?'kimi':'qwen'},'PATCH');color='#bb3322';
  const edited=await req('/agent/workspaces/'+id+'/generate',{prompt:'更正：我阅读不喜欢大字号了，用正常字号。把书改成红色',expectedVersion:2,clientRequestId:'edit'});const second=await done(edited.data.id);assert.equal(second.status,'done');assert.equal(second.execution.harness,harness);assert.equal(memoryCount().n,1);
  const after=(await req('/agent/workspaces/'+id)).data;assert.equal(after.app.id,before.app.id);assert.equal(after.tree.children[1].scene.objects[0].color,color);assert.deepEqual(after.interactionState.richState,{scene:{yaw:1.2}});assert.deepEqual(after.records,before.records);assert.equal(after.requestHistory.length,2);
  const memories=(await req('/agent/personal')).data.memories;assert.equal(memories.filter((m:any)=>m.active&&m.source==='interaction')[0].content,'使用正常字号');
  assert.equal((await req('/agent/workspaces/'+id,undefined,'GET','bob')).status,404);assert.equal((await req('/agent/personal',undefined,'GET','bob')).data.memories.length,0);
  broken=true;const bad=await req('/agent/workspaces/'+id+'/generate',{prompt:'调整布局',expectedVersion:3});const failed=await done(bad.data.id);assert.equal(failed.status,'error');assert.deepEqual((await req('/agent/workspaces/'+id)).data,after);
  const activity=db.prepare('SELECT status,prompt,text FROM chat_history ORDER BY id DESC LIMIT 1').get() as any;assert.equal(activity.status,'error');assert.equal(activity.prompt,'调整布局');
  broken=false;const reopened=createRichWorkspaces(db,{userOf:owner,harnessFor:()=>harness,codexOf:()=>llm});assert.deepEqual(reopened.load('alice',id),after);
  const next=await req('/agent/workspaces/create',{prompt:'做另一个阅读图表应用'});await done(next.data.id);const lastUi=calls.filter(c=>c.input.context).at(-1);assert.ok(lastUi.input.context.hostExperience.rememberedPreferences.some((p:any)=>p.preference==='使用正常字号'));
  // Both memory and UI requests went through the selected callback despite a
  // configured (unreachable) API URL, proving there is no preference bypass.
  assert.ok(calls.filter(c=>c.system.includes('contextual memory')).length>=4);
 });
}
