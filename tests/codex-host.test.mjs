import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

async function startHost(t,configured,extraEnv={}) {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-codex-test-'));
  const calls=[];
  const relay=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);assert.equal(req.headers.authorization,'Bearer test-secret');res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'gpt-6-astra',choices:[{message:{content:JSON.stringify({fields:[],action:{kind:'done',reason:'No action requested'}})}}]}));});
  await new Promise(r=>relay.listen(0,'127.0.0.1',r));
  const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const dbPath=path.join(tmp,'state.sqlite');let stderr='';
  const child=spawn(process.execPath,['dist-server/server/index.js'],{cwd:process.cwd(),stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),DB_PATH:dbPath,GENERATED_APPS_DIR:path.join(tmp,'apps'),OPENAI_API_KEY:'',OPENAI_API_BASE:'',LIVEUIAGENT_ORCHESTRATOR_MODEL:'DeepSeek-V4.1-Flash',LIVEUIAGENT_MODEL_CHOICES:'DeepSeek-V4.1-Flash',LIVEUIAGENT_DSH_API_BASE:'',LIVEUI_NATIVE_DSH_COMMAND:'',LIVEUI_DEFAULT_HARNESS:'native',LIVEUIAGENT_CODEX_BASE_URL:configured?`http://127.0.0.1:${relay.address().port}/v1`:'',LIVEUIAGENT_CODEX_TOKEN:configured?'test-secret':'',LIVEUIAGENT_CODEX_MODEL:'gpt-6-astra',LIVEUIAGENT_CODEX_ALLOWED_USERS:'alice',...extraEnv}});
  child.stdout.on('data',b=>stderr+=b.toString());child.stderr.on('data',b=>stderr+=b.toString());
  t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r)});relay.closeAllConnections();await new Promise(r=>relay.close(r));await fs.rm(tmp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<600;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));if(child.exitCode!==null)break;}
  assert.ok(ready,stderr);
  async function request(route,body,method='POST',owner='alice') {
    const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...(owner?{'x-liveuiagent-user':owner}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const raw=await response.text();assert.doesNotMatch(raw,/test-secret/);return{status:response.status,data:JSON.parse(raw)};
  }
  return{request,dbPath,calls};
}
test('actual host advertises unavailable Codex without configuration and keeps original default',async t=>{
  const {request}=await startHost(t,false);const view=await request('/agent/runtime-settings',undefined,'GET');
  assert.equal(view.data.harness,'native');assert.equal(view.data.choices.find(c=>c.id==='codex').available,false);
  assert.equal((await request('/agent/runtime-settings',{harness:'codex'},'PATCH')).status,503);
});
test('actual host keeps Codex model independent of saved provider, authorizes owner and dispatches inference',async t=>{
  const {request,dbPath,calls}=await startHost(t,true);
  const anonymous=await request('/agent/runtime-settings',undefined,'GET','');assert.equal(anonymous.data.choices.find(c=>c.id==='codex').available,false);
  await request('/agent/settings',{apiBase:'https://unused.example/v1',apiKey:'unused-test-provider',model:'DeepSeek-V4.1-Flash'},'PUT');
  const denied=await request('/agent/runtime-settings',undefined,'GET','bob');assert.equal(denied.data.choices.find(c=>c.id==='codex').available,false);assert.equal((await request('/agent/runtime-settings',{harness:'codex'},'PATCH','bob')).status,503);
  const selected=await request('/agent/runtime-settings',{harness:'codex'},'PATCH');
  assert.equal(selected.status,200);assert.deepEqual(selected.data.model,{id:'gpt-6-astra',source:'codex-login',configurable:false,providerConfigurable:false,delivery:'native'});
  assert.equal((await request('/agent/settings',undefined,'GET')).data.effective.model,'DeepSeek-V4.1-Flash');
  const db=new Database(dbPath);db.prepare("INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)").run('owned','Fixture','Fixture','{}','{}','{}','1','alice');db.prepare('INSERT INTO native_harness_bindings VALUES(?,?,?)').run('alice','owned','codex');db.close();
  const body={appId:'owned',harness:'codex',model:'gpt-6-astra',userMessage:'No action needed',snapshot:{visibleText:'Fixture',fields:[],buttons:[]},observations:[]};
  const out=await request('/evaluator/interaction-step',body);assert.equal(out.status,200,JSON.stringify(out.data));assert.equal(out.data.execution.harness,'codex');assert.equal(out.data.execution.model,'gpt-6-astra');assert.equal(calls.length,1);assert.equal(calls[0].model,'gpt-6-astra');
  assert.equal((await request('/evaluator/interaction-step',body,'POST','bob')).status,404);assert.equal(calls.length,1);
  assert.equal((await request('/agent/run',{prompt:'new app',platform:'web',delivery:'html',harness:'codex'})).status,422);assert.equal(calls.length,1);
  await request('/agent/runtime-settings',{harness:'native'},'PATCH');
  assert.equal((await request('/evaluator/interaction-step',body)).status,200);assert.equal(calls.length,2,'existing Codex app keeps its saved harness');
});


