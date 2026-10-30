import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {createRichWorkspaces} from '../server/rich-workspaces.js';
import {createRuntimeSettings, type HarnessId} from '../server/runtime-settings.js';
import {createNativeHarnessBindings} from '../server/native-harness.js';
import {harnessIds} from '../server/harness-catalog.js';

// The network/API, registry, binding, validation and persistence are real. Only
// inference is a fixture: separate callbacks prove which adapter received input.
const models: Record<HarnessId,string> = {
  native:'native-fixture', codex:'codex-fixture', dsh:'deepseek-fixture',
  qwen:'qwen-fixture', kimi:'kimi-fixture', zcode:'glm-fixture',
};
const records = [{id:'measurement',title:'Measured dimensions',width:2,depth:1,note:'Keep exact original values'}];
function richTree(revised=false) {
  return {type:'Grid',style:{width:revised?1120:900,columns:2,columnWeights:[2,1],fontFamily:'sans',fontSize:18,color:'#172034',background:'#ffffff',mobile:{columns:1,columnWeights:[1]}},children:[
    {type:'Scene3D',style:{height:360,mobile:{height:240}},scene:{title:'Room',grid:true,objects:[{id:'desk',shape:'box',position:[revised?1:0,0,0],scale:[2,1,1],color:'#2255cc'}]}},
    {type:'Plot',plot:{kind:'line',title:'Supplied measurements',series:[{name:'Length',color:'#2255cc',points:[[0,0],[1,2],[2,4]]}]}},
    {type:'Diagram',diagram:{nodes:[{id:'a',label:'Input',x:0.2,y:0.5,color:'#2255cc'},{id:'b',label:'Result',x:0.8,y:0.5,color:'#2255cc'}],edges:[{from:'a',to:'b',label:'Compare'}]}},
    {type:'List',recordId:'measurement',children:[]},
  ]};
}

for (const harness of harnessIds) {
  test(`${harness}: normal rich route uses its own adapter for 3D, plots, diagrams and revisions`,async t=>{
    const db = new Database(':memory:');
    const app = express(); app.use(express.json());
    const owner = (req:any)=>String(req.headers['x-owner']||'');
    const bindings = createNativeHarnessBindings(db);
    const settings = createRuntimeSettings(db,{
      userOf:owner,defaultHarness:harness,
      choicesOf:()=>harnessIds.map(id=>({id,label:id,available:true})),
      modelOf:async(_req,id)=>({id:models[id]}),
      appHarnessOf:(req,id)=>bindings.get(owner(req),id),
    });
    const calls:Array<{adapter:HarnessId,request:any}> = [];
    let revised=false, invalid=false;
    const adapters=Object.fromEntries(harnessIds.map(id=>[id,async(request:any)=>{
      calls.push({adapter:id,request});
      assert.equal(request.model,models[id]);
      return {choices:[{message:{content:JSON.stringify({text:'Ready',data:{tree:invalid?{type:'Script'}:richTree(revised)}})}}]};
    }]));
    const workspaces=createRichWorkspaces(db,{
      userOf:owner,harnessFor:(req,id)=>settings.forRequest(req,id),
      llmOf:(req,id)=>{const selected=settings.forRequest(req,id);return {model:models[selected],chatCompletion:adapters[selected]};},
      bindHarness:(user,id,selected)=>bindings.save(user,id,selected as HarnessId),
    });
    settings.install(app); workspaces.install(app);
    app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:error.message,code:error.code}));
    const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();});
    const base='http://127.0.0.1:'+(server.address() as any).port;
    async function request(route:string,body?:any,method=body?'POST':'GET',user='alice') {
      const response=await fetch(base+route,{method,headers:{'content-type':'application/json','x-owner':user},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,value:await response.json()};
    }
    const created=await request('/agent/run',{prompt:'创建一个三维房间与图表关系图应用',records});
    assert.equal(created.status,200); assert.equal(created.value.type,'app_created');
    assert.equal(created.value.execution.harness,harness); assert.equal(created.value.execution.model,models[harness]);
    const id=created.value.appSummary.appId, first=(await request('/agent/workspaces/'+id)).value;
    assert.deepEqual(first.tree,richTree()); assert.deepEqual(first.records,records);
    assert.equal(first.app.harness,harness); assert.equal(bindings.get('alice',id),harness);
    assert.match(calls[0].request.messages[0].content,/Scene3D/);
    assert.deepEqual(JSON.parse(calls[0].request.messages[1].content).context.presentation.components.filter((name:string)=>['Scene3D','Plot','Diagram'].includes(name)),['Scene3D','Plot','Diagram']);
    const interactionState={richState:{scene:{yaw:1.25},plot:{series:0,index:1},diagram:{selected:'b'}},checked:{measurement:true}};
    assert.equal((await request('/agent/workspaces/'+id+'/state',{expectedVersion:1,interactionState},'PUT')).status,200);
    const other:HarnessId=harness==='native'?'codex':'native';
    assert.equal((await request('/agent/runtime-settings',{harness:other},'PATCH')).status,200);
    const count=calls.length;
    assert.equal((await request('/agent/workspaces/'+id+'/generate',{harness:other,prompt:'Change renderer',expectedVersion:2})).status,409);
    assert.equal(calls.length,count,'wrong harness must fail before any inference');
    revised=true;
    const changed=await request('/agent/run',{selectedAppId:id,prompt:'把书桌右移一米，保留图表数值和关系，扩大工作区'});
    assert.equal(changed.status,200); assert.equal(changed.value.type,'app_patched');
    assert.equal(changed.value.execution.harness,harness); assert.equal(changed.value.execution.model,models[harness]);
    const after=(await request('/agent/workspaces/'+id)).value;
    assert.deepEqual(after.tree,richTree(true)); assert.deepEqual(after.records,records); assert.deepEqual(after.interactionState,interactionState);
    assert.deepEqual(after.tree.children[1].plot,first.tree.children[1].plot);
    assert.deepEqual(after.tree.children[2].diagram,first.tree.children[2].diagram);
    assert.deepEqual(calls.map(call=>call.adapter),[harness,harness]);
    assert.equal((await request('/agent/workspaces/'+id,undefined,'GET','bob')).status,404);
    invalid=true;
    const failed=await request('/agent/run',{selectedAppId:id,prompt:'再次改布局'});
    assert.equal(failed.status,502); assert.deepEqual((await request('/agent/workspaces/'+id)).value,after);
    assert.deepEqual(calls.map(call=>call.adapter),[harness,harness,harness],'invalid tree must not retry or silently switch adapter');
    const reopened=createRichWorkspaces(db,{userOf:owner,harnessFor:(req,id)=>settings.forRequest(req,id)});
    assert.deepEqual(reopened.load('alice',id),after,'new runtime reads unchanged persisted tree and interactions');
  });
}
