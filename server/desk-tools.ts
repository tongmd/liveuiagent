// Desk plugin surface: the read-only tools the Desk Agent calls in a loop to
// analyse the live whiteboard. Same registry shape as web-tools.ts (id / apiName /
// purpose / argsHint / invoke), so the catalog line format and the agent loop are
// shared rather than reimplemented.
//
// Why every tool here is READ-ONLY: acquireAppLock (liveuiagent.ts) is a promise-chain
// mutex and is NOT re-entrant. A write turn already holds the lock for its appId,
// so a tool that re-entered the same app's write path would self-deadlock forever
// (previous.then(...) never resolves, and there is no timeout). Writes stay in the
// unlocked desk layer, where the existing /agent/run routes own them.
import type Database from 'better-sqlite3';
import { webToolRegistry } from './web-tools.js';
import { loadCustomDeskTools } from './custom-tools.js';
import { clearUserLlmSettings, llmSettingsView, saveUserLlmSettings, type LlmSettingsView } from './llm-settings.js';

type JsonRecord = Record<string, unknown>;

export type DeskToolContext = {
  db: Database.Database;
  user: string;
  selectedAppId?: string;
  // Injected by liveuiagent.ts so this module does not re-implement the ownership gate
  // (getOwnedApp returns 404-not-403 on purpose: it must not leak that an appId
  // exists but belongs to someone else).
  listApps: (db: Database.Database, user: string) => Array<DeskStoredApp>;
  getApp: (db: Database.Database, appId: string, user: string) => DeskStoredApp | null;
  compact: (text: string, max: number) => string;
};

export type DeskStoredApp = {
  appId: string;
  appPackage: Record<string, any>;
  data: Record<string, Array<Record<string, unknown>>>;
  runtimeState: Record<string, unknown>;
  owner?: string;
};

export type DeskToolSpec = {
  id: string;
  apiName: string;
  label: string;
  purpose: string;
  argsHint: string;
  invoke(args: JsonRecord, ctx: DeskToolContext): Promise<JsonRecord>;
};

function toolFailure(message: string): JsonRecord {
  // Tool failures are DATA for the loop, not exceptions: a bad appId should let the
  // agent correct itself on the next step instead of killing the whole answer.
  return { ok: false, error: message };
}

function appSummary(stored: DeskStoredApp, compact: (t: string, m: number) => string) {
  const manifest = (stored.appPackage?.manifest ?? {}) as Record<string, any>;
  const runtime = stored.runtimeState as Record<string, any>;
  const entities = Array.isArray(runtime?.entities) ? runtime.entities : [];
  const stats = Array.isArray(runtime?.entityStats) ? runtime.entityStats : [];
  return {
    appId: stored.appId,
    name: compact(String(manifest.name || stored.appId), 60),
    description: compact(String(manifest.description || ''), 160),
    entityCount: entities.length,
    statCount: stats.length,
    lastTurn: compact(String(runtime?.lastSummary || ''), 140),
  };
}

