import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {HOST_COMMAND_DELEGATED_CHOICE_POLICY,hostCommandRoute} from '../server/native-host-command-runtime.js';
import {NativeWorkflow,type WorkflowRecord} from '../server/native-workflow.js';
const approved=(instructions:string)=>({proceed:true,instructions,constraints:['Keep the original scope and permissions; only the host executor may dispatch.','Use actual candidate identities and independently read back every actual effect.'],expectedOutcome:'Only the requested result, verified against actual evidence.'});
// Explicit HTTP model stubs test host route/context/refusal, not model quality.
async function fixture(t:any,respond:(node:any,input:any)=>unknown){
 const requests:any[]=[];const records:WorkflowRecord[]=[];const permissions=['storage.app','app_state.write','tool.example.read_candidates','tool.example.apply_selection'];const route=hostCommandRoute(permissions);const before=structuredClone(route);
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const part of req)raw+=part;const packet=JSON.parse(raw);requests.push(packet);const result=respond(packet.node,packet.input);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const workflow=new NativeWorkflow({appId:'app',owner:'owner',actionId:route.action.id,chain:route.action.agentChain,specs:route.specs,handoffEdges:route.action.handoffs,record:r=>records.push(r),call:async(node,input,mode)=>{const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({node,input,mode})});assert.equal(response.status,200);return response.json();}});
 return{workflow,requests,records,route,before,permissions};
}
test('command orchestrator and scope share delegated-choice policy without changing route/grants',()=>{
 const permissions=['storage.app','tool.example.read_candidates'];const route=hostCommandRoute(permissions);
 for(const id of ['agents.orchestrator','agents.host-command-scope'])assert(route.specs[id].purpose.includes(HOST_COMMAND_DELEGATED_CHOICE_POLICY));
 assert.match(HOST_COMMAND_DELEGATED_CHOICE_POLICY,/recommendations alone does not authorize an external mutation/);assert.match(HOST_COMMAND_DELEGATED_CHOICE_POLICY,/Generated UI options and required flags do not add user or API prerequisites/);assert.match(HOST_COMMAND_DELEGATED_CHOICE_POLICY,/payment actors, recipients, monetary amounts, existing target identities, explicit dates or permissions/);
 assert.deepEqual(route.action.permissions,permissions);assert.deepEqual(permissions,['storage.app','tool.example.read_candidates']);assert.deepEqual(route.action.agentChain,['agents.orchestrator','agents.host-command-scope','agents.host-command-plan']);assert.deepEqual(route.action.steps,[]);assert.throws(()=>hostCommandRoute(['storage.app','storage.app']),/exact persisted manifest/);
});
test('actual HTTP scope chain carries delegated choice/discovery plan without demanding concrete choices',async t=>{
 const f=await fixture(t,(node,input)=>{
  assert.match(input.context.originalRequest.command,/Choose and arrange/);if(node.id!=='agents.host-command-plan')assert(node.purpose.includes(HOST_COMMAND_DELEGATED_CHOICE_POLICY));
  if(node.id==='agents.orchestrator')return approved('Use authorized read_candidates discovery, then choose actual returned IDs matching the requested style. Arrange them into three user-delegated groups; do not invent candidate identities or treat all five generated options as mandatory.');
  assert.match(input.upstream[0].instructions,/actual returned IDs/);return approved('Selection among actual discovered candidates is delegated. Keep explicit constraints, resolve service identities through actual reads, preserve unrelated records, and verify the actual result; this plan is not execution evidence.');
 });
 const context={originalRequest:{command:'Choose and arrange a warm selection across three groups.',requestId:'00000000-0000-4000-8000-000000000001'},appPurpose:'Build a curated collection and let me rearrange selections.',permissions:f.permissions,currentState:{entities:[],appRecords:[],unrelated:{value:0,enabled:false}},hostActionContext:{originalAppNeed:'Build a curated collection and let me rearrange selections.',fields:[{name:'choice',type:'select',uiRequired:true,requiredOrigin:'generated-ui-design-not-api',valueState:'not_submitted',options:['a','b','c','d','e']}],actualApiContracts:{read:{required:[]},apply:{required:['candidate_id']}}}};const before=structuredClone(context);const handoffs=await f.workflow.plan(context);
 assert.equal(f.requests.length,3);assert.equal(handoffs.length,3);assert.equal(f.records.filter(r=>r.stage==='plan_repair').length,0);
 for(const [i,r]of f.requests.entries()){assert.deepEqual(r.input.context.originalRequest,before.originalRequest);assert.deepEqual(r.input.context.hostActionContext,before.hostActionContext);assert.deepEqual(r.input.context.permissions,f.permissions);assert.deepEqual(r.input.context.currentState,before.currentState);assert.equal(r.input.upstream.length,i);}
 assert.deepEqual(context,before);assert.deepEqual(f.route,f.before);assert.equal(f.records.filter(r=>r.stage==='plan'&&r.status==='ok').length,3);
});
for(const scenario of [
 {name:'payment actor',command:'Record a payment without an identified payer.',reason:'The actual payer is unresolved.'},
 {name:'recipient',command:'Send it to an unspecified recipient.',reason:'The actual recipient is unresolved.'},
 {name:'monetary amount',command:'Transfer an unspecified amount.',reason:'The required monetary amount is unresolved.'},
 {name:'existing target identity',command:'Change that existing record when several match.',reason:'The existing target identity is unresolved.'},
 {name:'explicit date',command:'Move it to my unspecified exact date.',reason:'The required explicit date is unresolved.'},
 {name:'unauthorized mutation',command:'Recommend a selection only.',reason:'A recommendation does not authorize the proposed external mutation.'},
])test(`explicit scope refusal for ${scenario.name} stays final without repair/later worker`,async t=>{
 const f=await fixture(t,node=>node.id==='agents.orchestrator'?approved('Keep the user request unchanged; clarify unresolved safety-critical values rather than inventing them.'):{proceed:false,reason:scenario.reason});
 await assert.rejects(f.workflow.plan({originalRequest:{command:scenario.command},permissions:f.permissions,currentState:{entities:[]}}),error=>String(error).includes(scenario.reason));assert.equal(f.requests.length,2);assert.deepEqual(f.requests.map(r=>r.node.id),['agents.orchestrator','agents.host-command-scope']);assert.equal(f.records.filter(r=>r.stage==='plan_repair').length,0);assert.equal(f.workflow.handoffs.length,1);
 const failed=f.records.find(r=>r.nodeId==='agents.host-command-scope'&&r.status==='failed');assert.equal((failed?.output as any).modelOutput.proceed,false);assert.equal(f.records.some(r=>r.nodeId==='agents.host-command-plan'),false);
});
