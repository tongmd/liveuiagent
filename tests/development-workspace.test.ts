import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDevelopmentWorkspace} from '../server/development-workspace.js';
const exec=promisify(execFile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-development-test-')),source=path.join(dir,'repo');await fs.mkdir(source);await fs.writeFile(path.join(source,'math.mjs'),'export const add=(a,b)=>a-b;\n');await fs.writeFile(path.join(source,'.env'),'PRIVATE=not-for-context');await fs.symlink('/etc/passwd',path.join(source,'link'));for(const args of [['init','-q'],['add','-A','-f'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']])await exec('git',['-C',source,...args]);return {dir,source,root:path.join(dir,'state')};}
async function done(manager:ReturnType<typeof createDevelopmentWorkspace>,owner:string,id:string){for(let i=0;i<500;i++){const job=await manager.getJob(owner,id);if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,10));}throw Error('job remained running');}
const input=(harness='native')=>({owner:'stone',prompt:'Fix add and check it',harness,model:'test-'+harness,clientRequestId:'request-1'});

test('real source edit, trusted test receipts and continuation preserve full conversation',async()=>{
 const f=await fixture();let phase=0,testCalls=0;const messages:any[]=[];
 const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({failure:{appId:'app_a',error:'subtract bug'},production:{sha256:'actual-live-sha'}}),allowedTests:{test:['node','--test','tests/development.test.mjs']},runTest:async({cwd})=>{testCalls++;const {stdout,stderr}=await exec(process.execPath,['--input-type=module','-e',"const m=await import('./math.mjs?'+Date.now()); if(m.add(2,3)!==5)throw Error('bad sum');console.log('5');"],{cwd});return {exitCode:0,stdout,stderr};},infer:async r=>{messages.push(r.messages);phase++;if(phase===1){const payload=JSON.parse(r.messages.at(-1)!.content);assert.equal(payload.runtimeContext.files.length,2);assert.ok(!r.messages.some(m=>m.content.includes('subtract bug')));return JSON.stringify({tool:'read',path:payload.runtimeContext.files[0].chunks[0].path});}if(phase===2){assert.match(r.messages.at(-1)!.content,/subtract bug/);return JSON.stringify({tool:'read',path:'math.mjs'});}if(phase===3){const value=JSON.parse(r.messages.at(-1)!.content).toolResult.result;return JSON.stringify({tool:'edit',path:'math.mjs',expectedSha256:value.sha256,oldText:'a-b',newText:'a+b'});}if(phase===4)return JSON.stringify({tool:'test',commandId:'test'});return JSON.stringify({tool:'finish',summary:'Addition fixed and actual Node test passed'});}});
 try{const j=await m.submit(input());const result=await done(m,'stone',j.id);assert.equal(result.status,'done');assert.equal(result.result?.validation,'passed');assert.equal(result.result?.deployed,false);assert.match(result.result!.diff,/a\+b/);assert.equal(testCalls,1);const c=await m.getConversation('stone',j.conversationId);assert.equal(c.omissions.length,2);assert.ok(c.omissions.some(o=>o.path==='.env'));assert.ok(c.omissions.some(o=>o.path==='link'));for(let n=1;n<messages.length;n++)assert.deepEqual(messages[n].slice(0,messages[n-1].length),messages[n-1]);
 const next=await m.submit({...input(),clientRequestId:'next',conversationId:j.conversationId,prompt:'Explain what changed'});assert.equal((await done(m,'stone',next.id)).status,'done');assert.ok((await m.getConversation('stone',j.conversationId)).messages.length>c.messages.length);assert.equal((await m.getRequest('stone','request-1')).id,j.id);
 }finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('each of six harnesses receives fixed model and per-task inference closure',async()=>{
 const f=await fixture(),seen:string[]=[];const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async()=>{throw Error('default must not run');}});
 try{for(const h of ['native','codex','dsh','qwen','kimi','zcode']){const j=await m.submit({...input(h),clientRequestId:'request-'+h},{infer:async r=>{seen.push(r.harness+':'+r.model);return JSON.stringify({tool:'finish',summary:'Inspected'});}});assert.equal((await done(m,'stone',j.id)).status,'done');}assert.equal(new Set(seen).size,6);}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('denies traversals, source secrets, symlinks, arbitrary tests and context writes',async()=>{
 const f=await fixture();const actions=[{tool:'read',path:'../repo/.env'},{tool:'read',path:'.env'},{tool:'read',path:'/etc/passwd'},{tool:'read',path:'link'},{tool:'test',commandId:'bash'},{tool:'write',path:'context/changed.json',expectedSha256:null,content:'overwrite'}];let n=0;const results:any[]=[];
 const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({value:'immutable'}),infer:async r=>{if(n>0)results.push(JSON.parse(r.messages.at(-1)!.content).toolResult);return JSON.stringify(actions[n++]||{tool:'finish',summary:'Scope checked'});}});
 try{const j=await m.submit(input());assert.equal((await done(m,'stone',j.id)).status,'done');assert.equal(results.length,actions.length);assert.ok(results.every(r=>r.result.error));assert.equal((await fs.readFile(path.join(f.source,'.env'),'utf8')),'PRIVATE=not-for-context');}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('owner isolation, harness binding, duplicate requests and conflicting retries',async()=>{
 const f=await fixture();let calls=0;const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async()=>{calls++;return JSON.stringify({tool:'finish',summary:'done'});}});
 try{const j=await m.submit(input());await done(m,'stone',j.id);assert.equal((await m.submit(input())).id,j.id);assert.equal(calls,1);await assert.rejects(m.getJob('other',j.id),/not found/);await assert.rejects(m.getConversation('other',j.conversationId),/not found/);await assert.rejects(m.submit({...input(),prompt:'different'}),/different task/);await assert.rejects(m.submit({...input(),clientRequestId:'next',conversationId:j.conversationId,harness:'codex'}),/original harness/);assert.equal(m.status('other').activeCount,0);}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('stale or failed tests cannot become passed after an edit',async()=>{
 const f=await fixture();let n=0;const actions=[{tool:'test',commandId:'syntax'},{tool:'edit',path:'math.mjs',expectedSha256:sha('export const add=(a,b)=>a-b;\n'),oldText:'a-b',newText:'a+b'},{tool:'finish',summary:'looks good'}];const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),allowedTests:{syntax:['node','--check']},runTest:async()=>({exitCode:0,stdout:'syntax passed',stderr:''}),infer:async()=>JSON.stringify(actions[n++])});
 try{const j=await m.submit(input());const final=await done(m,'stone',j.id);assert.equal(final.result?.validation,'stale');assert.equal(final.result?.tests.length,1);}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('shutdown preserves transcript without replay and persisted running jobs become interrupted',async()=>{
 const f=await fixture();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async()=>{entered();await new Promise(()=>{});return '';}});
 try{const j=await m.submit(input());await started;assert.equal(m.status().activeCount,1);assert.equal(m.status('other').activeCount,0);await m.dispose();const prior=await m.getJob('stone',j.id);assert.equal(prior.status,'error');const file=path.join(f.root,sha('stone'),'jobs',j.id+'.json');await fs.writeFile(file,JSON.stringify({...prior,status:'running'}));let calls=0;const restarted=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async()=>{calls++;return '{}';}});assert.equal((await restarted.getJob('stone',j.id)).status,'interrupted');assert.equal(calls,0);await restarted.dispose();}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('full large runtime context is retained in indexed chunks outside editable source',async()=>{
 const f=await fixture(),context={long:'汉字🙂'.repeat(160000),empty:null};let captured:any;
 const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>context,infer:async r=>{captured=JSON.parse(r.messages.at(-1)!.content).runtimeContext;return JSON.stringify({tool:'finish',summary:'Context indexed'});}});
 try{const job=await m.submit(input());assert.equal((await done(m,'stone',job.id)).status,'done');const entry=captured.files.find((x:any)=>x.key==='long');assert.ok(entry.chunks.length>1);let text='';for(const chunk of entry.chunks)text+=await fs.readFile(path.join(f.root,sha('stone'),'conversations',job.conversationId,chunk.path),'utf8');assert.equal(JSON.parse(text),context.long);assert.equal(sha(text),entry.sha256);assert.ok(!(await fs.readdir(path.join(f.root,sha('stone'),'conversations',job.conversationId,'source'))).includes('context'));}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('failed test remains failed even when model claims success',async()=>{
 const f=await fixture();let n=0;const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),allowedTests:{test:['node','--test']},runTest:async()=>({exitCode:1,stdout:'',stderr:'Assertion failed'}),infer:async()=>JSON.stringify(n++?{tool:'finish',summary:'Everything passed'}:{tool:'test',commandId:'test'})});
 try{const job=await m.submit(input());const result=await done(m,'stone',job.id);assert.equal(result.result?.validation,'failed');assert.equal(result.result?.tests[0].exitCode,1);assert.equal(result.result?.deployed,false);}finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});
