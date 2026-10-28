import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import puppeteer from 'puppeteer-core';
const runtime=()=>fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url),'utf8');
async function setup(t:any){const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent('<html lang="en"><main id="view"></main><textarea id="request"></textarea><button id="generate">Generate</button><output id="status"></output></html>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+runtime()});await page.evaluate(()=>{const w:any=window;w.saved={};w.writes=[];w.aiCalls=[];w.hold=false;w.rejectSave=false;w.pending=[];w.sdk={storage:{getItem:(key:string)=>w.saved[key]??null},save:(key:string,value:string)=>{w.writes.push({key,value});if(w.rejectSave)return Promise.reject(Error('Disk rejected write'));if(!w.hold){w.saved[key]=value;return Promise.resolve({ok:true});}return new Promise(resolve=>w.pending.push(()=>{w.saved[key]=value;resolve({ok:true});}));},ai:async(prompt:string,ctx:any)=>{w.aiCalls.push({prompt,ctx});if(w.aiFailure)throw Error('Model unavailable');return{requestId:ctx.requestId,data:{tree:w.responseTree}};}};w.ui=w.__liveuiStructuredRuntime(w.sdk);w.open=()=>{w.ws?.dispose();w.ws=w.ui.workspace({container:document.querySelector('#view'),requestInput:document.querySelector('#request'),generateButton:document.querySelector('#generate'),status:document.querySelector('#status'),storagePrefix:'test-workspace',layoutBrief:'Use my actual records'});};w.open();});return page;}
test('submitted generation brings the offscreen result into view without stealing focus or discarding a newer draft',async t=>{
 const page=await setup(t);
 await page.evaluate(()=>{const w:any=window;const spacer=document.createElement('div');spacer.style.height='1600px';document.querySelector('#view')!.after(spacer);w.responseTree={type:'Text',text:'Visible result'};(document.querySelector('#request') as HTMLTextAreaElement).value='Show result';});
 await page.$eval('#request',e=>e.dispatchEvent(new Event('input',{bubbles:true})));
 await page.click('#generate');await page.waitForFunction(()=>(window as any).ws.state.origin==='generated');
 await page.waitForFunction(()=>document.querySelector('#view')!.getBoundingClientRect().top>=0);
 assert.ok(await page.$eval('#view',e=>e.getBoundingClientRect().top<100));
 await page.evaluate(()=>{const w:any=window;w.ai= w.sdk.ai;w.sdk.ai=(...args:any[])=>new Promise(resolve=>w.release=()=>w.ai(...args).then(resolve));});
 await page.click('#generate');await page.waitForFunction(()=>typeof (window as any).release==='function');
 await page.focus('#request');await page.$eval('#request',e=>(e as HTMLTextAreaElement).value='New draft while waiting');
 await page.evaluate(()=>(window as any).release());await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.$eval('#request',e=>(e as HTMLTextAreaElement).value),'New draft while waiting');
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'request');
 assert.ok(await page.$eval('#view',e=>e.getBoundingClientRect().top<0),'do not move away from a new draft');
});
test('workspace serializes source writes and publishes only after ACK, preserving actual records and photos',async t=>{const page=await setup(t);await page.evaluate(()=>{const w:any=window;w.hold=true;w.p1=w.ws.setRecords([{id:'a',text:'Actual source A',value:4}]);w.p2=w.ws.setRecords((items:any[])=>[...items,{id:'b',text:'Actual source B',value:9}]);});await page.waitForFunction(()=>(window as any).pending.length===1);assert.deepEqual(await page.evaluate(()=>(window as any).ws.getRecords()),[]);assert.equal(await page.$eval('#view',e=>e.textContent),'Add content or describe the view you want.');assert.equal(await page.evaluate(()=>(window as any).writes.length),1);await page.evaluate(()=>(window as any).pending.shift()());await page.waitForFunction(()=>(window as any).pending.length===1);assert.equal(await page.evaluate(()=>(window as any).ws.getRecords().length),1);await page.evaluate(()=>(window as any).pending.shift()());await page.evaluate(()=>Promise.all([(window as any).p1,(window as any).p2]));assert.equal(await page.evaluate(()=>(window as any).ws.getRecords().length),2);assert.match(await page.$eval('#view',e=>e.textContent||''),/Actual source A/);assert.match(await page.$eval('#view',e=>e.textContent||''),/Actual source B/);assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'source');assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),0);
await page.evaluate(async()=>{const w:any=window;w.hold=false;await w.ws.setPhotos([{id:'p',src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nu0AAAAASUVORK5CYII='}]);w.oldHtml=document.querySelector('#view').innerHTML;w.oldSaved=w.saved['test-workspace:source:v1'];w.rejectSave=true;w.failure=await w.ws.setRecords([{id:'c',text:'Uncommitted edit'}]).then(()=>null,(e:any)=>e.message);});assert.match(await page.evaluate(()=>(window as any).failure),/Disk rejected/);assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).oldHtml),true);assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:source:v1']===(window as any).oldSaved),true);assert.equal(await page.$$eval('#view img',e=>e.length),1);assert.match(await page.$eval('#status',e=>e.textContent||''),/Disk rejected/);});
test('explicit generation receives committed preferences and sources, restores without model, retains failures and drafts',async t=>{const page=await setup(t);await page.evaluate(async()=>{const w:any=window;await w.ws.setRecords([{id:'a',text:'Real row',value:4}]);await w.ws.setPreferences({preferredView:'plot',detail:'full'});w.responseTree={type:'Stack',children:[{type:'Plot',plot:{kind:'bar',series:[{name:'Measured',color:'#6366f1',points:[[0,4]]}]}},{type:'Text',recordId:'a'}]};document.querySelector('#request').value='Compare these values';await w.ws.generate();});assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),1);assert.deepEqual(await page.evaluate(()=>(window as any).aiCalls[0].ctx.presentationContext.appContext),{preferredView:'plot',detail:'full'});assert.equal(await page.evaluate(()=>(window as any).aiCalls[0].ctx.records[0].value),4);assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'generated');
await page.select('[data-rich-details="plot"] select','0:0');await page.waitForFunction(()=>Object.keys((window as any).ws.state.richState).length===1);await page.evaluate(()=>(window as any).open());assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),1,'restore never calls model');assert.equal(await page.$eval('[data-rich-details="plot"] select',e=>(e as HTMLSelectElement).value),'0:0');assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{preferredView:'plot',detail:'full'});assert.equal(await page.evaluate(()=>Object.isFrozen((window as any).ws.state.preferences)),true);
await page.evaluate(async()=>{const w:any=window;w.oldHtml=document.querySelector('#view').innerHTML;w.oldLayout=w.saved['test-workspace:layout:v1'];w.aiFailure=true;document.querySelector('#request').value='Keep my retry draft';w.failure=await w.ws.generate().then(()=>null,(e:any)=>e.message);});assert.match(await page.evaluate(()=>(window as any).failure),/Model unavailable/);assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).oldHtml),true);assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:layout:v1']===(window as any).oldLayout),true);assert.equal(await page.$eval('#request',e=>(e as HTMLInputElement).value),'Keep my retry draft');assert.equal(await page.$eval('#generate',e=>(e as HTMLButtonElement).disabled),false);
// Same record id with new content must not resurrect stale generated plot values.
await page.evaluate(async()=>{const w:any=window;await w.ws.setRecords([{id:'a',text:'Changed row',value:44}]);w.open();});assert.equal(await page.$$eval('#view svg',e=>e.length),0);assert.match(await page.$eval('#view',e=>e.textContent||''),/44/);assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'source');
// Invalid or oversized edits reject without losing previously committed data.
const rejects=await page.evaluate(async()=>{const w:any=window;return Promise.all([[{id:'x',value:Infinity}],[{id:'duplicate'},{id:'duplicate'}]].map(value=>w.ws.setRecords(value).then(()=>false,()=>true)));});assert.deepEqual(rejects,[true,true]);});

