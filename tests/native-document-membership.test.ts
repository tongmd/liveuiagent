import test from 'node:test';
import assert from 'node:assert/strict';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {normalizeGroundingEntities} from '../server/grounding-entities.js';
const reply=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});

test('document membership policy reaches all roles without replacing real external write/read evidence',async()=>{
 const tools=[{id:'read_document',apiName:'read_document',permission:'read_document',appName:'documents',method:'GET',purpose:'Read actual document content'}, {id:'update_document',apiName:'update_document',permission:'update_document',appName:'documents',method:'PATCH',purpose:'Replace document content'}];
 for(const scenario of ['complete','mention-only','dropped-member','no-write','no-post-read','verifier-refusal','independent-refusal'] as const){
  let doc={id:71,title:'Saved entries',content:'Entry A\nEntry B\nEntry C\nEntry D'};const ops:string[]=[];const roles=new Set<string>();let step=0;
  const plan=scenario==='no-write'?[{api:'read_document',args:{id:71}}]:[{api:'read_document',args:{id:71}},{api:'update_document',args:{id:71,content:scenario==='mention-only'?'A paragraph merely mentioning Entry A and Entry B.':scenario==='dropped-member'?'Entry E':'Entry A\nEntry B\nEntry C\nEntry D\nEntry E'}},{api:'read_document',args:{id:71}}];if(scenario==='no-post-read')plan.pop();
  const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{ops.push(api);if(api==='update_document')doc={...doc,content:args.content};return{tool:tools.find(t=>t.id===api),request:structuredClone(args),response:structuredClone(doc),dbChanges:null};}};
  const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),appName:'Document entries',appPurpose:'Manage the structured entries in my service documents; retain unrelated entries.',payload:{request:'Append Entry E to my existing saved document entries.'},viewContext:{itemLabel:'entry',primaryMembership:'service_collection',collectionLabel:'Saved entries',perItemActions:[]},llm:{model:'offline-fixture',chatCompletion:async(req:any)=>{
   const sys=req.messages[0].content;const input=JSON.parse(req.messages[1].content.split('\n')[0]);
   assert.match(sys,/omit entities\[\]\.id/);assert.match(sys,/A complete fresh read of the actual structured member content can establish membership/);assert.match(sys,/arbitrary mention, search hit/);assert.doesNotMatch(sys,/Keep id bound to the exact real service record\/container identifier/);
   if(sys.includes('You analyze a GUI')){roles.add('requirement');assert.match(sys,/If the user instead maintains entries in their actual documents/);return reply({objective:'Append the requested entry in original external document',deliverables:['Original four members and new Entry E read from document'],projectionPolicy:'retain_existing'});}
   if(sys.includes('You are the Write Verifier')){roles.add('verifier');assert.deepEqual(input.proposedCalls,[plan[step-1]]);return reply(scenario==='verifier-refusal'?{approved:false,reject:true,reason:'Fixture refuses unsafe external mutation'}:{approved:true});}
   if(sys.includes('You are an INDEPENDENT evaluator')){
    roles.add('evaluator');assert.match(sys,/no independent service member object or invented unit ID is required/);
    const writes=input.apiCalls.filter((c:any)=>c.ok&&c.api==='update_document');const reads=input.apiCalls.filter((c:any)=>c.ok&&c.api==='read_document');const last=reads.at(-1);const good=writes.length===1&&last?.order>writes[0].order&&last.response.id===71&&last.response.content==='Entry A\nEntry B\nEntry C\nEntry D\nEntry E'&&scenario!=='independent-refusal';
    // Fixture reviewer deliberately checks complete original-container content,
    // not mere name mentions. This is evidence-flow coverage, not model efficacy.
    return reply({pass:good,deficiencies:good?[]:['Actual container membership, unchanged content, write/read evidence or approval missing']});
   }
   roles.add('executor');assert.match(sys,/When the user actually maintains structured entries in a service document/);const call=plan[step++];return reply(call?{calls:[call]}:{done:true,summary:'Observed service document members',entities:['Entry A','Entry B','Entry C','Entry D','Entry E'].map(name=>({name,group:'Saved entries',detail:'Actual document71 member'})),stats:[{label:'Entries',value:'5'}]});
  }}});
  assert.equal(result?.evaluation.pass,scenario==='complete',scenario);assert.equal(ops.filter(api=>api==='update_document').length,['no-write','verifier-refusal'].includes(scenario)?0:1,'successful write must not repeat while repairing projection');assert.ok(roles.has('requirement')&&roles.has('executor')&&roles.has('evaluator'));if(scenario!=='no-write')assert.ok(roles.has('verifier'));
 }
});

test('policy clarification does not add identity deduplication or an external echo exemption',()=>{
 const four=[{id:'71',name:'Entry A'},{id:'71',name:'Entry B'},{id:'72',name:'Entry C'},{id:'73',name:'Entry D'}];assert.deepEqual(normalizeGroundingEntities(four,new Set(),[],[]),four,'mechanical preservation is not approval of shared IDs as unit identity');
 assert.deepEqual(normalizeGroundingEntities([{name:'Entry E'}],new Set(['Entry E']),[],[]),[],'known no-ID external form-echo limitation remains; no invented proof/helper');
});
