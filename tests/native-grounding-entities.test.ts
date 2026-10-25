import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {normalizeGroundingEntities} from '../server/grounding-entities.js';
import {appRecordFields,createAppStateAdapter} from '../server/native-app-state.js';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

const row={name:'Needle',appRecordId:'record-a'};
const fields=[{name:'title',type:'string'},{name:'target',type:'number'}];
const normalize=(calls:any[],rows:any[]=[row],declared=fields)=>normalizeGroundingEntities(rows,new Set(['Needle','249']),calls,declared);
const receipt=(api:string,order:number,request:any,response:any)=>({source:'app-state',api,order,request,response,ok:true,executionState:'succeeded',requestSource:'host-bound-app-state-dispatched-arguments'});
function store(t:any){
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('one','alice');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('two','alice');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('three','bob');t.after(()=>db.close());
 return {db,adapter:createAppStateAdapter(db,'alice','one',fields,['storage.app','app_state.write'])!};
}

test('archived unclassified receipts do not acquire typed membership; explicit counterfact is separate',()=>{
 const f=JSON.parse(fs.readFileSync(new URL('./fixtures/native-reading-echo-proof.json',import.meta.url),'utf8'));
 assert.equal(f.sourceDiagnosticSha256,'056f8efffaf581de87da42939305e88318021002c57d3a32d1bfc09e775003f8');
 const echoes=new Set<string>(Object.values(f.payload).filter((v):v is string=>typeof v==='string').map(v=>v.trim()).filter(Boolean));
 assert.equal(f.rawProposals[1].entities.length,5);assert.equal(f.oldNormalizedEntities.length,4);
 assert.equal(normalizeGroundingEntities(f.rawProposals[1].entities,echoes,f.appStateCalls,appRecordFields(f.businessFields)).length,4);
 const typed=structuredClone(f.appStateCalls);for(const c of typed){for(const r of [...(c.response?.record?[c.response.record]:[]),...(c.response?.records??[])])r.recordKind='primary_member';if(c.api==='app_state.list_records'){c.request.recordKind='primary_member';c.response.filter={recordKind:'primary_member'};c.response.unknownRecordCount=0;}}
 const result=normalizeGroundingEntities(f.rawProposals[1].entities,echoes,typed,appRecordFields(f.businessFields));
 assert.equal(result.length,5);assert.equal(result[2].name,'Tomorrow, and Tomorrow, and Tomorrow');assert.equal(result[2].id,undefined);assert.equal(result[2].appRecordId,'reading-shelves-tomorrow-and-tomorrow-and-tomorrow');
 assert.equal(normalizeGroundingEntities(f.rawProposals[0].entities,echoes,f.appStateCalls,appRecordFields(f.businessFields)).length,4,'unbound first proposal is not exempted');
});

test('real SQLite upsert response alone is insufficient; later read/list proves exact declared name',t=>{
 const {adapter}=store(t);const request={recordKind:'primary_member',recordId:'record-a',values:{title:'Needle',target:249}};const write=receipt('app_state.upsert_record',1,request,adapter.call('app_state.upsert_record',request));assert.equal(normalize([write]).length,0);
 const read=receipt('app_state.read_record',2,{recordId:'record-a'},adapter.call('app_state.read_record',{recordId:'record-a'}));assert.equal(normalize([write,read]).length,1);
 const list=receipt('app_state.list_records',3,{recordKind:'primary_member'},adapter.call('app_state.list_records',{recordKind:'primary_member',}));assert.equal(normalize([write,list]).length,1);
 const next=receipt('app_state.upsert_record',4,request,adapter.call('app_state.upsert_record',request));assert.equal(normalize([write,read,next]).length,0,'read before latest write is stale');
 assert.equal(normalize([write,read,next,receipt('app_state.read_record',5,{recordId:'record-a'},adapter.call('app_state.read_record',{recordId:'record-a'}))]).length,1);
});

test('existing record read-only display needs no new write or write permission',t=>{
 const {db,adapter}=store(t);adapter.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'record-a',values:{title:'Needle'}});const readOnly=createAppStateAdapter(db,'alice','one',fields,['storage.app'])!;
 const read=receipt('app_state.read_record',1,{recordId:'record-a'},readOnly.call('app_state.read_record',{recordId:'record-a'}));assert.equal(normalize([read]).length,1);assert.equal((read.response as any).record.revision,1);assert.equal(readOnly.capabilities.some(c=>c.apiName==='app_state.upsert_record'),false);
});

