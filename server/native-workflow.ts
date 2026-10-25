import { randomUUID } from 'node:crypto';

export type WorkflowNode = { id: string; role?: string; name?: string; purpose?: string; model?: string; inputs?: unknown; outputs?: unknown; stateReads?: unknown; stateWrites?: unknown };
export type WorkflowRecord = { executionId: string; appId: string; owner: string; actionId: string; stage: string; nodeId: string; status: 'running' | 'ok' | 'failed'; input?: unknown; output?: unknown; at: string; startedAt?: string; finishedAt?: string };
type ModelCall = (node: WorkflowNode, input: Record<string, unknown>, mode: 'plan' | 'review') => Promise<Record<string, unknown>>;

/** Executes model workers as read-only collaborators. Only the host executor may
 * call tools or commit state. A rejected/failed worker never retries business writes. */
export class NativeWorkflow {
  readonly executionId = randomUUID();
  readonly steps: WorkflowRecord[] = [];
  readonly handoffs: Array<{ agentId: string; role: string; instructions: string; constraints: string[]; expectedOutcome: string }> = [];
  private readonly nodes: WorkflowNode[];
  constructor(private readonly options: {
    appId: string; owner: string; actionId: string; chain: string[];
    specs: Record<string, WorkflowNode>; handoffEdges: Array<{ from: string; to: string; payload?: string; reason?: string }>;
    call: ModelCall; record: (entry: WorkflowRecord) => void;
  }) {
    const { chain, specs, handoffEdges } = options;
    if (chain.length < 2 || chain[0] !== 'agents.orchestrator' || new Set(chain).size !== chain.length) throw new Error('invalid native workflow chain');
    this.nodes = chain.map(id => { if (!specs[id]) throw new Error(`native workflow missing agent ${id}`); return { ...specs[id], id }; });
    if (handoffEdges.length !== chain.length - 1 || handoffEdges.some((edge, i) => edge.from !== chain[i] || edge.to !== chain[i + 1])) throw new Error('native workflow handoffs do not match chain');
  }
  record(stage: string, nodeId: string, status: WorkflowRecord['status'], input?: unknown, output?: unknown) {
    const at = new Date().toISOString();
    const prior = [...this.steps].reverse().find(step => step.stage === stage && step.nodeId === nodeId && step.status === 'running');
    const step: WorkflowRecord = { executionId: this.executionId, appId: this.options.appId, owner: this.options.owner, actionId: this.options.actionId,
      stage, nodeId, status, input: input ?? prior?.input, output, at,
      startedAt: status === 'running' ? at : prior?.startedAt, ...(status === 'running' ? {} : { finishedAt: at }) };
    this.options.record(step);
    this.steps.push(step);
  }
  async plan(context: Record<string, unknown>) {
    for (const [index, node] of this.nodes.entries()) {
      const input = { modelInvocationId: randomUUID(), model: node.model, context, upstream: this.handoffs.slice(), incomingHandoff: index ? this.options.handoffEdges[index - 1] : null };
      this.record('plan', node.id, 'running', input);
      try {
        const output = await this.options.call(node, input, 'plan');
        if (output.proceed !== true) throw new Error(`agent ${node.id} rejected: ${String(output.reason || 'no approval')}`);
        if (typeof output.instructions !== 'string' || !output.instructions.trim() || typeof output.expectedOutcome !== 'string' || !output.expectedOutcome.trim() || !Array.isArray(output.constraints) || output.constraints.some(x => typeof x !== 'string')) throw new Error(`agent ${node.id} returned invalid handoff`);
        const handoff = { agentId: node.id, role: String(node.role || node.name || node.id), instructions: output.instructions.slice(0, 2400), constraints: output.constraints.map(x => String(x).slice(0, 500)).slice(0, 12), expectedOutcome: output.expectedOutcome.slice(0, 1200) };
        this.handoffs.push(handoff);
        this.record('plan', node.id, 'ok', undefined, handoff);
      } catch (error) { this.record('plan', node.id, 'failed', undefined, { error: String(error) }); throw error; }
    }
    return this.handoffs;
  }
  async review(outcome: Record<string, unknown>) {
    const node: WorkflowNode = { id: 'agents.result-reviewer', role: 'Independent result verifier', purpose: 'Check actual observed results against the original request and worker contracts. Never infer success from a plan or hide failed tools.' };
    const input = { modelInvocationId: randomUUID(), model: this.nodes[0]?.model, outcome, workerContracts: this.handoffs };
    this.record('review', node.id, 'running', input);
    try {
      const output = await this.options.call(node, input, 'review');
      if (output.pass !== true) throw new Error(`native result review rejected: ${String(output.reason || 'verification did not pass')}`);
      this.record('review', node.id, 'ok', undefined, output);
      return output;
    } catch (error) { this.record('review', node.id, 'failed', undefined, { error: String(error) }); throw error; }
  }
}
