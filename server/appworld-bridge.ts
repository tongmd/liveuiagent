import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

type AppWorldConfig = {
  enabled: boolean;
  apiBase: string;
  snapshotRoot: string;
  exposeAllTools: boolean;
  apps?: string[];
  timeoutMs: number;
};

export type AppWorldToolCapability = {
  id: string;
  label: string;
  purpose: string;
  permission: string;
  source: 'appworld';
  appName: string;
  apiName: string;
  method: HttpMethod;
  path: string;
  operationId: string;
  requiresAuth?: boolean;
  requiredParams?: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
};

type AppWorldChangeLine = [string, unknown, boolean];

type AppWorldDbFileSnapshot = {
  path: string;
  changeCount: number;
  recentStatements: Array<{ statement: string; parameters: unknown; executemany: boolean }>;
};

export type AppWorldDbSnapshot = {
  label: string;
  dbHomePath: string;
  snapshotDir: string;
  takenAt: string;
  apps: Record<string, AppWorldDbFileSnapshot>;
};

export type AppWorldDbChangeSummary = {
  before: AppWorldDbSnapshot;
  after: AppWorldDbSnapshot;
  changedApps: Array<{
    appName: string;
    before: number;
    after: number;
    delta: number;
    recentStatements: Array<{ statement: string; parameters: unknown; executemany: boolean }>;
  }>;
};

export type AppWorldCallResult = {
  tool: AppWorldToolCapability;
  request: Record<string, unknown>;
  response: unknown;
  dbChanges: AppWorldDbChangeSummary | null;
};

export type AppWorldClock = {dateTime: string; timezone: 'UTC' | 'offset' | 'unspecified'; source: 'appworld:/date_time'};

export type AppWorldBridge = {
  config: AppWorldConfig;
  // 桥自注册身份的邮箱(oracle@liveuiagent.dev):金钱归一化层需要知道"付款人=我"的地址。
  identityEmail: string;
  getCapabilities(): Promise<AppWorldToolCapability[]>;
  getAppDescriptions(): Promise<Array<{ name: string; description: string }>>;
  findCapability(id: string): Promise<AppWorldToolCapability | undefined>;
  callTool(id: string, payload: Record<string, unknown>): Promise<AppWorldCallResult>;
  snapshotDb(label?: string): Promise<AppWorldDbSnapshot>;
  getClock?(): Promise<AppWorldClock | null>;
};

function compactText(input: string, max = 120) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function titleCase(input: string) {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function requiredText(value: unknown, message: string) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(message);
  return text;
}

