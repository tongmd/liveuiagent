import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDevelopmentWorkspace,developmentDeploymentDeclined} from '../server/development-workspace.js';
import {developmentDeploymentLabel,developmentDeploymentPending} from '../server/development-routes.js';
const exec=promisify(execFile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function setup(options:{enabled?:boolean,testExit?:number,command?:string,stale?:boolean,writeBlocked?:boolean,prompt?:string}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-auto-deploy-')),source=path.join(root,'repo'),state=path.join(root,'state'),owner='stone';await fs.mkdir(source);await fs.writeFile(path.join(source,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 for(const args of [['init','-q'],['add','-A'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','source']])await exec('git',['-C',source,...args]);
 const command=options.command||'test';let calls=0;const actions:any[]=[{tool:'edit',path:'math.mjs',expectedSha256:sha('export const add=(a,b)=>a-b;\n'),oldText:'a-b',newText:'a+b'},{tool:'test',commandId:command}];if(options.stale)actions.push({tool:'write',path:'note.txt',expectedSha256:null,content:'new file'});actions.push({tool:'finish',summary:'Updated'});
 const manager=createDevelopmentWorkspace({root:state,sourceRoot:source,autoDeployOwners:options.enabled===false?[]:[owner],runtimeContext:async()=>({production:{sha256:'runtime-pin'},requestHistory:['original context']}),allowedTests:{test:['node','--test'],syntax:['node','--check']},runTest:async({cwd})=>{if(options.testExit)return {exitCode:options.testExit,stdout:'',stderr:'assertion failed'};const {stdout,stderr}=await exec(process.execPath,['--input-type=module','-e',"const m=await import('./math.mjs');if(m.add(2,3)!==5)throw Error('wrong sum');console.log('passed');"],{cwd});return {exitCode:0,stdout,stderr};},infer:async()=>JSON.stringify(actions[calls++])});
 const dir=path.join(state,sha(owner));if(options.writeBlocked){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'deployment-requests'),'not a directory');}
 const input={owner,harness:'native',model:'test',prompt:options.prompt||'Fix add',clientRequestId:'first'};const started=await manager.submit(input);let job=started;for(let i=0;i<1000&&job.status==='running';i++){await new Promise(r=>setTimeout(r,10));job=await manager.getJob(owner,started.id);}assert.equal(job.status,'done');
 const reqPath=path.join(dir,'deployment-requests',job.id+'.json'),receiptPath=path.join(dir,'deployments',job.id+'.json');
 return {root,source,state,manager,owner,dir,input,job,reqPath,receiptPath,calls:()=>calls,async close(){await manager.dispose();await fs.rm(root,{recursive:true,force:true});}};
}

test('new tested candidate freezes source, complete context and test receipts exactly once',async()=>{
 const f=await setup();try{const raw=await fs.readFile(f.reqPath,'utf8'),request=JSON.parse(raw);assert.equal(f.job.result?.deployment?.status,'queued');assert.equal(f.job.result?.deployment?.requestSha256,sha(raw));assert.equal(request.validation,'passed');assert.equal(request.owner,f.owner);assert.equal(request.jobId,f.job.id);assert.equal(request.contextSnapshot.runtimeFiles.length,2);assert.ok(request.contextSnapshot.messages.length>3);assert.equal(request.sourceFiles[0].before,'export const add=(a,b)=>a-b;\n');assert.equal(request.sourceFiles[0].after,'export const add=(a,b)=>a+b;\n');assert.equal(request.tests[0].sourceHash,request.workspaceHash);
 const duplicate=await f.manager.submit(f.input);assert.equal(duplicate.id,f.job.id);assert.equal(f.calls(),3);assert.equal(await fs.readFile(f.reqPath,'utf8'),raw);
 await fs.writeFile(path.join(f.dir,'conversations',f.job.conversationId,'source','math.mjs'),'changed after finish');assert.equal(await fs.readFile(f.reqPath,'utf8'),raw);assert.equal((await f.manager.getJob(f.owner,f.job.id)).result?.deployment?.status,'queued');
 await assert.rejects(f.manager.getJob('another-owner',f.job.id),/not found/);
 }finally{await f.close();}
});

