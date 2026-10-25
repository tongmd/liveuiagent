import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import {connectedStarterHtml} from '../host-action-starter.mjs';
import {validateBrowserDelivery} from '../browser-delivery.mjs';

async function chrome(){for(const file of [process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])if(file){try{await fs.access(file);return file}catch{}}throw Error('Chrome required');}
const slot = '<ul data-liveui-view="records" data-liveui-default-projection></ul>';
test('core-only observed entities do not satisfy domain delivery; local apps remain unaffected', async () => {
 const html = connectedStarterHtml().replace(slot, '');
 const result = await validateBrowserDelivery(html,{requireAgentAction:true});
 assert.equal(result.ok,false);assert.match(JSON.stringify(result.errors),/domain record surface omitted/);
 assert.equal((await validateBrowserDelivery(html)).ok,true);
});
test('fresh connected records cannot contain unobserved business facts; editable drafts remain allowed', async () => {
 const prefilled=connectedStarterHtml().replace(slot,'<ul data-liveui-view="records" data-liveui-default-projection><li>Unobserved record and value</li></ul>');
 const rejected=await validateBrowserDelivery(prefilled,{requireAgentAction:true});
 assert.equal(rejected.ok,false);assert.match(JSON.stringify(rejected.errors),/fresh connected app must start with an empty/);
 const draft=connectedStarterHtml().replace('</main>','<label>Draft amount <input value="1850"></label><p>Draft invoice supplied by the user</p></main>');
 const accepted=await validateBrowserDelivery(draft,{requireAgentAction:true});
 assert.equal(accepted.ok,true,JSON.stringify(accepted));
});
test('unknown groups and every observed field survive domain projection and later failure', async () => {
 const result = await validateBrowserDelivery(connectedStarterHtml(),{requireAgentAction:true});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.agentAction.displayedDomainRecords,true);
 assert.equal(result.agentAction.preservedRecordsOnFailure,true);
 assert.equal(result.agentAction.realServiceExecuted,false);
});
test('cache commits before result notification; rejected storage preserves the actual success', async t => {
 const browser=await puppeteer.launch({executablePath:await chrome(),headless:true,args:['--no-sandbox'],pipe:true});
 t.after(async()=>{await browser.close();for(const s of browser.process()?.stdio||[])s?.destroy?.()});
 const page=await browser.newPage();
 await page.evaluateOnNewDocument(()=>{
   const values={};window.rejectCache=false;window.events=[];window.calls=0;
   Object.defineProperty(window,'localStorage',{value:{getItem:k=>values[k]??null,setItem:(k,v)=>{if(window.rejectCache)throw Error('Storage denied');values[k]=v}}});
   window.liveuiagent={ai:async()=>({ok:true,text:'Actual completed '+(++window.calls),data:{entities:[{name:'Observed '+window.calls,detail:'Server detail',group:'unrecognized'}]}})};
   document.addEventListener('liveui:result',e=>window.events.push({event:e.detail.text,current:window.liveuiapp.lastResult.text,cached:JSON.parse(localStorage.getItem('liveui.observed-service-result.v1'))?.result.text}));
 });
 await page.goto('data:text/html,'+encodeURIComponent(connectedStarterHtml()));
 const first=await page.evaluate(()=>window.liveuiapp.perform('First request'));
 assert.equal(first.ok,true);
 assert.deepEqual(await page.evaluate(()=>window.events[0]),{event:'Actual completed 1',current:'Actual completed 1',cached:'Actual completed 1'});
 const second=await page.evaluate(()=>{window.rejectCache=true;return window.liveuiapp.perform('Second request')});
 assert.equal(second.ok,true);
 assert.equal(await page.$eval('[data-liveui-view="records"]',e=>e.innerText),'Observed 2 · Server detail · unrecognized');
 assert.equal(await page.$eval('#liveui-task-status',e=>e.dataset.state),'ready');
 assert.match(await page.$eval('#liveui-task-status',e=>e.innerText),/could not be saved for reopening/);
 assert.equal(await page.evaluate(()=>window.calls),2);
 assert.equal(await page.evaluate(()=>window.events[1].current),'Actual completed 2');
});