export const deskToolRegistry: DeskToolSpec[] = [
  {
    id: 'tool.desk.list_apps',
    apiName: 'desk_list_apps',
    label: 'Desk App List Tool',
    purpose: 'List every app on the user\'s whiteboard with its id, name, purpose, how many live records and aggregates it currently holds, and its most recent turn summary. Start here to see what exists.',
    argsHint: '(no args)',
    invoke: async (_args, ctx) => {
      const apps = ctx.listApps(ctx.db, ctx.user).map((stored) => appSummary(stored, ctx.compact));
      return { ok: true, appCount: apps.length, selectedAppId: ctx.selectedAppId || '', apps };
    },
  },
  {
    id: 'tool.desk.read_app',
    apiName: 'desk_read_app',
    label: 'Desk App Read Tool',
    purpose: 'Read ONE app in depth: its real records (entities), its computed aggregates (stats), the form slots the user filled, and its declared actions. Use this to answer questions about what is actually inside an app.',
    argsHint: 'appId*',
    invoke: async (args, ctx) => {
      const appId = String(args.appId || '').trim();
      if (!appId) return toolFailure('desk_read_app requires appId');
      const stored = ctx.getApp(ctx.db, appId, ctx.user);
      if (!stored) return toolFailure(`no app "${appId}" on this whiteboard — call desk_list_apps for the valid ids`);
      const runtime = stored.runtimeState as Record<string, any>;
      const entities = (Array.isArray(runtime?.entities) ? runtime.entities : []).slice(0, 40);
      const stats = (Array.isArray(runtime?.entityStats) ? runtime.entityStats : []).slice(0, 8);
      const slots = (stored.appPackage?.ui?.meta?.a2ui?.initialData?.draft?.slots ?? {}) as JsonRecord;
      // The raw slots map is only {slot_1: "2026-07-10"} — no label, no declared type. An agent
      // asked "which apps have a date slot" then has to guess from the value shape, and guessing
      // is wrong: 三分账本 slot_1 (账单月份) is type=string whose value merely looks like a date.
      // Join each slot to its field spec so the type is read, never inferred.
      const fieldSpecs = (stored.appPackage?.orchestration?.dataModels?.[0]?.fields ?? []) as Array<Record<string, any>>;
      const specByName = new Map<string, Record<string, any>>(
        (Array.isArray(fieldSpecs) ? fieldSpecs : [])
          .filter((field) => field && typeof field === 'object' && field.name)
          .map((field) => [String(field.name), field]),
      );
      // Actions live at pkg.actions.actions as a KEYED OBJECT ("agent_turn_1.run": {label,
      // type, agentChain...}), not an array — reading it as an array made this tool always
      // return [] and the agent then truthfully reported that no app declares any action.
      const actionMap = (stored.appPackage?.actions?.actions ?? {}) as Record<string, any>;
      const actions: Array<Record<string, any>> = (actionMap && typeof actionMap === 'object' ? Object.entries(actionMap) : [])
        .filter(([, spec]) => spec && typeof spec === 'object')
        .map(([actionId, spec]) => ({ actionId, ...(spec as Record<string, any>) }));
      return {
        ok: true,
        ...appSummary(stored, ctx.compact),
        entities: entities.map((item: Record<string, any>) => ({
          name: ctx.compact(String(item?.name ?? ''), 80),
          detail: ctx.compact(String(item?.detail ?? ''), 120),
          ...(item?.group ? { group: ctx.compact(String(item.group), 40) } : {}),
        })),
        stats: stats.map((item: Record<string, any>) => ({
          label: ctx.compact(String(item?.label ?? ''), 40),
          value: ctx.compact(String(item?.value ?? ''), 60),
        })),
        slots: Object.entries(slots).slice(0, 16).map(([slotName, value]) => {
          const spec = specByName.get(slotName);
          return {
            slot: slotName,
            ...(spec?.label ? { label: ctx.compact(String(spec.label), 40) } : {}),
            ...(spec?.type ? { type: String(spec.type) } : {}),
            value: ctx.compact(value === null || value === undefined ? '' : String(value), 80),
          };
        }),
        actions: actions.slice(0, 8).map((item) => ({
          actionId: ctx.compact(String(item.actionId ?? ''), 40),
          label: ctx.compact(String(item?.label ?? ''), 40),
          ...(item?.description ? { description: ctx.compact(String(item.description), 120) } : {}),
        })),
      };
    },
  },
  {
    id: 'tool.desk.search_records',
    apiName: 'desk_search_records',
    label: 'Desk Record Search Tool',
    purpose: 'Search the live records of EVERY app at once by keyword, returning which app each match lives in. Use for cross-app questions ("where did I save X", "which app tracks Y") instead of reading apps one by one.',
    argsHint: 'query*',
    invoke: async (args, ctx) => {
      const query = String(args.query || '').trim().toLowerCase();
      if (!query) return toolFailure('desk_search_records requires query text');
      const matches: Array<JsonRecord> = [];
      for (const stored of ctx.listApps(ctx.db, ctx.user)) {
        const runtime = stored.runtimeState as Record<string, any>;
        const entities = Array.isArray(runtime?.entities) ? runtime.entities : [];
        const name = String((stored.appPackage?.manifest ?? {}).name || stored.appId);
        for (const item of entities) {
          const haystack = `${item?.name ?? ''} ${item?.detail ?? ''} ${item?.group ?? ''}`.toLowerCase();
          if (!haystack.includes(query)) continue;
          matches.push({
            appId: stored.appId,
            appName: ctx.compact(name, 60),
            name: ctx.compact(String(item?.name ?? ''), 80),
            detail: ctx.compact(String(item?.detail ?? ''), 120),
          });
          if (matches.length >= 30) break;
        }
        if (matches.length >= 30) break;
      }
      return { ok: true, query, matchCount: matches.length, matches };
    },
  },
  // Settings tools. These WRITE — but to user_llm_settings, never to an app, so the
  // acquireAppLock re-entrancy hazard above does not apply. The key itself is never
  // returned: tool results only ever carry the masked form from llmSettingsView.
  {
    id: 'tool.desk.get_settings',
    apiName: 'desk_get_settings',
    label: 'Desk Settings Read Tool',
    purpose: 'Read the user\'s LIVEUIAGENT model settings: the API URL base, whether an API key is saved (masked, never the key itself), the default model and the model list, plus what is actually in effect right now (own key vs shared server key) and any configuration warnings.',
    argsHint: '(no args)',
    invoke: async (_args, ctx) => ({ ok: true, ...settingsForAgent(llmSettingsView(ctx.db, ctx.user)) }),
  },
  {
    id: 'tool.desk.update_settings',
    apiName: 'desk_update_settings',
    label: 'Desk Settings Update Tool',
    purpose: 'Change the user\'s LIVEUIAGENT model settings. Pass only the fields to change: apiBase (http(s) URL), apiKey (the user\'s own provider key; pass "" to remove it), model (default model id), models (list of model ids for the picker). Pass reset=true to clear every saved setting and fall back to the server configuration. The change takes effect from the NEXT request — the current turn keeps the configuration it started with.',
    argsHint: 'apiBase, apiKey, model, models[], reset',
    invoke: async (args, ctx) => {
      if (args.reset === true) {
        clearUserLlmSettings(ctx.db, ctx.user);
        return { ok: true, reset: true, ...settingsForAgent(llmSettingsView(ctx.db, ctx.user)) };
      }
      const patch: JsonRecord = {};
      for (const key of ['apiBase', 'apiKey', 'model', 'models'] as const) {
        if (key in args && args[key] !== undefined && args[key] !== null) patch[key] = args[key];
      }
      if (!Object.keys(patch).length) return toolFailure('desk_update_settings needs at least one of apiBase / apiKey / model / models, or reset=true');
      try {
        saveUserLlmSettings(ctx.db, ctx.user, patch);
      } catch (error) {
        return toolFailure(String((error as Error)?.message || error));
      }
      return { ok: true, changed: Object.keys(patch), ...settingsForAgent(llmSettingsView(ctx.db, ctx.user)) };
    },
  },
];

