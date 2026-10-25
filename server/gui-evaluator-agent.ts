import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { A2UISurfaceSpec, AppPackage, GuiReview } from '@liveuiagent/app-spec';

type A2UIComponent = Record<string, any> & {
  id: string;
  component: string;
};

type RenderedGuiMetrics = {
  totalComponents: number;
  visibleComponents: number;
  visibleTextLength: number;
  textFieldCount: number;
  buttonCount: number;
  highEmphasisTextCount: number;
  maxHighEmphasisTextLength: number;
  maxButtonTextLength: number;
  maxFieldLabelLength: number;
  actionBoundButtons: number;
  contextBoundButtons: number;
};

type GuiEvaluatorScores = {
  functionality: number;
  informationHierarchy: number;
  aesthetics: number;
  interactionNaturalness: number;
  crossPlatformReadiness: number;
  overall: number;
};

export type RenderedGuiEvaluation = {
  type: 'rendered_gui_evaluation';
  reviewedBy: 'gui-evaluator-agent';
  appId: string;
  appName: string;
  passed: boolean;
  threshold: number;
  scores: GuiEvaluatorScores;
  metrics: RenderedGuiMetrics;
  checks: GuiReview['checks'] & {
    hasA2uiSurface: boolean;
    hasResultBlock: boolean;
    hasSemanticInputSlots: boolean;
    everyButtonRoutesToAction: boolean;
    everyButtonHasContext: boolean;
    defaultRenderHasUsableFlow: boolean;
    noInternalCopyInDefaultRender: boolean;
    noOvercrowdedDefaultRender: boolean;
    noOversizedPrimaryText: boolean;
    fieldLabelsAreReadable: boolean;
    actionLabelsAreReadable: boolean;
  };
  findings: string[];
  blockingFindings: string[];
  visibleTextSample: string[];
  guiReview: GuiReview & {
    evaluator: 'rendered-a2ui';
    scores: GuiEvaluatorScores;
    metrics: RenderedGuiMetrics;
    blockingFindings: string[];
  };
};

export type GuiEvaluatorRunInput = {
  appName: string;
  appId?: string;
  user?: string;
  outDir?: string;
  apiBase?: string;
};

type GuiEvaluatorRuntime = {
  queryState(input?: Record<string, unknown>): Promise<any>;
};

function requireText(value: unknown, message: string, maxLength = 4000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim().slice(0, maxLength);
}

function requiredObject<T extends object>(value: unknown, message: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as T;
}

function requiredArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeTarget(value: string) {
  return value.toLowerCase().replace(/^actions\./, '').replace(/\s+/g, ' ').trim();
}

function slug(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'gui-evaluation';
}

