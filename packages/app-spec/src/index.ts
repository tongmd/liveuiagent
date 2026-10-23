export type Platform = 'web' | 'ios' | 'android';

export type FieldType = 'string' | 'text' | 'select' | 'boolean' | 'date' | 'number';

export type FieldSpec = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  hiddenInForm?: boolean;
  placeholder?: string;
  helpText?: string;
  display?: {
    emptyLabel?: string;
    prefix?: string;
    suffix?: string;
    format?: 'text' | 'date' | 'number' | 'currency' | 'temperature';
  };
  options?: Array<{ label: string; value: string }>;
};

export type ComponentType =
  | 'screen' | 'view' | 'stack' | 'row' | 'grid' | 'text' | 'heading' | 'button'
  | 'icon_button' | 'input' | 'textarea' | 'select' | 'checkbox' | 'switch' | 'form'
  | 'card' | 'data_list' | 'table_like_list' | 'kanban' | 'calendar' | 'chart'
  | 'modal' | 'sheet' | 'tabs' | 'file_upload' | 'image' | 'svg_icon' | 'markdown'
  | 'empty_state' | 'loading_state' | 'error_state';

export type UiComponent = {
  id: string;
  type: ComponentType | string;
  props?: Record<string, unknown>;
  events?: Record<string, string>;
  children?: UiComponent[];
};

export type GuiSurfaceSection = {
  id: string;
  role: 'identity' | 'result' | 'input' | 'actions' | 'detail' | 'records' | 'signals' | 'views';
  kind: 'icon' | 'card' | 'form' | 'grid' | 'data_list' | 'tabs';
  title: string;
  description?: string;
  order: number;
  emphasis?: 'primary' | 'secondary' | 'tertiary';
};

export type GuiSurfacePlan = {
  layoutVariant: 'focus' | 'split' | 'rail' | 'flow';
  sections: GuiSurfaceSection[];
  topSections: string[];
  notes: string[];
};

export type A2UIMessage = Record<string, unknown>;

export type A2UIActionMapping = {
  actionId: string;
  payloadSource: 'event.context' | 'event.context.payload';
};

export type A2UISurfaceSpec = {
  protocol: 'a2ui';
  version: 'v0.9';
  renderer: '@a2ui/react';
  catalogId: string;
  surfaceId: string;
  messages: A2UIMessage[];
  actionMap: Record<string, A2UIActionMapping>;
  initialData: Record<string, unknown>;
  generatedBy: 'a2ui-gui-agent';
};

export type ProposalToolInput = {
  id: string;
  label: string;
  purpose: string;
  source: 'core' | 'prompt' | 'appworld';
};

export type AgentOrchestrationNode = {
  id: string;
  name: string;
  role: string;
  purpose: string;
  model: string;
  tools: string[];
  memory: 'none' | 'app-scoped' | 'session-and-app';
  inputs: string[];
  outputs: string[];
  stateReads: string[];
  stateWrites: string[];
  priority: number;
};

export type AgentHandoff = {
  from: string;
  to: string;
  payload: string;
  reason: string;
};

export type AgentOrchestrationRoute = {
  id: string;
  entryActionId: string;
  entryAgent: string;
  agentChain: string[];
  handoffs: AgentHandoff[];
  schedulerClass: 'latency_first' | 'balanced' | 'reasoning';
  stateReads: string[];
  stateWrites: string[];
  feedbackTarget: string;
};

export type AgentOrchestrationDataModel = {
  id: string;
  displayName: string;
  primaryKey: string;
  dataSource: string;
  scope: 'app';
  storage: 'sqlite-json';
  fields: FieldSpec[];
};

