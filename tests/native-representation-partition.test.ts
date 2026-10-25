import test from 'node:test';
import assert from 'node:assert/strict';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
const reply=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});

test('all four grounding roles receive representation policy with unchanged actual mutation/read evidence',async()=>{
 const tools=[{id:'read_bundles',apiName:'read_bundles',permission:'read_bundles',method:'GET',appName:'fixture',purpose:'Read complete membership'},
 {id:'update_bundle',apiName:'update_bundle',permission:'update_bundle',method:'PATCH',appName:'fixture',purpose:'Update shared value and member set'},
 {id:'create_bundle',apiName:'create_bundle',permission:'create_bundle',method:'POST',appName:'fixture',purpose:'Create a backend representation'}];
 for(const scenario of ['complete','missing-member','overlapping-member','no-write','no-post-read','verifier-refusal','explicit-same-record','independent-refusal'] as const){
  let state:any[]=[{id:'bundle-1',name:'Existing bundle',members:['A','B','C'],value:4}];let index=0;const dispatched:any[]=[];const roles=new Set<string>();
  const plan=scenario==='no-write'?[{api:'read_bundles',args:{}}]:[{api:'read_bundles',args:{}},{api:'update_bundle',args:{id:'bundle-1',members:['A','C'],value:4}},{api:'create_bundle',args:{members:scenario==='missing-member'?[]:scenario==='overlapping-member'?['A','B']:['B'],value:9}},{api:'read_bundles',args:{}}];
  if(scenario==='no-post-read')plan.pop();
  const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{
   dispatched.push({api,args:structuredClone(args)});
   if(api==='update_bundle')state[0]={...state[0],...args};
   if(api==='create_bundle')state.push({id:'bundle-2',name:'Derived bundle',...args});
   return {tool:tools.find(t=>t.id===api),request:structuredClone(args),response:structuredClone(api==='read_bundles'?state:api==='create_bundle'?state[1]:state[0]),dbChanges:null};
  }};
  const payload={request:'Change unit B to value9, retain units A and C at4.'+(scenario==='explicit-same-record'?' Keep exactly the same backend record; do not create another.':'')};
  const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),payload,appName:'Bundle editor',targetEntity:{id:'bundle-1',name:'Existing bundle'},llm:{model:'offline-fixture',chatCompletion:async(req:any)=>{
   const sys=req.messages[0].content;const input=JSON.parse(req.messages[1].content.split('\n')[0]);
   assert.match(sys,/Logical-unit identity is not necessarily backend storage-record identity/);
   assert.match(sys,/Explicit record-identity requirements still apply/);
   assert.match(sys,/without omissions or overlaps/);
   assert.doesNotMatch(sys,/MUST make that many successful write calls/);
   assert.match(sys,/Local metadata and a model assertion alone never prove external success/);
   if(sys.includes('You analyze a GUI')){roles.add('requirement');return reply({objective:'Only B changes, A preserved',targetCount:3,deliverables:['A4, C4 and B9 verified'],projectionPolicy:'retain_existing'});}
   if(sys.includes('You are the Write Verifier')){roles.add('verifier');assert.deepEqual(input.proposedCalls,[plan[index-1]]);assert.match(JSON.stringify(input.userRequest),/Change unit B/);return reply(['verifier-refusal','explicit-same-record'].includes(scenario)?{approved:false,reject:true,reason:'Fixture explicit identity restriction or unsafe partition'}:{approved:true});}
   if(sys.includes('You are an INDEPENDENT evaluator')){
    roles.add('evaluator');const writes=input.apiCalls.filter((c:any)=>c.ok&&['update_bundle','create_bundle'].includes(c.api));const reads=input.apiCalls.filter((c:any)=>c.ok&&c.api==='read_bundles');const last=reads.at(-1)?.response??[];
    const units=last.flatMap((r:any)=>r.members.map((member:string)=>({member,value:r.value})));const good=writes.length===2&&units.length===3&&units.filter((u:any)=>u.member==='A'&&u.value===4).length===1&&units.filter((u:any)=>u.member==='B'&&u.value===9).length===1&&units.filter((u:any)=>u.member==='C'&&u.value===4).length===1&&reads.at(-1)?.order>writes.at(-1)?.order&&scenario!=='independent-refusal';
    // The deterministic fixture reviewer inspects full actual response bodies;
    // this tests evidence plumbing/gates, not a real model's policy understanding.
    if(writes.length){assert.ok(reads.length);if(scenario!=='no-post-read')assert.ok(reads.at(-1).order>writes.at(-1).order);assert.equal(writes[1].response.id,'bundle-2');}
    return reply({pass:good,deficiencies:good?[]:['Actual complete membership/write evidence or independent approval is missing']});
   }
   roles.add('executor');const call=plan[index++];return reply(call?{calls:[call]}:{done:true,summary:'Observed backend representation',entities:state.map(r=>({id:r.id,name:r.name,detail:r.members.join(',')+':'+r.value})),stats:[{label:'Logical units',value:'3'}]});
  }}});
  assert.equal(result?.evaluation.pass,scenario==='complete',scenario);
  assert.equal(dispatched.filter(c=>c.api==='create_bundle').length,['no-write','verifier-refusal','explicit-same-record'].includes(scenario)?0:1,'no implicit authorization or repeated create');
  assert.ok(roles.has('requirement')&&roles.has('executor')&&roles.has('evaluator'));
  if(scenario!=='no-write')assert.ok(roles.has('verifier'));
 }
});