// The agent-facing projection of the settings view: masked key only, plus a plain
// sentence about what is in effect so the model does not have to infer it.
function settingsForAgent(view: LlmSettingsView): JsonRecord {
  const source = view.effective.keySource === 'user'
    ? 'the user\'s own API key'
    : view.effective.keySource === 'server'
      ? 'the shared server key (model choices limited to the server whitelist)'
      : 'no API key at all — nothing can run until one is set';
  return {
    inEffect: { apiBase: view.effective.apiBase, model: view.effective.model, models: view.effective.models, apiKey: view.effective.apiKeyMasked || '(none)', using: source },
    saved: { apiBase: view.user.apiBase, apiKey: view.user.hasApiKey ? view.user.apiKeyMasked : '(none saved)', model: view.user.model, models: view.user.models, updatedAt: view.updatedAt },
    server: { apiBase: view.server.apiBase, hasApiKey: view.server.hasApiKey, model: view.server.model, models: view.server.models },
    warnings: view.warnings,
  };
}

export function findDeskTool(apiName: string): DeskToolSpec | undefined {
  return deskToolRegistry.find((tool) => tool.apiName === apiName);
}

// The FULL desk tool surface = builtin whiteboard readers + the external API tools
// generated apps already use (web search/fetch, weather, exchange rates) + user
// -installed command-line plugins (desk-plugins/*.json). Rebuilt on every call so a
// plugin file dropped in is live on the next sentence. The Router receives this same
// catalog — "what tools exist" and "what routes to the desk" can never drift apart.
export function deskToolSurface(): DeskToolSpec[] {
  const webTools: DeskToolSpec[] = webToolRegistry.map((tool) => ({
    id: tool.id,
    apiName: tool.apiName,
    label: tool.label,
    purpose: tool.purpose,
    argsHint: tool.argsHint,
    invoke: (args) => tool.invoke(args),
  }));
  const reservedNames = [...deskToolRegistry, ...webTools].map((tool) => tool.apiName);
  return [...deskToolRegistry, ...webTools, ...loadCustomDeskTools(reservedNames)];
}

// Same catalog line format as webToolCatalogLines, so both plugin families can be
// concatenated into one agent-visible tool list.
export function deskToolCatalogLines(tools: DeskToolSpec[]): string[] {
  return tools.map((tool) => `- ${tool.apiName}: ${tool.purpose} args(*=required): ${tool.argsHint}`);
}
