import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import Database from 'better-sqlite3';
import {groundingViewContext} from '../server/grounding-view.js';
import {runAppWorldGrounding,createLiveUIRuntime} from '../server/liveuiagent.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
const descriptor=groundingViewContext({manifest:{intent:{itemLabel:'parcel',presentation:{collection:'Dispatches'}}},dataSchema:{dataSources:{agent_turns:{}}},actions:{actions:{'inspect.run':{label:'Inspect parcel',perItem:true},'refresh.run':{label:'Refresh'}}}})!;

test('declared primary row context is shared without filtering complete container/item business evidence',async()=>{
 assert.deepEqual(descriptor,{itemLabel:'parcel',collectionLabel:'Dispatches',perItemActions:[{id:'inspect.run',label:'Inspect parcel'}]});assert.equal(groundingViewContext({manifest:{intent:{}}}),undefined);
 for(const complete of [true,false]){
  const requests:any[]=[];const tools=['create_batch','create_parcel','read_batch'].map(api=>({id:api,apiName:api,permission:api,appName:'warehouse',method:api==='read_batch'?'GET':'POST',purpose:api}));const ops:any[]=[];let step=0;
  const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{ops.push(api);return{tool:tools.find(t=>t.id===api),request:args,response:api==='read_batch'?{batch:{id:'batch-8',name:'Morning batch'},parcels:[{id:'parcel-42',name:'Parcel 42'}]}:{id:api==='create_batch'?'batch-8':'parcel-42',name:api==='create_batch'?'Morning batch':'Parcel 42'},dbChanges:null};}};
  const plan=complete?['create_batch','create_parcel','read_batch']:['create_parcel','read_batch'];
  const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),payload:{request:'Create Morning batch with Parcel 42 inside it.'},appName:'Dispatches',viewContext:descriptor,llm:{model:'fixture-only',chatCompletion:async(request:any)=>{
   requests.push(request);const sys=request.messages[0].content,input=JSON.parse(request.messages[1].content.split("\n")[0]);assert.deepEqual(input.viewContext,descriptor);assert.match(sys,/never new user intent/);assert.match(sys,/A clean list cannot hide an unfinished/);
   if(sys.includes('You analyze a GUI'))return reply({objective:'Create batch and its parcel',deliverables:['New Morning batch','Parcel 42 in the batch'],targetCount:1});
   if(sys.includes('You are the Write Verifier'))return reply({approved:true});
   if(sys.includes('You are an INDEPENDENT evaluator')){assert.deepEqual(input.visibleEntities,[{id:'parcel-42',name:'Parcel 42',detail:'In Morning batch'}]);assert.deepEqual(input.visibleStats,[{label:'Batch parcels',value:'1'}]);assert.ok(input.apiCalls.some((x:any)=>x.api==='read_batch'&&x.response.batch.id==='batch-8'&&x.response.parcels[0].id==='parcel-42'));const fulfilled=['create_batch','create_parcel','read_batch'].every(api=>input.apiCalls.some((x:any)=>x.ok&&x.api===api));return reply({pass:fulfilled,deficiencies:fulfilled?[]:['Requested new batch has no successful create; clean parcel rows cannot hide this gap']});}
   return reply(step<plan.length?{calls:[{api:plan[step++],args:{name:'fixture'}}]}:{done:true,summary:'Morning batch contains Parcel 42',entities:[{id:'parcel-42',name:'Parcel 42',detail:'In Morning batch'}],stats:[{label:'Batch parcels',value:'1'}]});
  }}});
  assert.equal(result?.evaluation?.pass,complete);assert.deepEqual(ops,plan,'projection must not remove evidence or reexecute confirmed writes');assert.ok(requests.some(r=>r.messages[0].content.includes('Write Verifier')));assert.ok(result!.calls.some(x=>(x.response as any).batch?.id==='batch-8'));
 }
});

