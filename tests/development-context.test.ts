import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createDevelopmentContext,cleanDevelopmentContext} from '../server/development-context.js';

test('development context retains complete owned Native execution and pins running source separately',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dev-context-'));
 const db=new Database(':memory:');
 try{
  fs.mkdirSync(path.join(tmp,'dist-server/server'),{recursive:true});fs.writeFileSync(path.join(tmp,'dist-server/server/index.js'),'console.log("actual runtime");');
  db.exec(`CREATE TABLE agent_apps(app_id TEXT,owner TEXT,name TEXT,description TEXT,version TEXT,updated_at TEXT);
  CREATE TABLE agent_workflow_execution_steps(id INTEGER,owner TEXT,app_id TEXT,input_json TEXT,output_json TEXT);
  CREATE TABLE agent_action_audit(id INTEGER,app_id TEXT,result_json TEXT);
  CREATE TABLE chat_history(id INTEGER,owner TEXT,text TEXT);`);
  db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('a','alice','A','owned','1','now');
  db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('b','bob','B','other','1','now');
  db.prepare('INSERT INTO agent_workflow_execution_steps VALUES (?,?,?,?,?)').run(1,'alice','a',JSON.stringify({prompt:'x'.repeat(14000)}),JSON.stringify({modelOutput:'original failed answer'}));
  db.prepare('INSERT INTO agent_workflow_execution_steps VALUES (?,?,?,?,?)').run(2,'bob','b','other secret','other secret');
  db.prepare('INSERT INTO agent_action_audit VALUES (?,?,?)').run(1,'a','real action');
  db.prepare('INSERT INTO chat_history VALUES (?,?,?)').run(1,'alice','own history');
  db.prepare('INSERT INTO chat_history VALUES (?,?,?)').run(2,'bob','other secret');
  const capture=createDevelopmentContext(db,{runtimeRoot:tmp,memoryOf:()=>[{preference:'compact'}]});
  const context=await capture('alice','a');
  assert.equal(context.executionHistory.length,1);assert.equal(context.executionHistory[0].input_json.prompt.length,14000);
  assert.equal(context.executionHistory[0].output_json.modelOutput,'original failed answer');
  assert.equal(context.runtime[0].content,'console.log("actual runtime");');assert.match(context.runtime[0].sha256,/^[0-9a-f]{64}$/);
  assert.equal(context.chatHistory.length,1);assert(!JSON.stringify(context).includes('other secret'));
  const cross=await capture('alice','b');assert.equal(cross.executionHistory.length,0);assert.equal(cross.application.native.length,0);assert.equal(cross.actionHistory.length,0);
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('context redacts structured and repeated secrets and image bodies without removing ordinary history',()=>{
 const clean=cleanDevelopmentContext({apiKey:'private-value-12345',log:'copied private-value-12345',nested:JSON.stringify({authorization:'Bearer ABC12345678',data:'data:image/png;base64,XXXX',prompt:'please change the layout'})});
 assert(!JSON.stringify(clean).includes('private-value'));assert(!JSON.stringify(clean).includes('ABC123'));assert(!JSON.stringify(clean).includes('base64,XXXX'));assert.equal(clean.nested.prompt,'please change the layout');
});

test('HTML context includes only the selected owner app, full job files and host action history',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dev-html-context-'));const db=new Database(':memory:');
 try{
  const root=path.join(tmp,'accounts');fs.mkdirSync(root);
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const id='11111111-2222-3333-4444-555555555555',app='dsh_'+id;
  db.exec(`CREATE TABLE complete_apps(owner TEXT,app_id TEXT,info_json TEXT);CREATE TABLE complete_host_actions(owner TEXT,app_id TEXT,result_json TEXT);CREATE TABLE complete_service_bindings(owner TEXT,app_id TEXT,plan_json TEXT);CREATE TABLE chat_history(owner TEXT,id INTEGER,text TEXT);`);
  for(const owner of ['alice','bob']){
   db.prepare('INSERT INTO complete_apps VALUES (?,?,?)').run(owner,app,JSON.stringify({name:owner==='alice'?'Owned HTML':'OTHER_OWNER'}));
   db.prepare('INSERT INTO complete_host_actions VALUES (?,?,?)').run(owner,app,JSON.stringify({prompt:owner==='alice'?'actual action':'OTHER_OWNER'}));
   db.prepare('INSERT INTO complete_service_bindings VALUES (?,?,?)').run(owner,app,JSON.stringify({service:owner==='alice'?'notes':'OTHER_OWNER'}));
  }
  for(const account of ['alice','liveuiagent:alice','bob']){
   const dir=path.join(root,hash(account));fs.mkdirSync(path.join(dir,'apps',id),{recursive:true});fs.mkdirSync(path.join(dir,'runs','run-1','work'),{recursive:true});
   fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({apps:[{id,name:'App '+account},{id:'other-app',name:'UNRELATED_APP'}],jobs:[{id:'run-1',appId:id,prompt:'full original '+account},{id:'other-job',appId:'other-app',prompt:'UNRELATED_JOB'}]}));
   fs.writeFileSync(path.join(dir,'apps',id,'index.html'),'<html>Actual app '+account+'</html>');
   fs.writeFileSync(path.join(dir,'apps',id,'store.json'),JSON.stringify({notes:['saved note'],apiKey:'hidden-context-secret'}));
   fs.writeFileSync(path.join(dir,'runs','run-1.json'),JSON.stringify({messages:['original prompt','tool results']}));
   fs.writeFileSync(path.join(dir,'runs','run-1','work','response.json'),JSON.stringify({answer:'real returned answer'}));
   fs.writeFileSync(path.join(dir,'runs','run-1','work','user-memory.json'),'SENSITIVE_MEMORY');
  }
  const capture=createDevelopmentContext(db,{runtimeRoot:tmp,dshRoot:root});const context=await capture('alice',app);const text=JSON.stringify(context);
  assert.equal(context.application.complete.length,1);assert.equal(context.application.dsh.length,2);assert.equal(context.hostActions.length,1);assert.equal(context.serviceBindings.length,1);
  assert.equal(context.appFiles.length,8);assert.equal(context.fileManifest.length,8);
  assert(context.appFiles.some((x:any)=>x.kind==='dsh_run_metadata'&&x.content.messages[1]==='tool results'));
  for(const blocked of ['OTHER_OWNER','UNRELATED_APP','UNRELATED_JOB','SENSITIVE_MEMORY','hidden-context-secret','full original bob'])assert(!text.includes(blocked),blocked);
  assert(context.fileManifest.every((x:any)=>/^[0-9a-f]{64}$/.test(x.sourceSHA256)&&/^[0-9a-f]{64}$/.test(x.contextSHA256)));
  assert(context.fileManifest.some((x:any)=>x.sourceSHA256!==x.contextSHA256));
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('HTML context rejects symlinks, hardlinks and oversized files with explicit gaps',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dev-html-boundary-'));const db=new Database(':memory:');
 try{
  const id='app-a',root=path.join(tmp,'accounts'),dir=path.join(root,createHash('sha256').update('alice').digest('hex')),appDir=path.join(dir,'apps',id);
  fs.mkdirSync(appDir,{recursive:true});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({apps:[{id}],jobs:[]}));
  const outside=path.join(tmp,'private.txt');fs.writeFileSync(outside,'OUTSIDE_PRIVATE');
  fs.symlinkSync(outside,path.join(appDir,'linked.txt'));fs.linkSync(outside,path.join(appDir,'hard.txt'));
  fs.writeFileSync(path.join(appDir,'huge.txt'),Buffer.alloc(8*1024*1024+1,'x'));
  fs.writeFileSync(path.join(appDir,'index.html'),'<html>actual</html>');
  const capture=createDevelopmentContext(db,{runtimeRoot:tmp,dshRoot:root});const context=await capture('alice','dsh_'+id);
  assert.equal(context.appFiles.length,1);assert(!JSON.stringify(context).includes('OUTSIDE_PRIVATE'));
  assert(context.scope.gaps.some((x:string)=>x.includes('symlink')));assert(context.scope.gaps.some((x:string)=>x.includes('unsafe source')));assert(context.scope.gaps.some((x:string)=>x.includes('byte budget')));
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('Native workflow turns require the selected app exact owner join',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dev-turns-'));const db=new Database(':memory:');
 try{
  db.exec(`CREATE TABLE agent_apps(app_id TEXT,owner TEXT,name TEXT,description TEXT,version TEXT,updated_at TEXT);CREATE TABLE agent_workflow_turns(id INTEGER,app_id TEXT,request_json TEXT,response_json TEXT);`);
  db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('a','alice','a','','1','now');db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('b','bob','b','','1','now');
  db.prepare('INSERT INTO agent_workflow_turns VALUES (?,?,?,?)').run(1,'a','{"request":"previous original action"}','{"reply":"previous result"}');
  db.prepare('INSERT INTO agent_workflow_turns VALUES (?,?,?,?)').run(2,'b','{"request":"OTHER_OWNER"}','{}');
  const capture=createDevelopmentContext(db,{runtimeRoot:tmp});const context=await capture('alice','a');
  assert.equal(context.workflowTurns.length,1);assert.equal(context.workflowTurns[0].request_json.request,'previous original action');
  assert.equal((await capture('alice','b')).workflowTurns.length,0);
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('raw credentials in source assignments and URL userinfo are redacted',()=>{
 const result=JSON.stringify(cleanDevelopmentContext({runtime:'const apiKey="raw-sensitive-value"; fetch("https://u:URLPASSWORD@example.test"); cookie=COOKIESECRET'}));
 for(const value of ['raw-sensitive-value','URLPASSWORD','COOKIESECRET'])assert(!result.includes(value),value);
});

test('DSH directory traversal refuses a linked apps ancestor before listing private names',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dev-ancestor-'));const db=new Database(':memory:');
 try{
  const root=path.join(tmp,'accounts'),dir=path.join(root,createHash('sha256').update('alice').digest('hex'));
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({apps:[{id:'app-a'}],jobs:[]}));
  const external=path.join(tmp,'outside');fs.mkdirSync(path.join(external,'app-a'),{recursive:true});
  fs.writeFileSync(path.join(external,'app-a','PRIVATE_DIRECTORY_NAME.txt'),'PRIVATE_BODY');fs.symlinkSync(external,path.join(dir,'apps'));
  const context=await createDevelopmentContext(db,{runtimeRoot:tmp,dshRoot:root})('alice','dsh_app-a');
  assert.equal(context.appFiles.length,0);assert(!JSON.stringify(context).includes('PRIVATE_DIRECTORY_NAME'));assert(!JSON.stringify(context).includes('PRIVATE_BODY'));
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
