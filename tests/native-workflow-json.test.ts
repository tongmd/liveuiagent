import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkflowJson } from '../server/liveuiagent.js';
import { NativeWorkflow } from '../server/native-workflow.js';

const args={label:'Independent result verifier',system:'Return strict JSON verdict',user:'Observed receipt is absent'};
test('short Native JSON roles keep model/budget and request DeepSeek content without hidden reasoning',async()=>{
  const requests:any[]=[];
  const llm:any={model:'DeepSeek-V4.1-Flash',chatCompletion:async(body:any)=>{requests.push(body);return {choices:[{message:{content:'{"pass":false,"reason":"no receipt"}'}}]};}};
  const result=await nativeWorkflowJson({...args,llm});
  assert.equal(result.pass,false);assert.equal(requests.length,1);
  assert.equal(requests[0].model,llm.model);assert.equal(requests[0].max_tokens,8192);
  assert.deepEqual(requests[0].thinking,{type:'disabled'});assert.equal(requests[0].reasoning_effort,'none');
  assert.equal(requests[0].tools,undefined);assert.equal(requests[0].messages[1].content,args.user);
});
test('other adapters retain original reasoning policy and empty output fails with only safe diagnostics',async()=>{
  let request:any;let calls=0;
  const llm:any={model:'gpt-6-astra',chatCompletion:async(body:any)=>{calls++;request=body;return {choices:[{finish_reason:'length',message:{content:null,reasoning_content:'secret-private-thought'}}],usage:{completion_tokens:8192,completion_tokens_details:{reasoning_tokens:8192}},api_key:'secret-token'};}};
  await assert.rejects(nativeWorkflowJson({...args,llm}),(e:any)=>{
    assert.match(e.message,/response missing content/);assert.match(e.message,/finish_reason=length/);assert.match(e.message,/completion_tokens=8192/);assert.match(e.message,/reasoning_tokens=8192/);
    assert.doesNotMatch(e.message,/secret|private|thought|token=/);return true;
  });
  assert.equal(calls,1);assert.equal(request.thinking,undefined);assert.equal(request.reasoning_effort,undefined);
});
test('empty review never approves or replays an already observed business effect',async()=>{
  let calls=0;const writes=1;const steps:any[]=[];
  const specs:any={'agents.orchestrator':{id:'agents.orchestrator',role:'orchestrator',purpose:'Plan'},'agents.action':{id:'agents.action',role:'action',purpose:'Action'}};
  const workflow=new NativeWorkflow({appId:'fixture',owner:'owner',actionId:'save',chain:['agents.orchestrator','agents.action'],specs,handoffEdges:[{from:'agents.orchestrator',to:'agents.action'}],record:s=>steps.push(s),call:()=>nativeWorkflowJson({...args,llm:{model:'DeepSeek-V4.1-Flash',chatCompletion:async()=>{calls++;return {choices:[{finish_reason:'evil-secret',message:{content:'',reasoning_content:'hidden'}}],usage:{completion_tokens:'secret'}};}} as any})});
  await assert.rejects(workflow.review({writes}),/response missing content.*finish_reason=unknown.*completion_tokens=unknown/);
  assert.equal(calls,1);assert.equal(writes,1);assert.equal(steps.at(-1).status,'failed');
});
