import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import Database from 'better-sqlite3';
const liveSource=fs.readFileSync(new URL('../server/liveuiagent.ts',import.meta.url),'utf8');
const diagnosticsSource=liveSource.slice(liveSource.indexOf('export type NativeTaskDiagnostics ='),liveSource.indexOf('type LIVEUIAGENTRuntimeOptions =')).replaceAll('export ','');
const source=fs.readFileSync(new URL('../server/index.ts',import.meta.url),'utf8');
const respond=source.slice(source.indexOf('async function respondWithProgress('),source.indexOf("app.post('/agent/run'"));
const end=source.slice(source.indexOf('function recordTaskEnd('),source.indexOf("app.post('/agent/chat-append'"));
async function run({sse=false,owner='test',code='',remove=false,label='Create'}={}){
 const db=new Database(':memory:');db.exec('CREATE TABLE chat_history(id INTEGER PRIMARY KEY, owner TEXT, kind TEXT, status TEXT, text TEXT, prompt TEXT)');
 const warnings=[],events=[],beforeUpdates=[];
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'task-failure-'));
 const traceFile=()=>path.join(temp,'task-diagnostics',createHash('sha256').update(owner).digest('hex'),'1.json');
 const wrappedDb={prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('UPDATE chat_history'))return statement;return {run(...args){beforeUpdates.push({trace:fs.existsSync(traceFile())?JSON.parse(fs.readFileSync(traceFile(),'utf8')):null,row:db.prepare('SELECT * FROM chat_history').get()});return statement.run(...args);}};}};
 const ctx={db:wrappedDb,dbPath:path.join(temp,'database.sqlite'),fs,path,createHash,randomUUID,Buffer,URL,URLSearchParams,Date,console:{warn:x=>warnings.push({text:x,row:db.prepare('SELECT * FROM chat_history').get()}),log:()=>{}},setInterval:()=>1,clearInterval:()=>{},llmConfigFromRequest:()=>({model:'fixture'}),requestUser:()=>owner,personal:{prepare:async()=>{},requestStatus:()=>({})},runtimeSettings:{forRequest:()=> 'codex'},appHarness:{during:async(_r,_a,fn)=>fn()},harnessLabel:()=> 'Codex',redactSecrets:x=>x.replaceAll('secret-fixture','[redacted]'),recordTaskStart:(_o,_l,p)=>Number(db.prepare("INSERT INTO chat_history(owner,kind,status,text,prompt) VALUES(?,'task','running','',?)").run(owner,p).lastInsertRowid),llmSettingsView:()=>({effective:{model:'fixture'}}),errorPayload:e=>({error:e.message})};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(diagnosticsSource+'\n'+respond+'\n'+end,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const request={body:{prompt:'original need'},header:()=>sse?'text/event-stream':''};
 await ctx.respondWithProgress(request,{writeHead:()=>{},write:x=>events.push(x),end:()=>{},json:()=>{}},e=>events.push(e.message),'run',async()=>{if(remove)db.exec('DELETE FROM chat_history');throw Object.assign(new Error('failure secret-fixture'),{code});},()=>'',label);
 const rows=db.prepare('SELECT * FROM chat_history').all();db.close();fs.rmSync(temp,{recursive:true,force:true});return {warnings,events,rows,beforeUpdates};
}
for(const sse of [false,true])test(`failure persisted before linked journal (${sse?'SSE':'JSON'})`,async()=>{
 const x=await run({sse});assert.equal(x.rows.length,1);assert.equal(x.rows[0].status,'error');assert.equal(x.rows[0].prompt,'original need');assert.equal(x.warnings[0].row.status,'error');assert.match(x.warnings[0].text,/FAIL chat_history=1 owner=test /);assert.doesNotMatch(x.warnings[0].text,/secret-fixture/);assert.equal(x.events.length,1);assert.equal(x.beforeUpdates[0].row.status,'running');assert.equal(x.beforeUpdates[0].trace.status,'error');assert.equal(x.beforeUpdates[0].trace.chatId,1);
});
test('unmonitored owner is not marked for journal suppression',async()=>assert.doesNotMatch((await run({owner:'other'})).warnings[0].text,/chat_history=/));
test('config loop deletes row and has no false link',async()=>{const x=await run({code:'llm_config_required'});assert.equal(x.rows.length,0);assert.doesNotMatch(x.warnings[0].text,/chat_history=/);});
test('missing or unrecorded row has no false link',async()=>{for(const o of [{remove:true},{label:undefined}]){const x=await run({...o,label:o.remove?'Create':''});assert.doesNotMatch(x.warnings[0].text,/chat_history=/);}});
