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
const seen=[];const pending=new Map();let failPatch=false,fixtureApps=false;const jobs=new Map(), requestJobs=new Map(), failures=new Map();
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
if(path.startsWith('/agent/development/jobs/')){const id=path.split('/').at(-1);if(failures.get(id)){failures.set(id,failures.get(id)-1);return reply({error:'Restarting'},503)}return jobs.has(id)?reply(jobs.get(id)):reply({error:'missing'},404)}
if(path.startsWith('/agent/development/requests/')){const id=requestJobs.get(path.split('/').at(-1));return id?reply(jobs.get(id)):reply({error:'missing'},404)}
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

function deployment(prompt,id,status,receipt){
 const job={id:'job_'+id,conversationId:'dev_'+id,status:'done',prompt,result:{validation:'passed',deployed:Boolean(receipt),deployment:{status,...(receipt?{receipt:{status:'deployed',transactionId:'tx-'+id,verified:true}}:{})}}};
 job.presentation={type:'answered',answer:'Modified source '+id,trace:[],jobId:job.id,developmentConversationId:job.conversationId,development:job.result};
 jobs.set(job.id,job);return job;
}
function deployResult(prompt,id,status='queued'){const job=deployment(prompt,id,status);requestJobs.set(pending.get(prompt).input.clientRequestId,job.id);event(prompt,'result',job.presentation,true);}
const reports=[];
try {
for(const width of [1280,390]){
 console.log('deployment width',width);runtime={...runtime,harness:'codex'};
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:900});
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base.replace('/liveui/',''))||r.url().startsWith('data:')?r.continue():r.abort());
 await page.goto(base,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('[aria-label="New app harness"]')?.value==='codex');
 let prompt='修改liveUI 自动部署 '+width;await submit(page,prompt);progress(prompt,'deploy'+width);deployResult(prompt,'deploy'+width);
 await page.waitForFunction(()=>document.body.innerText.includes('等待自动检查'));
 await type(page,'Keep this draft');failures.set('job_deploy'+width,1);
 await page.waitForFunction(()=>document.body.innerText.includes('重新连接原开发任务'));
 deployment(prompt,'deploy'+width,'reviewing');await page.waitForFunction(()=>document.body.innerText.includes('正在独立审查'));
 deployment(prompt,'deploy'+width,'deployed');await page.waitForFunction(()=>document.body.innerText.includes('部署结果待核查'));
 assert(!await page.evaluate(()=>document.body.innerText.includes('已上线')),'missing receipt cannot claim deployed');
 deployment(prompt,'deploy'+width,'deployed',true);await page.waitForFunction(()=>document.body.innerText.includes('已上线'));
 assert.equal(seen.filter(r=>r.path==='/agent/chat-append'&&r.input?.prompt===prompt).length,2,'deployment progress does not append heartbeat messages or full answer toasts');
 assert.equal(await page.$eval('.frontend-prompt textarea',e=>e.value),'Keep this draft');
 assert.equal(seen.filter(r=>r.path==='/agent/run'&&r.input?.prompt===prompt).length,1,'restart never repeats original POST');
 // Reload follows the same queued job without a new submit.
 prompt='修改liveUI 刷新 '+width;await submit(page,prompt);progress(prompt,'refresh'+width);deployResult(prompt,'refresh'+width,'checking');
 await page.waitForFunction(()=>document.body.innerText.includes('正在检查代码与测试'));await page.reload({waitUntil:'networkidle0'});
 await page.waitForFunction(()=>document.body.innerText.includes('正在检查代码与测试'));
 deployment(prompt,'refresh'+width,'rolled_back');await page.waitForFunction(()=>document.body.innerText.includes('已回滚'));
 assert.equal(seen.filter(r=>r.path==='/agent/run'&&r.input?.prompt===prompt).length,1);
 // Newer answer owns the display; an old deployment can still finish.
 const older='修改liveUI 旧 '+width,newer='修改liveUI 新 '+width;
 await submit(page,older);progress(older,'old'+width);deployResult(older,'old'+width);
 await page.waitForFunction(()=>document.body.innerText.includes('Modified source old'));
 await submit(page,newer);progress(newer,'new'+width);deployResult(newer,'new'+width,'blocked');
 await page.waitForFunction(()=>document.body.innerText.includes('自动部署受阻'));
 deployment(older,'old'+width,'deployed',true);await new Promise(r=>setTimeout(r,2500));
 assert(await page.evaluate(()=>document.body.innerText.includes('Modified source new')),'newer answer stays');
 assert(!await page.$eval('.morph-answer',e=>e.innerText.includes('Modified source old')),'old deployment cannot replace answer');
 // Lose the SSE before first progress; recover by clientRequestId GET only.
 prompt='修改liveUI 断线 '+width;const request=await submit(page,prompt);const recovered=deployment(prompt,'recover'+width,'queued');requestJobs.set(request.clientRequestId,recovered.id);
 pending.get(prompt).res.flushHeaders();await new Promise(r=>setTimeout(r,100));pending.get(prompt).res.destroy();pending.delete(prompt);
 try{await page.waitForFunction(()=>document.body.innerText.includes('Modified source recover'));}catch(error){console.log(JSON.stringify({last:seen.slice(-18),body:await page.evaluate(()=>document.body.innerText)}));throw error;}
 deployment(prompt,'recover'+width,'unknown');await page.waitForFunction(()=>document.body.innerText.includes('部署结果待核查'));
 assert.equal(seen.filter(r=>r.path==='/agent/run'&&r.input?.prompt===prompt).length,1);
 assert(seen.some(r=>r.method==='GET'&&r.path==='/agent/development/requests/'+request.clientRequestId));
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(process.env.LIVEUI_TEST_OUTPUT_DIR||os.tmpdir(),'deployment-'+width+'.png')});reports.push({width,passed:true});await page.close();
}
console.log(JSON.stringify({passed:true,reports,checks:['queued to checking/reviewing/deployed receipt','503 reconnect GET only','missing receipt never deployed','refresh same original job','rollback and blocked accurately shown','old completion cannot overwrite newer answer','draft preserved','SSE disconnect before progress recovers request ID without POST','no browser errors or overflow'],modelRequests:0}));
} finally {for(const {res} of pending.values())res.end();const child=browser.process();let closeTimer;await Promise.race([browser.close(),new Promise(resolve=>{closeTimer=setTimeout(()=>{child?.kill('SIGTERM');browser.disconnect();resolve();},5000)})]);clearTimeout(closeTimer);const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