function asRecord(value: unknown, message: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

async function fetchJson(url: string, options: RequestInit & { label: string; timeoutMs: number }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'LIVEUIAGENT-AppWorld-Bridge/0.1',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${options.label} failed ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${options.label} timed out after ${options.timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function flattenApiDocs(openapi: unknown, appName: string) {
  const doc = asRecord(openapi, `AppWorld openapi document for ${appName} must be an object`);
  const paths = asRecord(doc.paths, `AppWorld openapi document for ${appName} missing paths`);
  const tools: AppWorldToolCapability[] = [];
  for (const [routePath, methods] of Object.entries(paths)) {
    const routeMethods = asRecord(methods, `AppWorld openapi path ${routePath} must be an object`);
    for (const [methodRaw, operationRaw] of Object.entries(routeMethods)) {
      const method = methodRaw.toUpperCase() as HttpMethod;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) continue;
      const operation = asRecord(operationRaw, `AppWorld openapi operation ${appName} ${method} ${routePath} must be an object`);
      const operationId = requiredText(operation.operationId, `AppWorld operation ${appName} ${method} ${routePath} missing operationId`);
      // Use the full operationId as the api name: AppWorld operationIds embed
      // path params as `__param__`, so splitting on '__' collapses distinct
      // parameterized APIs into useless names like 'get'/'post'.
      const apiName = operationId;
      const summary = compactText(String(operation.summary || operation.description || apiName), 60);
      const description = compactText(String(operation.description || operation.summary || `${method} ${routePath}`), 240);
      const requestBody = operation.requestBody && typeof operation.requestBody === 'object'
        ? asRecord(operation.requestBody, `AppWorld operation ${operationId} requestBody must be an object`)
        : undefined;
      const requestSchema = requestBody?.content && typeof requestBody.content === 'object'
        ? (asRecord(requestBody.content, `AppWorld operation ${operationId} requestBody content must be an object`)['application/json'] as Record<string, unknown> | undefined)?.schema
        : undefined;
      const responses = operation.responses && typeof operation.responses === 'object'
        ? asRecord(operation.responses, `AppWorld operation ${operationId} responses must be an object`)
        : undefined;
      const outputSchema = responses?.['200'] && typeof responses['200'] === 'object'
        ? asRecord(responses['200'], `AppWorld operation ${operationId} response 200 must be an object`)
        : undefined;
      const requiredParams = (Array.isArray(operation.parameters) ? operation.parameters : [])
        .filter((param: any) => param && typeof param === 'object' && param.required === true)
        .map((param: any) => String(param.name || '')).filter(Boolean);
      tools.push({
        id: `tool.appworld.${appName}.${apiName}`,
        label: summary || titleCase(apiName),
        purpose: description,
        permission: `tool.appworld.${appName}.${apiName}`,
        source: 'appworld',
        appName,
        apiName,
        method,
        path: routePath,
        operationId,
        requiresAuth: Array.isArray(operation.security) && operation.security.length > 0,
        requiredParams,
        inputSchema: requestSchema,
        outputSchema,
      });
    }
  }
  return tools;
}

function normalizeArgs(payload: Record<string, unknown>) {
  for (const key of ['arguments', 'args', 'input', 'params', 'payload']) {
    const candidate = payload[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
  }
  return payload;
}

function readChangeFile(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as AppWorldChangeLine;
      const [statement, parameters, executemany] = parsed;
      return {
        statement: String(statement || ''),
        parameters,
        executemany: Boolean(executemany),
      };
    });
}

function summarizeSnapshot(label: string, dbHomePath: string, snapshotDir: string, appNames: string[]): AppWorldDbSnapshot {
  const apps: Record<string, AppWorldDbFileSnapshot> = {};
  for (const appName of appNames) {
    const filePath = path.join(snapshotDir, `${appName}.jsonl`);
    const lines = readChangeFile(filePath);
    apps[appName] = {
      path: filePath,
      changeCount: lines.length,
      recentStatements: lines.slice(-5).map((item) => ({
        statement: compactText(item.statement, 240),
        parameters: item.parameters,
        executemany: item.executemany,
      })),
    };
  }
  return {
    label,
    dbHomePath,
    snapshotDir,
    takenAt: new Date().toISOString(),
    apps,
  };
}

function diffSnapshots(before: AppWorldDbSnapshot, after: AppWorldDbSnapshot): AppWorldDbChangeSummary {
  const appNames = Array.from(new Set([
    ...Object.keys(before.apps),
    ...Object.keys(after.apps),
  ]));
  const changedApps = appNames
    .map((appName) => {
      const beforeCount = before.apps[appName]?.changeCount ?? 0;
      const afterCount = after.apps[appName]?.changeCount ?? 0;
      const delta = afterCount - beforeCount;
      if (delta === 0) return null;
      return {
        appName,
        before: beforeCount,
        after: afterCount,
        delta,
        recentStatements: after.apps[appName]?.recentStatements.slice(-Math.max(delta, 1)) ?? [],
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { before, after, changedApps };
}

function buildRequestUrl(base: string, routePath: string, args: Record<string, unknown>) {
  const usedKeys = new Set<string>();
  const renderedPath = routePath.replace(/\{([^}]+)\}/g, (_, rawName: string) => {
    const name = String(rawName).trim();
    const value = args[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`AppWorld request missing path parameter ${name} for ${routePath}`);
    }
    usedKeys.add(name);
    return encodeURIComponent(String(value));
  });
  const url = new URL(`${base.replace(/\/+$/, '')}${renderedPath}`);
  return { url, usedKeys };
}

function stripBodyArgs(args: Record<string, unknown>, usedKeys: Set<string>) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (usedKeys.has(key)) continue;
    if (key === 'sourceComponentId' || key === 'toolResults' || key === 'toolDbChanges' || key === 'dbChanges') continue;
    body[key] = value;
  }
  return body;
}

