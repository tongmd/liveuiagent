import {factorNativeReviewInput} from './native-review-factor.js';
import { randomUUID } from 'node:crypto';

export type WorkflowNode = { id: string; role?: string; name?: string; purpose?: string; model?: string; inputs?: unknown; outputs?: unknown; stateReads?: unknown; stateWrites?: unknown };
export type WorkflowRecord = { executionId: string; appId: string; owner: string; actionId: string; stage: string; nodeId: string; status: 'running' | 'ok' | 'failed'; input?: unknown; output?: unknown; at: string; startedAt?: string; finishedAt?: string };
/** Host implementation budget, not user intent or an authorization limit. */
export const NATIVE_ROLE_TRANSPORT_LIMITS = Object.freeze({constraintsCount:4,totalHandoffUnicodeCharacters:4096});
/** Compatibility alias for the shared total, not a separate instructions cap. */
export const NATIVE_INSTRUCTIONS_UNICODE_LIMIT = NATIVE_ROLE_TRANSPORT_LIMITS.totalHandoffUnicodeCharacters;
export const nativeRoleTransportPolicy = `Your handoff is a concise role-specific increment for the single host executor: at most ${NATIVE_ROLE_TRANSPORT_LIMITS.constraintsCount} constraints, and instructions plus all constraints plus expectedOutcome together at most ${NATIVE_ROLE_TRANSPORT_LIMITS.totalHandoffUnicodeCharacters} Unicode characters. These are transport limits, not business authorization. Do not copy the original request, upstream contracts, entity lists or entire state into your answer; refer to supplied fields and contribute only what your role adds. The host rejects oversized contracts without truncation.`;

type ModelCall = (node: WorkflowNode, input: Record<string, unknown>, mode: 'plan' | 'review') => Promise<Record<string, unknown>>;

/** Omit only the reserved static graph already supplied through chain/specs.
 * All business state, records and request values remain byte-for-byte intact. */
export function projectNativeRoleContext(context: Record<string, unknown>, stateField: 'currentState' | 'proposedRuntimeState' = 'currentState') {
  const state = context[stateField];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ...context, contextProjection: { version: 1, omittedRuntimeKeys: [], policy: 'Full original request, permissions, action and business data; no truncation' } };
  }
  const projected = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'orchestration'));
  return { ...context, [stateField]: projected, contextProjection: {
    version: 1, stateField, omittedRuntimeKeys: Object.hasOwn(state, 'orchestration') ? ['orchestration'] : [],
    reason: 'Static orchestration graph and worker specs are already consumed by the host graph executor; they are not business state',
    preservedRuntimeKeys: Object.keys(projected),
    policy: 'Full original request, permissions, action, entities, records, history, interaction and all other business fields; no truncation',
  } };
}

function validateRoleContract(output: Record<string, unknown>) {
  const errors: string[] = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['Response must be one JSON object'];
  if (output.proceed !== true) errors.push('proceed must be boolean true for an approved plan; never replace an actual refusal with approval');
  if (typeof output.instructions !== 'string' || !output.instructions.trim()) errors.push('instructions must be a non-empty string');
  if (typeof output.expectedOutcome !== 'string' || !output.expectedOutcome.trim()) errors.push('expectedOutcome must be a non-empty string');
  if (!Array.isArray(output.constraints)) errors.push('constraints must be an array');
  else {
    if (output.constraints.length > NATIVE_ROLE_TRANSPORT_LIMITS.constraintsCount) errors.push(`constraints exceeds ${NATIVE_ROLE_TRANSPORT_LIMITS.constraintsCount} entries (received ${output.constraints.length})`);
    output.constraints.forEach((value, index) => {
      if (typeof value !== 'string') errors.push(`constraints[${index}] must be a string`);
    });
  }
  const strings = [output.instructions, ...(Array.isArray(output.constraints)?output.constraints:[]), output.expectedOutcome];
  const total = strings.reduce<number>((sum,value)=>sum+(typeof value==='string'?Array.from(value).length:0),0);
  if(total>NATIVE_ROLE_TRANSPORT_LIMITS.totalHandoffUnicodeCharacters)errors.push(`handoff strings exceed ${NATIVE_ROLE_TRANSPORT_LIMITS.totalHandoffUnicodeCharacters} aggregate Unicode characters (received ${total})`);
  return errors;
}

