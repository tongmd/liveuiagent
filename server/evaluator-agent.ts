import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { LlmRuntimeConfig } from './liveuiagent.js';

type EvaluatorAction =
  | { kind: 'fill'; target: string; value: string; rationale?: string }
  | { kind: 'click'; target: string; rationale?: string }
  | { kind: 'wait'; milliseconds: number; rationale?: string }
  | { kind: 'reopen'; rationale?: string }
  | { kind: 'observe'; rationale?: string };

type EvaluatorDecision = {
  done: boolean;
  action?: EvaluatorAction;
  rationale: string;
  progress: string;
  checks: string[];
  failure?: string;
};

type EvaluatorPlan = {
  intent: string;
  steps: EvaluatorAction[];
  checks: string[];
  mode?: 'online' | 'planned';
  decisions?: Array<{
    stepIndex: number;
    done: boolean;
    rationale: string;
    progress: string;
    action?: EvaluatorAction;
    failure?: string;
  }>;
};

type EvaluatorVerdict = {
  passed: boolean;
  confidence: number;
  summary: string;
  evidence: string[];
  failures: string[];
};

type GuiSnapshot = {
  url: string;
  title: string;
  appCards: Array<{ appId: string; appName: string; text: string; visible: boolean }>;
  openApp: null | {
    appId: string;
    appName: string;
    text: string;
    fields: Array<{ componentId: string; label: string; tag: string; value: string; placeholder: string }>;
    buttons: Array<{
      componentId: string;
      actionId: string;
      text: string;
      disabled: boolean;
      contextFields?: Array<{
        key: string;
        path: string;
        componentId: string;
        label: string;
        currentValue: string;
      }>;
    }>;
    result?: { title: string; value: string; subtitle: string };
  };
  dockStatus: string;
  bodyText: string;
};

type StepObservation = {
  stepIndex: number;
  action: EvaluatorAction;
  ok: boolean;
  matched?: Record<string, unknown>;
  snapshot?: GuiSnapshot;
  screenshot?: string;
  error?: string;
};

type BehaviorProgress = {
  before?: GuiSnapshot;
  after?: GuiSnapshot;
  observations: StepObservation[];
  decisions: NonNullable<EvaluatorPlan['decisions']>;
  checks: string[];
};

export type EvaluatorRunInput = {
  appName: string;
  appId?: string;
  user?: string;
  expectedBehaviorPrompt: string;
  // 用例 fixture 里种进世界的人 = 用户"自己认识的人"(真实邮箱/电话只在 fixture 里,
  // 期望文本按自然语言只提名字):不带给驱动器它就发明 gmail 地址(iter19 实锤
  // Melissa Bailey/mel.bailey@gmail.com 全是幻觉)。
  knownPeople?: Array<{ name: string; email?: string; phone?: string }>;
  channel?: 'behavior' | 'browser';
  apiBase?: string;
  baseUrl?: string;
  outDir?: string;
  chromePath?: string;
  headless?: boolean;
  maxSteps?: number;
  horizonTurns?: number;
  llm?: LlmRuntimeConfig;
};

export type EvaluatorRunResult = {
  type: 'behavior_evaluation';
  channel: 'behavior' | 'browser';
  appName: string;
  expectedBehaviorPrompt: string;
  baseUrl?: string;
  apiBase?: string;
  artifactsDir: string;
  status: 'passed' | 'failed';
  plan: EvaluatorPlan;
  verdict: EvaluatorVerdict;
  before: GuiSnapshot;
  after: GuiSnapshot;
  observations: StepObservation[];
  screenshots?: {
    before: string;
    after: string;
  };
  stateFiles?: {
    before: string;
    after: string;
  };
  trace: Array<{
    agent: string;
    role: string;
    input: unknown;
    output: unknown;
    status: 'ok' | 'failed';
  }>;
};

export type EvaluatorBehaviorRuntime = {
  queryState(input?: Record<string, unknown>): Promise<any>;
  action(input: Record<string, unknown>): Promise<any>;
};

function requireText(value: unknown, message: string, maxLength = 4000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim().slice(0, maxLength);
}

function requireFieldValue(value: unknown, message: string) {
  if (typeof value !== 'string') throw new Error(message);
  return value.slice(0, 1200);
}

function requiredNumber(value: unknown, message: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(message);
  return number;
}

function slug(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'evaluation';
}

