import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarnessIntegration} from '../server/harness-integration.js';
import {harnessCatalog} from '../server/harness-catalog.js';
import {createCodexNativeInference} from '../server/codex-native-inference.js';
import type {LlmRuntimeConfig} from '../server/liveuiagent.js';

const models=['DeepSeek-V4.1-Flash','Qwen3.8-Flash','Kimi-K3','GLM-5.3-FlashX'];
function fixture(){
  const calls:any[]=[],resolved:any[]=[];
  const runner=(id:string)=>({maxConcurrent:2,dispose(){},async chatCompletion(request:any,options:any){calls.push({id,request,options});options.onProgress?.('received');return {model:request.model,choices:[{message:{content:'{}'}}]};}});
  const dsh=runner('dsh'),domestic={qwen:runner('qwen'),kimi:runner('kimi'),zcode:runner('zcode')};
  const codex=createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://127.0.0.1:1/v1',LIVEUIAGENT_CODEX_TOKEN:'test-only',LIVEUIAGENT_CODEX_ALLOWED_USERS:'alice'});
  const integration=createHarnessIntegration({codex,dsh:dsh as any,domestic,htmlConfigured:()=>true});
  const context={owner:'alice',models,model:models[0],keySource:'user',legacyCapabilities:async()=>({model:models[0],modelSelection:true,providerOverride:true}),personalContext:'current app memory',requested:{model:'gpt-6-astra',apiBase:'https://fixture.invalid/v1',apiKey:'fixture-key'},resolve(requested:Record<string,string>):LlmRuntimeConfig{resolved.push({...requested});return {...requested};}};
  return {integration,context,calls,resolved};
}
test('every registered reasoning adapter dispatches through the same host connection with its model and provider',async()=>{
  const {integration,context,calls,resolved}=fixture();
  for(const [i,id] of (['dsh','qwen','kimi','zcode'] as const).entries()){
    const llm=integration.connect(id,context)!;const progress:string[]=[];llm.onProgress=step=>progress.push(step);
    assert.equal(llm.model,models[i]);assert.equal(llm.personalContext,context.personalContext);assert.equal(llm.nativeInferenceConcurrency,2);
    const messages=[{role:'system',content:'host rules'},{role:'user',content:'current request'}];
    await llm.chatCompletion!({model:llm.model,messages},{timeoutMs:1234,roleLabel:'review'});
    const call=calls.at(-1);assert.equal(call.id,id);assert.deepEqual(call.request.messages,messages);assert.equal(call.options.timeoutMs,1234);assert.equal(call.options.provider.apiKey,'fixture-key');
    if(id==='dsh')assert.equal(call.options.roleLabel,'review');else assert.deepEqual(progress,['received']);
    assert.equal((await integration.model(id,context)).id,models[i]);
  }
  assert.equal(resolved.length,4);assert.equal(context.requested.model,'gpt-6-astra','selection never mutates the input');
});
test('shared connection cannot leak a provider override into Codex or bypass its owner allowlist',()=>{
  const {integration,context,resolved}=fixture();
  const llm=integration.connect('codex',context)!;
  assert.equal(llm.model,'gpt-6-astra');assert.equal(llm.apiBase,undefined);assert.equal(llm.apiKey,undefined);assert.equal(resolved.length,0);
  assert.throws(()=>integration.connect('codex',{...context,owner:'bob'}),{code:'codex_unavailable'});
  assert.equal(integration.choices({...context,owner:'bob'}).find(c=>c.id==='codex')!.available,false);
});
test('all non-HTML adapters reject HTML before calling a provider; only DSH preserves legacy delivery',()=>{
  const {integration,context,calls,resolved}=fixture();
  for(const item of harnessCatalog.filter(h=>!h.htmlDelivery))assert.throws(()=>integration.connect(item.id,{...context,delivery:'html'}),{status:422});
  assert.equal(resolved.length,0);
  for(const extension of [{delivery:'html'},{appId:'dsh_existing'}]){
    const llm=integration.connect('dsh',{...context,...extension})!;assert.equal(llm.model,models[0]);assert.equal(llm.chatCompletion,undefined);
  }
  assert.equal(calls.length,0);
});
test('missing model fails closed and a disconnected runner never uses direct provider inference',()=>{
  const {integration,context,resolved}=fixture();
  for(const id of ['dsh','qwen','kimi','zcode'] as const)assert.throws(()=>integration.connect(id,{...context,models:['gpt-6-astra']}),{code:'harness_model_unavailable',status:id==='dsh'?422:503});
  assert.equal(resolved.length,0);
  const unavailable=createHarnessIntegration({codex:undefined,dsh:undefined,domestic:{},htmlConfigured:()=>true});
  assert.throws(()=>unavailable.connect('dsh',context),{code:'dsh_native_unavailable'});
  assert.throws(()=>unavailable.connect('qwen',context),{code:'harness_unavailable'});
  assert.throws(()=>unavailable.connect('codex',context),{code:'codex_unavailable'});
});
test('native inference retains provider resolution and memory without acquiring a foreign worker',()=>{
  const {integration,context,calls}=fixture();const llm=integration.connect('native',context)!;
  assert.equal(llm.model,context.requested.model);assert.equal(llm.apiKey,'fixture-key');assert.equal(llm.personalContext,'current app memory');assert.equal(llm.chatCompletion,undefined);assert.equal(calls.length,0);
  assert.deepEqual(integration.choices(context).map(c=>c.id),harnessCatalog.map(c=>c.id));
});

test('provider defaults cannot replace a family model after selection, including legacy DSH',()=>{
  const {integration,context,calls}=fixture();
  for(const id of ['dsh','qwen','kimi','zcode'] as const){
    const drifted={...context,resolve:()=>({model:'gpt-6-astra',apiKey:'fixture-key',apiBase:'https://fixture.invalid/v1'})};
    assert.throws(()=>integration.connect(id,drifted),{code:'harness_model_mismatch',status:409});
    if(id==='dsh')assert.throws(()=>integration.connect(id,{...drifted,appId:'dsh_existing'}),{code:'harness_model_mismatch'});
  }
  assert.equal(calls.length,0);
});
