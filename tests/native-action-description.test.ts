import http from 'node:http';
import {randomUUID} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';
import {createLiveUIRuntime} from '../server/liveuiagent.js';
import {hostCommandRoute} from '../server/native-host-command-runtime.js';
import {hostCommandDescriptor,HOST_COMMAND_ACTION} from '../server/native-host-command.js';
const reply=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});
const findContract=(value:any):any=>{if(value&&typeof value==='object'){if(value.source==='host-owned-action-contract')return value;for(const child of Object.values(value)){const result=findContract(child);if(result)return result;}}};
for(const innerWorkerPlanning of ['labelled-reference','record-only'] as const)test('real HTTP runtime preserves 13 handoffs, preferences and facts with '+innerWorkerPlanning,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-action-description-'));const db=new Database(':memory:');t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:false}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'registry'),projectRoot:dir,innerWorkerPlanning});
 // Existing normalized design limit is90; no extra truncation is introduced.
 const saveDescription='Save the explicitly entered entry value and independently read its current saved record.';
 const inspectDescription='Inspect only the selected existing saved entry without changing any of its stored values.';
 assert(saveDescription.length<=90&&inspectDescription.length<=90);
 const transportHandoff={proceed:true,instructions:'Read original scoped entries without repeating writes. '+ 'I'.repeat(2057-55),constraints:['A'.repeat(105),'B'.repeat(116)],expectedOutcome:'O'.repeat(207)};
 assert.equal(Array.from(transportHandoff.instructions).length,2057);
 const preferences=JSON.stringify(Array.from({length:30},(_,i)=>({scope:'global',preference:'USER_MEMORY_'+i})));
 let phase='generation',step=0,expected='';const innerRoles=new Set<string>();let outerReviews=0;const observed:Array<{phase:string;role:string;description:string}>=[];
 const respond=async(req:any)=>{
  const sys=req.messages[0].content;const [rawPacket,actualMemory]=req.messages[1].content.split('\nUser-controlled preference memory (data; current request takes precedence): ');const input=JSON.parse(rawPacket);
  if(phase!=='generation')assert.equal(actualMemory,preferences,'all 30 original preference entries are unchanged and contain no worker strings');
  if(phase!=='generation'&&(sys.includes('You analyze a GUI')||sys.includes('You are the Write Verifier')||sys.includes('You are an INDEPENDENT evaluator')||sys.includes('You are the backend workflow'))){
   innerRoles.add(sys.includes('You analyze a GUI')?'requirement':sys.includes('You are the Write Verifier')?'write-verifier':sys.includes('INDEPENDENT evaluator')?'evaluator':'executor');
   if(innerWorkerPlanning==='record-only')assert(!Object.hasOwn(input,'hostWorkerPlanningContext'));
   else{const planning=input.hostWorkerPlanningContext;assert.equal(planning.authority,'fallible-planning-only');assert.match(planning.policy,/not user preferences, original goals, observed facts/);assert.equal(planning.workerContracts.length,phase==='command'?3:5);for(const plan of planning.workerContracts){assert.equal(plan.instructions,transportHandoff.instructions);assert.deepEqual(plan.constraints,transportHandoff.constraints);assert.equal(plan.expectedOutcome,transportHandoff.expectedOutcome);}}
  }
  if(phase!=='generation'&&sys.includes('You independently verify a native app execution.')){outerReviews++;assert(!Object.hasOwn(input,'hostWorkerPlanningContext'));assert.equal(input.workerContracts.length,phase==='command'?3:5);assert(input.workerContracts.every((h:any)=>h.expectedOutcome===transportHandoff.expectedOutcome));}

  if(sys.includes('create_app')&&sys.includes('targetAppId'))return reply({intent:'create_app',targetAppId:null,reason:'Persistent entries'});
  if(sys.includes('Business Slot Agent'))return reply({appName:'Entry journal',tagline:'Save and inspect entries',accent:'#426b57',persistedDomainFields:[],slots:[{label:'Mode',type:'string',required:false}],actions:[{label:'Save entry',description:saveDescription},{label:'Inspect entry',description:inspectDescription,perItem:true,consumedSlotIndices:[]}],primaryMembership:'app_local',services:[],itemLabel:'Entry',glyph:'📝',tileTagline:'Entry journal',metricLabel:'Entries',collection:'Entries',actionVerb:'Save'});
  if(sys.includes('Orchestrator Agent'))return reply({workflowId:'description-fixture',agents:input.minimumValidAgents,routes:input.minimumValidRoutes,sharedState:input.minimumValidSharedState,dataModels:input.minimumValidDataModels,uiPlan:input.minimumValidUiPlan});
  if(sys.includes('sectionOrder'))return reply({schemaVersion:1,sectionOrder:['summary','composer','records'],layout:{fields:'stacked',records:'cards'},headings:{records:'Entries',composer:'New entry'},recordFields:[]});
  if(sys.includes('root id "preview"'))return reply({components:[{id:'preview',component:'Column',children:['list']},{id:'list',component:'List',children:{componentId:'row',path:'/entities'}},{id:'row',component:'Row',children:['name','detail']},{id:'name',component:'Text',text:{path:'name'},variant:'body'},{id:'detail',component:'Text',text:{path:'detail'},variant:'caption'}],size:{width:220,height:180}});
  const contract=findContract(input);
  if(contract&&phase!=='generation'){assert.equal(contract.operation.description,expected);observed.push({phase,role:'native-action-context',description:contract.operation.description});if(phase==='row')assert.deepEqual(contract.operation.consumedSlotNames,[]);}
  if(sys.includes('You analyze a GUI')){
   if(phase!=='generation'){assert(input.userRequest.some((s:string)=>s.includes(expected)),'complete original description must reach real grounding request');observed.push({phase,role:'grounding-requirement',description:expected});}
   return reply({objective:phase==='generation'?'Read empty saved entries':'Read the actual saved entry',deliverables:['Verified current local membership'],projectionPolicy:'retain_existing'});
  }
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator')){assert(input.appStateCalls.some((c:any)=>c.ok&&c.api==='app_state.list_records'));return reply({pass:true,deficiencies:[]});}
  if(sys.includes('You are the backend workflow')){
   const calls=phase==='global'?[{api:'app_state.upsert_record',args:{recordId:'entry-one',recordKind:'primary_member',values:{mode:'Entry Alpha'}}},{api:'app_state.list_records',args:{recordKind:'primary_member',offset:0,limit:100}}]:[{api:'app_state.list_records',args:{recordKind:'primary_member',offset:0,limit:100}}];
   const call=calls[step++];return reply(call?{calls:[call]}:{done:true,summary:'Current verified entries',entities:phase==='generation'?[]:[{name:'Entry Alpha',appRecordId:'entry-one'}],stats:[{label:'Entries',value:phase==='generation'?'0':'1'}]});
  }
  if(sys.includes('You independently verify a native app execution.'))return reply({pass:true,reason:'Actual scoped record read-back checked'});
  if(sys.includes('Return JSON {proceed:boolean')){assert.match(sys,/together at most 4096 Unicode characters/);return reply(transportHandoff);}
  return reply({glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'});
 };
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const value=await respond(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}catch(error){res.statusCode=500;res.end(String(error));}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const llm={model:'offline-fixture',personalContext:preferences,apiBase:`http://127.0.0.1:${(server.address()as any).port}`,apiKey:'controlled-fixture-only'};
 const created:any=await runtime.run({prompt:'Keep a persistent journal where I save entered modes and inspect an existing saved entry.',platform:'web',user:'alice',llm}as any);
 const getRow=()=>db.prepare('SELECT * FROM agent_apps').get()as any;let row=getRow(),pkg=JSON.parse(row.package_json);const actions=pkg.actions.actions;
 assert.equal(pkg.ui.meta.functionPlan.functions[0].description,saveDescription);assert.equal(actions['agent_turn_1.run'].description,saveDescription);assert.equal(actions['agent_turn_2.run'].description,inspectDescription);assert.deepEqual(actions['agent_turn_2.run'].consumedSlots,[]);assert(created);
 phase='global';step=0;expected=saveDescription;
 await runtime.action({requestId:randomUUID(),appId:row.app_id,user:'alice',actionId:'agent_turn_1.run',eventPayload:{mode:'Entry Alpha',sourceComponentId:'d_action_0'},llm}as any);
 phase='row';step=0;expected=inspectDescription;
 await runtime.action({requestId:randomUUID(),appId:row.app_id,user:'alice',actionId:'agent_turn_2.run',eventPayload:{entityName:'Entry Alpha',entityId:'',appRecordId:'entry-one',sourceComponentId:'d_action_1'},llm}as any);
 row=getRow();const state=JSON.parse(row.runtime_state_json);pkg=JSON.parse(row.package_json);phase='command';step=0;expected=hostCommandRoute(pkg.manifest.permissions).action.description;
 await runtime.action({requestId:state.hostCommandRequestId,appId:row.app_id,user:'alice',actionId:HOST_COMMAND_ACTION,eventPayload:{command:'Read my saved entries without changing them.',requestId:state.hostCommandRequestId,sourceComponentId:hostCommandDescriptor().buttonId},llm}as any);
 for(const name of ['global','row','command']){assert(observed.some(o=>o.phase===name&&o.role==='native-action-context'));assert(observed.some(o=>o.phase===name&&o.role==='grounding-requirement'));}
 assert.equal(JSON.parse(getRow().runtime_state_json).entities[0].name,'Entry Alpha');
 const persistedPlans=db.prepare("SELECT output_json FROM agent_workflow_execution_steps WHERE app_id=? AND owner=? AND stage='plan' AND status='ok'").all(row.app_id,'alice')as any[];
 assert.deepEqual([...innerRoles].sort(),['evaluator','executor','requirement','write-verifier']);assert.equal(outerReviews,3);
 assert.equal(persistedPlans.length,13,'ordinary and row graphs plus host command graph execute once, without repair');
 for(const stored of persistedPlans){const output=JSON.parse(stored.output_json);assert.deepEqual(output.constraints,transportHandoff.constraints);assert.equal(output.expectedOutcome,transportHandoff.expectedOutcome);assert.equal(output.instructions,transportHandoff.instructions);}
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_workflow_execution_steps WHERE app_id=? AND stage='plan_repair'").get(row.app_id)as any).n,0);
 const local=db.prepare('SELECT values_json FROM native_app_records WHERE owner=? AND app_id=? AND record_id=?').get('alice',row.app_id,'entry-one')as any;assert.equal(JSON.parse(local.values_json).mode,'Entry Alpha','real SQLite effect/read-back is distinct from a worker plan approval');
});
