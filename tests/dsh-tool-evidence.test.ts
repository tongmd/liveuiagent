import test from 'node:test';
import assert from 'node:assert/strict';
import {dshToolEvidence} from '../server/complete-apps.js';

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
