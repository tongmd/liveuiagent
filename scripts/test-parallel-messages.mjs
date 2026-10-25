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
let runtime={harness:'native',choices:[{id:'native',label:'Native Agent',available:true},{id:'dsh',label:'DeepSeek Harness',available:true},{id:'future',label:'Future',available:false,reason:'Not configured'}],model:{id:'fixture/a',source:'server',configurable:true}};
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
if(path==='/agent/run'){pending.set(input.prompt,reply);return;}
if(path==='/evaluator/gui')return reply({type:'rendered_gui_evaluation',appId:input.appId,appName:input.appName,passed:true,scores:{overall:90},findings:['Fixture evidence'],blockingFindings:[],artifacts:{runId:'fixture-run',reportUrl:'/evaluator/artifacts/fixture-run/report.json',files:[{name:'desktop.png',url:'/evaluator/artifacts/fixture-run/desktop.png',type:'image/png'},{name:'report.json',url:'/evaluator/artifacts/fixture-run/report.json',type:'application/json'}]}});
if(path==='/evaluator/run')return reply({type:'behavior_evaluation',appName:input.appName,status:'passed',verdict:{summary:'Fixture behavior passed',evidence:['Fixture action'],failures:[]}});
if(path.startsWith('/agent/'))return reply({error:'Unexpected '+path},404);
const file=path==='/'?'/index.html':path;
const source=await fs.readFile(root+file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(source);
}catch(e){res.writeHead(500);res.end(String(e))}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/liveui/`;

const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-gpu']});
const runCount=()=>seen.filter(x=>x.path==='/agent/run').length;
const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error('Fixture request never arrived')};
async function type(page,text){await page.focus('.frontend-prompt textarea');await page.$eval('.frontend-prompt textarea',(e,value)=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))},text)}
async function finish(prompt,ok){const reply=pending.get(prompt);assert(reply,'request exists');pending.delete(prompt);reply(ok?{type:'answered',answer:'Answer for '+prompt,trace:[]}:{error:'Failure for '+prompt},ok?200:500)}
try{
 for(const width of [1440,390]){
 console.log('width',width);const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:1000});await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base.replace('/liveui/',''))||r.url().startsWith('data:')?r.continue():r.abort());await page.goto(base,{waitUntil:'networkidle0'});await page.waitForSelector('.liveui-runtime-controls');
 const a='Request A '+width,b='Request B '+width,c='Request C '+width,d='Request D '+width;
 await type(page,a);await page.click('.frontend-generate');await wait(()=>pending.has(a));
 await type(page,b);assert.equal(await page.$eval('.frontend-generate',e=>e.disabled),false,'Second Send remains available while A is running');await page.click('.frontend-generate');await wait(()=>pending.has(b));assert(pending.has(a),'A must remain in flight');
 await type(page,'Unsaved draft '+width);const before=runCount();await page.click('[data-evaluation-open]');await page.waitForSelector('.liveui-evaluation');await page.keyboard.press('Escape');await page.click('[aria-label="Reload settings"]');await page.click('.liveui-runtime-row button[title="Model, API, and harness settings"]');await page.waitForSelector('.liveui-panel');await page.keyboard.press('Escape');assert.equal(runCount(),before,'Settings and evaluation never submit the draft');
 console.log('settling B');await finish(b,true);await page.waitForFunction(text=>document.body.innerText.includes(text),{},'Answer for '+b);await finish(a,false);await page.waitForFunction(text=>document.body.innerText.includes(text),{},'Failure for '+a);assert.equal(await page.$eval('.frontend-prompt textarea',e=>e.value),'Unsaved draft '+width);
 // Persisted result association is observable through the chat-append boundary.
 const aResult=seen.filter(x=>x.path==='/agent/chat-append'&&String(x.input.text).includes('Failure for '+a));const bResult=seen.filter(x=>x.path==='/agent/chat-append'&&String(x.input.text).includes('Answer for '+b));assert(aResult.length&&bResult.length);assert(aResult.every(x=>x.input.prompt===a),'Failure belongs to A');assert(bResult.every(x=>x.input.prompt===b),'Answer belongs to B');
 console.log('second pair');await type(page,c);await page.click('.frontend-generate');await wait(()=>pending.has(c));await type(page,d);await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');await wait(()=>pending.has(d));assert(pending.has(c),'Ctrl+Enter submits D while C remains running');await type(page,'Next draft '+width);await finish(c,true);await page.waitForFunction(text=>document.body.innerText.includes(text),{},'Answer for '+c);await finish(d,true);await page.waitForFunction(text=>document.body.innerText.includes(text),{},'Answer for '+d);assert.equal(await page.$eval('.frontend-prompt textarea',e=>e.value),'Next draft '+width);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(process.env.LIVEUI_TEST_OUTPUT_DIR||os.tmpdir(),'parallel-'+width+'.png')});await page.close();
 }
 console.log(JSON.stringify({passed:true,checks:['two simultaneous pending requests','click and Ctrl+Enter while running','reverse completion with one failure','normal completion order','draft retention','request-bound result history','settings and evaluator never submit','desktop and mobile','no browser errors']}));
}finally{for(const reply of pending.values())reply({error:'Test shutdown'},500);await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
