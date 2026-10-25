// @ts-nocheck
import {compileSemanticSurface} from '../server/native-surface-design.js';
import {validateDesignedOverview} from '../server/liveuiagent.js';
import {rowActionSlotMap} from '../server/native-action-slots.js';
import {semanticDesign} from './fixtures/native-semantic-design.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import Database from 'better-sqlite3';
import {createAppStateAdapter} from '../server/native-app-state.js';
import {assertRowActionPayload} from '../server/native-action-slots.js';

// Actual product renderer and owner/app SQLite; controlled local HTTP only, no model or external service writes.
test('semantic compiler: actual product phone-width two-row click persists only selected SQLite record; identity-only unknown never retries', async t => {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (!candidate) continue; try { await fs.access(candidate); chrome = candidate; break; } catch {}
  }
  if (!chrome) return t.skip('Chrome unavailable; row context unexecuted');
  const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('row_fixture','fixture-owner');
  const store=createAppStateAdapter(db,'fixture-owner','row_fixture',[{name:'folder',type:'string'},{name:'label',type:'string'},{name:'amount',type:'number'},{name:'enabled',type:'boolean'}],['storage.app','app_state.write']);
  for(const id of ['one','two'])store.call('app_state.upsert_record',{recordKind:'primary_member',recordId:id,values:{folder:'Old folder',label:'Old label',amount:7,enabled:true}});
  const root = new URL('../frontend/snapshot/', import.meta.url);
  const businessFields = [{name:'folder',label:'Destination',type:'string'},{name:'label',label:'Optional label',type:'string'},{name:'amount',label:'Target amount',type:'number'},{name:'enabled',label:'Alert enabled',type:'boolean'}];
  const actions = [{actionId:'actions.add.run',label:'Add item'}, {actionId:'actions.move.run',label:'Move',perItem:true,consumedSlots:['folder','label','amount','enabled']},{actionId:'actions.done.run',label:'Mark done',perItem:true,consumedSlots:[]},{actionId:'actions.remove.run',label:'Remove',perItem:true,consumedSlots:[]}];
  const compiled=compileSemanticSurface(semanticDesign(),{businessFields,actions,persistedStateFields:businessFields});
  const designed=validateDesignedOverview(compiled.components,{slots:businessFields,actionIds:actions.map(a=>a.actionId),rowActionSlots:rowActionSlotMap(actions,businessFields.map(field=>field.name)),requireWidgets:true});
  assert.ok(designed);
  // Match makeA2uiSurface's wrapper and composer-context injection; per-item contexts stay exact.
  const components=[{id:'root',component:'Card',child:'d_overview'},...designed.map(node=>node.component==='Button'&&!node.action.event.context?{...node,action:{event:{...node.action.event,context:Object.fromEntries(businessFields.map(field=>[field.name,{path:'/draft/slots/'+field.name}]))}}}:node)];
  const data = {stats:[],entityName:'Wrong root identity',id:'wrong-root',draft:{statLabel:'Items',statValue:'Two',result:'Current items',slots:{folder:'Stale destination',label:'Stale label',amount:0,enabled:false}},entities:[{id:'',appRecordId:'one',entityName:'Same item',title:'Same item',tag:'Current',draft:{slots:{folder:'Forged row destination'}}},{id:'',appRecordId:'two',entityName:'Same item',title:'Same item',tag:'Current',draft:{slots:{folder:'Forged row destination'}}}]};
  const app = {appId:'row_fixture',name:'Row fixture',description:'Local renderer fixture',version:'1',status:'ready',records:2,preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],widget:{kind:'empty',items:[],stats:[],itemLabel:'Items'}},appPackage:{manifest:{appId:'row_fixture',name:'Row fixture',permissions:[]},actions:{actions:{'move.run':{perItem:true,consumedSlots:['folder','label','amount','enabled']},'done.run':{perItem:true,consumedSlots:[]},'remove.run':{perItem:true,consumedSlots:[]},'add.run':{perItem:false}}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{a2ui:{protocol:'a2ui',surfaceId:'fixture',initialData:data,messages:[{updateComponents:{surfaceId:'fixture',components}},{updateDataModel:{surfaceId:'fixture',value:data}}]}}}},appData:{},runtimeState:{}};
  const calls=[];const errors=[];
  const server=http.createServer(async(req,res)=>{try{
    const route=new URL(req.url,'http://local').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const chunk of req)raw+=chunk;
    const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(route==='/agent/query-state'){data.entities.forEach(row=>{const r=store.call('app_state.read_record',{recordId:row.appRecordId}).record;row.detail=r.values.folder+' · '+r.values.label;});return json({apps:[app],canvasState:{canvasId:'home',nodes:[{id:'node_row_fixture',type:'app_card',appId:app.appId,position:{x:72,y:72},size:{width:104,height:124},status:'ready'}],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom',placeholder:''}},summary:{text:'Fixture',apps:[]}});}
    if(route==='/agent/action'){const request=JSON.parse(raw);calls.push(request);const id=request.actionId.replace(/^actions\./,'');assertRowActionPayload(app.appPackage.actions.actions[id],request.eventPayload,businessFields.map(field=>field.name),data.entities.map(row=>({entityName:row.entityName,entityId:row.id,appRecordId:row.appRecordId})),app.appPackage.ui.meta.a2ui,id);if(id==='done.run')return json({error:'Unknown delivery outcome; do not retry'},500);const p=request.eventPayload;store.call('app_state.upsert_record',{recordKind:'primary_member',recordId:p.appRecordId,values:{folder:p.folder,label:p.label,amount:p.amount,enabled:p.enabled}});return json({ok:true});}
    if(route==='/agent/identity')return json({ownerScope:'a'.repeat(64)});
    if(route==='/agent/settings')return json({user:{models:[]},server:{models:[]},effective:{model:'offline',models:[]}});
    if(route==='/agent/runtime-settings')return json({harness:'native',choices:[{id:'native',label:'Native',available:true}],model:{id:'offline'}});
    if(route==='/agent/models')return json({models:['offline'],default:'offline'});
    if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
    if(route==='/agent/chat-history')return json({messages:[]});
    if(route.startsWith('/agent/'))return json({});
    const name=route==='/'?'index.html':route.slice(1);if(name.includes('..'))throw Error('Bad resource');const bytes=await fs.readFile(new URL(name,root));res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(bytes);
  }catch(error){res.writeHead(500);res.end(String(error));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:1000});await page.goto(`http://127.0.0.1:${server.address().port}/liveui/`);
    await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input',{timeout:5000}).catch(async error=>{throw Error(error.message+'; rendererErrors='+JSON.stringify(errors)+'; visible='+await page.$eval('body',node=>node.innerText));});
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
    assert.equal(await page.$$eval('.a2ui-host [data-a2ui-action-id]:not([data-a2ui-action-id="actions.add.run"])',nodes=>nodes.length),6,'all three legitimate actions appear on each of two rows');
    const overflow=await page.$eval('.a2ui-host',node=>node.scrollWidth>node.clientWidth+2);assert.equal(overflow,false,'390px surface has no horizontal scroll');
    // A legitimate row-only collection has no fabricated global operation, even empty.
    const originalComponents=app.appPackage.ui.meta.a2ui.messages[0].updateComponents.components;
    const originalRows=data.entities;
    for(const count of [2,3]){
      const rowActions=actions.slice(1,count+1);
      const rowCompiled=compileSemanticSurface(semanticDesign(),{businessFields,actions:rowActions,persistedStateFields:businessFields});
      const rowNodes=validateDesignedOverview(rowCompiled.components,{slots:businessFields,actionIds:rowActions.map(a=>a.actionId),rowActionSlots:rowActionSlotMap(rowActions,businessFields.map(f=>f.name)),requireWidgets:true});assert.ok(rowNodes);
      app.appPackage.ui.meta.a2ui.messages[0].updateComponents.components=[{id:'root',component:'Card',child:'d_overview'},...rowNodes];
      for(const populated of [true,false]){
        data.entities=populated?originalRows:[];await page.reload();await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');
        assert.equal(await page.$$eval('.a2ui-host [data-a2ui-action-id]',nodes=>nodes.length),populated?count*2:0);
        assert.equal(await page.$$eval('.a2ui-host input',nodes=>nodes.length),3,'both text fields and numeric input stay editable; toggle stays separate');assert.equal(calls.length,0);
      }
    }
    app.appPackage.ui.meta.a2ui.messages[0].updateComponents.components=originalComponents;data.entities=originalRows;
    await page.reload();await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');
    const savedRows=data.entities;data.entities=[];
    await page.reload();await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input',{timeout:5000}).catch(async error=>{throw Error(error.message+'; rendererErrors='+JSON.stringify(errors)+'; visible='+await page.$eval('body',node=>node.innerText));});
    assert.equal(await page.$$eval('.a2ui-host input',nodes=>nodes.length),3);assert.equal(await page.$$eval('.a2ui-host [data-a2ui-action-id="actions.add.run"]',nodes=>nodes.length),1);assert.equal(calls.length,0);
    data.entities=savedRows;await page.reload();await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input',{timeout:5000}).catch(async error=>{throw Error(error.message+'; rendererErrors='+JSON.stringify(errors)+'; visible='+await page.$eval('body',node=>node.innerText));});
    await page.locator('.a2ui-host input').fill('New destination');
    const inputs=await page.$$('.a2ui-host input');await inputs[1].evaluate(input=>{input.focus();input.select();});await page.keyboard.press('Backspace');await inputs[1].type('Gym');
    assert.equal(calls.length,0,'typing never starts a business action');
    await (await page.$$('.a2ui-host [data-a2ui-row-name="Same item"][data-a2ui-action-id="actions.move.run"]'))[1].click();
    await page.waitForFunction(()=>!document.querySelector('.a2ui-host [data-a2ui-action-id="actions.done.run"]').disabled);
    assert.deepEqual(store.call('app_state.read_record',{recordId:'two'}).record.values,{folder:'New destination',label:'Gym',amount:0,enabled:false});assert.deepEqual(store.call('app_state.read_record',{recordId:'one'}).record.values,{folder:'Old folder',label:'Old label',amount:7,enabled:true});
    assert.equal(calls.length,1);assert.deepEqual(calls[0].eventPayload,{folder:'New destination',label:'Gym',amount:0,enabled:false,entityName:'Same item',entityId:'',appRecordId:'two',sourceComponentId:'d_action_1'});
    await page.waitForFunction(()=>!document.querySelector('.a2ui-host [data-a2ui-action-id="actions.done.run"]').disabled);
    await (await page.$$('.a2ui-host [data-a2ui-row-name="Same item"][data-a2ui-action-id="actions.done.run"]'))[0].click();
    await page.waitForFunction(()=>!document.querySelector('.a2ui-host [data-a2ui-action-id="actions.done.run"]').disabled);
    assert.equal(calls.length,2);assert.deepEqual(calls[1].eventPayload,{entityName:'Same item',entityId:'',appRecordId:'one',sourceComponentId:'d_action_2'});
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(calls.length,2,'unknown outcomes never automatically resend');assert.deepEqual(errors,[]);
    await page.reload();await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('New destination · Gym'));assert.equal(store.call('app_state.read_record',{recordId:'two'}).record.values.folder,'New destination');assert.equal(store.call('app_state.read_record',{recordId:'one'}).record.revision,1);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}
});