export type AgentOrchestrationPlan = {
  plannedBy: 'orchestrator-agent';
  workflowId: string;
  sourcePromptHash: string;
  appAgentId: string;
  orchestratorAgentId: string;
  actionAgentId: string;
  dataAgentId: string;
  memoryAgentId: string;
  agents: AgentOrchestrationNode[];
  routes: AgentOrchestrationRoute[];
  dataModels: AgentOrchestrationDataModel[];
  uiPlan: GuiSurfacePlan;
  sharedState: Array<{
    id: string;
    label: string;
    ownerAgent: string;
    persistence: 'runtime' | 'app-data' | 'app-memory';
  }>;
  qualityGates: {
    generatedMoreThanCoreAgents: true;
    routesUseAgentChains: true;
    everyActionHasStateWrites: true;
  };
};

export type AppProposal = {
  plannedBy: 'proposer-agent';
  sourcePrompt: string;
  sourcePromptHash: string;
  appIdBase: string;
  name: string;
  description: string;
  subject: string;
  signature: string;
  workflowFocus: string;
  workflowResultFocus: string;
  iconInput: {
    plannedBy: 'icon-agent';
    motif: string;
    palette: string;
    brief: string;
    visualObjects: string[];
  };
  toolInputs: ProposalToolInput[];
  appAgentInput: {
    plannedBy: 'app-agent';
    tools: string[];
    iconInputs: string[];
    guiInputs: string[];
    memoryInputs: string[];
  };
  orchestrationInput: {
    plannedBy: 'orchestrator-agent';
    workflowId: string;
    requiredAgents: string[];
    handoffGoals: string[];
    sharedState: string[];
  };
  guiInput: {
    plannedBy: 'gui-agent';
    layoutId: string;
    surfacePlan: GuiSurfacePlan;
    topSections: string[];
    firstScreen: {
      inputComponentId: string;
      primaryActionComponentId: string;
      feedbackComponentId: string;
    };
    surfaceNotes: string[];
  };
  workflowOutline: Array<{
    pageId: string;
    inputSlot: string;
    actionSlot: string;
    feedbackSlot: string;
    stateWrites: string[];
    orchestrationRouteId?: string;
    entryAgent?: string;
    agentChain?: string[];
    handoffChain?: string[];
  }>;
};

export type PageInteractionSlot = {
  componentId: string;
  role:
    | 'primary_input'
    | 'follow_up_input'
    | 'primary_action'
    | 'secondary_action'
    | 'content_update'
    | 'content_delete'
    | 'content_toggle'
    | 'content_move'
    | 'result_refresh';
  intent: string;
  event?: string;
  actionId?: string;
};

export type PageInteractionContract = {
  pageId: string;
  purpose: string;
  interactionLogic: {
    entry: string;
    trigger: string;
    stateChange: string;
    feedback: string;
    agentHook: string;
  };
  primaryInput?: PageInteractionSlot;
  primaryAction: PageInteractionSlot;
  secondaryActions: PageInteractionSlot[];
  contentInteractions: PageInteractionSlot[];
  futureAgentHooks: Array<{
    hook: string;
    componentId: string;
    event: string;
    actionId: string;
    capability?: string;
  }>;
  emptyState?: {
    componentId: string;
    behavior: string;
  };
};

export type InteractionBlueprintSlot = {
  componentId: string;
  purpose: string;
  event?: string;
  actionId?: string;
  agent?: string;
  capability?: string;
  stateChange?: string;
};

export type PageInteractionBlueprint = {
  designedBy: 'interaction-blueprint-agent';
  pageId: string;
  userGoal: string;
  input: InteractionBlueprintSlot;
  primaryAction: InteractionBlueprintSlot;
  contentActions: InteractionBlueprintSlot[];
  feedback: {
    componentId: string;
    success: string;
    empty?: string;
    loading?: string;
  };
  futureAgentHooks: InteractionBlueprintSlot[];
  wiringNotes: string[];
};

export type UiFunctionPlanMeta = {
  plannedBy: 'function-planner-agent';
  sourcePromptHash: string;
  goal: string;
  functionSignature: string;
  primaryFunction: string;
  functions: Array<{
    id: string;
    label: string;
    verb: string;
    target: string;
    priority?: number;
    capability?: string;
    description?: string;
    sections?: string[];
  }>;
  visualObjects: string[];
  stateSignals: string[];
  topSections: string[];
};

