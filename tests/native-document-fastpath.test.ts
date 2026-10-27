import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import Database from 'better-sqlite3';
import {createLiveUIRuntime,readServiceDocumentDeterministically} from '../server/liveuiagent.js';
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
 const reset=()=>db.prepare('INSERT OR REPLACE INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('parcels','Parcels','Read parcels',JSON.stringify(pkg),JSON.stringify(data),JSON.stringify(state),'1','fixture-owner');reset();return{runtime,reset,db,dir,stored:()=>db.prepare('SELECT runtime_state_json FROM agent_apps WHERE app_id=?').get('parcels')as any};
}


const content='三个真实实验。'.repeat(300);
async function documentBridge(t:any,method='get',schema:any={type:'integer'}){
 let reads=0;
 const server=http.createServer((req,res)=>{reads++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({note_id:3086,title:'Real title',content}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const capability:any={id:'tool.appworld.notes.show_note_get',permission:'tool.appworld.notes.show_note_get',source:'appworld',method:method.toUpperCase(),inputSchema:schema===null?undefined:{type:'object',properties:{note_id:schema},required:['note_id']},requiredParams:['note_id']};
 const bridge:any={getCapabilities:async()=>[capability],callTool:async(id:string,args:any)=>{assert.equal(args.note_id,3086);const response=await fetch(`http://127.0.0.1:${(server.address()as any).port}`);return{tool:capability,request:args,response:await response.json(),dbChanges:null};}};
 return{bridge,capability,reads:()=>reads};
}
const action:any={executionMode:'read_document',documentBinding:{permission:'tool.appworld.notes.show_note_get',identityArgument:'note_id',responsePath:'/content'}};
const permissions=['storage.app','tool.appworld.notes.show_note_get'];
test('real local HTTP document read is one GET and complete exact typed body without a model',async t=>{
 const f=await documentBridge(t);const result=await readServiceDocumentDeterministically(action,permissions,{entityId:'3086'},[{id:'3086'}],f.bridge);assert.equal(f.reads(),1);assert.equal(result.document.content,content);assert.equal(result.document.entityId,'3086');assert.equal(result.call.request.note_id,3086);
});
test('wrong method, target, permission and unresolved/extra-required schema reject before dispatch',async t=>{
 const f=await documentBridge(t);const cap=f.capability;
 const fail=()=>assert.rejects(readServiceDocumentDeterministically(action,permissions,{entityId:'3086'},[{id:'3086'}],f.bridge));
 cap.method='POST';await fail();cap.method='GET';await assert.rejects(readServiceDocumentDeterministically(action,permissions,{entityId:'999'},[{id:'3086'}],f.bridge));await assert.rejects(readServiceDocumentDeterministically(action,['storage.app'],{entityId:'3086'},[{id:'3086'}],f.bridge));
 for(const schema of [undefined,{type:'object',properties:{note_id:{$ref:'#/x'}}},{type:'object',properties:{note_id:{type:'integer'}},required:['other']},{type:'object',properties:{note_id:{type:'object'}}}]){cap.inputSchema=schema;await fail();}assert.equal(f.reads(),0);
});
test('invalid scalar identities and lossy numeric conversions dispatch nothing',async t=>{
 const f=await documentBridge(t);for(const id of [undefined,null,{},Infinity,NaN,'03086','3.086e3','9007199254740993'])await assert.rejects(readServiceDocumentDeterministically(action,permissions,{entityId:id},[{id}],f.bridge));assert.equal(f.reads(),0);
});
test('actual runtime opt-in commits full document, preserves rows, reopens, and never calls model',async t=>{
 const f=await runtimeFixture(t);const b=await documentBridge(t);
 // Fixture runtime uses a real discovered AppWorld bridge; replace only its HTTP metadata/service routes via local config.
 const server=http.createServer((req,res)=>{const route=new URL(req.url!,'http://fixture').pathname;let value:any;if(route==='/api_docs/app_descriptions')value=[{name:'notes',description:'Fixture'}];else if(route==='/notes/openapi.json')value={openapi:'3.1.0',paths:{'/notes/{note_id}':{get:{operationId:'show_note_get',parameters:[{name:'note_id',in:'path',required:true,schema:{type:'integer'}}],responses:{'200':{description:'Note'}}}}}};else if(route==='/notes/notes/3086'){gets++;value={note_id:3086,title:'Real title',content};}else if(route==='/dbs')value={notes:f.dir};else if(route==='/dbs/save')value={message:'saved'};else{res.writeHead(404);res.end('{}');return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});let gets=0;await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base=`http://127.0.0.1:${(server.address()as any).port}`;process.env.APPWORLD_API_BASE=base;
 fs.writeFileSync(path.join(f.dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:true,apiBase:base,snapshotRoot:path.join(f.dir,'snapshots'),apps:['notes']}}));
 const runtime=createLiveUIRuntime(f.db,{registryRoot:path.join(f.dir,'apps2'),projectRoot:f.dir});const row:any=f.db.prepare('SELECT * FROM agent_apps WHERE app_id=?').get('parcels');const pkg=JSON.parse(row.package_json);pkg.actions.actions['refresh.run']={...pkg.actions.actions['refresh.run'],...action,permissions};const state=JSON.parse(row.runtime_state_json);state.entities.push({id:'3086',name:'Old summary',detail:'Wrong two experiments'});f.db.prepare('UPDATE agent_apps SET package_json=?,runtime_state_json=? WHERE app_id=?').run(JSON.stringify(pkg),JSON.stringify(state),'parcels');let models=0;
 const invoke=(user='fixture-owner')=>runtime.action({appId:'parcels',actionId:'refresh.run',user,eventPayload:{entityId:'3086'},llm:{model:'fixture',chatCompletion:async()=>{models++;throw Error('MODEL MUST NOT RUN');}}}as any);
 await assert.rejects(invoke('other-owner'),/not found/);assert.equal(gets,0);
 const result:any=await invoke();assert.equal(models,0);assert.equal(gets,1);assert.equal(result.workflowExecution.mode,'deterministic-document-read');assert.deepEqual(result.workflowExecution.steps,[]);assert.equal(result.runtimeState.serviceDocument.content,content);assert.equal(result.runtimeState.entities.find((r:any)=>r.id==='3086').name,'Real title');assert.ok(result.runtimeState.entities.some((r:any)=>r.id==='old-1'));
 const reopened=await runtime.queryState({user:'fixture-owner'});assert.equal(reopened.apps[0].appPackage.ui.meta.a2ui.initialData.draft.result,content);
 const before=f.stored().runtime_state_json;await assert.rejects(runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{entityId:'999'}}),/exact current/);assert.equal(f.stored().runtime_state_json,before);assert.equal(gets,1);
 delete pkg.actions.actions['refresh.run'].executionMode;f.db.prepare('UPDATE agent_apps SET package_json=? WHERE app_id=?').run(JSON.stringify(pkg),'parcels');await assert.rejects(invoke(),/MODEL MUST NOT RUN/);assert.ok(models>0);assert.equal(gets,1,'non-opt-in follows original model workflow rather than fastpath');
});