test('checklist toggles preserve generated composition, await ACK, rollback on failure and restore without AI',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{
  const w:any=window;
  await w.ws.setRecords([{id:'a',text:'First actual task',checked:false},{id:'b',text:'Second actual task',completed:true}]);
  w.responseTree={type:'Stack',children:[
   {type:'Diagram',diagram:{title:'Task dependency',nodes:[{id:'first',label:'First',x:.2,y:.5,color:'#6366f1'},{id:'second',label:'Second',x:.8,y:.5,color:'#10b981'}],edges:[{from:'first',to:'second',label:'then'}]}},
   {type:'Checklist',children:[{type:'Checklist',recordId:'a',children:[]},{type:'Checklist',recordId:'b',children:[]}]}
  ]};
  await w.ws.generate('Show these tasks and their dependency');
  w.generatedTree=w.ws.getTree();w.savedLayout=w.saved['test-workspace:layout:v1'];w.hold=true;
 });
 assert.deepEqual(await page.$$eval('#view input[type=checkbox]',els=>els.map(e=>(e as HTMLInputElement).checked)),[false,true]);
 await page.click('[data-record-id="a"] input');
 await page.waitForFunction(()=>(window as any).pending.length===1);
 assert.equal(await page.evaluate(()=>(window as any).ws.getRecords()[0].checked),false,'source remains committed value until ACK');
 assert.equal(await page.$eval('[data-record-id="a"] input',e=>(e as HTMLInputElement).disabled),true);
 assert.equal(await page.$$eval('#view input[type=checkbox]',els=>els.length),2,'waiting for ACK must not remove task controls');
 await page.evaluate(()=>(window as any).pending.shift()());
 await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.evaluate(()=>(window as any).ws.getRecords()[0].checked),true);
 assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'generated');
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getTree()),await page.evaluate(()=>(window as any).generatedTree));
 assert.equal(await page.$$eval('#view svg',els=>els.length),1,'rich composition survives ordinary checkbox state changes');
 await page.evaluate(()=>{const w:any=window;w.hold=false;w.open();});
 assert.deepEqual(await page.$$eval('#view input[type=checkbox]',els=>els.map(e=>(e as HTMLInputElement).checked)),[true,true]);
 assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'generated','checked-only changes do not invalidate saved layout');
 assert.equal(await page.$$eval('#view svg',els=>els.length),1);
 await page.click('[data-record-id="a"] input');
 await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.$eval('[data-record-id="a"] input',e=>(e as HTMLInputElement).checked),false,'a second click can uncheck the task');
 await page.click('[data-record-id="b"] input');
 await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.$eval('[data-record-id="b"] input',e=>(e as HTMLInputElement).checked),false,'completed-only source may be unchecked via explicit checked override');
 await page.evaluate(()=>(window as any).open());
 assert.deepEqual(await page.$$eval('#view input[type=checkbox]',els=>els.map(e=>(e as HTMLInputElement).checked)),[false,false]);
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),1,'toggle, uncheck and both restores never call the model');
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:layout:v1']===(window as any).savedLayout),true,'local checkbox updates do not rewrite a generated tree');
 await page.evaluate(()=>(window as any).rejectSave=true);
 await page.click('[data-record-id="a"] input');
 await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.$eval('[data-record-id="a"] input',e=>(e as HTMLInputElement).checked),false,'failed source write rolls back the native input');
 assert.equal(await page.$eval('[data-record-id="a"] input',e=>(e as HTMLInputElement).disabled),false);
 assert.equal(await page.evaluate(()=>(window as any).ws.getRecords()[0].checked),false);
 assert.equal(await page.$$eval('#view input[type=checkbox]',els=>els.length),2);
 assert.equal(await page.$$eval('#view svg',els=>els.length),1);
 assert.match(await page.$eval('#status',e=>e.textContent||''),/Disk rejected/);
});

