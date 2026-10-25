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

const longIds=process.env.LIVEUI_TEST_LONG_IDS==='1';
const socketLoss=process.env.LIVEUI_TEST_TRANSPORT_FAULT==='socket';
const rendererIndex=process.env.LIVEUI_TEST_RENDERER_INDEX;
const idFor=n=>longIds?'record-'+('x'.repeat(17))+'-'+n:'member-'+n;

// Controlled local fixture, not a benchmark/model/World result. Every mutation below
// enters through an actual product-renderer click -> HTTP -> real runtime -> SQLite.
test((longIds?'shared-prefix long-ID identity: ':'')+'390px product lifecycle uses actual SQLite: typed values, duplicate names, selected update/delete, absence, reopen and lost ACK', {timeout:120_000}, async t=>{
 const chrome=[process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&requireExists(p));
 assert.ok(chrome,'Actual Chrome is required; this lifecycle must not become a skipped pass');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-mobile-sqlite-'));const dbfile=path.join(dir,'fixture.sqlite');const db=new Database(dbfile);let reader;let browser;let server;
 const envKeys=['APPWORLD_ENABLED','LIVEUIAGENT_APPWORLD_GROUNDING'];const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));process.env.APPWORLD_ENABLED='false';delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
 const artifacts=process.env.LIVEUI_TEST_ARTIFACTS; if(artifacts)await fs.mkdir(artifacts,{recursive:true});
 const errors=[];const actionRequests=[];const roleCalls=[];const successful=[];let turn;let nextId=0;let dropNextAck=false;
 const fields=[{name:'title',label:'Name',type:'string',required:false},{name:'amount',label:'Amount',type:'number',required:false},{name:'enabled',label:'Enabled',type:'boolean',required:false},{name:'date',label:'Date',type:'date',required:false}];
 const defs=[{actionId:'actions.add.run',label:'Add item'},{actionId:'actions.read.run',label:'Read items'},{actionId:'actions.update.run',label:'Update item',perItem:true,consumedSlots:fields.map(f=>f.name)},{actionId:'actions.delete.run',label:'Delete item',perItem:true,consumedSlots:[]}];
 await fs.writeFile(path.join(dir,'liveuiagent.config.json'),JSON.stringify({gui_debug_policy:{mode:'workflow_first',fix_scope:'generation_pipeline',forbidden:[],required_fix_path:[],acceptance:[]},appworld:{enabled:false}}));
 const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:dir});
 const chain=['agents.orchestrator','agents.action','agents.app','agents.data','agents.memory'];const handoffs=chain.slice(1).map((to,i)=>({from:chain[i],to,payload:'Verified fixture context',reason:'Next role'}));
 const actions=Object.fromEntries(defs.map(d=>{const id=d.actionId.replace(/^actions\./,'');return[id,{id,label:d.label,description:d.label,permissions:['storage.app','app_state.write'],agent:chain[0],agentChain:chain,handoffs,orchestrationRouteId:id,steps:[],...(d.perItem?{perItem:true,consumedSlots:d.consumedSlots}:{})}]}));
 const orchestration={plannedBy:'orchestrator-agent',workflowId:'mobile_fixture',routes:defs.map(d=>({id:d.actionId.replace(/^actions\./,''),entryActionId:d.actionId,agentChain:chain,handoffs,label:d.label,description:d.label}))};
 const designed=compileSemanticSurface(semanticDesign(fields.map(f=>f.name)),{businessFields:fields,actions:defs,persistedStateFields:fields});
 const tree=validateDesignedOverview(designed.components,{slots:fields,actionIds:defs.map(a=>a.actionId),rowActionSlots:rowActionSlotMap(defs,fields.map(f=>f.name)),requireWidgets:true});
 assert.ok(tree,'Fixture source surface must pass the real validator before runtime owns sanitization');
 const interaction={focus:'Saved items',resultFocus:'Saved items',primaryFieldName:'title',secondaryFieldName:'date',businessFields:fields,historyTitle:'Items',inputTitle:'Edit item',inputDescription:'Only requested local items',primaryText:'Item',secondaryText:'Details',outcomeLabel:'Items',resultSectionLabels:['Items']};
 const pkg={manifest:{appId:'mobile_fixture',name:'Local items',description:'Controlled fixture',version:'1',intent:{sourcePrompt:'Save local items, update selected rows and delete them.',visualObjects:['item'],itemLabel:'Item',primaryMembership:'app_local',presentation:{collection:'Saved items'}}},actions:{actions},agents:{agents:Object.fromEntries(chain.map(id=>[id,{id,role:id.split('.')[1],purpose:'Execute assigned fixture role'}]))},memory:{defaultState:{}},proposal:{},assets:{icon:{svg:'<svg/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},dataSchema:{dataSources:{records:{model:'item'}},models:{item:{fields:[{name:'prompt',label:'Request'},{name:'context',label:'Details'}]}}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:designed.components}},orchestration};
 const initial={sourcePrompt:'Save local items',subject:'Items',functionSignature:'mobile_fixture',interaction,orchestration,intentResult:{title:'Items',value:'0',subtitle:'No saved items',sections:[],bullets:[]},intentActionCount:0,recentActions:[],entities:[],entityStats:[{label:'Items',value:'0'}]};
 db.prepare('INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('mobile_fixture','Local items','Controlled fixture',JSON.stringify(pkg),JSON.stringify({records:[{id:'fixture-initial-turn',prompt:'Fixture initialized',context:'No saved items yet',state:'open',nextStep:'Add item',result:'No saved items yet',title:'',amount:0,enabled:false,date:''}]}),JSON.stringify(initial),'1','fixture-owner');
 const canvas=JSON.parse(db.prepare('SELECT state_json FROM canvas_states WHERE canvas_id=?').get('home').state_json);canvas.nodes.push({id:'node_mobile_fixture',type:'app_card',appId:'mobile_fixture',position:{x:72,y:72},size:{width:104,height:124},status:'ready'});db.prepare('UPDATE canvas_states SET state_json=? WHERE canvas_id=?').run(JSON.stringify(canvas),'home');
 reader=new Database(dbfile,{readonly:true});reader.pragma('query_only=ON');
 const rows=()=>reader.prepare('SELECT record_id,record_kind,values_json,revision FROM native_app_records WHERE owner=? AND app_id=? ORDER BY record_id').all('fixture-owner','mobile_fixture').map(r=>({...r,values:JSON.parse(r.values_json)}));
 const reply=value=>({choices:[{message:{content:JSON.stringify(value)}}]});
 const completion=async(request,options)=>{
  const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split('\n')[0]);const label=options?.roleLabel||'';roleCalls.push(label||sys.slice(0,40));
  if(sys.includes('You analyze a GUI'))return reply({objective:turn.op+' the selected local item and read the actual saved collection',deliverables:[],expectedNumbers:[]});
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator')){assert.ok(input.appStateCalls.some(c=>c.ok&&c.api==='app_state.list_records'));return reply({pass:true,deficiencies:[]});}
  if(sys.includes('You are the backend workflow')){
   const calls=input.appStateCalls||[];const good=calls.filter(c=>c.ok);const read=good.find(c=>c.api==='app_state.read_record'&&c.request.recordId===turn.id);
   if((turn.op==='update'||turn.op==='delete')&&!read)return reply({calls:[{api:'app_state.read_record',args:{recordId:turn.id}}]});
   const mutation=good.find(c=>c.api===(turn.op==='delete'?'app_state.delete_record':'app_state.upsert_record'));
   if(turn.op!=='read'&&!mutation){const args=turn.op==='delete'?{recordId:turn.id,expectedRevision:read.response.record.revision}:{recordId:turn.id,recordKind:'primary_member',values:turn.values};return reply({calls:[{api:turn.op==='delete'?'app_state.delete_record':'app_state.upsert_record',args}]});}
   if(turn.op==='delete'&&!good.some(c=>c.api==='app_state.read_record'&&c.order>mutation.order&&c.response.record===null))return reply({calls:[{api:'app_state.read_record',args:{recordId:turn.id}}]});
   const latest=good.filter(c=>c.api==='app_state.list_records').at(-1);
   if(!latest)return reply({calls:[{api:'app_state.list_records',args:{recordKind:'primary_member'}}]});
   const records=latest.response.records;return reply({done:true,summary:records.length+' saved local items read back',entities:records.map(r=>({id:r.recordId,appRecordId:r.recordId,name:r.values.title,detail:`${r.values.date} | ${r.values.amount} | ${r.values.enabled}`,group:'Saved'})),stats:[{label:'Items',value:String(records.length)}]});
  }
  return reply(sys.includes('You independently verify')?{pass:true,reason:'Controlled verifier; actual local receipts remain host validated'}:{proceed:true,instructions:'Perform only this selected local operation, then read the actual collection.',constraints:[],expectedOutcome:'Actual local evidence'});
 };
 const root=new URL('../frontend/snapshot/',import.meta.url);
 server=http.createServer(async(req,res)=>{try{
  const route=new URL(req.url,'http://fixture').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const c of req)raw+=c;
  const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(route==='/agent/query-state'){const state=await runtime.queryState({user:'fixture-owner'});if(artifacts)await fs.writeFile(path.join(artifacts,'last-query.json'),JSON.stringify(state,null,2));return json(state);}
  if(route==='/agent/action'){
   const r=JSON.parse(raw);actionRequests.push(structuredClone(r));const op=r.actionId.replace(/^actions\./,'').split('.')[0];const p=r.eventPayload||{};if(op==='add'||op==='update'){for(const f of fields)assert.ok(Object.hasOwn(p,f.name),'Missing visible field '+f.name);assert.ok([true,false,'true','false'].includes(p.enabled));assert.ok(Number.isFinite(Number(p.amount)));assert.match(p.date,/^\d{4}-\d{2}-\d{2}$/);}
   turn={op,id:op==='add'?idFor(++nextId):p.entityId,values:{title:p.title,amount:Number(p.amount),enabled:p.enabled===true||p.enabled==='true',date:p.date}};
   const result=await runtime.action({...r,user:'fixture-owner',llm:{model:'controlled-fixture-no-provider',chatCompletion:completion}});successful.push({op,id:turn.id,result});if(dropNextAck){dropNextAck=false;req.socket.destroy();return;}return json(result);
  }
  if(route==='/agent/identity')return json({ownerScope:'a'.repeat(64)});
  if(route==='/agent/settings')return json({user:{models:[]},server:{models:[]},effective:{model:'offline',models:[]}});
  if(route==='/agent/runtime-settings')return json({harness:'native',choices:[{id:'native',label:'Native',available:true}],model:{id:'offline'}});
  if(route==='/agent/models')return json({models:['offline'],default:'offline'});
  if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
  if(route==='/agent/chat-history')return json({messages:[]});
  if(route.startsWith('/agent/'))return json({});
  const name=route==='/'?'index.html':route.slice(1);assert.ok(!name.includes('..'));res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(await fs.readFile(name==='index.html'&&rendererIndex?rendererIndex:new URL(name,root)));
 }catch(e){errors.push('fixture HTTP '+e.message);res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message,code:e.code}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let page;
 const screenshot=async name=>{if(artifacts){await page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});await fs.writeFile(path.join(artifacts,name+'.sqlite-rows.json'),JSON.stringify(rows(),null,2));}};
 try{
  browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});page=await browser.newPage();await page.evaluateOnNewDocument(()=>{const actual=window.fetch;window.__fixtureDropNextActionResponse=false;window.__fixtureLostResponseCount=0;window.fetch=async(...args)=>{const response=await actual(...args);if(window.__fixtureDropNextActionResponse&&String(args[0]).includes('/agent/action')){window.__fixtureDropNextActionResponse=false;await response.clone().arrayBuffer();window.__fixtureLostResponseCount++;throw new TypeError('Controlled response loss after the actual committed HTTP response');}return response;};});page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844});const url=`http://127.0.0.1:${server.address().port}/liveui/`;
  const open=async()=>{await page.goto(url);await page.waitForSelector('[data-app-id="mobile_fixture"]');await page.click('[data-app-id="mobile_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});};
  await open();
  const fill=async(title,amount,enabled,date)=>{
   await page.$$eval('.a2ui-host .a2ui-field',els=>els.forEach(e=>{const c=e.querySelector('input,textarea');if(c)c.setAttribute('data-fixture-field',e.querySelector('span')?.textContent||'');}));
   for(const [name,value]of Object.entries({Name:title,Amount:String(amount)}))await page.locator(`[data-fixture-field="${name}"]`).fill(value);
   // React tracks its own input.value setter; use the browser native date setter plus
   // real input/change events, not a model/store state patch or direct action call.
   const dateControl=await page.$('[data-fixture-field="Date"]');await dateControl.focus();await dateControl.evaluate((el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},date);await dateControl.evaluate(el=>el.blur());assert.equal(await dateControl.evaluate(el=>el.value),date);
   const check=await page.$('[data-a2ui-label="Enabled"] [role="switch"]');assert.ok(check);if(await check.evaluate(e=>e.getAttribute('aria-checked')==='true')!==enabled)await check.click();else{await check.click();await check.click();} // Explicitly edit even an unset/unchecked false value.
  };
  const click=async(action,index=0)=>{const n=actionRequests.length;const buttons=await page.$$(`[data-a2ui-action-id="actions.${action}.run"]`);assert.ok(buttons[index]);await buttons[index].click();await page.waitForFunction(n=>window.__fixtureActionCount>=n&&!document.querySelector('.a2ui-host button[disabled]'),{},n+1);};
  // Observer is fixture metadata only; all business effects still happen in the real request handler.
  await page.exposeFunction('__fixtureCalls',()=>actionRequests.length);
  await page.evaluate(()=>{window.__fixtureActionCount=0;const f=window.fetch;window.fetch=async(...args)=>{try{return await f(...args);}finally{window.__fixtureActionCount=await window.__fixtureCalls();}};});
  await fill('Twin',0,false,'2026-10-26');assert.equal(actionRequests.length,0);await click('add');await page.waitForFunction(()=>document.querySelectorAll('[data-a2ui-action-id="actions.update.run"]').length===1);
  assert.deepEqual(rows()[0].values,{title:'Twin',amount:0,enabled:false,date:'2026-10-26'});assert.equal(rows()[0].record_kind,'primary_member');await screenshot('add-zero-false-date');
  await fill('Twin',7,true,'2026-10-27');await click('add');await page.waitForFunction(()=>document.querySelectorAll('[data-a2ui-action-id="actions.update.run"]').length===2);assert.equal(rows().length,2);
  await click('read');assert.equal(rows().length,2);await fill('Twin',0,false,'2026-11-01');await click('update',1);await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('2026-11-01'));
  assert.deepEqual(rows().map(r=>({id:r.record_id,revision:r.revision,values:r.values})),[{id:idFor(1),revision:1,values:{title:'Twin',amount:0,enabled:false,date:'2026-10-26'}},{id:idFor(2),revision:2,values:{title:'Twin',amount:0,enabled:false,date:'2026-11-01'}}]);assert.equal(actionRequests.at(-1).eventPayload.entityId,idFor(2));await screenshot('same-name-selected-update');
  await click('delete',1);await page.waitForFunction(()=>document.querySelectorAll('[data-a2ui-action-id="actions.delete.run"]').length===1);assert.deepEqual(rows().map(r=>r.record_id),[idFor(1)]);
  const deletion=successful.at(-1).result;const receipts=Object.values(deletion.toolResults).filter(c=>c.source==='app-state');assert.ok(receipts.some(c=>c.api==='app_state.delete_record'&&c.response.deleted===true));assert.ok(receipts.some(c=>c.api==='app_state.list_records'&&c.response.records.length===1));assert.equal(reader.prepare('SELECT count(*) n FROM native_app_records WHERE record_id=?').get(idFor(2)).n,0);
  await page.reload();await open();assert.equal(rows()[0].values.date,'2026-10-26');assert.ok(await page.$('[data-a2ui-row-name="Twin"]'));await screenshot('reload-retained-first');
  // Reinstall the observer after navigation; it records completion, never performs actions.
  await page.evaluate(()=>{window.__fixtureActionCount=0;const f=window.fetch;window.fetch=async(...a)=>{try{return await f(...a);}finally{window.__fixtureActionCount=await window.__fixtureCalls();}};});
  await click('delete');await page.waitForFunction(()=>document.querySelectorAll('[data-a2ui-action-id="actions.delete.run"]').length===0);assert.deepEqual(rows(),[]);
  const last=Object.values(successful.at(-1).result.toolResults).filter(c=>c.source==='app-state');assert.ok(last.some(c=>c.api==='app_state.list_records'&&c.request.recordKind==='primary_member'&&c.response.records.length===0&&c.response.unknownRecordCount===0));await screenshot('delete-empty-absence');
  await page.reload();await open();assert.equal(rows().length,0);assert.equal((await page.$$('[data-a2ui-action-id="actions.delete.run"]')).length,0);await screenshot('reopen-empty');
  await fill('Unknown ACK',0,false,'2026-12-01');const before=actionRequests.length;if(socketLoss)dropNextAck=true;else await page.evaluate(()=>{window.__fixtureDropNextActionResponse=true;});const add=await page.$('[data-a2ui-action-id="actions.add.run"]');await add.click();await page.waitForFunction(async before=>document.body.innerText.includes('No response was received')||(await window.__fixtureCalls())>before+1,{},before);await new Promise(r=>setTimeout(r,350));assert.equal(actionRequests.length,before+1,'One lost ACK must not repeat a non-idempotent UI request');assert.ok(await page.$eval('body',el=>el.innerText.includes('The operation may already have taken effect')),'UI must disclose unknown effects rather than claim the request never reached the server');assert.equal(rows().length,1);assert.equal(rows()[0].revision,1);await screenshot('committed-lost-ack-error');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  if(artifacts)await fs.writeFile(path.join(artifacts,'receipt.json'),JSON.stringify({fixtureOnly:true,longIds,transportFault:socketLoss?'real-socket-loss':'controlled-fetch-response-loss',lostResponseCount:await page.evaluate(()=>window.__fixtureLostResponseCount),recordIds:rows().map(row=>row.record_id),dbFile:dbfile,realProviderCalls:0,WorldCalls:0,viewport:{width:390,height:844},actionRequests:actionRequests.map(({actionId,eventPayload})=>({actionId,eventPayload})),roleStubCalls:roleCalls.length,SQLiteRows:rows(),pageErrors:errors,rendererSHA256:crypto.createHash('sha256').update(await fs.readFile(rendererIndex||new URL('index.html',root))).digest('hex')},null,2));
 }catch(e){if(page&&artifacts){await screenshot('failure');await fs.writeFile(path.join(artifacts,'failure.json'),JSON.stringify({error:e.message,pageErrors:errors,dbFile:dbfile,transportFault:socketLoss?'real-socket-loss':'controlled-fetch-response-loss',lostResponseCount:await page.evaluate(()=>window.__fixtureLostResponseCount).catch(()=>null),actionRequests,successful:successful.map(s=>({op:s.op,id:s.id})),visible:await page.$eval('body',e=>e.innerText).catch(()=>''),rows:rows()},null,2));}throw e;}
 finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));reader?.close();db.close();if(artifacts)await fs.writeFile(path.join(artifacts,'sqlite-file-identity.json'),JSON.stringify({path:dbfile,bytes:(await fs.stat(dbfile)).size,sha256:crypto.createHash('sha256').update(await fs.readFile(dbfile)).digest('hex')}));for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!artifacts)await fs.rm(dir,{recursive:true,force:true});}
});
function requireExists(p){return existsSync(p);}
