import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationContractForRequest,validatePresentationContract} from '../presentation-contract.mjs';
import {validateBrowserDelivery} from '../browser-delivery.mjs';
import {validateVerificationInput} from '../delivery.mjs';
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
test('explicit dynamic UI supports generic trees, plots, diagrams and most recent requirements',()=>{
 const expected=(...components)=>({protocol:'liveui-tree-v1',components});
 for(const q of ['每次交互后重新生成界面','根据用户需求实时组织页面','Regenerate the UI on each interaction','Dynamically update the UI','A live evolving UI'])assert.deepEqual(presentationContractForRequest(q),expected(),q);
 assert.deepEqual(presentationContractForRequest('动态生成折线图和流程图'),expected('Plot','Diagram'));
 assert.deepEqual(presentationContractForRequest('Dynamically generate charts and a diagram'),expected('Plot','Diagram'));
 assert.deepEqual(presentationContractForRequest('不要3D，动态生成图表'),expected('Plot'));
 assert.deepEqual(presentationContractForRequest('不要流程图，动态生成三维空间'),expected('Scene3D'));
 assert.deepEqual(presentationContractForRequest('移除3D',['动态生成3D空间和图表']),expected('Plot'));
 assert.deepEqual(presentationContractForRequest('现在只需要图表',['动态生成3D空间']),expected('Plot'));
 assert.deepEqual(presentationContractForRequest('Only use Diagram',['动态生成3D空间和图表']),expected('Diagram'));
 assert.deepEqual(presentationContractForRequest('改成动态生成普通界面',['动态生成3D空间']),expected());
 assert.equal(presentationContractForRequest('改按钮颜色',['动态生成图表','不需要动态生成界面']),undefined);
 assert.equal(presentationContractForRequest('Disable dynamic UI',['动态生成图表']),undefined);
 assert.equal(presentationContractForRequest('No UI regeneration',['动态生成图表']),undefined);
 assert.equal(presentationContractForRequest('Stop generating UI',['动态生成图表']),undefined);
 assert.equal(presentationContractForRequest('不再生成界面',['动态生成图表']),undefined);
 assert.deepEqual(presentationContractForRequest('重新动态生成Diagram',['动态生成图表','不要动态生成界面']),expected('Diagram'));
 assert.deepEqual(presentationContractForRequest('不要图表，动态生成界面',['动态生成图表']),expected());
 assert.deepEqual(presentationContractForRequest('保持颜色',[{prompt:'动态生成图表和流程图'},{prompt:'移除流程图'}]),expected('Plot'));
 assert.deepEqual(presentationContractForRequest('解释Plot的含义',['动态生成界面']),expected());
 assert.deepEqual(presentationContractForRequest('图表随滑块实时更新',['动态生成3D空间']),expected('Scene3D'));
 for(const q of ['做一个记账App，展示统计图表','图表随滑块实时更新','解释流程图的含义','介绍动态生成三维场景的原理','Explain dynamically generated UI','Create a static chart','A dynamic pricing calculator'])assert.equal(presentationContractForRequest(q),undefined,q);
 for(const c of [[],['Plot'],['Diagram'],['Scene3D','Plot','Diagram']])assert.deepEqual(validatePresentationContract(expected(...c)),expected(...c));
 for(const c of [['Plot','Plot'],['Canvas'],['Scene3D','Plot','Diagram','Plot']])assert.throws(()=>validatePresentationContract(expected(...c)));
 assert.throws(()=>validatePresentationContract({protocol:'liveui-tree-v1',components:Array(1)}));
 assert.throws(()=>validatePresentationContract({...expected(),other:true}));
});
const html=code=>`<!doctype html><html lang="zh"><head><meta name="liveui-ui-protocol" content="liveui-tree-v1"></head><body><textarea data-liveui-ui-request>new layout</textarea><button data-liveui-action="ui.generate">生成</button><p id="status"></p><main id="view"></main><script>${code}</script></body></html>`;
const correct=`const ui=window.liveuiagent.ui;const saved=ui.read('tree');if(saved)ui.render(document.querySelector('#view'),saved.tree,{records:[]});document.querySelector('button').onclick=async()=>{try{await ui.generate(document.querySelector('#view'),document.querySelector('textarea').value,{storageKey:'tree',getRecords:()=>[]});}catch(e){document.querySelector('#status').textContent=e.message;}};`;
const uploadFirst=`const sdk=window.liveuiagent,ui=sdk.ui;let records=JSON.parse(sdk.storage.getItem('records')||'[]');const saved=ui.read('tree');if(saved)ui.render(document.querySelector('#view'),saved.tree,{records});document.querySelector('input[type=file]').onchange=async e=>{records=[{id:'uploaded-source',text:await e.target.files[0].text()}];await sdk.save('records',JSON.stringify(records));document.querySelector('#status').textContent='Source imported';};document.querySelector('button').onclick=async()=>{if(!records.length){document.querySelector('#status').textContent='Upload source material first';return;}try{await ui.generate(document.querySelector('#view'),document.querySelector('textarea').value,{storageKey:'tree',getRecords:()=>records});}catch(e){document.querySelector('#status').textContent=e.message;}};`;
const uploadHtml=(extension='.txt')=>html(uploadFirst).replace('<textarea',`<label for="source">Import source<input type="file" id="source" accept="${extension}" hidden></label><textarea`).replace('<p id="status">','<p id="status" role="status">');
test('synthetic verification input accepts only bounded local text or CSV metadata',()=>{
 for(const filename of ['notes.txt','comparison.csv'])assert.deepEqual(validateVerificationInput({filename,content:'synthetic test input'}),{filename,content:'synthetic test input'});
 for(const value of [{filename:'../notes.txt',content:'x'},{filename:'notes.json',content:'x'},{filename:'notes.txt',content:''},{filename:'notes.txt',content:'中'.repeat(6000)},{filename:'notes.txt',content:'x',selector:'#file'},[],null])assert.throws(()=>validateVerificationInput(value));
});
test('upload-first generated apps receive actual chooser input and restore the imported source',async()=>{
 const presentationContract={protocol:'liveui-tree-v1',components:['Diagram']};
 const blocked=await validateBrowserDelivery(uploadHtml(),{presentationContract,settleMs:30});
 assert.equal(blocked.ok,false);assert.ok(blocked.errors.some(e=>e.message.includes('did not invoke ui.generate')&&e.message.includes('Upload source material first')),JSON.stringify(blocked));
 for(const [extension,content] of [['.txt','Synthetic research note\nControlled input, not user data.'],['.csv','name,value\nControl A,2\nControl B,5']]){
  const filename='verification'+extension;
  const result=await validateBrowserDelivery(uploadHtml(extension),{presentationContract,verificationInput:{filename,content},settleMs:30});
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.verificationInput,{synthetic:true,uploaded:true,method:'file-chooser',filename,bytes:Buffer.byteLength(content)});assert.ok(result.presentation.variants.every(v=>v.content.includes(content)));assert.equal(result.presentation.restoredInFreshFrame,true);
 }
});
test('a verification fixture cannot select an absent or incompatible file input',async()=>{
 const result=await validateBrowserDelivery(uploadHtml('.txt'),{presentationContract:{protocol:'liveui-tree-v1',components:[]},verificationInput:{filename:'verification.csv',content:'name,value\nA,1'},settleMs:30});
 assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.message.includes('exactly one enabled file input')),JSON.stringify(result));assert.equal(result.verificationInput,undefined);
});
test('the maintained workspace uses the same actual generation, chooser and fresh-restore gate',async()=>{
 const code=`const workspace=window.liveuiagent.ui.workspace({container:document.querySelector('#view'),requestInput:document.querySelector('textarea'),generateButton:document.querySelector('button'),status:document.querySelector('#status'),storagePrefix:'protocol-workspace'});document.querySelector('input[type=file]').onchange=async e=>{await workspace.setRecords([{id:'workspace-input',text:await e.target.files[0].text()}]);};`;
 const page=html(code).replace('<textarea','<label for="workspace-source">Import source<input type="file" id="workspace-source" accept=".txt" hidden></label><textarea');
 const result=await validateBrowserDelivery(page,{presentationContract:{protocol:'liveui-tree-v1',components:['Plot','Diagram']},verificationInput:{filename:'verification.txt',content:'Synthetic workspace source'},settleMs:30});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation.generationCalls,3);assert.equal(result.presentation.successfulGenerations,2);assert.equal(result.presentation.restoredInFreshFrame,true);assert.ok(result.presentation.variants.every(v=>v.content.includes('Synthetic workspace source')));
});
test('actual maintained UI generation renders controlled WebGL trees and survives failure and reopening',async()=>{const result=await validateBrowserDelivery(html(correct),{presentationContract:contract,settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation.generationCalls,3);assert.equal(result.presentation.successfulGenerations,2);assert.equal(result.presentation.failedGenerations,1);assert.equal(result.presentation.realProviderCalls,0);assert.equal(result.presentation.variants.length,2);assert.equal(result.presentation.preservedViewOnError,true);assert.equal(result.presentation.restoredInFreshFrame,true);assert.ok(result.presentation.variants.every(v=>v.components[0].renderer==='webgl'&&v.components[0].pixelsChanged>100));});
test('generic dynamic UI renders structurally different trees with acknowledged saves',async()=>{const result=await validateBrowserDelivery(html(correct),{presentationContract:{protocol:'liveui-tree-v1',components:[]},settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation.storageAcknowledgements,true);assert.equal(result.presentation.structureChanged,true);assert.equal(result.presentation.contentChanged,true);assert.notEqual(result.presentation.variants[0].structure,result.presentation.variants[1].structure);});
test('Plot and Diagram contracts render actual changing SVG data and interactive nodes',async()=>{const result=await validateBrowserDelivery(html(correct),{presentationContract:{protocol:'liveui-tree-v1',components:['Plot','Diagram']},settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.presentation.variants[0].components.map(v=>v.renderer),['svg','svg']);assert.ok(result.presentation.variants.every(v=>v.components.every(c=>c.pixelsChanged>100)));});
test('all requested rich components coexist in both generated layouts and reopening',async()=>{const result=await validateBrowserDelivery(html(correct),{presentationContract:{protocol:'liveui-tree-v1',components:['Scene3D','Plot','Diagram']},settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.presentation.variants.every(v=>v.components.length===3));assert.equal(result.presentation.restoredInFreshFrame,true);});
test('original records remain in both new structures, after failure and on reopening',async()=>{const code=correct.replace('const ui=window.liveuiagent.ui;',"const ui=window.liveuiagent.ui;const records=[{id:'source-record',text:'Original user content remains '+String.fromCharCode(60)+'/script>'+String.fromCharCode(60)+'script>throw Error(12345)'+String.fromCharCode(60)+'/script>'}];").replace('{records:[]}','{records}').replace('getRecords:()=>[]','getRecords:()=>records');const result=await validateBrowserDelivery(html(code),{presentationContract:{protocol:'liveui-tree-v1',components:[]},settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.presentation.variants.every(v=>v.content.includes('Original user content remains')));assert.equal(result.presentation.preservedViewOnError,true);assert.equal(result.presentation.restoredInFreshFrame,true);});
test('a generated-view error replacement fails even though both successful trees render',async()=>{const code=correct.replace("document.querySelector('#status').textContent=e.message","document.querySelector('#view').textContent=e.message");const result=await validateBrowserDelivery(html(code),{presentationContract:{protocol:'liveui-tree-v1',components:[]},settleMs:30});assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.code==='browser_presentation_contract'),JSON.stringify(result));});
test('generating correctly without restoring the saved tree reports the fresh-frame phase',async()=>{
 const code=correct.replace("const saved=ui.read('tree');if(saved)ui.render(document.querySelector('#view'),saved.tree,{records:[]});",'');
 const result=await validateBrowserDelivery(html(code),{presentationContract:{protocol:'liveui-tree-v1',components:[]},settleMs:30});
 assert.equal(result.ok,false);const error=result.errors.find(e=>e.code==='browser_presentation_contract');assert.ok(error,JSON.stringify(result));assert.equal(error.details.phase,'fresh-frame-restore');assert.equal(error.details.renderCount,0);assert.equal(error.details.expectedMarkerPresent,false);assert.deepEqual(error.details.savedTreeKeys,['tree']);assert.match(error.message,/Reopening did not display the last acknowledged generated tree/);
});
test('startup local repaint is rejected with saved-versus-visible tree evidence',async()=>{
 const code=`const ui=window.liveuiagent.ui;ui.workspace({container:document.querySelector('#view'),requestInput:document.querySelector('textarea'),generateButton:document.querySelector('button'),status:document.querySelector('#status'),storagePrefix:'protocol-workspace'});ui.render(document.querySelector('#view'),{type:'Text',text:'Local default replaced the restored tree'},{records:[]});`;
 const result=await validateBrowserDelivery(html(code),{presentationContract:{protocol:'liveui-tree-v1',components:['Diagram']},settleMs:50});
 assert.equal(result.ok,false);const error=result.errors.find(e=>e.code==='browser_presentation_contract');assert.ok(error,JSON.stringify(result));assert.equal(error.details.phase,'fresh-frame-restore');assert.equal(error.details.hostGenerationCalls,3);assert.ok(error.details.renderCount>=1);assert.equal(error.details.expectedMarkerPresent,false);assert.ok(error.details.savedTreeKeys.includes('protocol-workspace:layout:v1'));assert.match(error.message,/Visible status:/);assert.ok(error.details.renderedText.includes('Local default replaced'));
});
test('a swallowed generation error reports its failed phase and actual visible status',async()=>{
 const code=correct.replace("document.querySelector('#status').textContent=e.message","document.querySelector('#status').textContent='Please retry this request'");
 const page=html(code).replace('<p id="status">','<p id="status" role="status">');
 const result=await validateBrowserDelivery(page,{presentationContract:{protocol:'liveui-tree-v1',components:[]},settleMs:30});
 assert.equal(result.ok,false);const error=result.errors.find(e=>e.code==='browser_presentation_contract');assert.ok(error,JSON.stringify(result));assert.equal(error.details.phase,'failure-message');assert.equal(error.details.expectedMarkerPresent,true);assert.equal(error.details.status,'Please retry this request');assert.match(error.message,/failed generation did not display the actual host error/);assert.match(error.message,/Please retry this request/);
});
test('custom 2D or a Scene3D label cannot masquerade as maintained generated 3D',async()=>{const code=`document.querySelector('button').onclick=()=>{document.querySelector('#view').innerHTML='<canvas width="300" height="200"></canvas>Scene3D';document.querySelector('canvas').getContext('2d').fillRect(10,10,100,100);};`;const result=await validateBrowserDelivery(html(code),{presentationContract:contract,settleMs:30});assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.code==='browser_presentation_contract'),JSON.stringify(result));});
test('the same ordinary static app is not forced through a generative 3D contract',async()=>{const result=await validateBrowserDelivery('<html><body><p>Reading list</p><button>Add</button></body></html>',{settleMs:30});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.presentation,undefined);});

