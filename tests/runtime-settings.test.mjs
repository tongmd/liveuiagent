import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {createRuntimeSettings} from '../dist-server/server/runtime-settings.js';
import {createCompleteApps} from '../dist-server/server/complete-apps.js';

async function serve(t,app){const s=createServer(app);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return `http://127.0.0.1:${s.address().port}`;}
const userOf=req=>req.header('x-liveuiagent-user')||'';

test('per-user harness preferences persist and dispatch new/existing apps with explicit mismatch errors',async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  const options={userOf,choicesOf:()=>[{id:'native',label:'Native',available:true},{id:'dsh',label:'DSH',available:true}],modelOf:async()=>({id:'fixture'}),defaultHarness:'dsh'};
  let settings=createRuntimeSettings(db,options);
  const app=express();app.use(express.json());settings.install(app);
  app.post('/dispatch',(req,res,next)=>{try{res.json({harness:settings.forRequest(req,req.body.appId)})}catch(e){next(e)}});
  app.use((e,req,res,next)=>res.status(e.status||500).json({code:e.code}));
  const base=await serve(t,app);
  async function call(route,body,owner='alice',method='POST'){const r=await fetch(base+route,{method,headers:{'content-type':'application/json','x-liveuiagent-user':owner},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,...await r.json()};}
  assert.equal((await call('/dispatch',{})).harness,'dsh');
  assert.equal((await call('/agent/runtime-settings',{harness:'native'},'alice','PATCH')).harness,'native');
  settings=createRuntimeSettings(db,options);
  assert.equal((await call('/dispatch',{completeApp:true})).harness,'native');
  assert.equal((await call('/dispatch',{},'bob')).harness,'dsh');
  assert.equal((await call('/dispatch',{appId:'dsh_old'})).harness,'dsh');
  assert.equal((await call('/dispatch',{appId:'native_old'},'bob')).harness,'native');
  assert.equal((await call('/dispatch',{appId:'dsh_old',harness:'native'})).code,'app_harness_mismatch');
  assert.equal((await call('/agent/runtime-settings',{harness:'imaginary'},'alice','PATCH')).code,'harness_unknown');
  assert.equal((await call('/agent/runtime-settings',{harness:'dsh',model:'x'},'alice','PATCH')).code,'runtime_settings_invalid');
});

test('bridge forwards the chosen model/provider for generate, revise and action; legacy service fails explicitly',async t=>{
  const appId='12345678-1234-1234-1234-123456789abc';const requests=[];let modern=true;
  const upstream=express();upstream.use(express.json());
  upstream.get('/api/runtime-settings',(req,res)=>modern?res.json({model:'default',modelSelection:true,providerOverride:true}):res.status(404).json({error:'old service'}));
  const meta={id:appId,name:'Fixture',description:'Fixture app',revision:1,createdAt:new Date().toISOString()};
  upstream.get('/api/state',(req,res)=>res.json({apps:[meta],engine:{model:'default'}}));
  upstream.get('/api/apps/:id',(req,res)=>res.json({app:meta,html:'<html></html>',store:{}}));
  for(const route of ['/api/generate','/api/apps/:id/action'])upstream.post(route,(req,res)=>{requests.push({body:req.body,owner:req.header('x-liveuiagent-user')});res.status(202).json({id:'job',appId,status:'done',model:req.body.model,toolCalls:1});});
  const upstreamBase=await serve(t,upstream);
  const old=process.env.LIVEUIAGENT_DSH_API_BASE;process.env.LIVEUIAGENT_DSH_API_BASE=upstreamBase+'/api';t.after(()=>{if(old===undefined)delete process.env.LIVEUIAGENT_DSH_API_BASE;else process.env.LIVEUIAGENT_DSH_API_BASE=old;});
  const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE chat_history(id INTEGER PRIMARY KEY,owner,role,text,prompt,kind,status,label)');
  const personal={prepare:async()=>{},requestStatus:()=>({}),recall:()=>[]};
  let harness='dsh';
  const bridge=createCompleteApps(db,personal,userOf,()=>undefined,{harnessFor:()=>harness,executionOf:()=>({model:'chosen-model',provider:{apiBase:'https://provider.example/v1',apiKey:'fixture-secret'}})});
  const app=express();app.use(express.json());bridge.install(app);app.post('/agent/run',(req,res)=>res.json({native:true}));
  app.use((e,req,res,next)=>res.status(e.status||500).json({code:e.code,error:e.message}));const base=await serve(t,app);
  async function call(route,body){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-liveuiagent-user':'alice'},body:JSON.stringify(body)});const text=await r.text();assert.ok(!text.includes('fixture-secret'));return{...JSON.parse(text),httpStatus:r.status};}
  const defaultNative=await call('/agent/run',{prompt:'new Native fixture'});assert.equal(defaultNative.native,true);assert.equal(requests.length,0,'DSH reasoning does not implicitly select HTML delivery');
  const generated=await call('/agent/run',{prompt:'build fixture',delivery:'html'});assert.equal(generated.type,'app_created');assert.equal(generated.execution.model,'chosen-model');
  assert.equal((await call('/agent/patch-app',{appId:'dsh_'+appId,prompt:'revise'})).httpStatus,202);
  assert.equal((await call('/agent/action',{appId:'dsh_'+appId,prompt:'explain'})).httpStatus,202);
  assert.equal(requests.length,3);for(const request of requests){assert.equal(request.owner,'alice');assert.equal(request.body.model,'chosen-model');assert.equal(request.body.provider.apiKey,'fixture-secret');}
  harness='native';assert.equal((await call('/agent/run',{prompt:'native'})).native,true);assert.equal(requests.length,3);
  harness='dsh';modern=false;assert.equal((await call('/agent/run',{prompt:'unsupported',delivery:'html'})).code,'harness_model_unsupported');assert.equal(requests.length,3);
});
