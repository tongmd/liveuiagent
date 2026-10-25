import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDshNativeInference,nativeDshTask,nativeDshProfilePatch,parseNativeDshAnswer } from '../server/dsh-native-inference.js';
const request={model:'unit-model',messages:[{role:'system',content:'role-one'},{role:'user',content:'a'.repeat(20000)},{role:'assistant',content:'handoff'},{role:'user',content:'preserve-all'}],response_format:{type:'json_object'}};
test('Native DSH transfers every message and schema without truncation and refuses malformed answers',()=>{
  const task=nativeDshTask(request);assert.ok(task.endsWith(JSON.stringify(request)));assert.ok(task.includes('a'.repeat(20000)));
  assert.throws(()=>nativeDshTask(request,10),/context transfer limit/);assert.throws(()=>parseNativeDshAnswer('text {"ok":true}'),/not valid JSON/);assert.throws(()=>parseNativeDshAnswer('[]'),/must be a JSON object/);
  assert.deepEqual(parseNativeDshAnswer('{"state":{"count":2}}'),{state:{count:2}});
  const patch=nativeDshProfilePatch();for(const id of ['tool-bash','tool-fs','tool-web','tool-subagent','session-telemetry-otel'])assert.ok(patch.includes(`- id: ${id}\n  disabled: true`));
});
test('Native DSH uses distinct private role directories, bounded concurrency and removes workspace after completion',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-dsh-test-'));let active=0,max=0;const dirs:string[]=[];const received:any[]=[];
  const transport=createDshNativeInference({root,projectRoot:process.cwd(),command:'unit',maxConcurrent:2,provider:{apiBase:'http://unit',apiKey:'private-unit'},runnerFactory:async config=>{
    assert.deepEqual(config.passEnv,[]);assert.ok(config.args.includes('--patch'));
    return {async run(input){assert.notEqual(input.provider?.apiKey,'private-unit');assert.ok(input.provider?.apiBase.startsWith('http://127.0.0.1:'));assert.ok(!input.task.includes('private-unit'));dirs.push(input.work);received.push(input);assert.equal((await fs.stat(input.home)).mode&0o777,0o700);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,15));active--;return{answer:'{"state":{"count":2}}'};},async dispose(){}};
  }});
  try{const results=await Promise.all(Array.from({length:4},()=>transport.chatCompletion(request)));assert.equal(max,2);assert.equal(new Set(dirs).size,4);assert.equal(received.length,4);assert.ok(received.every(x=>x.task.endsWith(JSON.stringify(request))));assert.equal(results[0].execution.delivery,'native');assert.deepEqual(await fs.readdir(root),[]);}finally{await transport.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('Native DSH absolute budget aborts the real runner instead of retrying or leaving background work',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-dsh-timeout-'));let calls=0,aborted=false,disposed=false;
 const transport=createDshNativeInference({root,projectRoot:process.cwd(),command:'unit',runnerFactory:async()=>({async run({signal}){calls++;signal.throwIfAborted();return await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});},async dispose(){disposed=true;}})});
 try{await assert.rejects(transport.chatCompletion(request,{timeoutMs:500}),/timed out/);assert.equal(calls,1);assert.equal(aborted,true);assert.equal(disposed,true);assert.deepEqual(await fs.readdir(root),[]);}finally{await transport.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('Native DSH never accepts local tool use as a native business operation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-dsh-tool-'));
 const transport=createDshNativeInference({root,projectRoot:process.cwd(),command:'unit',runnerFactory:async()=>({async run({onEvent}){onEvent({type:'tool_call',name:'bash'});return{answer:'{"ok":true}'};},async dispose(){}})});
 try{await assert.rejects(transport.chatCompletion(request),/forbidden local tool/);assert.deepEqual(await fs.readdir(root),[]);}finally{await transport.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('transport disposal waits for an aborted runner and workspace cleanup',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-dsh-dispose-'));let started!:()=>void;const ready=new Promise<void>(r=>started=r);let runnerClosed=false;
 const transport=createDshNativeInference({root,projectRoot:process.cwd(),command:'unit',runnerFactory:async()=>({async run({signal}){started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>{runnerClosed=true;reject(signal.reason);},20),{once:true}));},async dispose(){}})});
 const run=transport.chatCompletion(request);const rejection=assert.rejects(run,/transport closed/);await ready;await transport.dispose();assert.equal(runnerClosed,true);assert.deepEqual(await fs.readdir(root),[]);await rejection;await fs.rm(root,{recursive:true,force:true});
});