test('source fallback supports 80 records together with photos and restores every actual item',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{
  const w:any=window;
  w.image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nu0AAAAASUVORK5CYII=';
  await w.ws.setRecords(Array.from({length:80},(_,i)=>({id:'record-'+i,text:'Actual record '+i,value:i})));
  await w.ws.setPhotos([{id:'photo-0',src:w.image}]);
 });
 assert.equal(await page.$$eval('#view [data-record-id]',els=>els.length),80);
 assert.equal(await page.$$eval('#view img',els=>els.length),1);
 assert.equal(await page.evaluate(()=>(window as any).ws.getRecords().length),80);
 assert.equal(await page.evaluate(()=>(window as any).ws.getPhotos().length),1);
 assert.match(await page.$eval('#view',e=>e.textContent||''),/Actual record 79/);
 await page.evaluate(()=>(window as any).open());
 assert.equal(await page.$$eval('#view [data-record-id]',els=>els.length),80);
 assert.equal(await page.$$eval('#view img',els=>els.length),1);
 assert.equal(await page.$eval('#view img',e=>e.getAttribute('src')),await page.evaluate(()=>(window as any).image));
 // Both independently supported collections can reach their documented maximum.
 await page.evaluate(async()=>{const w:any=window;await w.ws.setPhotos(Array.from({length:80},(_,i)=>({id:'photo-'+i,src:w.image})));w.open();});
 assert.equal(await page.$$eval('#view [data-record-id]',els=>els.length),80);
 assert.equal(await page.$$eval('#view img',els=>els.length),80);
 assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'source');
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),0,'source edits and source restore remain deterministic local operations');
});

