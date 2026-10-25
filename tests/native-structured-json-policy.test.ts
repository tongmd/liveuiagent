import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {applyNativeStructuredJsonPolicy,nativeStructuredJsonPolicyMetadata,NATIVE_STRUCTURED_JSON_POLICY} from '../server/native-structured-json-policy.js';
import {nativeModelTransport,planNativeGuiInteractionStep} from '../server/liveuiagent.js';
import {createDshNativeInference} from '../server/dsh-native-inference.js';
import {NATIVE_DSH_ROLE_BOUNDARY} from '../server/dsh-native-relay.js';
const request=(extra:any={})=>({model:'DeepSeek-V4.1-Flash',response_format:{type:'json_object'},messages:[{role:'system',content:'fixture-schema-only'},{role:'user',content:'fixture-user-input'}],...extra});
async function server(handler:(r:http.IncomingMessage,s:http.ServerResponse)=>void){const s=http.createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return {base:`http://127.0.0.1:${(s.address()as any).port}/v1`,async close(){const done=new Promise<void>(r=>s.close(()=>r()));s.closeAllConnections();await done;}};}
test('explicit bounded caps and effective safe policy; no mutation of host/global objects',()=>{
 for(const extra of [{},{max_tokens:1024},{max_completion_tokens:2048},{max_tokens:3000,max_completion_tokens:1000},{max_tokens:16384}]){
  const r=request({...extra,thinking:{type:'enabled'},reasoning_effort:'high',reasoning:{enabled:true}}),before=structuredClone(r);const p=applyNativeStructuredJsonPolicy(r);
  assert.equal(p.max_tokens,Math.min(8192,...Object.entries(extra).map(([,v])=>v as number)));assert.equal(p.max_completion_tokens,undefined);assert.deepEqual(p.thinking,{type:'disabled'});assert.equal(p.reasoning_effort,'none');assert.equal(p.reasoning,undefined);assert.deepEqual(r,before);
  assert.deepEqual(nativeStructuredJsonPolicyMetadata(p),{id:NATIVE_STRUCTURED_JSON_POLICY,responseFormat:'json_object',thinking:'disabled',reasoningEffort:'none',maxTokens:p.max_tokens});
 }
 for(const value of [0,-1,1.5,NaN,null,'1024'])assert.throws(()=>applyNativeStructuredJsonPolicy(request({max_tokens:value})),/positive safe integer/);
});
test('only DeepSeek JSON scope changes; text/nonDeepSeek remain exact objects',()=>{
 for(const r of [request({model:'other-model'}),request({response_format:undefined}),request({response_format:{type:'text'}})])assert.equal(applyNativeStructuredJsonPolicy(r),r);
 const schema=applyNativeStructuredJsonPolicy(request({model:'provider/deepseek-v4',response_format:{type:'json_schema',json_schema:{name:'schema',schema:{type:'object'}}}}));assert.equal(schema.max_tokens,8192);assert.equal((schema.response_format as any).json_schema.name,'schema');
});
test('actual host transport through Native relay forwards all structured role policy once; sanitized diagnostics reflect effective fields',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-json-policy-'));const wires:any[]=[];const upstream=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;wires.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}));});
 const adapter=createDshNativeInference({root:path.join(root,'workers'),diagnosticRoot:path.join(root,'metadata'),projectRoot:process.cwd(),command:'fixture-no-cli',provider:{apiBase:upstream.base,apiKey:'fixture-provider-secret'},runnerFactory:async()=>({async run(input){const response=await fetch(input.provider!.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+input.provider!.apiKey,'content-type':'application/json'},body:JSON.stringify({model:input.model,messages:[{role:'system',content:'adapter-default-only'}],tools:[],stream:false,max_tokens:32768,max_completion_tokens:32768})});const data:any=await response.json();if(!response.ok)throw Error('fixture relay rejected');return {answer:data.choices[0].message.content};},async dispose(){}})});
 try{
  const llm={model:'DeepSeek-V4.1-Flash',chatCompletion:adapter.chatCompletion};
  for(const role of ['Router Agent','AppWorld Grounding Agent','Write Verifier Agent','Grounding Evaluator Agent','Verifier Agent']){
   const r=request();const result=await nativeModelTransport(llm,'http://unused.invalid',{method:'POST',body:JSON.stringify(r)},5000,role);assert.equal(result.ok,true);
   const wire=wires.at(-1);assert.equal(wire.max_tokens,8192);assert.equal(wire.max_completion_tokens,undefined);assert.deepEqual(wire.thinking,{type:'disabled'});assert.equal(wire.reasoning_effort,'none');assert.deepEqual(wire.messages,[{role:'system',content:NATIVE_DSH_ROLE_BOUNDARY},...r.messages]);assert.equal(wire.tools,undefined);assert.ok(!Object.keys(wire).some(k=>/policy/i.test(k)));
  }
  assert.equal(wires.length,5);
  const paths=await fs.readdir(path.join(root,'metadata'));assert.equal(paths.length,5);
  for(const filename of paths){const meta=JSON.parse(await fs.readFile(path.join(root,'metadata',filename),'utf8'));assert.equal(meta.structuredJsonPolicy.maxTokens,8192);assert.equal(meta.structuredJsonPolicy.thinking,'disabled');assert.equal(meta.relay.providerRequests,1);assert.equal(meta.outcome,'succeeded');const serialized=JSON.stringify(meta);assert.ok(!serialized.includes('fixture-provider-secret'));assert.ok(!serialized.includes('fixture-user-input'));assert.ok(!serialized.includes('reasoning_content'));}
 }finally{await adapter.dispose();await upstream.close();await fs.rm(root,{recursive:true,force:true});}
});
test('direct HTTP DeepSeek stays unchanged and no retry is added; GUI explicit policy remains unchanged',async()=>{
 const wires:any[]=[];const upstream=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;wires.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));});
 try{const original=request({thinking:{type:'enabled'},max_tokens:16384});await nativeModelTransport({model:original.model,apiBase:upstream.base,apiKey:'fixture'},upstream.base+'/chat/completions',{method:'POST',body:JSON.stringify(original)},5000,'Router Agent');assert.deepEqual(wires[0],original);assert.equal(wires.length,1);}finally{await upstream.close();}
 let received:any;const llm={model:'DeepSeek-V4.1-Flash',chatCompletion:async(r:any)=>{received=r;return {choices:[{message:{content:JSON.stringify({operation:{},fields:[],action:{kind:'done',reason:'fixture complete'}})}}]};}};
 await planNativeGuiInteractionStep('fixture-system',{userMessage:'fixture-user',snapshot:{visibleText:'fixture',fields:[],buttons:[]},observations:[]},llm);assert.equal(received.max_tokens,8192);assert.deepEqual(received.thinking,{type:'disabled'});assert.equal(received.reasoning_effort,'none');
});
test('bounded policy does not accept truncated or incomplete output and cannot add retries',async()=>{
 for(const mode of ['length','incomplete']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-json-policy-failure-'));let calls=0;
  const upstream=await server((_req,res)=>{calls++;res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{delta:{content:'{"ok":true}'},finish_reason:null}]})+'\n\n');if(mode==='length')res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\n');res.end();});
  const adapter=createDshNativeInference({root:path.join(root,'workers'),diagnosticRoot:path.join(root,'metadata'),projectRoot:process.cwd(),command:'fixture-no-cli',provider:{apiBase:upstream.base,apiKey:'fixture'},runnerFactory:async()=>({async run(input){const r=await fetch(input.provider!.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+input.provider!.apiKey},body:JSON.stringify({model:input.model,messages:[],stream:true,max_tokens:32768})});await r.text();return {answer:'{"ok":true}'};},async dispose(){}})});
  try{await assert.rejects(nativeModelTransport({model:'DeepSeek-V4.1-Flash',chatCompletion:adapter.chatCompletion},'http://unused.invalid',{body:JSON.stringify(request())},5000,'Grounding Evaluator Agent'),error=>{assert.equal((error as any).code,mode==='length'?'dsh_native_output_truncated':'dsh_native_stream_incomplete');return true;});assert.equal(calls,1);const paths=await fs.readdir(path.join(root,'metadata'));assert.equal(paths.length,1);const meta=JSON.parse(await fs.readFile(path.join(root,'metadata',paths[0]),'utf8'));assert.equal(meta.outcome,'failed');assert.equal(meta.relay.providerRequests,1);assert.equal(meta.structuredJsonPolicy.maxTokens,8192);}
  finally{await adapter.dispose();await upstream.close();await fs.rm(root,{recursive:true,force:true});}
 }
});

