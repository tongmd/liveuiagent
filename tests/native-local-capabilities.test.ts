import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveToolCapabilities,selectDeclaredAppWorldCapabilities,runActionTools} from '../server/liveuiagent.js';

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
