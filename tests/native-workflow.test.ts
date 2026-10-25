import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NativeWorkflow, type WorkflowRecord } from '../server/native-workflow.js';

const chain = ['agents.orchestrator', 'agents.action', 'agents.app', 'agents.data', 'agents.memory'];
const specs = Object.fromEntries(chain.map(id => [id, { id, role: id.split('.')[1], purpose: `Execute ${id}` }]));
const edges = chain.slice(1).map((to, i) => ({ from: chain[i], to, payload: 'prior verified context', reason: 'execute next role' }));

test('real HTTP model workers pass role-specific handoffs to subsequent workers and one executor', async () => {
  const requests: any[] = [];
  const records: WorkflowRecord[] = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    const request = JSON.parse(body); requests.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(request.mode === 'review' ? { pass: true, reason: 'observed exact result' } : {
      proceed: true, instructions: `instruction:${request.node.role}`, constraints: ['Do not duplicate the write'], expectedOutcome: 'One saved record',
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const workflow = new NativeWorkflow({ appId: 'a', owner: 'owner-a', actionId: 'save', chain, specs, handoffEdges: edges,
      record: record => records.push(record),
      call: async (node, input, mode) => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ node, input, mode }) })).json() as any,
    });
    const handoffs = await workflow.plan({ originalRequest: { name: 'first' }, permissions: ['db.local.write'] });
    let writes = 0;
    // Exactly one host-owned executor consumes all worker contracts.
    const execute = (contracts: typeof handoffs) => { assert.equal(contracts.length, 5); writes++; return { saved: 'first' }; };
    const outcome = execute(handoffs);
    await workflow.review(outcome);
    assert.equal(writes, 1);
    assert.equal(requests.length, 6);
    for (let index = 0; index < chain.length; index++) {
      assert.equal(requests[index].node.id, chain[index]);
      assert.equal(requests[index].input.upstream.length, index);
      if (index) assert.equal(requests[index].input.upstream[index - 1].instructions, `instruction:${specs[chain[index - 1]].role}`);
    }
    assert.deepEqual(requests[5].input.outcome, { saved: 'first' });
    assert.ok(records.every(record => record.owner === 'owner-a' && record.appId === 'a' && record.executionId === workflow.executionId));
    assert.equal(records.filter(record => record.status === 'ok').length, 6);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('worker rejection interrupts before tools; no downstream worker or business execution', async () => {
  const records: WorkflowRecord[] = []; let calls = 0; let writes = 0;
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r),
    call: async node => { calls++; return node.id === 'agents.action' ? { proceed: false, reason: 'missing target' } : { proceed: true, instructions: 'check target', constraints: [], expectedOutcome: 'known target' }; },
  });
  await assert.rejects(async () => { await workflow.plan({}); writes++; }, /missing target/);
  assert.equal(writes, 0); assert.equal(calls, 2);
  assert.equal(records.at(-1)?.status, 'failed');
});

test('review requires strict boolean true and never reruns business effects', async () => {
  let writes = 1; const records: WorkflowRecord[] = [];
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'send', chain, specs, handoffEdges: edges, record: r => records.push(r), call: async () => ({ pass: 'true', reason: 'not proven' }) });
  await assert.rejects(workflow.review({ realWrites: writes }), /not proven/);
  assert.equal(writes, 1); assert.equal(records.at(-1)?.stage, 'review'); assert.equal(records.at(-1)?.status, 'failed');
});

test('invalid duplicate chain, missing nodes and mismatched edges rejected before workers', () => {
  const base = { appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: () => {}, call: async () => ({}) };
  assert.throws(() => new NativeWorkflow({ ...base, chain: ['agents.orchestrator', 'agents.orchestrator'] }), /chain/);
  assert.throws(() => new NativeWorkflow({ ...base, specs: {} }), /missing agent/);
  assert.throws(() => new NativeWorkflow({ ...base, handoffEdges: edges.toReversed() }), /handoffs/);
});