test('unchanged source updates on reopen retain the acknowledged generated tree',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{const w:any=window;await w.ws.setRecords([{id:'a',text:'Actual row',value:4}]);w.responseTree={type:'Stack',children:[{type:'Diagram',diagram:{nodes:[{id:'a',label:'Actual row',x:.5,y:.5,color:'#6366f1'}],edges:[]}},{type:'List',recordId:'a',children:[]}]};await w.ws.generate('Show relationships');w.open();w.beforeWrites=w.writes.length;await w.ws.setRecords((rows:any[])=>rows);await w.ws.setPhotos((photos:any[])=>photos);});
 assert.equal(await page.$$eval('#view svg',els=>els.length),1);
 assert.equal(await page.evaluate(()=>(window as any).ws.state.origin),'generated');
 assert.equal(await page.evaluate(()=>(window as any).writes.length===(window as any).beforeWrites),true,'same-source initialization must not write or replace the restored composition');
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),1);
});

test('snapshot save and restore await ACK and reopen exact tree, preferences, draft and point selection without AI',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{
  const w:any=window;
  await w.ws.setRecords([{id:'a',text:'Actual source',value:4}]);
  w.image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nu0AAAAASUVORK5CYII=';
  await w.ws.setPhotos([{id:'p',src:w.image}]);await w.ws.setPreferences({focus:'A'});
  w.responseTree={type:'Stack',children:[{type:'Plot',plot:{kind:'line',title:'Saved view A',series:[{name:'Actual',color:'#6366f1',points:[[0,4],[1,4]]}]}},{type:'List',recordId:'a',children:[]},{type:'Image',photoId:'p'}]};
  (document.querySelector('#request') as HTMLInputElement).value='Keep view A';await w.ws.generate();w.treeA=w.ws.getTree();
 });
 await page.select('[data-rich-details="plot"] select','0:1');await page.waitForFunction(()=>!(window as any).ws.state.busy);
 await page.evaluate(()=>{const w:any=window;w.hold=true;w.savingSnapshot=w.ws.saveSnapshot('Building A');});
 await page.waitForFunction(()=>(window as any).pending.length===1);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),0,'unacknowledged history is not published');
 await page.evaluate(()=>(window as any).pending.shift()());
 await page.evaluate(async()=>{const w:any=window;w.snapshotA=await w.savingSnapshot;w.hold=false;});
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots()[0].label),'Building A');
 assert.equal(await page.evaluate(()=>Object.isFrozen((window as any).ws.listSnapshots()[0])),true);
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:history:v1'].includes('data:image')),false,'history must not copy image bytes');
 await page.evaluate(async()=>{const w:any=window;await w.ws.setPreferences({focus:'B'});w.responseTree={type:'Stack',children:[{type:'Diagram',diagram:{title:'Current view B',nodes:[{id:'b',label:'Current B',x:.5,y:.5,color:'#10b981'}],edges:[]}},{type:'List',recordId:'a',children:[]},{type:'Image',photoId:'p'}]};(document.querySelector('#request') as HTMLInputElement).value='Keep view B';await w.ws.generate();w.treeB=w.ws.getTree();w.layoutB=w.saved['test-workspace:layout:v1'];w.rejectSave=true;w.failedRestore=await w.ws.restoreSnapshot(w.snapshotA.id).then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).failedRestore),/Disk rejected/);
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getTree()),await page.evaluate(()=>(window as any).treeB));
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'B'});
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:layout:v1']===(window as any).layoutB),true);
 await page.evaluate(()=>{const w:any=window;w.rejectSave=false;const input=document.querySelector('#request') as HTMLInputElement;input.value='Older draft before restoring A';input.dispatchEvent(new Event('input'));w.hold=true;w.restoring=w.ws.restoreSnapshot(w.snapshotA.id);});
 await page.waitForFunction(()=>(window as any).pending.length===1);
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getTree()),await page.evaluate(()=>(window as any).treeB),'restore waits for its layout ACK');
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'B'});
 await new Promise(resolve=>setTimeout(resolve,250)); // Let the older input's autosave queue behind the pending restore.
 await page.evaluate(()=>(window as any).pending.shift()());await page.evaluate(()=>(window as any).restoring);
 await page.waitForFunction(()=>!(window as any).ws.state.busy);
 assert.equal(await page.evaluate(()=>(window as any).pending.length),0,'an earlier draft autosave cannot overwrite restored snapshot state');
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getTree()),await page.evaluate(()=>(window as any).treeA));
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'A'});
 assert.equal(await page.$eval('[data-rich-details="plot"] select',e=>(e as HTMLSelectElement).value),'0:1');
 assert.equal(await page.$eval('#request',e=>(e as HTMLInputElement).value),'Keep view A');
 await page.evaluate(()=>{const w:any=window;w.hold=false;(document.querySelector('#request') as HTMLInputElement).value='';w.open();});
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),1);
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'A'});
 assert.equal(await page.$eval('[data-rich-details="plot"] select',e=>(e as HTMLSelectElement).value),'0:1');
 assert.equal(await page.$eval('#request',e=>(e as HTMLInputElement).value),'Keep view A');
 await page.evaluate(async()=>{const w:any=window;await w.ws.setPreferences({focus:'Newer user preference'});await w.ws.deleteSnapshot(w.snapshotA.id);w.open();});
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'Newer user preference'},'a later acknowledged preference supersedes the restored snapshot override');
 assert.deepEqual(await page.evaluate(()=>(window as any).ws.getTree()),await page.evaluate(()=>(window as any).treeA),'deleting history does not erase the active restored view');
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),0);
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),2,'history operations and reopens never call the model');
});