test('thinking-low requires explicit isolated business experiment; GUI/global/model/caps remain unchanged',async()=>{
 const original=request({thinking:{type:'enabled'},reasoning_effort:'high',max_tokens:8192});
 assert.equal(applyNativeStructuredJsonPolicy(original).reasoning_effort,'none');
 const llm:any={model:'DeepSeek-V4.1-Flash',experimentalNativeBusinessThinking:'enabled-low',chatCompletion:async(r:any)=>{received=r;return {choices:[{message:{content:'{}'}}]};}};let received:any;
 const before=structuredClone(original);
 await nativeModelTransport(llm,'http://unused.invalid',{body:JSON.stringify(original)},5000,'Grounding Evaluator Agent');
 assert.equal(received.reasoning_effort,'low');assert.deepEqual(received.thinking,{type:'enabled'});assert.equal(received.max_tokens,8192);assert.equal(received.model,original.model);assert.deepEqual(original,before);
 for(const role of ['Native GUI Step Planner','UI Designer Agent',undefined]){await nativeModelTransport(llm,'http://unused.invalid',{body:JSON.stringify(original)},5000,role);assert.equal(received.reasoning_effort,'none');assert.deepEqual(received.thinking,{type:'disabled'});}
 const nonDeepSeek={...original,model:'other-model'};assert.deepEqual(applyNativeStructuredJsonPolicy(nonDeepSeek,{experimentalBusinessThinking:'enabled-low',roleLabel:'Grounding Evaluator Agent'}),nonDeepSeek);
 assert.equal(applyNativeStructuredJsonPolicy({...original,max_tokens:1024},{experimentalBusinessThinking:'enabled-low',roleLabel:'Grounding Evaluator Agent'}).max_tokens,1024);
 assert.equal(applyNativeStructuredJsonPolicy({...original,max_tokens:32768},{experimentalBusinessThinking:'enabled-low',roleLabel:'Grounding Evaluator Agent'}).max_tokens,8192);
 assert.equal(nativeStructuredJsonPolicyMetadata(applyNativeStructuredJsonPolicy(original,{experimentalBusinessThinking:'enabled-low',roleLabel:'Grounding Evaluator Agent'}))?.reasoningEffort,'low');
});