export function createAppWorldBridge(projectRoot: string): AppWorldBridge | null {
  const configPath = path.resolve(projectRoot, 'liveuiagent.config.json');
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const appworld = raw.appworld as Record<string, unknown> | undefined;
  if (!appworld || (process.env.APPWORLD_ENABLED === undefined ? !appworld.enabled : process.env.APPWORLD_ENABLED !== 'true')) return null;

  // APPWORLD_API_BASE overrides the config so parallel eval workers can each
  // target their own isolated AppWorld instance (worlds are in-memory per process).
  const apiBase = (process.env.APPWORLD_API_BASE || requiredText(appworld.apiBase, 'liveuiagent.config.json appworld.apiBase required when appworld.enabled=true')).replace(/\/+$/, '');
  const snapshotRoot = process.env.APPWORLD_SNAPSHOT_ROOT || requiredText(appworld.snapshotRoot, 'liveuiagent.config.json appworld.snapshotRoot required when appworld.enabled=true');
  const exposeAllTools = appworld.exposeAllTools === undefined ? true : Boolean(appworld.exposeAllTools);
  const timeoutMs = Number.isFinite(Number(appworld.timeoutMs)) ? Number(appworld.timeoutMs) : 15000;
  const explicitApps = Array.isArray(appworld.apps) ? appworld.apps.map((item) => String(item).trim()).filter(Boolean) : undefined;
  const config: AppWorldConfig = {
    enabled: true,
    apiBase,
    snapshotRoot: path.resolve(projectRoot, snapshotRoot),
    exposeAllTools,
    apps: explicitApps,
    timeoutMs,
  };

  let cachedTools: AppWorldToolCapability[] | null = null;
  let cachedAppNames: string[] | null = null;
  let cachedAppDescriptions: Array<{ name: string; description: string }> | null = null;

  // --- Oracle identity + per-app auth sessions -------------------------------
  // AppWorld apps require signup -> email verification (code sent to a gmail
  // inbox) -> login. A single fixed identity keeps this deterministic; gmail is
  // the identity root (its signup needs no verification).
  const oracleIdentity = {
    first_name: process.env.LIVEUI_ORACLE_FIRST_NAME || 'LiveUIAgent',
    last_name: 'Oracle',
    email: process.env.LIVEUI_ORACLE_EMAIL || 'oracle@liveuiagent.dev',
    phone_number: '5550100001',
    password: process.env.LIVEUI_ORACLE_PASSWORD || 'liveuiagent-oracle-1',
  };
  const sessionTokens = new Map<string, string>();

  async function tryLogin(appName: string): Promise<string | null> {
    const username = appName === 'phone' ? oracleIdentity.phone_number : oracleIdentity.email;
    const body = new URLSearchParams({ username, password: oracleIdentity.password }).toString();
    try {
      const result = await fetchJson(`${config.apiBase}/${appName}/auth/token`, {
        method: 'POST',
        label: `AppWorld ${appName} login`,
        timeoutMs: config.timeoutMs,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const token = String((result as Record<string, unknown>)?.access_token || '').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async function readVerificationCode(appName: string): Promise<string> {
    const gmailToken = await ensureSession('gmail');
    // 收件箱可能被基准种子邮件塞满(page_limit 上限 20):验证码邮件必须翻页找,
    // 否则 oracle 对新服务的注册在忙碌收件箱下必失败("no verification email found")。
    const matching: Array<Record<string, any>> = [];
    for (let page = 0; page < 5; page++) {
      const threads = await fetchJson(`${config.apiBase}/gmail/email_threads/category/inbox?page_limit=20&page_index=${page}`, {
        label: 'AppWorld gmail inbox',
        timeoutMs: config.timeoutMs,
        headers: { Authorization: `Bearer ${gmailToken}` },
      }) as Array<Record<string, any>>;
      if (!threads?.length) break;
      matching.push(...threads.filter((thread) =>
        JSON.stringify(thread.participants || '').toLowerCase().includes(`@${appName.replace(/_/g, '')}.com`)
        || String(thread.subject || '').toLowerCase().includes(appName.replace(/_/g, ' '))));
      if (matching.length) break;
    }
    const emailIds = matching.flatMap((thread) => (Array.isArray(thread.email_ids) ? thread.email_ids : []));
    if (!emailIds.length) throw new Error(`no verification email found for ${appName}`);
    const latest = Math.max(...emailIds.map(Number));
    const email = await fetchJson(`${config.apiBase}/gmail/emails/${latest}`, {
      label: 'AppWorld gmail verification email',
      timeoutMs: config.timeoutMs,
      headers: { Authorization: `Bearer ${gmailToken}` },
    }) as Record<string, any>;
    const match = String(email?.body || '').match(/code is:\s*([A-Za-z0-9]+)/);
    if (!match) throw new Error(`no verification code in ${appName} email ${latest}`);
    return match[1];
  }

  async function ensureSession(appName: string): Promise<string> {
    const cached = sessionTokens.get(appName);
    if (cached) return cached;
    let token = await tryLogin(appName);
    if (!token) {
      if (appName !== 'gmail') await ensureSession('gmail');
      const signupBody: Record<string, string> = {
        first_name: oracleIdentity.first_name,
        last_name: oracleIdentity.last_name,
        password: oracleIdentity.password,
        ...(appName === 'phone' ? { phone_number: oracleIdentity.phone_number } : { email: oracleIdentity.email }),
      };
      await fetchJson(`${config.apiBase}/${appName}/account`, {
        method: 'POST',
        label: `AppWorld ${appName} signup`,
        timeoutMs: config.timeoutMs,
        body: JSON.stringify(signupBody),
      }).catch(() => null); // account may already exist
      token = await tryLogin(appName);
      if (!token && appName !== 'gmail') {
        await fetchJson(`${config.apiBase}/${appName}/send_verification_code`, {
          method: 'POST',
          label: `AppWorld ${appName} send verification`,
          timeoutMs: config.timeoutMs,
          body: JSON.stringify({ email: oracleIdentity.email }),
        }).catch(() => null);
        const code = await readVerificationCode(appName);
        await fetchJson(`${config.apiBase}/${appName}/verify_account`, {
          method: 'POST',
          label: `AppWorld ${appName} verify`,
          timeoutMs: config.timeoutMs,
          body: JSON.stringify({ email: oracleIdentity.email, verification_code: code }),
        });
        token = await tryLogin(appName);
      }
    }
    if (!token) throw new Error(`AppWorld ${appName} session could not be established`);
    sessionTokens.set(appName, token);
    return token;
  }

  async function discoverApps() {
    if (cachedAppNames) return cachedAppNames;
    // AppWorld 0.1.x exposes the app catalog through the api_docs app
    // (`GET /api_docs/app_descriptions`), returning a list of {name, description}.
    const descriptions = await fetchJson(`${config.apiBase}/api_docs/app_descriptions`, {
      label: 'AppWorld app descriptions',
      timeoutMs: config.timeoutMs,
    });
    const discovered = Array.isArray(descriptions)
      ? descriptions.map((entry) => requiredText(
          asRecord(entry, 'AppWorld app description entry must be an object').name,
          'AppWorld app description entry missing name',
        ))
      : Object.keys(asRecord(descriptions, 'AppWorld /api_docs/app_descriptions must return a list or object'));
    const appNames = (config.apps && config.apps.length ? config.apps : discovered)
      .filter((name) => name !== 'admin' && name !== 'api_docs');
    if (!appNames.length) throw new Error('AppWorld did not expose any user apps');
    // 应用级描述供域选择 agent 使用(按需求语义挑服务,不做关键词匹配)。
    cachedAppDescriptions = Array.isArray(descriptions)
      ? (descriptions as Array<Record<string, unknown>>)
          .filter((entry) => appNames.includes(String(entry.name)))
          .map((entry) => ({ name: String(entry.name), description: String(entry.description || '') }))
      : appNames.map((name) => ({ name, description: '' }));
    cachedAppNames = appNames;
    return appNames;
  }

  async function getAppDescriptions() {
    await discoverApps();
    if (!cachedAppDescriptions) throw new Error('AppWorld app descriptions unavailable');
    return cachedAppDescriptions;
  }

  async function discoverTools() {
    if (cachedTools) return cachedTools;
    const appNames = await discoverApps();
    const tools: AppWorldToolCapability[] = [];
    for (const appName of appNames) {
      const openapi = await fetchJson(`${config.apiBase}/${appName}/openapi.json`, {
        label: `AppWorld openapi for ${appName}`,
        timeoutMs: config.timeoutMs,
      });
      tools.push(...flattenApiDocs(openapi, appName));
    }
    tools.push({
      id: 'tool.appworld.db.snapshot',
      label: 'AppWorld DB Snapshot',
      purpose: 'Save the current AppWorld database changes into a local snapshot directory for inspection.',
      permission: 'tool.appworld.db.snapshot',
      source: 'appworld',
      appName: '__meta__',
      apiName: 'db.snapshot',
      method: 'POST',
      path: '/dbs/save',
      operationId: 'appworld__db_snapshot',
    });
    cachedTools = tools;
    return tools;
  }

  async function getDbHomePath() {
    const dbs = await fetchJson(`${config.apiBase}/dbs`, {
      label: 'AppWorld database paths',
      timeoutMs: config.timeoutMs,
    });
    const values = Object.values(asRecord(dbs, 'AppWorld /dbs must return an object')).map((value) => String(value ?? '').trim()).filter(Boolean);
    const uniqueRoots = Array.from(new Set(values));
    if (uniqueRoots.length !== 1) {
      throw new Error(`AppWorld /dbs must resolve to one shared db home path, found: ${uniqueRoots.join(', ')}`);
    }
    return uniqueRoots[0];
  }

  async function writeSnapshot(label: string): Promise<AppWorldDbSnapshot> {
    const appNames = await discoverApps();
    const dbHomePath = await getDbHomePath();
    const snapshotDir = path.resolve(config.snapshotRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}-${label}`);
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
    await fetchJson(`${config.apiBase}/dbs/save`, {
      method: 'POST',
      label: 'AppWorld database snapshot',
      timeoutMs: config.timeoutMs,
      body: JSON.stringify({
        from_db_home_path: dbHomePath,
        to_db_home_path: snapshotDir,
        format: 'changes',
        app_names: appNames,
        delete_if_exists: true,
        skip_mandatory_apps: false,
        save_model_hashes: false,
        vaccum: false,
      }),
    });
    return summarizeSnapshot(label, dbHomePath, snapshotDir, appNames);
  }

  async function findCapability(id: string) {
    const tools = await discoverTools();
    return tools.find((tool) => tool.id === id);
  }

  async function callTool(id: string, payload: Record<string, unknown>): Promise<AppWorldCallResult> {
    const tool = await findCapability(id);
    if (!tool) throw new Error(`unknown AppWorld tool: ${id}`);
    const args = normalizeArgs(payload);
    if (tool.id === 'tool.appworld.db.snapshot') {
      const snapshot = await writeSnapshot('manual');
      return { tool, request: args, response: snapshot, dbChanges: null };
    }
    // Final enforcement for every execution path, including explicit MCP
    // calls. Catalog/schema discovery and evaluator snapshots remain usable;
    // fail before auth bootstrap can read mail or write account records.
    if (process.env.LIVEUIAGENT_APPWORLD_GROUNDING === 'off') {
      throw new Error(`AppWorld business tool disabled by LIVEUIAGENT_APPWORLD_GROUNDING=off: ${id}`);
    }
    // Session bootstrap (signup/verify/login) writes to the users table; run it
    // BEFORE the before-snapshot so those rows never land inside the scoring
    // window — otherwise the first authenticated call of a case credits a
    // db-change delta to a read-only GET (2026-07-26 scorer audit).
    if (tool.requiresAuth) await ensureSession(tool.appName);
    const before = await writeSnapshot(`before-${tool.appName}-${tool.apiName}`);
    // AppWorld mounts each app's OpenAPI paths under /{appName}; the per-app
    // openapi.json documents paths without that prefix.
    const { url, usedKeys } = buildRequestUrl(config.apiBase, `/${tool.appName}${tool.path}`, args);
    const queryKeys = ['GET', 'HEAD'].includes(tool.method) ? Object.keys(args).filter((key) => !usedKeys.has(key)) : [];
    for (const key of queryKeys) {
      const value = args[key];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      url.searchParams.set(key, String(value));
    }
    const body = !['GET', 'HEAD'].includes(tool.method) ? stripBodyArgs(args, usedKeys) : undefined;
    const callOnce = async () => fetchJson(url.toString(), {
      method: tool.method,
      label: `AppWorld tool ${tool.id}`,
      timeoutMs: config.timeoutMs,
      headers: tool.requiresAuth ? { Authorization: `Bearer ${await ensureSession(tool.appName)}` } : {},
      ...(body && Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
    });
    let response: unknown;
    try {
      response = await callOnce();
    } catch (error) {
      // A cached session can go stale if the world was reset under us; drop it and retry once.
      if (tool.requiresAuth && /\b401\b|not authorized|token is missing|expired/i.test((error as Error).message)) {
        sessionTokens.delete(tool.appName);
        response = await callOnce();
      } else {
        throw error;
      }
    }
    const after = await writeSnapshot(`after-${tool.appName}-${tool.apiName}`);
    const dbChanges = diffSnapshots(before, after);
    return {
      tool,
      request: args,
      response,
      dbChanges,
    };
  }

  return {
    config,
    identityEmail: oracleIdentity.email,
    async getClock() {
      try {
        const value = await fetchJson(`${config.apiBase}/date_time`, {label: 'AppWorld current clock', timeoutMs: Math.min(config.timeoutMs, 3000)});
        const dateTime = String((value as Record<string, unknown>)?.date_and_time || '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(dateTime) || !Number.isFinite(Date.parse(dateTime))) return null;
        return {dateTime, timezone: dateTime.endsWith('Z') ? 'UTC' : /[+-]\d{2}:\d{2}$/.test(dateTime) ? 'offset' : 'unspecified', source: 'appworld:/date_time'};
      } catch { return null; } // A missing/unavailable service clock falls back to the real host clock.
    },
    getCapabilities: discoverTools,
    getAppDescriptions,
    findCapability,
    callTool,
    snapshotDb: writeSnapshot,
  };
}