export type AgentWorkflowPlan = {
  plannedBy: 'gui-workflow-agent';
  pageId: string;
  userGoal: string;
  functionSignature: string;
  surfacePlan: {
    layoutId: string;
    visualObjects: string[];
    topSections: string[];
  };
  firstScreen: {
    inputComponentId: string;
    primaryActionComponentId: string;
    feedbackComponentId: string;
  };
  interactionLoop: {
    input: InteractionBlueprintSlot;
    trigger: InteractionBlueprintSlot;
    feedback: PageInteractionBlueprint['feedback'];
    stateChange: string;
  };
  actionRoutes: Array<{
    componentId: string;
    event: string;
    actionId: string;
    endpoint: '/agent/action';
    agent: string;
    entryAgent?: string;
    agentChain?: string[];
    handoffs?: AgentHandoff[];
    schedulerClass: 'latency_first' | 'balanced' | 'reasoning';
    payloadSource: 'event.formData' | 'event.payload' | 'event.patch';
    expectedFeedbackComponentId: string;
    stateWrites: string[];
  }>;
  qualityGates: {
    pageHasUserEditableInput: true;
    inputAndActionShareFirstScreen: true;
    feedbackComponentDeclared: true;
    actionsRouteToAgent: true;
  };
};

export type GuiReview = {
  reviewedBy: 'gui-review-agent';
  score: number;
  checks: {
    hasPrimaryInput: boolean;
    hasPrimaryAction: boolean;
    hasContentAction: boolean;
    hasVisiblePreviewAction: boolean;
    hasInputNearTop: boolean;
    noWorkbenchCopy: boolean;
    noTemplateCopy: boolean;
    everyPageHasInteractionLogic: boolean;
  };
  findings: string[];
};

export type ValidationReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checkedBy: string;
};

export type AppManifest = {
  schemaVersion: string;
  appId: string;
  name: string;
  description: string;
  icon: string;
  entry: string;
  platforms: Platform[];
  layoutModes: Array<'phone' | 'tablet' | 'desktop'>;
  runtime: {
    renderer: string;
    minRuntimeVersion: string;
  };
  permissions: string[];
  backend: {
    type: 'agent';
    orchestratorAgent?: string;
    appAgent: string;
    actionAgent: string;
    dataAgent: string;
    memoryAgent?: string;
    safetyAgent?: string;
  };
  intent?: {
    agentApp?: boolean;
    kind?: 'agent_app';
    functionSignature?: string;
    goal?: string;
    visualObjects?: string[];
    sourcePrompt?: string;
    proposal?: AppProposal;
    orchestration?: AgentOrchestrationPlan;
  };
  version: string;
};

export type UiSpec = {
  schemaVersion: string;
  meta?: {
    generatedBy?: string;
    proposal?: AppProposal;
    orchestration?: AgentOrchestrationPlan;
    surfacePlan?: GuiSurfacePlan;
    a2ui?: A2UISurfaceSpec;
    functionPlan?: UiFunctionPlanMeta;
    agentWorkflow?: AgentWorkflowPlan[];
    interactionBlueprints?: PageInteractionBlueprint[];
    pageContracts?: PageInteractionContract[];
    guiReview?: GuiReview;
    [key: string]: unknown;
  };
  pages: Array<{
    id: string;
    title: string;
    layout: Record<string, unknown>;
    components: UiComponent[];
  }>;
};

export type ActionsSpec = {
  schemaVersion: string;
  actions: Record<string, unknown>;
};

export type DataSchemaSpec = {
  schemaVersion: string;
  models: Record<string, {
    id?: string;
    displayName?: string;
    primaryKey?: string;
    fields: FieldSpec[];
  }>;
  dataSources: Record<string, {
    model: string;
    scope?: 'app';
    storage?: string;
  }>;
};

