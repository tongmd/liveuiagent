// Exercise the HTTP-browser path where randomUUID is unavailable.
// Browser integration fixtures only: no external model or DSH requests.
// Run: CHROME_PATH=/path/to/chrome node scripts/test-runtime-controls.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const root=process.env.LIVEUI_TEST_FRONTEND_DIR || fileURLToPath(new URL('../frontend/snapshot', import.meta.url));
const seen=[];const pending=new Map();let failPatch=false,fixtureApps=false;
let settings={user:{apiBase:'',model:'fixture/a',models:['fixture/a','fixture/DeepSeek-V4.1-Flash'],hasApiKey:false},server:{apiBase:'https://example.invalid',model:'fixture/a',models:['fixture/a','fixture/DeepSeek-V4.1-Flash'],hasApiKey:true},effective:{model:'fixture/a',models:['fixture/a','fixture/DeepSeek-V4.1-Flash'],keySource:'server'},warnings:[]};
let runtime={harness:'codex',choices:[{id:'native',label:'Native Agent',available:true},{id:'dsh',label:'DeepSeek Harness',available:true},{id:'codex',label:'Codex',available:true}],model:{id:'fixture/a',source:'server',configurable:true}};
// Query-state can refresh after a submit while the evaluator is open. Keep its
// app records valid for both the real React catalog and the evaluator picker.
const fixtureApp=(appId,name,completeApp=false)=>({appId,name,description:'Fixture application',status:'ready',version:'1',...(completeApp?{completeApp:{id:appId}}:{}),preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],presentation:{glyph:'F',collection:'Notes',tagline:'Saved details',metric:'0',metricLabel:'RECORDS',rows:0,live:true},widget:{kind:'entities',items:[],stats:[],itemLabel:'Records'}},appPackage:{manifest:{appId,name,permissions:[]},ui:{meta:{}},actions:{actions:{}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#4b7560"/></svg>'}}},appData:{},runtimeState:{}});
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');let path=url.pathname.replace(/^\/liveui/,'')||'/';let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):undefined;seen.push({path,rawPath:url.pathname,method:req.method,input});const reply=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
if(path==='/agent/settings'){if(req.method==='PUT')settings={...settings,effective:{...settings.effective,model:input.model},user:{...settings.user,model:input.model}};return reply(settings)}
if(path==='/agent/runtime-settings'){if(req.method==='PATCH'){if(failPatch)return reply({error:'Fixture unavailable'},503);runtime={...runtime,harness:input.harness}}return reply(runtime)}
if(path==='/agent/models')return reply({models:settings.effective.models,default:settings.effective.model});
if(path==='/agent/personal')return reply({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
if(path==='/agent/query-state')return reply({canvasState:{canvasId:'home',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom',placeholder:''}},apps:fixtureApps?[fixtureApp('native_fixture','Fixture Native'),fixtureApp('dsh_fixture','Fixture DSH',true)]:[],summary:{text:'Fixture',apps:[]}});
if(path==='/agent/chat-history')return reply({messages:[]});
if(path==='/agent/chat-append')return reply({id:1});
if(path==='/agent/run'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});pending.set(input.prompt,{res,input});return;}
if(path==='/evaluator/gui')return reply({type:'rendered_gui_evaluation',appId:input.appId,appName:input.appName,passed:true,scores:{overall:90},findings:['Fixture evidence'],blockingFindings:[],artifacts:{runId:'fixture-run',reportUrl:'/evaluator/artifacts/fixture-run/report.json',files:[{name:'desktop.png',url:'/evaluator/artifacts/fixture-run/desktop.png',type:'image/png'},{name:'report.json',url:'/evaluator/artifacts/fixture-run/report.json',type:'application/json'}]}});
if(path==='/evaluator/run')return reply({type:'behavior_evaluation',appName:input.appName,status:'passed',verdict:{summary:'Fixture behavior passed',evidence:['Fixture action'],failures:[]}});
if(path.startsWith('/agent/'))return reply({error:'Unexpected '+path},404);
const file=path==='/'?'/index.html':path;
const source=await fs.readFile(root+file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(source);
}catch(e){res.writeHead(500);res.end(String(e))}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/liveui/`;

const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-gpu']});
const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error('Expected fixture request')};
async function type(page,text){await page.focus('.frontend-prompt textarea');await page.$eval('.frontend-prompt textarea',e=>e.select());await page.keyboard.press('Backspace');await page.keyboard.sendCharacter(text);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function submit(page,prompt){await type(page,prompt);await page.click('.frontend-generate');try {await wait(()=>pending.has(prompt));} catch(error) {await page.screenshot({path:(process.env.LIVEUI_TEST_OUTPUT_DIR || '/tmp')+'/development-failed.png'});console.error(JSON.stringify({prompt,viewport:page.viewport(),last:seen.slice(-8),composer:await page.$eval('.frontend-prompt textarea',e=>e.value),buttons:await page.$$eval('.frontend-generate',es=>es.map(e=>({text:e.textContent,disabled:e.disabled,rect:JSON.stringify(e.getBoundingClientRect())})))}));throw error;}return pending.get(prompt).input;}
function event(prompt,name,data,close=false){const item=pending.get(prompt);assert(item);item.res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');if(close){item.res.end();pending.delete(prompt)}}
function progress(prompt,id){event(prompt,'progress',{step:'Reading source',elapsedMs:100,jobId:'job_'+id,developmentConversationId:'dev_'+id})}
function done(prompt,id){event(prompt,'result',{type:'answered',answer:'Modified source '+id+'; not deployed.',trace:[],jobId:'job_'+id,developmentConversationId:'dev_'+id,development:{validation:'passed',changedFiles:['server/example.ts'],deployed:false}},true)}
function fail(prompt,id){event(prompt,'error',{error:'Test command failed '+id,code:'development_test_failed',jobId:'job_'+id,developmentConversationId:'dev_'+id},true)}
function ordinary(prompt){event(prompt,'result',{type:'answered',answer:'Ordinary answer',trace:[]},true)}
try {
for(const width of [1280,390]){console.log('width',width);
 runtime={...runtime,harness:'codex'};
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:900});
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base.replace('/liveui/',''))||r.url().startsWith('data:')?r.continue():r.abort());
 await page.goto(base,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('[aria-label="New app harness"]')?.value==='codex');
 const a='修改liveUI界面 A '+width,b='修改liveUI界面 B '+width;
 await submit(page,a);progress(a,'A');await submit(page,b);progress(b,'B');await type(page,'Preserved draft');done(b,'B');await page.waitForFunction(()=>document.body.innerText.includes('Modified source B'));done(a,'A');await new Promise(r=>setTimeout(r,200));assert(!await page.$eval('.morph-answer',e=>e.innerText.includes('Modified source A')),'late A result must not replace B answer');
 assert.equal(await page.$eval('.frontend-prompt textarea',e=>e.value),'Preserved draft');
 const continuation=await submit(page,'继续');assert.equal(continuation.developmentConversationId,'dev_B','late A result must not replace B');fail('继续','B');await page.waitForFunction(()=>document.body.innerText.includes('Test command failed B'));assert(await page.evaluate(()=>document.body.innerText.includes('job_B')),'error must expose actual job ID');
 await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('[aria-label="New app harness"]')?.value==='codex');
 const afterReload=await submit(page,'继续');assert.equal(afterReload.developmentConversationId,'dev_B');done('继续','B');await page.waitForFunction(()=>document.body.innerText.includes('Modified source B'));
 await page.select('[aria-label="New app harness"]','native');await page.waitForFunction(()=>!document.querySelector('[aria-label="New app harness"]').disabled);
 const switched=await submit(page,'继续');assert.equal(switched.developmentConversationId,undefined,'another harness must not inherit Codex context');ordinary('继续');
 await page.select('[aria-label="New app harness"]','codex');await page.waitForFunction(()=>!document.querySelector('[aria-label="New app harness"]').disabled);
 const restored=await submit(page,'继续');assert.equal(restored.developmentConversationId,'dev_B');progress('继续','C');fail('继续','C');await page.waitForFunction(()=>document.body.innerText.includes('Test command failed C'));
 const retry=await submit(page,'继续');assert.equal(retry.developmentConversationId,'dev_C','failed job retains its actual conversation');done('继续','C');await page.waitForFunction(()=>document.body.innerText.includes('Modified source C'));
 const notice=await page.$('.liveuiagent-toast');assert(notice);const dismiss=await page.$('.liveuiagent-toast-close');assert(dismiss,'explicit close remains available');assert.equal(await page.$eval('.liveuiagent-toasts',e=>getComputedStyle(e).pointerEvents),'none');assert.equal(await page.$eval('.liveuiagent-toast-close',e=>getComputedStyle(e).pointerEvents),'auto');
 const hit=await page.$eval('.frontend-generate',e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e===h||e.contains(h)});assert.equal(hit,true,'Send hit target must remain the Send button while notices exist');const beforeClose=await page.$$eval('.liveuiagent-toast',es=>es.length);await page.click('.liveuiagent-toast:last-child .liveuiagent-toast-close');await page.waitForFunction(before=>document.querySelectorAll('.liveuiagent-toast').length<before,{},beforeClose);await page.screenshot({path:path.join(process.env.LIVEUI_TEST_OUTPUT_DIR||os.tmpdir(),'development-'+width+'.png')});
 const normal=await submit(page,'做一个新的阅读清单');assert.equal(normal.developmentConversationId,undefined,'ordinary requests remain ordinary');ordinary('做一个新的阅读清单');await page.waitForFunction(()=>document.body.innerText.includes('Ordinary answer'));
 const normalContinue=await submit(page,'继续');assert.equal(normalContinue.developmentConversationId,undefined,'ordinary result clears old development focus');ordinary('继续');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.close();
}
console.log(JSON.stringify({passed:true,widths:[1280,390],checks:['normal composer development progress/result/error','late result does not replace newer conversation','draft retained','bare continue attaches exact conversation','refresh persists binding','ordinary App does not inherit development target','harness isolation and switch back','actual failed job retained','no browser errors or overflow'],modelRequests:0}));
} finally {for(const {res} of pending.values())res.end();const child=browser.process();let closeTimer;await Promise.race([browser.close(),new Promise(resolve=>{closeTimer=setTimeout(()=>{child?.kill('SIGTERM');browser.disconnect();resolve();},5000)})]);clearTimeout(closeTimer);const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
