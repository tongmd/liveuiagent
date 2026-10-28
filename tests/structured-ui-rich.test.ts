import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import {validateStructuredUiTree,generateStructuredUi} from '../server/structured-ui.js';
const context={uiProtocol:'liveui-tree-v1',records:[],photos:[]};
const scene:any={type:'Scene3D',scene:{title:'空间结构示意',objects:[{id:'a',shape:'sphere',position:[-1,0,0],scale:[1,1,1],color:'#8b5cf6',label:'假设'},{id:'b',shape:'torus',position:[1,0,0],scale:[1,1,1],color:'#10b981',label:'验证'},{id:'c',shape:'box',position:[0,1,0],scale:[.7,.7,.7],color:'#f59e0b'}]}};
const plot={type:'Plot',plot:{kind:'line',title:'数学示意 y=x²',series:[{name:'示例',color:'#6366f1',points:[[0,0],[1,1],[2,4],[3,9]]}],xLabel:'x',yLabel:'y'}};
const diagram={type:'Diagram',diagram:{nodes:[{id:'a',label:'问题',x:.2,y:.5,color:'#6366f1'},{id:'b',label:'检验',x:.8,y:.5,color:'#10b981'}],edges:[{from:'a',to:'b',label:'推导'}]}};
const tree:any={type:'Stack',children:[scene,plot,diagram]};
test('bounded rich component schema accepts geometry/data and rejects executable or nonfinite payloads',()=>{
 assert.deepEqual(validateStructuredUiTree(tree,context),tree);
 for(const bad of [{...scene,scene:{...scene.scene,url:'javascript:alert(1)'}},{...scene,scene:{objects:[{...scene.scene.objects[0],scale:[1,0,1]}]}},{...scene,scene:{objects:Array(49).fill(scene.scene.objects[0])}},{...plot,plot:{...plot.plot,series:[{name:'x',color:'#000000',points:[[0,Infinity]]}]}},{...diagram,diagram:{...diagram.diagram,edges:[{from:'a',to:'absent'}]}}])assert.throws(()=>validateStructuredUiTree(bad,context));
 assert.throws(()=>validateStructuredUiTree(tree,{...context,records:[{id:'r1',text:'preserve me'}]}),/omitted/);
});
test('configured one-call generation receives rich protocol and returns validated rich tree',async()=>{
 let calls=0;const result=await generateStructuredUi('用可旋转三维结构解释我的假设',context,{model:'test',chatCompletion:async(request:any)=>{calls++;assert.match(request.messages[0].content,/Scene3D/);assert.match(request.messages[0].content,/Do not invent measured/);return{choices:[{message:{content:JSON.stringify({text:'空间结构',data:{tree}})}}]};}} as any);assert.equal(calls,1);assert.deepEqual(result.data.tree,tree);
});
test('server-validated rich tree uses real WebGL, responds to orbit/zoom/spread, restores and disposes',async t=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--force-device-scale-factor=2']});t.after(()=>browser.close());const page=await browser.newPage();await page.setViewport({width:1024,height:900,deviceScaleFactor:2});
 await page.setContent('<style>body{font-family:system-ui;margin:20px}main{max-width:900px;margin:auto}</style><main id="view"></main>');await page.addScriptTag({content:'window.__name=(fn)=>fn;'+fs.readFileSync(new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url),'utf8')});
 await page.evaluate(tree=>{const w:any=window;w.state={};w.runtime=w.__liveuiStructuredRuntime({});w.tree=tree;w.render=()=>w.runtime.render(document.querySelector('#view'),w.tree,{richState:w.state,onRichStateChange:(key:string,view:any)=>{w.state[key]=view;}});w.render();},validateStructuredUiTree(tree,context));
 assert.equal(await page.$eval('section[data-renderer]',e=>(e as HTMLElement).dataset.renderer),'webgl');
 const before=await page.$eval('canvas',e=>(e as HTMLCanvasElement).toDataURL());assert.ok(before.length>6000,'WebGL scene must have nonempty rendered pixels');
 const box=await page.$eval('canvas',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});await page.mouse.move(box.x+120,box.y+120);await page.mouse.down();await page.mouse.move(box.x+220,box.y+160,{steps:8});await page.mouse.up();assert.notEqual(await page.$eval('canvas',e=>(e as HTMLCanvasElement).toDataURL()),before);
 const afterDrag=await page.$eval('canvas',e=>(e as HTMLCanvasElement).toDataURL());await page.mouse.wheel({deltaY:-200});assert.notEqual(await page.$eval('canvas',e=>(e as HTMLCanvasElement).toDataURL()),afterDrag);
 await page.$eval('input[type=range]',e=>{(e as HTMLInputElement).value='2';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.$eval('section[data-renderer]',e=>JSON.parse((e as HTMLElement).dataset.view!).spread),2);
 const view=await page.$eval('section[data-renderer]',e=>(e as HTMLElement).dataset.view);await page.evaluate(()=>{const w:any=window;w.old=document.querySelector('canvas');w.render();});assert.equal(await page.$eval('section[data-renderer]',e=>(e as HTMLElement).dataset.view),view);assert.equal(await page.evaluate(()=>(window as any).old.dataset.disposed),'true');
 assert.equal(await page.$$eval('svg',els=>els.length),2);assert.equal(await page.$$eval('svg polyline',els=>els.length),1);assert.equal(await page.$$eval('svg g[role=button]',els=>els.length),2);
 await page.screenshot({path:'/Users/stone/output/liveui-rich-972-20261028/desktop.png',fullPage:true});await page.setViewport({width:390,height:844,deviceScaleFactor:2});await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/Users/stone/output/liveui-rich-972-20261028/mobile.png',fullPage:true});
 const rejected=await page.evaluate(()=>{try{(window as any).runtime.render(document.querySelector('#view'),{type:'Scene3D',scene:{objects:[{id:'x',shape:'script',position:[0,0,0],scale:[1,1,1],color:'#000000'}]}});return false;}catch{return true;}});assert.equal(rejected,true);
});