test('actual five-role runtime treats static persistence handoff as staged GUI cache without a business write',async t=>{
 const f=await runtimeFixture(t);const row:any=f.db.prepare('SELECT * FROM agent_apps WHERE app_id=?').get('parcels');const pkg=JSON.parse(row.package_json);
 const oldEdge={from:'agents.app',to:'agents.data',payload:'records to persist for the app',reason:'Persist structured state for reopen and later interactions.'};
 const route=pkg.orchestration.routes[0];route.handoffs[2]=oldEdge;const action=pkg.actions.actions['refresh.run'];action.handoffs=route.handoffs;action.label='Compare';action.description='Read public repository information and display a comparison. Saving a business note is a separate action.';action.permissions=['storage.app','llm.call','tool.github.search'];
 pkg.manifest.intent.sourcePrompt='Compare actual public repository information without saving a business note.';f.db.prepare('UPDATE agent_apps SET package_json=? WHERE app_id=?').run(JSON.stringify(pkg),'parcels');
 const priorState=f.stored().runtime_state_json;const originalFetch=globalThis.fetch;let publicReads=0,businessWrites=0,groundingSteps=0,workerPlans=0,reviews=0;
 globalThis.fetch=async(input:any,init:any)=>{
  if(String(input).startsWith('https://api.github.com/search/repositories?')){publicReads++;return new Response(JSON.stringify({items:[{full_name:'fixture/repository',html_url:'https://github.com/fixture/repository',description:'Actual retrieved comparison evidence',stargazers_count:7,license:{spdx_id:'MIT'}}]}));}
  if(init?.method&&!['GET','HEAD'].includes(String(init.method).toUpperCase()))businessWrites++;
  return originalFetch(input,init);
 };t.after(()=>{globalThis.fetch=originalFetch;});
 const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
 const model=async(request:any)=>{
  const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split('\n')[0]);
  if(input.assignedWorker&&sys.includes('one worker in a native application')){
   workerPlans++;assert.match(sys,/Static route handoff metadata/);assert.equal(input.context.originalRequest.currentAction.label,'Compare');assert.deepEqual(input.context.permissions,['storage.app','llm.call','tool.github.search']);
   if(input.assignedWorker.id==='agents.data'){assert.deepEqual(input.incomingHandoff,oldEdge);assert.match(sys,/host still stages that cache until independent review/);assert.match(sys,/do not reinterpret a concrete forbidden mutation as cache/);}
   return reply({proceed:true,instructions:'Prepare actual retrieved results for staged GUI display only.',constraints:['No external or app-local business writes'],expectedOutcome:'Visible comparison from actual public evidence'});
  }
  if(sys.includes('You analyze a GUI'))return reply({objective:'Compare public repository evidence',deliverables:['Actual public repository result'],projectionPolicy:'replace_or_filter'});
  if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:true,deficiencies:[]});
  if(sys.includes('independently verify a native app execution')){reviews++;assert.equal(input.outcome.persistencePending,true);assert.ok(input.outcome.proposedRecords.length>1);assert.ok(Object.keys(input.outcome.toolResults).some(key=>key.startsWith('public-tool#')));return reply({pass:true,reason:'Public read evidence and staged GUI result satisfy Compare; no business save claimed'});}
  return ++groundingSteps===1?reply({calls:[{api:'github_search_repositories',args:{query:'agent research'}}]}):reply({done:true,summary:'Found fixture/repository, MIT, 7 stars',entities:[{name:'fixture/repository',id:'https://github.com/fixture/repository',detail:'MIT; 7 stars'}],stats:[{label:'Repositories',value:'1'}]});
 };
 const invoke=(chatCompletion=model)=>f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'agent research',scope:'Public',filter:'All'},llm:{model:'fixture-only',chatCompletion}}as any);
 const result:any=await invoke();
 assert.equal(workerPlans,5);assert.equal(reviews,1);assert.equal(publicReads,1);assert.equal(businessWrites,0);assert.equal(result.workflowExecution.status,'completed');assert.notEqual(f.stored().runtime_state_json,priorState);
 const stored:any=f.db.prepare('SELECT data_json FROM agent_apps WHERE app_id=?').get('parcels');assert.equal(JSON.parse(stored.data_json).records.length,2,'Host commits its staged turn history after review');
 const localTable=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_app_records'").get();if(localTable)assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM native_app_records').get()as any).n,0,'No app-local business records were created');
 const reopened=await f.runtime.queryState({user:'fixture-owner'});assert.equal(reopened.apps[0].runtimeState.entities[0].name,'fixture/repository');
 const verified=f.stored().runtime_state_json;const savedData=(f.db.prepare('SELECT data_json FROM agent_apps WHERE app_id=?').get('parcels')as any).data_json;groundingSteps=0;
 await assert.rejects(invoke(async(request:any)=>request.messages[0].content.includes('independently verify a native app execution')?reply({pass:false,reason:'A business save was claimed without actual external write evidence'}):model(request)),/business save was claimed/);
 assert.equal(f.stored().runtime_state_json,verified,'Independent review refusal still prevents the staged GUI commit');assert.equal((f.db.prepare('SELECT data_json FROM agent_apps WHERE app_id=?').get('parcels')as any).data_json,savedData);assert.equal(businessWrites,0);
});
