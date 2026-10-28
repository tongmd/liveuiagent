import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../frontend/snapshot/complete-apps.js',import.meta.url),'utf8');
function sdkFixture(){
 const messages:any[]=[],listeners:any={};let nextTimer=0;const timers=new Map();
 const parent={postMessage:(message:any)=>messages.push(structuredClone(message))};
 const sandbox:any={window:{},parent,document:{addEventListener(){}},addEventListener:(name:string,fn:any)=>listeners[name]=fn,setTimeout:(fn:any)=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:(id:any)=>timers.delete(id),console};
 vm.createContext(sandbox);
 const bootstrap=source.slice(source.indexOf('  function bootstrap('),source.indexOf('  function documentFor('));
 vm.runInContext(bootstrap+`\nbootstrap({tree:'old',draft:'keep'},'fixture-channel');`,sandbox);
 return {sdk:sandbox.window.liveuiagent,messages,reply(index:number,value:any,error?:string){const message=messages[index];listeners.message({source:parent,data:{channel:message.channel,id:message.id,type:'reply',value,error}});}};
}
test('SDK save updates local values only after durable ACK and blocks stale legacy snapshots while pending',async()=>{
 const f=sdkFixture();const save=f.sdk.save('tree','new');assert.equal(f.sdk.storage.getItem('tree'),'old');assert.equal(f.messages.length,1);
 assert.deepEqual(f.messages[0].expected,{tree:'old',draft:'keep'});assert.deepEqual(f.messages[0].store,{tree:'new',draft:'keep'});
 for(const mutate of [()=>f.sdk.storage.setItem('draft','changed'),()=>f.sdk.storage.removeItem('tree'),()=>f.sdk.storage.clear()])assert.throws(mutate,/Wait for saving/);
 await assert.rejects(f.sdk.save('tree','second'),/Wait for saving/);assert.equal(f.messages.length,1,'blocked mutations must not emit a stale snapshot');
 f.reply(0,{ok:true});await save;assert.equal(f.sdk.storage.getItem('tree'),'new');assert.equal(f.sdk.storage.getItem('draft'),'keep');
 f.sdk.storage.setItem('draft','later');assert.equal(f.messages.length,2);assert.deepEqual(f.messages[1].store,{tree:'new',draft:'later'});f.reply(1,{ok:true});
});
test('failed save retains previous local values and permits a new acknowledged attempt',async()=>{
 const f=sdkFixture();const save=f.sdk.save('tree','rejected');const failed=assert.rejects(save,/changed in another window/);
 f.reply(0,null,'Saved data changed in another window');await failed;
 assert.equal(f.sdk.storage.getItem('tree'),'old');assert.equal(f.sdk.storage.getItem('draft'),'keep');
 const retry=f.sdk.save('tree','accepted');assert.deepEqual(f.messages[1].expected,{tree:'old',draft:'keep'});f.reply(1,{ok:true});await retry;assert.equal(f.sdk.storage.getItem('tree'),'accepted');
});
function handlerFixture(){
 const replies:any[]=[],updates:any[]=[];let finishApi!:(value:any)=>void,calls=0;
 const frameWindow={postMessage:(message:any)=>replies.push(message)};
 const sandbox:any={frame:{current:{contentWindow:frameWindow}},key:{current:'channel-1'},jobRef:{current:null},alive:{current:true},writes:{current:Promise.resolve()},appId:'dsh_fixture',
  setStatus:(value:any)=>updates.push(['status',value]),setJob:(value:any)=>updates.push(['job',value]),
  api:()=>{calls++;return new Promise(resolve=>{finishApi=resolve;});},wait:()=>{throw Error('Unexpected polling');}};
 vm.createContext(sandbox);
 const start=source.indexOf('      const handler=async e=>{'),end=source.indexOf("      addEventListener('message',handler)",start);
 vm.runInContext(source.slice(start,end)+'\nthis.invoke=handler;',sandbox);
 return {sandbox,replies,updates,calls:()=>calls,finish:(value:any)=>finishApi(value),invoke:(id:number)=>sandbox.invoke({source:frameWindow,data:{id,type:'ai',channel:sandbox.key.current,prompt:'Layout',context:{}}})};
}
test('second AI request is rejected without clearing the first request lock',async()=>{
 const f=handlerFixture();const first=f.invoke(1);assert.equal(f.sandbox.jobRef.current.pending,true);assert.equal(f.calls(),1);
 await f.invoke(2);assert.equal(f.sandbox.jobRef.current.pending,true);assert.equal(f.calls(),1);assert.match(f.replies[0].error,/Wait for the current task/);
 await f.invoke(3);assert.equal(f.calls(),1,'third request must still be locked');
 f.finish({id:'host_fixture',status:'done',result:{text:'Layout ready'}});await first;
 assert.equal(f.sandbox.jobRef.current,null);assert.equal(f.replies.find((r:any)=>r.id===1).value.text,'Layout ready');
});
