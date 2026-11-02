import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {installApplicationRoutes} from '../server/application-routes.js';
import {createRichWorkspaces} from '../server/rich-workspaces.js';
import {createNativeHarnessBindings} from '../server/native-harness.js';

const tree={type:'Stack',children:[{type:'Text',text:'Original chart'},{type:'Checklist',recordId:'record',checked:true,children:[]},{type:'Plot',plot:{kind:'bar',series:[{name:'Saved',color:'#245abc',points:[[1,72],[2,40]]}]}}]};
const updatedTree={type:'Stack',children:[{type:'Text',text:'Updated chart'},{type:'Checklist',recordId:'record',checked:true,children:[]},{type:'Plot',plot:{kind:'bar',series:[{name:'Saved',color:'#245abc',points:[[1,72],[2,40]]}]}}]};
const initial={app:{id:'visual_one',name:'Original chart',description:'A saved chart',harness:'native',model:'old-model',revision:1},version:1,tree,records:[{id:'record',value:72}],interactionState:{checked:{record:true}},lastRequest:'original request',requestHistory:[{prompt:'original request'}]};
const harnesses=['native','dsh','codex','qwen','kimi','zcode'];
async function fixture(t:any){
 const db=new Database(':memory:');db.exec(`CREATE TABLE agent_apps(app_id TEXT PRIMARY KEY,owner TEXT,package_json TEXT,data_json TEXT,runtime_state_json TEXT,version TEXT);
 CREATE TABLE complete_apps(owner TEXT,app_id TEXT,info_json TEXT,updated_at TEXT,PRIMARY KEY(owner,app_id));`);
 db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('native_one','alice',JSON.stringify({manifest:{name:'Native',description:'Owned app'},frontend:{files:{'App.tsx':'actual source'}}}),'{}','{"count":7}','1');
 db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('native_other','bob','{"manifest":{"name":"Other private"}}','{}','{}','1');
 db.prepare('INSERT INTO complete_apps VALUES (?,?,?,?)').run('alice','dsh_one','{"id":"one","name":"Saved HTML","revision":3}','today');
 const binding=createNativeHarnessBindings(db),requests:any[]=[],nativePatches:any[]=[],htmlCalls:any[]=[],htmlEdits:any[]=[],app=express();app.use(express.json());
 const userOf=(req:any)=>String(req.header('x-owner')||'');let answer:(request:any,harness:string)=>Promise<any>=async()=>({answer:'Read complete'});
 const llmOf=(req:any)=>{const harness=req.body.harness||'native';return {model:'model-'+harness,chatCompletion:async(request:any)=>{requests.push({harness,request});return {choices:[{message:{content:JSON.stringify(await answer(request,harness))}}]};}};};
 const rich=createRichWorkspaces(db,{userOf,harnessFor:()=> 'native',llmOf:()=>{throw Error('Management must use selected model');},bindHarness:(owner,id,h)=>binding.save(owner,id,h as any)});
 db.prepare('INSERT INTO rich_workspaces VALUES (?,?,?)').run('alice','visual_one',JSON.stringify(initial));binding.save('alice','visual_one','native');
 const html={app:{id:'one',name:'Saved HTML',revision:3},html:'<!doctype html><title>Saved HTML</title>',store:{score:72}};
 let patchHook:()=>Promise<void>=async()=>{};
 const managerOptions:Parameters<typeof installApplicationRoutes>[2]={userOf,llmOf,harnessFor:req=>req.body.harness||'native',bindingOf:(o,id)=>binding.get(o,id),during:async(_req,_id,work)=>work(),
 nativePatch:async input=>{nativePatches.push(input);await patchHook();return {type:'app_patched',appSummary:{name:'Native'}};},rich,
 html:{loadApp:async(req,id)=>{htmlCalls.push({owner:userOf(req),id});return html;},reviseManaged:async(req,id)=>{htmlEdits.push({owner:userOf(req),id});throw Error('Unexpected HTML edit');}}};
 const manager=installApplicationRoutes(app,db,managerOptions);
 rich.install(app);let passedThrough=0;const forwardedBodies:any[]=[];app.post('/agent/run',(req,res)=>{passedThrough++;forwardedBodies.push(structuredClone(req.body));res.json({type:'original-handler'});});
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message,code:e.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
 const base='http://127.0.0.1:'+(server.address() as any).port;
 async function call(path:string,body?:any,owner='alice'){const result=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-owner':owner},...(body?{body:JSON.stringify(body)}:{})});return {status:result.status,body:await result.json() as any};}
 const saved=()=>JSON.parse((db.prepare('SELECT snapshot_json FROM rich_workspaces WHERE owner=? AND app_id=?').get('alice','visual_one') as any).snapshot_json);
 return {db,call,requests,nativePatches,htmlCalls,htmlEdits,html,manager,forwardedBodies,restart:()=>installApplicationRoutes(express(),db,managerOptions),binding,saved,rich,passedThrough:()=>passedThrough,setAnswer:(fn:typeof answer)=>answer=fn,setPatch:(fn:typeof patchHook)=>patchHook=fn};
}

test('HTTP inventory and exact paged reads cover every format with no writes or inference',async t=>{
 const x=await fixture(t),before=(x.db.prepare('SELECT total_changes() n').get() as any).n;
 const listed=await x.call('/agent/applications');assert.equal(listed.status,200);assert.equal(listed.body.total,3);assert.deepEqual(listed.body.apps.map((a:any)=>a.format).sort(),['html','native','workspace']);
 for(const id of ['native_one','visual_one','dsh_one']){const read=await x.call('/agent/applications/'+id);assert.equal(read.status,200);assert.match(read.body.token,/^[a-f0-9]{64}$/);assert.doesNotThrow(()=>JSON.parse(read.body.content));}
 assert.deepEqual(x.htmlCalls,[{owner:'alice',id:'dsh_one'}]);assert.equal(x.requests.length,0);assert.equal((x.db.prepare('SELECT total_changes() n').get() as any).n,before);assert.deepEqual(x.saved(),initial);
});

test('HTTP read cannot reveal another owner or invoke HTML reader before authorization',async t=>{
 const x=await fixture(t);assert.equal((await x.call('/agent/applications/native_other')).status,404);assert.equal((await x.call('/agent/applications/dsh_one',undefined,'bob')).status,404);assert.equal(x.htmlCalls.length,0);
 assert.equal((await x.call('/agent/applications',undefined,'')).status,401);assert.equal((await x.call('/agent/applications/native_one?offset=-1')).status,400);
 const first=await x.call('/agent/applications/visual_one?section=source&maxChars=10');assert.equal(first.status,200);assert.equal(first.body.content.length,10);assert.equal(first.body.nextOffset,10);
 const state=x.saved();state.version++;x.db.prepare('UPDATE rich_workspaces SET snapshot_json=? WHERE owner=?').run(JSON.stringify(state),'alice');assert.equal((await x.call('/agent/applications/visual_one?expectedToken='+first.body.token)).status,409);
});

function sequence(x:any,steps:any[]){let index=0;x.setAnswer(async()=>{assert.ok(index<steps.length,'Unexpected extra inference');const value=steps[index++];return typeof value==='function'?value():value;});return ()=>index;}
const route=(intent:string,id='visual_one')=>({intent,appIds:[id]});
const read=(id='visual_one')=>({tool:'read_app',appId:id,section:'all',offset:0,maxChars:12000});
const revise=(id='visual_one')=>({tool:'revise_app',appId:id});
const treeReply={text:'Updated',data:{tree:updatedTree}};

test('six harnesses receive the same tools and query selected rich app without changing it',async t=>{
 const x=await fixture(t),toolPrompts:string[]=[];
 for(const harness of harnesses){
  const before=x.requests.length;sequence(x,[route('answer'),read(),{tool:'finish',answer:'The saved record has value 72.'}]);
  const result=await x.call('/agent/run',{prompt:'Read the selected app and its saved values',selectedAppId:'visual_one',harness,clientRequestId:'query-'+harness});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.type,'answered');assert.match(result.body.answer,/72/);
  const calls=x.requests.slice(before);assert.equal(calls.length,3);assert.ok(calls.every((r:any)=>r.harness===harness));toolPrompts.push(calls[1].request.messages[0].content);
  assert.deepEqual(x.saved(),initial);assert.equal(x.binding.get('alice','visual_one'),'native');
 }
 assert.ok(toolPrompts.every(p=>p===toolPrompts[0]));assert.match(toolPrompts[0],/read_app/);assert.match(toolPrompts[0],/revise_app/);assert.equal(x.nativePatches.length,0);assert.equal(x.htmlEdits.length,0);assert.equal(x.manager.activeCount(),0);
});