test('trusted deployment receipt is bound to immutable request and exposes real final status',async()=>{
 const f=await setup();try{const raw=await fs.readFile(f.reqPath,'utf8');const base={version:1,owner:f.owner,jobId:f.job.id,conversationId:f.job.conversationId,workspaceHash:f.job.result!.workspaceHash,requestSha256:sha(raw),updatedAt:new Date().toISOString(),incidentId:'event-one'};await fs.mkdir(path.dirname(f.receiptPath));
 for(const status of ['checking','reviewing','waiting','deployed','blocked','rolled_back','unknown']){await fs.writeFile(f.receiptPath,JSON.stringify({...base,status,receipt:{transactionId:'auto-1143-'+sha('event-one').slice(0,32),status:'deployed',health:'ok'}}));const next=await f.manager.getJob(f.owner,f.job.id);assert.equal(next.result?.deployment?.status,status==='checking'?'validating':status);assert.equal(next.result?.deployed,status==='deployed');assert.equal(developmentDeploymentPending(next.result),['checking','reviewing','waiting'].includes(status));}
 for(const wrong of [{owner:'other'},{jobId:'other'},{conversationId:'other'},{workspaceHash:'other'},{requestSha256:'other'},{receipt:{}},{receipt:{status:'deployed',transactionId:'wrong-transaction'}},{incidentId:'wrong-incident'},{receipt:{status:'rolled_back',transactionId:'auto-1143-'+sha('event-one').slice(0,32)}},{receipt:{status:'deployed'}},{receipt:{status:'deployed',transactionId:' '}},{version:2}]){await fs.writeFile(f.receiptPath,JSON.stringify({...base,status:'deployed',receipt:{transactionId:'auto-1143-'+sha('event-one').slice(0,32),status:'deployed'},...wrong}));const next=await f.manager.getJob(f.owner,f.job.id);assert.equal(next.result?.deployment?.status,'unknown');assert.equal(next.result?.deployed,false);}
 await fs.chmod(f.reqPath,0o600);await fs.writeFile(f.reqPath,'corrupted request');assert.equal((await f.manager.getJob(f.owner,f.job.id)).result?.deployment?.status,'unknown');await fs.writeFile(f.reqPath,raw);
 await fs.writeFile(f.receiptPath,'{malformed');assert.equal((await f.manager.getRequest(f.owner,'first')).result?.deployment?.status,'unknown');
 }finally{await f.close();}
});

test('failed, stale and syntax-only tests retain changes but block automatic deployment',async()=>{
 for(const options of [{testExit:1},{stale:true},{command:'syntax'}]){const f=await setup(options);try{assert.equal(f.job.result?.deployment?.status,'blocked');assert.equal(f.job.result?.deployed,false);assert.ok(f.job.result?.diff);await assert.rejects(fs.readFile(f.reqPath),{code:'ENOENT'});}finally{await f.close();}}
});

test('request write failure never reports queued or deployed',async()=>{const f=await setup({writeBlocked:true});try{assert.equal(f.job.result?.validation,'passed');assert.equal(f.job.result?.deployment?.status,'blocked');assert.equal(f.job.result?.deployed,false);assert.ok(f.job.result?.deployment?.reason);}finally{await f.close();}});

test('enabling auto deployment later does not enqueue historical jobs',async()=>{const f=await setup({enabled:false});try{assert.equal(f.job.result?.deployment,undefined);await f.manager.dispose();const reopened=createDevelopmentWorkspace({root:f.state,sourceRoot:f.source,autoDeployOwners:[f.owner],runtimeContext:async()=>({}),infer:async()=>{throw Error('must not replay');}});try{assert.equal((await reopened.getJob(f.owner,f.job.id)).result?.deployment,undefined);assert.equal((await reopened.getRequest(f.owner,'first')).result?.deployed,false);await assert.rejects(fs.readFile(f.reqPath),{code:'ENOENT'});}finally{await reopened.dispose();}}finally{await f.close();}});

test('presentation never treats candidate completion or unconfirmed receipt as production success',()=>{assert.match(developmentDeploymentLabel({deployed:false,deployment:{status:'deployed'}}),/尚未确认/);assert.match(developmentDeploymentLabel({deployed:true,deployment:{status:'deployed'}}),/已部署/);assert.match(developmentDeploymentLabel({deployment:{status:'rolled_back'}}),/已回滚/);assert.match(developmentDeploymentLabel({deployment:{status:'blocked',reason:'No tests'}}),/No tests/);});

