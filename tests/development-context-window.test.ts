import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDevelopmentWorkspace,developmentInferenceMessages,type DevelopmentMessage} from '../server/development-workspace.js';
const exec=promisify(execFile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const req=(request:string):DevelopmentMessage=>({role:'user',content:JSON.stringify({request,runtimeContext:{readOnly:true,files:[]}})});
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'development-window-')),source=path.join(dir,'repo');await fs.mkdir(source);const content='first\n'+'中文🙂 data\n'.repeat(5000)+'END';await fs.writeFile(path.join(source,'large.txt'),content);for(const args of [['init','-q'],['add','-A'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']])await exec('git',['-C',source,...args]);return {dir,source,content,root:path.join(dir,'state')};}
async function done(m:ReturnType<typeof createDevelopmentWorkspace>,id:string){for(let i=0;i<1000;i++){const j=await m.getJob('test',id);if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,10));}throw Error('job not terminal');}
const input={owner:'test',harness:'codex',model:'gpt-6-astra',prompt:'Original user requirement',clientRequestId:'first'};

test('long transcript stays exact while encoded inference view fits relay limits and pins requirements',()=>{
 const history:DevelopmentMessage[]=[{role:'system',content:'Trusted tool rules'},req('ORIGINAL need A')];
 history.push(req('MIDDLE retain the existing behavior'));for(let i=0;i<400;i++)history.push({role:i%2?'assistant':'user',content:'message-'+i+' '+('中文\\"\n'.repeat(2000))});
 history.push(req('LATEST need B'),{role:'user',content:JSON.stringify({toolResult:{tool:'test',result:{exitCode:1,commandId:'test',sourceHash:'actual-sha',stdout:'x'.repeat(200000)}}})});
 const before=JSON.stringify(history),view=developmentInferenceMessages(history);
 assert.ok(Buffer.byteLength(before)>8*1024*1024);assert.equal(JSON.stringify(history),before);assert.ok(view.length<=128);assert.ok(Buffer.byteLength(JSON.stringify(view))<=512*1024);
 const wire=JSON.stringify({model:'gpt-6-astra',messages:view,response_format:{type:'json_object'},tools:[]});assert.ok(Buffer.byteLength(wire)<2*1024*1024);
 assert.match(wire,/ORIGINAL need A/);assert.match(wire,/LATEST need B/);assert.match(wire,/includedMessageIndices/);assert.match(wire,/testReceipt/);assert.match(wire,/exitCode/);assert.match(view[0].content,/history/);const notice=JSON.parse(view.at(-1)!.content).historyView;assert.equal(notice.totalRequestCount,3);assert.equal(notice.omittedRequestCount,1);assert.match(notice.notice,/intermediate corrections/);
});

test('oversized original/current requests are explicitly paged, never silently discarded',()=>{
 const history:DevelopmentMessage[]=[{role:'system',content:'rules'},req('原'.repeat(100000)),req('新'.repeat(100000))];const view=developmentInferenceMessages(history);
 assert.ok(Buffer.byteLength(JSON.stringify(view))<=512*1024);const clipped=view.filter(m=>m.content.includes('archivedMessage')).map(m=>JSON.parse(m.content));assert.equal(clipped.length,2);assert.deepEqual(clipped.map(c=>c.archivedMessage),[1,2]);for(const c of clipped){assert.ok(c.nextOffset>0&&c.nextOffset<c.totalChars);assert.equal(c.contentPart,history[c.archivedMessage].content.slice(0,c.nextOffset));}
});

test('continued legacy transcript over 8 MiB recovers without replay; history paging and file paging retain full SHA/content',async()=>{
 const f=await fixture();let phase=0;let view:DevelopmentMessage[]=[];const results:any[]=[];const m=createDevelopmentWorkspace({root:f.root,sourceRoot:f.source,runtimeContext:async()=>({}),infer:async r=>{view=r.messages;if(phase===0)return JSON.stringify({tool:'finish',summary:'Initial read only'});
  const actions=[{tool:'history',messageIndex:2,offset:0,maxChars:7},{tool:'history',onlyRequests:true,startIndex:0,limit:1},{tool:'read',path:'large.txt',offset:0,maxChars:10000},{tool:'read',path:'large.txt',offset:10000,maxChars:32000},{tool:'history',messageIndex:999999},{tool:'finish',summary:'Archived context readable'}];return JSON.stringify(actions[phase++-1]);}});
 try{const j=await m.submit(input);assert.equal((await done(m,j.id)).status,'done');const file=path.join(f.root,sha('test'),'conversations',j.conversationId,'conversation.json');const c=JSON.parse(await fs.readFile(file,'utf8'));const original=c.messages.map((m:DevelopmentMessage)=>({...m}));for(let i=0;i<300;i++)c.messages.push({role:'user',content:'Archived '+i+' '+('x'.repeat(30000))});await fs.writeFile(file,JSON.stringify(c));const before=JSON.stringify(c.messages);phase=1;
  const next=await m.submit({...input,clientRequestId:'continued',conversationId:j.conversationId,prompt:'LATEST preserve all data'});const final=await done(m,next.id);assert.equal(final.status,'done');assert.ok(Buffer.byteLength(JSON.stringify(view))<=512*1024);const after=await m.getConversation('test',j.conversationId);results.push(...after.messages.slice(c.messages.length).filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content);}catch{return {};}}).filter(v=>v.toolResult).map(v=>v.toolResult.result));assert.equal(JSON.stringify(after.messages.slice(0,c.messages.length)),before);assert.deepEqual(after.messages.slice(0,original.length),original);assert.match(JSON.stringify(view),/LATEST preserve all data/);assert.equal(results[0].content,c.messages[2].content.slice(0,7));assert.equal(results[0].nextOffset,7);
  assert.equal(results[1].onlyRequests,true);assert.equal(results[1].messages.length,1);assert.equal(results[1].messages[0].messageIndex,2);assert.equal(results[1].nextIndex,3);assert.equal(results[2].sha256,sha(f.content));assert.equal(results[2].content,f.content.slice(0,10000));assert.equal(results[2].nextOffset,10000);assert.equal(results[3].sha256,sha(f.content));assert.equal(results[3].content,f.content.slice(10000,42000));assert.match(results[4].error,/Invalid transcript/);await assert.rejects(m.getConversation('other',j.conversationId),/not found/);
 }finally{await m.dispose();await fs.rm(f.dir,{recursive:true,force:true});}
});


test('inference adapters cannot mutate durable history through either view path',()=>{
 for(const count of [2,300]){const history:DevelopmentMessage[]=[{role:'system',content:'rules'},req('ORIGINAL')];for(let i=0;i<count;i++)history.push({role:'user',content:'entry '+i});const before=JSON.stringify(history),view=developmentInferenceMessages(history);for(const message of view)message.content='adapter mutation';assert.equal(JSON.stringify(history),before);}
});