test('selected Codex genuinely revises rich tree through original renderer validator and persistence, preserves data and binding',async t=>{
 const x=await fixture(t);sequence(x,[route('edit'),read(),revise(),treeReply]);
 const body={prompt:'Change the chart heading to Updated chart and retain all values',selectedAppId:'visual_one',harness:'codex',clientRequestId:'rich-edit'};
 const result=await x.call('/agent/run',body);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.type,'answered');
 const saved=x.saved();assert.deepEqual(saved.tree,updatedTree);assert.equal(saved.version,2);assert.deepEqual(saved.records,initial.records);assert.deepEqual(saved.interactionState,initial.interactionState);assert.equal(saved.app.harness,'native');assert.equal(saved.app.model,'old-model');assert.equal(x.binding.get('alice','visual_one'),'native');
 assert.equal(x.requests.length,4);assert.ok(x.requests.every((r:any)=>r.harness==='codex'));assert.equal(result.body.editedApps[0].execution.harness,'codex');
 const second=await x.call('/agent/run',body);assert.equal(second.status,200);assert.deepEqual(second.body,result.body);assert.equal(x.requests.length,4);assert.equal(x.saved().version,2);
 const conflict=await x.call('/agent/run',{...body,prompt:'Different requested change'});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'application_request_conflict');assert.equal(x.requests.length,4);
});

