import { randomUUID } from 'node:crypto';

export type AgentOperation = 'run' | 'action' | 'patch_app' | 'remove_app' | 'query_state' | 'patch_canvas';
export type AgentLatencyPreference = 'low' | 'balanced' | 'quality' | 'background';
export type AgentLatencyClass = 'realtime' | 'interactive' | 'standard' | 'background';
export type AgentDifficulty = 'trivial' | 'low' | 'medium' | 'high';
export type SchedulerLane = AgentLatencyClass;

export type AgentModelRoute = {
  model: 'scheduler.fast-local' | 'scheduler.balanced-local' | 'scheduler.reasoning-local';
  tier: 'fast' | 'balanced' | 'reasoning';
  estimatedCostUnits: number;
  maxLatencyMs: number;
  reason: string;
};

export type AgentSchedulerRequest<TPayload = unknown> = {
  operation: AgentOperation;
  payload?: TPayload;
  requestId?: string;
  appId?: string;
  windowId?: string;  // unique per open app instance, enables per-window parallelism
  userId?: string;
  sessionId?: string;
  fairnessKey?: string;
  prompt?: string;
  actionId?: string;
  platform?: string;
  latencyPreference?: AgentLatencyPreference;
  deadlineMs?: number;
  priority?: number;
};

export type AgentSchedulerPlan = {
  requestId: string;
  operation: AgentOperation;
  fairnessKey: string;
  lane: SchedulerLane;
  difficulty: AgentDifficulty;
  latencyClass: AgentLatencyClass;
  modelRoute: AgentModelRoute;
};

export type AgentSchedulerMetadata = AgentSchedulerPlan & {
  enqueuedAt: string;
  startedAt: string;
  completedAt: string;
  queueWaitMs: number;
  runMs: number;
  queueDepthAtEnqueue: number;
};

export type AgentExecutionContext = {
  requestId: string;
  plan: AgentSchedulerPlan;
  scheduler: AgentScheduler;
};

type InternalJob<T = unknown> = {
  plan: AgentSchedulerPlan;
  request: Required<Pick<AgentSchedulerRequest, 'operation'>> & AgentSchedulerRequest;
  execute: (context: AgentExecutionContext) => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAtMs: number;
  queueDepthAtEnqueue: number;
};

type QueuedJob = InternalJob<any>;

type LaneState = {
  queues: Map<string, QueuedJob[]>;
  order: string[];
  cursor: number;
};

export type AgentSchedulerOptions = {
  maxConcurrent?: number;
  perFairnessKeyConcurrent?: number;
  agingMs?: number;
  now?: () => number;
};

const lanePriority: SchedulerLane[] = ['realtime', 'interactive', 'standard', 'background'];
const laneRank = new Map(lanePriority.map((lane, index) => [lane, index]));

function textFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  return String(record.prompt || record.message || record.query || '');
}

function appIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  return String(record.appId || record.selectedAppId || record.canvasId || '');
}

function actionIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  return String(record.actionId || '');
}

function classifyDifficulty(operation: AgentOperation, _prompt: string, actionId: string): AgentDifficulty {
  if (operation === 'query_state' || operation === 'patch_canvas') return 'trivial';
  if (operation === 'run' || operation === 'patch_app') return 'high';
  if (operation === 'action') {
    if (/generate|compose|summari[sz]e|analy[sz]e|llm|生成|总结|分析|规划/i.test(actionId)) return 'medium';
    return 'low';
  }
  return 'low';
}

function classifyLatency(
  operation: AgentOperation,
  difficulty: AgentDifficulty,
  preference: AgentLatencyPreference,
  deadlineMs?: number,
): AgentLatencyClass {
  if (preference === 'background') return 'background';
  if (typeof deadlineMs === 'number' && deadlineMs > 0) {
    if (deadlineMs <= 250) return 'realtime';
    if (deadlineMs <= 1200) return 'interactive';
  }
  if (operation === 'query_state' || operation === 'patch_canvas') return 'realtime';
  if (operation === 'action') return 'interactive';
  if (difficulty === 'high' && preference === 'quality') return 'standard';
  return difficulty === 'trivial' || difficulty === 'low' ? 'interactive' : 'standard';
}

