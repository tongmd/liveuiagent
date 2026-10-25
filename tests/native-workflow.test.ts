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

test('failed execution closes all pending timing records without retrying a worker', () => {
  const records: WorkflowRecord[] = [];
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r), call: async () => ({}) });
  workflow.record('execute', 'agents.executor', 'running', { operation: 'write' });
  workflow.fail(new Error('connection lost after write'));
  assert.equal(records.length, 2);
  assert.equal(records[1].status, 'failed');
  assert.ok(records[1].startedAt); assert.ok(records[1].finishedAt);
  assert.deepEqual(records[1].input, { operation: 'write' });
});

test('role projection omits only duplicate static graph and preserves full request and large business state', async () => {
  const originalRequest = { payload: { request: 'original-HEAD-' + '完整请求'.repeat(4000) + '-TAIL', nested: { untouched: 'source' } }, sourceComponentId: 'save-button' };
  const entities = Array.from({ length: 150 }, (_, i) => ({ id: i, name: 'entity-' + i, detail: 'actual-business-' + 'x'.repeat(200) }));
  const context = { originalRequest, permissions: ['real.write'], action: { id: 'save', description: 'full action' },
    currentState: { orchestration: { agents: Array.from({ length: 100 }, () => ({ layout: 'STATIC-DUPLICATE'.repeat(500) })) }, entities,
      history: [{ text: 'all-history-' + 'h'.repeat(10000) }], interaction: { businessFields: [{ name: 'amount', label: 'Actual amount' }] }, customDomainField: { value: 7 } },
    records: { tasks: Array.from({ length: 120 }, (_, i) => ({ id: i, text: 'persisted-' + i })) } };
  const inputs: any[] = [];
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges,
    record: () => {}, call: async (_node, input) => { inputs.push(input); return { proceed: true, instructions: 'Check the actual requested target without repeating supplied data.', constraints: ['Write at most once'], expectedOutcome: 'Verified target saved' }; } });
  await workflow.plan(context);
  for (const input of inputs) {
    assert.deepEqual(input.context.originalRequest, originalRequest);
    assert.deepEqual(input.context.permissions, context.permissions); assert.deepEqual(input.context.action, context.action);
    assert.deepEqual(input.context.currentState.entities, entities); assert.equal(input.context.currentState.entities.length, 150);
    assert.deepEqual(input.context.currentState.history, context.currentState.history);
    assert.deepEqual(input.context.currentState.interaction, context.currentState.interaction);
    assert.deepEqual(input.context.currentState.customDomainField, { value: 7 });
    assert.deepEqual(input.context.records, context.records);
    assert.equal(input.context.currentState.orchestration, undefined);
    assert.deepEqual(input.context.contextProjection.omittedRuntimeKeys, ['orchestration']);
  }
  assert.ok(context.currentState.orchestration, 'projection does not modify stored graph');
});

test('compact role contracts are validated in Unicode characters and never silently truncated', async () => {
  for (const invalid of [ { instructions: '文'.repeat(601) }, { constraints: Array(5).fill('one') }, { constraints: ['文'.repeat(101)] }, { expectedOutcome: '文'.repeat(201) } ]) {
    let calls = 0;
    const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: () => {},
      call: async () => { calls++; return { proceed: true, instructions: 'Act', constraints: [], expectedOutcome: 'Verified', ...invalid }; } });
    await assert.rejects(workflow.plan({ originalRequest: 'untouched' }), /exceeded handoff limits; contract was not truncated/);
    assert.equal(workflow.handoffs.length, 0); assert.equal(calls, 2, 'one bounded schema repair then fail without truncation');
  }
  const exact = { proceed: true, instructions: '💧'.repeat(600), constraints: Array(4).fill('字'.repeat(100)), expectedOutcome: '字'.repeat(200) };
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: () => {}, call: async () => exact });
  const result = await workflow.plan({ originalRequest: 'untouched' });
  assert.equal(result[0].instructions, exact.instructions); assert.deepEqual(result[0].constraints, exact.constraints); assert.equal(result[0].expectedOutcome, exact.expectedOutcome);
});

test('failure cleanup and catch reporting create exactly one terminal event per stage', () => {
  const records: WorkflowRecord[] = [];
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r), call: async () => ({}) });
  workflow.record('turn', 'agents.orchestrator', 'running', { request: 'original' });
  workflow.record('plan', 'agents.action', 'running');
  workflow.record('plan', 'agents.action', 'failed', undefined, { error: 'original model failure' });
  workflow.fail(new Error('original model failure'));
  workflow.record('turn', 'agents.orchestrator', 'failed', undefined, { error: 'catch cleanup' });
  workflow.fail(new Error('repeat cleanup'));
  assert.equal(records.filter(r => r.stage === 'turn' && r.status === 'failed').length, 1);
  assert.equal(records.filter(r => r.stage === 'plan' && r.status === 'failed').length, 1);
  assert.equal(records.at(-1)?.input && (records.at(-1)!.input as any).request, 'original');
});