function contractValidationError(nodeId: string, errors: string[]) {
  return new Error(`agent ${nodeId} exceeded handoff limits; contract was not truncated; invalid handoff: ${errors.join('; ')}`);
}

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
    const terminal = this.steps.find(step => step.stage === stage && step.nodeId === nodeId && step.status !== 'running');
    if (terminal) return; // A stage has one terminal fact, including fail() followed by catch reporting.
    const at = new Date().toISOString();
    const prior = [...this.steps].reverse().find(step => step.stage === stage && step.nodeId === nodeId && step.status === 'running');
    const step: WorkflowRecord = { executionId: this.executionId, appId: this.options.appId, owner: this.options.owner, actionId: this.options.actionId,
      stage, nodeId, status, input: structuredClone(input ?? prior?.input), output: structuredClone(output), at,
      startedAt: status === 'running' ? at : prior?.startedAt, ...(status === 'running' ? {} : { finishedAt: at }) };
    this.options.record(structuredClone(step));
    this.steps.push(step);
  }
  fail(error: unknown, details: Record<string, unknown> = {}) {
    const pending = this.steps.filter(step => step.status === 'running' && !this.steps.some(next => next.stage === step.stage && next.nodeId === step.nodeId && next.status !== 'running'));
    for (const step of pending) this.record(step.stage, step.nodeId, 'failed', undefined, { error: String(error), ...details });
  }
  async plan(context: Record<string, unknown>) {
    const roleContext = projectNativeRoleContext(context);
    for (const [index, node] of this.nodes.entries()) {
      const input = { modelInvocationId: randomUUID(), model: node.model, context: roleContext, upstream: this.handoffs.slice(), incomingHandoff: index ? this.options.handoffEdges[index - 1] : null };
      this.record('plan', node.id, 'running', input);
      let output: Record<string, unknown> | undefined;
      try {
        output = await this.options.call(node, input, 'plan');
        // An explicit policy or feasibility refusal is final. Repair is only a
        // bounded, read-only schema/length correction, never an approval retry.
        if (output?.proceed !== true) throw new Error(`agent ${node.id} rejected: ${String(output?.reason || 'no strict approval')}`);
        let errors = validateRoleContract(output);
        if (errors.length) {
          const originalError = contractValidationError(node.id, errors);
          this.record('contract_validation', node.id, 'running', input);
          this.record('contract_validation', node.id, 'failed', undefined, { error: originalError.message, validationErrors: errors, invalidOutput: output });
          const repairInput = { ...input, modelInvocationId: randomUUID(), contractRepair: {
            attempt: 1, maxAttempts: 1, validationErrors: errors, previousInvalidOutput: output,
            constraints: { ...NATIVE_ROLE_TRANSPORT_LIMITS },
            instruction: nativeRoleTransportPolicy+' Repair only this same role contract schema/length. Use the complete unchanged original request, permissions, context, role and upstream below. Return concise role-specific incremental instructions, not a copy of upstream. Preserve every safety constraint; do not claim execution, change permissions, erase a refusal or fabricate evidence. If the role should refuse, return proceed:false. This is the only repair attempt; oversized output fails rather than being truncated.',
          } };
          this.record('plan_repair', node.id, 'running', repairInput);
          let repairResponseReceived = false;
          try {
            output = await this.options.call(node, repairInput, 'plan');
            repairResponseReceived = true;
            if (output?.proceed !== true) throw new Error(`agent ${node.id} rejected: ${String(output?.reason || 'no strict approval')}`);
            errors = validateRoleContract(output);
            if (errors.length) throw contractValidationError(node.id, errors);
            this.record('plan_repair', node.id, 'ok', undefined, { repairedOutput: output });
          } catch (error) {
            this.record('plan_repair', node.id, 'failed', undefined, { error: String(error), invalidOutput: repairResponseReceived ? output : undefined, responseReceived: repairResponseReceived });
            throw error;
          }
        }
        const handoff = { agentId: node.id, role: String(node.role || node.name || node.id), instructions: output.instructions as string, constraints: (output.constraints as string[]).map(String), expectedOutcome: output.expectedOutcome as string };
        this.handoffs.push(handoff);
        this.record('plan', node.id, 'ok', undefined, handoff);
      } catch (error) { this.record('plan', node.id, 'failed', undefined, { error: String(error), modelOutput: output }); throw error; }
    }
    return this.handoffs;
  }
  async review(outcome: Record<string, unknown>) {
    const node: WorkflowNode = { id: 'agents.result-reviewer', role: 'Independent result verifier', purpose: 'Check actual observed results against the original request and worker contracts. Never infer success from a plan or hide failed tools.' };
    const projectedOutcome = Object.hasOwn(outcome, 'proposedRuntimeState') ? projectNativeRoleContext(outcome, 'proposedRuntimeState') : outcome;
    const input = { modelInvocationId: randomUUID(), model: this.nodes[0]?.model, outcome: projectedOutcome, workerContracts: this.handoffs };
    this.record('review', node.id, 'running', input);
    try {
      const projection=factorNativeReviewInput(input);
      this.record('review_projection',node.id,'running',projection.receipt);
      this.record('review_projection',node.id,'ok',undefined,projection.receipt);
      const output = await this.options.call(node, projection.input, 'review');
      if (output.pass !== true) throw new Error(`native result review rejected: ${String(output.reason || 'verification did not pass')}`);
      this.record('review', node.id, 'ok', undefined, output);
      return output;
    } catch (error) { this.record('review', node.id, 'failed', undefined, { error: String(error) }); throw error; }
  }
}