test('snapshot history rejects failed saves, changed source and capacity overflow without evicting history',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{const w:any=window;w.rejectSave=true;w.failedSave=await w.ws.saveSnapshot('Not committed').then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).failedSave),/Disk rejected/);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),0);
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:history:v1']),undefined);
 await page.evaluate(async()=>{const w:any=window;w.rejectSave=false;w.original=await w.ws.saveSnapshot('Empty source');await w.ws.setRecords([{id:'real',text:'New actual data'}]);w.beforeMismatch=w.writes.length;w.beforeHtml=document.querySelector('#view').innerHTML;w.mismatch=await w.ws.restoreSnapshot(w.original.id).then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).mismatch),/Source data changed/);
 assert.equal(await page.evaluate(()=>(window as any).writes.length===(window as any).beforeMismatch),true,'mismatch is rejected before writes');
 assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).beforeHtml),true);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots()[0].matchesSource),false);
 await page.evaluate(async()=>{const w:any=window;for(let i=0;i<5;i++)await w.ws.saveSnapshot('Saved '+i);w.historyBefore=w.saved['test-workspace:history:v1'];w.overflow=await w.ws.saveSnapshot('Seventh').then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).overflow),/at most 6/);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),6);
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:history:v1']===(window as any).historyBefore),true,'capacity error never silently evicts old snapshots');
 await page.evaluate(async()=>{const w:any=window;w.rejectSave=true;w.failedDelete=await w.ws.deleteSnapshot(w.original.id).then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).failedDelete),/Disk rejected/);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),6);
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),0);
});

