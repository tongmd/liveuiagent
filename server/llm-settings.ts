// Per-user LLM settings (API URL base / API key / default model / model list).
//
// Precedence when a request needs an LLM (resolveLlm):
//   1. explicit key in the request body/headers  — an API client bringing its own key
//   2. the user's saved settings    — set via the Settings dialog or the Desk Agent
//   3. the server environment (OPENAI_API_KEY / OPENAI_API_BASE / LIVEUIAGENT_ORCHESTRATOR_MODEL)
// A user's apiBase only applies together with the user's own key: pointing the shared
// server key at a foreign endpoint would just fail there, so it is warned about, not done.
// On the shared server key the LIVEUIAGENT_MODEL_CHOICES whitelist still gates the model; on
// the user's own key any model id is accepted (it is their bill).
//
// Keys are stored as-is in the local SQLite file (same trust boundary as the env key)
// and are NEVER returned to a client or a tool — only maskKey() output leaves this module.
import type Database from 'better-sqlite3';
import type { LlmRuntimeConfig } from './liveuiagent.js';

export type UserLlmSettings = {
  apiBase: string;
  apiKey: string;
  model: string;
  models: string[];
};

export type LlmSettingsPatch = Record<string, unknown>;

export type LlmKeySource = 'explicit' | 'user' | 'server' | 'none';

export type ResolvedLlm = {
  llm: LlmRuntimeConfig | undefined;
  keySource: LlmKeySource;
  // Model ids the picker should offer for this resolution.
  models: string[];
  warnings: string[];
};

export type LlmSettingsView = {
  user: { apiBase: string; hasApiKey: boolean; apiKeyMasked: string; model: string; models: string[] };
  server: { apiBase: string; hasApiKey: boolean; model: string; models: string[] };
  effective: { apiBase: string; model: string; models: string[]; keySource: LlmKeySource; apiKeyMasked: string };
  warnings: string[];
  updatedAt: string | null;
};

const EMPTY: UserLlmSettings = { apiBase: '', apiKey: '', model: '', models: [] };

function badRequest(message: string): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  return error;
}

export function ensureLlmSettingsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_llm_settings (
      owner TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Server-side whitelist of model ids a user may pick on the SHARED server key
// (comma-separated LIVEUIAGENT_MODEL_CHOICES); the env default model is always first.
export function modelChoices(): string[] {
  const raw = String(process.env.LIVEUIAGENT_MODEL_CHOICES ?? '').trim();
  const list = raw ? raw.split(',').map((m) => m.trim()).filter(Boolean) : [];
  const envDefault = String(process.env.LIVEUIAGENT_ORCHESTRATOR_MODEL ?? '').trim();
  if (envDefault && !list.includes(envDefault)) list.unshift(envDefault);
  return list;
}

// LIVEUIAGENT_MODEL_ROUTES='{"gpt-5.6-sol":{"apiBase":"https://api.openlux.ai/v1","apiKey":"..."}}'
// — per-model provider routes for the shared server key. Not applied to user keys.
export function modelRoute(model: string): { apiBase?: string; apiKey?: string } | null {
  const raw = String(process.env.LIVEUIAGENT_MODEL_ROUTES ?? '').trim();
  if (!raw || !model) return null;
  try {
    const routes = JSON.parse(raw) as Record<string, { apiBase?: string; apiKey?: string }>;
    const hit = routes[model];
    return hit && typeof hit === 'object' ? hit : null;
  } catch {
    console.warn('[llm] LIVEUIAGENT_MODEL_ROUTES is not valid JSON; ignoring');
    return null;
  }
}

// LIVEUIAGENT_LLM_EXTRA_BODY='{"reasoning":{"enabled":false}}' — provider-specific request
// fields (e.g. OpenRouter reasoning switch) merged into every chat body.
export function llmExtraBody(): Record<string, unknown> {
  const raw = process.env.LIVEUIAGENT_LLM_EXTRA_BODY;
  if (!raw) return Object.create(null);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Object.create(null);
  } catch {
    return Object.create(null);
  }
}

export function serverLlmDefaults() {
  return {
    apiKey: String(process.env.OPENAI_API_KEY ?? '').trim(),
    apiBase: String(process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    model: String(process.env.LIVEUIAGENT_ORCHESTRATOR_MODEL ?? '').trim(),
    models: modelChoices(),
  };
}

export function maskKey(key: string | undefined): string {
  const value = String(key ?? '').trim();
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

// Log/label hygiene for prompts that may quote a key ("把 key 换成 sk-..."). Not a
// security boundary — the key is still in the request — just keeps it out of logs.
export function redactSecrets(text: string): string {
  return String(text ?? '').replace(/\b(sk|key|token)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}/gi, (m) => `${m.slice(0, 3)}…`);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean)));
}