test('existing HTML actions keep their DSH model when the new-app default is Codex; missing DSH configuration fails closed',async t=>{
  const id='12345678-1234-1234-1234-123456789abc', appId='dsh_'+id, dispatched=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url==='/api/runtime-settings')return res.end(JSON.stringify({model:'DeepSeek-V4.1-Flash',modelSelection:true,providerOverride:true}));
    if(req.url==='/api/apps/'+id && req.method==='GET')return res.end(JSON.stringify({app:{id,name:'Existing app',revision:1},html:'<html></html>',store:{existing:'unchanged'}}));
    if(req.url==='/api/apps/'+id+'/action'){
      const body=JSON.parse(raw);dispatched.push(body);
      return res.end(JSON.stringify({id:'accepted-fixture',status:'queued',appId:id,model:body.model}));
    }
    res.statusCode=404;res.end(JSON.stringify({error:'Unknown fixture route'}));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r)}));
  const {request,calls}=await startHost(t,true,{LIVEUIAGENT_DSH_API_BASE:`http://127.0.0.1:${upstream.address().port}/api`,LIVEUIAGENT_APPWORLD_GROUNDING:'off'});
  await request('/agent/settings',{apiBase:'https://unused.example/v1',apiKey:'unused-test-provider',model:'DeepSeek-V4.1-Flash',models:['DeepSeek-V4.1-Flash','Qwen3.8-Flash']},'PUT');
  await request('/agent/personal/context-settings',{enabled:false},'PUT');
  assert.equal((await request('/agent/runtime-settings',{harness:'codex'},'PATCH')).status,200);
  for(const staleModel of ['gpt-6-astra','Qwen3.8-Flash']){
    const response=await request('/agent/complete/apps/'+appId+'/action',{prompt:'Read existing content',llm:{model:staleModel}});
    assert.equal(response.status,202,JSON.stringify(response.data));
    assert.equal(response.data.execution.harness,'dsh');assert.equal(response.data.execution.model,'DeepSeek-V4.1-Flash');
  }
  assert.equal(dispatched.length,2);assert.equal(calls.length,0,'HTML actions never reach Codex');
  for(const job of dispatched){assert.equal(job.model,'DeepSeek-V4.1-Flash');assert.equal(job.provider.apiBase,'https://unused.example/v1');assert.equal(job.provider.apiKey,'unused-test-provider');}
  const mismatch=await request('/agent/complete/apps/'+appId+'/action',{prompt:'Explicit Codex request',harness:'codex'});
  assert.equal(mismatch.status,409);assert.equal(mismatch.data.code,'app_harness_mismatch');assert.equal(dispatched.length,2);
  // Remove the known DSH model without changing the new-app Codex preference.
  await request('/agent/settings',{apiBase:'https://unused.example/v1',apiKey:'unused-test-provider',model:'Qwen3.8-Flash',models:['Qwen3.8-Flash']},'PUT');
  const unavailable=await request('/agent/complete/apps/'+appId+'/action',{prompt:'Read existing content',llm:{model:'gpt-6-astra'}});
  assert.equal(unavailable.status,422,JSON.stringify(unavailable.data));assert.equal(unavailable.data.code,'harness_model_unavailable');
  assert.equal(dispatched.length,2,'no model job is submitted without a configured DSH model');assert.equal(calls.length,0);
  assert.equal((await request('/agent/runtime-settings',undefined,'GET')).data.harness,'codex');
});
