import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import {validateStructuredUiTree} from '../server/structured-ui.js';
const script=fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url),'utf8');
const chrome=[process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(x=>x&&fs.existsSync(x));
test('trusted structured runtime validates and commits real DOM only after persistence ACK',async t=>{
 assert.ok(chrome,'Chrome is required for this browser verification');
 const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setViewport({width:390,height:844});await page.setContent('<div id="view">OLD DOM</div>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+script});
 await page.evaluate(()=>{
  const w:any=window;w.records=[{id:'r1',text:'Original <script>window.pwned=1</script>',checked:false},{id:'r2',text:'Second task',checked:true}];w.saved={};w.saveCount=0;w.events=[];
  w.sdk={storage:{getItem:(key:string)=>w.saved[key]??null},ai:async(_prompt:string,context:any)=>{w.context=context;return new Promise(resolve=>w.aiReply=resolve);},save:async(key:string,value:string)=>{w.saveCount++;return new Promise((resolve,reject)=>{w.ack=()=>{w.saved[key]=value;resolve({ok:true});};w.fail=()=>reject(Error('Persistence failed'));});}};
  w.ui=w.__liveuiStructuredRuntime(w.sdk);w.options={storageKey:'layout',getRecords:()=>w.records,onToggle:(id:string,checked:boolean)=>{w.events.push({id,checked});w.records=w.records.map((r:any)=>r.id===id?{...r,checked}:r);}};
  w.tree={type:'Grid',style:{columns:2},children:[{type:'Card',children:[{type:'Checklist',children:[{type:'Checklist',recordId:'r1',checked:true,children:[]}]}]},{type:'Checklist',children:[{type:'Checklist',recordId:'r2',checked:false,children:[]}]}]};
  w.options.previousTree={type:'Text',text:'Prior layout'};
  w.start=()=>{w.operation=w.ui.generate(document.querySelector('#view'),'Reorganize',w.options).then((value:any)=>({ok:true,value}),(error:any)=>({ok:false,error:error.message}));};
  w.respond=(tree=w.tree)=>w.aiReply({text:'Layout ready',requestId:w.context.requestId,data:{tree}});
  w.start();w.respond();
 });
 await page.waitForFunction(()=>(window as any).saveCount===1);
 assert.deepEqual(await page.evaluate(()=>(window as any).context.tree),{type:'Text',text:'Prior layout'});
 assert.equal(await page.$eval('#view',e=>e.textContent),'OLD DOM');assert.equal(await page.evaluate(()=>(window as any).saved.layout),undefined);
 await page.evaluate(()=>(window as any).ack());assert.equal((await page.evaluate(()=>(window as any).operation)).ok,true);
 assert.match(await page.$eval('#view',e=>e.textContent||''),/Original <script>/);assert.equal(await page.evaluate(()=>(window as any).pwned),undefined);
 assert.equal(await page.$$eval('#view input',xs=>xs.length),2);assert.deepEqual(await page.$$eval('#view input',xs=>xs.map(x=>(x as HTMLInputElement).checked)),[false,true]);
 await page.click('#view input');assert.deepEqual(await page.evaluate(()=>(window as any).events),[{id:'r1',checked:true}]);
 assert.equal(await page.$eval('#view',e=>e.scrollWidth<=e.clientWidth),true,'grid must fit 390px viewport');
 await page.evaluate(()=>{const w:any=window;w.ui.render(document.querySelector('#view'),w.tree,{records:w.records,onToggle:async()=>false});});
 await page.click('#view input');assert.equal(await page.$eval('#view input',e=>(e as HTMLInputElement).checked),true,'false toggle result rolls back to the previously checked state');

 await page.evaluate(()=>{const w:any=window;w.beforeDom=document.querySelector('#view')!.innerHTML;w.beforeStore=w.saved.layout;w.start();w.respond();});
 await page.waitForFunction(()=>(window as any).saveCount===2);await page.evaluate(()=>(window as any).fail());
 const failure=await page.evaluate(()=>(window as any).operation);assert.equal(failure.ok,false);assert.match(failure.error,/Persistence failed/);
 assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).beforeDom),true);assert.equal(await page.evaluate(()=>(window as any).saved.layout===(window as any).beforeStore),true);
 await page.evaluate(()=>{const w:any=window;w.start();w.records.push({id:'r3',text:'Edited while waiting'});w.respond();});
 const stale=await page.evaluate(()=>(window as any).operation);assert.equal(stale.ok,false);assert.match(stale.error,/Content changed/);assert.equal(await page.evaluate(()=>(window as any).saveCount),2,'late response must not save');
 assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).beforeDom),true);
 await page.evaluate(()=>{const w:any=window;w.records=w.records.filter((r:any)=>r.id!=='r3');const restored=w.ui.read('layout');w.ui.render(document.querySelector('#view'),restored.tree,{records:w.records,onToggle:w.options.onToggle});});
 assert.equal(await page.$$eval('#view input',xs=>xs.length),2,'restore uses the same renderer');

 // Navigation replaces the same container while getRecords keeps a valid old-section closure.
 await page.evaluate(()=>{const w:any=window;w.start();document.querySelector('#view')!.replaceChildren(Object.assign(document.createElement('p'),{textContent:'OTHER SECTION'}));w.respond();});
 const navigated=await page.evaluate(()=>(window as any).operation);assert.equal(navigated.ok,false);assert.equal(await page.evaluate(()=>(window as any).saveCount),2);
 assert.equal(await page.$eval('#view',e=>e.textContent),'OTHER SECTION');
 // Even if navigation happens after the save starts, late ACK cannot paint over it.
 await page.evaluate(()=>{const w:any=window;w.start();w.respond();});await page.waitForFunction(()=>(window as any).saveCount===3);
 await page.evaluate(()=>{document.querySelector('#view')!.replaceChildren(Object.assign(document.createElement('p'),{textContent:'THIRD SECTION'}));(window as any).ack();});
 const duringSave=await page.evaluate(()=>(window as any).operation);assert.equal(duringSave.ok,false);assert.equal(await page.$eval('#view',e=>e.textContent),'THIRD SECTION');
 const rejected=await page.evaluate(()=>{const w:any=window;const results=[];for(const tree of [{type:'Text',text:'x',innerHTML:'<img onerror=alert(1)>'},{type:'Image',photoId:'p1'},{type:'Text',text:'x',style:{fontSize:104}}]){try{w.ui.render(document.querySelector('#view'),tree,{records:[],photos:[{id:'p1',src:'javascript:alert(1)'}]});results.push(false);}catch{results.push(true);}}return results;});assert.deepEqual(rejected,[true,true,true]);
});

test('server-validated production tree renders through browser helper',async t=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/structured-ui-946.json',import.meta.url),'utf8'));
 const tree=validateStructuredUiTree(fixture.tree,{uiProtocol:'liveui-tree-v1',records:fixture.records,photos:[]});
 const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent('<main id="view"></main>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+script});
 await page.evaluate(({tree,records})=>{const w:any=window;w.__liveuiStructuredRuntime({}).render(document.querySelector('#view'),tree,{records,onToggle:async()=>true});},{tree,records:fixture.records});
 assert.equal(await page.$$eval('#view input',xs=>xs.length),3);
});
