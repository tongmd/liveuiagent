import {randomUUID} from 'node:crypto';
import { AgentScheduler, createScheduledAgentGateway, planAgentRequest } from '../server/agent-scheduler.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testModelRouting() {
  const queryPlan = planAgentRequest({
    operation: 'query_state',
    payload: {},
    deadlineMs: 120,
  });
  assert(queryPlan.lane === 'realtime', 'query-state should use realtime lane');
  assert(queryPlan.modelRoute.model === 'scheduler.fast-local', 'query-state should use fast model route');
  assert(queryPlan.modelRoute.estimatedCostUnits === 1, 'query-state should be lowest-cost');

  const actionPlan = planAgentRequest({
    operation: 'action',
    payload: { appId: 'agent_app', actionId: 'agent_turn_1.run' },
    appId: 'agent_app',
    actionId: 'agent_turn_1.run',
  });
  assert(actionPlan.lane === 'interactive', 'normal action should use interactive lane');
  assert(actionPlan.modelRoute.model === 'scheduler.fast-local', 'normal action should use fast model route');

  const createPlan = planAgentRequest({
    operation: 'run',
    prompt: '生成一个长期使用的应用，能持续输入内容、刷新页面状态、保留上下文并提醒我下一步',
    latencyPreference: 'quality',
  });
  assert(createPlan.difficulty === 'high', 'complex create prompt should be high difficulty');
  assert(createPlan.modelRoute.model === 'scheduler.reasoning-local', 'complex create should route to reasoning model');
  assert(createPlan.modelRoute.estimatedCostUnits > actionPlan.modelRoute.estimatedCostUnits, 'hard requests should declare higher cost');

  const shortCreatePlan = planAgentRequest({
    operation: 'run',
    prompt: '生成一个可以反复输入内容的小应用',
  });
  assert(shortCreatePlan.modelRoute.model === 'scheduler.reasoning-local', 'short app creation should still route to reasoning model');

  const patchPlan = planAgentRequest({
    operation: 'patch_app',
    payload: { appId: 'agent_app', prompt: '把下一次交互重点改成先收集限制条件再刷新结果' },
    appId: 'agent_app',
    prompt: '把下一次交互重点改成先收集限制条件再刷新结果',
  });
  assert(patchPlan.modelRoute.model === 'scheduler.reasoning-local', 'patch-app should route to reasoning model');
  assert(patchPlan.fairnessKey === 'app:agent_app', 'patch-app should use app fairness key');
}

async function testFairQueue() {
  const scheduler = new AgentScheduler({ maxConcurrent: 1, perFairnessKeyConcurrent: 1 });
  const executionOrder: string[] = [];

  const run = (appId: string, label: string) => scheduler.schedule({
    operation: 'action',
    appId,
    actionId: 'item.update',
    payload: { appId, actionId: 'item.update' },
  }, async () => {
    executionOrder.push(label);
    await wait(5);
    return { label };
  });

  const results = await Promise.all([
    run('a', 'a1'),
    run('a', 'a2'),
    run('a', 'a3'),
    run('b', 'b1'),
  ]);

  assert(executionOrder[0] === 'a1', `first request should execute first, got ${executionOrder.join(',')}`);
  assert(executionOrder[1] === 'a2', `second app-a request should run before app-b arrives in queue order, got ${executionOrder.join(',')}`);
  assert(executionOrder[2] === 'b1', `fair queue should give app-b a turn before app-a drains, got ${executionOrder.join(',')}`);
  assert(executionOrder[3] === 'a3', `app-a tail should run after app-b, got ${executionOrder.join(',')}`);
  assert(results.every((result: any) => result.scheduler?.fairnessKey), 'scheduled results should include scheduler metadata');
  assert(results.every((result: any) => result.trace?.[0]?.agent === 'Scheduler Agent'), 'scheduler trace should be prepended');

  try {
    await scheduler.schedule({
      operation: 'action',
      appId: 'a',
      actionId: 'item.delete',
      payload: { appId: 'a', actionId: 'item.delete' },
    }, async () => {
      const error = new Error('rejected by policy') as Error & { status?: number };
      error.status = 403;
      throw error;
    });
    throw new Error('expected failed scheduled job');
  } catch (error) {
    assert((error as any).scheduler?.operation === 'action', 'failed job should carry scheduler metadata');
    assert((error as any).trace?.[0]?.status === 'rejected', 'failed job should carry rejected scheduler trace');
  }
  assert(scheduler.snapshot().failed === 1, 'scheduler should count failed jobs');
}

async function testGatewayIntegration() {
  const calls: string[] = [];
  const runtime = {
    async run(input: any) {
      calls.push(`run:${input.prompt}`);
      return { type: 'app_created', trace: [] };
    },
    async action(input: any) {
      calls.push(`action:${input.appId}:${input.actionId}`);
      return { messages: ['ok'], trace: [] };
    },
    async patchCanvas(input: any) {
      calls.push(`patchCanvas:${input.nodeId}`);
      return { message: 'node moved', trace: [] };
    },
    async patchApp(input: any) {
      calls.push(`patchApp:${input.appId}`);
      return { type: 'app_patched', trace: [] };
    },
    async queryState() {
      calls.push('queryState');
      return { apps: [], canvasState: { canvasId: 'home' } };
    },
  };

  const gateway = createScheduledAgentGateway(runtime as any, new AgentScheduler({ maxConcurrent: 2 }));
  const [state, action, created, patched, moved] = await Promise.all([
    gateway.queryState({ deadlineMs: 100 }),
    gateway.action({ requestId:randomUUID(),appId: 'agent_app', actionId: 'agent_turn_1.run' }),
    gateway.run({ prompt: '生成一个可以反复输入内容的小应用' }),
    gateway.patchApp({ appId: 'agent_app', prompt: '把交互重点改成收集限制条件' }),
    gateway.patchCanvas({ canvasId: 'home', nodeId: 'node_agent_app', position: { x: 1, y: 2 } }),
  ]);

  assert(calls.includes('queryState'), 'gateway should call runtime.queryState');
  assert(calls.includes('action:agent_app:agent_turn_1.run'), 'gateway should call runtime.action');
  assert(calls.includes('run:生成一个可以反复输入内容的小应用'), 'gateway should call runtime.run');
  assert(calls.includes('patchApp:agent_app'), 'gateway should call runtime.patchApp');
  assert(calls.includes('patchCanvas:node_agent_app'), 'gateway should call runtime.patchCanvas');
  assert((state as any).scheduler.modelRoute.model === 'scheduler.fast-local', 'query-state should carry fast scheduler route');
  assert((action as any).scheduler.fairnessKey === 'app:agent_app', 'action should carry app fairness key');
  assert((created as any).scheduler.operation === 'run', 'run response should carry scheduler metadata');
  assert((patched as any).scheduler.modelRoute.model === 'scheduler.reasoning-local', 'patch-app should carry reasoning route');
  assert((moved as any).scheduler.lane === 'realtime', 'patch-canvas should carry realtime lane');
  assert(gateway.schedulerState().completed === 5, 'scheduler state should count completed gateway jobs');
}

async function main() {
  await testModelRouting();
  await testFairQueue();
  await testGatewayIntegration();
  console.log('agent scheduler ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
