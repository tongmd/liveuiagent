import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
function controlledRuntime() { return 'window.__name=(fn)=>fn;' + fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js', import.meta.url), 'utf8'); }
const plot = (kind='line') => ({type:'Plot',plot:{kind,title:'实际数据',xLabel:'时间',yLabel:'数量',series:[{name:'甲组',color:'#6366f1',points:[[0,0],[1,3]]},{name:'乙组',color:'#10b981',points:[[0,2],[1,-1]]}]}});
const diagram = {type:'Diagram',diagram:{title:'关系',nodes:[{id:'a',label:'问题',x:.1,y:.2,color:'#6366f1'},{id:'b',label:'验证',x:.5,y:.5,color:'#10b981'},{id:'c',label:'结果',x:.9,y:.8,color:'#f59e0b'},{id:'d',label:'独立项',x:.8,y:.1,color:'#6366f1'}],edges:[{from:'a',to:'b',label:'提出'},{from:'b',to:'c',label:'得到'}]}};

test('native Plot and Diagram selections expose real details, persist, restore and stay local', async t => {
  const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
  t.after(()=>browser.close()); const page = await browser.newPage();
  await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
  await page.setContent('<html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:12px;font-family:system-ui}main{max-width:780px}</style><main id="view"></main></html>');
  await page.addScriptTag({content:controlledRuntime()});
  await page.evaluate(tree=>{const w:any=window;w.saved={};w.writes=[];w.modelCalls=0;w.runtime=w.__liveuiStructuredRuntime({ai:()=>{w.modelCalls++;throw Error('No model call allowed');}});w.tree=tree;w.render=()=>w.runtime.render(document.querySelector('#view'),w.tree,{locale:'zh',richState:w.saved,onRichStateChange:(key:string,view:any)=>{w.saved[key]=view;w.writes.push({key,view});}});w.render();},{type:'Stack',children:[plot(),diagram]});
  assert.equal(await page.$$eval('[data-rich-details]',e=>e.length),2);
  // Mobile users can choose even densely overlapping marks using a native control.
  await page.select('[data-rich-details="plot"] select','1:1');
  assert.equal(await page.$eval('[data-rich-details="plot"] [role=status]',e=>e.textContent),'乙组 · 时间 = 1 · 数量 = -1');
  assert.equal(await page.$$eval('svg g[aria-pressed=true]',e=>e.length),1);
  assert.equal(await page.$eval('[data-rich-details="plot"] select',e=>e.getBoundingClientRect().height>=44),true);
  // Touch selects the actual native SVG node and reveals both edge directions.
  await page.tap('svg g[aria-label="验证"]');
  assert.deepEqual(await page.$$eval('[data-rich-details="diagram"] li',els=>els.map(e=>e.textContent)),['问题 → 验证 · 提出','验证 → 结果 · 得到']);
  assert.equal(await page.$eval('svg g[aria-label="独立项"]',e=>Number((e as HTMLElement).style.opacity)),.35);
  const before = await page.evaluate(()=>({writes:(window as any).writes.length,selections:[...document.querySelectorAll('section[data-selection]')].map((e:any)=>e.dataset.selection)}));
  assert.equal(before.writes,2,'one save per selection');
  await page.evaluate(()=>(window as any).render());
  assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('section[data-selection]')].map((e:any)=>e.dataset.selection)),before.selections);
  assert.equal(await page.evaluate(()=>(window as any).writes.length),before.writes,'restore does not write');
  assert.equal(await page.evaluate(()=>(window as any).modelCalls),0);
  assert.equal(await page.evaluate(()=>innerWidth),390,'test uses actual mobile CSS width');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no mobile horizontal overflow');
  await page.$eval('svg g[aria-label="甲组 · 时间 = 1 · 数量 = 3"]',e=>(e as unknown as HTMLElement).focus());await page.keyboard.press('Enter');
  assert.equal(await page.$eval('[data-rich-details="plot"] [role=status]',e=>e.textContent),'甲组 · 时间 = 1 · 数量 = 3');
  await page.$eval('svg g[aria-label="独立项"]',e=>(e as unknown as HTMLElement).focus());await page.keyboard.press('Space');
  assert.deepEqual(await page.$$eval('[data-rich-details="diagram"] li',els=>els.map(e=>e.textContent)),['没有直接连接。']);
  assert.equal(await page.evaluate(()=>(window as any).writes.length),4,'Diagram native keyboard handler must not double-save');
  
  // Changing actual data cannot restore a selection by a stale point index.
  await page.evaluate(()=>{const w:any=window;w.tree.children[0].plot.series[0].points[1][1]=44;w.render();});
  assert.match(await page.$eval('[data-rich-details="plot"] [role=status]',e=>e.textContent||''),/点选/);
});

