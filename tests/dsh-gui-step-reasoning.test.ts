import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {planNativeGuiInteractionStep,runAppWorldGrounding} from '../server/liveuiagent.js';
import {createNativeDshRelay} from '../server/dsh-native-relay.js';
const emptyInput={userMessage:'Enter a real supplied value',snapshot:{visibleText:'',fields:[],buttons:[]}};
const completion=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
test('only the DeepSeek single-step GUI planner overrides thinking while retaining cap and timeout',async t=>{
 const before=process.env.LIVEUIAGENT_LLM_EXTRA_BODY;process.env.LIVEUIAGENT_LLM_EXTRA_BODY=JSON.stringify({thinking:{type:'enabled'},reasoning_effort:'high',seed:17});t.after(()=>before===undefined?delete process.env.LIVEUIAGENT_LLM_EXTRA_BODY:process.env.LIVEUIAGENT_LLM_EXTRA_BODY=before);
 for(const model of ['DeepSeek-V4.1-Flash','deepseek-flash','deepseek/deepseek-v4-pro']){
  let captured:any,options:any;const result=await planNativeGuiInteractionStep('Select one existing visible control',emptyInput,{model,chatCompletion:async(body,config)=>{captured=body;options=config;return completion({operation:{quote:emptyInput.userMessage},fields:[],action:{kind:'done',reason:'No visible operation required'}});}});
  assert.equal(result.kind,'done');assert.equal(captured.model,model);assert.deepEqual(captured.thinking,{type:'disabled'});assert.equal(captured.reasoning_effort,'none');assert.equal(captured.max_tokens,8192);assert.equal(captured.seed,17);assert(options.timeoutMs<=120000);assert.equal(options.roleLabel,'Native GUI Step Planner');
 }
 let captured:any;await planNativeGuiInteractionStep('One GUI step',emptyInput, {model:'other-model',chatCompletion:async body=>{captured=body;return completion({operation:{quote:emptyInput.userMessage},fields:[],action:{kind:'done',reason:'Done'}});}});assert.deepEqual(captured.thinking,{type:'enabled'});assert.equal(captured.reasoning_effort,'high','another model keeps existing explicit user/provider settings');
 delete process.env.LIVEUIAGENT_LLM_EXTRA_BODY;await planNativeGuiInteractionStep('One GUI step',emptyInput, {model:'other-model',chatCompletion:async body=>{captured=body;return completion({operation:{quote:emptyInput.userMessage},fields:[],action:{kind:'done',reason:'Done'}});}});assert.equal(captured.thinking,undefined);assert.equal(captured.reasoning_effort,undefined);
});
test('host GUI policy wins over simulated DSH defaults in the actual relay upstream body',async t=>{
 const bodies:any[]=[];const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;bodies.push(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(completion({operation:{quote:emptyInput.userMessage},fields:[],action:{kind:'done',reason:'No more actions'}})));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(r=>upstream.close(()=>r()));});
 const result=await planNativeGuiInteractionStep('One existing GUI operation',emptyInput, {model:'DeepSeek-V4.1-Flash',chatCompletion:async request=>{
  const relay=await createNativeDshRelay({provider:{apiBase:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,apiKey:'fixture-private'},request,signal:new AbortController().signal});try{
   const response=await fetch(relay.provider.apiBase+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+relay.provider.apiKey},body:JSON.stringify({...request,thinking:{type:'enabled'},reasoning_effort:'high',max_completion_tokens:32768})});assert.equal(response.status,200);return response.json();
  }finally{await relay.close();}
 }});assert.equal(result.kind,'done');assert.equal(bodies.length,1);assert.equal(bodies[0].model,'DeepSeek-V4.1-Flash');assert.deepEqual(bodies[0].thinking,{type:'disabled'});assert.equal(bodies[0].reasoning_effort,'none');assert.equal(bodies[0].max_tokens,8192);assert.equal(bodies[0].max_completion_tokens,undefined);assert.equal(bodies[0].tools,undefined);
});
test('Native DeepSeek structured business requirement execution and verification roles use the central JSON policy',async t=>{
 const previous=process.env.LIVEUIAGENT_LLM_EXTRA_BODY;process.env.LIVEUIAGENT_LLM_EXTRA_BODY=JSON.stringify({thinking:{type:'enabled'},reasoning_effort:'high'});t.after(()=>previous===undefined?delete process.env.LIVEUIAGENT_LLM_EXTRA_BODY:process.env.LIVEUIAGENT_LLM_EXTRA_BODY=previous);
 const requests:any[]=[];let execution=0;const tools=[{id:'write',apiName:'update_record',permission:'write',appName:'records',method:'PATCH',purpose:'Update an actual record'},{id:'read',apiName:'read_record',permission:'read',appName:'records',method:'GET',purpose:'Read an actual record'}];
 const output=await runAppWorldGrounding({appName:'Records',permissions:['write','read'],payload:{request:'Update the real record'},bridge:{getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>({tool:tools.find(x=>x.id===id),request:args,response:{id:1,name:'Actual record'},dbChanges:null})} as any,llm:{model:'DeepSeek-V4.1-Flash',chatCompletion:async(body,options)=>{
  requests.push({body,role:options?.roleLabel});const system=(body.messages as any[])[0].content;return completion(system.includes('You analyze a GUI')?{objective:'Update actual record',deliverables:['Updated record']}:system.includes('You are the Write Verifier')?{approved:true}:system.includes('You are an INDEPENDENT evaluator')?{pass:true,deficiencies:[]}:++execution===1?{calls:[{api:'update_record',args:{id:1}},{api:'read_record',args:{id:1}}]}:{done:true,summary:'Actual record verified',entities:[{id:'1',name:'Actual record'}]});
 }}});assert.equal(output?.evaluation?.pass,true);assert(requests.some(x=>x.role==='Write Verifier Agent'));for(const {body} of requests){assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.reasoning_effort,'none');assert.ok(Number.isFinite(body.max_tokens)&&body.max_tokens>0&&body.max_tokens<=8192);assert.equal(body.max_completion_tokens,undefined);}
});