test('same request while pending joins its original execution rather than dispatching another edit',async t=>{
 const x=await fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered!:()=>void;const began=new Promise<void>(r=>entered=r);
 sequence(x,[async()=>{entered();await gate;return route('edit');},read(),revise(),treeReply]);
 const body={prompt:'Change the heading only',selectedAppId:'visual_one',harness:'kimi',clientRequestId:'joined-edit'};
 const first=x.call('/agent/run',body);await began;const second=x.call('/agent/run',body);await new Promise(r=>setTimeout(r,20));release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(b.status,200);assert.deepEqual(a.body,b.body);assert.equal(x.requests.length,4);assert.equal(x.saved().version,2);assert.equal(x.manager.activeCount(),0);
});

test('changed token between read and edit rejects without invoking rich generation or losing current data',async t=>{
 const x=await fixture(t);sequence(x,[route('edit'),read(),()=>{const saved=x.saved();saved.records[0].value=99;saved.version++;x.db.prepare('UPDATE rich_workspaces SET snapshot_json=? WHERE owner=? AND app_id=?').run(JSON.stringify(saved),'alice','visual_one');return revise();}]);
 const result=await x.call('/agent/run',{prompt:'Change the heading',harness:'qwen',selectedAppId:'visual_one',clientRequestId:'stale-token'});
 assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,'application_conflict');assert.equal(x.requests.length,3);assert.equal(x.saved().records[0].value,99);assert.deepEqual(x.saved().tree,initial.tree);
 assert.equal((x.db.prepare('SELECT count(*) n FROM rich_workspace_jobs').get() as any).n,0);
});

test('uncertain native mutation is durably failed and identical request never replays it',async t=>{
 const x=await fixture(t);sequence(x,[route('edit','native_one'),read('native_one'),revise('native_one')]);
 x.setPatch(async()=>{throw Object.assign(new Error('Transport disconnected after dispatch'),{code:'application_unknown'});});
 const body={prompt:'Change the native app heading',selectedAppId:'native_one',harness:'zcode',clientRequestId:'unknown-native'};
 const result=await x.call('/agent/run',body);assert.equal(result.status,500);assert.equal(result.body.code,'application_unknown');assert.equal(x.nativePatches.length,1);
 const again=await x.call('/agent/run',body);assert.equal(again.status,500);assert.equal(again.body.code,'application_unknown');assert.equal(x.nativePatches.length,1);assert.equal(x.requests.length,3);
 assert.equal((x.db.prepare('SELECT status FROM application_management_jobs WHERE request_id=?').get(body.clientRequestId) as any).status,'error');assert.equal(x.manager.activeCount(),0);
});


test('stale HTML token refuses before dispatch and retains the latest package and saved store',async t=>{
 const x=await fixture(t),originalHtml=x.html.html;
 sequence(x,[route('edit','dsh_one'),read('dsh_one'),()=>{x.html.store.score=99;x.html.app.revision++;return revise('dsh_one');}]);
 const result=await x.call('/agent/run',{prompt:'Change the HTML title',selectedAppId:'dsh_one',harness:'codex',clientRequestId:'stale-html'});
 assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,'application_conflict');assert.equal(x.htmlEdits.length,0);assert.equal(x.html.html,originalHtml);assert.equal(x.html.store.score,99);assert.equal(x.requests.length,3);
});


