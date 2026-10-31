import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDevelopmentWorkspace} from '../server/development-workspace.js';
const exec=promisify(execFile);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'development-admission-')),source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'code.mjs'),'export const ok=true;');for(const args of [['init','-q'],['add','-A'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']])await exec('git',['-C',source,...args]);return {dir,source,root:path.join(dir,'state')};}
const input={owner:'test',harness:'codex',model:'gpt-6-astra',prompt:'Inspect the source',clientRequestId:'first'};
async function terminal(m:ReturnType<typeof createDevelopmentWorkspace>,id:string){for(let i=0;i<1000;i++){const j=await m.getJob(input.owner,id);if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,10));}throw Error('Job not terminal');}

test('preparation is synchronously visible, queued duplicate is counted and capacity excludes itself',async()=>{
 const f=await fixture(),contextEntered=deferred(),contextRelease=deferred(),inferenceEntered=deferred(),inferenceRelease=deferred();let calls=0;
 const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,maxConcurrent:1,runtimeContext:async()=>{contextEntered.resolve();await contextRelease.promise;return {};},infer:async()=>{calls++;inferenceEntered.resolve();await inferenceRelease.promise;return JSON.stringify({tool:'finish',summary:'Inspected'});}});
 try{const first=m.submit(input);assert.equal(m.status().activeCount,1);assert.equal(m.status().preparingCount,1);assert.equal(m.status('other').activeCount,0);await contextEntered.promise;assert.equal(m.status().inferenceCount,0);const duplicate=m.submit(input);assert.equal(m.status().preparingCount,2);contextRelease.resolve();const job=await first;await inferenceEntered.promise;assert.equal((await duplicate).id,job.id);assert.equal(m.status().preparingCount,0);assert.equal(m.status().activeCount,1);assert.equal(calls,1);
 await assert.rejects(m.submit({...input,clientRequestId:'busy'}),/busy/);assert.equal(m.status().preparingCount,0);assert.equal(m.status().activeCount,1);inferenceRelease.resolve();assert.equal((await terminal(m,job.id)).status,'done');await m.dispose();assert.equal(m.status().activeCount,0);
 }finally{contextRelease.resolve();inferenceRelease.resolve();await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('preparation errors release admission and dispose cannot launch a model after context returns',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let inferenceCalls=0;const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>{entered.resolve();await release.promise;return {};},infer:async()=>{inferenceCalls++;return JSON.stringify({tool:'finish',summary:'Unexpected'});}});
 try{const pending=m.submit(input);const rejected=assert.rejects(pending,/stopped during preparation/);await entered.promise;let disposed=false;const closing=m.dispose().then(()=>{disposed=true;});await Promise.resolve();assert.equal(disposed,false);assert.equal(m.status().preparingCount,1);release.resolve();await rejected;await closing;assert.equal(inferenceCalls,0);assert.equal(m.status().activeCount,0);await assert.rejects(m.submit({...input,clientRequestId:'after-close'}),/closed/);assert.equal(m.status().preparingCount,0);
 }finally{release.resolve();await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
 const g=await fixture(),failed=createDevelopmentWorkspace({root:g.root,sourceRoot:g.source,runtimeContext:async()=>{throw Error('context capture failed');},infer:async()=>{throw Error('must not infer');}});try{await assert.rejects(failed.submit(input),/context capture failed/);assert.equal(failed.status().activeCount,0);assert.equal(failed.status().preparingCount,0);}finally{await failed.dispose();await fs.rm(g.dir,{recursive:true,force:true});}
});

test('dispose during final request persistence records interruption without orphan inference or replay',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let inferenceCalls=0;const rename=fs.rename;const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async()=>{inferenceCalls++;return JSON.stringify({tool:'finish',summary:'Unexpected'});}});
 fs.rename=async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1]).startsWith(f.root)&&String(args[1]).endsWith('/requests.json')){entered.resolve();await release.promise;}return rename(...args);};
 try{const pending=m.submit(input);await entered.promise;assert.equal(m.status().preparingCount,1);const closing=m.dispose();release.resolve();const job=await pending;await closing;assert.equal(job.status,'interrupted');assert.equal(inferenceCalls,0);assert.equal((await m.getRequest(input.owner,input.clientRequestId)).id,job.id);assert.equal((await m.getJob(input.owner,job.id)).status,'interrupted');assert.equal(m.status().activeCount,0);
 }finally{release.resolve();fs.rename=rename;await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});
