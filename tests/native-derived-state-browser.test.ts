// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import {createLiveUIRuntime,validateDesignedOverview} from '../server/liveuiagent.js';
import {compileSemanticSurface} from '../server/native-surface-design.js';
import {rowActionSlotMap} from '../server/native-action-slots.js';
import {semanticDesign} from './fixtures/native-semantic-design.js';

const rendererIndex=undefined;
const idFor=n=>'derived-record-'+n;
// Controlled local fixture, not a benchmark/model/World result. Every mutation below
// enters through an actual product-renderer click -> HTTP -> real runtime -> SQLite.
test('390px derived-state actual runtime SQLite lifecycle keeps annotations out of inputs', {timeout:120_000}, async t=>{
 const chrome=[process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&requireExists(p));
 assert.ok(chrome,'Actual Chrome is required; this lifecycle must not become a skipped pass');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-mobile-sqlite-'));const dbfile=path.join(dir,'fixture.sqlite');const db=new Database(dbfile);let reader;let browser;let server;
 const envKeys=['APPWORLD_ENABLED','LIVEUIAGENT_APPWORLD_GROUNDING'];const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));process.env.APPWORLD_ENABLED='false';delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
 const artifacts=process.env.LIVEUI_TEST_ARTIFACTS; if(artifacts)await fs.mkdir(artifacts,{recursive:true});
 const errors=[];const actionRequests=[];const roleCalls=[];const successful=[];const rejectedResults=[];let turn;let nextId=0;let dropNextAck=false;
 const fields=[{name:'title',label:'Name',type:'string',required:false}];
 const persisted=[{name:'reviewed',label:'Reviewed',type:'boolean'},{name:'attempts',label:'Attempts',type:'number'},{name:'review_date',label:'Review date',type:'date'}];
 const defs=[{actionId:'actions.add.run',label:'Add item'},...['unreview','review','reject'].map((op,i)=>({actionId:'actions.'+op+'.run',label:['Mark not reviewed','Mark reviewed','Reject unknown'][i],perItem:true,consumedSlots:[]}))];
 await fs.writeFile(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:false}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:dir});
 const chain=['agents.orchestrator','agents.action','agents.app','agents.data','agents.memory'];const handoffs=chain.slice(1).map((to,i)=>({from:chain[i],to,payload:'Verified fixture context',reason:'Next role'}));
 const actions=Object.fromEntries(defs.map(d=>{const id=d.actionId.replace(/^actions\./,'');return[id,{id,label:d.label,description:d.label,permissions:['storage.app','app_state.write'],agent:chain[0],agentChain:chain,handoffs,orchestrationRouteId:id,steps:[],...(d.perItem?{perItem:true,consumedSlots:d.consumedSlots}:{})}]}));
 const orchestration={plannedBy:'orchestrator-agent',workflowId:'mobile_fixture',routes:defs.map(d=>({id:d.actionId.replace(/^actions\./,''),entryActionId:d.actionId,agentChain:chain,handoffs,label:d.label,description:d.label}))};
 const designed=compileSemanticSurface(semanticDesign([...fields,...persisted].map(f=>f.name)),{businessFields:fields,actions:defs,persistedStateFields:[...fields,...persisted]});
 const tree=validateDesignedOverview(designed.components,{slots:fields,persistedDomainFields:persisted,actionIds:defs.map(a=>a.actionId),rowActionSlots:rowActionSlotMap(defs,fields.map(f=>f.name)),requireWidgets:true});
 assert.ok(tree,'Fixture source surface must pass the real validator before runtime owns sanitization');
 const interaction={focus:'Saved items',resultFocus:'Saved items',primaryFieldName:'title',secondaryFieldName:'title',businessFields:fields,persistedDomainFields:persisted,historyTitle:'Items',inputTitle:'Edit item',inputDescription:'Only requested local items',primaryText:'Item',secondaryText:'Details',outcomeLabel:'Items',resultSectionLabels:['Items']};
 const pkg={manifest:{appId:'mobile_fixture',name:'Local items',description:'Controlled fixture',version:'1',intent:{sourcePrompt:'Save local items, update selected rows and delete them.',visualObjects:['item'],itemLabel:'Item',primaryMembership:'app_local',presentation:{collection:'Saved items'}}},actions:{actions},agents:{agents:Object.fromEntries(chain.map(id=>[id,{id,role:id.split('.')[1],purpose:'Execute assigned fixture role'}]))},memory:{defaultState:{}},proposal:{},assets:{icon:{svg:'<svg/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},dataSchema:{dataSources:{records:{model:'item'}},models:{item:{fields:[{name:'prompt',label:'Request'},{name:'context',label:'Details'}]}}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:designed.components}},orchestration};
 const initial={sourcePrompt:'Save local items',subject:'Items',functionSignature:'mobile_fixture',interaction,orchestration,intentResult:{title:'Items',value:'0',subtitle:'No saved items',sections:[],bullets:[]},intentActionCount:0,recentActions:[],entities:[],entityStats:[{label:'Items',value:'0'}]};
 db.prepare('INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('mobile_fixture','Local items','Controlled fixture',JSON.stringify(pkg),JSON.stringify({records:[{id:'fixture-initial-turn',prompt:'Fixture initialized',context:'No saved items yet',state:'open',nextStep:'Add item',result:'No saved items yet',title:''}]}),JSON.stringify(initial),'1','fixture-owner');
 const canvas=JSON.parse(db.prepare('SELECT state_json FROM canvas_states WHERE canvas_id=?').get('home').state_json);canvas.nodes.push({id:'node_mobile_fixture',type:'app_card',appId:'mobile_fixture',position:{x:72,y:72},size:{width:104,height:124},status:'ready'});db.prepare('UPDATE canvas_states SET state_json=? WHERE canvas_id=?').run(JSON.stringify(canvas),'home');
 reader=new Database(dbfile,{readonly:true});reader.pragma('query_only=ON');
 const rows=()=>reader.prepare('SELECT record_id,record_kind,values_json,revision FROM native_app_records WHERE owner=? AND app_id=? ORDER BY record_id').all('fixture-owner','mobile_fixture').map(r=>({...r,values:JSON.parse(r.values_json)}));
 const reply=value=>({choices:[{message:{content:JSON.stringify(value)}}]});
 const completion=async(request,options)=>{
  const sys=request.messages[0].content,input=JSON.parse(request.messages[1].content.split('\n')[0]);roleCalls.push(options?.roleLabel||'unknown');
  if(sys.includes('You analyze a GUI'))return reply({objective:'Perform the explicit selected local annotation action and read it back'});
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:turn.op!=='reject',deficiencies:turn.op==='reject'?['Undeclared field rejected']:[]});
  if(sys.includes('You are the backend workflow')){
   const calls=input.appStateCalls||[],good=calls.filter(c=>c.ok);
   if(turn.op!=='add'&&!good.some(c=>c.api==='app_state.read_record'))return reply({calls:[{api:'app_state.read_record',args:{recordId:turn.id}}]});
   if(!calls.some(c=>c.api==='app_state.upsert_record'))return reply({calls:[{api:'app_state.upsert_record',args:{recordId:turn.id,recordKind:'primary_member',values:turn.values}}]});
   if(turn.op==='reject')return reply({done:true,summary:'Undeclared field was rejected; no update completed',entities:[],stats:[]});
   if(!good.some(c=>c.api==='app_state.read_record'&&c.order>good.find(c=>c.api==='app_state.upsert_record').order))return reply({calls:[{api:'app_state.read_record',args:{recordId:turn.id}}]});
   const listed=good.filter(c=>c.api==='app_state.list_records').at(-1);if(!listed)return reply({calls:[{api:'app_state.list_records',args:{recordKind:'primary_member'}}]});
   return reply({done:true,summary:'Actual local annotation read back',entities:listed.response.records.map(r=>({id:r.recordId,appRecordId:r.recordId,name:r.values.title})),stats:[]});
  }
  return reply(sys.includes('You independently verify')?{pass:turn.op!=='reject',reason:'Controlled verifier reads actual app-state receipts'}:{proceed:true,instructions:'Only selected explicit local operation; persist declared values then read them back',constraints:[],expectedOutcome:'Actual scoped app-state result'});
 };
 const root=new URL('../frontend/snapshot/',import.meta.url);
 server=http.createServer(async(req,res)=>{try{
  const route=new URL(req.url,'http://fixture').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const c of req)raw+=c;
  const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(route==='/agent/query-state'){const state=await runtime.queryState({user:'fixture-owner'});if(artifacts)await fs.writeFile(path.join(artifacts,'last-query.json'),JSON.stringify(state,null,2));return json(state);}
  if(route==='/agent/action'){
   const r=JSON.parse(raw);actionRequests.push(structuredClone(r));const op=r.actionId.replace(/^actions\./,'').split('.')[0],p=r.eventPayload||{};
   if(op==='add')assert.equal(p.title,'Entry');else for(const f of persisted)assert.equal(p[f.name],undefined,'Derived values never appear as consumed inputs');
   turn={op,id:op==='add'?idFor(++nextId):p.entityId,values:op==='add'?{title:p.title}:op==='unreview'?{title:'Entry',reviewed:false,attempts:0,review_date:'2026-10-26'}:op==='review'?{title:'Entry',reviewed:true,attempts:1,review_date:'2026-11-01'}:{title:'Entry',undeclared_state:true}};
   const result=await runtime.action({...r,user:'fixture-owner',llm:{model:'controlled-fixture-no-provider',chatCompletion:completion}});if(op==='reject')rejectedResults.push(result);if(result.workflowExecution?.status==='completed')successful.push({op,id:turn.id,result});if(dropNextAck&&result.workflowExecution?.status==='completed'){dropNextAck=false;req.socket.destroy();return;}return json(result);
  }
  if(route==='/agent/identity')return json({ownerScope:'a'.repeat(64)});
  if(route==='/agent/settings')return json({user:{models:[]},server:{models:[]},effective:{model:'offline',models:[]}});
  if(route==='/agent/runtime-settings')return json({harness:'native',choices:[{id:'native',label:'Native',available:true}],model:{id:'offline'}});
  if(route==='/agent/models')return json({models:['offline'],default:'offline'});
  if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
  if(route==='/agent/chat-history')return json({messages:[]});
  if(route.startsWith('/agent/'))return json({});
  const name=route==='/'?'index.html':route.slice(1);assert.ok(!name.includes('..'));res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(await fs.readFile(name==='index.html'&&rendererIndex?rendererIndex:new URL(name,root)));
 }catch(e){if(turn?.op==='reject')rejectedResults.push({error:e.message,code:e.code});if(turn?.op!=='reject')errors.push('fixture HTTP '+e.message);res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message,code:e.code}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let page;
 const screenshot=async name=>{if(artifacts){await page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});await fs.writeFile(path.join(artifacts,name+'.sqlite-rows.json'),JSON.stringify(rows(),null,2));}};
 try{
  browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844});
  await page.evaluateOnNewDocument(()=>{const actual=window.fetch;window.__fixtureDrop=false;window.fetch=async(...args)=>{const r=await actual(...args);if(window.__fixtureDrop&&String(args[0]).includes('/agent/action')){window.__fixtureDrop=false;await r.clone().arrayBuffer();throw new TypeError('Controlled ACK loss after actual SQLite commit');}return r;};});
  await page.exposeFunction('__countActions',()=>actionRequests.length);
  const open=async()=>{await page.goto(`http://127.0.0.1:${server.address().port}/liveui/`);await page.waitForSelector('[data-app-id="mobile_fixture"]');await page.click('[data-app-id="mobile_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});};
  const click=async op=>{const n=actionRequests.length;await page.click(`[data-a2ui-action-id="actions.${op}.run"]:not([disabled])`);await page.waitForFunction(async n=>(await window.__countActions())>n&&!document.querySelector('.a2ui-host button[disabled]'),{},n);};
  await open();assert.equal(await page.$$eval('.a2ui-host input,.a2ui-host textarea,.a2ui-host select',e=>e.length),1);assert.equal(await page.$$eval('.a2ui-host [role="switch"]',e=>e.length),0);await page.locator('.a2ui-host input').fill('Entry');await click('add');await page.waitForSelector('[data-a2ui-action-id="actions.unreview.run"]');assert.equal(rows().length,1);
  await click('unreview');await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('2026-10-26'));assert.deepEqual(rows()[0].values,{title:'Entry',reviewed:false,attempts:0,review_date:'2026-10-26'});await screenshot('false-zero-date');
  const text=await page.$eval('.a2ui-host',e=>e.textContent);assert.match(text,/false/);assert.match(text,/0/);assert.match(text,/2026-10-26/);assert.equal(await page.$$eval('.a2ui-host input,.a2ui-host textarea,.a2ui-host select',e=>e.length),1);
  await click('review');await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('2026-11-01'));assert.deepEqual(rows()[0].values,{title:'Entry',reviewed:true,attempts:1,review_date:'2026-11-01'});await screenshot('true-one-new-date');
  await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('2026-11-01'));assert.equal(rows()[0].revision,3);assert.equal((await runtime.queryState({user:'other-owner'})).apps.length,0);const reopenedDb=new Database(dbfile);try{const rebuilt=createLiveUIRuntime(reopenedDb,{registryRoot:path.join(dir,'apps'),projectRoot:dir});const fromDisk=(await rebuilt.queryState({user:'fixture-owner'})).apps[0];assert.deepEqual(fromDisk.appPackage.ui.meta.a2ui.initialData.entities[0].appState,{title:'Entry',reviewed:true,attempts:1,review_date:'2026-11-01'});assert.equal((await rebuilt.queryState({user:'other-owner'})).apps.length,0);}finally{reopenedDb.close();}await screenshot('sqlite-reopen');
  await open();const n=actionRequests.length;await page.evaluate(()=>window.__fixtureDrop=true);await click('unreview');await page.waitForFunction(()=>document.body.innerText.includes('No response was received'));await new Promise(r=>setTimeout(r,350));assert.equal(actionRequests.length,n+1,'Unknown ACK does not automatically resend');assert.equal(rows()[0].revision,4);assert.deepEqual(rows()[0].values,{title:'Entry',reviewed:false,attempts:0,review_date:'2026-10-26'});await screenshot('unknown-ack-not-replayed');await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('2026-10-26'));assert.equal(rows()[0].revision,4);
  const before=JSON.stringify(rows());await click('reject');assert.equal(JSON.stringify(rows()),before,'Undeclared field attempt cannot update SQLite');assert.ok(actionRequests.at(-1).actionId.includes('reject'));assert.match(JSON.stringify(rejectedResults),/undeclared_state/);assert.match(JSON.stringify(rejectedResults),/Undeclared|Unknown/);await new Promise(r=>setTimeout(r,350));assert.equal(JSON.stringify(rows()),before);await screenshot('undeclared-rejected');
  const actual=(await runtime.queryState({user:'fixture-owner'})).apps[0];assert.deepEqual(actual.runtimeState.interaction.businessFields.map(f=>f.name),['title']);for(const op of ['unreview','review','reject'])assert.deepEqual(actual.appPackage.actions.actions[op+'.run'].consumedSlots,[]);for(const f of persisted)assert.equal(actual.appPackage.ui.meta.a2ui.initialData.draft.slots[f.name],undefined);assert.deepEqual(errors,[]);
  if(artifacts)await fs.writeFile(path.join(artifacts,'receipt.json'),JSON.stringify({fixtureOnly:true,providerCalls:0,WorldCalls:0,viewport:{width:390,height:844},dbfile,rows:rows(),actionRequests:actionRequests.map(r=>({requestId:r.requestId,actionId:r.actionId,eventPayload:r.eventPayload})),roleCalls,rejectedResults,sourceCommit:process.env.LIVEUI_TEST_SOURCE_COMMIT},null,2));
 }catch(e){if(page&&artifacts){await screenshot('failure');await fs.writeFile(path.join(artifacts,'failure.json'),JSON.stringify({error:e.message,errors,rows:rows(),actionRequests,visible:await page.$eval('body',e=>e.innerText)},null,2));}throw e;}finally{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(reader)reader.close();db.close();for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
function requireExists(p){try{return existsSync(p);}catch{return false;}}
