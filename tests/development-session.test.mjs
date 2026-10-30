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
test('deployment labels require an actual receipt and distinguish rollback from completion',()=>{
 const {api}=fixture();
 const result=status=>({developmentConversationId:'dev_1',development:{validation:'passed',deployment:{status}}});
 for(const status of ['queued','checking','validating','reviewing','waiting','blocked','rolled_back','unknown','deployed'])assert.doesNotMatch(api.resultLabel(result(status)),/^已上线$/);
 assert.match(api.resultLabel(result('blocked')),/受阻/);assert.match(api.resultLabel(result('rolled_back')),/已回滚/);
 const released=result('deployed');released.development.deployed=true;released.development.deployment.receipt={status:'deployed',transactionId:'tx_1'};assert.equal(api.resultLabel(released),'已上线');
 released.development.deployment.receipt.status='rolled_back';assert.doesNotMatch(api.resultLabel(released),/^已上线$/);released.development.deployment.receipt={};assert.doesNotMatch(api.resultLabel(released),/^已上线$/);
});
test('new submissions own presentation immediately, even before their first progress',()=>{
 const {api}=fixture(),old=api.begin('修改liveUI','old');api.observe(old,{jobId:'job_old',developmentConversationId:'dev_old'});
 const recent=api.begin('新的普通请求','new');assert.equal(api.canPresent(old),false);assert.equal(api.canPresent(recent),true);
});
test('six unsuccessful GET reconnects stop observing without claiming deployment or resubmitting',async()=>{
 const selection={harness:'codex',model:'gpt-fixture'},storage=new Map(),updates=[];let reads=0;
 const context={window:{},setTimeout:fn=>setTimeout(fn,0),document:{querySelector:selector=>({value:selector.includes('harness')?selection.harness:selection.model})},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}};
 vm.runInNewContext(source,context);const api=context.window.LiveUIDevelopment;
 api.attach({read:async()=>{reads++;throw Object.assign(Error('Restarting'),{status:503})},present:(_turn,_result,label)=>updates.push(label)});
 const turn=api.begin('修改liveUI','r');api.observe(turn,{jobId:'job_1',developmentConversationId:'dev_1'});
 api.follow(turn,{developmentConversationId:'dev_1',development:{deployment:{status:'queued'}}});
 for(let i=0;i<100&&!updates.some(x=>x.includes('刷新可继续'));i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(reads,6);assert(updates.some(x=>x.includes('待核查')));assert(!updates.some(x=>x==='已上线'));
 assert.equal(JSON.parse(storage.values().next().value)['["codex","gpt-fixture"]'].tracking,true);
});
