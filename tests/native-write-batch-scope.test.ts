import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

for(const mode of ['complete','extra_target','missing_prerequisite','incomplete','atomic'] as const)test(`bounded write safety with real local HTTP: ${mode}`,async t=>{
 const target='owned-collection';const items=new Set<number>();let readSeen=false,decision=0,verifierCalls=0;const dispatches:any[]=[];const packets:any[]=[];const scopes:any[]=[];
 const tools=['read_collection','append_item'].map(api=>({id:api,apiName:api,permission:api,appName:'collection',method:api==='append_item'?'POST':'GET',purpose:api}));
 const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
 const add=(i:number)=>({api:'append_item',args:{collection_id:target,item_id:i}});
 const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);const system=request.messages[0].content;const p=JSON.parse(request.messages[1].content);packets.push(p);let value:any;
 if(system.includes('You analyze a GUI'))value={objective:'Append the twenty explicitly authorized items, then display the complete collection',targetCount:20,deliverables:['Twenty items in the actual owned collection'],projectionPolicy:'retain_existing'};
 else if(system.includes('You are the Write Verifier')){
  verifierCalls++;scopes.push(p.batchScope);assert.match(system,/A finite batch need not complete the entire goal/);assert.match(system,/atomic\/all-or-nothing/);
  assert.equal(p.batchScope.source,'host-selected-dispatch-batch');assert.equal(p.batchScope.selectedCallCount,p.proposedCalls.length);assert(p.proposedCalls.length<=10);assert.equal(p.batchScope.completionClaim,false);assert.equal(p.batchScope.grantsAdditionalAuthority,false);
  const safe=mode!=='atomic'&&readSeen&&p.proposedCalls.every((c:any)=>c.args.collection_id===target&&Number.isInteger(c.args.item_id)&&c.args.item_id>=1&&c.args.item_id<=20);
  value=safe?{approved:true}:{approved:false,reject:true,reason:'Unsafe target, missing actual prerequisite or explicit atomic scope'};
 }else if(system.includes('You are an INDEPENDENT evaluator')){
  const last=p.apiCalls.filter((c:any)=>c.api==='read_collection').at(-1);const complete=items.size===20&&last?.response.items.length===20;
  value={pass:complete,deficiencies:complete?[]:['The full twenty-item goal is not complete from fresh evidence']};
 }else{
  decision++;
  if(mode==='complete')value=decision===1?{calls:[{api:'read_collection',args:{collection_id:target}}]}:decision===2?{calls:Array.from({length:20},(_,i)=>add(i+1))}:decision===3?{calls:Array.from({length:10},(_,i)=>add(i+11))}:decision===4?{calls:[{api:'read_collection',args:{collection_id:target}}]}:{done:true,summary:'Twenty actual items saved',entities:[{name:'Owned collection',id:target}],stats:[{label:'Items',value:'20'}]};
  else if(decision===1&&mode==='missing_prerequisite')value={calls:[add(1)]};
  else if(decision===1)value={calls:[{api:'read_collection',args:{collection_id:target}}]};
  else if(decision===2)value={calls:mode==='extra_target'?[{api:'append_item',args:{collection_id:'other-owner',item_id:1}}]:[add(1)]};
  else if(decision===3)value={calls:[{api:'read_collection',args:{collection_id:target}}]};
  else value={done:true,summary:'Partial result only',entities:[{name:'Owned collection',id:target}],stats:[{label:'Items',value:String(items.size)}]};
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply(value)));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{dispatches.push({api,args});if(api==='append_item'){assert(readSeen);assert.equal(args.collection_id,target);items.add(args.item_id);}else readSeen=true;return{tool:tools.find(x=>x.id===api),request:args,response:api==='read_collection'?{id:target,items:[...items].map(id=>({id,name:`Item ${id}`}))}:{saved:true},dbChanges:null};}};
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:`Append items 1 through 20 to my owned collection after reading it.${mode==='atomic'?' Perform this atomically, all-or-nothing.':''}`},appName:'Collection',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address()as any).port}/v1`,model:'fixture'}});
 assert(verifierCalls>0);assert.equal(result?.evaluation?.pass,mode==='complete');
 if(mode==='complete'){assert.equal(items.size,20);assert.equal(dispatches.filter(x=>x.api==='append_item').length,20);assert.equal(dispatches.at(-1).api,'read_collection');assert.equal(verifierCalls,2);assert.deepEqual(scopes.map(x=>[x.proposedCallCount,x.selectedCallCount,x.omittedTailCallCount]),[[20,10,10],[10,10,0]]);}
 if(mode==='extra_target'||mode==='atomic')assert.equal(items.size,0);
 if(mode==='missing_prerequisite')assert.equal(dispatches[0].api,'read_collection','rejected proposal never dispatches before an actual read');
 if(mode==='incomplete')assert.equal(items.size,1,'safe partial progress is not misreported as full success');
});
