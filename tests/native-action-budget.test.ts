import http from 'node:http';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveUIRuntime} from '../server/liveuiagent.js';
import {actionDeadlineAt,remainingActionMs,withActionDeadline} from '../server/action-deadline.js';

function setup(t:any,timeoutMs:number|null=100){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-budget-'));const db=new Database(':memory:');
 const old=process.env.APPWORLD_ENABLED;process.env.APPWORLD_ENABLED='false';
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(root,'apps'),projectRoot:process.cwd(),...(timeoutMs===null?{}:{nativeActionTimeoutMs:timeoutMs})});
 if(old===undefined)delete process.env.APPWORLD_ENABLED;else process.env.APPWORLD_ENABLED=old;
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const chain=['agents.orchestrator','agents.action','agents.app','agents.data','agents.memory'];
 const handoffs=chain.slice(1).map((to,i)=>({from:chain[i],to,payload:'Verified context',reason:'Next role'}));
 const route={id:'r',entryActionId:'actions.record.run',agentChain:chain,handoffs,label:'Run',description:'Run the request'};
 const interaction={focus:'request',resultFocus:'result',primaryFieldName:'request',secondaryFieldName:'context',businessFields:[{name:'request',label:'Request',type:'text'},{name:'context',label:'Context',type:'text'},{name:'notes',label:'Notes',type:'text'}],historyTitle:'Requests',inputTitle:'Request',inputDescription:'Enter the requested work',primaryText:'Request',secondaryText:'Context',outcomeLabel:'Result',resultSectionLabels:['Result']};
 const orchestration={plannedBy:'orchestrator-agent',workflowId:'wf',routes:[route]};
 const pkg={manifest:{appId:'a',name:'Fixture',description:'Execute a local request',version:'1.0.0',intent:{visualObjects:['record']}},actions:{actions:{'record.run':{id:'record.run',label:'Run',description:'Execute local request',permissions:[],agent:chain[0],agentChain:chain,handoffs,orchestrationRouteId:'r',steps:[]}}},agents:{agents:Object.fromEntries(chain.map(id=>[id,{id,role:id.split('.')[1],purpose:'Execute assigned role'}]))},memory:{defaultState:{}},proposal:{},assets:{icon:{review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},dataSchema:{dataSources:{records:{model:'record'}},models:{record:{fields:[]}}},ui:{pages:[],meta:{designedOverview:[{id:'overview',component:'Column',children:['f1','f2','f3','go','result','list']},{id:'f1',component:'TextField',label:'Entry content',value:{path:'/draft/slots/request'}},{id:'f2',component:'TextField',label:'Entry context',value:{path:'/draft/slots/context'}},{id:'f3',component:'TextField',label:'Extra notes',value:{path:'/draft/slots/notes'}},{id:'go',component:'Button',child:'goText',action:{event:{name:'record.run'}}},{id:'goText',component:'Text',text:'Create record'},{id:'result',component:'Text',text:{path:'/draft/result'}},{id:'list',component:'List',children:{componentId:'item',path:'/entities'}},{id:'item',component:'Column',children:['name','detail']},{id:'name',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}}]}},orchestration};
 const state={sourcePrompt:'Create local records',subject:'Records',functionSignature:'fixture',interaction,orchestration,intentActionCount:0,recentActions:[]};
 db.prepare(`INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES('a','Fixture','Fixture',?,?,?,'1.0.0','alice')`).run(JSON.stringify(pkg),JSON.stringify({records:[]}),JSON.stringify(state));
 const stored=()=>db.prepare('SELECT data_json,runtime_state_json FROM agent_apps WHERE app_id=?').get('a');
 const invoke=(chatCompletion:any,extra={})=>runtime.action({requestId:randomUUID(),appId:'a',actionId:'record.run',user:'alice',eventPayload:{request:'Create one record',context:'Local fixture',notes:'One record',deadlineMs:99999999},llm:{model:'fixture',chatCompletion},...extra} as any);
 return{runtime,db,stored,invoke};
}
function response(request:any){const system=request.messages[0].content;return {choices:[{message:{content:JSON.stringify(system.includes('independently verify')?{pass:true,reason:'Actual local record'}:system.includes('backend agent')?{result:'Created record',entities:[{name:'Actual record',detail:'Created locally'}],stats:[]}:{proceed:true,instructions:'Execute only this request',constraints:[],expectedOutcome:'One record'})}}]};}

test('runtime action shares server budget across roles and cannot start its local executor after exhaustion',async t=>{
 const {invoke,stored}=setup(t);const before=stored();let now=1000,calls=0;const budgets:number[]=[];t.mock.method(Date,'now',()=>now);
 await assert.rejects(invoke(async(req:any)=>{budgets.push(remainingActionMs());calls++;now+=40;return response(req);}),(e:any)=>e.code==='action_deadline_exceeded'&&e.status===504);
 assert.equal(calls,3);assert.deepEqual(budgets,[100,60,20]);assert.deepEqual(stored(),before);
});

test('late reviewer cannot commit; durable uncertainty gate blocks a new independent turn',async t=>{
 const {invoke,stored}=setup(t,100);let now=1000,executions=0,reviews=0;const before=stored();t.mock.method(Date,'now',()=>now);
 await assert.rejects(invoke(async(req:any)=>{const s=req.messages[0].content;if(s.includes('backend agent'))executions++;if(s.includes('independently verify')){reviews++;now+=101;}return response(req);}),(e:any)=>e.code==='action_deadline_exceeded'&&e.status===504);
 assert.equal(executions,1);assert.equal(reviews,1);assert.deepEqual(stored(),before);
 // This fixture has no business tools, but executor entry is not a host proof of
 // zero dispatch. Preserve uncertainty until a separately reviewed evidence path exists.
 await assert.rejects(invoke(async(req:any)=>{if(req.messages[0].content.includes('backend agent'))executions++;return response(req);}),/native_command_unresolved/);
 assert.equal(executions,1);assert.deepEqual(stored(),before);
});