test('bar/scatter hit targets, text safety and disposed views do not invent relationships or save', async t=>{
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent('<main id="view"></main>');await page.addScriptTag({content:controlledRuntime()});
  await page.evaluate(tree=>{const w:any=window;w.calls=[];w.runtime=w.__liveuiStructuredRuntime({});w.runtime.render(document.querySelector('#view'),tree,{onRichStateChange:(key:string,view:any)=>w.calls.push({key,view})});},{type:'Stack',children:[plot('bar'),plot('scatter'),{type:'Diagram',diagram:{nodes:[{id:'only',label:'<img src=x onerror=alert(1)>',x:.5,y:.5,color:'#6366f1'}],edges:[]}}]});
  assert.equal(await page.$$eval('svg g[role=button]',els=>els.length),9);
  await page.click('svg g[aria-label="甲组 · 时间 = 0 · 数量 = 0"]');
  assert.match(await page.$eval('[data-rich-details="plot"] [role=status]',e=>e.textContent||''),/数量 = 0/);
  assert.equal(await page.$$eval('img',els=>els.length),0,'labels only enter textContent');
  await page.evaluate(()=>{const w:any=window;w.old=document.querySelector('svg g[role=button]');w.runtime.render(document.querySelector('#view'),{type:'Text',text:'Other view'});w.old.dispatchEvent(new MouseEvent('click'));});
  assert.equal(await page.evaluate(()=>(window as any).calls.length),1,'disposed listeners cannot save');
});

test('phone Plot legends wrap every series and scatter axes expose close measured values',async t=>{const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setViewport({width:390,height:844});await page.setContent('<main id="view"></main>');await page.addScriptTag({content:controlledRuntime()});await page.evaluate(()=>{const w:any=window;w.ui=w.__liveuiStructuredRuntime({storage:{getItem:()=>null},save:async()=>({ok:true})});w.ui.render(document.querySelector('#view'),{type:'Plot',plot:{kind:'scatter',series:Array.from({length:6},(_,i)=>({name:'Measured method with a long name '+i,color:'#167566',points:[[i+1,82+i]]}))}},{records:[],photos:[]});});const actual=await page.evaluate(()=>{const items=[...document.querySelectorAll('[data-plot-legend] span')];return{labels:items.map(e=>e.textContent),bounds:items.map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right}}),ys:[...document.querySelectorAll('svg circle')].map(e=>Number(e.getAttribute('cy'))),height:document.querySelector('[data-plot-legend]')!.getBoundingClientRect().height};});assert.equal(actual.labels.length,6);assert(actual.bounds.every(r=>r.left>=0&&r.right<=390));assert(actual.height>40);assert(Math.max(...actual.ys)-Math.min(...actual.ys)>200);});

test('phone diagrams keep relationship labels readable in selection details instead of overlapping nodes',async t=>{const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setViewport({width:390,height:844});await page.setContent('<html lang="zh"><main id="view"></main></html>');await page.addScriptTag({content:controlledRuntime()});await page.evaluate(tree=>{const w:any=window;w.ui=w.__liveuiStructuredRuntime({storage:{getItem:()=>null},save:async()=>({ok:true})});w.ui.render(document.querySelector('#view'),tree,{records:[],photos:[]});},diagram);await page.waitForFunction(()=>document.querySelector('[data-edge-label]')?.getAttribute('style')?.includes('none'));await page.select('[data-rich-details="diagram"] select','b');const details=await page.$eval('[data-rich-details="diagram"]',e=>e.textContent||'');assert.match(details,/提出/);assert.match(details,/得到/);await page.setViewport({width:900,height:844});await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-edge-label]')!).display!=='none');});

test('vertical process nodes place labels beside nodes at phone width',async t=>{const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setViewport({width:390,height:844});await page.setContent('<main id="view"></main>');await page.addScriptTag({content:controlledRuntime()});await page.evaluate(()=>{const w:any=window;w.ui=w.__liveuiStructuredRuntime({storage:{getItem:()=>null},save:async()=>({ok:true})});w.ui.render(document.querySelector('#view'),{type:'Diagram',diagram:{nodes:Array.from({length:6},(_,i)=>({id:'n'+i,label:'步骤'+i,x:.5,y:.08+i*.17,color:'#167566'})),edges:[]}},{records:[],photos:[]});});const positions=await page.$$eval('svg g[role=button]',groups=>groups.map(g=>{const c=g.querySelector('circle')!,t=g.querySelector('text')!;return{cx:Number(c.getAttribute('cx')),x:Number(t.getAttribute('x')),cy:Number(c.getAttribute('cy')),y:Number(t.getAttribute('y')),anchor:t.getAttribute('text-anchor')};}));assert.equal(positions.length,6);assert(positions.every(p=>p.x>p.cx+25&&Math.abs(p.y-p.cy)<8&&p.anchor==='start'));});
