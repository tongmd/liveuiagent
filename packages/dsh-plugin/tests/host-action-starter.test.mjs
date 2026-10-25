import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import {connectedStarterHtml,seedConnectedApp} from '../host-action-starter.mjs';
import {validateBrowserDelivery} from '../browser-delivery.mjs';

async function chrome(){for(const p of [process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'])if(p){try{await fs.access(p);return p}catch{}}throw Error('Chrome required');}
test('new connected starter passes the real trusted-click SDK/error contract',async()=>{
 const result=await validateBrowserDelivery(connectedStarterHtml(),{requireAgentAction:true});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.businessBehaviorVerified,false);
});
test('seeding does not overwrite an existing app or claim checks that have not run',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-starter-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 assert.equal(await seedConnectedApp(dir),true);const first=await fs.readFile(path.join(dir,'index.html'),'utf8');assert.match(first,/data-liveui-action="agent.invoke"/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'app.json'),'utf8')).checks,[]);
 await fs.writeFile(path.join(dir,'index.html'),'existing user app');assert.equal(await seedConnectedApp(dir),false);assert.equal(await fs.readFile(path.join(dir,'index.html'),'utf8'),'existing user app');
});
test('observed successful results and entities remain visible after reopen; failed results preserve draft/cache and provide context',async t=>{
 const server=http.createServer((_q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(connectedStarterHtml())});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});
 const browser=await puppeteer.launch({executablePath:await chrome(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],pipe:true});t.after(async()=>{await browser.close();for(const stream of browser.process()?.stdio||[])stream?.destroy?.()});
 const page=await browser.newPage();const calls=[];let allow=true,store={},setupId;
 await page.exposeFunction('fixtureCall',async(prompt,context)=>{calls.push({prompt,context});return allow?{ok:true,text:'A note was read back from the service',data:{entities:[{name:'Confirmed book',detail:'Observed verdict'}],stats:[{label:'Books',value:'1'}],evaluation:{pass:true}}}:{ok:false,error:'Service rejected the new change'};});
 async function open(){if(setupId)await page.removeScriptToEvaluateOnNewDocument(setupId);const setup=await page.evaluateOnNewDocument(initial=>{const values={...initial};Object.defineProperty(window,'localStorage',{value:{getItem:k=>values[k]??null,setItem:(k,v)=>{values[k]=String(v)}}});window.liveuiagent={ai:(prompt,context)=>window.fixtureCall(prompt,context)};},store);setupId=setup.identifier;await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});}
 await open();assert.equal(calls.length,0);await page.type('#liveui-task','Read my shelf');await page.click('#liveui-task-submit');await page.waitForFunction(()=>document.querySelector('#liveui-task-status').dataset.state==='ready');
 assert.equal(calls.length,1);assert.equal(calls[0].prompt,'Read my shelf');assert.match(await page.$eval('#liveui-task-result',n=>n.textContent),/read back/);assert.match(await page.$eval('#liveui-task-entities',n=>n.textContent),/Confirmed book/);assert.match(await page.$eval('#liveui-task-stats',n=>n.textContent),/Books1/);
 const cache=await page.evaluate(()=>localStorage.getItem('liveui.observed-service-result.v1'));store={'liveui.observed-service-result.v1':cache};await open();assert.equal(calls.length,1,'reopen does not repeat service writes');assert.match(await page.$eval('#liveui-task-result',n=>n.textContent),/read back/);assert.match(await page.$eval('#liveui-task-entities',n=>n.textContent),/Observed verdict/);
 allow=false;await page.type('#liveui-task','Change the second item');await page.click('#liveui-task-submit');await page.waitForFunction(()=>document.querySelector('#liveui-task-status').dataset.state==='error');assert.match(await page.$eval('#liveui-task-status',n=>n.textContent),/Service rejected/);assert.equal(await page.$eval('#liveui-task',n=>n.value),'Change the second item');assert.equal(await page.evaluate(()=>localStorage.getItem('liveui.observed-service-result.v1')),cache);assert.equal(calls[1].context.lastVerified.text,'A note was read back from the service');
});
