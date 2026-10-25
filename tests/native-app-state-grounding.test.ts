import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import Database from 'better-sqlite3';
import {runAppWorldGrounding,createLiveUIRuntime} from '../server/liveuiagent.js';
import {createAppStateAdapter,hydrateAppState} from '../server/native-app-state.js';
import {AppWorldRequestNotStartedError} from '../server/appworld-request-error.js';
import {withActionDeadline} from '../server/action-deadline.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
async function runtimeFixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-primary-list-'));const db=new Database(':memory:');
 const server=http.createServer((req,res)=>{const route=new URL(req.url!,'http://fixture').pathname;let value:any;
  if(route==='/api_docs/app_descriptions')value=[{name:'inventory',description:'Fixture inventory'}];
  else if(route==='/inventory/openapi.json')value={openapi:'3.1.0',paths:{'/items':{get:{operationId:'read_items',summary:'Read current parcels',responses:{'200':{description:'Current parcel list'}}}}}};
  else if(route==='/inventory/items')value=[{id:'parcel42',name:'Parcel42'}];
  else if(route==='/dbs')value={inventory:dir};else if(route==='/dbs/save')value={message:'saved'};else{res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address()as any).port}`;
 const previous=Object.fromEntries(['APPWORLD_ENABLED','APPWORLD_API_BASE','APPWORLD_SNAPSHOT_ROOT','LIVEUIAGENT_APPWORLD_GROUNDING'].map(k=>[k,process.env[k]]));process.env.APPWORLD_ENABLED='true';process.env.APPWORLD_API_BASE=base;process.env.APPWORLD_SNAPSHOT_ROOT=path.join(dir,'snapshots');delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
 t.after(async()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:true,apiBase:base,snapshotRoot:path.join(dir,'snapshots'),apps:['inventory']}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:dir});const chain=['agents.orchestrator','agents.action','agents.app','agents.data','agents.memory'];const handoffs=chain.slice(1).map((to,i)=>({from:chain[i],to,payload:'Verified context',reason:'Next role'}));const route={id:'refresh',entryActionId:'actions.refresh.run',agentChain:chain,handoffs,label:'Refresh',description:'Read current parcels'};
 const interaction={focus:'Parcels',resultFocus:'Current parcels',primaryFieldName:'subject',secondaryFieldName:'scope',businessFields:[{name:'subject',label:'Parcel subject',type:'string'},{name:'scope',label:'Parcel scope',type:'string'},{name:'filter',label:'Parcel filter',type:'string'}],historyTitle:'Parcels',inputTitle:'Parcels',inputDescription:'Read current parcels',primaryText:'Parcel',secondaryText:'Details',outcomeLabel:'Parcels',resultSectionLabels:['Parcels']};
 const tree=[{id:'overview',component:'Column',children:['subject','scope','filter','go','result','list']},...['subject','scope','filter'].map(n=>({id:n,component:'TextField',label:'Parcel '+n,value:{path:'/draft/slots/'+n}})),{id:'go',component:'Button',child:'goText',action:{event:{name:'refresh.run'}}},{id:'goText',component:'Text',text:'Refresh'},{id:'result',component:'Text',text:{path:'/draft/result'}},{id:'list',component:'List',children:{componentId:'item',path:'/entities'}},{id:'item',component:'Column',children:['name','detail','inspect']},{id:'name',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}},{id:'inspect',component:'Button',child:'inspectText',action:{event:{name:'inspect.run'}}},{id:'inspectText',component:'Text',text:'Inspect parcel'}];
 const orchestration={plannedBy:'orchestrator-agent',workflowId:'parcels',routes:[route]};const pkg={manifest:{appId:'parcels',name:'Parcels',description:'Read parcels',version:'1',intent:{visualObjects:['parcel'],itemLabel:'parcel',presentation:{collection:'Dispatches'}}},actions:{actions:{'refresh.run':{id:'refresh.run',label:'Refresh',description:'Read current parcels',permissions:['tool.appworld.inventory.read_items','storage.app','app_state.write'],agent:chain[0],agentChain:chain,handoffs,orchestrationRouteId:'refresh',steps:[]},'inspect.run':{id:'inspect.run',label:'Inspect parcel',perItem:true,consumedSlots:[]}}},agents:{agents:Object.fromEntries(chain.map(id=>[id,{id,role:id.split('.')[1],purpose:'Execute assigned role'}]))},memory:{defaultState:{}},proposal:{},assets:{icon:{svg:'<svg/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},dataSchema:{dataSources:{records:{model:'parcel'}},models:{parcel:{fields:[{name:'prompt',label:'Parcel'},{name:'context',label:'Details'}]}}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:tree}},orchestration};
 const state={sourcePrompt:'Read the actual current parcels',subject:'Parcels',functionSignature:'parcel_fixture',interaction,orchestration,intentResult:{title:'Parcels',value:'Parcels',subtitle:'Previously observed parcel',sections:[],bullets:[]},intentActionCount:0,recentActions:[],entities:[{id:'old-1',name:'Old parcel',detail:'Previously observed'}],entityStats:[{label:'Parcels',value:'1'}]};
 const data={records:[{id:'turn1',prompt:'Read parcels',context:'Current parcels',state:'open',nextStep:'Refresh',result:'Previous parcels',subject:'Current parcels',scope:'All',filter:'All'}]};
 const reset=()=>db.prepare('INSERT OR REPLACE INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('parcels','Parcels','Read parcels',JSON.stringify(pkg),JSON.stringify(data),JSON.stringify(state),'1','fixture-owner');reset();return{runtime,reset,db,stored:()=>db.prepare('SELECT runtime_state_json FROM agent_apps WHERE app_id=?').get('parcels')as any};
}


test('actual runtime persists local values with independent receipts and reads them into same row on reopen',async t=>{
 const f=await runtimeFixture(t);let step=0;const prompts:any[]=[];
 const chatCompletion=async(request:any)=>{const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split('\n')[0]);prompts.push({sys,input});
  if(sys.includes('You analyze a GUI'))return reply({objective:'Read Parcel42 and save its local target preference'});
  if(sys.includes('You are the Write Verifier')){assert.deepEqual(input.proposedCalls,[{api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'parcel42',values:{subject:'Parcel42',filter:'249'}}}]);assert.equal(input.appStateCapabilities.find((c:any)=>c.apiName==='app_state.upsert_record').source,'app-state');return reply({approved:true});}
  if(sys.includes('You are an INDEPENDENT evaluator')){assert.equal(input.apiCalls.filter((c:any)=>c.ok).length,1);assert.equal(input.appStateCalls.filter((c:any)=>c.ok).length,2);assert.equal(input.appStateCalls[1].response.record.values.filter,'249');return reply({pass:true,deficiencies:[]});}
  if(sys.includes('You are the backend workflow')){step++;return reply(step===1?{calls:[{api:'read_items',args:{}}]}:step===2?{calls:[{api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'parcel42',values:{subject:'Parcel42',filter:'249'}}}]}:step===3?{calls:[{api:'app_state.read_record',args:{recordId:'parcel42'}}]}:{done:true,summary:'Parcel42 target preference saved as 249',entities:[{id:'parcel42',name:'Parcel42',detail:'Local target 249',appRecordId:'parcel42'}],stats:[{label:'Tracked',value:'1'}]});}
  return reply(sys.includes('independently verify')?{pass:true,reason:'Actual service read plus local persisted target readback'}:{proceed:true,instructions:'Read service and persist requested local preference',constraints:[],expectedOutcome:'Actual local target saved'});
 };
 const action=await f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Parcel42',scope:'All',filter:'249'},llm:{model:'fixture-only',chatCompletion}}as any);
 assert.equal((action as any).runtimeState.entities[0].appState.filter,'249');assert.equal((action as any).runtimeState.entities[0].appRecordId,'parcel42');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_app_records').get().n,1);
 const locals=Object.values((action as any).toolResults).filter((v:any)=>v.source==='app-state');assert.equal(locals.length,2);assert.deepEqual((action as any).toolDbChanges,[],'local persistence must not masquerade as external DB changes');
 const reopen=await f.runtime.queryState({user:'fixture-owner'});assert.equal(reopen.apps[0].runtimeState.entities[0].appState.filter,'249');assert.equal(reopen.apps[0].appPackage.ui.meta.a2ui.initialData.entities[0].appState.filter,'249');assert.equal(reopen.apps[0].appPackage.ui.meta.a2ui.initialData.appRecords[0].recordId,'parcel42');
 f.db.prepare('UPDATE native_app_records SET values_json=?').run(JSON.stringify({subject:'Parcel42',filter:'199'}));
 const reread=await f.runtime.queryState({user:'fixture-owner'});assert.equal(reread.apps[0].runtimeState.entities[0].appState.filter,'199','query-state reads real local table, not cached history');
 assert.equal((await f.runtime.queryState({user:'other-owner'})).apps.length,0);
 assert.ok(prompts.some(p=>p.sys.includes('INDEPENDENT evaluator')));
});

test('local permission boundary is owner/app bound and cannot escalate read-only storage',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('one','alice');
 const fields=[{name:'target',type:'number'}];assert.equal(createAppStateAdapter(db,'alice','one',fields,[]),undefined);assert.equal(createAppStateAdapter(db,'alice','one',fields,['app_state.write']),undefined);
 const read=createAppStateAdapter(db,'alice','one',fields,['storage.app'])!;assert.equal(read.capabilities.length,2);assert.throws(()=>read.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'x',values:{target:2}}),/Unauthorized/);
 const write=createAppStateAdapter(db,'alice','one',fields,['storage.app','app_state.write'])!;assert.throws(()=>write.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'x',values:{target:2},owner:'bob'}),/cannot select/);
 write.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'x',values:{target:2}});assert.equal((write.call('app_state.read_record',{recordId:'x'}) as any).record.values.target,2);
 db.transaction(()=>{assert.throws(()=>write.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'nested',values:{target:3}}),/autocommit/);assert.throws(()=>createAppStateAdapter(db,'alice','one',fields,['storage.app','app_state.write']),/autocommit/);})();
 assert.equal((write.call('app_state.read_record',{recordId:'nested'}) as any).record,null);
 const other=createAppStateAdapter(db,'bob','one',fields,['storage.app','app_state.write'])!;assert.throws(()=>other.call('app_state.read_record',{recordId:'x'}),/scope is unavailable/);db.close();
});

for(const mode of ['complete','external_read_missing','local_read_missing','wrong_local_read','schema_failure','unknown_after_commit','deadline_after_commit','local_only'] as const)test(`separate store evidence and partial effects: ${mode}`,async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('one','alice');
 const real=createAppStateAdapter(db,'alice','one',[{name:'target',type:'number'}],['storage.app','app_state.write'])!;let localDispatches=0;const adapter={...real,call(api:string,args:any){localDispatches++;const result=real.call(api,args);if(api==='app_state.upsert_record'&&mode==='unknown_after_commit')throw Error('Injected lost reply after actual commit');if(api==='app_state.upsert_record'&&mode==='deadline_after_commit')return new Promise(resolve=>setTimeout(()=>resolve(result),120));return result;}};
 const tools=['create_external','read_external'].map(api=>({id:api,apiName:api,permission:api,appName:'service',method:api==='create_external'?'POST':'GET',purpose:api}));const external:string[]=[];let step=0;
 const bridge:any={getCapabilities:async()=>mode==='local_only'?[]:tools,callTool:async(api:string,args:any)=>{external.push(api);return{tool:tools.find(t=>t.id===api),request:args,response:{id:'x',name:'External X'},dbChanges:null}}};
 const plan=[...(mode==='local_only'?[]:[{api:'create_external',args:{}}]),{api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'x',values:{target:mode==='schema_failure'?'invented':25}}},...(mode==='unknown_after_commit'?[{api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'x',values:{target:25}}}]:[]),...(mode==='local_read_missing'?[]:[{api:'app_state.read_record',args:{recordId:mode==='wrong_local_read'?'other':'x'}}]),...(mode==='external_read_missing'||mode==='local_only'?[]:[{api:'read_external',args:{}}])];
 const run=()=>runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),appState:adapter,appName:'Preferences',payload:{request:'Persist actual local target for X'},llm:{model:'fixture-only',chatCompletion:async(request:any)=>{const sys=request.messages[0].content;
  if(sys.includes('You analyze a GUI'))return reply({objective:'Persist actual local target; external mutation also requested unless local-only'});
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:true,deficiencies:[]});
  return reply(step<plan.length?{calls:[plan[step++]]}:{done:true,summary:'Actual local preference for X',entities:[{name:mode==='local_only'?'Local X':'External X',id:'x',appRecordId:'x'}],stats:[{label:'Target',value:'25'}]});
 }}});
 const result=mode==='deadline_after_commit'?await withActionDeadline(Date.now()+70,run):await run();
 assert.equal(external.filter(api=>api==='create_external').length,mode==='local_only'?0:1,'real external mutation receipt must not be lost or replayed');
 assert.equal(result?.calls.filter(c=>c.tool.apiName==='create_external').length,mode==='local_only'?0:1);
 assert.equal(result?.evaluation?.pass,mode==='complete'||mode==='local_only');
 if(mode==='external_read_missing')assert.match(result!.evaluation!.deficiencies.join('\n'),/read-back/);
 if(mode==='wrong_local_read')assert.match(result!.evaluation!.deficiencies.join('\n'),/exact subsequent read-back/);
 if(mode==='local_read_missing')assert.match(result!.evaluation!.deficiencies.join('\n'),/app-state write lacks/);
 if(mode==='schema_failure')assert.equal((real.call('app_state.read_record',{recordId:'x'}) as any).record,null);
 else assert.equal((real.call('app_state.read_record',{recordId:'x'}) as any).record.values.target,25);
 if(mode==='unknown_after_commit'||mode==='deadline_after_commit'){assert.equal(result!.appStateExecutionEvidence.unknownDispatchOutcomes,1);assert.equal((real.call('app_state.read_record',{recordId:'x'}) as any).record.revision,1,'unknown dispatch must never cause another local write');}
 if(mode==='deadline_after_commit')assert.equal(result?.deadlineExceeded,true);
 if(mode==='complete'){assert.deepEqual(result!.attempts.filter(c=>c.ok===true&&c.api!=='(write-verifier)').map(c=>c.order),[1,4]);assert.deepEqual(result!.appStateCalls.map(c=>c.order),[2,3]);assert.equal(result?.executionEvidence?.successfulApiCalls,2);assert.equal(result?.appStateExecutionEvidence.successfulCalls,2);assert.equal(result?.appStateCalls.every(c=>c.source==='app-state'),true);}
 if(mode==='local_only'){assert.equal(result?.calls.length,0);assert.equal(result?.executionEvidence?.successfulApiCalls,0);assert.equal(result?.appStateExecutionEvidence.successfulCalls,2);}
 db.close();
});

for(const scenario of ['local_unknown','external_unknown','local_get_failure','external_get_failure','trusted_preflight'] as const)test(`per-dispatch mixed batch write lock: ${scenario}`,async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('one','alice');
 const real=createAppStateAdapter(db,'alice','one',[{name:'target',type:'number'}],['storage.app','app_state.write'])!;
 const localOps:string[]=[],externalOps:string[]=[];let injected=false,externalEffects=0,localEffects=0,step=0;
 const adapter={...real,call(api:string,args:any){localOps.push(api);if(scenario==='local_get_failure'&&api==='app_state.read_record'&&!injected){injected=true;throw Error('Injected read failure');}const result=real.call(api,args);if(api==='app_state.upsert_record'){localEffects++;if(scenario==='local_unknown'&&!injected){injected=true;throw Error('Reply lost after local commit');}}return result;}};
 const tools=['create_external','read_external'].map(api=>({id:api,apiName:api,permission:api,source:'appworld',appName:'service',method:api==='create_external'?'POST':'GET',purpose:api}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{externalOps.push(api);if(api==='read_external'&&scenario==='external_get_failure'&&!injected){injected=true;throw Error('Read reply lost');}if(api==='create_external'){if(scenario==='trusted_preflight'&&!injected){injected=true;throw new AppWorldRequestNotStartedError(Error('Trusted validation stopped before dispatch'));}externalEffects++;if(scenario==='external_unknown'&&!injected){injected=true;throw Error('Reply lost after external mutation');}}return{tool:tools.find(t=>t.id===api),request:args,response:{id:'x',name:'External X'},dbChanges:null};}};
 const localWrite={api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'x',values:{target:25}}};const externalWrite={api:'create_external',args:{name:'External X'}};const localRead={api:'app_state.read_record',args:{recordId:'x'}};const externalRead={api:'read_external',args:{}};
 const first=scenario==='local_unknown'?[localWrite,externalWrite,localWrite,externalRead,localRead]:scenario==='external_unknown'?[externalWrite,localWrite,externalWrite,externalRead,localRead]:scenario==='local_get_failure'?[localRead,externalWrite,localWrite,externalRead,localRead]:scenario==='external_get_failure'?[externalRead,externalWrite,localWrite,externalRead,localRead]:[externalWrite,localWrite,externalWrite,externalRead,localRead];
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),appState:adapter,appName:'Mixed calls',payload:{request:'Perform original service operation and persist local target'},llm:{model:'fixture-only',chatCompletion:async(request:any)=>{const sys=request.messages[0].content;
  if(sys.includes('You analyze a GUI'))return reply({objective:'Original service operation plus actual local preference'});
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:true,deficiencies:[]});
  step++;return reply(step===1?{calls:first}:step===2&&scenario.endsWith('_unknown')?{calls:[externalWrite,localWrite,externalRead,localRead]}:{done:true,summary:'Actual evidence only',entities:[{name:'External X',id:'x'}],stats:[]});
 }}});
 if(scenario==='local_unknown'||scenario==='external_unknown'){
  assert.equal(localEffects,scenario==='local_unknown'?1:0);assert.equal(externalEffects,scenario==='external_unknown'?1:0);
  assert.equal(result?.evaluation?.pass,false);assert.match(result!.evaluation!.deficiencies.join('\n'),/mutation outcome unknown/);
  assert.ok(result!.appStateCalls.some(c=>c.dispatchBlocked===true));assert.ok(result!.attempts.some(c=>c.dispatchBlocked===true));
  assert.ok(localOps.includes('app_state.read_record'));assert.ok(externalOps.includes('read_external'),'reads after unknown write remain allowed within the SAME batch and later steps');
  assert.equal(result!.appStateExecutionEvidence.unknownWriteOutcomes,scenario==='local_unknown'?1:0);assert.equal(result!.executionEvidence!.unknownWriteOutcomes,scenario==='external_unknown'?1:0);
  assert.equal((real.call('app_state.read_record',{recordId:'x'}) as any).record?.revision,scenario==='local_unknown'?1:undefined);
  assert.equal(result!.calls.filter(c=>c.tool.apiName==='create_external').length,0,'unknown response must never be reported as successful, even when actual effect exists');
 }else{
  assert.equal(localEffects,1);assert.equal(externalEffects,1);assert.equal(result!.appStateExecutionEvidence.unknownWriteOutcomes,0);assert.equal(result!.executionEvidence!.unknownWriteOutcomes,0);
  assert.equal(result!.attempts.some(c=>c.dispatchBlocked===true),false,'GET errors and trusted not-started errors are not mutation-unknown authorization blocks');
  if(scenario==='trusted_preflight'){assert.equal(result!.executionEvidence!.notStartedApiCalls,1);assert.equal(result!.executionEvidence!.unknownDispatchOutcomes,0);}
 }
 db.close();
});

test('actual worker callback factors only model-wire plan packet and records private receipt while raw workflow input stays full',async t=>{
 const f=await runtimeFixture(t);const evidence={call:{api:'actual-read',request:{page:0},response:{body:'z'.repeat(10000),amount:0.01}}};const state=JSON.parse(f.stored().runtime_state_json);state.lastActionPayload={toolResults:evidence};const data={agent_turns:[{toolResults:structuredClone(evidence),unique:'preserved'}]};f.db.prepare('UPDATE agent_apps SET runtime_state_json=?,data_json=? WHERE app_id=?').run(JSON.stringify(state),JSON.stringify(data),'parcels');let wire:any;let system='';
 await assert.rejects(f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Read parcels'},llm:{model:'fixture',chatCompletion:async(request:any)=>{system=request.messages[0].content;wire=JSON.parse(request.messages[1].content);throw Error('fixture-stop-before-any-business');}}}as any),/fixture-stop/);
 assert(system.includes('hostPlanEvidenceFactorization'));assert.equal(wire.assignedWorker.id,'agents.orchestrator');assert.equal(wire.hostPlanEvidenceFactorization.aliases.length,1);assert.deepEqual(wire.context.currentState.lastActionPayload.toolResults,evidence);
 const raw=f.db.prepare("SELECT input_json FROM agent_workflow_execution_steps WHERE stage='plan' AND status='running' LIMIT 1").get()as any;const original=JSON.parse(raw.input_json);assert.deepEqual(original.context.records.agent_turns[0].toolResults,evidence);assert.equal(original.hostPlanEvidenceFactorization,undefined);
 const recorded=f.db.prepare("SELECT output_json FROM agent_workflow_execution_steps WHERE stage='plan_wire_projection' AND status='ok' LIMIT 1").get()as any;const receipt=JSON.parse(recorded.output_json);const{restoreNativePlanInput}=await import('../server/native-plan-factor.js');assert.deepEqual(restoreNativePlanInput(wire,receipt),{assignedWorker:wire.assignedWorker,...original});
});

test('real runtime plan refusal has typed failed non-entry evidence; entering executor never gains that proof',async t=>{
 const{hostNativeActionNotStartedProof,validateNativeActionNotStartedProof}=await import('../server/native-action-not-started.js');const f=await runtimeFixture(t);const payload={subject:'Read parcel',scope:'All',filter:''};let entered=false;
 for(const planRefuses of [true,false]){f.reset();let error:any;try{await f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:payload,llm:{model:'fixture',chatCompletion:async request=>{const system=request.messages[0].content;if(system.includes('You are one worker'))return reply({proceed:!planRefuses,instructions:'Read actual parcel',constraints:[],expectedOutcome:'Observed parcel',reason:'Fixture refusal'});entered=true;throw Error('fixture-executor-error');}}}as any);}catch(e){error=e;}assert(error);assert.equal(error.workflowExecution.status,'failed');const proof=hostNativeActionNotStartedProof(error);if(planRefuses){assert.equal(entered,false);assert(proof);assert(validateNativeActionNotStartedProof(proof,{appId:'parcels',actionId:'actions.refresh.run',eventPayload:payload}));assert.equal(error.workflowExecution.externalEffectsMayHaveOccurred,false);}else{assert.equal(entered,true);assert.equal(proof,undefined);assert.equal(error.workflowExecution.externalEffectsMayHaveOccurred,true);}}
});

test('actual HTTP failed runtime action returns host-only non-entry proof without acknowledging business success',async t=>{
 const{hostNativeActionNotStartedProof,validateNativeActionNotStartedProof}=await import('../server/native-action-not-started.js');const f=await runtimeFixture(t);const payload={subject:'First request',scope:'All',filter:''};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);try{await f.runtime.action({...body,user:'fixture-owner',llm:{model:'fixture',chatCompletion:async()=>reply({proceed:false,reason:'Fixture actual plan refusal'})}});}catch(e:any){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message,workflowExecution:e.workflowExecution,...(hostNativeActionNotStartedProof(e)?{nativeActionNotStarted:hostNativeActionNotStartedProof(e)}:{})}));}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const response=await fetch(`http://127.0.0.1:${(server.address()as any).port}/agent/action`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId:'parcels',actionId:'actions.refresh.run',eventPayload:payload})});assert.equal(response.status,500);const body:any=await response.json();assert.equal(body.workflowExecution.status,'failed');assert.equal(body.workflowExecution.externalEffectsMayHaveOccurred,false);assert(validateNativeActionNotStartedProof(body.nativeActionNotStarted,{appId:'parcels',actionId:'refresh.run',eventPayload:payload}));assert.equal(body.nativeActionNotStarted.executionId,body.workflowExecution.executionId);
});
