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
