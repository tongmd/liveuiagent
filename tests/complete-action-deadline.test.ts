import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompleteAppBrowser} from '../server/complete-app-evaluator.js';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t:any,{actionDelay=0,actionTimeoutMs=1200,bridgeTimeoutMs=500,raf=false,storeDelay=0}={}){
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'complete-deadline-'));let calls=0,stores=0;
 const html=`<!doctype html><html><head></head><body><h1>Tasks</h1><label>Task<input id="task"></label><button id="run">Run</button><button id="save">Save draft</button><output id="result"></output><script>document.querySelector('#run').onclick=async()=>{try{const result=await liveuiagent.ai(document.querySelector('#task').value,{});await Promise.resolve();${raf?"requestAnimationFrame(()=>document.querySelector('#result').textContent=result.text);":"document.querySelector('#result').textContent=result.text;"}}catch(error){document.querySelector('#result').textContent=error.message;}};document.querySelector('#save').onclick=()=>localStorage.setItem('draft','saved');</script></body></html>`;
 const server=http.createServer(async(req,res)=>{if(req.url?.endsWith('/action')){calls++;await wait(actionDelay);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'host-'+calls,status:'done',result:{ok:true,text:'Actual host record'}}));}else if(req.url?.endsWith('/store')){stores++;await wait(storeDelay);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({html,store:{}}));}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;const transport={async request(route:string,body?:any,method='POST'){const response=await fetch(base+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return response.json();}};
 const browser=new CompleteAppBrowser(transport,'dsh_deadline_fixture',out,process.env.CHROME_PATH,{actionTimeoutMs,bridgeTimeoutMs});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(out,{recursive:true,force:true});});await browser.open();await browser.perform({kind:'fill',target:'task',value:'Read the record'});
 return{browser,calls:()=>calls,stores:()=>stores};
}
test('a configured action budget completes a real HTTP action beyond the old scaled limit',async t=>{
 const {browser,calls}=await fixture(t,{actionDelay:350,actionTimeoutMs:1200});await browser.perform({kind:'click',target:'run'});assert.equal(calls(),1);assert.equal(browser.bridgeResults.length,1);assert.equal(browser.actionState.status,'idle');assert.match((await browser.snapshot()).visibleText,/Actual host record/);
});
test('HTTP completion is not settled until the SDK reply and its DOM continuation acknowledge',async t=>{
 const {browser,calls}=await fixture(t,{actionDelay:30,actionTimeoutMs:1600,raf:true});
 await browser.page!.evaluate(()=>{const original=(window as any).__liveuiEvalBridge;(window as any).__liveuiEvalBridge=async(...args:any[])=>{const value=await original(...args);await new Promise(resolve=>setTimeout(resolve,350));return value;};});
 const started=Date.now();await browser.perform({kind:'click',target:'run'});assert.ok(Date.now()-started>=350);assert.equal(calls(),1);assert.match((await browser.snapshot()).visibleText,/Actual host record/);assert.equal(browser.pending.size,0);
});
test('one absolute deadline taints unresolved actions and blocks retry steps reopen and late attribution',async t=>{
 const {browser,calls}=await fixture(t,{actionDelay:900,actionTimeoutMs:400});
 const operation=browser.perform({kind:'click',target:'run'});await wait(120);const deadline=browser.actionState.deadlineAt;const settling=browser.settle();const results=await Promise.allSettled([operation,settling]);assert(results.every(result=>result.status==='rejected'));assert.equal(browser.actionState.deadlineAt,deadline,'settle did not reset the action budget');assert.equal(browser.actionState.status,'unresolved');assert.equal(browser.actionState.tainted,true);assert.match(browser.actionState.warning!,/side effects.*may already|outcome is unknown/);
 await assert.rejects(browser.submit('Retry would duplicate a write'),/unresolved|blocked/);await assert.rejects(browser.perform({kind:'click',target:'run'}),/unresolved|blocked/);await assert.rejects(browser.open(),/unresolved|blocked/);
 const rejected=await browser.frame!.evaluate(async()=>{try{await(window as any).liveuiagent.ai('Retry from inside the app',{});return '';}catch(error){return(error as Error).message;}});assert.match(rejected,/unresolved|blocked/);assert.equal(calls(),1);
 await wait(700);assert.equal(browser.bridgeResults.length,0,'late result cannot become evidence for a later turn');assert.equal(browser.lateBridgeResults.length,1);assert.equal(browser.actionState.status,'unresolved');assert.equal(calls(),1);
});
test('storage stays on the short bridge deadline instead of inheriting the long AI budget',async t=>{
 const {browser,stores}=await fixture(t,{storeDelay:700,actionTimeoutMs:2000,bridgeTimeoutMs:250});await assert.rejects(browser.perform({kind:'click',target:'save'}),/unresolved|deadline/);assert.equal(stores(),1);assert.equal(browser.actionState.tainted,true);await wait(700);
});
