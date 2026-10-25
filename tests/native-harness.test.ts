import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createNativeHarnessBindings,usesHtmlDelivery} from '../server/native-harness.js';
import {createRuntimeSettings} from '../server/runtime-settings.js';
test('new DSH requests use Native AppSpec while existing HTML packages keep original delivery',()=>{
 assert.equal(usesHtmlDelivery({harness:'dsh',completeApp:true}),false);
 assert.equal(usesHtmlDelivery({harness:'dsh'},'native-app'),false);
 assert.equal(usesHtmlDelivery({harness:'dsh'},'dsh_00000000-0000-0000-0000-000000000000'),true);
 assert.equal(usesHtmlDelivery({delivery:'html'}),true);
});
test('native DSH app affinity survives preference changes and is isolated by owner',()=>{
 const db=new Database(':memory:');
 try{
  const bindings=createNativeHarnessBindings(db);bindings.save('alice','app-one','dsh');assert.equal(bindings.get('bob','app-one'),undefined);
  const settings=createRuntimeSettings(db,{userOf:req=>String(req.header('owner')),choicesOf:()=>[{id:'native',label:'Native',available:true},{id:'dsh',label:'DSH',available:true}],modelOf:async()=>({}),appHarnessOf:(req,id)=>bindings.get(String(req.header('owner')),id)});
  const req:any={body:{},header:()=> 'alice'};
  assert.equal(settings.forRequest(req,'app-one'),'dsh');assert.equal(settings.forRequest(req,'unknown-app'),'native');assert.equal(settings.forRequest(req),'native');
  req.body={harness:'native'};assert.throws(()=>settings.forRequest(req,'app-one'),/different harness/);
  req.body={};req.header=()=> 'bob';assert.equal(settings.forRequest(req,'app-one'),'native');
 }finally{db.close();}
});
