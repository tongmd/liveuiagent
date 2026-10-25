import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runActionTools } from '../server/liveuiagent.js';

test('explicit AppWorld/MCP write declarations are never pre-executed before grounded execution', async () => {
  const previous = process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
  delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
  try {
    const calls: string[] = [];
    const bridge = { callTool: async (id: string) => { calls.push(id); return { response: { id: 1 } }; } } as any;
    const action = { permissions: ['tool.appworld.todoist.add_task'], steps: [
      { capability: 'tool.appworld.todoist.add_task' },
      { capability: 'tool.mcp.call', toolId: 'tool.appworld.todoist.add_task' },
    ] };
    const result = await runActionTools(action, { task: 'Buy milk' }, bridge);
    assert.deepEqual(result, {}); assert.equal(calls.length, 0);
    // The one grounded executor, not prefetch, owns this write.
    await bridge.callTool('tool.appworld.todoist.add_task', { task: 'Buy milk' });
    assert.deepEqual(calls, ['tool.appworld.todoist.add_task']);
  } finally { if (previous === undefined) delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING; else process.env.LIVEUIAGENT_APPWORLD_GROUNDING = previous; }
});

test('explicit unpermitted AppWorld configuration fails before any business call', async () => {
  let calls = 0;
  await assert.rejects(runActionTools({ permissions: ['llm.call'], steps: [{ capability: 'tool.appworld.todoist.add_task' }] }, {}, { callTool: async () => { calls++; } } as any), /single grounded executor/);
  assert.equal(calls, 0);
});