test('host-derived contract enters the existing sole repair instead of publishing a fake 3D app',async t=>{
 const {createLiveUIAgentRuntime}=await import('../runtime.mjs');const {createServer}=await import('node:http');const fs=await import('node:fs/promises');const path=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await fs.mkdtemp(path.join(tmpdir(),'liveui-presentation-'));let calls=0;
 const runtime=await createLiveUIAgentRuntime({basePath:'/fixture',dataDir:dir,frontendDir:path.resolve('packages/dsh-plugin/public'),owner:'fixture',model:'fixture',runner:{async run({work,onEvent,task}){calls++;onEvent({type:'tool_call',name:'write_file'});if(calls===2){assert.match(task,/browser_presentation_contract/);assert.match(task,/"phase":"variant-1-render"/);}const document=calls===1?html("document.querySelector('button').onclick=()=>{document.querySelector('#view').textContent='Scene3D';};"):uploadHtml();await fs.writeFile(path.join(work,'index.html'),document+' '.repeat(1100));await fs.writeFile(path.join(work,'app.json'),JSON.stringify({name:'空间实验台',...(calls===2?{verificationInput:{filename:'verification.txt',content:'Synthetic spatial source'}}:{})}));return{};}}});
 const server=createServer(runtime.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await runtime.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/fixture/api/';const response=await fetch(base+'generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'根据我的描述动态生成可旋转的三维界面',context:{presentationContract:null}})});assert.equal(response.status,202);const initial=await response.json();let job;
 for(let i=0;i<1800;i++){job=await(await fetch(base+'jobs/'+initial.id)).json();if(['done','error'].includes(job.status))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(job.status,'done',JSON.stringify(job));assert.equal(calls,2);await runtime.dispose();const accounts=await fs.readdir(path.join(dir,'accounts'));const stored=JSON.parse(await fs.readFile(path.join(dir,'accounts',accounts[0],'state.json'),'utf8')).jobs.find(j=>j.id===initial.id);assert.equal(stored.repairAttempts,1);assert.equal(stored.browserValidation.presentation.generationCalls,3);assert.equal(stored.browserValidation.presentation.successfulGenerations,2);assert.equal(stored.browserValidation.verificationInput.uploaded,true);assert.equal(stored.browserValidationAttempts[0].ok,false);
});
