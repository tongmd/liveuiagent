import {randomUUID} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';
import {createLiveUIRuntime} from '../server/liveuiagent.js';
import {hostCommandRoute} from '../server/native-host-command-runtime.js';
import {hostCommandDescriptor,HOST_COMMAND_ACTION} from '../server/native-host-command.js';
const reply=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});
const findContract=(value:any):any=>{if(value&&typeof value==='object'){if(value.source==='host-owned-action-contract')return value;for(const child of Object.values(value)){const result=findContract(child);if(result)return result;}}};
test('real plan installation preserves descriptions through ordinary, per-item and host-command runtime context and grounding',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-action-description-'));const db=new Database(':memory:');t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:false}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'registry'),projectRoot:dir});
 // Existing normalized design limit is90; no extra truncation is introduced.
 const saveDescription='Save the explicitly entered entry value and independently read its current saved record.';
 const inspectDescription='Inspect only the selected existing saved entry without changing any of its stored values.';
 assert(saveDescription.length<=90&&inspectDescription.length<=90);
 let phase='generation',step=0,expected='';const observed:Array<{phase:string;role:string;description:string}>=[];
 const llm={model:'offline-fixture',chatCompletion:async(req:any)=>{
  const sys=req.messages[0].content;const input=JSON.parse(req.messages[1].content.split('\n')[0]);
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
  if(sys.includes('independently verify'))return reply({pass:true,reason:'Actual scoped record read-back checked'});
  if(sys.includes('Return JSON {proceed:boolean'))return reply({proceed:true,instructions:'Use actual local record reads for this operation',constraints:[],expectedOutcome:'Verified saved entries'});
  return reply({glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'});
 }};
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
});
