import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

for(const mode of ['complete','extra_target','missing_prerequisite','incomplete','atomic','quantity_overrun'] as const)test(`bounded write safety with real local HTTP: ${mode}`,async t=>{
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
  assert.match(system,/proposed incremental delta/);
  const prior=new Set(p.previousCalls.filter((c:any)=>c.ok===true&&c.api==='append_item').map((c:any)=>c.request.item_id));
  const safe=mode!=='atomic'&&readSeen&&p.proposedCalls.length<=20-prior.size&&p.proposedCalls.every((c:any)=>c.args.collection_id===target&&Number.isInteger(c.args.item_id)&&c.args.item_id>=1&&c.args.item_id<=20);
  value=safe?{approved:true}:{approved:false,reject:true,reason:'Unsafe target, missing actual prerequisite or explicit atomic scope'};
 }else if(system.includes('You are an INDEPENDENT evaluator')){
  const last=p.apiCalls.filter((c:any)=>c.api==='read_collection').at(-1);const complete=items.size===20&&last?.response.items.length===20;
  value={pass:complete,deficiencies:complete?[]:['The full twenty-item goal is not complete from fresh evidence']};
 }else{
  decision++;
  if(mode==='complete'||mode==='quantity_overrun')value=decision===1?{calls:[{api:'read_collection',args:{collection_id:target}}]}:decision===2?{calls:Array.from({length:20},(_,i)=>add(i+1))}:decision===3?{calls:Array.from({length:10},(_,i)=>add(i+11))}:decision===4&&mode==='quantity_overrun'?{calls:[add(21)]}:decision===(mode==='quantity_overrun'?5:4)?{calls:[{api:'read_collection',args:{collection_id:target}}]}:{done:true,summary:'Twenty actual items saved',entities:[{name:'Owned collection',id:target}],stats:[{label:'Items',value:'20'}]};
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
 assert(verifierCalls>0);assert.equal(result?.evaluation?.pass,mode==='complete'||mode==='quantity_overrun');
 if(mode==='quantity_overrun'){assert.equal(items.size,20);assert.equal(verifierCalls,3);assert.equal(dispatches.filter(x=>x.api==='append_item').length,20);assert(!items.has(21));}
 if(mode==='complete'){assert.equal(items.size,20);assert.equal(dispatches.filter(x=>x.api==='append_item').length,20);assert.equal(dispatches.at(-1).api,'read_collection');assert.equal(verifierCalls,2);assert.deepEqual(scopes.map(x=>[x.proposedCallCount,x.selectedCallCount,x.omittedTailCallCount]),[[20,10,10],[10,10,0]]);}
 if(mode==='extra_target'||mode==='atomic')assert.equal(items.size,0);
 if(mode==='missing_prerequisite')assert.equal(dispatches[0].api,'read_collection','rejected proposal never dispatches before an actual read');
 if(mode==='incomplete')assert.equal(items.size,1,'safe partial progress is not misreported as full success');
});

test('current explicit page is a read-only view, not deletion of the saved universe',async t=>{
 const saved=Array.from({length:40},(_,i)=>({id:String(i+1),name:`Item ${i+1}`}));let step=0;const reads:any[]=[];let requirementSeen=false;
 const tools=[{id:'read_page',apiName:'read_page',permission:'read_page',appName:'collection',method:'GET',purpose:'Read an ordered page without changing collection'}];
 const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const wire=JSON.parse(text),system=wire.messages[0].content,p=JSON.parse(wire.messages[1].content);let value:any;
  if(system.includes('You analyze a GUI')){requirementSeen=true;assert.match(system,/does not delete or replace the real saved collection/);assert.match(system,/Do not require every member/);value={objective:'Display the first requested page, preserving the saved collection',targetCount:25,deliverables:['The requested visible page'],projectionPolicy:'replace_or_filter'};}
  else if(system.includes('You are an INDEPENDENT evaluator')){assert.equal(p.apiCalls.length,2);assert.equal(p.visibleEntities.length,25);value={pass:true,deficiencies:[]};}
  else{step++;value=step===1?{calls:[{api:'read_page',args:{offset:0,limit:20}},{api:'read_page',args:{offset:20,limit:20}}]}:{done:true,summary:'Showing the first 25 of 40 saved items; no items deleted',entities:saved.slice(0,25),stats:[{label:'Shown',value:'25'}]};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{assert.equal(api,'read_page');reads.push(args);return{tool:tools[0],request:args,response:saved.slice(args.offset,args.offset+args.limit),dbChanges:null};}};
 const result=await runAppWorldGrounding({bridge,permissions:['read_page'],payload:{command:'Show the first 25 of my 40 saved items, without changing the saved collection.'},appName:'Saved collection',priorProjection:{entities:saved,stats:[]},llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address()as any).port}/v1`,model:'fixture'}});
 assert(requirementSeen);assert.equal(result?.evaluation?.pass,true);assert.equal(result?.entities.length,25);assert.equal(saved.length,40);assert.equal(reads.length,2);assert.equal(result?.calls.length,2);
});

test('one named update preserves sibling values and later repair consumes the same successful baseline',async t=>{
 const rows=[{id:'a',name:'Alpha',value:1},{id:'b',name:'Beta',value:2}];let step=0,writes=0;let baselineSeen=false;
 const tools=['read_rows','update_row'].map(api=>({id:api,apiName:api,permission:api,appName:'collection',method:api==='read_rows'?'GET':'POST',purpose:api}));
 const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const wire=JSON.parse(text),system=wire.messages[0].content,p=JSON.parse(wire.messages[1].content);let value:any;
 if(system.includes('You analyze a GUI'))value={objective:'Update only Alpha to the submitted value',targetCount:1,deliverables:['Alpha updated and siblings unchanged'],projectionPolicy:'retain_existing'};
 else if(system.includes('You are the Write Verifier')){const successes=p.previousCalls.filter((c:any)=>c.ok&&c.api==='update_row');if(successes.length){baselineSeen=true;assert.equal(successes[0].request.id,'a');assert.match(system,/When updating one target, preserve siblings/);}value=p.proposedCalls.every((c:any)=>c.args.id==='a')&&!successes.length?{approved:true}:{approved:false,reject:true,reason:'Current request does not authorize the sibling or another completed update'};}
 else if(system.includes('You are an INDEPENDENT evaluator'))value={pass:rows[0].value===0&&rows[1].value===2,deficiencies:[]};
 else{step++;value=step===1?{calls:[{api:'read_rows',args:{}}]}:step===2?{calls:[{api:'update_row',args:{id:'a',value:0}}]}:step===3?{calls:[{api:'update_row',args:{id:'b',value:0}}]}:step===4?{calls:[{api:'read_rows',args:{}}]}:{done:true,summary:'Alpha updated; Beta unchanged',entities:rows.map(x=>({id:x.id,name:x.name})),stats:[{label:'Updated',value:'1'}]};}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{if(api==='update_row'){writes++;rows.find(x=>x.id===args.id)!.value=args.value;}return{tool:tools.find(x=>x.id===api),request:args,response:structuredClone(rows),dbChanges:null};}};
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{command:'Set only Alpha to 0; leave Beta unchanged.'},appName:'Values',targetEntity:{id:'a',name:'Alpha'},llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address()as any).port}/v1`,model:'fixture'}});
 assert.equal(result?.evaluation?.pass,true);assert(baselineSeen);assert.equal(writes,1);assert.deepEqual(rows.map(x=>x.value),[0,2]);
});