export type AgentsSpec = {
  schemaVersion: string;
  agents: Record<string, {
    id?: string;
    name?: string;
    role: string;
    purpose?: string;
    model?: string;
    tools: string[];
    memory: string;
    inputs?: string[];
    outputs?: string[];
    stateReads?: string[];
    stateWrites?: string[];
    priority?: number;
    generatedBy?: string;
  }>;
  orchestration?: AgentOrchestrationPlan;
};

export type AppPackage = {
  manifest: AppManifest;
  ui: UiSpec;
  actions: ActionsSpec;
  dataSchema: DataSchemaSpec;
  agents: AgentsSpec;
  proposal?: AppProposal;
  orchestration?: AgentOrchestrationPlan;
  assets: {
    icon: {
      path: string;
      type: 'svg';
      safe: boolean;
      hash: string;
      svg: string;
    };
  };
  memory: Record<string, unknown>;
  safetyReport: ValidationReport;
};

export type AppRecord = {
  appId: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  status: string;
  records: number;
  updatedAt: string;
  preview: {
    accent: string;
    chips: string[];
    primaryCollection: string;
    primaryLabel: string;
    secondaryLabel?: string;
    metrics: Array<{
      id: string;
      label: string;
      value: string;
      tone?: 'default' | 'active' | 'urgent' | 'done';
    }>;
    sampleRecords: Array<{
      id: string;
      title: string;
      subtitle: string;
      badges: string[];
    }>;
    recentAction?: {
      title: string;
      detail: string;
      at: string;
      tone: 'default' | 'active' | 'danger' | 'done';
    };
    completeness: {
      label: string;
      value: number;
    };
    widget?: {
      kind: 'entities' | 'stats' | 'empty';
      items: Array<{
        id: string;
        name: string;
        detail: string;
        group?: string;
      }>;
      stats: Array<{
        label: string;
        value: string;
      }>;
      itemLabel: string;
    };
  };
  appPackage: AppPackage;
  appData: Record<string, Array<Record<string, unknown>>>;
  runtimeState: Record<string, unknown>;
};

export type CanvasNode = {
  id: string;
  type: 'app_card';
  appId: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  status: 'generating' | 'ready' | 'error';
};

export type CanvasEdge = {
  id: string;
  type: 'app_connection';
  sourceAppId: string;
  targetAppId: string;
  label: string;
  prompt: string;
  status: 'pending_confirmation' | 'active' | 'rejected';
  permissionsRequired: string[];
  createdAt: string;
};

export type CanvasState = {
  canvasId: string;
  selectedNodeId?: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
  inputDock: { position: 'bottom'; placeholder: string };
};

export type CanvasPatch = {
  op: 'move_node';
  canvasId: string;
  nodeId: string;
  position: { x: number; y: number };
};

export type CanvasPatchResponse = {
  canvasState: CanvasState;
  canvasPatch: CanvasPatch;
  message: string;
  error?: string;
  trace?: AgentTrace[];
};

export type AgentTrace = {
  agent: string;
  role: string;
  input?: unknown;
  output?: unknown;
  status: 'ok' | 'rejected';
};

export type QueryStateResponse = {
  canvasState: CanvasState;
  summary: {
    appCount: number;
    totalRecords: number;
    pendingConnections: number;
    text: string;
    apps: Array<Pick<AppRecord, 'appId' | 'name' | 'description' | 'version' | 'icon' | 'status' | 'records' | 'updatedAt' | 'preview'>>;
  };
  apps: AppRecord[];
};

export const componentAllowlist: ComponentType[] = [
  'screen', 'view', 'stack', 'row', 'grid', 'text', 'heading', 'button',
  'icon_button', 'input', 'textarea', 'select', 'checkbox', 'switch', 'form',
  'card', 'data_list', 'table_like_list', 'kanban', 'calendar', 'chart',
  'modal', 'sheet', 'tabs', 'file_upload', 'image', 'svg_icon', 'markdown',
  'empty_state', 'loading_state', 'error_state',
];

export const bannedComponents = [
  'script',
  'iframe',
  'webview',
  'raw_html',
  'custom_js',
  'dangerous_inner_html',
  'native_module',
  'shell_command',
];