async function createEvaluatorArtifactsDirectory(artifactsDir: string) {
  await fs.mkdir(path.dirname(artifactsDir), { recursive: true });
  try {
    // Claim a fresh run directory atomically; existing reports and partial
    // trajectories must survive retries and accidental reuse of --out.
    await fs.mkdir(artifactsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Evaluator output already exists: ${artifactsDir}. Choose a new output directory; existing artifacts will not be overwritten.`);
    }
    throw error;
  }
}

function evaluatorErrorDetails(error: unknown) {
  const details = error as Error & Record<string, unknown>;
  return {
    message: String(details?.message ?? error),
    name: details?.name,
    llmLabel: details?.llmLabel,
    rawDecision: details?.rawDecision,
    rawVerdict: details?.rawVerdict,
    rawLlmResponse: details?.rawLlmResponse,
    previousDecisionErrors: details?.previousDecisionErrors,
  };
}

function behaviorProgressPlan(appName: string, progress: BehaviorProgress): EvaluatorPlan {
  return {
    intent: `Online behavior evaluation for ${appName}`,
    mode: 'online',
    steps: progress.observations.map((item) => item.action),
    checks: progress.checks,
    decisions: progress.decisions,
  };
}

function evaluatorConfigRequired(message: string) {
  const error = new Error(message) as Error & {
    status?: number;
    code?: string;
    retryable?: boolean;
    requiredConfig?: string[];
  };
  error.status = 428;
  error.code = 'llm_config_required';
  error.retryable = true;
  error.requiredConfig = ['apiKey', 'apiBase', 'model'];
  return error;
}

type ResolvedLlm = Required<Pick<LlmRuntimeConfig, 'apiKey' | 'apiBase' | 'model'>>;

function resolveLlmConfig(llm?: LlmRuntimeConfig): ResolvedLlm {
  const apiKey = String(llm?.apiKey || process.env.OPENAI_API_KEY || '').trim();
  const apiBase = String(llm?.apiBase || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, '');
  const model = String(llm?.model || process.env.LIVEUIAGENT_EVALUATOR_MODEL || process.env.LIVEUIAGENT_ORCHESTRATOR_MODEL || '').trim();
  if (!apiKey) throw evaluatorConfigRequired('Evaluator Agent api key required');
  if (!apiBase) throw evaluatorConfigRequired('Evaluator Agent api base required');
  if (!model) throw evaluatorConfigRequired('Evaluator Agent model required');
  return { apiKey, apiBase, model };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Evaluator Agent returned empty output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Evaluator Agent did not return JSON');
  }
}

async function openAIChatJson(input: {
  llm?: LlmRuntimeConfig;
  label: string;
  system: string;
  user: unknown;
  temperature?: number;
}) {
  const llm = resolveLlmConfig(input.llm);
  const timeoutMs = requiredNumber(process.env.LIVEUIAGENT_EVALUATOR_TIMEOUT_MS || 180000, 'invalid evaluator timeout');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${llm.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: llm.model,
        temperature: input.temperature ?? 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: JSON.stringify(input.user) },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      if ([400, 401, 403, 404, 405].includes(response.status)) {
        throw evaluatorConfigRequired(`${input.label} LLM config was rejected by the provider (HTTP ${response.status}).`);
      }
      throw new Error(`${input.label} failed ${response.status}: ${text}`);
    }
    let content = text;
    try {
      const json = JSON.parse(text);
      content = requireText(json.choices?.[0]?.message?.content, `${input.label} response missing content`, 30000);
      return extractJsonObject(content);
    } catch (error) {
      throw Object.assign(error as Error, { rawLlmResponse: content, llmLabel: input.label });
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${input.label} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePlan(raw: unknown, maxSteps: number): EvaluatorPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Evaluator Agent plan must be an object');
  const record = raw as Record<string, unknown>;
  const steps = record.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('Evaluator Agent plan must include non-empty steps');
  if (steps.length > maxSteps) throw new Error(`Evaluator Agent plan has ${steps.length} steps, max ${maxSteps}`);
  const normalizedSteps = steps.map((step, index): EvaluatorAction => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`Evaluator Agent step ${index + 1} must be an object`);
    const item = step as Record<string, unknown>;
    const kind = requireText(item.kind, `Evaluator Agent step ${index + 1} missing kind`, 40);
    const rationale = typeof item.rationale === 'string' ? item.rationale.slice(0, 400) : undefined;
    if (kind === 'fill') {
      return {
        kind,
        target: requireText(item.target, `Evaluator Agent fill step ${index + 1} missing target`, 200),
        value: requireFieldValue(item.value, `Evaluator Agent fill step ${index + 1} missing value`),
        rationale,
      };
    }
    if (kind === 'click') {
      return {
        kind,
        target: requireText(item.target, `Evaluator Agent click step ${index + 1} missing target`, 200),
        rationale,
      };
    }
    if (kind === 'wait') {
      const milliseconds = Math.max(100, Math.min(5000, Math.round(requiredNumber(item.milliseconds, `Evaluator Agent wait step ${index + 1} missing milliseconds`))));
      return { kind, milliseconds, rationale };
    }
    if (kind === 'observe') return { kind, rationale };
    if (kind === 'reopen') return { kind, rationale };
    throw new Error(`Evaluator Agent emitted unsupported step kind: ${kind}`);
  });
  const checks = Array.isArray(record.checks)
    ? record.checks.map((check) => requireText(check, 'Evaluator Agent check must be text', 500))
    : [];
  return {
    intent: requireText(record.intent ?? 'Evaluate expected GUI behavior', 'Evaluator Agent plan missing intent', 500),
    steps: normalizedSteps,
    checks,
  };
}

function normalizeVerdict(raw: unknown): EvaluatorVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Evaluator Agent verdict must be an object');
  const record = raw as Record<string, unknown>;
  if (typeof record.passed !== 'boolean') throw new Error('Evaluator Agent verdict missing boolean passed');
  const confidence = Number(record.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Evaluator Agent verdict confidence must be 0..1');
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((item) => requireText(item, 'Evaluator Agent evidence must be text', 500))
    : [];
  const failures = Array.isArray(record.failures)
    ? record.failures.map((item) => requireText(item, 'Evaluator Agent failure must be text', 500))
    : [];
  const passed = record.passed && failures.length === 0;
  return {
    passed,
    confidence,
    summary: requireText(record.summary, 'Evaluator Agent verdict missing summary', 1000),
    evidence,
    failures,
  };
}

type A2UIComponent = Record<string, any> & {
  id: string;
  component: string;
};

type BehaviorSurfaceModel = {
  surfaceId: string;
  components: Map<string, A2UIComponent>;
  rootId: string;
  data: Record<string, any>;
};

function requiredObject<T extends object>(value: unknown, message: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as T;
}

function requiredArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTarget(value: string) {
  return value.toLowerCase().replace(/^actions\./, '').replace(/\s+/g, ' ').trim();
}

function behaviorAppCards(state: any) {
  return requiredArray<any>(state.apps, 'query-state missing apps').map((app) => ({
    appId: requireText(app.appId, 'app missing appId', 120),
    appName: requireText(app.name, 'app missing name', 200),
    text: `${app.name} ${app.description || ''}`.replace(/\s+/g, ' ').trim(),
    visible: true,
  }));
}

function findAppRecord(state: any, appName: string) {
  const apps = requiredArray<any>(state.apps, 'query-state missing apps');
  const wanted = normalizeTarget(appName);
  const exact = apps.find((app) => normalizeTarget(String(app.appId || '')) === wanted || normalizeTarget(String(app.name || '')) === wanted);
  const partial = apps.find((app) => {
    const values = [app.appId, app.name, app.description].map((value) => normalizeTarget(String(value || '')));
    return values.some((value) => value.includes(wanted) || wanted.includes(value));
  });
  const app = exact || partial;
  if (!app) throw new Error(`Evaluator could not find app: ${appName}`);
  return app;
}

function buildBehaviorSurfaceModel(app: any): BehaviorSurfaceModel {
  const a2ui = requiredObject<Record<string, any>>(app.appPackage?.ui?.meta?.a2ui, `app ${app.appId} missing A2UI surface`);
  if (a2ui.protocol !== 'a2ui') throw new Error(`app ${app.appId} A2UI protocol is invalid`);
  const surfaceId = requireText(a2ui.surfaceId, `app ${app.appId} A2UI missing surfaceId`, 160);
  const components = new Map<string, A2UIComponent>();
  let rootId = '';
  let data: Record<string, any> | null = null;
  for (const message of requiredArray<Record<string, any>>(a2ui.messages, `app ${app.appId} A2UI missing messages`)) {
    const updateComponents = message.updateComponents;
    if (updateComponents !== undefined) {
      const update = requiredObject<{ surfaceId: unknown; components: unknown }>(updateComponents, 'A2UI updateComponents must be an object');
      if (update.surfaceId !== surfaceId) throw new Error(`A2UI updateComponents surfaceId mismatch for ${app.appId}`);
      for (const component of requiredArray<A2UIComponent>(update.components, 'A2UI updateComponents missing components')) {
        requireText(component.id, 'A2UI component missing id', 160);
        requireText(component.component, `A2UI component ${component.id} missing component`, 80);
        components.set(component.id, component);
        if (component.id === 'root') rootId = component.id;
      }
    }
    const updateDataModel = message.updateDataModel;
    if (updateDataModel !== undefined) {
      const update = requiredObject<{ surfaceId: unknown; value: unknown }>(updateDataModel, 'A2UI updateDataModel must be an object');
      if (update.surfaceId !== surfaceId) throw new Error(`A2UI updateDataModel surfaceId mismatch for ${app.appId}`);
      data = requiredObject<Record<string, any>>(update.value, 'A2UI updateDataModel missing value');
    }
  }
  if (!rootId) throw new Error(`app ${app.appId} A2UI missing root component`);
  if (!data) throw new Error(`app ${app.appId} A2UI missing data model`);
  return { surfaceId, components, rootId, data };
}

function resolveA2uiPath(data: Record<string, any>, descriptor: unknown) {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) || !('path' in descriptor)) return descriptor;
  const rawPath = requireText((descriptor as { path?: unknown }).path, 'A2UI binding missing path', 400);
  const parts = rawPath.replace(/^\//, '').split('/').filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`A2UI binding path ${rawPath} cannot be resolved`);
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined || current === null) throw new Error(`A2UI binding path ${rawPath} resolved empty`);
  return current;
}

function setA2uiPath(data: Record<string, any>, descriptor: unknown, value: string) {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) || !('path' in descriptor)) {
    throw new Error('TextField value must bind to a data path');
  }
  const rawPath = requireText((descriptor as { path?: unknown }).path, 'TextField binding missing path', 400);
  const parts = rawPath.replace(/^\//, '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('TextField binding path is empty');
  let current: Record<string, any> = data;
  for (const part of parts.slice(0, -1)) {
    current = requiredObject<Record<string, any>>(current[part], `TextField binding path ${rawPath} cannot be resolved`);
  }
  current[parts[parts.length - 1]] = value;
}

function childIds(component: A2UIComponent): string[] {
  if (component.children !== undefined) return requiredArray<string>(component.children, `A2UI component ${component.id} children must be an array`);
  if (component.child !== undefined) return [requireText(component.child, `A2UI component ${component.id} child must be text`, 160)];
  return [];
}

function behaviorTextForComponent(model: BehaviorSurfaceModel, data: Record<string, any>, componentId: string, visited = new Set<string>()): string[] {
  if (visited.has(componentId)) return [];
  visited.add(componentId);
  const component = model.components.get(componentId);
  if (!component) throw new Error(`A2UI component not found: ${componentId}`);
  // Match the widget vocabulary rendered by docs/ui-revamp/index-patched.html
  // (served as dist/index.html), including the same order and StatGrid limit.
  if (component.component === 'StatBlock') {
    return [
      String(resolveA2uiPath(data, component.label)),
      String(resolveA2uiPath(data, component.value)),
      ...(component.caption === undefined ? [] : [String(resolveA2uiPath(data, component.caption))]),
    ];
  }
  if (component.component === 'StatGrid') {
    const stats = requiredArray<Record<string, any>>(resolveA2uiPath(data, { path: component.path || '/stats' }), `StatGrid ${component.id} binding must resolve a stats array`);
    return stats.slice(0, 4).flatMap((stat) => [String(stat?.label || ''), String(stat?.value || '')]);
  }
  if (component.component === 'Badge') return [String(resolveA2uiPath(data, component.text))];
  if (component.component === 'SectionHeading') {
    return [
      ...(component.kicker === undefined ? [] : [String(resolveA2uiPath(data, component.kicker))]),
      String(resolveA2uiPath(data, component.title)),
      ...(component.meta === undefined ? [] : [String(resolveA2uiPath(data, component.meta))]),
    ];
  }
  if (component.component === 'Text') return [String(resolveA2uiPath(data, component.text))];
  if (component.component === 'TextField') {
    return [
      requireText(component.label, `TextField ${component.id} missing label`, 160),
      String(resolveA2uiPath(data, component.value)),
    ];
  }
  if (component.component === 'Button') {
    return childIds(component).flatMap((childId) => behaviorTextForComponent(model, data, childId, visited));
  }
  if (component.component === 'List') {
    const children = requiredObject<{ componentId: unknown; path: unknown }>(component.children, `List ${component.id} missing children descriptor`);
    const itemComponentId = requireText(children.componentId, `List ${component.id} missing item component id`, 160);
    const rows = requiredArray<Record<string, any>>(resolveA2uiPath(data, { path: children.path }), `List ${component.id} binding must resolve rows`);
    return rows.flatMap((row) => behaviorTextForComponent(model, row, itemComponentId, new Set(visited)));
  }
  if (component.component === 'Tabs') {
    return requiredArray<{ title: string; child: string }>(component.tabs, `Tabs ${component.id} missing tabs`)
      .flatMap((tab) => [requireText(tab.title, `Tabs ${component.id} tab missing title`, 120), ...behaviorTextForComponent(model, data, requireText(tab.child, `Tabs ${component.id} tab missing child`, 160), visited)]);
  }
  return childIds(component).flatMap((childId) => behaviorTextForComponent(model, data, childId, visited));
}

function behaviorFieldList(model: BehaviorSurfaceModel, data: Record<string, any>) {
  return Array.from(model.components.values())
    .filter((component) => component.component === 'TextField')
    .map((component) => ({
      componentId: component.id,
      label: requireText(component.label, `TextField ${component.id} missing label`, 160),
      tag: component.variant === 'longText' ? 'textarea' : 'input',
      value: String(resolveA2uiPath(data, component.value)),
      placeholder: String(component.placeholder || ''),
    }));
}

// List 条目模板作用域:模板子树里的组件 id → 所属列表的行数据。
// 行内实体按钮要按行展开(每行一个可点目标),点击时 context 必须对那一行解析。
function collectItemScopes(model: BehaviorSurfaceModel, data: Record<string, any>) {
  const scopes = new Map<string, Array<Record<string, any>>>();
  for (const component of model.components.values()) {
    if (component.component !== 'List') continue;
    const children = requiredObject<{ componentId: unknown; path: unknown }>(component.children, `List ${component.id} missing children descriptor`);
    const itemId = requireText(children.componentId, `List ${component.id} missing item component id`, 160);
    const rows = requiredArray<Record<string, any>>(resolveA2uiPath(data, { path: children.path }), `List ${component.id} binding must resolve rows`);
    const stack = [itemId];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      scopes.set(id, rows);
      const node = model.components.get(id);
      if (node) stack.push(...childIds(node));
    }
  }
  return scopes;
}

function behaviorButtonList(model: BehaviorSurfaceModel, data: Record<string, any>) {
  const fields = Array.from(model.components.values())
    .filter((component) => component.component === 'TextField')
    .map((component) => ({
      componentId: component.id,
      label: requireText(component.label, `TextField ${component.id} missing label`, 160),
      valueBinding: component.value,
      path: typeof component.value === 'object' && component.value !== null && !Array.isArray(component.value) && 'path' in component.value
        ? String((component.value as Record<string, unknown>).path || '')
        : '',
    }));
  const itemScopes = collectItemScopes(model, data);
  const makeEntry = (component: A2UIComponent, suffix: string, rowName: string) => {
    const action = requiredObject<Record<string, any>>(component.action, `Button ${component.id} missing action`);
    const event = requiredObject<Record<string, any>>(action.event, `Button ${component.id} missing action event`);
    const context = requiredObject<Record<string, unknown>>(event.context, `Button ${component.id} missing action context`);
    const contextFields = Object.entries(context).flatMap(([key, binding]) => {
      const pathValue = typeof binding === 'object' && binding !== null && !Array.isArray(binding) && 'path' in binding
        ? String((binding as Record<string, unknown>).path || '')
        : '';
      if (!pathValue) return [];
      const field = fields.find((candidate) => candidate.path === pathValue);
      if (!field) return [];
      return [{
        key,
        path: pathValue,
        componentId: field.componentId,
        label: field.label,
        currentValue: String(resolveA2uiPath(data, field.valueBinding)),
      }];
    });
    const baseText = behaviorTextForComponent(model, data, component.id).join(' ').replace(/\s+/g, ' ').trim();
    return {
      componentId: suffix ? `${component.id}${suffix}` : component.id,
      actionId: requireText(event.name, `Button ${component.id} missing action name`, 160),
      text: rowName ? `${baseText} · ${rowName}` : baseText,
      disabled: false,
      contextFields,
    };
  };
  // 顶层按钮先出:快照按钮预算截断时,composer 主按钮不能被行按钮挤掉。
  const topLevel: Array<ReturnType<typeof makeEntry>> = [];
  const rowButtons: Array<ReturnType<typeof makeEntry>> = [];
  for (const component of model.components.values()) {
    if (component.component !== 'Button') continue;
    const rows = itemScopes.get(component.id);
    if (!rows) {
      topLevel.push(makeEntry(component, '', ''));
      continue;
    }
    // 行按钮:componentId 变 d_x[行号],文字追加 · 行名 —— 驱动器据此点中特定一行。
    rows.slice(0, 8).forEach((row, index) => {
      rowButtons.push(makeEntry(component, `[${index}]`, String(row?.name ?? '')));
    });
  }
  return [...topLevel, ...rowButtons];
}

function behaviorSnapshotFromState(state: any, app: any, model: BehaviorSurfaceModel, data: Record<string, any>, dockStatus = ''): GuiSnapshot {
  const openText = behaviorTextForComponent(model, data, model.rootId).join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const ir = app?.runtimeState?.intentResult;
  const result = ir && typeof ir === 'object'
    ? { title: String(ir.title ?? '').slice(0, 200), value: String(ir.value ?? '').slice(0, 400), subtitle: String(ir.subtitle ?? '').slice(0, 600) }
    : undefined;
  // 快照硬预算:字段值/按钮/正文全部截断 —— 富内容应用(整段工具结果渗进数据模型)
  // 曾把驱动 prompt 滚到 1.15M token(413)。
  const fields = behaviorFieldList(model, data).slice(0, 24).map((field: any) => ({
    ...field,
    value: String(field.value ?? '').slice(0, 300),
    placeholder: String(field.placeholder ?? '').slice(0, 120),
  }));
  const buttons = behaviorButtonList(model, data).slice(0, 24);
  return {
    url: 'behavior://liveuiagent/a2ui',
    title: 'LIVEUIAGENT Behavior Evaluator',
    appCards: behaviorAppCards(state),
    openApp: {
      appId: requireText(app.appId, 'app missing appId', 120),
      appName: requireText(app.name, 'app missing name', 200),
      text: openText,
      fields,
      buttons,
      ...(result ? { result } : {}),
    },
    dockStatus: String(dockStatus ?? '').slice(0, 400),
    bodyText: `${behaviorAppCards(state).map((card) => card.text).join(' ')} ${openText}`.replace(/\s+/g, ' ').trim().slice(0, 6000),
  };
}

function matchField(model: BehaviorSurfaceModel, data: Record<string, any>, target: string) {
  const wanted = normalizeTarget(target);
  const fields = Array.from(model.components.values())
    .filter((component) => component.component === 'TextField')
    .map((component) => ({
      component,
      label: requireText(component.label, `TextField ${component.id} missing label`, 160),
      value: String(resolveA2uiPath(data, component.value)),
    }));
  const found = fields.find((field) => normalizeTarget(field.component.id) === wanted || normalizeTarget(field.label) === wanted)
    || fields.find((field) => normalizeTarget(field.component.id).includes(wanted) || normalizeTarget(field.label).includes(wanted) || wanted.includes(normalizeTarget(field.label)));
  if (!found) throw new Error(`field not found: ${target}; candidates: ${fields.map((field) => `${field.component.id}/${field.label}`).join(', ')}`);
  return found;
}

function matchButton(model: BehaviorSurfaceModel, data: Record<string, any>, target: string) {
  const wanted = normalizeTarget(target);
  const buttons = behaviorButtonList(model, data);
  const found = buttons.find((button) => normalizeTarget(button.actionId) === wanted || normalizeTarget(button.componentId) === wanted || normalizeTarget(button.text) === wanted)
    || buttons.find((button) => normalizeTarget(button.actionId).includes(wanted) || normalizeTarget(button.componentId).includes(wanted) || normalizeTarget(button.text).includes(wanted) || wanted.includes(normalizeTarget(button.text)));
  if (!found) throw new Error(`button not found: ${target}; candidates: ${buttons.map((button) => `${button.componentId}/${button.actionId}/${button.text}`).join(', ')}`);
  // 行按钮的合成 id(d_x[3]):真实组件是模板 id,点击 context 必须对第 3 行的行数据解析。
  const rowMatch = /^(.+)\[(\d+)\]$/.exec(found.componentId);
  const baseId = rowMatch ? rowMatch[1] : found.componentId;
  const component = model.components.get(baseId);
  if (!component) throw new Error(`button component not found after match: ${found.componentId}`);
  let rowData: Record<string, any> | null = null;
  if (rowMatch) {
    const rows = collectItemScopes(model, data).get(baseId);
    rowData = rows?.[Number(rowMatch[2])] ?? null;
    if (!rowData) throw new Error(`row ${rowMatch[2]} not found for button ${baseId}`);
  }
  return { component, summary: found, rowData };
}

function resolveA2uiActionContext(data: Record<string, any>, context: unknown): Record<string, unknown> {
  const record = requiredObject<Record<string, unknown>>(context, 'A2UI action missing context');
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolveA2uiPath(data, value)]));
}

function normalizeDecision(raw: unknown): EvaluatorDecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Behavior Evaluator decision must be an object');
  const record = raw as Record<string, unknown>;
  if (typeof record.done !== 'boolean') throw new Error('Behavior Evaluator decision missing boolean done');
  const checks = Array.isArray(record.checks)
    ? record.checks.map((check) => requireText(check, 'Behavior Evaluator check must be text', 500))
    : [];
  const base = {
    done: record.done,
    rationale: requireText(record.rationale ?? (record.done ? 'Evaluation complete' : 'Continue evaluation'), 'Behavior Evaluator decision missing rationale', 600),
    progress: requireText(record.progress ?? 'Observed current GUI state', 'Behavior Evaluator decision missing progress', 800),
    checks,
    failure: typeof record.failure === 'string' && record.failure.trim() ? record.failure.trim().slice(0, 800) : undefined,
  };
  if (record.done) return base;
  const action = (record as { action?: unknown }).action;
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Behavior Evaluator non-final decision missing action');
  return {
    ...base,
    action: normalizePlan({ intent: base.rationale, steps: [action], checks }, 1).steps[0],
  };
}

async function decideNextBehaviorAction(input: {
  llm?: LlmRuntimeConfig;
  appName: string;
  expectedBehaviorPrompt: string;
  snapshot: GuiSnapshot;
  observations: StepObservation[];
  maxSteps: number;
  minActionTurns: number;
  mustContinue: boolean;
  rejectedEarlyDone?: {
    rationale: string;
    progress: string;
  };
}) {
  const raw = await openAIChatJson({
    llm: input.llm,
    label: 'Behavior Evaluator Agent',
    temperature: 0.1,
    system: [
      'You are the LIVEUIAGENT Behavior Evaluator Agent.',
      'You run an online behavior test against one generated GUI app through an A2UI channel.',
      'This is not a prewritten multi-step script. Decide exactly one next GUI action from the current snapshot and previous observations.',
      'Use only these action kinds when done=false: fill, click, wait, observe, reopen. To verify reopen persistence, emit {"kind":"reopen"} — this closes and re-reads the persisted app state; never click an app card, which is not a button.',
      'If you emit kind "wait", include milliseconds as an integer between 100 and 5000.',
      'Targets must be field labels, A2UI component ids, button text, or A2UI action ids from the current snapshot. Buttons whose componentId ends in [N] (e.g. d_done[2]) are per-row entity buttons — their text ends with · <entity name>; to act on ONE specific listed item, click that row\'s button by its exact componentId or its row-qualified text. When the expected behavior requires acting on ONE listed item (mark done, remove it, settle one person) and a per-row button exists, PREFER that row\'s button over a composer button with typed form values. CRITICAL: act ONLY on the items/people the expected behavior explicitly names for THIS step — never click a row button for anyone else (extra clicks corrupt the scenario), and verify the entity name in the button text matches (the row index shifts when the list re-renders — match by NAME, never by remembered index).',
      'Before clicking a button, inspect that button contextFields list and ensure every relevant field has a purposeful value.',
      'For long-horizon evaluation, create a coherent trajectory: initial entry, agent action, revision or changed constraint, second agent action, and final observation when the GUI supports it.',
      'The expectedBehaviorPrompt is authoritative and may describe an ordered test story. Follow that story in order.',
      'Only previousObservations from this evaluator run count as completed test steps. Values or history already present in the before/current snapshot are dirty prior state, not proof that the current test phase was executed.',
      'If the snapshot already contains a later-phase value but the current run has not executed the initial phase, overwrite the relevant fields with the initial-phase values from expectedBehaviorPrompt before clicking.',
      'If the GUI has the same fields and button after an action, continue by making a meaningful revision to one or more existing input slots, then click the same visible button again to test stateful update behavior.',
      'Do not randomly fill fields. Values must support the expected behavior prompt and preserve prior context unless the next action intentionally tests revision.',
      'Do not invent controls. Do not inspect or mutate backend files. Do not call app actions except by clicking visible A2UI buttons.',
      'If mustContinue is true, set done=false and choose the next purposeful GUI action unless the current GUI has no usable path to continue; only then set done=true with a concrete failure.',
      'Set done=true only after enough GUI actions have been executed to judge stateful behavior, or when the GUI lacks required controls and failure is clear.',
      'Cover EVERY sub-scenario the expected behavior describes before done — including later revisions, removals and reopen checks (e.g. "removing X leaves only Y" requires you to actually edit the field to drop X and resubmit). An unexecuted sub-scenario is a failed evaluation, not a shortcut.',
      'Return only JSON with keys done, action, rationale, progress, checks, failure.',
    ].join(' '),
    user: {
      appName: input.appName,
      expectedBehaviorPrompt: input.expectedBehaviorPrompt,
      currentGuiSnapshot: compactGuiSnapshot(input.snapshot),
      stepBudget: {
        maxSteps: input.maxSteps,
        stepsAlreadyExecuted: input.observations.length,
        minActionTurns: input.minActionTurns,
        clickTurnsAlreadyExecuted: input.observations.filter((item) => item.ok && item.action.kind === 'click').length,
        mustContinue: input.mustContinue,
      },
      rejectedEarlyDone: input.rejectedEarlyDone,
      previousObservations: compactObservations(input.observations),
      outputShape: {
        done: false,
        action: { kind: 'fill', target: 'visible field label or component id', value: 'purposeful test value', rationale: 'why this is the next online action' },
        rationale: 'why this is the next best step from the current GUI state',
        progress: 'what has been verified or still needs checking',
        checks: ['observable behavior to verify over the trajectory'],
        failure: 'only set when done=true and behavior cannot be satisfied',
      },
    },
  });
  try {
    return normalizeDecision(raw);
  } catch (error) {
    throw Object.assign(error as Error, { rawDecision: raw, llmLabel: 'Behavior Evaluator Agent' });
  }
}

async function executeBehaviorAction(input: {
  runtime: EvaluatorBehaviorRuntime;
  appName: string;
  app: any;
  state: any;
  model: BehaviorSurfaceModel;
  data: Record<string, any>;
  dockStatus: string;
  action: EvaluatorAction;
  stepIndex: number;
  llm?: LlmRuntimeConfig;
  artifactsDir: string;
}) {
  let state = input.state;
  let app = input.app;
  let model = input.model;
  let data = input.data;
  let dockStatus = input.dockStatus;
  const { action, stepIndex } = input;
  try {
    let matched: Record<string, unknown> | undefined;
    if (action.kind === 'fill') {
      const field = matchField(model, data, action.target);
      setA2uiPath(data, field.component.value, action.value);
      matched = {
        componentId: field.component.id,
        label: field.label,
        value: action.value,
      };
    } else if (action.kind === 'click') {
      const { component, summary, rowData } = matchButton(model, data, action.target);
      const actionSpec = requiredObject<Record<string, any>>(component.action, `Button ${component.id} missing action`);
      const event = requiredObject<Record<string, any>>(actionSpec.event, `Button ${component.id} missing action event`);
      const rawActionId = requireText(event.name, `Button ${component.id} missing action name`, 160);
      // 行按钮的 context(/entityName、/id)绑在行对象上 —— 与真实客户端同一条派发路径。
      const payload = resolveA2uiActionContext(rowData ?? data, event.context);
      const actionResult = await input.runtime.action({
        requestId:rawActionId.replace(/^actions\./,'')==='host.app.command'?payload.requestId:randomUUID(),
        appId: requireText(app.appId, 'app missing appId', 120),
        actionId: rawActionId.replace(/^actions\./, ''),
        eventPayload: { ...payload, sourceComponentId: component.id },
        clientState: { evaluatorChannel: 'behavior' },
        platform: 'web',
        llm: input.llm,
        latencyPreference: 'low',
      });
      dockStatus = requiredArray<string>(actionResult.messages, 'action response missing messages')[0] || '';
      state = await input.runtime.queryState({});
      app = findAppRecord(state, input.appName);
      model = buildBehaviorSurfaceModel(app);
      data = cloneJson(model.data);
      matched = {
        componentId: summary.componentId,
        actionId: rawActionId,
        text: summary.text,
        runtimeState: actionResult.runtimeState,
        toolDbChanges: actionResult.toolDbChanges,
      };
    } else if (action.kind === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
      state = await input.runtime.queryState({});
      app = findAppRecord(state, input.appName);
      model = buildBehaviorSurfaceModel(app);
      data = cloneJson(model.data);
    } else if (action.kind === 'reopen') {
      // A genuine close-and-reopen: drop the in-memory draft and re-read the
      // persisted app state from the runtime, exactly what a user reopening the
      // app card would see.
      state = await input.runtime.queryState({});
      app = findAppRecord(state, input.appName);
      model = buildBehaviorSurfaceModel(app);
      data = cloneJson(model.data);
      dockStatus = '已重新打开应用';
      matched = { reopened: true, appId: app.appId };
    }

    const stepSnapshot = behaviorSnapshotFromState(state, app, model, data, dockStatus);
    const snapshotPath = path.join(input.artifactsDir, `step-${String(stepIndex).padStart(2, '0')}.json`);
    await fs.writeFile(snapshotPath, `${JSON.stringify(stepSnapshot, null, 2)}\n`);
    return {
      state,
      app,
      model,
      data,
      dockStatus,
      observation: { stepIndex, action, ok: true, matched, snapshot: stepSnapshot, screenshot: snapshotPath } satisfies StepObservation,
    };
  } catch (error) {
    const stepSnapshot = behaviorSnapshotFromState(state, app, model, data, dockStatus);
    const snapshotPath = path.join(input.artifactsDir, `step-${String(stepIndex).padStart(2, '0')}-failed.json`);
    await fs.writeFile(snapshotPath, `${JSON.stringify(stepSnapshot, null, 2)}\n`);
    return {
      state,
      app,
      model,
      data,
      dockStatus,
      observation: {
        stepIndex,
        action,
        ok: false,
        snapshot: stepSnapshot,
        screenshot: snapshotPath,
        error: (error as Error).message,
      } satisfies StepObservation,
    };
  }
}

async function runOnlineBehavior(input: {
  runtime: EvaluatorBehaviorRuntime;
  appName: string;
  expectedBehaviorPrompt: string;
  state: any;
  app: any;
  model: BehaviorSurfaceModel;
  data: Record<string, any>;
  maxSteps: number;
  minActionTurns: number;
  llm?: LlmRuntimeConfig;
  artifactsDir: string;
  progress: BehaviorProgress;
}) {
  let state = input.state;
  let app = input.app;
  let model = input.model;
  let data = input.data;
  let dockStatus = '';
  const observations = input.progress.observations;
  const decisions = input.progress.decisions;
  const checks = new Set<string>();
  let consecutiveFailedSteps = 0;

  for (let stepIndex = 1; stepIndex <= input.maxSteps; stepIndex += 1) {
    const currentSnapshot = behaviorSnapshotFromState(state, app, model, data, dockStatus);
    input.progress.after = currentSnapshot;
    const clickTurnsBeforeDecision = observations.filter((item) => item.ok && item.action.kind === 'click').length;
    // 单次驱动决策失败(空响应/格式错)重试一次 —— 不让一次抖动作废整例。
    let decision: Awaited<ReturnType<typeof decideNextBehaviorAction>>;
    try {
      decision = await decideNextBehaviorAction({
        llm: input.llm,
        appName: input.appName,
        expectedBehaviorPrompt: input.expectedBehaviorPrompt,
        snapshot: currentSnapshot,
        observations,
        maxSteps: input.maxSteps,
        minActionTurns: input.minActionTurns,
        mustContinue: clickTurnsBeforeDecision < input.minActionTurns,
      });
    } catch (error) {
      console.warn(`[evaluator] driver decision ${stepIndex} failed, retrying once: ${(error as Error).message}`);
      try {
        decision = await decideNextBehaviorAction({
          llm: input.llm,
          appName: input.appName,
          expectedBehaviorPrompt: input.expectedBehaviorPrompt,
          snapshot: currentSnapshot,
          observations,
          maxSteps: input.maxSteps,
          minActionTurns: input.minActionTurns,
          mustContinue: clickTurnsBeforeDecision < input.minActionTurns,
        });
      } catch (retryError) {
        throw Object.assign(retryError as Error, {
          previousDecisionErrors: [{ stepIndex, attempt: 1, ...evaluatorErrorDetails(error) }],
        });
      }
    }
    if (decision.done && clickTurnsBeforeDecision < input.minActionTurns && !decision.failure) {
      decision = await decideNextBehaviorAction({
        llm: input.llm,
        appName: input.appName,
        expectedBehaviorPrompt: input.expectedBehaviorPrompt,
        snapshot: currentSnapshot,
        observations,
        maxSteps: input.maxSteps,
        minActionTurns: input.minActionTurns,
        mustContinue: true,
        rejectedEarlyDone: {
          rationale: decision.rationale,
          progress: decision.progress,
        },
      });
    }
    for (const check of decision.checks) checks.add(check);
    input.progress.checks = Array.from(checks);
    decisions.push({
      stepIndex,
      done: decision.done,
      rationale: decision.rationale,
      progress: decision.progress,
      action: decision.action,
      failure: decision.failure,
    });
    if (decision.done) {
      const clickTurns = observations.filter((item) => item.ok && item.action.kind === 'click').length;
      if (clickTurns < input.minActionTurns && !decision.failure) {
        // 早退不再作废整例:带着已有轨迹交给 judge 判(不足的回合数 judge 看得见)。
        console.warn(`[evaluator] driver ended after ${clickTurns} click turns (< ${input.minActionTurns}); judging on partial trajectory`);
      }
      break;
    }
    if (!decision.action) throw new Error(`Behavior Evaluator decision ${stepIndex} missing action`);

    const executed = await executeBehaviorAction({
      runtime: input.runtime,
      appName: input.appName,
      app,
      state,
      model,
      data,
      dockStatus,
      action: decision.action,
      stepIndex,
      llm: input.llm,
      artifactsDir: input.artifactsDir,
    });
    state = executed.state;
    app = executed.app;
    model = executed.model;
    data = executed.data;
    dockStatus = executed.dockStatus;
    observations.push(executed.observation);
    input.progress.after = executed.observation.snapshot;
    // 单步失败不终局:驱动 agent 能从失败观察调整下一步;连续 3 次失败才停。
    if (!executed.observation.ok) {
      consecutiveFailedSteps += 1;
      if (consecutiveFailedSteps >= 3) {
        console.warn(`[evaluator] ${consecutiveFailedSteps} consecutive failed steps; judging on partial trajectory`);
        break;
      }
    } else {
      consecutiveFailedSteps = 0;
    }
    if (stepIndex === input.maxSteps && observations.filter((item) => item.ok && item.action.kind === 'click').length < input.minActionTurns) {
      // 步数耗尽同样交给 judge 判(不作废),回合数证据都在轨迹里。
      console.warn(`[evaluator] exhausted ${input.maxSteps} steps below ${input.minActionTurns} click turns; judging on partial trajectory`);
    }
  }
  const plan = behaviorProgressPlan(input.appName, input.progress);
  return { state, app, model, data, dockStatus, observations, plan };
}

async function runBehaviorEvaluatorAgent(input: EvaluatorRunInput, runtime: EvaluatorBehaviorRuntime): Promise<EvaluatorRunResult> {
  const appName = requireText(input.appName, 'appName required', 300);
  const expectedBehaviorPrompt = requireText(input.expectedBehaviorPrompt, 'expectedBehaviorPrompt required', 4000);
  const maxSteps = Math.max(3, Math.min(24, Math.round(Number(input.maxSteps ?? 14))));
  const minActionTurns = Math.max(1, Math.min(6, Math.round(Number(input.horizonTurns ?? 3))));
  const llm = resolveLlmConfig(input.llm);
  const artifactsDir = path.resolve(input.outDir || process.env.LIVEUIAGENT_EVALUATOR_OUT || path.join('artifacts', 'evaluator', `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(appName)}-behavior`));
  await createEvaluatorArtifactsDirectory(artifactsDir);
  const trace: EvaluatorRunResult['trace'] = [];
  const progress: BehaviorProgress = { observations: [], decisions: [], checks: [] };
  let failureStage = 'opening';

  try {
    let state = await runtime.queryState({});
    let app = findAppRecord(state, appName);
    let model = buildBehaviorSurfaceModel(app);
    let data = cloneJson(model.data);
    const before = behaviorSnapshotFromState(state, app, model, data);
    progress.before = before;
    progress.after = before;
    const beforePath = path.join(artifactsDir, 'before.json');
    await fs.writeFile(beforePath, `${JSON.stringify(before, null, 2)}\n`);
    trace.push({
      agent: 'Behavior Evaluator Channel',
      role: 'Open target generated GUI package through A2UI without browser',
      input: { appName },
      output: { appId: app.appId, appName: app.name, fields: before.openApp?.fields, buttons: before.openApp?.buttons },
      status: 'ok',
    });

    failureStage = 'driver';
    const behaviorRun = await runOnlineBehavior({
      runtime,
      appName,
      expectedBehaviorPrompt,
      state,
      app,
      model,
      data,
      maxSteps,
      minActionTurns,
      llm,
      artifactsDir,
      progress,
    });
    state = behaviorRun.state;
    app = behaviorRun.app;
    model = behaviorRun.model;
    data = behaviorRun.data;
    const observations = behaviorRun.observations;
    const plan = behaviorRun.plan;
    trace.push({
      agent: 'Behavior Evaluator Agent',
      role: 'Online decide one GUI action at a time from current A2UI snapshots',
      input: { appName, expectedBehaviorPrompt, maxSteps, minActionTurns, fields: before.openApp?.fields, buttons: before.openApp?.buttons },
      output: plan,
      status: observations.every((item) => item.ok) ? 'ok' : 'failed',
    });

    const after = behaviorSnapshotFromState(state, app, model, data, behaviorRun.dockStatus);
    progress.after = after;
    const afterPath = path.join(artifactsDir, 'after.json');
    await fs.writeFile(afterPath, `${JSON.stringify(after, null, 2)}\n`);

    failureStage = 'judge';
    const verdict = await judgeBehavior({ llm, appName, expectedBehaviorPrompt, plan, before, after, observations, pageErrors: [] });
    trace.push({
      agent: 'Evaluator Judge Agent',
      role: 'Check observed online GUI behavior against expected behavior',
      input: { expectedBehaviorPrompt },
      output: verdict,
      status: verdict.passed ? 'ok' : 'failed',
    });

    const result: EvaluatorRunResult = {
      type: 'behavior_evaluation',
      channel: 'behavior',
      appName,
      expectedBehaviorPrompt,
      apiBase: input.apiBase,
      artifactsDir,
      status: verdict.passed ? 'passed' : 'failed',
      plan,
      verdict,
      before,
      after,
      observations,
      stateFiles: {
        before: beforePath,
        after: afterPath,
      },
      trace,
    };
    failureStage = 'report';
    await fs.writeFile(path.join(artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    trace.push({
      agent: 'Behavior Evaluator Workflow',
      role: 'Fail fast on invalid behavior evaluator setup or behavior test',
      input: { appName, expectedBehaviorPrompt },
      output: { failureStage, ...evaluatorErrorDetails(error) },
      status: 'failed',
    });
    const failurePath = path.join(artifactsDir, 'failure.json');
    await fs.writeFile(failurePath, `${JSON.stringify({
      type: 'behavior_evaluation_failure', channel: 'behavior', status: 'unscored',
      appName, expectedBehaviorPrompt, artifactsDir, failureStage,
      error: evaluatorErrorDetails(error),
      before: progress.before, after: progress.after,
      observations: progress.observations, plan: behaviorProgressPlan(appName, progress), trace,
    }, null, 2)}\n`, { flag: 'wx' });
    throw Object.assign(error as Error, { trace, failurePath });
  }
}

function resolveChromePath(input?: string) {
  const candidates = [
    input,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) throw new Error('Chrome executable not found; set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH');
  return found;
}

async function preparePage(browser: Browser, baseUrl: string, llm: ResolvedLlm, user?: string) {
  const page = await browser.newPage();
  if (user) await page.setExtraHTTPHeaders({ 'X-LiveUIAgent-User': user });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push((error as Error).message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.setViewport({ width: 1440, height: 1024, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((config) => {
    window.localStorage.setItem('liveuiagent.llm.config', JSON.stringify(config));
  }, llm);
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.app-card', { timeout: 30000 });
  return { page, pageErrors };
}

async function snapshot(page: Page): Promise<GuiSnapshot> {
  return page.evaluate(() => {
    const textOf = (node: Element | null | undefined) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const appCards = Array.from(document.querySelectorAll<HTMLElement>('.app-card')).map((node) => ({
      appId: node.dataset.appId || '',
      appName: node.dataset.appName || '',
      text: textOf(node),
      visible: isVisible(node),
    }));
    const sheet = document.querySelector<HTMLElement>('.app-sheet');
    const fields = sheet
      ? Array.from(sheet.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
        .filter(isVisible)
        .map((node) => {
          const label = node.closest('label');
          return {
            componentId: node.dataset.a2uiComponentId || '',
            label: node.dataset.a2uiLabel || textOf(label?.querySelector('span')) || node.getAttribute('aria-label') || '',
            tag: node.tagName.toLowerCase(),
            value: String(node.value || ''),
            placeholder: node.getAttribute('placeholder') || '',
          };
        })
      : [];
    const buttons = sheet
      ? Array.from(sheet.querySelectorAll<HTMLButtonElement>('button'))
        .filter((node) => !node.classList.contains('sheet-close'))
        .filter(isVisible)
        .map((node) => ({
          componentId: node.dataset.a2uiComponentId || '',
          actionId: node.dataset.a2uiActionId || '',
          text: textOf(node),
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
        }))
      : [];
    return {
      url: window.location.href,
      title: document.title,
      appCards,
      openApp: sheet ? {
        appId: sheet.dataset.appId || '',
        appName: sheet.dataset.appName || '',
        text: textOf(sheet),
        fields,
        buttons,
      } : null,
      dockStatus: textOf(document.querySelector('.dock-status')),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000),
    };
  });
}

async function openApp(page: Page, appName: string, exactId = false) {
  const opened = await page.evaluate(({target, exactId}) => {
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = normalize(target);
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.app-card'));
    const exact = cards.find((card) => normalize(card.dataset.appId || '') === wanted || normalize(card.dataset.appName || '') === wanted);
    const partial = cards.find((card) => {
      const values = [card.dataset.appId || '', card.dataset.appName || '', card.textContent || ''].map(normalize);
      return values.some((value) => value.includes(wanted) || wanted.includes(value));
    });
    const card = exact || (!exactId ? partial : undefined);
    if (!card) return { ok: false, appId: '', appName: '', text: '' };
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 2 }));
    return {
      ok: true,
      appId: card.dataset.appId || '',
      appName: card.dataset.appName || '',
      text: (card.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  }, {target: appName, exactId});
  if (!opened.ok) throw new Error(`Evaluator could not find app: ${appName}`);
  await page.waitForSelector('.app-sheet', { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 800));
  return opened;
}

async function fillField(page: Page, target: string, value: string) {
  const result = await page.evaluate(({ target: rawTarget, value: nextValue }) => {
    const normalize = (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = normalize(rawTarget);
    const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, assigned: string) => {
      if (element instanceof HTMLSelectElement) {
        const option = Array.from(element.options).find((candidate) => normalize(candidate.value) === normalize(assigned) || normalize(candidate.textContent || '') === normalize(assigned))
          || Array.from(element.options).find((candidate) => candidate.value)
          || element.options[0];
        if (!option) throw new Error(`select ${rawTarget} has no options`);
        element.value = option.value;
      } else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (!descriptor?.set) throw new Error(`field ${rawTarget} has no value setter`);
        descriptor.set.call(element, assigned);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const textOf = (node: Element | null | undefined) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('.app-sheet input, .app-sheet textarea, .app-sheet select'));
    const visible = fields.filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const candidates = visible.map((node) => {
      const label = node.dataset.a2uiLabel || textOf(node.closest('label')?.querySelector('span')) || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '';
      const componentId = node.dataset.a2uiComponentId || '';
      return { node, label, componentId, tag: node.tagName.toLowerCase() };
    });
    const found = candidates.find((item) => normalize(item.componentId) === wanted || normalize(item.label) === wanted)
      || candidates.find((item) => normalize(item.componentId).includes(wanted) || normalize(item.label).includes(wanted) || wanted.includes(normalize(item.label)));
    if (!found) return { ok: false, message: `field not found: ${rawTarget}`, candidates: candidates.map(({ label, componentId, tag }) => ({ label, componentId, tag })) };
    setNativeValue(found.node, nextValue);
    return {
      ok: true,
      matched: {
        componentId: found.componentId,
        label: found.label,
        tag: found.tag,
        value: found.node.value,
      },
    };
  }, { target, value });
  if (!result.ok) throw new Error(result.message);
  return result.matched as Record<string, unknown>;
}

async function clickButton(page: Page, target: string) {
  const result = await page.evaluate((rawTarget) => {
    const normalize = (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = normalize(rawTarget);
    const textOf = (node: Element | null | undefined) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.app-sheet button'))
      .filter((node) => !node.classList.contains('sheet-close'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((node) => ({
        node,
        text: textOf(node),
        componentId: node.dataset.a2uiComponentId || '',
        actionId: node.dataset.a2uiActionId || '',
        // 行内实体按钮:所有行共用同一组件 id,靠行名(entityName)区分要点哪一行。
        rowName: node.dataset.a2uiRowName || '',
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      }))
      .map((item) => ({ ...item, rowQualifiedText: item.rowName ? `${item.text} · ${item.rowName}` : item.text }));
    const found = buttons.find((item) => normalize(item.actionId) === wanted || normalize(item.componentId) === wanted || normalize(item.text) === wanted || normalize(item.rowQualifiedText) === wanted)
      || buttons.find((item) => normalize(item.actionId).includes(wanted) || normalize(item.componentId).includes(wanted) || normalize(item.rowQualifiedText).includes(wanted) || wanted.includes(normalize(item.rowQualifiedText)));
    if (!found) return { ok: false, message: `button not found: ${rawTarget}`, candidates: buttons.map(({ text, componentId, actionId, disabled }) => ({ text, componentId, actionId, disabled })) };
    if (found.disabled) return { ok: false, message: `button disabled: ${rawTarget}`, candidates: buttons.map(({ text, componentId, actionId, disabled }) => ({ text, componentId, actionId, disabled })) };
    found.node.click();
    return {
      ok: true,
      matched: {
        componentId: found.componentId,
        actionId: found.actionId,
        text: found.text,
      },
    };
  }, target);
  if (!result.ok) throw new Error(result.message);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  return result.matched as Record<string, unknown>;
}

async function planBehavior(input: {
  llm?: LlmRuntimeConfig;
  appName: string;
  expectedBehaviorPrompt: string;
  snapshot: GuiSnapshot;
  maxSteps: number;
}) {
  const raw = await openAIChatJson({
    llm: input.llm,
    label: 'Evaluator Planner Agent',
    temperature: 0.1,
    system: [
      'You are the LIVEUIAGENT Evaluator Planner Agent.',
      'Plan a concrete GUI behavior test for one already-open generated app.',
      'Use only these step kinds: fill, click, wait, observe.',
      'If you emit kind "wait", you must include milliseconds as an integer between 100 and 5000.',
      'Targets must be visible field labels, A2UI component ids, button text, or A2UI action ids from the snapshot. Buttons whose componentId ends in [N] are per-row entity buttons (text ends with · <entity name>) — use them to act on ONE specific listed item. Act ONLY on the items/people the expected behavior explicitly names — clicking a row button for anyone else corrupts the scenario (e.g. story says record Mel\'s repayment → click ONLY Mel\'s row, never Jon\'s). Match rows by the NAME in the button text, never by position.',
      'Before clicking a button, inspect that button contextFields list and fill every context field whose currentValue is empty.',
      'Prefer the button whose text or action best matches the expected behavior, but still fill its required contextFields first.',
      'Do not invent controls that are not in the snapshot.',
      'Do not close the app. Do not use browser devtools. Do not inspect backend files.',
      'Return only JSON with keys intent, steps, checks.',
    ].join(' '),
    user: {
      appName: input.appName,
      expectedBehaviorPrompt: input.expectedBehaviorPrompt,
      currentGuiSnapshot: input.snapshot,
      outputShape: {
        intent: 'short test intent',
        steps: [
          { kind: 'fill', target: 'visible field label or component id', value: 'test input value', rationale: 'why this is needed' },
          { kind: 'click', target: 'visible button text or action id', rationale: 'why this triggers the behavior' },
          { kind: 'wait', milliseconds: 1200, rationale: 'wait for GUI update' },
          { kind: 'observe', rationale: 'collect final visible state' },
        ],
        checks: ['observable expected behavior after the steps'],
      },
      maxSteps: input.maxSteps,
    },
  });
  try {
    return normalizePlan(raw, input.maxSteps);
  } catch (error) {
    // 规划器输出形状错(fill 缺 value 等)= LLM 质量方差,重掷一次而非杀整例。
    const retry = await openAIChatJson({
      llm: input.llm,
      label: 'Evaluator Planner Agent',
      temperature: 0.1,
      system: 'Your previous test plan was rejected: ' + String((error as Error).message).slice(0, 160) + '. Re-emit the FULL plan as JSON {intent, steps, checks}; every fill step MUST include both target and a non-empty value string.',
      user: { appName: input.appName, expectedBehaviorPrompt: input.expectedBehaviorPrompt, currentGuiSnapshot: input.snapshot, maxSteps: input.maxSteps },
    });
    return normalizePlan(retry, input.maxSteps);
  }
}

function compactGuiButton(button: NonNullable<GuiSnapshot['openApp']>['buttons'][number], includeContextFields = false) {
  return {
    componentId: String(button.componentId ?? '').slice(0, 160),
    actionId: String(button.actionId ?? '').slice(0, 160),
    text: String(button.text ?? '').slice(0, 300),
    disabled: Boolean(button.disabled),
    ...(includeContextFields && Array.isArray(button.contextFields) ? {
      contextFields: button.contextFields.slice(0, 24).map((field: Record<string, any>) => ({
        key: String(field.key ?? '').slice(0, 160),
        path: String(field.path ?? '').slice(0, 400),
        componentId: String(field.componentId ?? '').slice(0, 160),
        label: String(field.label ?? '').slice(0, 160),
        currentValue: String(field.currentValue ?? '').slice(0, 300),
      })),
    } : {}),
  };
}

function visibleSnapshotResult(snapshot: GuiSnapshot) {
  const result = snapshot.openApp?.result;
  if (!result) return undefined;
  // intentResult also contains summaries that a designed surface may omit.
  // Only text actually present in the surface is GUI evidence.
  const visibleText = String(snapshot.openApp?.text ?? '').replace(/\s+/g, ' ').trim();
  const fields = Object.entries(result).filter(([, value]) => {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 && visibleText.includes(normalized);
  });
  return fields.length ? Object.fromEntries(fields) : undefined;
}

function compactGuiSnapshot(snapshot: GuiSnapshot) {
  return {
    ...snapshot,
    openApp: snapshot.openApp ? {
      ...snapshot.openApp,
      buttons: snapshot.openApp.buttons.slice(0, 24).map((button) => compactGuiButton(button, true)),
      result: visibleSnapshotResult(snapshot),
    } : null,
    bodyText: String(snapshot.bodyText || '').slice(0, 3000),
  };
}

function compactMatched(matched?: Record<string, unknown>) {
  if (!matched) return undefined;
  // Keep the complete runtime response in the artifact, but never reveal
  // backend state or database statements to the GUI driver or judge.
  const visible: Record<string, string | boolean> = {};
  for (const key of ['componentId', 'actionId', 'text', 'label', 'value', 'appId'] as const) {
    if (typeof matched[key] === 'string') visible[key] = matched[key].slice(0, key === 'value' ? 1000 : 300);
  }
  if (typeof matched.reopened === 'boolean') visible.reopened = matched.reopened;
  return visible;
}

// Bound individual GUI evidence fields, while retaining every executed phase.
// Raw matched payloads remain in report.json; they are not GUI observations.
function compactObservations(observations: StepObservation[]) {
  return observations.map((item) => ({
    stepIndex: item.stepIndex,
    action: item.action,
    ok: item.ok,
    matched: compactMatched(item.matched),
    error: typeof item.error === 'string' ? item.error.slice(0, 300) : item.error,
    visibleTextAfterStep: item.snapshot?.openApp?.text.slice(0, 2400),
    visibleResultAfterStep: item.snapshot ? visibleSnapshotResult(item.snapshot) : undefined,
    fieldsAfterStep: ((item.snapshot?.openApp?.fields ?? []) as Array<Record<string, unknown>>).slice(0, 10)
      .map((field) => ({ label: field.label, value: String(field.value ?? '').slice(0, 120) })),
    buttonsAfterStep: (item.snapshot?.openApp?.buttons ?? []).slice(0, 10).map((button) => compactGuiButton(button)),
    dockStatusAfterStep: item.snapshot?.dockStatus,
  }));
}

async function judgeBehavior(input: {
  llm?: LlmRuntimeConfig;
  appName: string;
  expectedBehaviorPrompt: string;
  plan: EvaluatorPlan;
  before: GuiSnapshot;
  after: GuiSnapshot;
  observations: StepObservation[];
  pageErrors: string[];
}) {
  // judge 不因单次调用抖动丢判决:短重试;输入走同一预算(413 防线)。
  let raw: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      raw = await openAIChatJson({
    llm: input.llm,
    label: 'Evaluator Judge Agent',
    temperature: 0,
    system: [
      'You are the LIVEUIAGENT Evaluator Judge Agent.',
      'Judge whether the online GUI behavior trajectory satisfied the expected behavior prompt.',
      'Use only evidence from snapshots, executed steps, observations, and page errors.',
      'Passing requires visible GUI interaction, a coherent step-by-step trajectory, and observable state changes aligned with the expected behavior.',
      'For long-horizon behavior evaluation, inspect whether later actions used the state created by earlier actions, whether revisions preserved relevant context, and whether every click happened through a visible GUI control.',
      'If controls were missing, a step failed, the app did not update, or evidence is ambiguous, return passed=false.',
      'Return only JSON with keys passed, confidence, summary, evidence, failures.',
    ].join(' '),
    user: {
      appName: input.appName,
      expectedBehaviorPrompt: input.expectedBehaviorPrompt,
      plan: input.plan,
      beforeSnapshot: compactGuiSnapshot(input.before),
      afterSnapshot: compactGuiSnapshot(input.after),
      observations: compactObservations(input.observations),
      pageErrors: input.pageErrors,
      outputShape: {
        passed: true,
        confidence: 0.0,
        summary: 'one paragraph',
        evidence: ['specific visible evidence'],
        failures: ['specific missing or failing behavior'],
      },
    },
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.warn(`[evaluator] judge attempt ${attempt} failed, retrying: ${(error as Error).message}`);
    }
  }
  try {
    return normalizeVerdict(raw);
  } catch (error) {
    throw Object.assign(error as Error, { rawVerdict: raw, llmLabel: 'Evaluator Judge Agent' });
  }
}

async function runSteps(page: Page, plan: EvaluatorPlan, outDir: string): Promise<StepObservation[]> {
  const observations: StepObservation[] = [];
  for (const [index, action] of plan.steps.entries()) {
    const stepIndex = index + 1;
    try {
      let matched: Record<string, unknown> | undefined;
      if (action.kind === 'fill') matched = await fillField(page, action.target, action.value);
      if (action.kind === 'click') matched = await clickButton(page, action.target);
      if (action.kind === 'wait') await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
      const stepSnapshot = await snapshot(page);
      const screenshot = path.join(outDir, `step-${String(stepIndex).padStart(2, '0')}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      observations.push({ stepIndex, action, ok: true, matched, snapshot: stepSnapshot, screenshot });
    } catch (error) {
      const stepSnapshot = await snapshot(page).catch(() => undefined);
      const screenshot = path.join(outDir, `step-${String(stepIndex).padStart(2, '0')}-failed.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
      observations.push({
        stepIndex,
        action,
        ok: false,
        snapshot: stepSnapshot,
        screenshot,
        error: (error as Error).message,
      });
      break;
    }
  }
  return observations;
}

async function runBrowserEvaluatorAgent(input: EvaluatorRunInput): Promise<EvaluatorRunResult> {
  const appName = requireText(input.appName, 'appName required', 300);
  const expectedBehaviorPrompt = requireText(input.expectedBehaviorPrompt, 'expectedBehaviorPrompt required', 4000);
  const maxSteps = Math.max(1, Math.min(20, Math.round(Number(input.maxSteps ?? 8))));
  const llm = resolveLlmConfig(input.llm);
  const baseUrl = requireText(input.baseUrl || process.env.LIVEUIAGENT_EVALUATOR_URL || process.env.LIVEUIAGENT_FRONTEND_URL || `${input.apiBase || 'http://127.0.0.1:8787'}/liveui/`, 'baseUrl required', 400);
  const artifactsDir = path.resolve(input.outDir || process.env.LIVEUIAGENT_EVALUATOR_OUT || path.join('artifacts', 'evaluator', `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(appName)}`));
  await createEvaluatorArtifactsDirectory(artifactsDir);
  const trace: EvaluatorRunResult['trace'] = [];
  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      executablePath: resolveChromePath(input.chromePath),
      headless: input.headless ?? true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const { page, pageErrors } = await preparePage(browser, baseUrl, llm, input.user);
    const opened = await openApp(page, appName, Boolean(input.appId));
    trace.push({
      agent: 'Evaluator Runner',
      role: 'Open the target GUI app by name or id',
      input: { appName },
      output: opened,
      status: 'ok',
    });

    const before = await snapshot(page);
    const beforePath = path.join(artifactsDir, 'before.png');
    await page.screenshot({ path: beforePath, fullPage: true });

    const plan = await planBehavior({ llm, appName, expectedBehaviorPrompt, snapshot: before, maxSteps });
    trace.push({
      agent: 'Evaluator Planner Agent',
      role: 'Turn expected behavior prompt into GUI-only interaction steps',
      input: { appName, expectedBehaviorPrompt, fields: before.openApp?.fields, buttons: before.openApp?.buttons },
      output: plan,
      status: 'ok',
    });

    const observations = await runSteps(page, plan, artifactsDir);
    trace.push({
      agent: 'Evaluator Runner',
      role: 'Execute planned interactions against the live GUI',
      input: plan.steps,
      output: observations.map((item) => ({ stepIndex: item.stepIndex, ok: item.ok, matched: item.matched, error: item.error })),
      status: observations.every((item) => item.ok) ? 'ok' : 'failed',
    });

    const after = await snapshot(page);
    const afterPath = path.join(artifactsDir, 'after.png');
    await page.screenshot({ path: afterPath, fullPage: true });

    const verdict = await judgeBehavior({ llm, appName, expectedBehaviorPrompt, plan, before, after, observations, pageErrors });
    trace.push({
      agent: 'Evaluator Judge Agent',
      role: 'Check observed GUI behavior against expected behavior',
      input: { expectedBehaviorPrompt, pageErrors },
      output: verdict,
      status: verdict.passed ? 'ok' : 'failed',
    });

    const result: EvaluatorRunResult = {
      type: 'behavior_evaluation',
      channel: 'browser',
      appName,
      expectedBehaviorPrompt,
      baseUrl,
      artifactsDir,
      status: verdict.passed ? 'passed' : 'failed',
      plan,
      verdict,
      before,
      after,
      observations,
      screenshots: {
        before: beforePath,
        after: afterPath,
      },
      trace,
    };
    await fs.writeFile(path.join(artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    trace.push({
      agent: 'Evaluator Workflow',
      role: 'Fail fast on invalid evaluator setup or behavior test',
      input: { appName, expectedBehaviorPrompt, baseUrl },
      output: { error: (error as Error).message },
      status: 'failed',
    });
    throw Object.assign(error as Error, { trace });
  } finally {
    if (browser) await browser.close();
  }
}

function createHttpEvaluatorRuntime(apiBase: string, llm: ResolvedLlm, user?: string): EvaluatorBehaviorRuntime {
  const base = apiBase.replace(/\/+$/, '');
  async function post(pathname: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? { 'X-LiveUIAgent-User': user } : {}) },
      body: JSON.stringify({
        ...body,
        llm,
      }),
    });
    const text = await response.text();
    if (!text.trim()) throw new Error(`${pathname} returned an empty response`);
    const json = JSON.parse(text);
    if (!response.ok) throw new Error(requireText(json.error, `${pathname} error response missing message`, 1000));
    return json;
  }
  return {
    queryState(input: Record<string, unknown> = {}) {
      return post('/agent/query-state', input);
    },
    action(input: Record<string, unknown>) {
      return post('/agent/action', input);
    },
  };
}

export async function runEvaluatorAgent(input: EvaluatorRunInput, runtime?: EvaluatorBehaviorRuntime): Promise<EvaluatorRunResult> {
  // 已知联系人拼进权威行为脚本(驱动器/规划器/判官三方同源):表单要填某个人时
  // 必须用这些真实地址,绝不发明。
  if (input.knownPeople?.length) {
    const contacts = input.knownPeople
      .map((person) => [person.name, person.email ? `<${person.email}>` : '', person.phone ? `tel:${person.phone}` : ''].filter(Boolean).join(' '))
      .join('; ');
    input = { ...input, expectedBehaviorPrompt: `${input.expectedBehaviorPrompt}\n\n[The user of this app is LiveUIAgent Oracle (oracle@liveuiagent.dev) — "I"/"me" in the story above refers to LiveUIAgent Oracle. The user personally knows these people — whenever a form or action needs someone's contact, use these REAL addresses verbatim; NEVER invent an email or phone number: ${contacts}]` };
  }
  if (input.channel === 'browser' && !input.appId) return runBrowserEvaluatorAgent(input);
  const llm = resolveLlmConfig(input.llm);
  const apiBase = requireText(input.apiBase || process.env.LIVEUIAGENT_EVALUATOR_API_BASE || process.env.LIVEUIAGENT_API_URL || 'http://127.0.0.1:8787', 'apiBase required', 400);
  let service = runtime || createHttpEvaluatorRuntime(apiBase, llm, input.user);
  if (input.appId) {
    const requestedId = requireText(input.appId, 'appId required', 160);
    const original = service;
    service = {
      ...original,
      async queryState(request = {}) {
        const state = await original.queryState(request);
        const app = (state.apps || []).find((item: any) => item.appId === requestedId);
        if (!app) throw new Error(`Evaluator could not find exact appId: ${requestedId}`);
        if (app.appPackage?.manifest?.intent?.kind === 'complete_app') throw new Error('A2UI behavior evaluator does not support DSH complete apps');
        return { ...state, apps: [app] };
      },
      async action(request: any) {
        if (request.appId !== requestedId) throw new Error('Evaluator action targeted a different app');
        return original.action(request);
      },
    };
    await service.queryState({});
    input = { ...input, appName: requestedId };
  }
  if (input.channel === 'browser') return runBrowserEvaluatorAgent(input);
  return runBehaviorEvaluatorAgent({ ...input, apiBase, llm }, service);
}

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasArg(name: string) {
  return process.argv.includes(name);
}

async function main() {
  const appName = argValue('--app') || argValue('--app-name');
  const expectedBehaviorPrompt = argValue('--expect') || argValue('--expected-behavior') || argValue('--expected');
  const result = await runEvaluatorAgent({
    appName: requireText(appName, '--app required', 300),
    expectedBehaviorPrompt: requireText(expectedBehaviorPrompt, '--expect required', 4000),
    channel: hasArg('--browser') ? 'browser' : 'behavior',
    apiBase: argValue('--api-base'),
    baseUrl: argValue('--url'),
    outDir: argValue('--out'),
    chromePath: argValue('--chrome'),
    headless: !hasArg('--headed'),
    maxSteps: argValue('--max-steps') ? Number(argValue('--max-steps')) : undefined,
    horizonTurns: argValue('--horizon-turns') ? Number(argValue('--horizon-turns')) : undefined,
    llm: {
      apiKey: process.env.OPENAI_API_KEY,
      apiBase: process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL,
      model: process.env.LIVEUIAGENT_EVALUATOR_MODEL || process.env.LIVEUIAGENT_ORCHESTRATOR_MODEL,
    },
  });
  console.log(JSON.stringify({
    status: result.status,
    channel: result.channel,
    appName: result.appName,
    summary: result.verdict.summary,
    artifactsDir: result.artifactsDir,
    screenshots: result.screenshots,
    stateFiles: result.stateFiles,
  }, null, 2));
  if (result.status !== 'passed') process.exit(1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