function chooseModelRoute(
  operation: AgentOperation,
  difficulty: AgentDifficulty,
  latencyClass: AgentLatencyClass,
  preference: AgentLatencyPreference,
): AgentModelRoute {
  if (difficulty === 'trivial' || (difficulty === 'low' && preference !== 'quality')) {
    return {
      model: 'scheduler.fast-local',
      tier: 'fast',
      estimatedCostUnits: 1,
      maxLatencyMs: latencyClass === 'realtime' ? 120 : 450,
      reason: `${operation} is ${difficulty}; route to low-cost fast lane`,
    };
  }

  if (difficulty === 'high' && preference === 'quality' && latencyClass !== 'realtime') {
    return {
      model: 'scheduler.reasoning-local',
      tier: 'reasoning',
      estimatedCostUnits: 5,
      maxLatencyMs: 4500,
      reason: `${operation} is high difficulty and quality-sensitive; route to reasoning lane`,
    };
  }

  if (difficulty === 'high' && latencyClass === 'standard') {
    return {
      model: 'scheduler.reasoning-local',
      tier: 'reasoning',
      estimatedCostUnits: 5,
      maxLatencyMs: 3800,
      reason: `${operation} requires app planning or patching; route to reasoning lane`,
    };
  }

  return {
    model: 'scheduler.balanced-local',
    tier: 'balanced',
    estimatedCostUnits: 2,
    maxLatencyMs: latencyClass === 'interactive' ? 900 : 1800,
    reason: `${operation} balances latency and planning quality`,
  };
}

function fairnessKeyFor(request: AgentSchedulerRequest) {
  if (request.fairnessKey) return request.fairnessKey;
  // Per-window fairness: each open app window gets independent queue
  if (request.windowId) return `window:${request.windowId}`;
  // Legacy single-app fairness (backward compatible)
  if (request.appId) return `app:${request.appId}`;
  const payloadAppId = appIdFromPayload(request.payload);
  if (request.operation === 'patch_canvas') return `canvas:${payloadAppId || 'home'}`;
  if (payloadAppId) return `app:${payloadAppId}`;
  if (request.sessionId) return `session:${request.sessionId}`;
  if (request.userId) return `user:${request.userId}`;
  return 'whiteboard:default';
}

export function planAgentRequest(input: AgentSchedulerRequest): AgentSchedulerPlan {
  const requestId = input.requestId || `agent_req_${randomUUID().slice(0, 8)}`;
  const prompt = String(input.prompt || textFromPayload(input.payload));
  const actionId = String(input.actionId || actionIdFromPayload(input.payload));
  const preference = input.latencyPreference || (input.operation === 'patch_app' ? 'quality' : 'balanced');
  const difficulty = classifyDifficulty(input.operation, prompt, actionId);
  const latencyClass = classifyLatency(input.operation, difficulty, preference, input.deadlineMs);
  return {
    requestId,
    operation: input.operation,
    fairnessKey: fairnessKeyFor(input),
    lane: latencyClass,
    difficulty,
    latencyClass,
    modelRoute: chooseModelRoute(input.operation, difficulty, latencyClass, preference),
  };
}

function publicSchedulerTrace(metadata: AgentSchedulerMetadata, status: 'ok' | 'rejected' = 'ok') {
  return {
    agent: 'Scheduler Agent',
    role: 'Route unified agent request by latency, difficulty, cost, and fair queue',
    input: {
      requestId: metadata.requestId,
      operation: metadata.operation,
      fairnessKey: metadata.fairnessKey,
      latencyClass: metadata.latencyClass,
      difficulty: metadata.difficulty,
    },
    output: {
      model: metadata.modelRoute.model,
      tier: metadata.modelRoute.tier,
      lane: metadata.lane,
      queueWaitMs: metadata.queueWaitMs,
      runMs: metadata.runMs,
      estimatedCostUnits: metadata.modelRoute.estimatedCostUnits,
    },
    status,
  };
}