test('new App request clears selected rich context before original create routing',async t=>{
 const x=await fixture(t);sequence(x,[{intent:'create',appIds:[]}]);
 const result=await x.call('/agent/run',{prompt:'Create a separate shopping list application',selectedAppId:'visual_one',appId:'visual_one',harness:'codex',clientRequestId:'create-with-selection'});
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.type,'original-handler');assert.equal(x.passedThrough(),1);
 assert.equal(x.forwardedBodies[0].selectedAppId,undefined);assert.equal(x.forwardedBodies[0].appId,undefined);assert.equal(x.forwardedBodies[0].harness,'codex');assert.equal(x.requests.length,1);
 assert.deepEqual(x.saved(),initial);assert.equal((x.db.prepare('SELECT count(*) n FROM rich_workspace_jobs').get() as any).n,0);assert.equal(x.nativePatches.length,0);assert.equal(x.htmlEdits.length,0);
});

test('weather and ordinary chat remove selected app and explicit old delivery before original desk routing',async t=>{
 const x=await fixture(t);
 for(const [index,prompt] of ['What is the weather in Shanghai today?','Hello, how are you?'].entries()){
  sequence(x,[{intent:'pass',appIds:[]}]);
  const result=await x.call('/agent/run',{prompt,selectedAppId:index?'dsh_one':'visual_one',appId:index?'dsh_one':'visual_one',delivery:index?'html':'workspace',completeApp:true,harness:'kimi',clientRequestId:'chat-with-selection-'+index});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.type,'original-handler');
  const forwarded=x.forwardedBodies[index];for(const field of ['selectedAppId','appId','delivery','completeApp'])assert.equal(forwarded[field],undefined,field);assert.equal(forwarded.prompt,prompt);assert.equal(forwarded.harness,'kimi');
 }
 assert.equal(x.passedThrough(),2);assert.equal(x.requests.length,2);assert.deepEqual(x.saved(),initial);assert.equal((x.db.prepare('SELECT count(*) n FROM rich_workspace_jobs').get() as any).n,0);assert.equal(x.nativePatches.length,0);assert.equal(x.htmlEdits.length,0);
});

test('partial multi-App success retains first receipt after second failure and restart without replay',async t=>{
 const x=await fixture(t);sequence(x,[{intent:'edit',appIds:['visual_one','native_one']},read(),revise(),treeReply,read('native_one'),revise('native_one')]);
 x.setPatch(async()=>{throw Object.assign(new Error('Second edit transport disconnected after dispatch'),{code:'application_unknown'});});
 const body={prompt:'Change the titles of both saved applications, keep all existing data',harness:'codex',clientRequestId:'partial-two-apps'};
 const result=await x.call('/agent/run',body);assert.equal(result.status,500,JSON.stringify(result.body));assert.equal(result.body.code,'application_unknown');
 assert.deepEqual(result.body.attemptedAppIds,['visual_one','native_one']);assert.equal(result.body.completedEdits.length,1);assert.equal(result.body.completedEdits[0].appId,'visual_one');assert.equal(result.body.completedEdits[0].version,2);assert.deepEqual(x.saved().tree,updatedTree);assert.equal(x.nativePatches.length,1);
 const receipt=await x.call('/agent/application-requests/'+body.clientRequestId);assert.equal(receipt.status,200);assert.equal(receipt.body.status,'error');assert.deepEqual(receipt.body.result.completedEdits,result.body.completedEdits);
 assert.equal((await x.call('/agent/application-requests/'+body.clientRequestId,undefined,'bob')).status,404);
 x.restart();const after=await x.call('/agent/application-requests/'+body.clientRequestId);assert.deepEqual(after.body,receipt.body);
 const again=await x.call('/agent/run',body);assert.equal(again.status,500);assert.deepEqual(again.body.completedEdits,result.body.completedEdits);assert.equal(x.requests.length,6);assert.equal(x.nativePatches.length,1);assert.equal(x.saved().version,2);
 // Simulate restart between first durable receipt and outer terminal update.
 x.db.prepare("UPDATE application_management_jobs SET status='running' WHERE request_id=?").run(body.clientRequestId);x.restart();
 const interrupted=await x.call('/agent/application-requests/'+body.clientRequestId);assert.equal(interrupted.body.status,'error');assert.equal(interrupted.body.result.code,'application_interrupted');assert.deepEqual(interrupted.body.result.completedEdits,result.body.completedEdits);assert.deepEqual(interrupted.body.result.attemptedAppIds,['visual_one','native_one']);
 const noReplay=await x.call('/agent/run',body);assert.equal(noReplay.status,409);assert.equal(noReplay.body.code,'application_interrupted');assert.equal(x.nativePatches.length,1);assert.equal(x.requests.length,6);
});
