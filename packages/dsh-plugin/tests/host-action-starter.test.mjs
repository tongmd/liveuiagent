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
test('a domain Add control projects only actual SDK records and preserves them on failure and reopen',async t=>{
 const domain=`<label>Item <input id="domain-name"></label><button id="domain-add">Add</button><ul id="domain-records"></ul><p id="domain-error" role="alert"></p>`;
 const script=`<script>function project(){const rows=window.liveuiapp.lastResult?.data?.entities||[];document.querySelector('#domain-records').replaceChildren(...rows.map(row=>{const li=document.createElement('li');li.textContent=row.name;return li}))}document.addEventListener('liveui:result',project);project();document.querySelector('#domain-add').onclick=async()=>{const name=document.querySelector('#domain-name').value;const reply=await window.liveuiapp.perform('Add '+name,{name});document.querySelector('#domain-error').textContent=reply?.ok===true?'':reply?.error||'Not completed';if(reply?.ok===true)project()};</script>`;
 const html=connectedStarterHtml().replace('<section id="liveui-domain-view"><ul data-liveui-view="records" data-liveui-default-projection></ul></section>','<section id="liveui-domain-view">'+domain+'</section>').replace('</body>',script+'</body>');
 const server=http.createServer((_q,r)=>{r.writeHead(200,{'Content-Type':'text/html'});r.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});
 const browser=await puppeteer.launch({executablePath:await chrome(),headless:true,args:['--no-sandbox'],pipe:true});t.after(async()=>{await browser.close();for(const s of browser.process()?.stdio||[])s?.destroy?.()});const page=await browser.newPage();let success=false,calls=0;
 await page.exposeFunction('domainSdk',async(prompt,fields)=>{calls++;assert.equal(prompt,'Add Requested record');assert.equal(fields.name,'Requested record');return success?{ok:true,text:'Read back record',data:{entities:[{name:'Server normalized record'}]}}:{ok:false,error:'Write denied'};});
 await page.evaluateOnNewDocument(()=>{window.liveuiagent={ai:(p,c)=>window.domainSdk(p,c)}});await page.goto(`http://127.0.0.1:${server.address().port}`);
 assert.equal(await page.$eval('#domain-records',n=>n.textContent),'');assert.equal(calls,0);await page.type('#domain-name','Requested record');await page.click('#domain-add');await page.waitForFunction(()=>document.querySelector('#domain-error').textContent==='Write denied');assert.equal(await page.$eval('#domain-records',n=>n.textContent),'');
 success=true;await page.click('#domain-add');await page.waitForFunction(()=>document.querySelector('#domain-records').textContent==='Server normalized record');assert.equal(calls,2);await page.reload();assert.equal(await page.$eval('#domain-records',n=>n.textContent),'Server normalized record');assert.equal(calls,2,'reopen does not repeat a write');
 success=false;await page.type('#domain-name','Requested record');await page.click('#domain-add');await page.waitForFunction(()=>document.querySelector('#domain-error').textContent==='Write denied');assert.equal(await page.$eval('#domain-records',n=>n.textContent),'Server normalized record');
});
test('restored records are available to early and late domain listeners before ready without service calls',async t=>{
 const html=connectedStarterHtml().replace('<script>','<script>window.early=[];document.addEventListener("liveui:result",()=>window.early.push(window.liveuiapp?.lastResult?.text));</script><script>').replace('</body>','<script>window.late=[];document.addEventListener("liveui:ready",()=>window.late.push(window.liveuiapp.lastResult.text));document.addEventListener("liveui:result",()=>window.late.push(window.liveuiapp.lastResult.text));</script></body>');
 const browser=await puppeteer.launch({executablePath:await chrome(),headless:true,args:['--no-sandbox'],pipe:true});t.after(async()=>{await browser.close();for(const s of browser.process()?.stdio||[])s?.destroy?.()});const page=await browser.newPage();let calls=0;await page.exposeFunction('unexpectedSdk',()=>{calls++;throw Error('Reopen must not call a service')});await page.evaluateOnNewDocument(()=>{const cache=JSON.stringify({schemaVersion:1,result:{ok:true,text:'Actual cached record',data:{entities:[{name:'Observed item'}]}}});Object.defineProperty(window,'localStorage',{value:{getItem:()=>cache,setItem:()=>{}}});window.liveuiagent={ai:()=>window.unexpectedSdk()}});await page.goto('data:text/html,'+encodeURIComponent(html));
 assert.deepEqual(await page.evaluate(()=>window.early),['Actual cached record']);assert.deepEqual(await page.evaluate(()=>window.late),['Actual cached record','Actual cached record']);assert.equal(calls,0);assert.match(await page.$eval('#liveui-task-entities',n=>n.textContent),/Observed item/);
});
