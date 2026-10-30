import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDomesticHarnessInference,parseHarnessAnswer} from '../server/domestic-harness-inference.js';
import {harnessModels,selectHarnessModel,type DomesticHarnessId} from '../server/harness-catalog.js';
const models=['DeepSeek-V4.1-Flash','Qwen3.8-Flash','Kimi-K3','GLM-5.3-FlashX'];
test('API models map to their harness; an old browser model cannot cross families',()=>{
 for(const [id,model] of ['dsh','qwen','kimi','zcode'].map((h,i)=>[h,models[i]])){
  assert.deepEqual(harnessModels(id as any,models),[model]);assert.equal(selectHarnessModel(id as any,models,'old-model'),model);
 }
 assert.equal(selectHarnessModel('kimi',['Qwen3.8-Flash']),undefined);
});
test('CLI error/tool/empty output never becomes a successful answer',()=>{
 for(const id of ['qwen','kimi','zcode'] as const)for(const output of ['', '{}','garbage'])assert.throws(()=>parseHarnessAnswer(id,output));
 assert.throws(()=>parseHarnessAnswer('qwen',JSON.stringify([{type:'result',subtype:'success',result:'ok',stats:{tools:{totalCalls:1}}}])));
 assert.throws(()=>parseHarnessAnswer('kimi',JSON.stringify({role:'assistant',content:'ok',tool_calls:[{}]})));
 assert.throws(()=>parseHarnessAnswer('zcode',JSON.stringify({response:'ok',projection:{status:'idle'},usage:{modelRequestCount:2}})));
});
// Opt in with actual official CLI entrypoint paths; the provider is local and has
// no real API keys. This catches CLI/config/protocol drift, not just mock adapters.
for(const [id,envName,model] of [['qwen','LIVEUI_TEST_QWEN_CLI',models[1]],['kimi','LIVEUI_TEST_KIMI_CLI',models[2]],['zcode','LIVEUI_TEST_ZCODE_CLI',models[3]]] as const){
 test(`official ${id}: ordered context, model, Unicode response, isolation and cleanup`,{skip:!process.env[envName]},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'liveui-harness-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls:any[]=[];
  const content=JSON.stringify({text:'偏好已应用',data:{tree:{type:'Text',text:'中文保持完整'}}});
  const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);calls.push({body:b,authorization:req.headers.authorization});res.writeHead(200,{'content-type':'text/event-stream'});
   const send=(delta:any,finish_reason:any)=>res.write('data: '+JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
   send({role:'assistant',content},null);send({},'stop');res.end('data: [DONE]\n\n');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const runner=createDomesticHarnessInference({id,command:process.execPath,args:[process.env[envName]!],root});t.after(()=>runner.dispose());
  const messages=[{role:'system',content:'Return JSON'},{role:'user',content:'我喜欢大字号'},{role:'assistant',content:'已记录'},{role:'user',content:'更正：只在晚上使用大字号'}];const progress:string[]=[];
  const result=await runner.chatCompletion({model,messages,max_tokens:512},{provider:{apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,apiKey:'real-test-key-not-for-cli'},onProgress:step=>progress.push(step)});
  assert.equal(result.choices[0].message.content,content);assert.equal(calls.length,1);assert.equal(calls[0].body.model,model);assert.deepEqual(calls[0].body.messages.slice(1),messages);assert.equal(calls[0].body.tools,undefined);assert.equal(calls[0].authorization,'Bearer real-test-key-not-for-cli');assert.equal(calls[0].body.max_tokens,512);assert.equal(progress.length,3);assert.deepEqual(await readdir(root),[]);
 });
}
test('a failed or hung harness produces an explicit failure and releases capacity',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liveui-harness-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const request={model:'Kimi-K3',messages:[{role:'user',content:'test'}]},provider={apiBase:'http://127.0.0.1:1/v1',apiKey:'test'};
 const runner=createDomesticHarnessInference({id:'kimi',command:process.execPath,args:['-e','setInterval(()=>{},1000)','--'],root,timeoutMs:100,maxConcurrent:1});t.after(()=>runner.dispose());
 const results=await Promise.allSettled([runner.chatCompletion(request,{provider}),runner.chatCompletion(request,{provider})]);for(const r of results){assert.equal(r.status,'rejected');if(r.status==='rejected')assert.match(r.reason.code,/kimi_timeout/);}
 assert.deepEqual(await readdir(root),[]);
 const missing=createDomesticHarnessInference({id:'kimi',command:'/does-not-exist/liveui',root});await assert.rejects(missing.chatCompletion(request,{provider}),{code:'kimi_launch_failed'});assert.deepEqual(await readdir(root),[]);
});