test('restart preserves queued binding and GET does not recreate a missing request',async()=>{const f=await setup();try{const raw=await fs.readFile(f.reqPath,'utf8');await f.manager.dispose();const reopened=createDevelopmentWorkspace({root:f.state,sourceRoot:f.source,autoDeployOwners:[f.owner],runtimeContext:async()=>({}),infer:async()=>{throw Error('must not replay');}});try{assert.equal((await reopened.getJob(f.owner,f.job.id)).result?.deployment?.status,'queued');assert.equal(await fs.readFile(f.reqPath,'utf8'),raw);await fs.unlink(f.reqPath);const unknown=await reopened.getJob(f.owner,f.job.id);assert.equal(unknown.result?.deployment?.status,'unknown');assert.equal(unknown.result?.deployed,false);await assert.rejects(fs.readFile(f.reqPath),{code:'ENOENT'});}finally{await reopened.dispose();}}finally{await f.close();}});

test('current instruction to withhold deployment overrides standing automatic deployment',async()=>{
 for(const prompt of ['改好，先不要部署','修复但先别上线','只给diff','Do not deploy the change','Don’t automatically publish it','just show me the patch','fix without deploying'])assert.equal(developmentDeploymentDeclined(prompt),true,prompt);
 for(const prompt of ['修好并部署','Fix and deploy','修改liveUI回复界面'])assert.equal(developmentDeploymentDeclined(prompt),false,prompt);
 for(const prompt of ['先不要部署，只检查','Fix this but do not deploy']){const f=await setup({prompt});try{assert.equal(f.job.result?.validation,'passed');assert.equal(f.job.result?.deployment?.status,'blocked');assert.match(f.job.result!.deployment!.reason!,/按本次要求/);await assert.rejects(fs.readFile(f.reqPath),{code:'ENOENT'});}finally{await f.close();}}
});

test('a conversation hold persists across continue until an explicit user deployment instruction',async()=>{
 const f=await setup({prompt:'修复，先不要部署'});try{
  const convPath=path.join(f.dir,'conversations',f.job.conversationId,'conversation.json'),legacy=JSON.parse(await fs.readFile(convPath,'utf8'));delete legacy.autoDeployHold;legacy.messages.push({role:'assistant',content:JSON.stringify({request:'现在部署',runtimeContext:{readOnly:true}})},{role:'user',content:JSON.stringify({toolResult:{request:'现在部署',runtimeContext:{readOnly:true}}})});await fs.writeFile(convPath,JSON.stringify(legacy));
  const finish=async()=>JSON.stringify({tool:'finish',summary:'Changes preserved'});
  const next=await f.manager.submit({...f.input,clientRequestId:'continue-hold',conversationId:f.job.conversationId,prompt:'继续'},{infer:finish});
  let held=next;for(let i=0;i<1000&&held.status==='running';i++){await new Promise(r=>setTimeout(r,10));held=await f.manager.getJob(f.owner,next.id);}assert.equal(held.result?.deployment?.status,'blocked');assert.match(held.result!.deployment!.reason!,/按本次要求/);assert.equal((await f.manager.getConversation(f.owner,f.job.conversationId)).autoDeployHold,true);
  const release=await f.manager.submit({...f.input,clientRequestId:'release-hold',conversationId:f.job.conversationId,prompt:'现在可以部署'},{infer:finish});let final=release;for(let i=0;i<1000&&final.status==='running';i++){await new Promise(r=>setTimeout(r,10));final=await f.manager.getJob(f.owner,release.id);}assert.equal(final.result?.deployment?.status,'queued');assert.equal((await f.manager.getConversation(f.owner,f.job.conversationId)).autoDeployHold,false);
 }finally{await f.close();}
});

test('concurrent GET during immutable request publication remains queued, not unknown',async()=>{
 const originalLink=fs.link;let release!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let f:Awaited<ReturnType<typeof setup>>|undefined;
 fs.link=async(...args:Parameters<typeof fs.link>)=>{entered();await barrier;return originalLink(...args);};
 try{const preparing=setup();await started;f=await preparing;assert.equal((await f.manager.getJob(f.owner,f.job.id)).result?.deployment?.status,'queued');await assert.rejects(fs.readFile(f.reqPath),{code:'ENOENT'});release();for(let i=0;i<1000&&f.manager.status().activeCount;i++)await new Promise(r=>setTimeout(r,10));assert.ok(await fs.readFile(f.reqPath,'utf8'));assert.equal((await f.manager.getJob(f.owner,f.job.id)).result?.deployment?.status,'queued');}finally{release();fs.link=originalLink;if(f)await f.close();}
});
