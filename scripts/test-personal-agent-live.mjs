// Explicit real-provider acceptance test. Creates apps and preferences in a dedicated test account.
// LIVEUI_TEST_BASE_URL=http://127.0.0.1:8787 LIVEUI_TEST_OWNER=qa-account 
// LIVEUI_TEST_REAL_MODELS=1 node scripts/test-personal-agent-live.mjs
import assert from 'node:assert/strict';
if(process.env.LIVEUI_TEST_REAL_MODELS!=='1')throw Error('Set LIVEUI_TEST_REAL_MODELS=1 to allow real model calls.');
const base=String(process.env.LIVEUI_TEST_BASE_URL||'').replace(/\/$/,''),owner=process.env.LIVEUI_TEST_OWNER,results=[];
if(!base||!owner)throw Error('Set a test base URL and dedicated authenticated test owner.');
const harnesses=(process.env.LIVEUI_TEST_HARNESSES||'native,dsh,qwen,kimi,zcode,codex').split(',');
async function api(route,body,method=body?'POST':'GET'){const response=await fetch(base+route,{method,headers:{'content-type':'application/json','x-liveuiagent-user':owner},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(240000)});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'HTTP '+response.status),{code:data.code});return data;}
async function wait(id){for(let i=0;i<250;i++){const job=await api('/agent/workspaces/jobs/'+id);if(job.status==='done')return job;if(job.status==='error')throw Object.assign(Error(job.error),{code:job.code});await new Promise(r=>setTimeout(r,1000));}throw Error('job deadline');}
function scene(tree){if(tree?.type==='Scene3D')return tree.scene;for(const c of tree?.children||[]){const s=scene(c);if(s)return s;}}
const availability=await api('/agent/runtime-settings');console.log(JSON.stringify({choices:availability.choices.map(c=>({id:c.id,available:c.available}))}));
const originalSettings=await api('/agent/settings');
try {
for(const harness of harnesses){
 const began=Date.now(),result={harness,ok:false};
 try{
  if(harness==='native'&&process.env.LIVEUI_TEST_NATIVE_MODEL)await api('/agent/settings',{model:process.env.LIVEUI_TEST_NATIVE_MODEL},'PUT');const selected=await api('/agent/runtime-settings',{harness},'PATCH');result.model=selected.model.id;
  const prompt=`创建一个三维房间布局应用，名称为验收-${harness}。只展示一个蓝色书桌，物体id固定为desk，shape为box，position为[0,0,0]，scale为[2,1,1]，color为#2255cc。我的长期习惯是空间规划页面用大字号和简洁布局，请记住。`;
  const created=await api('/agent/workspaces/create',{prompt,clientRequestId:'verify-'+harness+'-'+Date.now()});const first=await wait(created.id);result.appId=first.appId;result.memory=first.contextualMemory;assert.equal(first.execution.harness,harness);
  const before=await api('/agent/workspaces/'+first.appId);const desk=scene(before.tree)?.objects.find(o=>o.id==='desk');assert.ok(desk,'expected desk');
  await api('/agent/workspaces/'+first.appId+'/state',{expectedVersion:before.version,interactionState:{richState:{scene:{yaw:0.8}},checked:{}}},'PUT');
  // Changing the new-app default must not alter this existing application's engine.
  await api('/agent/runtime-settings',{harness:harness==='qwen'?'kimi':'qwen'},'PATCH');
  const edit=await api('/agent/workspaces/'+first.appId+'/generate',{prompt:'把desk书桌改为红色#bb3322，位置改为[3,0,0]，其他属性完全保留。这次用正常字号即可，不要修改我长期的大字号偏好。',expectedVersion:before.version+1,clientRequestId:'edit-'+harness+'-'+Date.now()});const second=await wait(edit.id);assert.equal(second.execution.harness,harness);
  const after=await api('/agent/workspaces/'+first.appId);const changed=scene(after.tree)?.objects.find(o=>o.id==='desk');assert.equal(changed.color.toLowerCase(),'#bb3322');assert.deepEqual(changed.position,[3,0,0]);assert.deepEqual(changed.scale,desk.scale);assert.deepEqual(after.interactionState.richState,{scene:{yaw:0.8}});assert.equal(after.app.id,before.app.id);assert.deepEqual(after.records,before.records);
  const reopened=await api('/agent/workspaces/'+first.appId);assert.deepEqual(reopened,after);result.ok=true;result.version=after.version;result.changed={color:changed.color,position:changed.position};
 }catch(e){result.code=e.code;result.error=e.message;}
 result.elapsedMs=Date.now()-began;results.push(result);console.log(JSON.stringify(result));
}
} finally {
 await api('/agent/runtime-settings',{harness:availability.harness},'PATCH');
 if(originalSettings.effective?.model)await api('/agent/settings',{model:originalSettings.effective.model},'PUT');
}
console.log(JSON.stringify({passed:results.every(r=>r.ok),results},null,2));
if(results.some(r=>!r.ok))process.exitCode=1;