function isInternalStateText(input: unknown) {
  const text = String(input ?? '').trim();
  return /(^|[;；\s])(?:prompt|context|state|nextStep|nextstep|runtimeState|agent trace|trace|payload|debug)\s*[:：]/i.test(text)
    || /[{[]\s*["']?(?:prompt|context|state|nextStep|runtimeState|payload)["']?\s*[:：]/i.test(text)
    || /\b(?:manifest|backend|actions\.json|memory dump|agent chain|workspace state)\b/i.test(text)
    || /工作台|仪表盘|商业数据|后端|调试面板/.test(text);
}

const genericVisibleFieldLabels = new Set(['主输入', '上下文', '输入', 'prompt', 'context', 'state', 'nextStep', 'result']);

function isGenericVisibleFieldLabel(label: unknown) {
  const text = String(label || '').trim();
  return genericVisibleFieldLabels.has(text) || genericVisibleFieldLabels.has(text.toLowerCase());
}

function collectA2uiComponents(surface: A2UISurfaceSpec): A2UIComponent[] {
  return requiredArray<Record<string, any>>(surface.messages, `A2UI surface ${surface.surfaceId} missing messages`)
    .flatMap((message) => {
      const update = message.updateComponents;
      if (!update) return [];
      return requiredArray<A2UIComponent>(update.components, `A2UI surface ${surface.surfaceId} updateComponents missing components`);
    });
}

function resolvePath(data: Record<string, unknown>, descriptor: unknown): unknown {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) || !('path' in descriptor)) return descriptor;
  const rawPath = requireText((descriptor as { path?: unknown }).path, 'A2UI binding missing path', 400);
  const parts = rawPath.replace(/^\//, '').split('/').filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`A2UI binding path ${rawPath} cannot be resolved`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function childIds(component: A2UIComponent): string[] {
  if (component.children !== undefined) return requiredArray<string>(component.children, `A2UI component ${component.id} children must be an array`);
  if (component.child !== undefined) return [requireText(component.child, `A2UI component ${component.id} child must be text`, 160)];
  return [];
}

function defaultVisibleComponentIds(components: Map<string, A2UIComponent>, rootId: string) {
  const visible: A2UIComponent[] = [];
  const walk = (componentId: string, visited = new Set<string>()) => {
    if (visited.has(componentId)) return;
    visited.add(componentId);
    const component = components.get(componentId);
    if (!component) throw new Error(`A2UI component not found: ${componentId}`);
    visible.push(component);
    if (component.component === 'Tabs') {
      const tabs = requiredArray<{ title: string; child: string }>(component.tabs, `Tabs ${component.id} missing tabs`);
      const first = tabs[0];
      if (!first) throw new Error(`Tabs ${component.id} has no tabs`);
      walk(requireText(first.child, `Tabs ${component.id} first tab missing child`, 160), visited);
      return;
    }
    if (component.component === 'List') return;
    for (const childId of childIds(component)) walk(childId, visited);
  };
  walk(rootId);
  return visible;
}

function textValue(component: A2UIComponent, data: Record<string, unknown>) {
  if (component.component === 'Text') return String(resolvePath(data, component.text) ?? '').trim();
  if (component.component === 'TextField') {
    const label = requireText(component.label, `TextField ${component.id} missing label`, 120);
    const value = String(resolvePath(data, component.value) ?? '').trim();
    return `${label}${value ? ` ${value}` : ''}`.trim();
  }
  return '';
}

function buttonText(component: A2UIComponent, components: Map<string, A2UIComponent>, data: Record<string, unknown>) {
  return childIds(component).map((childId) => {
    const child = components.get(childId);
    return child ? textValue(child, data) : '';
  }).join(' ').replace(/\s+/g, ' ').trim();
}

function actionIdFromButton(component: A2UIComponent) {
  const action = requiredObject<Record<string, any>>(component.action, `Button ${component.id} missing action`);
  const event = requiredObject<Record<string, any>>(action.event, `Button ${component.id} missing action event`);
  return requireText(event.name, `Button ${component.id} missing action name`, 160);
}

function buttonHasContext(component: A2UIComponent) {
  const action = requiredObject<Record<string, any>>(component.action, `Button ${component.id} missing action`);
  const event = requiredObject<Record<string, any>>(action.event, `Button ${component.id} missing action event`);
  const context = requiredObject<Record<string, unknown>>(event.context, `Button ${component.id} missing action context`);
  return Object.keys(context).length > 0;
}

function appActionExists(pkg: AppPackage, actionId: string) {
  const normalized = actionId.replace(/^actions\./, '');
  const actions = requiredObject<Record<string, unknown>>(pkg.actions?.actions, 'package missing actions');
  return Boolean(actions[normalized] || actions[actionId] || actions[normalized.replace(/\.run$/, '')]);
}

export function evaluateRenderedGui(input: { appPackage: AppPackage; appId?: string }): RenderedGuiEvaluation {
  const pkg = input.appPackage;
  const manifest = requiredObject<Record<string, any>>(pkg.manifest, 'package missing manifest');
  const appId = requireText(input.appId || manifest.appId, 'app missing appId', 160);
  const appName = requireText(manifest.name, `app ${appId} missing name`, 160);
  if (manifest.intent?.kind === 'complete_app') throw new Error('Rendered A2UI evaluator does not support DSH complete apps; the shell is not the generated GUI');
  const surface = requiredObject<A2UISurfaceSpec>(pkg.ui?.meta?.a2ui, `app ${appId} missing A2UI surface`);
  if (surface.protocol !== 'a2ui') throw new Error(`app ${appId} A2UI protocol is invalid`);
  const data = requiredObject<Record<string, unknown>>(surface.initialData, `app ${appId} A2UI missing initialData`);
  const componentList = collectA2uiComponents(surface);
  const components = new Map(componentList.map((component) => [requireText(component.id, 'A2UI component missing id', 160), component]));
  const root = components.get('root');
  if (!root) throw new Error(`app ${appId} A2UI missing root component`);
  const visibleComponents = defaultVisibleComponentIds(components, 'root');
  const allTextFields = componentList.filter((component) => component.component === 'TextField');
  const allButtons = componentList.filter((component) => component.component === 'Button');
  const visibleTexts = visibleComponents
    .flatMap((component) => {
      if (component.component === 'Tabs') {
        return requiredArray<{ title: string }>(component.tabs, `Tabs ${component.id} missing tabs`).map((tab) => requireText(tab.title, `Tabs ${component.id} tab missing title`, 80));
      }
      if (component.component === 'Button') return [buttonText(component, components, data)];
      return [textValue(component, data)];
    })
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const highTextLengths = visibleComponents
    .filter((component) => component.component === 'Text' && ['h1', 'h2', 'h3'].includes(String(component.variant || 'body')))
    .map((component) => textValue(component, data).length);
  const buttonTexts = allButtons.map((component) => buttonText(component, components, data)).filter(Boolean);
  const fieldLabels = allTextFields.map((component) => requireText(component.label, `TextField ${component.id} missing label`, 120));
  const actionBoundButtons = allButtons.filter((component) => {
    try {
      return appActionExists(pkg, actionIdFromButton(component));
    } catch {
      return false;
    }
  });
  const contextBoundButtons = allButtons.filter((component) => {
    try {
      return buttonHasContext(component);
    } catch {
      return false;
    }
  });
  const visibleTextLength = visibleTexts.join(' ').length;
  const metrics: RenderedGuiMetrics = {
    totalComponents: componentList.length,
    visibleComponents: visibleComponents.length,
    visibleTextLength,
    textFieldCount: allTextFields.length,
    buttonCount: allButtons.length,
    highEmphasisTextCount: highTextLengths.length,
    maxHighEmphasisTextLength: highTextLengths.length ? Math.max(...highTextLengths) : 0,
    maxButtonTextLength: buttonTexts.length ? Math.max(...buttonTexts.map((text) => text.length)) : 0,
    maxFieldLabelLength: fieldLabels.length ? Math.max(...fieldLabels.map((label) => label.length)) : 0,
    actionBoundButtons: actionBoundButtons.length,
    contextBoundButtons: contextBoundButtons.length,
  };
  const defaultIds = visibleComponents.map((component) => component.id);
  const firstFieldIndex = defaultIds.findIndex((id) => allTextFields.some((field) => field.id === id));
  const firstButtonIndex = defaultIds.findIndex((id) => allButtons.some((button) => button.id === id));
  // 结构化判定(不依赖模板 id):任何绑定 /draft/result 的 Text 即结果反馈区。
  const hasResultBlock = componentList.some((component) =>
    component.component === 'Text' && component.text && typeof component.text === 'object'
    && String((component.text as Record<string, unknown>).path || '') === '/draft/result');
  const semanticFieldCount = fieldLabels.filter((label) => !isGenericVisibleFieldLabel(label)).length;
  const noInternalCopy = visibleTexts.every((text) => !isInternalStateText(text));
  const noOvercrowded = metrics.textFieldCount <= 6 && metrics.buttonCount <= 6 && metrics.visibleTextLength <= 2600;
  const noOversizedPrimaryText = metrics.maxHighEmphasisTextLength <= 48;
  const fieldLabelsAreReadable = metrics.maxFieldLabelLength <= 18 && fieldLabels.every((label) => !isGenericVisibleFieldLabel(label));
  const actionLabelsAreReadable = metrics.maxButtonTextLength <= 18 && buttonTexts.every((text) => text.length > 0);
  const checks = {
    hasPrimaryInput: allTextFields.length > 0,
    hasPrimaryAction: allButtons.length > 0,
    hasContentAction: actionBoundButtons.length === allButtons.length && allButtons.length > 0,
    hasVisiblePreviewAction: defaultIds.some((id) => allButtons.some((button) => button.id === id)),
    hasInputNearTop: firstFieldIndex >= 0 && firstFieldIndex < 12,
    noWorkbenchCopy: noInternalCopy,
    noTemplateCopy: noInternalCopy,
    everyPageHasInteractionLogic: actionBoundButtons.length === allButtons.length && allButtons.length > 0,
    hasA2uiSurface: true,
    hasResultBlock,
    hasSemanticInputSlots: semanticFieldCount>=1 && semanticFieldCount<=6 && semanticFieldCount === allTextFields.length,
    everyButtonRoutesToAction: actionBoundButtons.length === allButtons.length && allButtons.length > 0,
    everyButtonHasContext: contextBoundButtons.length === allButtons.length && allButtons.length > 0,
    defaultRenderHasUsableFlow: firstFieldIndex >= 0 && firstButtonIndex > firstFieldIndex && hasResultBlock,
    noInternalCopyInDefaultRender: noInternalCopy,
    noOvercrowdedDefaultRender: noOvercrowded,
    noOversizedPrimaryText,
    fieldLabelsAreReadable,
    actionLabelsAreReadable,
  };
  const findings: string[] = [];
  const blockingFindings: string[] = [];
  const addFinding = (condition: boolean, message: string, blocking = false) => {
    if (condition) return;
    findings.push(message);
    if (blocking) blockingFindings.push(message);
  };
  addFinding(checks.hasPrimaryInput, 'Rendered GUI has no editable input slot.', true);
  addFinding(checks.hasPrimaryAction, 'Rendered GUI has no visible action button.', true);
  addFinding(checks.hasResultBlock, 'Rendered GUI has no visible result block.', true);
  addFinding(checks.hasSemanticInputSlots, 'Rendered GUI must expose 1-6 semantic input slots.', true);
  addFinding(checks.everyButtonRoutesToAction, 'One or more visible buttons do not route to a package action.', true);
  addFinding(checks.everyButtonHasContext, 'One or more visible buttons do not carry action context.', true);
  addFinding(checks.defaultRenderHasUsableFlow, 'Default render does not present input before action with visible result feedback.', true);
  addFinding(checks.noInternalCopyInDefaultRender, 'Default render leaks internal/debug/backend copy.', true);
  addFinding(metrics.buttonCount <= 6, 'Rendered GUI exceeds the bound of four composer and two row buttons.', true);
  addFinding(checks.noOvercrowdedDefaultRender, 'Default render is likely overcrowded.', false);
  addFinding(checks.noOversizedPrimaryText, 'Primary/high-emphasis text is too long for a polished app surface.', false);
  addFinding(checks.fieldLabelsAreReadable, 'Input labels are generic or too long.', true);
  addFinding(checks.actionLabelsAreReadable, 'Action labels are empty or too long.', true);

  const functionality = clampScore(100
    - (checks.hasPrimaryInput ? 0 : 25)
    - (checks.hasPrimaryAction ? 0 : 25)
    - (checks.everyButtonRoutesToAction ? 0 : 20)
    - (checks.everyButtonHasContext ? 0 : 10)
    - (checks.hasSemanticInputSlots ? 0 : 15));
  const informationHierarchy = clampScore(100
    - (checks.hasResultBlock ? 0 : 20)
    - (checks.defaultRenderHasUsableFlow ? 0 : 20)
    - (checks.noInternalCopyInDefaultRender ? 0 : 25)
    - Math.max(0, metrics.maxHighEmphasisTextLength - 36));
  const aesthetics = clampScore(100
    - (checks.noOvercrowdedDefaultRender ? 0 : 12)
    - (checks.noOversizedPrimaryText ? 0 : 10)
    - (checks.fieldLabelsAreReadable ? 0 : 12)
    - (checks.actionLabelsAreReadable ? 0 : 8)
    - Math.max(0, metrics.visibleTextLength - 1800) / 80);
  const interactionNaturalness = clampScore(100
    - (checks.defaultRenderHasUsableFlow ? 0 : 25)
    - (metrics.textFieldCount > 6 ? 10 : 0)
    - (metrics.buttonCount > 6 ? 10 : 0)
    - (checks.everyButtonHasContext ? 0 : 15));
  const crossPlatformReadiness = clampScore(100
    - (surface.renderer === '@a2ui/react' ? 0 : 12)
    - (metrics.totalComponents > 80 ? 10 : 0)
    - (metrics.maxButtonTextLength > 18 ? 8 : 0)
    - (metrics.maxFieldLabelLength > 18 ? 8 : 0));
  const scores: GuiEvaluatorScores = {
    functionality,
    informationHierarchy,
    aesthetics,
    interactionNaturalness,
    crossPlatformReadiness,
    overall: clampScore((functionality * 0.3) + (informationHierarchy * 0.22) + (aesthetics * 0.18) + (interactionNaturalness * 0.2) + (crossPlatformReadiness * 0.1)),
  };
  const threshold = 86;
  const passed = scores.overall >= threshold && blockingFindings.length === 0;
  const guiReview: RenderedGuiEvaluation['guiReview'] = {
    reviewedBy: 'gui-review-agent',
    evaluator: 'rendered-a2ui',
    score: scores.overall,
    scores,
    metrics,
    checks,
    findings,
    blockingFindings,
  };
  return {
    type: 'rendered_gui_evaluation',
    reviewedBy: 'gui-evaluator-agent',
    appId,
    appName,
    passed,
    threshold,
    scores,
    metrics,
    checks,
    findings,
    blockingFindings,
    visibleTextSample: visibleTexts.slice(0, 24),
    guiReview,
  };
}

export function assertRenderedGuiEvaluationPass(report: RenderedGuiEvaluation) {
  if (!report.passed) {
    throw new Error(`GUI evaluator failed for ${report.appId}: ${report.blockingFindings.concat(report.findings).join('; ')}`);
  }
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
  if (!app) throw new Error(`GUI evaluator could not find app: ${appName}`);
  return app;
}

export async function runGuiEvaluatorAgent(input: GuiEvaluatorRunInput, runtime?: GuiEvaluatorRuntime) {
  const appName = requireText(input.appName, 'appName required', 300);
  const service = runtime ?? createHttpRuntime(input.apiBase || process.env.LIVEUIAGENT_EVALUATOR_API_BASE || process.env.LIVEUIAGENT_API_URL || 'http://127.0.0.1:8787', input.user);
  const state = await service.queryState({});
  const app = input.appId
    ? (state.apps || []).find((item: any) => item.appId === input.appId)
    : findAppRecord(state, appName);
  if (!app) throw new Error(`GUI evaluator could not find exact appId: ${input.appId}`);
  const report = evaluateRenderedGui({ appPackage: app.appPackage, appId: app.appId });
  if (input.outDir) {
    const outDir = path.resolve(input.outDir);
    await fs.mkdir(path.dirname(outDir), { recursive: true });
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, 'gui-evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function createHttpRuntime(apiBase: string, user?: string): GuiEvaluatorRuntime {
  const base = apiBase.replace(/\/+$/, '');
  return {
    async queryState(input: Record<string, unknown> = {}) {
      const response = await fetch(`${base}/agent/query-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(user ? { 'X-LiveUIAgent-User': user } : {}) },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!text.trim()) throw new Error('/agent/query-state returned an empty response');
      const json = JSON.parse(text);
      if (!response.ok) throw new Error(requireText(json.error, '/agent/query-state error response missing message', 1000));
      return json;
    },
  };
}

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const appName = requireText(argValue('--app') || argValue('--app-name'), '--app required', 300);
  const outDir = argValue('--out') || path.join('artifacts', 'gui-evaluator', `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(appName)}`);
  const report = await runGuiEvaluatorAgent({ appName, outDir, apiBase: argValue('--api-base') });
  console.log(JSON.stringify({
    appId: report.appId,
    appName: report.appName,
    passed: report.passed,
    score: report.scores.overall,
    findings: report.findings,
    outDir: path.resolve(outDir),
  }, null, 2));
  if (!report.passed) process.exit(1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