test('independent reviewer retains complete observed results and staged business state while omitting static graph', async () => {
  let observed: any;
  const outcome = { originalRequest: { text: 'Full original request' }, toolResults: [{ response: { items: Array.from({ length: 80 }, (_, i) => ({ id: i, actual: 'observed' })) } }],
    proposedRecords: Array.from({ length: 90 }, (_, i) => ({ id: i, text: 'saved-' + i })),
    proposedRuntimeState: { orchestration: { staticGraph: 'not-business'.repeat(10000) }, entities: [{ id: 7, name: 'Actual target' }], history: ['full real history'], interaction: { target: 7 } } };
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: () => {}, call: async (_node, input) => { observed = input; return { pass: true, reason: 'Verified observed target' }; } });
  await workflow.review(outcome);
  assert.deepEqual(observed.outcome.originalRequest, outcome.originalRequest);
  assert.deepEqual(observed.outcome.toolResults, outcome.toolResults);
  assert.deepEqual(observed.outcome.proposedRecords, outcome.proposedRecords);
  assert.deepEqual(observed.outcome.proposedRuntimeState.entities, outcome.proposedRuntimeState.entities);
  assert.deepEqual(observed.outcome.proposedRuntimeState.history, outcome.proposedRuntimeState.history);
  assert.deepEqual(observed.outcome.proposedRuntimeState.interaction, outcome.proposedRuntimeState.interaction);
  assert.equal(observed.outcome.proposedRuntimeState.orchestration, undefined);
  assert.ok(outcome.proposedRuntimeState.orchestration);
  assert.equal(observed.outcome.contextProjection.stateField, 'proposedRuntimeState');
});

test('one real HTTP contract repair preserves the full original context and original validation failure', async () => {
  const records: WorkflowRecord[] = []; const requests: any[] = [];
  const originalRequest = { text: 'FULL-BEGIN-' + 'unchanged-request-'.repeat(3000) + '-FULL-END', targetId: 7 };
  const invalidOutput = { proceed: true, instructions: 'x'.repeat(601), constraints: ['Never duplicate a write'], expectedOutcome: 'Verified target' };
  const validOutput = { proceed: true, instructions: 'Use the original targetId and preserve its safety constraints.', constraints: ['Never duplicate a write'], expectedOutcome: 'Verified target' };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(request.node.id === chain[0] && !request.input.contractRepair ? invalidOutput : validOutput));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r),
      call: async (node, input) => (await fetch(`http://127.0.0.1:${(server.address() as any).port}`, { method: 'POST', body: JSON.stringify({ node, input }) })).json() as any });
    const contracts = await workflow.plan({ originalRequest, permissions: ['real.write'], currentState: { entities: [{ id: 7, name: 'Actual target' }], history: ['complete prior history'] } });
    assert.equal(requests.length, chain.length + 1); assert.equal(contracts.length, chain.length);
    assert.equal(requests[1].node.id, requests[0].node.id);
    assert.deepEqual(requests[1].input.context, requests[0].input.context);
    assert.deepEqual(requests[1].input.context.originalRequest, originalRequest);
    assert.deepEqual(requests[1].input.context.permissions, ['real.write']);
    assert.deepEqual(requests[1].input.upstream, requests[0].input.upstream);
    assert.deepEqual(requests[1].input.contractRepair.previousInvalidOutput, invalidOutput);
    assert.notEqual(requests[1].input.modelInvocationId, requests[0].input.modelInvocationId);
    assert.deepEqual(requests[1].input.contractRepair.constraints, { instructionsUnicodeCharacters: 600, constraintsCount: 4, constraintUnicodeCharacters: 100, expectedOutcomeUnicodeCharacters: 200 });
    assert.match(requests[1].input.contractRepair.validationErrors.join(';'), /601/);
    const invalidAudit = records.find(r => r.stage === 'contract_validation' && r.status === 'failed')!;
    assert.deepEqual((invalidAudit.output as any).invalidOutput, invalidOutput);
    assert.match((invalidAudit.output as any).error, /contract was not truncated/);
    assert.equal(records.filter(r => r.stage === 'plan_repair' && r.status === 'ok').length, 1);
    assert.equal(contracts[0].instructions, validOutput.instructions);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('two invalid plan contracts fail after exactly one read-only repair and no business execution', async () => {
  let calls = 0, businessWrites = 0; const records: WorkflowRecord[] = [];
  const invalidOutput = { proceed: true, instructions: 'x'.repeat(601), constraints: [], expectedOutcome: 'Target' };
  const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r), call: async () => { calls++; return invalidOutput; } });
  await assert.rejects(async () => { await workflow.plan({ originalRequest: 'Write once' }); businessWrites++; }, /contract was not truncated/);
  assert.equal(calls, 2); assert.equal(businessWrites, 0); assert.equal(workflow.handoffs.length, 0);
  assert.equal(records.filter(r => r.stage === 'contract_validation' && r.status === 'failed').length, 1);
  assert.equal(records.filter(r => r.stage === 'plan_repair' && r.status === 'failed').length, 1);
  assert.equal(records.filter(r => r.stage === 'plan' && r.status === 'failed').length, 1);
});

test('explicit refusal, transport failure and independent review rejection are never repaired', async () => {
  for (const scenario of ['refusal', 'transport', 'review']) {
    let calls = 0; const records: WorkflowRecord[] = [];
    const workflow = new NativeWorkflow({ appId: 'a', owner: 'one', actionId: 'save', chain, specs, handoffEdges: edges, record: r => records.push(r), call: async () => {
      calls++; if (scenario === 'transport') throw new Error('Transport unavailable');
      return scenario === 'review' ? { pass: false, reason: 'Missing actual evidence' } : { proceed: false, reason: 'No permission', instructions: 'x'.repeat(601) };
    } });
    await assert.rejects(scenario === 'review' ? workflow.review({ toolResults: [] }) : workflow.plan({ originalRequest: 'Write once' }), /No permission|Transport unavailable|Missing actual evidence/);
    assert.equal(calls, 1); assert.equal(records.filter(r => r.stage === 'plan_repair').length, 0);
  }
});
