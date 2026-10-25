import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

// Actual product renderer, local fixture HTTP only: no model, world, or business writes.
test('all declared business controls are editable and optional values can remain empty without autosubmit', async t => {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (!candidate) continue; try { await fs.access(candidate); chrome = candidate; break; } catch {}
  }
  if (!chrome) return t.skip('Chrome unavailable; row context unexecuted');
  const root = new URL('../frontend/snapshot/', import.meta.url);
  const slots = [
    {name:'wake_time',label:'Wake time',required:true,value:'07:00'},
    {name:'alarm_label',label:'Alarm label',required:false,value:''},
    {name:'weekday',label:'Weekday',required:false,value:''},
    {name:'snooze',label:'Snooze',required:false,value:''},
    {name:'notes',label:'Notes',required:false,value:''},
  ];
  const components = [
    {id:'root',component:'Card',child:'body'},
    {id:'body',component:'Column',children:[...slots.map(s=>s.name),'save']},
    ...slots.map(s=>({id:s.name,component:'TextField',label:s.label,value:{path:'/draft/slots/'+s.name},variant:s.name==='notes'?'longText':'shortText'})),
    {id:'saveLabel',component:'Text',text:'Save'},
    {id:'save',component:'Button',child:'saveLabel',action:{event:{name:'actions.save.run',context:Object.fromEntries(slots.map(s=>[s.name,{path:'/draft/slots/'+s.name}]))}}},
  ];
  const data = {draft:{slots:Object.fromEntries(slots.map(s=>[s.name,s.value]))},entities:[]};
  const app = {appId:'row_fixture',name:'Row fixture',description:'Local renderer fixture',version:'1',status:'ready',records:2,preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],widget:{kind:'empty',items:[],stats:[],itemLabel:'Items'}},appPackage:{manifest:{appId:'row_fixture',name:'Row fixture',permissions:[],interaction:{businessFields:slots.map(({name,label,required})=>({name,label,required,type:name==='notes'?'text':'string'}))}},actions:{actions:{}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{a2ui:{protocol:'a2ui',surfaceId:'fixture',initialData:data,messages:[{updateComponents:{surfaceId:'fixture',components}},{updateDataModel:{surfaceId:'fixture',value:data}}]}}}},appData:{},runtimeState:{}};
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
    await page.$$eval('.a2ui-host .a2ui-field', fields=>fields.forEach(field=>{const input=field.querySelector('input,textarea');if(input)input.setAttribute('data-test-field',field.querySelector('span')?.textContent||'')}));
    for(const width of [1440,390]) {
      await page.setViewport({width,height:1000});
      const controls=await page.$$eval('.a2ui-host input,.a2ui-host textarea', els=>els.map(e=>({disabled:e.disabled,readOnly:e.readOnly,required:e.required,valid:e.checkValidity()})));
      assert.equal(controls.length,slots.length);assert.ok(controls.every(c=>!c.disabled&&!c.readOnly&&!c.required&&c.valid));
      for(const slot of slots) {
        // Native TextField labels are actual wrapping labels, so locate by their visible text.
        const control=page.locator(`[data-test-field="${slot.label}"]`);
        await control.fill(slot.name==='wake_time'?'05:45':'Edited '+slot.name);
      }
      assert.equal(calls.length,0,'editing every reachable declared field never starts business');
    }
    // Leave optional controls blank: they remain editable, valid, and do not block submission.
    for(const slot of slots.filter(s=>!s.required)) {
      await page.$eval(`[data-test-field="${slot.label}"]`, input=>{input.focus();input.select();});
      await page.keyboard.press('Backspace');
    }
    assert.deepEqual(await page.$$eval('.a2ui-host input,.a2ui-host textarea',els=>els.map(e=>e.value)),['05:45','','','','']);
    await page.click('.a2ui-host [data-a2ui-action-id="actions.save.run"]');
    await page.waitForFunction(()=>document.body.innerText.includes('Unknown delivery outcome'));
    assert.equal(calls.length,1);assert.deepEqual(calls[0].eventPayload,{wake_time:'05:45',alarm_label:'',weekday:'',snooze:'',notes:'',sourceComponentId:'save'});
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(calls.length,1);assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