function normalizeApiBase(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (text.length > 300) throw badRequest('apiBase too long');
  if (!/^https?:\/\/[^\s/]+/i.test(text)) throw badRequest('apiBase must be an http(s) URL, e.g. https://api.openai.com/v1');
  return text;
}

function normalizeModel(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length > 120) throw badRequest('model id too long');
  if (/\s/.test(text)) throw badRequest('model id must not contain whitespace');
  return text;
}

function normalizeModels(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\n,]/);
  const models = uniqueStrings(parts).map(normalizeModel).filter(Boolean);
  if (models.length > 40) throw badRequest('at most 40 models');
  return models;
}

function normalizeApiKey(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length > 400) throw badRequest('apiKey too long');
  if (/\s/.test(text)) throw badRequest('apiKey must not contain whitespace');
  return text;
}

export function loadUserLlmSettings(db: Database.Database, owner: string): UserLlmSettings & { updatedAt: string | null } {
  const row = db.prepare('SELECT settings_json, updated_at FROM user_llm_settings WHERE owner = ?').get(owner) as { settings_json: string; updated_at: string } | undefined;
  if (!row) return { ...EMPTY, updatedAt: null };
  let parsed: Partial<UserLlmSettings> = {};
  try { parsed = JSON.parse(row.settings_json) ?? {}; } catch { parsed = {}; }
  return {
    apiBase: String(parsed.apiBase ?? ''),
    apiKey: String(parsed.apiKey ?? ''),
    model: String(parsed.model ?? ''),
    models: Array.isArray(parsed.models) ? parsed.models.map(String).filter(Boolean) : [],
    updatedAt: row.updated_at,
  };
}

// Field semantics: a field that is absent from the patch is left unchanged; a present
// field is SET — an empty string clears it (apiKey: '' removes the saved key).
export function applyLlmSettingsPatch(current: UserLlmSettings, patch: LlmSettingsPatch): UserLlmSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('settings patch must be an object');
  const known = new Set(['apiBase', 'apiKey', 'model', 'models']);
  const unknown = Object.keys(patch).filter((key) => !known.has(key));
  if (unknown.length) throw badRequest(`unknown settings field(s): ${unknown.join(', ')}`);
  return {
    apiBase: 'apiBase' in patch ? normalizeApiBase(patch.apiBase) : current.apiBase,
    apiKey: 'apiKey' in patch ? normalizeApiKey(patch.apiKey) : current.apiKey,
    model: 'model' in patch ? normalizeModel(patch.model) : current.model,
    models: 'models' in patch ? normalizeModels(patch.models) : current.models,
  };
}

