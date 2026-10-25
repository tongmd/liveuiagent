import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {createAppStateAdapter} from '../server/native-app-state.js';

for(const mode of ['complete','no_playback','explicit_collection','untargeted','unknown'] as const)test(`generated service display does not authorize a collection: ${mode}`,async t=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('app','alice');t.after(()=>db.close());
 const adapter=createAppStateAdapter(db,'alice','app',[{name:'title',type:'string'},{name:'duration',type:'number'}],['storage.app','app_state.write'])!;
 const tools=['play','current_song'].map(api=>({id:api,apiName:api,permission:api,appName:'player',method:api==='play'?'POST':'GET',purpose:api}));
 let started=false,step=0,plays=0;const roles=new Set<string>();let evaluatorCalls=0;const actual:any[]=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const wire=JSON.parse(raw),system=wire.messages[0].content,p=JSON.parse(wire.messages[1].content);let out:any;
 const role=system.includes('You analyze a GUI')?'goal':system.includes('You are the Write Verifier')?'write':system.includes('You are an INDEPENDENT evaluator')?'evaluate':'execute';roles.add(role);
 assert.match(system,/collectionLabel and itemLabel are presentation labels/);assert.match(system,/service_collection projection does not require creating a service collection/);
 assert.equal(p.viewContext.primaryMembership,'service_collection');assert.equal(p.viewContext.collectionLabel,'Tonight selection');
 if(role==='goal')out={objective:'Save the requested routine and start actual playback'+(mode==='explicit_collection'?' and create the explicitly requested external collection':''),deliverables:['Actual saved local routine','Actual started player and fresh readback',...(mode==='explicit_collection'?['Actual external collection created and read back']:[])]};
 else if(role==='write')out=p.proposedCalls.some((c:any)=>c.api==='play'&&c.args.device_id!=='my-device')?{approved:false,reject:true,reason:'Untargeted device is not authorized'}:{approved:true};
 else if(role==='evaluate'){
 evaluatorCalls++;const write=p.appStateCalls.some((c:any)=>c.api==='app_state.upsert_record'&&c.ok);const read=p.appStateCalls.some((c:any)=>c.api==='app_state.read_record'&&c.response?.record?.values?.title==='Quiet routine');const played=p.apiCalls.some((c:any)=>c.api==='play'&&c.ok);const checked=p.apiCalls.some((c:any)=>c.api==='current_song'&&c.response?.playing===true);const pass=write&&read&&played&&checked&&mode!=='explicit_collection';out={pass,deficiencies:pass?[]:['Missing actual requested external effect or complete explicit external collection deliverable']};
 }else{
 step++;
 out=step===1?{calls:[{api:'app_state.upsert_record',args:{recordId:'routine',recordKind:'supporting_preference',values:{title:'Quiet routine',duration:30}}}]}:step===2?{calls:[{api:'app_state.read_record',args:{recordId:'routine'}},...(mode==='no_playback'?[]:[{api:'play',args:{song_id:7,device_id:mode==='untargeted'?'other-device':'my-device'}}])]}:step===3?{calls:[{api:'current_song',args:{device_id:'my-device'}}]}:{done:true,summary:started?'Routine saved; actual playback started':'Routine saved; playback not verified',entities:started?[{id:'7',name:'Actual song',detail:'Playing from current service read'}]:[],stats:[]};
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{actual.push({api,args});if(api==='play'){plays++;if(mode==='unknown')throw Error('Outcome unknown after request dispatch');assert.equal(args.device_id,'my-device');started=true;}return{tool:tools.find(x=>x.id===api),request:args,response:api==='current_song'?{playing:started,...(started?{song:{id:7,name:'Actual song'}}:{})}:{started:true},dbChanges:null};}};
 const result=await runAppWorldGrounding({bridge,appState:adapter,permissions:tools.map(x=>x.permission),payload:{command:'Save Quiet routine for 30 minutes and start playing on my device.'+(mode==='explicit_collection'?' Create a new external collection too.':'')},appName:'Night helper',appPurpose:'Save a nightly routine and start music.',viewContext:{primaryMembership:'service_collection',collectionLabel:'Tonight selection',itemLabel:'Song',perItemActions:[]},llm:{model:'fixture-only',apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address()as any).port}/v1`}});
 assert.deepEqual([...roles].sort(),['evaluate','execute','goal','write']);assert(evaluatorCalls>0);assert.equal(result?.evaluation?.pass,mode==='complete');
 const stored:any=adapter.call('app_state.read_record',{recordId:'routine'});assert.equal(stored.record.recordKind,'supporting_preference');assert.deepEqual(stored.record.values,{title:'Quiet routine',duration:30});
 if(mode==='complete'){assert.equal(plays,1);assert.equal(result?.entities[0].id,'7');assert.equal(result?.entities[0].name,'Actual song');assert.equal((result?.entities[0]as any).appRecordId,undefined);}
 if(mode==='no_playback'||mode==='untargeted')assert.equal(plays,0);
 if(mode==='unknown'){assert.equal(plays,1);assert.equal(result?.executionEvidence?.unknownWriteOutcomes,1);}
 assert(!actual.some(x=>x.api==='create_collection'),'generated display label never creates an external business object');
});