function attachSchedulerMetadata<T>(result: T, metadata: AgentSchedulerMetadata): T {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      value: result,
      scheduler: metadata,
      trace: [publicSchedulerTrace(metadata)],
    } as T;
  }
  const record = result as Record<string, unknown>;
  const trace = Array.isArray(record.trace) ? record.trace : [];
  return {
    ...record,
    scheduler: metadata,
    trace: [publicSchedulerTrace(metadata), ...trace],
  } as T;
}

export class AgentScheduler {
  private readonly maxConcurrent: number;
  private readonly perFairnessKeyConcurrent: number;
  private readonly agingMs: number;
  private readonly now: () => number;
  private readonly lanes: Record<SchedulerLane, LaneState>;
  private activeCount = 0;
  private activeByFairnessKey = new Map<string, number>();
  private completedCount = 0;
  private failedCount = 0;
  private totalQueueWaitMs = 0;
  private totalRunMs = 0;
  private routeCounts = new Map<string, number>();

  constructor(options: AgentSchedulerOptions = {}) {
    // LLM 回合是网络等待型,不吃 CPU:并发上限给足,避免几个 2 分钟的
    // grounded 回合把 200ms 的只读查询挡在全局闸门外。
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 8);
    this.perFairnessKeyConcurrent = Math.max(1, options.perFairnessKeyConcurrent ?? 1);
    this.agingMs = Math.max(0, options.agingMs ?? 8_000);
    this.now = options.now ?? Date.now;
    this.lanes = {
      realtime: { queues: new Map(), order: [], cursor: 0 },
      interactive: { queues: new Map(), order: [], cursor: 0 },
      standard: { queues: new Map(), order: [], cursor: 0 },
      background: { queues: new Map(), order: [], cursor: 0 },
    };
  }

  schedule<T>(request: AgentSchedulerRequest, execute: (context: AgentExecutionContext) => Promise<T> | T): Promise<T> {
    const normalizedRequest = {
      ...request,
      operation: request.operation,
      requestId: request.requestId || `agent_req_${randomUUID().slice(0, 8)}`,
    };
    const plan = planAgentRequest(normalizedRequest);

    return new Promise<T>((resolve, reject) => {
      const job: InternalJob<T> = {
        plan,
        request: normalizedRequest,
        execute,
        resolve,
        reject,
        enqueuedAtMs: this.now(),
        queueDepthAtEnqueue: this.pendingCount(),
      };
      this.enqueue(job as QueuedJob);
      this.dispatch();
    });
  }

  snapshot() {
    const pendingByLane = Object.fromEntries(lanePriority.map((lane) => [lane, this.pendingCount(lane)]));
    return {
      active: this.activeCount,
      pending: this.pendingCount(),
      pendingByLane,
      completed: this.completedCount,
      failed: this.failedCount,
      finished: this.completedCount + this.failedCount,
      averageQueueWaitMs: this.completedCount ? Math.round(this.totalQueueWaitMs / this.completedCount) : 0,
      averageRunMs: this.completedCount ? Math.round(this.totalRunMs / this.completedCount) : 0,
      routeCounts: Object.fromEntries(this.routeCounts),
    };
  }

  private enqueue(job: QueuedJob) {
    const lane = this.lanes[job.plan.lane];
    const key = job.plan.fairnessKey;
    const queue = lane.queues.get(key);
    if (queue) {
      queue.push(job);
      return;
    }
    lane.queues.set(key, [job]);
    lane.order.push(key);
  }

  private dispatch() {
    while (this.activeCount < this.maxConcurrent) {
      const job = this.takeNextJob();
      if (!job) return;
      this.start(job);
    }
  }

  private takeNextJob(): QueuedJob | undefined {
    for (const lane of this.orderedLanes()) {
      const job = this.takeFromLane(lane);
      if (job) return job;
    }
    return undefined;
  }

  private orderedLanes(): SchedulerLane[] {
    const now = this.now();
    return [...lanePriority].sort((a, b) => {
      const agedA = this.oldestWaitMs(a, now) >= this.agingMs;
      const agedB = this.oldestWaitMs(b, now) >= this.agingMs;
      if (agedA !== agedB) return agedA ? -1 : 1;
      return (laneRank.get(a) ?? 0) - (laneRank.get(b) ?? 0);
    });
  }

  private oldestWaitMs(lane: SchedulerLane, now: number) {
    let oldest = Infinity;
    for (const queue of this.lanes[lane].queues.values()) {
      if (queue[0]) oldest = Math.min(oldest, queue[0].enqueuedAtMs);
    }
    return oldest === Infinity ? 0 : now - oldest;
  }

  private takeFromLane(laneName: SchedulerLane): QueuedJob | undefined {
    const lane = this.lanes[laneName];
    if (!lane.order.length) return undefined;
    const startCursor = lane.cursor % lane.order.length;

    for (let visited = 0; visited < lane.order.length; visited += 1) {
      const index = (startCursor + visited) % lane.order.length;
      const key = lane.order[index];
      if ((this.activeByFairnessKey.get(key) ?? 0) >= this.perFairnessKeyConcurrent) continue;
      const queue = lane.queues.get(key);
      if (!queue) {
        lane.order.splice(index, 1);
        lane.cursor = lane.order.length ? index % lane.order.length : 0;
        return this.takeFromLane(laneName);
      }
      const job = queue.shift();
      if (!job) {
        lane.queues.delete(key);
        lane.order.splice(index, 1);
        lane.cursor = lane.order.length ? index % lane.order.length : 0;
        return this.takeFromLane(laneName);
      }
      if (!queue.length) {
        lane.queues.delete(key);
        lane.order.splice(index, 1);
        lane.cursor = lane.order.length ? index % lane.order.length : 0;
      } else {
        lane.cursor = (index + 1) % lane.order.length;
      }
      return job;
    }
    return undefined;
  }

  private start(job: QueuedJob) {
    const startedAtMs = this.now();
    const key = job.plan.fairnessKey;
    this.activeCount += 1;
    this.activeByFairnessKey.set(key, (this.activeByFairnessKey.get(key) ?? 0) + 1);
    this.routeCounts.set(job.plan.modelRoute.model, (this.routeCounts.get(job.plan.modelRoute.model) ?? 0) + 1);

    Promise.resolve()
      .then(() => job.execute({
        requestId: job.plan.requestId,
        plan: job.plan,
        scheduler: this,
      }))
      .then((result) => {
        const completedAtMs = this.now();
        const metadata: AgentSchedulerMetadata = {
          ...job.plan,
          enqueuedAt: new Date(job.enqueuedAtMs).toISOString(),
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          queueWaitMs: Math.max(0, startedAtMs - job.enqueuedAtMs),
          runMs: Math.max(0, completedAtMs - startedAtMs),
          queueDepthAtEnqueue: job.queueDepthAtEnqueue,
        };
        this.completedCount += 1;
        this.totalQueueWaitMs += metadata.queueWaitMs;
        this.totalRunMs += metadata.runMs;
        job.resolve(attachSchedulerMetadata(result, metadata));
      })
      .catch((error) => {
        const failedAtMs = this.now();
        const metadata: AgentSchedulerMetadata = {
          ...job.plan,
          enqueuedAt: new Date(job.enqueuedAtMs).toISOString(),
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(failedAtMs).toISOString(),
          queueWaitMs: Math.max(0, startedAtMs - job.enqueuedAtMs),
          runMs: Math.max(0, failedAtMs - startedAtMs),
          queueDepthAtEnqueue: job.queueDepthAtEnqueue,
        };
        this.failedCount += 1;
        (error as Record<string, unknown>).scheduler = metadata;
        (error as Record<string, unknown>).trace = [publicSchedulerTrace(metadata, 'rejected')];
        job.reject(error);
      })
      .finally(() => {
        this.activeCount -= 1;
        const activeForKey = (this.activeByFairnessKey.get(key) ?? 1) - 1;
        if (activeForKey <= 0) this.activeByFairnessKey.delete(key);
        else this.activeByFairnessKey.set(key, activeForKey);
        this.dispatch();
      });
  }

  private pendingCount(laneName?: SchedulerLane) {
    const lanes = laneName ? [laneName] : lanePriority;
    return lanes.reduce((count, lane) => {
      let laneCount = 0;
      for (const queue of this.lanes[lane].queues.values()) laneCount += queue.length;
      return count + laneCount;
    }, 0);
  }
}

