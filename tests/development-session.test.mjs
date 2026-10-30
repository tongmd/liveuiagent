import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../frontend/snapshot/development-session.js',import.meta.url),'utf8');
function fixture(storage=new Map()) {
 const selection={harness:'codex',model:'gpt-fixture'};
 const context={window:{},document:{querySelector(selector){return {value:selector.includes('harness')?selection.harness:selection.model};}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}};
 vm.runInNewContext(source,context);return {api:context.window.LiveUIDevelopment,selection,storage};
}
test('same-harness/model continuation survives errors and refresh; ordinary completion clears focus',()=>{
 let f=fixture();const turn=f.api.begin('修改liveUI','request_1');f.api.observe(turn,{jobId:'job_1',developmentConversationId:'dev_1'});
 const failure=new Error('failure');f.api.stopped(turn,failure);assert.equal(failure.jobId,'job_1');assert.equal(failure.developmentConversationId,'dev_1');
 f=fixture(f.storage);assert.equal(f.api.begin('继续','request_2').request.developmentConversationId,'dev_1');assert.equal(f.api.begin('继续，把回复窗口收紧一些','request_detail').request.developmentConversationId,'dev_1');assert.equal(f.api.begin('继续做一个新的清单App','request_new').request.developmentConversationId,undefined);
 f.selection.harness='native';assert.equal(f.api.begin('继续','request_3').request.developmentConversationId,undefined);
 f.selection.harness='codex';f.selection.model='other-model';assert.equal(f.api.begin('继续','request_4').request.developmentConversationId,undefined);
 f.selection.model='gpt-fixture';const normal=f.api.begin('做一个清单','request_5');assert.equal(normal.request.developmentConversationId,undefined);f.api.observe(normal,{type:'app_created'});
 assert.equal(f.api.begin('继续','request_6').request.developmentConversationId,undefined);
});
test('out-of-order jobs preserve newest request and retain older error identity',()=>{
 const {api}=fixture();const a=api.begin('修改liveUI A','a'),b=api.begin('修改liveUI B','b');
 api.observe(b,{jobId:'job_b',developmentConversationId:'dev_b'});api.observe(a,{jobId:'job_a',developmentConversationId:'dev_a'});
 const error=new Error('A failed');api.stopped(a,error);assert.equal(error.jobId,'job_a');assert.equal(api.begin('继续','c').request.developmentConversationId,'dev_b');
});
test('progress-only transport error keeps job identity without claiming success',()=>{
 const {api}=fixture(),turn=api.begin('修改liveUI','request');api.observe(turn,{jobId:'job_1',developmentConversationId:'dev_1'});
 const error=new Error('Network disconnected');api.stopped(turn,error);assert.equal(error.jobId,'job_1');assert.equal(error.clientRequestId,'request');assert.match(error.message,/Network disconnected/);assert.doesNotMatch(error.message,/测试通过/);
});
