import test from 'node:test';import assert from 'node:assert/strict';
import {NativeWorkflow,NATIVE_ROLE_TRANSPORT_LIMITS,nativeRoleTransportPolicy,type WorkflowRecord} from '../server/native-workflow.js';
const chain=['agents.orchestrator','agents.action'];const specs=Object.fromEntries(chain.map(id=>[id,{id,role:id}]));const edges=[{from:chain[0],to:chain[1]}];
function fixture(call:any){const records:WorkflowRecord[]=[];return{records,workflow:new NativeWorkflow({appId:'fixture',owner:'alice',actionId:'read',chain,specs,handoffEdges:edges,record:r=>records.push(r),call})};}
const valid=()=>({proceed:true,instructions:'Read verified current state.',constraints:['A'.repeat(105),'B'.repeat(116)],expectedOutcome:'O'.repeat(207)});

test('former per-string sizes are intact under one shared aggregate transport budget without repair',async()=>{
 let calls=0;const output={...valid(),unrelatedPreviouslyAcceptedKey:'not newly rejected'};const f=fixture(async(_node:any,input:any)=>{calls++;assert(!input.contractRepair);return output;});const handoffs=await f.workflow.plan({originalRequest:{amount:0,enabled:false},permissions:['actual.scope']});assert.equal(calls,2);
 for(const h of handoffs){assert.deepEqual(h.constraints,output.constraints);assert.equal(h.expectedOutcome,output.expectedOutcome);assert.equal(h.instructions,output.instructions);}assert.equal(f.records.filter(r=>r.stage==='plan_repair').length,0);
 assert.deepEqual(NATIVE_ROLE_TRANSPORT_LIMITS,{instructionsUnicodeCharacters:2048,constraintsCount:4,totalHandoffUnicodeCharacters:4096});assert.match(nativeRoleTransportPolicy,/together at most 4096 Unicode characters/);assert.doesNotMatch(nativeRoleTransportPolicy,/each at most 100|at most 200/);
});

test('aggregate4096 includes Unicode code points and preserves full strings;4097 fails without truncation',async()=>{
 for(const unicode of [false,true]){
  const output={proceed:true,instructions:(unicode?'😀':'I').repeat(2048),constraints:[(unicode?'界':'C').repeat(2000)],expectedOutcome:'O'.repeat(48)};
  assert.equal([output.instructions,...output.constraints,output.expectedOutcome].reduce((n,v)=>n+Array.from(v).length,0),4096);
  let calls=0;const good=fixture(async()=>{calls++;return output;});const h=await good.workflow.plan({originalRequest:'Preserve complete request'});assert.equal(calls,2);assert.equal(h[0].instructions,output.instructions);assert.deepEqual(h[1].constraints,output.constraints);
  const oversized={...output,expectedOutcome:output.expectedOutcome+'!'};let attempts=0;const bad=fixture(async()=>{attempts++;return oversized;});await assert.rejects(bad.workflow.plan({originalRequest:'Preserve complete request'}),/4096 aggregate Unicode characters \(received 4097\)/);assert.equal(attempts,2);assert.equal(bad.workflow.handoffs.length,0);assert.deepEqual((bad.records.find(r=>r.stage==='contract_validation'&&r.status==='failed')!.output as any).invalidOutput,oversized);
 }
});

test('instruction2048 and four-constraint caps remain, with exactly one pure repair under the same original contract',async()=>{
 for(const invalid of [{...valid(),instructions:'😀'.repeat(2049)},{...valid(),constraints:['one','two','three','four','five']}]){
  const original={originalRequest:{opaque:'Full source',amount:0,enabled:false},permissions:['unchanged.scope'],currentState:{entries:['Retain me']}};let count=0;const f=fixture(async(_node:any,input:any)=>{
   count++;if(count===1)return invalid;
   if(input.contractRepair){assert.equal(input.contractRepair.attempt,1);assert.equal(input.contractRepair.maxAttempts,1);assert.deepEqual(input.contractRepair.constraints,NATIVE_ROLE_TRANSPORT_LIMITS);assert(input.contractRepair.instruction.startsWith(nativeRoleTransportPolicy));assert.deepEqual(input.contractRepair.previousInvalidOutput,invalid);assert.deepEqual(input.context.originalRequest,original.originalRequest);assert.deepEqual(input.context.permissions,original.permissions);return valid();}
   return valid();
  });await f.workflow.plan(original);assert.equal(count,3,'initial+single repair for first role, one normal second role');assert.equal(f.records.filter(r=>r.stage==='plan_repair'&&r.status==='ok').length,1);
 }
});

test('refusal and transport error never trigger repair; invalid repair never starts a third invocation',async()=>{
 for(const response of [{proceed:false,reason:'Actual policy refusal'},null,{proceed:'true'}]){let calls=0;const f=fixture(async()=>{calls++;return response;});await assert.rejects(f.workflow.plan({originalRequest:'Current operation'}),/rejected/);assert.equal(calls,1);assert.equal(f.records.filter(r=>r.stage==='plan_repair').length,0);}
 let calls=0;const transport=fixture(async()=>{calls++;throw Error('transport failed');});await assert.rejects(transport.workflow.plan({}),/transport failed/);assert.equal(calls,1);
 for(const repair of [{...valid(),expectedOutcome:'x'.repeat(4097)},{proceed:false,reason:'Refuse rather than approve'}]){calls=0;const f=fixture(async()=>{calls++;return calls===1?{...valid(),instructions:'x'.repeat(2049)}:repair;});await assert.rejects(f.workflow.plan({originalRequest:'No business replay'}));assert.equal(calls,2);assert.equal(f.workflow.handoffs.length,0);}
});

test('malformed original field types are never coerced into an approved handoff',async()=>{
 for(const invalid of [{instructions:17},{constraints:[0]},{constraints:'one constraint'},{expectedOutcome:['not a string']}]){
  let calls=0;const f=fixture(async()=>{calls++;return{...valid(),...invalid};});await assert.rejects(f.workflow.plan({originalRequest:'No type coercion'}),/invalid handoff/);assert.equal(calls,2);assert.equal(f.workflow.handoffs.length,0);
 }
});
