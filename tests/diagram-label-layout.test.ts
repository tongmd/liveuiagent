import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
test('dense diagram labels remain separate and selectable across phone and desktop sizes',async t=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,pipe:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();
 const labels=['Generate capability','Different applications','Spatial expression','Natural interaction','Personal memory','Acceptance'];
 const diagram={type:'Diagram',diagram:{nodes:labels.map((label,i)=>({id:'n'+i,label,x:.5,y:.35+i*.055,color:'#6366f1'})),edges:labels.slice(1).map((_,i)=>({from:'n'+i,to:'n'+(i+1)}))}};
 for(const width of[390,320,1280,390]){
  await page.setViewport({width,height:844});await page.setContent('<style>body{margin:14px}main{max-width:700px;margin:auto}</style><main></main>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url),'utf8')});
  await page.evaluate(tree=>{const w:any=window;w.changes=[];w.runtime=w.__liveuiStructuredRuntime({});w.runtime.render(document.querySelector('main'),tree,{onRichStateChange:(key:string,value:any)=>w.changes.push({key,value})});},diagram);
  await new Promise(r=>setTimeout(r,250));
  const bounds=await page.$$eval('g[role=button] text',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));assert.equal(bounds.length,6);
  for(let i=0;i<bounds.length;i++){const a=bounds[i];assert(a.left>=0&&a.right<=width,'label contained');for(let j=0;j<i;j++){const b=bounds[j];assert(!(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom),'labels do not overlap');}}
  await page.click('g[role=button][aria-label="Personal memory"] tspan');await page.waitForFunction(()=>((window as any).changes.at(-1)?.value.nodeId)==='n4');assert.equal(await page.evaluate(()=>(window as any).changes.at(-1)?.value.nodeId),'n4');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
});
test('mobile scene height follows available viewport and keeps explicit mobile sizing and camera state',async t=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,pipe:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setViewport({width:1280,height:844});await page.setContent('<style>body{margin:14px}</style><main></main>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url),'utf8')});
 await page.evaluate(()=>{const w:any=window;w.state={};w.tree={type:'Scene3D',style:{height:520},scene:{objects:[{id:'box',shape:'box',position:[0,0,0],scale:[1,2,1],color:'#6366f1'}]}};w.runtime=w.__liveuiStructuredRuntime({});w.render=()=>w.runtime.render(document.querySelector('main'),w.tree,{richState:w.state,onRichStateChange:(key:string,value:any)=>w.state[key]=value});w.render();});
 const height=()=>page.$eval('canvas',e=>e.getBoundingClientRect().height);
 assert.equal(await height(),520);
 for(const width of[390,320]){await page.setViewport({width,height:844});await page.waitForFunction(()=>document.querySelector('canvas')!.getBoundingClientRect().height<=360);assert.equal(await height(),360);}
 await page.setViewport({width:390,height:400});await page.waitForFunction(()=>document.querySelector('canvas')!.getBoundingClientRect().height<=200);assert.equal(await height(),200);
 await page.setViewport({width:390,height:844});await page.waitForFunction(()=>document.querySelector('canvas')!.getBoundingClientRect().height>200);
 const canvas=await page.$('canvas');const before=await canvas!.evaluate(e=>(e as HTMLCanvasElement).toDataURL());const box=await canvas!.boundingBox();assert(box);await page.mouse.move(box.x+100,box.y+100);await page.mouse.down();await page.mouse.move(box.x+160,box.y+130,{steps:8});await page.mouse.up();assert.notEqual(await canvas!.evaluate(e=>(e as HTMLCanvasElement).toDataURL()),before);await canvas!.focus();await page.keyboard.press('+');const state=await page.evaluate(()=>(window as any).state);assert(Object.keys(state).length>0);await page.evaluate(()=>(window as any).render());assert.deepEqual(await page.evaluate(()=>(window as any).state),state);
 await page.evaluate(()=>{const w:any=window;w.tree.style.mobile={height:280};w.render();});assert.equal(await height(),280);await page.setViewport({width:1280,height:844});await page.waitForFunction(()=>document.querySelector('canvas')!.getBoundingClientRect().height===520);
});
