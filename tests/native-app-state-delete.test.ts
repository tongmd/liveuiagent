import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {createAppStateAdapter,createInitialAppStateAdapter} from '../server/native-app-state.js';
import {hasLocalReadNameBinding} from '../server/grounding-entities.js';
import {primaryProjectionDeficiencies} from '../server/native-primary-projection.js';
import {withActionDeadline} from '../server/action-deadline.js';
const fields=[{name:'name',type:'string'}];
function setup(t:any){const db=new Database(':memory:');db.exec("CREATE TABLE agent_apps(app_id TEXT,owner TEXT); INSERT INTO agent_apps VALUES('a','alice'),('b','alice'),('a','bob')");t.after(()=>db.close());return{db,adapter:createAppStateAdapter(db,'alice','a',fields,['storage.app','app_state.write'])!};}
const receipt=(api:string,order:number,request:any,response:any)=>({source:'app-state',api,order,request,response,ok:true,executionState:'succeeded',requestSource:'host-bound-app-state-dispatched-arguments'});
test('actual SQLite delete is single owner/app record, read-backed, permission checked and honest on missing',t=>{
 const{db,adapter}=setup(t);for(const [owner,app]of[['alice','a'],['alice','b'],['bob','a']])createAppStateAdapter(db,owner,app,fields,['storage.app','app_state.write'])!.call('app_state.upsert_record',{recordId:'same',values:{name:owner+app}});
 adapter.call('app_state.upsert_record',{recordId:'keep',values:{name:'Keep'}});
 const cap=adapter.capabilities.find(c=>c.apiName==='app_state.delete_record')!;assert.equal(cap.method,'DELETE');assert.deepEqual(cap.requiredParams,['recordId','expectedRevision']);
 const result=adapter.call('app_state.delete_record',{recordId:'same',expectedRevision:1})as any;assert.equal(result.deleted,true);assert.equal(result.operation,'delete-and-read-back');assert.equal(result.record,null);assert.equal((adapter.call('app_state.read_record',{recordId:'same'})as any).record,null);
 assert.deepEqual(adapter.listAll().map(r=>r.recordId),['keep']);assert.equal((db.prepare('SELECT count(*) n FROM native_app_records').get()as any).n,3);
 assert.equal((adapter.call('app_state.delete_record',{recordId:'same',expectedRevision:1})as any).outcome,'not_found');
 for(const permission of [[],['storage.app']]){const read=createAppStateAdapter(db,'alice','a',fields,permission);if(read)assert.throws(()=>read.call('app_state.delete_record',{recordId:'keep',expectedRevision:1}),/Unauthorized/);else assert.equal(read,undefined);}
 const initial=createInitialAppStateAdapter(db,'alice','a',fields,['storage.app','app_state.write'])!;assert.equal(initial.capabilities.length,2);assert(initial.capabilities.every(c=>c.method==='GET'));assert.throws(()=>initial.call('app_state.delete_record',{recordId:'keep',expectedRevision:1}),/Unauthorized/);
 assert.throws(()=>adapter.call('app_state.delete_record',{recordId:'keep',expectedRevision:1,owner:'bob'}),/cannot select/);
});
test('stale revision, delete/recreate ABA, invalid identities and expired deadline cannot delete',async t=>{
 const{adapter}=setup(t);const key='selected';adapter.call('app_state.upsert_record',{recordId:key,values:{name:'One'}});adapter.call('app_state.upsert_record',{recordId:key,values:{name:'Two'}});
 assert.throws(()=>adapter.call('app_state.delete_record',{recordId:key,expectedRevision:1}),/revision conflict/);assert.equal(adapter.listAll()[0].revision,2);
 adapter.call('app_state.delete_record',{recordId:key,expectedRevision:2});adapter.call('app_state.upsert_record',{recordId:key,values:{name:'Recreated'}});assert.equal(adapter.listAll()[0].revision,3);assert.throws(()=>adapter.call('app_state.delete_record',{recordId:key,expectedRevision:2}),/revision conflict/);
 for(const args of [{recordId:key},{recordId:key,expectedRevision:0},{recordId:'',expectedRevision:3},{recordId:key,expectedRevision:3,values:{name:null}}])assert.throws(()=>adapter.call('app_state.delete_record',args));
 await assert.rejects(withActionDeadline(Date.now()-1,async()=>adapter.call('app_state.delete_record',{recordId:key,expectedRevision:3})),/deadline/);assert.equal(adapter.listAll().length,1);
});
test('last-member deletion requires fresh empty first-list proof after every local write; stale names cannot survive delete',t=>{
 const{adapter}=setup(t);const emptyBefore=receipt('app_state.list_records',1,{},adapter.call('app_state.list_records',{}));
 const write=receipt('app_state.upsert_record',2,{recordId:'one',values:{name:'One'}},adapter.call('app_state.upsert_record',{recordId:'one',values:{name:'One'}}));
 const read=receipt('app_state.read_record',3,{recordId:'one'},adapter.call('app_state.read_record',{recordId:'one'}));assert(hasLocalReadNameBinding({name:'One',appRecordId:'one'},[write,read],fields));
 const deletion=receipt('app_state.delete_record',4,{recordId:'one',expectedRevision:1},adapter.call('app_state.delete_record',{recordId:'one',expectedRevision:1}));
 assert.equal(hasLocalReadNameBinding({name:'One',appRecordId:'one'},[write,read,deletion],fields),false);
 assert(primaryProjectionDeficiencies('app_local',[],[emptyBefore,write,read,deletion],fields).some(s=>s.includes('empty first list')));
 const absent=receipt('app_state.read_record',5,{recordId:'one'},adapter.call('app_state.read_record',{recordId:'one'}));assert(primaryProjectionDeficiencies('app_local',[],[write,deletion,absent],fields).some(s=>s.includes('empty first list')));
 const emptyAfter=receipt('app_state.list_records',6,{},adapter.call('app_state.list_records',{}));assert.deepEqual(primaryProjectionDeficiencies('app_local',[],[write,read,deletion,emptyAfter],fields),[]);
 adapter.call('app_state.upsert_record',{recordId:'other',values:{name:'Other'}});const later=receipt('app_state.upsert_record',7,{recordId:'other',values:{name:'Other'}},{source:'app-state'});assert(primaryProjectionDeficiencies('app_local',[],[emptyAfter,later],fields).some(s=>s.includes('empty first list')));
});

