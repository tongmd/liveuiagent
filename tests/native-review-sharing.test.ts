import test from 'node:test';import assert from 'node:assert/strict';
import {projectNativeReviewOutcome,restoreNativeReviewOutcome} from '../server/native-workflow.js';
test('complete repeated review evidence is reversible, retaining unique history and failures',()=>{
 const tools={read:{ok:true,response:{content:'真实观察'.repeat(2000)},dbChanges:{before:{value:0},after:{value:false}}},write:{ok:false,error:'Actual write rejected'}};
 const outcome={originalRequest:{input:'求推演'},toolResults:tools,proposedRuntimeState:{lastActionPayload:{toolResults:tools},uniqueOldFact:'older'},proposedRecords:[{toolResults:tools},{toolResults:{read:{old:'distinct historical evidence'.repeat(100)}}}],grounded:true,persistencePending:true};
 const projected=projectNativeReviewOutcome(outcome);assert.deepEqual(restoreNativeReviewOutcome(projected),outcome);assert.ok(JSON.stringify(projected).length<JSON.stringify(outcome).length/2);assert.equal(outcome.proposedRecords.length,2);
 const tampered=JSON.parse(JSON.stringify(projected));const id=Object.keys(tampered.reviewContextReferences)[0];tampered.reviewContextReferences[id]={fake:true};assert.throws(()=>restoreNativeReviewOutcome(tampered),/SHA mismatch/);
});
test('reserved user fields and unique small contexts are not reinterpreted',()=>{for(const x of [{result:'small'},{result:{$nativeReviewRef:'user value'}},{reviewContextReferences:{user:'data'}}])assert.equal(projectNativeReviewOutcome(x),x);});
test('escaping, equal values at distinct paths, zero/false/null and unique evidence survive exact JSON wire',()=>{
 const repeated=JSON.parse('{"__proto__":{"safe":"not prototype"},"text":"\\\\路径\\n\\\"quote\\\"","nested":[0,false,null,"\\ud800"]}');repeated.padding='evidence\\\\"\n'.repeat(500);
 const original={a:repeated,b:JSON.parse(JSON.stringify(repeated)),different:{...repeated,text:'distinct true observation'},failed:{ok:false,error:'Do not hide'},nan:NaN,missing:undefined};
 const wire=JSON.stringify(original);const projected=projectNativeReviewOutcome(original);assert.equal(JSON.stringify(restoreNativeReviewOutcome(projected)),wire);assert.equal(({} as any).safe,undefined);assert.ok(JSON.stringify(projected).includes('distinct true observation'));
});
test('collision markers anywhere force original representation without interpreting task data',()=>{
 const original={a:{padding:'x'.repeat(5000),$nativeReviewRef:'user-authored r0'},b:{reviewContextEncoding:{version:1,user:'not host'}}};assert.equal(projectNativeReviewOutcome(original),original);
});