export function saveUserLlmSettings(db: Database.Database, owner: string, patch: LlmSettingsPatch): UserLlmSettings {
  const next = applyLlmSettingsPatch(loadUserLlmSettings(db, owner), patch);
  db.prepare(`
    INSERT INTO user_llm_settings (owner, settings_json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(owner) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).run(owner, JSON.stringify(next));
  return next;
}

export function clearUserLlmSettings(db: Database.Database, owner: string) {
  db.prepare('DELETE FROM user_llm_settings WHERE owner = ?').run(owner);
}

function pack(apiKey: string, apiBase: string, model: string): LlmRuntimeConfig {
  const out: LlmRuntimeConfig = { apiKey };
  if (apiBase) out.apiBase = apiBase;
  if (model) out.model = model;
  return out;
}

export function resolveLlmFrom(
  user: UserLlmSettings,
  server: ReturnType<typeof serverLlmDefaults>,
  requested: { apiKey?: string; apiBase?: string; model?: string } = {},
): ResolvedLlm {
  const warnings: string[] = [];
  const req = {
    apiKey: String(requested.apiKey ?? '').trim(),
    apiBase: String(requested.apiBase ?? '').trim().replace(/\/+$/, ''),
    model: String(requested.model ?? '').trim(),
  };

  if (req.apiKey) {
    const apiBase = req.apiBase || user.apiBase || server.apiBase;
    const model = req.model || user.model || server.model;
    return { llm: pack(req.apiKey, apiBase, model), keySource: 'explicit', models: uniqueStrings([model, ...user.models]), warnings };
  }

  if (user.apiKey) {
    const apiBase = user.apiBase || server.apiBase;
    if (!user.apiBase && server.apiBase) warnings.push(`Using the server API base: ${server.apiBase}`);
    const model = req.model || user.model || server.model;
    if (!user.model && !user.models.length && server.model) warnings.push(`Using the server model: ${server.model}`);
    // Own key: the picker offers the user's list; fall back to whatever model is in effect.
    const models = uniqueStrings([...user.models, user.model, ...(user.models.length || user.model ? [] : [server.model])]);
    return { llm: pack(user.apiKey, apiBase, model), keySource: 'user', models, warnings };
  }

  if (user.apiBase) warnings.push('Enter an API key to use your own API base. The server provider is currently selected.');

  if (server.apiKey) {
    const allowed = server.models;
    let model = '';
    for (const candidate of [req.model, user.model]) {
      if (!candidate) continue;
      if (!allowed.length || allowed.includes(candidate)) { model = candidate; break; }
      warnings.push(`Model "${candidate}" is unavailable on the server provider. Using ${server.model || allowed[0]}. Add your own API key to use this model.`);
    }
    model ||= server.model || allowed[0] || '';
    const route = modelRoute(model);
    return {
      llm: pack(String(route?.apiKey || server.apiKey), String(route?.apiBase || server.apiBase), model),
      keySource: 'server',
      models: allowed,
      warnings,
    };
  }

  // No key anywhere: downstream throws llm_config_required, which opens the Settings dialog.
  return { llm: undefined, keySource: 'none', models: uniqueStrings([...user.models, user.model]), warnings };
}

export function resolveLlm(
  db: Database.Database,
  owner: string,
  requested: { apiKey?: string; apiBase?: string; model?: string } = {},
): ResolvedLlm {
  return resolveLlmFrom(loadUserLlmSettings(db, owner), serverLlmDefaults(), requested);
}

export function llmSettingsView(db: Database.Database, owner: string): LlmSettingsView {
  const user = loadUserLlmSettings(db, owner);
  const server = serverLlmDefaults();
  const resolved = resolveLlmFrom(user, server);
  return {
    user: { apiBase: user.apiBase, hasApiKey: Boolean(user.apiKey), apiKeyMasked: maskKey(user.apiKey), model: user.model, models: user.models },
    server: { apiBase: server.apiBase, hasApiKey: Boolean(server.apiKey), model: server.model, models: server.models },
    effective: {
      apiBase: String(resolved.llm?.apiBase ?? ''),
      model: String(resolved.llm?.model ?? ''),
      models: resolved.models,
      keySource: resolved.keySource,
      apiKeyMasked: maskKey(resolved.llm?.apiKey),
    },
    warnings: resolved.warnings,
    updatedAt: user.updatedAt,
  };
}

// One tiny chat completion against the settings as they WOULD be after `draft` is
// applied (nothing is persisted). Any key echoed by the provider is scrubbed.
export async function testLlmConnection(
  db: Database.Database,
  owner: string,
  draft: LlmSettingsPatch = {},
): Promise<{ ok: boolean; keySource: LlmKeySource; apiBase: string; model: string; latencyMs: number; reply?: string; status?: number; error?: string }> {
  const merged = applyLlmSettingsPatch(loadUserLlmSettings(db, owner), draft);
  const resolved = resolveLlmFrom(merged, serverLlmDefaults());
  const apiKey = String(resolved.llm?.apiKey ?? '');
  const apiBase = String(resolved.llm?.apiBase ?? '');
  const model = String(resolved.llm?.model ?? '');
  const base = { keySource: resolved.keySource, apiBase, model };
  if (!apiKey) return { ok: false, ...base, latencyMs: 0, error: 'No API key configured' };
  if (!apiBase) return { ok: false, ...base, latencyMs: 0, error: 'No API base configured' };
  if (!model) return { ok: false, ...base, latencyMs: 0, error: 'No model selected' };
  const scrub = (text: string) => text.split(apiKey).join('[redacted]');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        ...llmExtraBody(),
        model,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, ...base, latencyMs, status: response.status, error: scrub(text).slice(0, 240) };
    let reply = '';
    try { reply = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? ''); } catch { /* non-JSON 200 */ }
    if (!reply.trim()) return { ok: false, ...base, latencyMs, status: response.status, error: `HTTP 200 but no message content: ${scrub(text).slice(0, 160)}` };
    return { ok: true, ...base, latencyMs, status: response.status, reply: reply.trim().slice(0, 80) };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? 'timed out after 30s' : String((error as Error)?.message || error);
    return { ok: false, ...base, latencyMs: Date.now() - startedAt, error: scrub(message).slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}
