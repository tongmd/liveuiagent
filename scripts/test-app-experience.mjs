// Real Chrome, current shipped frontend, local mock service only.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
// Set PLAYWRIGHT_MODULE to an installed Playwright module when it is outside this workspace.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=process.env.LIVEUI_TEST_FRONTEND_DIR||new URL('../frontend/snapshot',import.meta.url).pathname;
const output=process.env.LIVEUI_ENTRY_TEST_OUTPUT||'/tmp/ulemi-app-experience';
await fs.mkdir(output,{recursive:true});
const openFailures=new Set();const bindings=new Map();let patchFailure=false;const apps=[],seen=[],snapshots=new Map(),errors=[],external=[];let createKind='html',responseMode='sse';
function fixture(kind){const appId=kind==='html'?'dsh_entry_fixture':kind==='rich'?'visual_entry_fixture':'native_entry_fixture',name={html:'HTML Reading',native:'Native Notes',rich:'Rich Workspace'}[kind];const app={appId,name,description:'Existing content stays available after closing and reopening.',status:'ready',version:'1',preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],presentation:{glyph:'E',collection:'Notes',tagline:'Saved notes',metric:'1',metricLabel:'RECORDS',rows:1,live:true},widget:{kind:'entities',items:[{id:'note',name:'Saved entry',detail:'Persistent content'}],stats:[],itemLabel:'Records'}},appPackage:{manifest:{appId,name,permissions:[]},ui:{meta:{}},actions:{actions:{}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}}},appData:{},runtimeState:{}};
if(kind==='html')app.completeApp={id:appId};
if(kind==='rich'){app.richWorkspace={id:appId};snapshots.set(appId,{appId,name,version:1,tree:{type:'Stack',children:[{type:'Text',text:'Rich workspace content'},{type:'Text',text:'Saved entry remains intact'}]},records:[],interactionState:{},lastRequest:'Create a useful workspace'});}
if(kind==='native')app.appPackage.ui.meta.a2ui={protocol:'a2ui',surfaceId:'main',initialData:{saved:'Native saved entry'},messages:[{createSurface:{surfaceId:'main'}},{updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['saved']},{id:'saved',component:'Text',text:{path:'/saved'}}]}},{updateDataModel:{surfaceId:'main',value:{saved:'Native saved entry'}}}]};
return app;}
for(const kind of ['html','native','rich'])apps.push(fixture(kind));
const server=http.createServer(async(req,res)=>{try{let route=new URL(req.url,'http://local').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const c of req)raw+=c;const input=raw?JSON.parse(raw):undefined;seen.push({route,method:req.method,input});const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
if(/^\/agent\/apps\/[^/]+\/harness$/.test(route)){
 const id=route.split('/')[3],app=apps.find(a=>a.appId===id);if(!app)return json({error:'Missing'},404);
 const format=app.richWorkspace?'workspace':app.completeApp?'html':'native';
 let state=bindings.get(id)||{appId:id,format,harness:'native',model:'native-model',token:'1',revision:1,busy:false,choices:['native','dsh','codex','qwen','kimi','zcode'].map(key=>({id:key,label:key,available:format!=='html'||key==='dsh',model:key+'-model',models:[key+'-model',key+'-alternate']}))};
 if(format==='html')state={...state,harness:'dsh',model:'dsh-model'};
 if(req.method==='PATCH'){if(patchFailure){patchFailure=false;return json({error:'Active task',code:'app_harness_busy'},409);}assert.equal(input.expectedToken,state.token);state={...state,harness:input.harness,model:input.model,token:String(Number(state.token)+1),revision:state.revision+1,changed:true};if(snapshots.has(id))snapshots.get(id).version++;bindings.set(id,state);}
 return json(state);
}
if(route==='/agent/run'&&input.selectedAppId){assert.equal(input.selectedAppId,'native_entry_fixture');assert.equal(input.llm,undefined);assert.equal(input.harness,undefined);return json({type:'app_patched',appPackage:apps.find(a=>a.appId===input.selectedAppId).appPackage,trace:[]});}
if(route==='/agent/settings')return json({user:{model:'fixture/DeepSeek-V4.1-Flash',models:['fixture/DeepSeek-V4.1-Flash']},server:{model:'fixture/DeepSeek-V4.1-Flash',models:['fixture/DeepSeek-V4.1-Flash'],hasApiKey:true},effective:{model:'fixture/DeepSeek-V4.1-Flash',models:['fixture/DeepSeek-V4.1-Flash'],keySource:'server'}});
if(route==='/agent/models')return json({models:['fixture/DeepSeek-V4.1-Flash'],default:'fixture/DeepSeek-V4.1-Flash'});
if(route==='/agent/runtime-settings')return json({harness:'dsh',choices:[{id:'native',label:'LiveUIAgent',available:true},{id:'dsh',label:'DeepSeek Harness',available:true}],model:{id:'fixture/DeepSeek-V4.1-Flash',configurable:true}});
if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
if(route==='/agent/query-state')return json({canvasState:{canvasId:'home',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom'}},apps,summary:{text:'Fixture',apps:[]}});
if(route==='/agent/chat-history')return json({messages:[]});
if(route==='/agent/run'){const app=fixture(createKind);assert(!apps.some(a=>a.appId===app.appId),'No duplicate create');apps.push(app);const result={type:'app_created',appSummary:{appId:app.appId},appPackage:app.appPackage,trace:[]};if(responseMode==='json')return json(result);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: progress\ndata: '+JSON.stringify({step:'Finishing the app',elapsedMs:50})+'\n\n');return res.end('event: result\ndata: '+JSON.stringify(result)+'\n\n');}
if(route==='/agent/remove-app'){const idx=apps.findIndex(a=>a.appId===input.appId);assert(idx>=0);const [app]=apps.splice(idx,1);return json({type:'app_removed',appId:app.appId,name:app.name});}
if(route.startsWith('/agent/complete/apps/')&&openFailures.delete('html'))return json({error:'Temporary opening failure'},503);
if(route.startsWith('/agent/complete/apps/'))return json({html:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>HTML application content</h1><p>Saved reading entry</p><label>Note <input aria-label="Note"></label></body></html>',store:{notes:'original'}});
if(route.startsWith('/agent/workspaces/')&&req.method==='GET'&&openFailures.delete('rich'))return json({error:'Temporary opening failure'},503);
if(route.startsWith('/agent/workspaces/')){const id=route.split('/')[3];const snapshot=snapshots.get(id);if(req.method==='PUT'){assert.equal(input.expectedVersion,snapshot.version);snapshot.interactionState=input.interactionState;snapshot.version++;}return json(snapshot||{});}
if(route.startsWith('/agent/'))return json({ok:true});
const file=route==='/'?'/index.html':route;if(file.includes('..'))throw Error('Bad path');const data=await fs.readFile(path.join(root,file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html'});res.end(data);
}catch(error){res.writeHead(500);res.end(String(error.stack||error));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/liveui/';
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 UlemiMobile/1'}),page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',route=>{const url=route.request().url();return url.startsWith(origin)||url.startsWith('data:')||url.startsWith('blob:')?route.continue():route.abort();});
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.locator('.gallery-open').first().waitFor();
 async function open(kind){const id=kind==='html'?'dsh_entry_fixture':kind==='rich'?'visual_entry_fixture':'native_entry_fixture';await page.locator(`.liveui-gallery-card[data-app-id="${id}"] .gallery-open`).click();const sheet=page.locator(`.app-sheet[data-app-id="${id}"]`);await sheet.waitFor();await sheet.locator('.complete-app-frame,.a2ui-host,.rich-workspace-content').first().waitFor();return sheet;}
 async function close(sheet){await sheet.locator('.sheet-close').click();await sheet.waitFor({state:'detached'});}
 const checks=[];
 for(const width of[1280,390,320]){
  await page.setViewportSize({width,height:844});
  for(const kind of['rich','native','html']){
   const sheet=await open(kind);await page.waitForTimeout(100);
   const geometry=await sheet.evaluate(el=>{const r=e=>e?.getBoundingClientRect().toJSON();return{header:r(el.querySelector('.sheet-header')),content:r(el.querySelector('.rich-workspace-content,.complete-app-frame,.a2ui-host')),input:r(el.querySelector('.rich-workspace-request textarea,.complete-app-edit textarea,.ulemi-native-compose textarea')),sheet:r(el),closeHit:(()=>{const b=el.querySelector('.sheet-close'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})(),accountCount:document.querySelectorAll('[data-ulemi-native-menu=true]').length,memory:getComputedStyle(document.querySelector('.personal-space-button')).visibility};});
   assert(geometry.closeHit,'Close is not covered');assert.equal(geometry.accountCount,1);assert.equal(geometry.memory,'hidden');
   if(width<=700){assert.equal(Math.round(geometry.sheet.top),0);assert.equal(Math.round(geometry.sheet.height),844);assert(geometry.content.top>=geometry.header.bottom-1);assert(geometry.input.top>=geometry.content.bottom-1);assert(geometry.input.bottom<=844);}
   if(!process.env.LIVEUI_SKIP_SCREENSHOTS)await page.screenshot({path:path.join(output,`${kind}-${width}.png`)});checks.push({kind,width,geometry});
   await close(sheet);
  }
 }
 for(const kind of ['rich','html']){
  openFailures.add(kind);const id=kind==='rich'?'visual_entry_fixture':'dsh_entry_fixture';await page.locator(`.liveui-gallery-card[data-app-id="${id}"] .gallery-open`).click();const failedSheet=page.locator(`.app-sheet[data-app-id="${id}"]`);await failedSheet.getByText('Temporary opening failure',{exact:true}).waitFor();await failedSheet.getByRole('button',{name:/^(Retry|重新打开)$/}).click();await failedSheet.locator(kind==='rich'?'.rich-workspace-content':'.complete-app-frame').waitFor();await close(failedSheet);
 }
 await page.setViewportSize({width:390,height:844});let sheet=await open('rich');const draft=sheet.locator('textarea');await draft.fill('Keep this unsent draft');
 const tree=JSON.stringify(snapshots.get('visual_entry_fixture').tree);
 await sheet.locator('.ulemi-agent-button').click();let firstDialog=page.locator('.ulemi-harness-dialog');await firstDialog.getByLabel('App model',{exact:true}).selectOption('native-alternate');assert.equal(await firstDialog.getByLabel('App model',{exact:true}).inputValue(),'native-alternate');await firstDialog.locator('.ulemi-harness-actions button.primary').click();await firstDialog.getByText('Switched. Content preserved.',{exact:true}).waitFor();await firstDialog.getByRole('button',{name:'Done',exact:true}).click();
 for(const target of['dsh','codex','qwen','kimi','zcode','native']){
  await sheet.locator('.ulemi-agent-button').click();const dialog=page.locator('.ulemi-harness-dialog');await dialog.getByLabel('App agent',{exact:true}).selectOption(target);await dialog.locator('.ulemi-harness-actions button.primary').click();await dialog.getByText('Switched. Content preserved.',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'Keep this unsent draft');assert.equal(JSON.stringify(snapshots.get('visual_entry_fixture').tree),tree);await dialog.getByRole('button',{name:'Done',exact:true}).click();
 }
 assert.equal(seen.filter(x=>x.method==='PATCH').length,7);assert.equal((await page.evaluate(()=>window.__liveuiWorkspaceSnapshots.visual_entry_fixture.version)),snapshots.get('visual_entry_fixture').version);
 patchFailure=true;await sheet.locator('.ulemi-agent-button').click();let dialog=page.locator('.ulemi-harness-dialog');await dialog.getByLabel('App agent',{exact:true}).selectOption('codex');await dialog.locator('.ulemi-harness-actions button.primary').click();await dialog.locator('[role=status].is-error').waitFor();assert.equal(bindings.get('visual_entry_fixture').harness,'native');assert.equal(await draft.inputValue(),'Keep this unsent draft');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.setViewportSize({width:320,height:420});await draft.focus();const bounds=await draft.boundingBox();assert(bounds.y+bounds.height<=420);if(!process.env.LIVEUI_SKIP_SCREENSHOTS)await page.screenshot({path:path.join(output,'rich-short-viewport.png')});await close(sheet);
 sheet=await open('native');await sheet.locator('textarea').fill('Retain my existing notes and add a field');await sheet.locator('.ulemi-native-compose button').click();await sheet.locator('.ulemi-native-feedback').getByText('Updated',{exact:true}).waitFor();assert.equal(seen.filter(x=>x.route==='/agent/run').length,1);await close(sheet);
 sheet=await open('html');await sheet.locator('.ulemi-agent-button').click();dialog=page.locator('.ulemi-harness-dialog');await dialog.getByText('This app uses DSH.',{exact:true}).waitFor();assert.equal(await dialog.getByLabel('App agent',{exact:true}).locator('option').evaluateAll(es=>es.filter(e=>!e.disabled).length),1);assert(await dialog.locator('.ulemi-harness-actions button.primary').isDisabled());await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await close(sheet);
 // Native menu bridge remains one reachable control on the home and app surfaces.
 let nativePrompt='';page.once('dialog',async d=>{nativePrompt=d.message();await d.dismiss();});await page.getByRole('button',{name:'Ulemi menu',exact:true}).click();assert.equal(nativePrompt,'__ulemi_menu_v1__');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({passed:true,checks,switches:7,busyFailurePreservesDraft:true,htmlUnsupportedDisabled:true,nativeUpdateUsesAppBinding:true,nativeMenu:true,openingFailureRetry:true,errors},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,switches:7}));
}catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,seen},null,2));await page.screenshot({path:path.join(output,'failure.png')});throw error;}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
