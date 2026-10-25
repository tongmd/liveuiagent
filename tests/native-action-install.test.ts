import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';
import {createLiveUIRuntime} from '../server/liveuiagent.js';import {requireActionRequestId,installHostActionNonces} from '../server/native-action-request.js';
const reply=(x:unknown)=>({choices:[{message:{content:JSON.stringify(x)}}]});
test('real generation installs package host nonces before enrich/save, redesign preserves persisted identities, reopen retains both',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-install-'));const db=new Database(':memory:');t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:false}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'registry'),projectRoot:dir});const roles:string[]=[];
 const llm={model:'fixture-only',chatCompletion:async(r:any)=>{const system=r.messages[0].content;roles.push(system);const p=JSON.parse(r.messages[1].content);
 if(system.includes('create_app')&&system.includes('targetAppId'))return reply({intent:'create_app',targetAppId:null,reason:'Persistent entries'});
 if(system.includes('Business Slot Agent'))return reply({appName:'Mode entries',tagline:'Save a chosen mode',accent:'#426b57',slots:[{label:'Mode',type:'string',required:false}],actions:[{label:'Save entry',description:'Save the entered mode'}],primaryMembership:'app_local',services:[],itemLabel:'Entry',glyph:'📝',tileTagline:'Mode entries',metricLabel:'Entries',collection:'Entries',actionVerb:'Save'});
 if(system.includes('Orchestrator Agent'))return reply({workflowId:'fixture',agents:p.minimumValidAgents,routes:p.minimumValidRoutes,sharedState:p.minimumValidSharedState,dataModels:p.minimumValidDataModels,uiPlan:p.minimumValidUiPlan});
 if(system.includes('sectionOrder'))return reply({schemaVersion:1,sectionOrder:['summary','composer','records'],layout:{fields:'stacked',records:'cards'},headings:{records:'Entries',composer:'New entry'},recordFields:[]});
 if(system.includes('root id "preview"'))return reply({components:[{id:'preview',component:'Column',children:['list']},{id:'list',component:'List',children:{componentId:'row',path:'/entities'}},{id:'row',component:'Row',children:['name','detail']},{id:'name',component:'Text',text:{path:'name'},variant:'body'},{id:'detail',component:'Text',text:{path:'detail'},variant:'caption'}],size:{width:220,height:180}});
 return reply({glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'});}};
 const created:any=await runtime.run({prompt:'Keep a persistent journal of entry modes',platform:'web',user:'alice',llm} as any);const row:any=db.prepare('SELECT * FROM agent_apps').get();assert.ok(row,'real run inserted SQLite app');const state=JSON.parse(row.runtime_state_json),pkg=JSON.parse(row.package_json);
 for(const key of ['hostCommandRequestId','hostTransportRequestId']){assert.equal(requireActionRequestId(state[key]),state[key]);assert.equal(state[key],pkg.memory.defaultState[key]);}
 assert.ok(roles.some(x=>x.includes('Business Slot Agent')));assert.ok(created);assert.equal(created.appPackage.ui.meta.a2ui.initialData.hostCommand.requestId,state.hostCommandRequestId);
 await runtime.patchApp({appId:row.app_id,prompt:'Keep entries and retain the editable mode',user:'alice',llm} as any);
 const next=JSON.parse((db.prepare('SELECT runtime_state_json FROM agent_apps').get() as any).runtime_state_json);assert.equal(next.hostCommandRequestId,state.hostCommandRequestId);assert.equal(next.hostTransportRequestId,state.hostTransportRequestId);
 const reopened:any=await runtime.queryState({user:'alice'});assert.equal(reopened.apps[0].runtimeState.hostCommandRequestId,state.hostCommandRequestId);assert.equal(reopened.apps[0].runtimeState.hostTransportRequestId,state.hostTransportRequestId);
});
test('installation rejects missing or malformed host-minted nonces instead of generating query-time fallback',()=>{assert.throws(()=>installHostActionNonces({}),/requestId/);assert.throws(()=>installHostActionNonces({hostCommandRequestId:'model-text',hostTransportRequestId:'x'}),/requestId/);});
