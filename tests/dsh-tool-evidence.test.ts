import test from 'node:test';
import assert from 'node:assert/strict';
import {dshToolEvidence,dshServiceContext,dshGroundingPayload} from '../server/complete-apps.js';

test('trusted evidence retains native workflow attempts, executed calls, and rejected review without inventing success',()=>{
 const call:any={tool:{id:'tool.appworld.simple_note.update_note'},request:{id:42},response:{id:42},dbChanges:{changedApps:[{appName:'simple_note',delta:1}]}};
 const grounded:any={calls:[call],goal:{objective:'Update specified note'},attempts:[{api:'update_note',ok:true}],evaluation:{pass:false,deficiencies:['Read-back not satisfied']}};
 const evidence=dshToolEvidence('dsh_test',grounded);
 assert.equal(evidence.appId,'dsh_test');
 assert.match(evidence.trace[0].agent,/Orchestrator/);
 assert.equal(evidence.trace[0].status,'rejected');
 assert.equal(evidence.trace[0].output.attempts,grounded.attempts);
 assert.equal(evidence.toolResults['tool.appworld.simple_note.update_note#1'],call);
 assert.deepEqual(evidence.toolDbChanges,[{appName:'simple_note',delta:1}]);
});

 test('generation capabilities describe actual connected services and require the host bridge without benchmark answers',()=>{
 const services=[{name:'simple_note',description:'Notes service'}];
 const context=dshServiceContext(services);
 assert.deepEqual(context.connectedServices,services);
 assert.match(context.serviceExecutionContract,/window.liveuiagent.ai/);
 assert.match(context.serviceExecutionContract,/returned text\/data/);
 assert.doesNotMatch(JSON.stringify(context),/reading-log|expectedBehavior|episode/);
 });

 test('grounding receives complete user context without promoting app-controlled audit claims or overwriting request',()=>{
 const payload=dshGroundingPayload('Move book',{title:'Tomorrow, and Tomorrow, and Tomorrow',finishedAt:'2026-10-25',evidence:{success:true},toolResults:{fake:true}},{request:'override',date:'2026-10-25'});
 assert.equal(payload.request,'Move book');
 assert.match(payload.applicationContext!,/Tomorrow, and Tomorrow, and Tomorrow/);
 assert.match(payload.applicationContext!,/2026-10-25/);
 assert.match(payload.applicationContext!,/^Unverified user application inputs/);
 assert.doesNotMatch(payload.applicationContext!,/success|toolResults/);
 assert.throws(()=>dshGroundingPayload('x',{text:'a'.repeat(50001)},{}),/50 KB/);
 });

test('host completed actions survive store recreation, keep actual results, and remain owner scoped',async()=>{
 const {default:Database}=await import('better-sqlite3');
 const {createHostActionStore}=await import('../server/complete-apps.js');
 const db=new Database(':memory:');
 try{
  const grounded:any={calls:[],goal:{objective:'Read records'},attempts:[],evaluation:{pass:true,deficiencies:[]},summary:'Observed note',entities:[{name:'Book'}],stats:[]};
  const job=createHostActionStore(db).save('alice','dsh_app',grounded,'chosen-model');
  assert.equal(job.status,'done');assert.equal(job.execution.actionRuntime,'host-appworld');
  assert.equal(job.result.text,'Observed note');assert.equal(job.result.ok,true);assert.equal(job.result.status,'succeeded');
  const rejected=createHostActionStore(db).save('alice','dsh_app',{...grounded,evaluation:{pass:false,deficiencies:['Read-back absent']}},'chosen-model');
  assert.equal(rejected.status,'done');assert.equal(rejected.result.ok,false);assert.equal(rejected.result.status,'not_verified');assert.equal(rejected.result.error,'Read-back absent');assert.deepEqual(rejected.result.data.entities,grounded.entities);assert.equal(rejected.evidence.trace[0].status,'rejected');
  assert.deepEqual(createHostActionStore(db).load('alice',job.id),job);
  assert.equal(createHostActionStore(db).load('bob',job.id),undefined);
 }finally{db.close();}
});

test('service bindings persist by owner and published generation revision without activating failed pending revisions',async()=>{
 const {default:Database}=await import('better-sqlite3');const {createDshServiceBindings}=await import('../server/complete-apps.js');const db=new Database(':memory:');
 try{
  const store=createDshServiceBindings(db),notes={services:['simple_note'],permissions:['tool.appworld.simple_note.update_note']},multi={services:['simple_note','todoist'],permissions:['tool.appworld.simple_note.update_note','tool.appworld.todoist.create_task']};
  store.save('alice','dsh_app','original',notes,'Original complete request');
  assert.deepEqual(store.load('alice','dsh_app','original',1),notes);
  store.save('alice','dsh_app','pending',multi,'Revision adds tasks');
  assert.deepEqual(createDshServiceBindings(db).load('alice','dsh_app','original',1),notes);
  assert.equal(store.load('bob','dsh_app','original',1),undefined);
  assert.equal(store.load('alice','dsh_app','original',2),undefined);
  assert.deepEqual(store.load('alice','dsh_app','pending',2),multi);
  store.save('alice','dsh_local','local',{services:[],permissions:[]},'Local counter');assert.deepEqual(store.load('alice','dsh_local','local',1),{services:[],permissions:[]});
 }finally{db.close();}
});