type LIVEUIAGENTRuntime = {
  run(input: any): Promise<any>;
  action(input: any): Promise<any>;
  patchCanvas(input: any): Promise<any>;
  patchApp(input: any): Promise<any>;
  removeApp(input: any): Promise<any>;
  queryState(input?: any): Promise<any>;
};

export function createScheduledAgentGateway(runtime: LIVEUIAGENTRuntime, scheduler = new AgentScheduler()) {
  return {
    scheduler,

    run(input: any) {
      return scheduler.schedule({
        operation: 'run',
        payload: input,
        appId: input?.selectedAppId,
        prompt: input?.prompt,
        platform: input?.platform,
        latencyPreference: input?.latencyPreference,
        deadlineMs: input?.deadlineMs,
        userId: input?.userId,
        sessionId: input?.sessionId,
        // 没选中应用时每个 run 独立排队:否则全部 run 挤在 whiteboard:default
        // 一个 fairness 键上(perKey=1),第二个生成必须等第一个跑完。
        ...(input?.selectedAppId ? {} : { fairnessKey: `run:${randomUUID().slice(0, 8)}` }),
      }, () => runtime.run(input));
    },

    action(input: any) {
      return scheduler.schedule({
        operation: 'action',
        payload: input,
        appId: input?.appId,
        windowId: input?.windowId,  // enable per-window parallelism
        actionId: input?.actionId,
        platform: input?.platform,
        latencyPreference: input?.latencyPreference || 'low',
        deadlineMs: input?.deadlineMs,
        userId: input?.userId,
        sessionId: input?.sessionId,
      }, () => runtime.action(input));
    },

    patchCanvas(input: any) {
      return scheduler.schedule({
        operation: 'patch_canvas',
        payload: input,
        fairnessKey: `canvas:${input?.canvasId || 'home'}`,
        latencyPreference: 'low',
        deadlineMs: input?.deadlineMs ?? 200,
      }, () => runtime.patchCanvas(input));
    },

    patchApp(input: any) {
      return scheduler.schedule({
        operation: 'patch_app',
        payload: input,
        appId: input?.appId,
        prompt: input?.prompt,
        latencyPreference: input?.latencyPreference || 'quality',
        deadlineMs: input?.deadlineMs,
      }, () => runtime.patchApp(input));
    },

    removeApp(input: any) {
      return scheduler.schedule({
        operation: 'remove_app',
        payload: input,
        appId: input?.appId,
        latencyPreference: 'low',
        deadlineMs: input?.deadlineMs,
      }, () => runtime.removeApp(input));
    },

    queryState(input: any = {}) {
      return scheduler.schedule({
        operation: 'query_state',
        payload: input,
        // 只读快查询必须有自己的 fairness 键:跟 run 共享 whiteboard:default
        // 会被 2 分钟的生成回合饿死(页面加载拿不到应用列表)。
        fairnessKey: `query:${randomUUID().slice(0, 8)}`,
        latencyPreference: 'low',
        deadlineMs: input?.deadlineMs ?? 200,
      }, () => runtime.queryState(input));
    },

    schedulerState() {
      return scheduler.snapshot();
    },
  };
}
