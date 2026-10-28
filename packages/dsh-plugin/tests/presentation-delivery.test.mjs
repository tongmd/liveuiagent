import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationContractForRequest,validatePresentationContract} from '../presentation-contract.mjs';
import {validateBrowserDelivery} from '../browser-delivery.mjs';
const contract={protocol:'liveui-tree-v1',components:['Scene3D']};
test('only explicit positive dynamic 3D user requests activate the host contract',()=>{
 for(const q of ['根据我的描述动态生成可渲染的3D场景','请动态生成三维交互界面','Dynamically generate an interactive 3D scene'])assert.deepEqual(presentationContractForRequest(q),contract);
 for(const q of ['做一个阅读清单','介绍3D打印的发展','不要动态3D，只需要列表','不需要三维场景','Create a static 3D printer checklist'])assert.equal(presentationContractForRequest(q),undefined);
 assert.deepEqual(presentationContractForRequest('把按钮改成蓝色',['动态生成可旋转三维结构']),contract);
 assert.deepEqual(presentationContractForRequest('不要普通卡片，动态生成可旋转的3D空间'),contract);
 assert.deepEqual(presentationContractForRequest('不用二维投影，动态生成可旋转的3D空间'),contract);
 assert.equal(presentationContractForRequest('把按钮改成蓝色',['动态生成可旋转三维结构','移除三维场景']),undefined);
 assert.equal(presentationContractForRequest('不需要动态生成界面',['动态生成可旋转三维结构']),undefined);
 assert.equal(presentationContractForRequest('移除三维场景',['动态生成可旋转三维结构']),undefined);
 assert.throws(()=>validatePresentationContract({protocol:'fake',components:['Scene3D']}));
});
const html=code=>`<!doctype html><html lang="zh"><head><meta name="liveui-ui-protocol" content="liveui-tree-v1"></head><body><textarea data-liveui-ui-request>new geometry</textarea><button data-liveui-action="ui.generate">生成</button><main id="view"></main><script>${code}</script></body></html>`;
const correct=`const ui=window.liveuiagent.ui;document.querySelector('button').onclick=async()=>{try{await ui.generate(document.querySelector('#view'),document.querySelector('textarea').value,{storageKey:'tree',getRecords:()=>[]});}catch(e){document.querySelector('#view').textContent=e.message;}};`;
test('actual maintained UI generation renders two controlled WebGL trees through visible controls',async()=>{const result=await validateBrowserDelivery(html(correct),{presentationContract:contract,settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation.generationCalls,2);assert.equal(result.presentation.realProviderCalls,0);assert.equal(result.presentation.variants.length,2);});
test('custom 2D or a Scene3D label cannot masquerade as maintained generated 3D',async()=>{const code=`document.querySelector('button').onclick=()=>{document.querySelector('#view').innerHTML='<canvas width="300" height="200"></canvas>Scene3D';document.querySelector('canvas').getContext('2d').fillRect(10,10,100,100);};`;const result=await validateBrowserDelivery(html(code),{presentationContract:contract,settleMs:30});assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.code==='browser_presentation_contract'),JSON.stringify(result));});
test('the same ordinary static app is not forced through a generative 3D contract',async()=>{const result=await validateBrowserDelivery('<html><body><p>Reading list</p><button>Add</button></body></html>',{settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation,undefined);});

test('host-derived contract enters the existing sole repair instead of publishing a fake 3D app',async t=>{
 const {createLiveUIAgentRuntime}=await import('../runtime.mjs');const {createServer}=await import('node:http');const fs=await import('node:fs/promises');const path=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await fs.mkdtemp(path.join(tmpdir(),'liveui-presentation-'));let calls=0;
 const runtime=await createLiveUIAgentRuntime({basePath:'/fixture',dataDir:dir,frontendDir:path.resolve('packages/dsh-plugin/public'),owner:'fixture',model:'fixture',runner:{async run({work,onEvent,task}){calls++;onEvent({type:'tool_call',name:'write_file'});if(calls===2)assert.match(task,/browser_presentation_contract/);const code=calls===1?"document.querySelector('button').onclick=()=>{document.querySelector('#view').textContent='Scene3D';};":correct;await fs.writeFile(path.join(work,'index.html'),html(code)+' '.repeat(1100));await fs.writeFile(path.join(work,'app.json'),'{"name":"空间实验台"}');return{};}}});
 const server=createServer(runtime.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await runtime.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/fixture/api/';const response=await fetch(base+'generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'根据我的描述动态生成可旋转的三维界面',context:{presentationContract:null}})});assert.equal(response.status,202);const initial=await response.json();let job;
 for(let i=0;i<1800;i++){job=await(await fetch(base+'jobs/'+initial.id)).json();if(['done','error'].includes(job.status))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(job.status,'done',JSON.stringify(job));assert.equal(calls,2);await runtime.dispose();const accounts=await fs.readdir(path.join(dir,'accounts'));const stored=JSON.parse(await fs.readFile(path.join(dir,'accounts',accounts[0],'state.json'),'utf8')).jobs.find(j=>j.id===initial.id);assert.equal(stored.repairAttempts,1);assert.equal(stored.browserValidation.presentation.generationCalls,2);assert.equal(stored.browserValidationAttempts[0].ok,false);
});
