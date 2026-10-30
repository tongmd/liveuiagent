import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import express from 'express';
import Database from 'better-sqlite3';
import {installDevelopmentRoutes,wantsLiveuiDevelopment,developmentCompletion} from '../server/development-routes.js';
import {createHarnessIntegration} from '../server/harness-integration.js';
const models=['DeepSeek-V4.1-Flash','Qwen3.8-Flash','Kimi-K3','GLM-5.3-FlashX'];
const envelope=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
async function fixture(mode='success'){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-development-route-')),source=path.join(dir,'source');
 await fs.mkdir(path.join(source,'server'),{recursive:true});await fs.writeFile(path.join(source,'server/example.ts'),'export const answer = 1;\n');
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','source']])execFileSync('git',['-C',source,...args]);
 const calls:any[]=[],contexts:any[]=[],selection:any[]=[];let invocations=0;
 function infer(request:any){
  invocations++;calls.push(structuredClone(request));
  if(mode==='failure')throw Object.assign(new Error('fixture provider unavailable'),{code:'fixture_provider_error'});
  const messages=request.messages,tool=messages.filter((m:any)=>m.role==='assistant').map((m:any)=>JSON.parse(m.content)).at(-1);
  const last=JSON.parse(messages.at(-1).content);
  if(!tool)return envelope({tool:'read',path:last.runtimeContext.files.find((f:any)=>f.key==='memory').chunks[0].path});
  if(tool.tool==='read'&&tool.path.startsWith('context/'))return envelope({tool:'read',path:'server/example.ts'});
  if(tool.tool==='read')return envelope({tool:'edit',path:'server/example.ts',expectedSha256:last.toolResult.result.sha256,oldText:'answer = 1',newText:'answer = 2'});
  if(tool.tool==='edit')return envelope({tool:'test',commandId:'behavior'});
  return envelope({tool:'finish',summary:'Changed the fixture answer.'});
 }
 const provider=express();provider.use(express.json({limit:'10mb'}));provider.post('/v1/chat/completions',(req,res)=>{assert.equal(req.header('authorization'),'Bearer test-provider-key');try{res.json(infer(req.body));}catch{res.status(503).json({error:'fixture failure'});}});
 const pserver=provider.listen(0,'127.0.0.1');await new Promise<void>(r=>pserver.once('listening',r));const providerUrl='http://127.0.0.1:'+(pserver.address() as any).port+'/v1';
 const runner={maxConcurrent:2,chatCompletion:async(request:any)=>infer(request)};
 const codex={allowsUser:()=>true,view:()=>({id:'gpt-6-astra'}),config:()=>({model:'gpt-6-astra',chatCompletion:async(request:any)=>infer(request)})};
 const integration=createHarnessIntegration({codex:codex as any,dsh:runner as any,domestic:{qwen:runner,kimi:runner,zcode:runner} as any,htmlConfigured:()=>true});
 const db=new Database(':memory:'),app=express();app.use(express.json());
 const dev=installDevelopmentRoutes(app,db,{owners:['alice','bob'],workspaceRoot:path.join(dir,'jobs'),sourceRoot:source,userOf:req=>String(req.header('x-owner')||''),harnessFor:req=>req.body.harness||'native',llmOf:req=>{
  selection.push(structuredClone(req.body));return integration.connect(req.body.harness||'native',{owner:String(req.header('x-owner')),models,model:models[0],requested:{},personalContext:'owner memory',legacyCapabilities:async()=>({}),resolve:requested=>({apiBase:providerUrl,apiKey:'test-provider-key',model:requested.model||models[0]})});
 },context:async(owner,appId)=>{contexts.push({owner,appId});return {memory:'actual owner memory',selectedApp:{id:appId,owner},deployment:{sha:'actual-runtime-sha'},originalRequest:'actual prior prompt'};},allowedTests:{behavior:['fixture']},runTest:async({cwd})=>({exitCode:mode!=='test-failure'&&(await fs.readFile(path.join(cwd,'server/example.ts'),'utf8')).includes('answer = 2')?0:1,stdout:mode==='test-failure'?'test failed':'1 behavior test passed',stderr:''})});
 app.post('/agent/run',(_req,res)=>res.json({type:'ordinary_app'}));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:error.message,code:error.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as any).port;
 const request=(endpoint:string,body?:any,owner='alice',headers:any={})=>fetch(url+endpoint,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-owner':owner,...headers},...(body?{body:JSON.stringify(body)}:{})});
 return {request,dev,calls,contexts,selection,get invocations(){return invocations},async close(){await dev.dispose();server.closeAllConnections();pserver.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>pserver.close(()=>r()))]);db.close();await fs.rm(dir,{recursive:true,force:true});}};
}
test('host editing uses explicit intent, not app requests or quoted source',()=>{
 for(const prompt of ['修改 liveUI 本身，把按钮改一下','修复liveUI宿主，处理错误','请帮我修改liveUI源码','Edit liveUI source code','继续修改liveUI，把入口改好'])assert.equal(wantsLiveuiDevelopment({prompt}),true,prompt);
 for(const prompt of ['用liveUI生成应用','创建一个说明如何修改liveUI本身的页面','“修改liveUI本身”是什么意思','> 修改liveUI源码','给应用增加游戏功能','继续','改一下'])assert.equal(wantsLiveuiDevelopment({prompt}),false,prompt);
 assert.equal(wantsLiveuiDevelopment({target:'liveui',prompt:'fix'}),true);
});
test('six harness adapters run the same persistent read/edit/test conversation and return actual patch without app creation',async()=>{
 const f=await fixture();try{
 for(const harness of ['native','dsh','codex','qwen','kimi','zcode']){
  const req={target:'liveui',prompt:'修改liveUI源码，修复示例',harness,clientRequestId:harness,selectedAppId:'dsh_owned',delivery:'html',hostContext:{fake:'untrusted'},owner:'bob'};
  const response=await f.request('/agent/run',req);assert.equal(response.status,200);const result:any=await response.json();assert.equal(result.type,'answered');assert.equal(result.execution.harness,harness);assert.equal(result.development.validation,'passed');assert.equal(result.development.deployed,false);assert.match(result.development.diff,/answer = 2/);assert.match(result.answer,/未部署/);assert.ok(result.developmentConversationId);
  const before=f.invocations;const duplicate:any=await (await f.request('/agent/run',req)).json();assert.equal(duplicate.jobId,result.jobId);assert.equal(f.invocations,before);
  const job=await f.request('/agent/development/jobs/'+result.jobId);assert.equal(job.status,200);
  assert.equal((await f.request('/agent/development/jobs/'+result.jobId,undefined,'bob')).status,404);
  assert.equal((await f.request('/agent/development/conversations/'+result.developmentConversationId,undefined,'bob')).status,404);
  const patch=await (await f.request('/agent/development/jobs/'+result.jobId+'/patch')).text();assert.equal(patch,result.development.diff);
  const recovered:any=await (await f.request('/agent/development/requests/'+harness)).json();assert.equal(recovered.id,result.jobId);
 }
 assert.equal(f.invocations,30);assert.ok(f.selection.every(x=>!x.appId&&!x.selectedAppId&&!x.delivery&&!x.hostContext&&!x.owner));assert.ok(f.contexts.every(x=>x.owner==='alice'&&x.appId==='dsh_owned'));
 assert.ok(f.calls.every(x=>x.messages.some((m:any)=>m.role==='system')));assert.ok(f.calls[4].messages.some((m:any)=>m.content.includes('answer = 1')));assert.ok(f.calls[4].messages.some((m:any)=>m.content.includes('actual owner memory')));assert.ok(f.calls[4].messages.some((m:any)=>m.content.includes('actual-runtime-sha'))===false,'unread runtime fields stay available in complete context files');
 }finally{await f.close();}
});
test('owner boundaries, disabled default, ordinary fallthrough and failures stay failures',async()=>{
 const f=await fixture('failure');try{
 const req={target:'liveui',prompt:'修改liveUI本身',clientRequestId:'failure'};
 assert.equal((await f.request('/agent/run',req,'')).status,401);assert.equal((await f.request('/agent/run',req,'mallory')).status,403);assert.equal(f.invocations,0);
 assert.equal((await (await f.request('/agent/run',{prompt:'用liveUI生成游戏'})).json() as any).type,'ordinary_app');
 const bad=await f.request('/agent/run',req);assert.equal(bad.status,502);const result:any=await bad.json();assert.equal(result.code,'development_provider_error');assert.ok(result.jobId);assert.equal(result.type,undefined);
 const sse=await f.request('/agent/run',{...req,clientRequestId:'sse-failure'},'alice',{accept:'text/event-stream'});const stream=await sse.text();assert.match(stream,/event: error/);assert.doesNotMatch(stream,/event: result/);
 const db=new Database(':memory:'),app=express(),disabled=installDevelopmentRoutes(app,db,{owners:[],sourceRoot:'',workspaceRoot:'',userOf:()=>'',harnessFor:()=>'',llmOf:()=>undefined,context:async()=>({})});assert.equal(disabled.configured,false);await disabled.dispose();db.close();
 }finally{await f.close();}
});
test('explicit continuation preserves full earlier messages and selected-node app context',async()=>{
 const f=await fixture();try{
 const first:any=await (await f.request('/agent/run',{target:'liveui',prompt:'修改liveUI源码',clientRequestId:'first',selectedNodeId:'node1',canvasState:{nodes:[{id:'node1',appId:'app-owned'}]}})).json();
 const second:any=await (await f.request('/agent/run',{prompt:'继续修改liveUI，说明已修改内容',clientRequestId:'second'})).json();assert.equal(second.developmentConversationId,first.developmentConversationId);assert.equal(f.contexts[0].appId,'app-owned');assert.ok(f.calls.at(-1).messages.some((m:any)=>m.content.includes('修改liveUI源码')));
 const conv:any=await (await f.request('/agent/development/conversations/'+first.developmentConversationId)).json();assert.equal(conv.jobs.length,2);
 }finally{await f.close();}
});
test('adapter response deadline is bounded and invalid envelope cannot become success',async()=>{
 await assert.rejects(developmentCompletion({model:'x',chatCompletion:async()=>({choices:[]})},[],100),{code:'development_provider_format'});
 await assert.rejects(developmentCompletion({model:'x',chatCompletion:()=>new Promise(()=>{})},[],5),{code:'development_model_timeout'});
});
test('a finished model turn with failed tests reports failed validation, never deployed',async()=>{
 const f=await fixture('test-failure');try{const result:any=await (await f.request('/agent/run',{target:'liveui',prompt:'修复liveUI宿主',clientRequestId:'bad-test'})).json();assert.equal(result.development.validation,'failed');assert.match(result.answer,/当前代码测试失败/);assert.equal(result.development.deployed,false);}finally{await f.close();}
});
