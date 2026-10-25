import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import {stateDisplayFields,stateDisplayPaths,stateDisplayValues} from '../server/native-state-display.js';
import {createAppStateAdapter} from '../server/native-app-state.js';
import {createLiveUIRuntime,designAppSurface,designAppPreview} from '../server/liveuiagent.js';
const fields:any[]=[{name:'item_name',label:'Item name',type:'string'},{name:'target',label:'Target cost',type:'number'},{name:'note',label:'Target note',type:'text'}];
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
function overview(binding='appState/target'){
 return [{id:'overview',component:'Column',children:['hero','list','result',...fields.map(f=>f.name),'save']},{id:'hero',component:'StatBlock',label:{path:'/draft/statLabel'},value:{path:'/draft/statValue'}},{id:'list',component:'List',children:{componentId:'row',path:'/entities'}},{id:'row',component:'Column',children:['name','detail','targetLabel','targetValue','noteValue']},{id:'name',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}},{id:'targetLabel',component:'Text',text:'Target cost'},{id:'targetValue',component:'Text',text:{path:binding}},{id:'noteValue',component:'Badge',text:{path:'appState/note'}},{id:'result',component:'Text',text:{path:'/draft/result'}},...fields.map(f=>({id:f.name,component:'TextField',label:f.label,value:{path:'/draft/slots/'+f.name},variant:f.type==='number'?'stepper':f.type==='text'?'longText':'shortText'})),{id:'save',component:'Button',child:'saveText',action:{event:{name:'save.run'}}},{id:'saveText',component:'Text',text:'Save target'}];
}
function preview(binding='appState/target') {return [{id:'preview',component:'Column',children:['list']},{id:'list',component:'List',children:{componentId:'row',path:'/entities'}},{id:'row',component:'Row',children:['name','target']},{id:'name',component:'Text',text:{path:'name'}},{id:'target',component:'Text',text:{path:binding}}];}
test('state display admits declared scalar fields only and preserves actual zero/false while unknown stays unknown',()=>{
 const declared=[...fields,{name:'enabled',type:'boolean'},{name:'api_token',type:'string'},{name:'owner',type:'string'},{name:'hidden',type:'string',hiddenInForm:true},{name:'__proto__',type:'string'}];
 assert.deepEqual(stateDisplayFields(declared).map(f=>f.name),['item_name','target','note','enabled']);
 assert.ok(stateDisplayPaths(declared).has('appState/target'));assert.ok(!stateDisplayPaths(declared).has('/appState/api_token'));
 assert.deepEqual(stateDisplayValues(declared,{target:0,enabled:false,note:null,api_token:'not-visible'}),{item_name:'Not set',target:0,note:'Not set',enabled:false});
});
test('overview and preview designers accept the same declared row metadata but repair secret, unknown and arbitrary paths',async()=>{
 for(const binding of ['appState/target','appState/api_token','appState/undeclared','appState/target/owner','/appRecords/0/values/target','/owner']){
  for(const mode of ['overview','preview']){
   let calls=0;let contract:any;
   const input:any={name:'Parts',description:'Parts with a local target cost',sourcePrompt:'Track parts and local targets',businessFields:fields,actions:[{actionId:'save.run',label:'Save target'}],llm:{model:'fixture-only',chatCompletion:async(req:any)=>{calls++;contract=JSON.parse(req.messages[1].content);return reply(mode==='overview'?{components:overview(calls===1?binding:'appState/target')}:{components:preview(calls===1?binding:'appState/target'),size:{width:230,height:200}});}}};
   if(mode==='overview')await designAppSurface(input);else await designAppPreview(input);
   assert.equal(calls,binding==='appState/target'?1:2);assert.ok(contract.persistedStateFields.some((f:any)=>f.path==='appState/target'));assert.ok(!contract.persistedStateFields.some((f:any)=>f.name==='api_token'));
  }
 }
});
async function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-state-display-'));const db=new Database(':memory:');const old=process.env.APPWORLD_ENABLED;process.env.APPWORLD_ENABLED='false';let runtime:any;
 try{runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:process.cwd()});}finally{if(old===undefined)delete process.env.APPWORLD_ENABLED;else process.env.APPWORLD_ENABLED=old;}
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const interaction={focus:'Parts',resultFocus:'Targets',primaryFieldName:'item_name',secondaryFieldName:'note',businessFields:fields,historyTitle:'Parts',inputTitle:'Targets',inputDescription:'Set local target costs'};
 const pkg={manifest:{appId:'parts',name:'Parts',description:'Track local targets',version:'1',intent:{visualObjects:['parts']}},actions:{actions:{'save.run':{id:'save.run',label:'Save target',permissions:['storage.app','app_state.write']}}},dataSchema:{dataSources:{records:{model:'part'}},models:{part:{fields:[{name:'prompt',label:'Part'},{name:'context',label:'Details'}]}}},memory:{defaultState:{}},agents:{},proposal:{},orchestration:{},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:overview()}}};
 const state={sourcePrompt:'Track parts and local targets',subject:'Parts',functionSignature:'parts_fixture',interaction,orchestration:{workflowId:'parts',routes:[]},intentResult:{title:'Parts',value:'Parts',subtitle:'Saved parts',sections:[],bullets:[]},intentActionCount:0,recentActions:[],entities:[{id:'external-pump',name:'Pump',detail:'Observed part',appRecordId:'pump-local'},{id:'unlinked',name:'Unlinked part',detail:'No local record',appState:{target:999}}],entityStats:[]};
 const data={records:[{id:'turn1',prompt:'Set target',context:'Parts',state:'open',nextStep:'Set target',result:'Observed parts',item_name:'Pump',target:'',note:''}]};
 db.prepare('INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('parts','Parts','Local targets',JSON.stringify(pkg),JSON.stringify(data),JSON.stringify(state),'1','fixture-owner');
 const adapter=createAppStateAdapter(db,'fixture-owner','parts',fields,['storage.app','app_state.write'])!;adapter.call('app_state.upsert_record',{recordId:'pump-local',values:{item_name:'Pump',target:249,note:null}});
 return {db,runtime,adapter};
}
test('actual SQLite association is owner/app scoped and query/reopen reads current values without inventing primary rows',async t=>{
 const f=await fixture(t);let q=await f.runtime.queryState({user:'fixture-owner'});let rows=q.apps[0].appPackage.ui.meta.a2ui.initialData.entities;
 assert.equal(rows.length,2);assert.equal(rows[0].appState.target,249);assert.equal(rows[0].appState.note,'Not set');assert.equal(rows[1].appState.target,'Not set');
 f.adapter.call('app_state.upsert_record',{recordId:'pump-local',values:{target:199}});q=await f.runtime.queryState({user:'fixture-owner'});assert.equal(q.apps[0].appPackage.ui.meta.a2ui.initialData.entities[0].appState.target,199);assert.equal((await f.runtime.queryState({user:'other-owner'})).apps.length,0);
});
test('real product DOM shows actual local target then SQLite update on fresh reopen without model or business actions',async t=>{
 let chrome;for(const c of [process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'])if(c&&fs.existsSync(c)){chrome=c;break;}if(!chrome)return t.skip('Chrome unavailable; state DOM unexecuted');
 const f=await fixture(t);let actionCalls=0;const root=path.join(process.cwd(),'frontend/snapshot');
 const server=http.createServer(async(req,res)=>{try{const route=new URL(req.url!,'http://local').pathname.replace(/^\/liveui/,'')||'/';for await(const _ of req){}const json=(v:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(route==='/agent/query-state')return json(await f.runtime.queryState({user:'fixture-owner'}));if(route==='/agent/action'){actionCalls++;return json({error:'Business calls forbidden'},500);}if(route==='/agent/identity')return json({ownerScope:'a'.repeat(64)});if(route==='/agent/settings')return json({user:{models:[]},server:{models:[]},effective:{model:'offline',models:[]}});if(route==='/agent/runtime-settings')return json({harness:'native',choices:[{id:'native',label:'Native',available:true}],model:{id:'offline'}});if(route==='/agent/models')return json({models:['offline'],default:'offline'});if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});if(route==='/agent/chat-history')return json({messages:[]});if(route.startsWith('/agent/'))return json({});const name=route==='/'?'index.html':route.slice(1);if(name.includes('..'))throw Error('Bad resource');res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(path.join(root,name)));}catch(e){res.writeHead(500);res.end(String(e));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));let browser:any;const errors:string[]=[];
 try{browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.on('pageerror',(e:any)=>errors.push(e.message));await page.setViewport({width:1440,height:1000});const url=`http://127.0.0.1:${(server.address()as any).port}/liveui/`;
  for(const [phase,value]of [['before',249],['reopened',199]]as const){if(phase==='reopened'){f.adapter.call('app_state.upsert_record',{recordId:'pump-local',values:{target:value}});await page.setViewport({width:390,height:1000});}await page.goto(url);await page.waitForSelector('[data-app-id="parts"]');await page.click('[data-app-id="parts"]',{clickCount:2});await page.waitForSelector('.a2ui-host');await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});const text=await page.$eval('.a2ui-host',(e:Element)=>e.textContent);assert.match(text!,new RegExp(String(value)));assert.match(text!,/Target cost/);assert.match(text!,/Not set/);if(phase==='reopened')assert.doesNotMatch(text!,/249/);if(process.env.NATIVE_STATE_RENDER_OUT){fs.mkdirSync(process.env.NATIVE_STATE_RENDER_OUT,{recursive:true});await page.screenshot({path:path.join(process.env.NATIVE_STATE_RENDER_OUT,phase+'.png')});fs.writeFileSync(path.join(process.env.NATIVE_STATE_RENDER_OUT,phase+'-dom.txt'),text!);}}
  assert.equal(actionCalls,0);assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
