// Real Chrome renderer integration; API fixture, no model/service calls.
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const root=new URL('../frontend/snapshot/',import.meta.url);let saved='',calls=[],release=null,scope='a'.repeat(64);
const app=()=>({appId:'native_fixture',name:'Native Notes',description:'Native fixture',status:'ready',version:'1',preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],presentation:{glyph:'N',collection:'Notes',tagline:'',metric:'0',rows:0,live:true},widget:{kind:'entities',items:[],stats:[],itemLabel:'Records'}},appPackage:{manifest:{appId:'native_fixture',name:'Native Notes',permissions:[]},actions:{actions:{save:{}}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{a2ui:{protocol:'a2ui',surfaceId:'main',initialData:{draft:'',saved},messages:[{createSurface:{surfaceId:'main'}},{updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['draft','save','saved']},{id:'draft',component:'TextField',label:'Note',value:{path:'/draft'}},{id:'save',component:'Button',variant:'primary',child:'label',action:{event:{name:'actions.save',context:{note:{path:'/draft'}}}}},{id:'label',component:'Text',text:'Save note'},{id:'saved',component:'Text',text:{path:'/saved'}}]}},{updateDataModel:{surfaceId:'main',value:{draft:'',saved}}}]}}}},appData:{},runtimeState:{}});
const server=http.createServer(async(req,res)=>{try{const route=new URL(req.url,'http://local').pathname.replace(/^\/liveui/,'')||'/';let body='';for await(const b of req)body+=b;const input=body?JSON.parse(body):{};calls.push({route,input});const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
if(route==='/agent/identity')return json({ownerScope:scope});
if(route==='/agent/query-state')return json({apps:[app()],canvasState:{canvasId:'home',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom'}},summary:{text:'',apps:[]}});
if(route==='/agent/settings')return json({user:{models:[]},server:{models:['fixture'],hasApiKey:true},effective:{model:'fixture',models:['fixture'],keySource:'server'},warnings:[]});
if(route==='/agent/runtime-settings')return json({harness:'native',choices:[{id:'native',label:'Native Agent',available:true}],model:{id:'fixture'}});
if(route==='/agent/models')return json({models:['fixture'],default:'fixture'});
if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
if(route==='/agent/chat-history')return json({messages:[]});
if(route==='/agent/chat-append')return json({id:1});
if(route==='/agent/action'){assert.equal(input.appId,'native_fixture');assert.equal(input.actionId,'save');if(input.eventPayload.note==='Rejected request')return json({error:'Actual service failure'},503);if(input.eventPayload.note==='Slow submitted')await new Promise(resolve=>release=resolve);saved=input.eventPayload.note;return json({type:'action_result',messages:['Saved'],trace:[]});}
if(route.startsWith('/agent/'))return json({ok:true,trace:[]});
const file=route==='/'?'index.html':route.slice(1);const data=await fs.readFile(new URL(file,root));res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(data);
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1000});
  const base=`http://127.0.0.1:${server.address().port}/liveui/`;
  async function open(){await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-app-id="native_fixture"]');await page.click('[data-app-id="native_fixture"]',{clickCount:2});await page.waitForSelector('.a2ui-host input');}
  async function fill(text){await page.focus('.a2ui-host input');await page.$eval('.a2ui-host input',e=>e.select());await page.keyboard.press('Backspace');await page.type('.a2ui-host input',text);assert.equal(await page.$eval('.a2ui-host input',e=>e.value),text,'Fixture keyboard fill must match intended input');}
  const button='.a2ui-host [data-a2ui-action-id="actions.save"]';
  await open();await fill('Rejected request');await page.click(button);await page.waitForFunction(()=>document.body.textContent.includes('Actual service failure'));
  await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host input').value==='Rejected request');
  await fill('Slow submitted');await page.click(button);const started=Date.now();while(!release){if(Date.now()-started>10000)throw Error('Expected submitted payload not observed: '+JSON.stringify(calls.filter(c=>c.route==='/agent/action')));await new Promise(r=>setTimeout(r,10));}
  assert.equal(await page.$eval('.a2ui-host input',e=>e.disabled),false,'New draft remains editable while submitted snapshot runs');
  await fill('New draft during save');release();release=null;
  await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('Slow submitted'));
  assert.equal(await page.$eval('.a2ui-host input',e=>e.value),'New draft during save');
  await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host input').value==='New draft during save');
  await fill('Final committed note');await page.click(button);await page.waitForFunction(()=>document.querySelector('.a2ui-host')?.textContent.includes('Final committed note'));await page.waitForFunction(()=>document.querySelector('.a2ui-host input').value==='');
  await open();assert.equal(await page.$eval('.a2ui-host input',e=>e.value),'');
  await fill('Unsubmitted A draft');await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host input').value==='Unsubmitted A draft');
  scope='b'.repeat(64);await open();assert.equal(await page.$eval('.a2ui-host input',e=>e.value),'','Different account cannot load A draft');
  scope='a'.repeat(64);await open();await page.waitForFunction(()=>document.querySelector('.a2ui-host input').value==='Unsubmitted A draft');
  await page.setViewport({width:390,height:844});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['failed action draft restored after refresh','input stays editable during action','success clears only submitted snapshot and retains newer draft','unsubmitted draft survives immediate refresh','owner-isolated draft storage','native server results preserved','desktop/mobile without page errors'],actionRequests:calls.filter(x=>x.route==='/agent/action').length,modelCalls:0,serviceCalls:0}));
} finally {if(release)release();if(browser){const owned=browser.process();await Promise.race([browser.close(),new Promise(resolve=>setTimeout(()=>{owned?.kill('SIGTERM');resolve()},3000).unref())]);}server.closeAllConnections();await new Promise(r=>server.close(r));}
