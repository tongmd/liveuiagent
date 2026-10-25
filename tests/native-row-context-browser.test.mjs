import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

// Actual product renderer, local fixture HTTP only: no model, world, or business writes.
test('row click binds current composer input and selected identity; unknown outcome is not retried', async t => {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (!candidate) continue; try { await fs.access(candidate); chrome = candidate; break; } catch {}
  }
  if (!chrome) return t.skip('Chrome unavailable; row context unexecuted');
  const root = new URL('../frontend/snapshot/', import.meta.url);
  const components = [
    {id:'root',component:'Card',child:'body'},
    {id:'body',component:'Column',children:['folder','list']},
    {id:'folder',component:'TextField',label:'Destination',value:{path:'/draft/slots/folder'}},
    {id:'list',component:'List',children:{componentId:'row',path:'/entities'}},
    {id:'row',component:'Card',child:'rowBody'},
    {id:'rowBody',component:'Column',children:['title','move','done']},
    {id:'title',component:'Text',text:{path:'/entityName'}},
    {id:'moveLabel',component:'Text',text:'Move'},
    {id:'doneLabel',component:'Text',text:'Mark done'},
    {id:'move',component:'Button',child:'moveLabel',action:{event:{name:'actions.move.run',context:{folder:{path:'/draft/slots/folder'},entityName:{path:'/entityName'},entityId:{path:'/id'}}}}},
    {id:'done',component:'Button',child:'doneLabel',action:{event:{name:'actions.done.run',context:{entityName:{path:'/entityName'},entityId:{path:'/id'}}}}},
  ];
  const data = {entityName:'Wrong root identity',id:'wrong-root',draft:{slots:{folder:'Stale destination',amount:'Stale amount'}},entities:[{id:'one',entityName:'First item',draft:{slots:{folder:'Forged row destination'}}},{id:'two',entityName:'Second item',draft:{slots:{folder:'Forged row destination'}}}]};
  const app = {appId:'row_fixture',name:'Row fixture',description:'Local renderer fixture',version:'1',status:'ready',records:2,preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],widget:{kind:'empty',items:[],stats:[],itemLabel:'Items'}},appPackage:{manifest:{appId:'row_fixture',name:'Row fixture',permissions:[]},actions:{actions:{}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{a2ui:{protocol:'a2ui',surfaceId:'fixture',initialData:data,messages:[{updateComponents:{surfaceId:'fixture',components}},{updateDataModel:{surfaceId:'fixture',value:data}}]}}}},appData:{},runtimeState:{}};
  const calls=[];const errors=[];
  const server=http.createServer(async(req,res)=>{try{
    const route=new URL(req.url,'http://local').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const chunk of req)raw+=chunk;
    const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(route==='/agent/query-state')return json({apps:[app],canvasState:{canvasId:'home',nodes:[{id:'node_row_fixture',type:'app_card',appId:app.appId,position:{x:72,y:72},size:{width:104,height:124},status:'ready'}],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom',placeholder:''}},summary:{text:'Fixture',apps:[]}});
    if(route==='/agent/action'){calls.push(JSON.parse(raw));return json({error:'Unknown delivery outcome; do not retry'},500);}
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
    browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1000});await page.goto(`http://127.0.0.1:${server.address().port}/liveui/`);
    await page.waitForSelector('[data-app-id="row_fixture"]');await page.click('[data-app-id="row_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');
    await page.locator('.a2ui-host input').fill('New destination');
    assert.equal(calls.length,0,'typing never starts a business action');
    await page.click('.a2ui-host [data-a2ui-row-name="Second item"][data-a2ui-action-id="actions.move.run"]');
    await page.waitForFunction(()=>document.body.innerText.includes('Unknown delivery outcome'));
    assert.equal(calls.length,1);assert.deepEqual(calls[0].eventPayload,{folder:'New destination',entityName:'Second item',entityId:'two',sourceComponentId:'move'});
    await page.waitForFunction(()=>!document.querySelector('.a2ui-host [data-a2ui-action-id="actions.done.run"]').disabled);
    await page.click('.a2ui-host [data-a2ui-row-name="First item"][data-a2ui-action-id="actions.done.run"]');
    await page.waitForFunction(()=>!document.querySelector('.a2ui-host [data-a2ui-action-id="actions.done.run"]').disabled);
    assert.equal(calls.length,2);assert.deepEqual(calls[1].eventPayload,{entityName:'First item',entityId:'one',sourceComponentId:'done'});
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(calls.length,2,'unknown outcomes never automatically resend');assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