test('snapshot byte budget and restored-tree validation reject before changing saved history or current view',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{const w:any=window;await w.ws.setRecords([{id:'large',text:'x'.repeat(86000)}]);for(let i=0;i<5;i++)await w.ws.saveSnapshot('Large '+i);w.historyBefore=w.saved['test-workspace:history:v1'];w.tooLarge=await w.ws.saveSnapshot('Exceeds byte budget').then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).tooLarge),/too large/);
 assert.equal(await page.evaluate(()=>(window as any).ws.listSnapshots().length),5,'byte budget is independent of the six-snapshot count limit');
 assert.equal(await page.evaluate(()=>(window as any).saved['test-workspace:history:v1']===(window as any).historyBefore),true);
 assert.equal(await page.evaluate(()=>new TextEncoder().encode((window as any).saved['test-workspace:history:v1']).length<=500000),true);
 await page.evaluate(()=>{const w:any=window;const history=JSON.parse(w.saved['test-workspace:history:v1']);history.snapshots[0].tree={type:'Text',text:'This omits the actual source'};w.saved['test-workspace:history:v1']=JSON.stringify(history);w.open();w.beforeRestoreWrites=w.writes.length;w.beforeRestoreHtml=document.querySelector('#view').innerHTML;});
 await page.evaluate(async()=>{const w:any=window;w.invalidRestore=await w.ws.restoreSnapshot(w.ws.listSnapshots()[0].id).then(()=>null,(e:any)=>e.message);});
 assert.match(await page.evaluate(()=>(window as any).invalidRestore),/omitted source content/);
 assert.equal(await page.evaluate(()=>(window as any).writes.length===(window as any).beforeRestoreWrites),true);
 assert.equal(await page.evaluate(()=>document.querySelector('#view')!.innerHTML===(window as any).beforeRestoreHtml),true);
 assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),0);
});

test('workspace owns generation button readiness even when app markup starts disabled',async t=>{const page=await setup(t);await page.evaluate(()=>{const w:any=window;w.ws.dispose();document.querySelector<HTMLButtonElement>('#generate')!.disabled=true;w.open();w.responseTree={type:'Text',text:'Real generated view'};});assert.equal(await page.$eval('#generate',e=>(e as HTMLButtonElement).disabled),false);await page.click('#generate');await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('Enter a layout request'));assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),0);await page.type('#request','Make my view');await page.click('#generate');await page.waitForFunction(()=>document.querySelector('#view')?.textContent==='Real generated view');assert.equal(await page.evaluate(()=>(window as any).aiCalls.length),1);assert.equal(await page.$eval('#generate',e=>(e as HTMLButtonElement).disabled),false);});

test('a preference write queued before a generation error cannot overwrite the actual error',async t=>{const page=await setup(t);await page.evaluate(async()=>{const w:any=window;w.aiFailure=true;w.generationFailure=w.ws.generate('Change this view').catch((e:any)=>e.message);w.preferenceWrite=w.ws.setPreferences({focus:'cost'});await Promise.all([w.generationFailure,w.preferenceWrite]);});assert.match(await page.$eval('#status',e=>e.textContent||''),/Model unavailable/);assert.match(await page.evaluate(()=>(window as any).ws.state.error),/Model unavailable/);assert.deepEqual(await page.evaluate(()=>(window as any).ws.getPreferences()),{focus:'cost'});await page.evaluate(async()=>{const w:any=window;await w.ws.setPreferences({focus:'score'});});assert.equal(await page.evaluate(()=>(window as any).ws.state.error),null);assert.equal(await page.$eval('#status',e=>e.textContent),'Saved');});
