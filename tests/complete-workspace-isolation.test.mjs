import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {createCompleteApps} from '../dist-server/server/complete-apps.js';

const hash=user=>createHash('sha256').update(user).digest('hex');
const appMeta={id:'12345678-1234-1234-1234-123456789abc',name:'Existing app',description:'Retained data',revision:1,createdAt:'2026-01-01'};
async function serve(t,app){const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;}
function env(t,values){const before={};for(const [key,value]of Object.entries(values)){before[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}t.after(()=>{for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});}
async function fixture(t,{prefix,bootstrap,upstreamRoot,oldApps=[appMeta]}={}){
 const calls=[];const upstream=express();upstream.use(express.json());
 upstream.get('/api/state',async(req,res,next)=>{try{
  const owner=req.header('x-liveuiagent-user');calls.push(owner);let state={apps:oldApps};
  if(upstreamRoot){const file=path.join(upstreamRoot,'accounts',hash(owner),'state.json');state=JSON.parse(await fs.readFile(file,'utf8'));if(!state.seedVersion)state.apps.push({...appMeta,example:true});}
  res.json({...state,user:owner});
 }catch(e){next(e)}});
 const remote=await serve(t,upstream);
 env(t,{LIVEUIAGENT_DSH_API_BASE:remote+'/api',LIVEUI_DSH_USER_PREFIX:prefix,LIVEUI_DSH_EMPTY_ACCOUNT_ROOT:bootstrap});
 const db=new Database(':memory:');t.after(()=>db.close());const userOf=req=>req.header('x-liveuiagent-user')||'';
 const bridge=createCompleteApps(db,{},userOf,()=>undefined);const app=express();app.use(express.json());bridge.install(app);
 app.get('/merged',async(req,res,next)=>{try{res.json(await bridge.merge(req,{apps:[],canvasState:{nodes:[],edges:[]},summary:{}}));}catch(e){next(e)}});
 app.use((e,req,res,next)=>res.status(e.status||500).json({code:e.code,error:e.message}));const base=await serve(t,app);
 return {db,calls,request:async(owner='alice',route='/agent/complete/state')=>{const r=await fetch(base+route,{headers:{'x-liveuiagent-user':owner}});return{status:r.status,body:await r.json()};}};
}
async function rootDir(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-workspace-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
async function stateFile(root,user,value){const file=path.join(root,'accounts',hash(user),'state.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));return file;}

test('default DSH identity and local owner remain compatible; optional prefix changes only upstream identity',async t=>{
 const legacy=await fixture(t);assert.equal((await legacy.request()).body.apps.length,1);assert.deepEqual(legacy.calls,['alice']);
 const isolated=await fixture(t,{prefix:'liveui:'});assert.equal((await isolated.request('alice','/merged')).body.apps.length,1);
 assert.deepEqual(isolated.calls,['liveui:alice']);assert.deepEqual(isolated.db.prepare('SELECT owner FROM complete_apps').all(),[{owner:'alice'}]);
 await isolated.request('bob');assert.equal(isolated.calls.at(-1),'liveui:bob');
});

test('future namespaced users start empty before first upstream read; original accounts and existing isolated apps survive',async t=>{
 const root=await rootDir(t);const original=await stateFile(root,'alice',{apps:[appMeta],jobs:[],seedVersion:1,memory:{manual:'Keep my preference',entries:[]}});
 const bytes=await fs.readFile(original);const f=await fixture(t,{prefix:'liveui:',bootstrap:root,upstreamRoot:root});
 const requests=await Promise.all([f.request('alice'),f.request('alice'),f.request('future-user')]);
 for(const r of requests){assert.equal(r.status,200);assert.deepEqual(r.body.apps,[]);assert.equal(r.body.seedVersion,1);}
 assert.deepEqual(await fs.readFile(original),bytes);assert.equal(f.calls.filter(x=>x==='alice').length,0);
 const existing=await stateFile(root,'liveui:existing',{apps:[appMeta],jobs:[],seedVersion:1,memory:{manual:'Preserve this',entries:[]}});const before=await fs.readFile(existing);
 assert.equal((await f.request('existing')).body.apps[0].name,'Existing app');assert.deepEqual(await fs.readFile(existing),before);
 const otherProcess=await fixture(t,{prefix:'liveui:',bootstrap:root,upstreamRoot:root});
 for(const response of await Promise.all([f.request('concurrent-user'),otherProcess.request('concurrent-user')]))assert.deepEqual(response.body.apps,[]);
 for(const user of ['alice','future-user'])assert.deepEqual(await fs.readdir(path.join(root,'accounts',hash('liveui:'+user))),['state.json']);
});

test('bootstrap configuration and storage failures cannot silently import upstream examples',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());env(t,{LIVEUI_DSH_USER_PREFIX:undefined,LIVEUI_DSH_EMPTY_ACCOUNT_ROOT:'/absolute'});
 assert.throws(()=>createCompleteApps(db,{},()=>'',()=>undefined),/nonempty/);
 process.env.LIVEUI_DSH_USER_PREFIX='liveui:';process.env.LIVEUI_DSH_EMPTY_ACCOUNT_ROOT='relative';assert.throws(()=>createCompleteApps(db,{},()=>'',()=>undefined),/absolute/);
 const root=await rootDir(t);const file=path.join(root,'not-a-directory');await fs.writeFile(file,'blocked');
 const broken=await fixture(t,{prefix:'liveui:',bootstrap:file});const response=await broken.request('alice','/merged');
 assert.equal(response.status,503);assert.equal(response.body.code,'dsh_workspace_initialization_failed');assert.deepEqual(broken.calls,[]);
 const unsafe=await stateFile(root,'liveui:unmigrated',{apps:[appMeta],jobs:[]});const before=await fs.readFile(unsafe);
 const guarded=await fixture(t,{prefix:'liveui:',bootstrap:root});assert.equal((await guarded.request('unmigrated')).status,503);assert.deepEqual(await fs.readFile(unsafe),before);assert.deepEqual(guarded.calls,[]);
 const original=await stateFile(root,'legacy-owner',{apps:[appMeta],jobs:[],seedVersion:1});const originalBytes=await fs.readFile(original);
 await fs.symlink(path.dirname(original),path.join(root,'accounts',hash('liveui:linked-owner')));
 assert.equal((await guarded.request('linked-owner')).status,503);assert.deepEqual(await fs.readFile(original),originalBytes);assert.deepEqual(guarded.calls,[]);
});