async function runtimeFixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-primary-list-'));const db=new Database(':memory:');
 const server=http.createServer((req,res)=>{const route=new URL(req.url!,'http://fixture').pathname;let value:any;
  if(route==='/api_docs/app_descriptions')value=[{name:'inventory',description:'Fixture inventory'}];
  else if(route==='/inventory/openapi.json')value={openapi:'3.1.0',paths:{'/items':{get:{operationId:'read_items',summary:'Read current parcels',responses:{'200':{description:'Current parcel list'}}}}}};
  else if(route==='/inventory/items')value=[];
  else if(route==='/dbs')value={inventory:dir};else if(route==='/dbs/save')value={message:'saved'};else{res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address()as any).port}`;
 const previous=Object.fromEntries(['APPWORLD_ENABLED','APPWORLD_API_BASE','APPWORLD_SNAPSHOT_ROOT','LIVEUIAGENT_APPWORLD_GROUNDING'].map(k=>[k,process.env[k]]));process.env.APPWORLD_ENABLED='true';process.env.APPWORLD_API_BASE=base;process.env.APPWORLD_SNAPSHOT_ROOT=path.join(dir,'snapshots');delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
 t.after(async()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:true,apiBase:base,snapshotRoot:path.join(dir,'snapshots'),apps:['inventory']}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:dir});const chain=['agents.orchestrator','agents.action','agents.app','agents.data','agents.memory'];const handoffs=chain.slice(1).map((to,i)=>({from:chain[i],to,payload:'Verified context',reason:'Next role'}));const route={id:'refresh',entryActionId:'actions.refresh.run',agentChain:chain,handoffs,label:'Refresh',description:'Read current parcels'};
 const interaction={focus:'Parcels',resultFocus:'Current parcels',primaryFieldName:'subject',secondaryFieldName:'scope',businessFields:[{name:'subject',label:'Parcel subject',type:'string'},{name:'scope',label:'Parcel scope',type:'string'},{name:'filter',label:'Parcel filter',type:'string'}],historyTitle:'Parcels',inputTitle:'Parcels',inputDescription:'Read current parcels',primaryText:'Parcel',secondaryText:'Details',outcomeLabel:'Parcels',resultSectionLabels:['Parcels']};
 const tree=[{id:'overview',component:'Column',children:['subject','scope','filter','go','result','list']},...['subject','scope','filter'].map(n=>({id:n,component:'TextField',label:'Parcel '+n,value:{path:'/draft/slots/'+n}})),{id:'go',component:'Button',child:'goText',action:{event:{name:'refresh.run'}}},{id:'goText',component:'Text',text:'Refresh'},{id:'result',component:'Text',text:{path:'/draft/result'}},{id:'list',component:'List',children:{componentId:'item',path:'/entities'}},{id:'item',component:'Column',children:['name','detail','inspect']},{id:'name',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}},{id:'inspect',component:'Button',child:'inspectText',action:{event:{name:'inspect.run'}}},{id:'inspectText',component:'Text',text:'Inspect parcel'}];
 const orchestration={plannedBy:'orchestrator-agent',workflowId:'parcels',routes:[route]};const pkg={manifest:{appId:'parcels',name:'Parcels',description:'Read parcels',version:'1',intent:{visualObjects:['parcel'],itemLabel:'parcel',presentation:{collection:'Dispatches'}}},actions:{actions:{'refresh.run':{id:'refresh.run',label:'Refresh',description:'Read current parcels',permissions:['tool.appworld.inventory.read_items'],agent:chain[0],agentChain:chain,handoffs,orchestrationRouteId:'refresh',steps:[]},'inspect.run':{id:'inspect.run',label:'Inspect parcel',perItem:true}}},agents:{agents:Object.fromEntries(chain.map(id=>[id,{id,role:id.split('.')[1],purpose:'Execute assigned role'}]))},memory:{defaultState:{}},proposal:{},assets:{icon:{svg:'<svg/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},dataSchema:{dataSources:{records:{model:'parcel'}},models:{parcel:{fields:[{name:'prompt',label:'Parcel'},{name:'context',label:'Details'}]}}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:tree}},orchestration};
 const state={sourcePrompt:'Read the actual current parcels',subject:'Parcels',functionSignature:'parcel_fixture',interaction,orchestration,intentResult:{title:'Parcels',value:'Parcels',subtitle:'Previously observed parcel',sections:[],bullets:[]},intentActionCount:0,recentActions:[],entities:[{id:'old-1',name:'Old parcel',detail:'Previously observed'}],entityStats:[{label:'Parcels',value:'1'}]};
 const data={records:[{id:'turn1',prompt:'Read parcels',context:'Current parcels',state:'open',nextStep:'Refresh',result:'Previous parcels',subject:'Current parcels',scope:'All',filter:'All'}]};
 const reset=()=>db.prepare('INSERT OR REPLACE INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('parcels','Parcels','Read parcels',JSON.stringify(pkg),JSON.stringify(data),JSON.stringify(state),'1','fixture-owner');reset();return{runtime,reset,stored:()=>db.prepare('SELECT runtime_state_json FROM agent_apps WHERE app_id=?').get('parcels')as any};
}

test('actual runtime commits verified empty rows through reopen, but failed or omitted rows preserve prior data',async t=>{
 const f=await runtimeFixture(t);
 const malformed:any={malformed_blank:[{name:''}],malformed_null:[null],malformed_primitive:['not an entity'],malformed_array:[[]],malformed_nonstring:[{name:42}],malformed_mixed:[{name:'Valid row'},{name:''}]};
 for(const mode of ['verified','retain','failed','missing','review_failed',...Object.keys(malformed)]){
  f.reset();let decision=0;const captures:any[]=[];
  const chatCompletion=async(request:any)=>{const sys=request.messages[0].content,input=JSON.parse(request.messages[1].content.split("\n")[0]);captures.push({sys,input});
   if(sys.includes('You analyze a GUI'))return reply({objective:'Read actual current parcels',...(mode==='retain'?{projectionPolicy:'retain_existing'}:{}),deliverables:['Current parcel list']});
   if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:mode!=='failed',deficiencies:mode==='failed'?['Full current list could not be verified']:[]});
   if(sys.includes('You are the backend workflow'))return reply(decision++===0?{calls:[{api:'read_items',args:{}}]}:{done:true,summary:'No current parcels',...(mode==='missing'?{}:{entities:malformed[mode]??[]}),stats:[]});
   return reply(sys.includes('independently verify')?{pass:mode!=='review_failed',reason:mode==='review_failed'?'Independent final review rejected this result':'Observed current empty parcel list'}:{proceed:true,instructions:'Read the current parcels only',constraints:[],expectedOutcome:'Verified current list'});
  };
  const invoke=()=>f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Refresh current parcels',scope:'All',filter:'All',entities:[],authoritativeEntities:true},llm:{model:'fixture-only',chatCompletion}}as any);
  if(mode==='verified')await invoke();else await assert.rejects(invoke(),/did not pass verification|native result review rejected/);
  const stored=JSON.parse(f.stored().runtime_state_json);assert.deepEqual(stored.entities,mode==='verified'?[]:[{id:'old-1',name:'Old parcel',detail:'Previously observed'}]);
  assert.deepEqual(stored.entityStats,mode==='verified'?[]:[{label:'Parcels',value:'1'}]);
  const reopened=await f.runtime.queryState({user:'fixture-owner'});if(mode==='verified'){assert.ok(stored.selectedRecordId);assert.ok(Object.values(reopened.apps[0].appData).flat().some((row:any)=>row.id===stored.selectedRecordId),'selected record must survive reopen and reference actual persisted data');}else{assert.equal(stored.selectedRecordId,undefined,'rejected turns must not change selection');}assert.deepEqual(reopened.apps[0].runtimeState.entities,stored.entities);assert.equal(reopened.apps[0].appPackage.ui.meta.a2ui.initialData.entities.length,mode==='verified'?0:1);
  const requirements=captures.find(x=>x.sys.includes('You analyze a GUI'));assert.deepEqual(requirements.input.priorProjection,{entities:[{id:'old-1',name:'Old parcel',detail:'Previously observed'}],stats:[{label:'Parcels',value:'1'}]});assert.deepEqual(requirements.input.viewContext,descriptor);assert.equal(requirements.input.goal,undefined,'view metadata must not inject new goal obligations');
 }
});

test('repair round must explicitly return its own empty list before clearing persisted rows',async t=>{
 const f=await runtimeFixture(t);
 for(const secondRound of ['missing','explicit']){
  f.reset();let decisions=0,reviews=0;
  const chatCompletion=async(request:any)=>{const sys=request.messages[0].content;
   if(sys.includes('You analyze a GUI'))return reply({objective:'Read actual current parcels',deliverables:['Current parcel list']});
   if(sys.includes('You are an INDEPENDENT evaluator')){reviews++;return reply({pass:reviews>1,deficiencies:reviews===1?['Recheck the primary-list projection']:[]});}
   if(sys.includes('You are the backend workflow')){
    decisions++;if(decisions===1)return reply({calls:[{api:'read_items',args:{}}]});
    return reply({done:true,summary:'No current parcels',...(decisions===2||secondRound==='explicit'?{entities:[]}:{}),stats:[]});
   }
   return reply(sys.includes('independently verify')?{pass:true,reason:'Verified current empty list'}:{proceed:true,instructions:'Read current parcels only',constraints:[],expectedOutcome:'Verified current list'});
  };
  const invoke=()=>f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Refresh current parcels',scope:'All',filter:'All'},llm:{model:'fixture-only',chatCompletion}}as any);
  if(secondRound==='explicit')await invoke();else await assert.rejects(invoke(),/explicit current primary entities array missing/);
  assert.equal(reviews,2,'first explicit [] is rejected; only the second round is approved by the mock evaluator');assert.equal(decisions,3,'one actual fixture read followed by exactly two done responses');
  const stored=JSON.parse(f.stored().runtime_state_json);assert.deepEqual(stored.entities,secondRound==='explicit'?[]:[{id:'old-1',name:'Old parcel',detail:'Previously observed'}]);
  const reopened=await f.runtime.queryState({user:'fixture-owner'});assert.equal(reopened.apps[0].appPackage.ui.meta.a2ui.initialData.entities.length,secondRound==='explicit'?0:1);
 }
});
