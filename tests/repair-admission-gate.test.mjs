import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
const source=fs.readFileSync(new URL('../server/index.ts',import.meta.url),'utf8');
const block=source.match(/\/\/ LIVEUI_AUTO_REPAIR_GATE_1143_BEGIN[\s\S]*?\/\/ LIVEUI_AUTO_REPAIR_GATE_1143_END/)?.[0];
assert.ok(block, 'admission gate remains present');
const fixtureRoot=path.resolve('fixture-release', 'releases', 'test');
const markerPath=path.resolve(fixtureRoot, '..', '..', 'auto-repair-maintenance.json');
const valid=()=>({expiresAt:Date.now()+179000,transactionId:'fixture-1143'});
async function fixture(fn){
 let marker=null,symlink=false,oversized=false; const touched=[];
 const fakeFs={lstatSync(p){touched.push(p);if(marker===null)throw Object.assign(new Error('missing'),{code:'ENOENT'});return {isFile:()=>true,isSymbolicLink:()=>symlink,size:oversized?4097:200};},readFileSync(p,encoding){touched.push(p);assert.equal(encoding,'utf8');return typeof marker==='string'?marker:JSON.stringify(marker);}};
 const app=express();new Function('app','fs','path','root',block)(app,fakeFs,path,fixtureRoot);
 let business=0;let unblock;
 const inflight=new Promise(resolve=>{unblock=resolve;});
 let started;const observed=new Promise(resolve=>{started=resolve;});
 app.post('/slow',async(_q,r)=>{business++;started();await inflight;r.json({finished:true});});
 app.use((req,res)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!['/agent/query-state','/agent/scheduler-state'].includes(req.path))business++;res.json({method:req.method,path:req.path});});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{await fn({set:(v)=>{marker=v;},setSymlink:()=>{symlink=true;},setOversized:()=>{oversized=true;},request:(path,method='GET')=>fetch(base+path,{method}),business:()=>business,unblock,observed});assert.ok(touched.every(p=>p===markerPath));}
 finally{unblock();server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('missing marker leaves ordinary business requests available',()=>fixture(async f=>{for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await f.request('/work',method)).status,200);assert.equal(f.business(),4);assert.deepEqual(await(await f.request('/agent/repair-gate-status')).json(),{active:false,transactionId:null});}));
test('valid marker blocks every new mutating request with explicit retry and no business execution',()=>fixture(async f=>{f.set(valid());for(const method of ['POST','PUT','PATCH','DELETE']){const r=await f.request('/work?x=1',method);assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'5');assert.equal((await r.json()).code,'liveui_repair_maintenance');}assert.equal(f.business(),0);const r=await f.request('/agent/repair-gate-status');assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{active:true,transactionId:'fixture-1143'});}));
test('active gate leaves job GETs, health, OPTIONS and only fixed readonly POSTs available',()=>fixture(async f=>{f.set(valid());for(const [path,method] of [['/agent/jobs/original','GET'],['/health','GET'],['/agent/jobs/original','HEAD'],['/agent/run','OPTIONS'],['/agent/scheduler-state','POST'],['/agent/query-state','POST']])assert.equal((await f.request(path,method)).status,200);assert.equal((await f.request('/agent/query-state','PATCH')).status,503);assert.equal((await f.request('/agent/query-state/evil','POST')).status,503);assert.equal(f.business(),0);}));
test('expiry releases admission automatically without marker deletion',()=>fixture(async f=>{f.set({expiresAt:Date.now()-1,transactionId:'expired'});assert.equal((await f.request('/work','POST')).status,200);assert.deepEqual(await(await f.request('/agent/repair-gate-status')).json(),{active:false,transactionId:null});}));
test('malformed, invalid-ID, far-future or missing fields are inactive',()=>fixture(async f=>{for(const marker of ['{invalid',{},null,[],{expiresAt:'never',transactionId:'x'},{expiresAt:Date.now()+3600000,transactionId:'x'},{expiresAt:Date.now()+10000,transactionId:'../unsafe'}]){f.set(marker);assert.equal((await f.request('/work','POST')).status,200);assert.equal((await(await f.request('/agent/repair-gate-status')).json()).active,false);}}));
test('symlink marker is ignored and never read',()=>fixture(async f=>{f.set(valid());f.setSymlink();assert.equal((await f.request('/work','POST')).status,200);}));
test('oversized marker is ignored',()=>fixture(async f=>{f.set(valid());f.setOversized();assert.equal((await f.request('/work','POST')).status,200);}));
test('already-admitted work may finish while new requests are held',()=>fixture(async f=>{const pending=f.request('/slow','POST');await f.observed;f.set(valid());assert.equal((await f.request('/work','POST')).status,503);f.unblock();assert.deepEqual(await(await pending).json(),{finished:true});assert.equal(f.business(),1);}));
