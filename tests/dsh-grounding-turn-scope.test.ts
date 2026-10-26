import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

// Local scripted roles exercise the real grounding loop and evidence gates.
// They verify prompt/evidence plumbing, not real-model policy compliance.
const candidates=Array.from({length:15},(_,i)=>({id:String(i+1),name:`Candidate ${i+1}`,genre:'requested genre',duration:180+i}));
async function fixture(t:any, request:string, decide:(input:any,step:number)=>any, review:(input:any)=>any) {
 const prompts:any[]=[];const operations:any[]=[];let step=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);prompts.push(body);const sys=body.messages[0].content,input=JSON.parse(body.messages[1].content);let result;
  if(sys.includes('You analyze a GUI')) result={objective:request,targetCount:request.includes('15')?15:null,deliverables:[request]};
  else if(sys.includes('You are the Write Verifier')) result={approved:true};
  else if(sys.includes('You are an INDEPENDENT evaluator')) result=review(input);
  else result=decide(input,++step);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const tools=['search_catalog','read_candidate','save_choice','read_saved'].map(id=>({id,apiName:id,permission:id,appName:'catalog',method:id==='save_choice'?'POST':'GET',purpose:'Read candidates or save the user selection'}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{
  operations.push({id,args});return{tool:tools.find(x=>x.id===id),request:args,response:id==='search_catalog'?candidates:id==='read_candidate'?candidates[0]:{...candidates[0],saved:true},dbChanges:null};
 }};
 const output=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request},appName:'Catalog choices',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 return{output,operations,prompts};
}
function assertPolicies(prompts:any[]) {
 const role=(text:string)=>prompts.find(p=>p.messages[0].content.includes(text)).messages[0].content;
 assert.match(role('You analyze a GUI'),/not automatically a write count/);
 assert.match(role('You analyze a GUI'),/do not claim the later whole goal is complete/);
 const execution=role('You are the backend workflow');
 assert.doesNotMatch(execution,/After ONE search|never search twice|never run more than two searches|Any reasonable match satisfies/);
 assert.match(execution,/consecutive searches when they resolve different prerequisites/);
 assert.match(execution,/reserve budget for required post-write read-back/);
 assert.match(role('You are an INDEPENDENT evaluator'),/Neither requires an unrequested write/);
 assert.match(role('You are an INDEPENDENT evaluator'),/Do not waive a requested change by relabeling it discovery/);
}

test('15 read-only candidates and an explicit pending choice do not require writes',async t=>{
 const f=await fixture(t,'Show 15 candidates; I will choose which one to save next.',(_input,step)=>
  step<=3?{calls:[{api:'search_catalog',args:{phase:['identity','genre','required page'][step-1]}}]}:
  {done:true,summary:'15 catalog candidates shown; choose one before saving.',entities:candidates,stats:[{label:'Candidates',value:'15'}]},input=>{
   const found=input.apiCalls.filter((c:any)=>c.api==='search_catalog'&&c.executionState==='succeeded').at(-1)?.response;
   return{pass:found?.length===15&&input.visibleEntities.length===15&&input.visibleSummary.includes('choose one before saving'),deficiencies:[]};
  });
 assert.deepEqual(f.operations.map(x=>x.id),['search_catalog','search_catalog','search_catalog']);
 assert.equal(f.output?.evaluation?.pass,true,'current discovery turn can complete without claiming the later save');
 assert.match(f.output!.summary,/choose one before saving/);assert.equal(f.output!.goal.targetCount,15);assertPolicies(f.prompts);
});

test('an explicit later selection performs one write followed by target readback',async t=>{
 const f=await fixture(t,'I select Candidate 1. Save that choice now.',(_input,step)=>
  step===1?{calls:[{api:'save_choice',args:{id:'1'}}]}:step===2?{calls:[{api:'read_saved',args:{id:'1'}}]}:
  {done:true,summary:'Candidate 1 saved and verified',entities:[candidates[0]]},input=>{
   const write=input.apiCalls.find((c:any)=>c.api==='save_choice'&&c.executionState==='succeeded');
   const read=input.apiCalls.find((c:any)=>c.api==='read_saved'&&c.executionState==='succeeded'&&c.order>write?.order&&c.response?.id==='1'&&c.response?.saved===true);
   return{pass:!!write&&!!read,deficiencies:read?[]:['Missing fresh saved-choice readback']};
  });
 assert.deepEqual(f.operations.map(x=>x.id),['save_choice','read_saved']);assert.equal(f.output?.evaluation?.pass,true);assertPolicies(f.prompts);
});

test('unsupported requested style remains a gap instead of being weakened to any match',async t=>{
 const f=await fixture(t,'Find 15 candidates with verified low acoustic energy.',(_input,step)=>
  step===1?{calls:[{api:'search_catalog',args:{style:'low acoustic energy'}}]}:
  {done:true,summary:'Candidates found, but acoustic energy is not verified.',entities:candidates,stats:[{label:'Candidates',value:'15'}]},input=>{
   const actual=input.apiCalls.find((c:any)=>c.api==='search_catalog')?.response;
   const verified=actual?.length===15&&actual.every((x:any)=>x.acousticEnergyCategory==='low');
   return{pass:!!verified,deficiencies:verified?[]:['Required low acoustic energy is unsupported by actual catalog evidence.']};
  });
 assert.equal(f.output?.evaluation?.pass,false);assert(f.operations.every(x=>x.id==='search_catalog'));
 assert.match(f.output!.evaluation!.deficiencies.join(' '),/acoustic energy/);assertPolicies(f.prompts);
});

test('a real requested write without post-write readback remains rejected even if mock evaluator approves',async t=>{
 const f=await fixture(t,'Save Candidate 1 now.',(_input,step)=>step===1?{calls:[{api:'save_choice',args:{id:'1'}}]}:
  {done:true,summary:'Candidate 1 saved',entities:[candidates[0]]},()=>({pass:true,deficiencies:[]}));
 assert.deepEqual(f.operations.map(x=>x.id),['save_choice'],'repair must not replay the confirmed write');
 assert.equal(f.output?.evaluation?.pass,false,'unchanged host readback gate rejects a permissive mock verdict');assertPolicies(f.prompts);
});
