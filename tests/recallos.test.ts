import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import {createRecallOSBackend} from '../server/recallos.js';
import {createContextualMemory} from '../server/contextual-memory.js';

async function fixture(t:any) {
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE personal_memory(owner TEXT,id TEXT,scope TEXT,content TEXT,updated_at TEXT,expires_at TEXT)');
  createContextualMemory(db);
  const records=new Map<string,any[]>(),events=new Set<string>(),requests:any[]=[];let revision=1;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),{owner,operation,arguments:a}=body;
    requests.push(body);
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    const rows=records.get(owner)||[];records.set(owner,rows);
    const state=()=>({revision:String(revision).padStart(40,'0'),rules:rows});
    let result:any;
    if(operation==='snapshot')result=state();
    else if(operation==='apply'){
      if(!events.has(owner+'/'+a.source_id)){
        const index=rows.findIndex(r=>r.id===a.rule_id&&r.scope===a.scope&&r.project===a.project);
        if(index>=0)rows.splice(index,1);
        if(a.text!==null)rows.push({id:a.rule_id,scope:a.scope,project:a.project,text:a.text,
          attributes:a.attributes,source_id:a.source_id,evidence:a.evidence,updated_at:new Date().toISOString()});
        events.add(owner+'/'+a.source_id);revision++;
      }
      result={revision:state().revision,status:'updated'};
    }else if(req.url==='/v1/chat/completions'){
      const input=JSON.parse(body.messages[1].content);
      result={choices:[{message:{content:JSON.stringify({updates:[{id:null,preference:'Use larger type at night',dimension:'typography',condition:'Night reading',scope:'global',evidence:[{eventId:input.current.id,quote:input.current.text}],expiresAt:null}],selected_ids:[],selected_update_indexes:[0],current_context:'Night reading',forget_ids:[]})}}]};
    }else {res.writeHead(400);res.end('{}');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as any).port;
  const backend=createRecallOSBackend(db,{url:`http://127.0.0.1:${port}`,token:'fixture-token'});
  return {db,backend,records,events,requests,url:`http://127.0.0.1:${port}`};
}

test('RecallOS imports old conditional memories, preserves scope, and does not resurrect deleted imports',async t=>{
  const f=await fixture(t);
  f.db.prepare('INSERT INTO personal_context_memory VALUES (?,?,?,?,?,?,?,?,?)').run('alice','legacy-1','global','Larger type','typography','Night reading',JSON.stringify([{eventId:'old',quote:'Larger type at night'}]),new Date().toISOString(),null);
  await f.backend.refresh('alice');
  assert.equal(f.backend.list('alice')[0].condition,'Night reading');
  assert.equal(f.records.get('alice')![0].scope,'liveui');
  await f.backend.remove('alice','legacy-1','undo-import');
  const restarted=createRecallOSBackend(f.db,{url:f.url,token:'fixture-token'});
  await restarted.refresh('alice');
  assert.equal(restarted.list('alice').length,0);
});

test('RecallOS exposes shared global rules and isolates owners and unrelated projects',async t=>{
  const f=await fixture(t);
  f.records.set('alice',[
    {id:'language',scope:'global',project:null,text:'Use Chinese',source_id:'codex/1',updated_at:new Date().toISOString()},
    {id:'private',scope:'coding',project:'other-project',text:'Project-only value',source_id:'codex/2'}
  ]);
  await f.backend.refresh('alice');await f.backend.refresh('bob');
  assert.equal(f.backend.list('alice').length,1);
  assert.equal(f.backend.list('alice')[0].source,'explicit');
  assert.equal(f.backend.list('bob').length,0);
});

test('Contextual feedback writes to RecallOS and leaves legacy SQLite memory unchanged',async t=>{
  const f=await fixture(t);
  const context=createContextualMemory(f.db,f.backend);
  const result=await context.process('alice',{text:'At night, please use larger type',kind:'conversation'},
    {apiBase:f.url+'/v1',apiKey:'fixture-token',model:'fixture'} as any);
  assert.equal(result.status,'ready');assert.equal(result.remembered,1);
  assert.equal(result.selected[0].when,'Night reading');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM personal_context_memory').get() as any).n,0);
  assert.equal(f.records.get('alice')![0].text,'Use larger type at night');
});

test('An in-flight feedback update retains its original revision and native rule identity after refresh',async t=>{
  const f=await fixture(t);
  f.records.set('alice',[{id:'language',scope:'global',project:null,text:'Use Chinese',source_id:'codex/1',updated_at:new Date().toISOString()}]);
  await f.backend.refresh('alice');
  const baseline=f.backend.capture('alice'),row=f.backend.list('alice')[0];
  f.records.set('alice',[]);
  await f.backend.refresh('alice');
  await f.backend.upsert('alice',{...row,content:'Use English'},'feedback-after-concurrent-delete','Use English',undefined,baseline);
  const request=f.requests.find(r=>r.operation==='apply').arguments;
  assert.equal(request.rule_id,'language');assert.equal(request.scope,'global');
  assert.equal(request.base_revision,baseline!.revision);
});