test('grounding DELETE remains a verified mutation and separately read empty list clears last-member pending readback',async t=>{
 const{adapter}=setup(t);adapter.call('app_state.upsert_record',{recordId:'one',values:{name:'One'}});
 const{runAppWorldGrounding}=await import('../server/liveuiagent.js');let step=0;let verifierSeen=false;
 const reply=(v:any)=>({choices:[{message:{content:JSON.stringify(v)}}]});
 const output=await runAppWorldGrounding({bridge:{getCapabilities:async()=>[],callTool:async()=>{throw Error('No external effects permitted');}}as any,appState:adapter,permissions:[],payload:{},appName:'Local entries',appPurpose:'Remove exactly the selected local entry',viewContext:{itemLabel:'Entry',primaryMembership:'app_local',perItemActions:[]},llm:{model:'fixture',chatCompletion:async(request,call)=>{
  const label=call!.roleLabel;const input=JSON.parse(request.messages[1].content);
  if(label==='Grounding Requirement Agent')return reply({objective:'Remove the selected local member and verify absence',deliverables:[],expectedNumbers:[]});
  if(label==='Write Verifier Agent'){verifierSeen=true;assert.equal(input.proposedCalls[0].api,'app_state.delete_record');return reply({approved:true});}
  if(label==='Grounding Evaluator Agent'){assert(input.appStateCalls.some((c:any)=>c.api==='app_state.delete_record'&&c.response.deleted===true));return reply({pass:true,deficiencies:[]});}
  assert.equal(label,'AppWorld Grounding Agent');step++;return reply(step===1?{calls:[{api:'app_state.read_record',args:{recordId:'one'}}]}:step===2?{calls:[{api:'app_state.delete_record',args:{recordId:'one',expectedRevision:1}}]}:step===3?{calls:[{api:'app_state.list_records',args:{}}]}:{done:true,summary:'Selected local member removed and empty list read back',entities:[],stats:[{label:'Members',value:'0'}]});
 }}});
 assert.equal(verifierSeen,true);assert.equal(output?.evaluation?.pass,true);assert.deepEqual(adapter.listAll(),[]);assert.equal(output?.appStateCalls.filter(c=>c.api==='app_state.delete_record').length,1);
});

test('lost DELETE reply remains unknown and never auto-replays the actual committed deletion',async t=>{
 const{adapter}=setup(t);adapter.call('app_state.upsert_record',{recordId:'one',values:{name:'One'}});let dispatched=0;const lossy={...adapter,call(api:string,args:Record<string,unknown>){const result=adapter.call(api,args);if(api==='app_state.delete_record'){dispatched++;throw Error('Lost delete reply after commit');}return result;}};
 const{runAppWorldGrounding}=await import('../server/liveuiagent.js');const reply=(v:any)=>({choices:[{message:{content:JSON.stringify(v)}}]});let step=0;
 const output=await runAppWorldGrounding({bridge:{getCapabilities:async()=>[],callTool:async()=>{throw Error('No external calls');}}as any,appState:lossy,permissions:[],payload:{},appName:'Local entries',appPurpose:'Remove selected member',viewContext:{itemLabel:'Entry',primaryMembership:'app_local',perItemActions:[]},llm:{model:'fixture',chatCompletion:async(_request,call)=>{if(call!.roleLabel==='Grounding Requirement Agent')return reply({objective:'Remove selected local member',deliverables:[],expectedNumbers:[]});if(call!.roleLabel==='Write Verifier Agent')return reply({approved:true});if(call!.roleLabel==='Grounding Evaluator Agent')return reply({pass:true,deficiencies:[]});step++;return reply(step<=2?{calls:[{api:'app_state.delete_record',args:{recordId:'one',expectedRevision:1}}]}:step===3?{calls:[{api:'app_state.list_records',args:{}}]}:{done:true,summary:'Observed empty collection, original delete receipt unknown',entities:[],stats:[]});}}});
 assert.equal(dispatched,1);assert.deepEqual(adapter.listAll(),[]);assert.equal(output?.evaluation?.pass,false);assert(output?.appStateCalls.some(c=>c.api==='app_state.delete_record'&&c.executionState==='outcome_unknown'&&c.automaticRetry===false));
});