test('parent deadline only shortens host action budget and client JSON cannot extend it',async t=>{
 const {invoke,stored}=setup(t,100);let now=1000;const before=stored();const budgets:number[]=[];t.mock.method(Date,'now',()=>now);
 await assert.rejects(withActionDeadline(1030,()=>invoke(async(req:any)=>{budgets.push(remainingActionMs());now+=20;return response(req);},{deadlineMs:9999999,deadlineAt:999999999})),(e:any)=>e.code==='action_deadline_exceeded'&&e.status===504);
 assert.deepEqual(budgets,[30,10]);assert.deepEqual(stored(),before);assert.equal(actionDeadlineAt(),undefined);
});

test('real elapsed inference timeout cannot commit its late result or replay the executor',async t=>{
 // This is a deadline/commit contract, not an 80 ms runtime performance target.
 const {invoke,stored}=setup(t,1000);const before=stored();let executionCalls=0,lateFinished=false;
 const started=Date.now();
 await assert.rejects(invoke(async(req:any)=>{
  if(req.messages[0].content.includes('backend agent')){executionCalls++;await new Promise(r=>setTimeout(r,1700));lateFinished=true;}
  return response(req);
 }),(e:any)=>e.code==='action_deadline_exceeded'&&e.status===504);
 assert.ok(Date.now()-started<3000,'server total deadline is bounded rather than child 60s timeout');
 await new Promise(r=>setTimeout(r,1800));assert.equal(lateFinished,true);assert.equal(executionCalls,1);assert.deepEqual(stored(),before);
 let extraCalls=0;await assert.rejects(invoke(async(req:any)=>{extraCalls++;return response(req);}),/native_command_unresolved/);assert.equal(extraCalls,0);assert.deepEqual(stored(),before);
});

test('default Native action owns a sixteen minute budget independent of client JSON',async t=>{
 const {invoke}=setup(t,null);let firstBudget:number|undefined;
 const result=await invoke(async(req:any)=>{firstBudget??=remainingActionMs();return response(req);},{deadlineMs:1,deadlineAt:0});
 assert.ok(firstBudget!>959000&&firstBudget!<=960000);assert.equal(result.workflowExecution.status,'completed');
});

test('real shorter parent deadline wins over host timeout with no downstream executor',async t=>{
 // Give role dispatch room while preserving a genuinely shorter parent budget.
 const {invoke,stored}=setup(t,5000);const before=stored();let calls=0;
 await assert.rejects(withActionDeadline(Date.now()+500,()=>invoke(async(req:any)=>{calls++;await new Promise(r=>setTimeout(r,1000));return response(req);})),(e:any)=>e.code==='action_deadline_exceeded'&&e.status===504);
 await new Promise(r=>setTimeout(r,1200));assert.equal(calls,1);assert.deepEqual(stored(),before);
});

test('actual outer reviewer HTTP policy checks original obligations without elevating worker inventions or forgiving missing external effects',async t=>{
 for(const externalRequired of [false,true]){
  const f=setup(t,10000);const before=f.stored();const source=f.db.prepare('SELECT package_json FROM agent_apps WHERE app_id=?').get('a')as any;const pkg=JSON.parse(source.package_json);const need=externalRequired?'Create one local record and send a required external notice.':'Create one local record.';pkg.manifest.intent.sourcePrompt=need;f.db.prepare('UPDATE agent_apps SET package_json=? WHERE app_id=?').run(JSON.stringify(pkg),'a');
  let plans=0,executions=0,reviews=0;const systems:string[]=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);const system=request.messages[0].content;systems.push(system);let value:any;
   if(system.includes('independently verify')){reviews++;const packet=JSON.parse(request.messages[1].content);assert.match(system,/Worker-declared end states are fallible planning evidence, not independent goals/);assert.match(system,/original app need and explicit current user request/);assert.match(system,/all actual safety requirements satisfied and no failed operations/);assert.match(system,/External writes may already have occurred/);assert.match(system,/Do not invent service facts or claim a rollback/);assert(!system.includes('no failed operations or unmet worker contracts'));assert.equal(packet.outcome.hostActionContext.originalAppNeed,need);assert(packet.workerContracts.some((h:any)=>h.constraints.includes('Notify an unrelated optional service even when the user did not request it.')));
    value=externalRequired?{pass:false,reason:'Required external notice has no observed service evidence.'}:{pass:true,reason:'The actual requested local record is present; unrelated worker notification is not a user obligation.'};
   }else if(system.includes('backend agent')){executions++;value={result:'Created local record only; no external notice sent.',entities:[{name:'Actual local record',detail:'Created locally only'}],stats:[]};}
   else{plans++;value={proceed:true,instructions:'Create the requested local record.',constraints:['Notify an unrelated optional service even when the user did not request it.'],expectedOutcome:'Local record plus an unrequested optional notification.'};}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const action=f.invoke(undefined,{eventPayload:{request:need,context:'Current controlled request',notes:''},llm:{model:'fixture-only',apiBase:`http://127.0.0.1:${(server.address()as any).port}`,apiKey:'controlled-fixture-only'}});
   if(externalRequired){await assert.rejects(action,/Required external notice has no observed service evidence/);assert.deepEqual(f.stored(),before,'missing actual requested external effects cannot be committed as success');}
   else{const result=await action;assert.equal(result.workflowExecution.status,'completed');}
   assert.equal(plans,5);assert.equal(executions,1);assert.equal(reviews,1);assert.equal(systems.length,7,'one actual review, no review approval retry or extra provider attempt');
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});
