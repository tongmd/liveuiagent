import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveToolCapabilities,selectDeclaredAppWorldCapabilities,runActionTools,isWebCapabilityDenied} from '../server/liveuiagent.js';

test('natural-language mentions and negation do not grant an MCP connector',()=>{
 for(const prompt of ['不要外部服务，只保存在应用中','不使用 API 或工具','无需 MCP 插件','Use an API','MCP tool']) {
  const capabilities=deriveToolCapabilities(prompt,[]);
  assert.equal(capabilities.some(c=>c.id==='tool.mcp.call'),false,prompt);
 }
});
test('local planning excludes metadata-only external capabilities; selected services retain exact declared grants',async()=>{
 const capabilities=[{id:'tool.appworld.simple_note.create_note',source:'appworld',appName:'simple_note'},{id:'tool.appworld.todoist.create_task',source:'appworld',appName:'todoist'},{id:'tool.appworld.db.snapshot',source:'appworld',appName:'__meta__'}];
 assert.deepEqual(selectDeclaredAppWorldCapabilities(capabilities,new Set()),[]);
 assert.deepEqual(selectDeclaredAppWorldCapabilities(capabilities,new Set(['simple_note'])).map(c=>c.id),[capabilities[0].id,capabilities[2].id]);
 assert.deepEqual(await runActionTools({permissions:['storage.app','app_state.write'],steps:[{capability:'app_state.write'}]},{}),{});
});

test('explicit browsing prohibition is enforced on derivation and legacy prefetch while ordinary search remains',async()=>{
 for(const prompt of ['不抓网页','不要抓取网页','禁止搜索互联网','无需联网','Do not browse the web']){
  assert.equal(isWebCapabilityDenied(prompt,'tool.web.search'),true,prompt);
  assert.equal(isWebCapabilityDenied(prompt,'tool.web.fetch'),true,prompt);
  assert.equal(deriveToolCapabilities(prompt,[]).some(c=>c.id==='tool.web.search'||c.id==='tool.web.fetch'),false,prompt);
 }
 assert.equal(isWebCapabilityDenied('每天搜索最新RSI论文','tool.web.search'),false);
 assert.equal(deriveToolCapabilities('每天搜索最新RSI论文',[]).some(c=>c.id==='tool.web.search'),true);
 assert.equal(isWebCapabilityDenied('不抓网页','tool.weather.current'),false);
 assert.equal(isWebCapabilityDenied('不抓网页','tool.appworld.simple_note.create_note'),false);
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('Denied browsing must not dispatch');};
 try{assert.deepEqual(await runActionTools({permissions:['tool.web.search'],steps:[{capability:'tool.web.search'}]},{query:'research'},null,'不抓网页'),{});assert.equal(requests,0);
 globalThis.fetch=async()=>{requests++;return new Response('<html><body>No results</body></html>',{status:200});};
 await runActionTools({permissions:['tool.web.search'],steps:[{capability:'tool.web.search'}]},{query:'RSI papers'},null,'每天搜索最新RSI论文');
 assert.equal(requests,1,'ordinary RSI search still dispatches');
 }finally{globalThis.fetch=original;}
});