test('other owner/app rows, fake IDs, unread records and mismatched/undeclared/number values stay filtered',t=>{
 const {db,adapter}=store(t);for(const[owner,app]of[['alice','two'],['bob','three']])createAppStateAdapter(db,owner,app,fields,['storage.app','app_state.write'])!.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'record-a',values:{title:'Needle'}});
 const absent=receipt('app_state.read_record',1,{recordId:'record-a'},adapter.call('app_state.read_record',{recordId:'record-a'}));assert.equal(normalize([absent]).length,0);
 assert.throws(()=>createAppStateAdapter(db,'bob','one',fields,['storage.app'])!.call('app_state.read_record',{recordId:'record-a'}),/scope is unavailable/);
 adapter.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'record-a',values:{title:'Something else',target:249}});let read=receipt('app_state.read_record',2,{recordId:'record-a'},adapter.call('app_state.read_record',{recordId:'record-a'}));assert.equal(normalize([read]).length,0);assert.equal(normalize([read],[{name:'249',appRecordId:'record-a'}]).length,0);
 adapter.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'record-a',values:{title:'Needle'}});read=receipt('app_state.read_record',3,{recordId:'record-a'},adapter.call('app_state.read_record',{recordId:'record-a'}));assert.equal(normalize([read],[{...row,appRecordId:'fake'}]).length,0);assert.equal(normalize([read],undefined,[{name:'other',type:'string'}]).length,0);
 for(const mutation of [(c:any)=>c.requestSource='model-supplied',(c:any)=>c.response.scope='other-owner',(c:any)=>c.ok=false,(c:any)=>c.api='app_state.upsert_record']){const bad=structuredClone(read);mutation(bad);assert.equal(normalize([bad]).length,0);}
 assert.equal(normalize([],[{name:'Needle',id:'real-api-id'}]).length,1,'existing API-id exception is unchanged');
});

for(const mode of ['complete','metadata_only','external_read_missing','unknown_external']as const)test(`local echo proof never waives external business verification: ${mode}`,async t=>{
 const {adapter}=store(t);const tools=['create_external','read_external'].map(api=>({id:api,apiName:api,permission:api,appName:'service',method:api==='create_external'?'POST':'GET',purpose:api}));let externalEffects=0,step=0,evaluatorSawRow=false;
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{if(api==='create_external'){externalEffects++;if(mode==='unknown_external')throw Error('Reply lost after external commit');}return{tool:tools.find(t=>t.id===api),request:args,response:{name:'Needle',id:'external-record'},dbChanges:null};}};
 const localWrite={api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'record-a',values:{title:'Needle'}}};const localRead={api:'app_state.read_record',args:{recordId:'record-a'}};
 const calls=[...(mode==='metadata_only'?[]:[{api:'create_external',args:{name:'Needle'}}]),localWrite,localRead,...(mode==='metadata_only'||mode==='external_read_missing'?[]:[{api:'read_external',args:{}}])];
 const reply=(v:any)=>({choices:[{message:{content:JSON.stringify(v)}}]});
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),appState:adapter,appName:'Parts',payload:{title:'Needle'},llm:{model:'fixture-only',chatCompletion:async(request:any)=>{
  const system=request.messages[0].content;if(system.includes('You analyze a GUI'))return reply({objective:'Create real external Needle and persist its local title',projectionPolicy:'retain_existing'});if(system.includes('You are the Write Verifier'))return reply({approved:true});
  if(system.includes('You are an INDEPENDENT evaluator')){const evidence=JSON.parse(request.messages[1].content);evaluatorSawRow=evidence.visibleEntities.some((x:any)=>x.name==='Needle');return reply({pass:mode!=='metadata_only',deficiencies:mode==='metadata_only'?['No actual external write or external read-back; local metadata is not business completion']:[]});}
  return reply(step++===0?{calls}:{done:true,summary:'Needle',entities:[row],stats:[{label:'Parts',value:'1'}]});
 }}});
 assert.equal(result!.evaluation!.pass,mode==='complete');assert.equal(externalEffects,mode==='metadata_only'?0:1,'confirmed/unknown writes are never replayed');
 if(mode==='complete'||mode==='metadata_only'){assert.equal(evaluatorSawRow,true);assert.equal(result!.entities.length,1);}
 if(mode==='external_read_missing')assert.match(result!.evaluation!.deficiencies.join(' '),/read-back/);
 if(mode==='unknown_external')assert.equal(result!.executionEvidence!.unknownWriteOutcomes,1);
});
