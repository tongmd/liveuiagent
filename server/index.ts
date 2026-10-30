import 'dotenv/config';
import {domesticHarnessFromEnv} from './domestic-harness-inference.js';
import {domesticHarnesses,harnessIds,harnessDefinition,selectHarnessModel,harnessLabel} from './harness-catalog.js';
import {createHarnessIntegration} from './harness-integration.js';
import {installDevelopmentRoutes} from './development-routes.js';
import {createDevelopmentContext} from './development-context.js';
import {createDevelopmentTestRunner} from './development-test-runner.js';
import type {HarnessId} from './runtime-settings.js';
import { createRichWorkspaces } from './rich-workspaces.js';
import { createCodexNativeInference } from './codex-native-inference.js';
import { createDshNativeInference } from './dsh-native-inference.js';
import { createNativeHarnessBindings } from './native-harness.js';
import { createPersonalization } from './personalization.js';
import { createCompleteApps } from './complete-apps.js';
import { createRuntimeSettings } from './runtime-settings.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createEvaluatorArtifacts } from './evaluator-artifacts.js';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createGuiInteractionPlanner } from './gui-interaction-planner.js';
import { createLiveUIRuntime, planNativeGuiInteractionStep, type LlmRuntimeConfig } from './liveuiagent.js';
import { createScheduledAgentGateway } from './agent-scheduler.js';
import { runEvaluatorAgent } from './evaluator-agent.js';
import { runGuiEvaluatorAgent } from './gui-evaluator-agent.js';
import { runCompleteAppEvaluator } from './complete-app-evaluator.js';
import { clearUserLlmSettings, ensureLlmSettingsTable, llmSettingsView, redactSecrets, resolveLlm, saveUserLlmSettings, testLlmConnection } from './llm-settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} required`);
  return value;
}

const port = Number(requireEnv('PORT'));
if (!Number.isFinite(port)) throw new Error('PORT must be numeric');
const dbPath = path.resolve(root, requireEnv('DB_PATH'));
const generatedAppsDir = path.resolve(root, requireEnv('GENERATED_APPS_DIR'));

fs.mkdirSync(generatedAppsDir, { recursive: true });

const db = openDb(dbPath);
ensureLlmSettingsTable(db);
const nativeHarnessBindings=createNativeHarnessBindings(db);
const nativeCodex=createCodexNativeInference();
const domesticRunners=Object.fromEntries(domesticHarnesses.map(({id})=>[id,domesticHarnessFromEnv(id,path.join(path.dirname(dbPath),'domestic-harness-workers'))]));
const nativeDshCommand=process.env.LIVEUI_NATIVE_DSH_COMMAND?.trim();
const nativeDsh=nativeDshCommand?createDshNativeInference({
  root:path.resolve(process.env.LIVEUI_NATIVE_DSH_ROOT||path.join(path.dirname(dbPath),'native-dsh-workers')),
  projectRoot:root,command:nativeDshCommand,
  diagnosticRoot:path.join(path.dirname(path.resolve(process.env.LIVEUI_NATIVE_DSH_ROOT||path.join(path.dirname(dbPath),'native-dsh-workers'))),'native-inference-diagnostics'),
  args:process.env.LIVEUI_NATIVE_DSH_ARGS?JSON.parse(process.env.LIVEUI_NATIVE_DSH_ARGS):undefined,
  timeoutMs:Number(process.env.LIVEUI_NATIVE_DSH_TIMEOUT_MS||120000),
  maxConcurrent:Number(process.env.LIVEUI_NATIVE_DSH_MAX_CONCURRENT||4),
}):undefined;
const liveuiagentRuntime = createLiveUIRuntime(db, { registryRoot: generatedAppsDir, projectRoot: root });
const agentGateway = createScheduledAgentGateway(liveuiagentRuntime);
const app = express();
// LIVEUI_AUTO_REPAIR_GATE_1143_BEGIN
const liveuiRepairMaintenancePath1143 = path.resolve(root, '..', '..', 'auto-repair-maintenance.json');
function liveuiRepairGateState1143() {
    try {
        const metadata = fs.lstatSync(liveuiRepairMaintenancePath1143);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return { active: false, transactionId: null };
        const marker = JSON.parse(fs.readFileSync(liveuiRepairMaintenancePath1143, 'utf8'));
        const now = Date.now();
        if (!marker || typeof marker.expiresAt !== 'number' || !Number.isFinite(marker.expiresAt)
            || marker.expiresAt <= now || marker.expiresAt > now + 180000
            || typeof marker.transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(marker.transactionId)) {
            return { active: false, transactionId: null };
        }
        return { active: true, transactionId: marker.transactionId };
    } catch {
        return { active: false, transactionId: null };
    }
}
app.get('/agent/repair-gate-status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(liveuiRepairGateState1143());
});
app.use((req, res, next) => {
    const writeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const readOnlyPost = req.method === 'POST' && ['/agent/scheduler-state', '/agent/query-state'].includes(req.path);
    if (writeMethod && !readOnlyPost && liveuiRepairGateState1143().active) {
        return res.status(503).set('Retry-After', '5').set('Cache-Control', 'no-store').json({
            error: 'liveUI is applying an automatic repair. Please try again shortly.',
            code: 'liveui_repair_maintenance', retryable: true,
        });
    }
    next();
});
// LIVEUI_AUTO_REPAIR_GATE_1143_END

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.get('/agent/identity', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const owner = requestUser(req);
  if (!owner) return res.status(401).json({error:'An authenticated owner is required for persisted drafts'});
  return res.json({ownerScope:createHash('sha256').update('liveui-native-draft-v1\0'+owner).digest('hex')});
});
app.get('/health',(_req,res)=>res.json({status:'ok',service:'liveuiagent',...(process.env.LIVEUIBENCH_RUN_ID?{benchmarkRunId:process.env.LIVEUIBENCH_RUN_ID}:{})}));
const evaluatorArtifacts=createEvaluatorArtifacts(process.env.LIVEUI_EVALUATION_DIR || path.join(path.dirname(dbPath),'evaluations'),requestUser);
evaluatorArtifacts.install(app);
const personal = createPersonalization(db, requestUser, llmConfigFromRequest);
personal.install(app);
if (process.env.LIVEUI_DEFAULT_HARNESS && !harnessIds.includes(process.env.LIVEUI_DEFAULT_HARNESS as HarnessId)) throw new Error('LIVEUI_DEFAULT_HARNESS must name a supported harness');
const completeApps=createCompleteApps(db,personal,requestUser,llmConfigFromRequest,{
  harnessFor:(req,appId)=>runtimeSettings.forRequest(req,appId),
  executionOf(req) {
    const llm=llmConfigFromRequest(req);
    const view=llmSettingsView(db,requestUser(req));
    return {model:llm?.model || view.effective.model || view.user.model,
      ...(llm?.apiKey && llm.apiBase ? {provider:{apiKey:llm.apiKey,apiBase:llm.apiBase}} : {})};
  },
});
const harnessIntegration=createHarnessIntegration({codex:nativeCodex,dsh:nativeDsh,domestic:domesticRunners,htmlConfigured:()=>completeApps.configured});
function harnessSelection(req:express.Request){
  const view=llmSettingsView(db,requestUser(req));
  return {owner:requestUser(req),models:view.effective.models,model:view.effective.model,keySource:view.effective.keySource,legacyCapabilities:()=>completeApps.capabilities(req)};
}
const runtimeSettings=createRuntimeSettings(db,{
  userOf:requestUser,
  defaultHarness:(process.env.LIVEUI_DEFAULT_HARNESS||'native') as HarnessId,
  onSelect(req,harness){
    if(harnessDefinition(harness)?.family){
      const view=llmSettingsView(db,requestUser(req));
      const model=selectHarnessModel(harness,view.effective.models,view.effective.model);
      if(model)saveUserLlmSettings(db,requestUser(req),{model});
    }
  },
  appHarnessOf:(req,appId)=>nativeHarnessBindings.get(requestUser(req),appId),
  choicesOf:req=>harnessIntegration.choices(harnessSelection(req)),
  async modelOf(req,harness){return harnessIntegration.model(harness,harnessSelection(req));},
});
runtimeSettings.install(app);
const development=installDevelopmentRoutes(app,db,{
  userOf:requestUser,llmOf:llmConfigFromRequest,harnessFor:req=>runtimeSettings.forRequest(req),
  context:createDevelopmentContext(db,{runtimeRoot:root,memoryOf:(owner,appId)=>personal.recall(owner,appId),dshRoot:process.env.LIVEUI_DEVELOPMENT_DSH_ROOT}),
  ...(process.env.LIVEUI_DEVELOPMENT_TEST_RUNNER?{runTest:createDevelopmentTestRunner(process.env.LIVEUI_DEVELOPMENT_TEST_RUNNER),
    allowedTests:{syntax:['Parse JavaScript files without execution'],test:['Run tests/development.test.mjs in the isolated test environment']}}:{}),
});
const richWorkspaces=createRichWorkspaces(db,{userOf:requestUser,harnessFor:(req,id)=>runtimeSettings.forRequest(req,id),llmOf:(req,id)=>{
  const selected=Object.assign(Object.create(req),{body:{...req.body,...(id?{appId:id}:{})}});
  return llmConfigFromRequest(selected);
},prepare:(req,llm,appId)=>personal.prepare(req,llm),memoryStatus:req=>personal.requestStatus(req),bindHarness:(owner,appId,harness)=>nativeHarnessBindings.save(owner,appId,harness as HarnessId),recall:(owner,appId,prompt)=>personal.recall(owner,appId)});
richWorkspaces.install(app);
completeApps.install(app);

// 每次请求解析一次 LLM 配置(见 llm-settings.ts 的优先级说明):
// 请求体/请求头里显式带 key(API 客户端自带 key) > 该用户在设置里保存的配置 > 服务端环境变量。
// 前端不再传 key —— 它只改设置;这里读出的 llm 从不回写给客户端。
function llmConfigFromRequest(req: express.Request): LlmRuntimeConfig | undefined {
  const body: Record<string, any> = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : Object.create(null);
  const harness = runtimeSettings.forRequest(req,String(body.appId||body.selectedAppId||'')||undefined);
  const explicit: Record<string, any> = (body.llm && typeof body.llm === 'object' && !Array.isArray(body.llm)) ? body.llm : Object.create(null);
  const requested = {
    apiKey: String(explicit.apiKey ?? req.header('x-liveuiagent-llm-key') ?? ''),
    apiBase: String(explicit.apiBase ?? req.header('x-liveuiagent-llm-base') ?? ''),
    model: String(explicit.model ?? req.header('x-liveuiagent-llm-model') ?? ''),
  };
  return harnessIntegration.connect(harness,{
    ...harnessSelection(req),appId:String(body.appId||body.selectedAppId||'')||undefined,delivery:body.delivery,
    personalContext:JSON.stringify(personal.context(requestUser(req),String(body.appId||body.selectedAppId||'global'))),requested,
    resolve(selected){
      const resolved=resolveLlm(db,requestUser(req),selected);
      for(const warning of resolved.warnings)console.warn(`[llm] ${requestUser(req)||'shared'}: ${warning}`);
      return resolved.llm;
    },
  });
}

// nginx basic auth 用户名(proxy_set_header X-LiveUIAgent-User $remote_user)。
// 直连 8787(本地开发/无 auth)时为空串 = 共享视角。
function requestUser(req: express.Request): string {
  return String(req.header('x-liveuiagent-user') ?? '').trim().slice(0, 60);
}

function requireBody(req: express.Request): Record<string, any> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new Error('request body must be an object');
  return req.body as Record<string, any>;
}

function requireRecord(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function requireText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

function errorPayload(err: any) {
  return {
    error: String(err?.message ?? 'server error'),
    ...(err?.code ? { code: err.code } : {}),
    ...(err?.retryable ? { retryable: err.retryable } : {}),
    ...(err?.requiredConfig ? { requiredConfig: err.requiredConfig } : {}),
    ...(err?.scheduler ? { scheduler: err.scheduler } : {}),
    ...(err?.trace ? { trace: err.trace } : {}),
    ...(err?.artifactsDir ? { artifactsDir:err.artifactsDir } : {}),
    ...(err?.workflowExecution ? { workflowExecution:err.workflowExecution } : {}),
    ...(err?.nativeInference ? { nativeInference:err.nativeInference } : {}),
    ...(err?.planningContractInvalid===true?{planningContractInvalid:true}:{}),
    ...(Number.isInteger(err?.plannerModelCalls) ? {plannerModelCalls:err.plannerModelCalls} : {}),
  };
}

// 生成 2-6 分钟、真实 API 回合 2-8 分钟:客户端带 Accept: text/event-stream 时
// 走 SSE —— 每个 agent 步骤/真实 API 调用推一条 progress,最后推 result 或 error。
// 进度通道挂在 llm 配置对象上(onProgress),沿现有参数链流到每次 LLM/API 调用。
async function respondWithProgress(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  logTag: string,
  exec: (llm: LlmRuntimeConfig | undefined) => Promise<unknown>,
  describeOk: (result: any) => string,
  // 消息中心任务行:给出标签就在 chat_history 里记 running → done/error,
  // JSON 与 SSE 两条路径共用这一个挂点。
  taskLabel?: string,
) {
  const startedAt = Date.now();
  const llm = llmConfigFromRequest(req);
  const owner = requestUser(req);
  const execute=async()=>{await personal.prepare(req,llm);const result=await exec(llm);return result&&typeof result==='object'?{...result,execution:{harness:runtimeSettings.forRequest(req,req.body?.appId||req.body?.selectedAppId),delivery:'native',model:llm?.model||llmSettingsView(db,owner).effective.model},contextualMemory:personal.requestStatus(req)}:result;};
  const taskHarness = runtimeSettings.forRequest(req,req.body?.appId||req.body?.selectedAppId);
  const taskPrompt = typeof req.body?.prompt==='string' ? req.body.prompt : req.body?.actionId ? JSON.stringify({appId:req.body.appId,actionId:req.body.actionId,input:req.body.eventPayload}) : '';
  const taskRowId = taskLabel ? recordTaskStart(owner, taskLabel, taskPrompt) : 0;
  const finishTask = (status: 'done' | 'error', text: string, code?: string) => {
    if (!taskRowId) return;
    // 配置弹窗回路(llm_config_required)不是任务失败:删行,别在消息中心刷屏。
    if (code === 'llm_config_required') {
      db.prepare('DELETE FROM chat_history WHERE id = ?').run(taskRowId);
      return;
    }
    recordTaskEnd(taskRowId, status, redactSecrets(`${text} · ${harnessLabel(taskHarness)} · ${llm?.model||''} · ${Math.round((Date.now() - startedAt) / 1000)}s`));
  };
  if (!String(req.header('accept') || '').includes('text/event-stream')) {
    try {
      const result = await execute();
      console.log(`[${logTag}] ok ${describeOk(result)} ${Date.now() - startedAt}ms`);
      finishTask('done', describeOk(result));
      res.json(result);
    } catch (e) {
      console.warn(`[${logTag}] FAIL ${Date.now() - startedAt}ms: ${(e as Error).message}`);
      finishTask('error', (e as Error).message, String((e as any)?.code || ''));
      next(e);
    }
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // nginx 默认 proxy_buffering 会把 SSE 帧(连 15s 心跳一起)扣在代理缓冲里,
    // 客户端整段静默直到链路被中间层掐断 —— 表现就是"跑了 58s 却收到空响应"。
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  if (llm) llm.onProgress = (step) => send('progress', { step, elapsedMs: Date.now() - startedAt });
  try {
    const result = await execute();
    console.log(`[${logTag}] ok ${describeOk(result)} ${Date.now() - startedAt}ms`);
    finishTask('done', describeOk(result));
    send('result', result);
  } catch (e) {
    console.warn(`[${logTag}] FAIL ${Date.now() - startedAt}ms: ${(e as Error).message}`);
    finishTask('error', (e as Error).message, String((e as any)?.code || ''));
    send('error', errorPayload(e));
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

app.post('/agent/run', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const prompt = requireText(body.prompt, 'prompt required');
    console.log(`[run] start "${redactSecrets(prompt).slice(0, 60)}"`);
    await respondWithProgress(req, res, next, 'run', async (llm) => {
      const result = await agentGateway.run({
      prompt,
      canvasState: body.canvasState,
      selectedAppId: body.selectedAppId,
      selectedNodeId: body.selectedNodeId,
      knownPeople:Array.isArray(body.knownPeople)?body.knownPeople:undefined,
      platform: requireText(body.platform, 'platform required') as any,
      latencyPreference: body.latencyPreference,
      deadlineMs: body.deadlineMs,
      userId: body.userId,
      sessionId: body.sessionId,
      user: requestUser(req),
      llm,
    });
      if (result.type === 'app_created' && result.appSummary?.appId) {
        nativeHarnessBindings.save(requestUser(req),result.appSummary.appId,runtimeSettings.forRequest(req));
        try { await personal.inheritAppearance(requestUser(req),result.appSummary.appId,prompt,llm); }
        catch { console.warn('[personal] New app created; appearance adaptation failed, saved preferences retained.'); }
      }
      return result;
    }, (result) => `"${redactSecrets(prompt).slice(0, 30)}" -> ${result?.appPackage?.manifest?.name ?? result?.type ?? '?'}`,
    `Create: ${redactSecrets(prompt).slice(0, 60)}`);
  } catch (e) { next(e); }
});

app.post('/agent/action', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const appId = requireText(body.appId, 'appId required');
    const actionId = requireText(body.actionId, 'actionId required');
    const windowId = body.windowId;  // optional: enables per-window parallelism
    console.log(`[action] start ${appId} ${actionId}${windowId ? ` window=${windowId}` : ''}`);
    await respondWithProgress(req, res, next, 'action', (llm) => agentGateway.action({
      appId,
      actionId,
      windowId,
      eventPayload: requireRecord(body.eventPayload, 'eventPayload required'),
      clientState: body.clientState,
      platform: requireText(body.platform, 'platform required') as any,
      latencyPreference: body.latencyPreference,
      deadlineMs: body.deadlineMs,
      userId: body.userId,
      sessionId: body.sessionId,
      user: requestUser(req),
      llm,
    }), (result) => String(result?.messages?.[0] || `${appId} ${actionId}`),
    (() => {
      // 任务行标签用应用名而不是内部 id。必须按 owner 过滤(共享应用 owner=''):
      // 无过滤会把别的用户的私有应用名写进本用户的消息中心。
      const row = db.prepare(`SELECT name FROM agent_apps WHERE app_id = ? AND owner IN ('', ?)`)
        .get(appId, requestUser(req)) as { name?: string } | undefined;
      return `Action: ${row?.name || appId} · ${actionId.replace(/^action_/, '')}`;
    })());
  } catch (e) { next(e); }
});

app.post('/agent/patch-canvas', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const canvasId = requireText(body.canvasId, 'canvasId required');
    const nodeId = requireText(body.nodeId, 'nodeId required');
    const position = requireRecord(body.position, 'position required');
    const current = await completeApps.merge(req, await agentGateway.queryState({
      userId: body.userId, sessionId: body.sessionId, deadlineMs: body.deadlineMs, user: requestUser(req),
    }));
    res.json(personal.moveCanvas(requestUser(req), {canvasId, nodeId, position}, current));
  } catch (e) { next(e); }
});

app.post('/agent/patch-app', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const llm=await personal.prepare(req,llmConfigFromRequest(req));
    const result=await agentGateway.patchApp({
      appId: requireText(body.appId, 'appId required'),
      prompt: requireText(body.prompt, 'prompt required'),
      latencyPreference: body.latencyPreference,
      deadlineMs: body.deadlineMs,
      user: requestUser(req),
      llm,
    });
    res.json({...result,execution:{harness:runtimeSettings.forRequest(req,body.appId),delivery:'native',model:llm?.model||llmSettingsView(db,requestUser(req)).effective.model}});
  } catch (e) { next(e); }
});

app.post('/agent/remove-app', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const appId = requireText(body.appId, 'appId required');
    const result = await agentGateway.removeApp({ appId, user: requestUser(req) });
    console.log(`[remove-app] ok ${appId} (${result?.name ?? '?'})`);
    res.json(result);
  } catch (e) { next(e); }
});

app.post('/agent/query-state', async (req, res, next) => {
  try {
    const body = requireBody(req);
    res.json(richWorkspaces.merge(req,personal.decorate(requestUser(req), await completeApps.merge(req,await agentGateway.queryState({
      userId: body.userId,
      sessionId: body.sessionId,
      deadlineMs: body.deadlineMs,
      user: requestUser(req),
    })))));
  } catch (e) { next(e); }
});

app.post('/agent/scheduler-state', async (_req, res, next) => {
  try {
    res.json(agentGateway.schedulerState());
  } catch (e) { next(e); }
});

// 聊天记录按 nginx basic-auth 用户落库,换设备登录同一账号即可看到历史。
// 直连(无 auth 头)时 owner='',即本机共享视角。
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_history_owner ON chat_history(owner, id);
`);
// 消息中心升级:kind='chat' 普通消息;kind='task' 任务生命周期行
// (status: running/done/error,label 任务名,text 结果句)。旧库迁移补列。
{
  const chatCols = new Set((db.prepare('PRAGMA table_info(chat_history)').all() as Array<{ name: string }>).map((col) => col.name));
  if (!chatCols.has('kind')) db.exec(`ALTER TABLE chat_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`);
  if (!chatCols.has('status')) db.exec(`ALTER TABLE chat_history ADD COLUMN status TEXT NOT NULL DEFAULT ''`);
  if (!chatCols.has('label')) db.exec(`ALTER TABLE chat_history ADD COLUMN label TEXT NOT NULL DEFAULT ''`);
}
// 服务重启时上一进程遗留的 running 任务行已死,如实标记中断,别永远转圈。
db.prepare(`UPDATE chat_history SET status = 'error', text = CASE WHEN text = '' THEN 'Task interrupted by a server restart' ELSE text END WHERE kind = 'task' AND status = 'running'`).run();

function recordTaskStart(owner: string, label: string, prompt: string): number {
  const info = db.prepare(`INSERT INTO chat_history (owner, role, text, prompt, kind, status, label) VALUES (?, 'agent', '', ?, 'task', 'running', ?)`)
    .run(owner, redactSecrets(prompt).slice(0,12000), redactSecrets(label).slice(0, 120));
  trimChatHistory(owner);
  return Number(info.lastInsertRowid);
}

// 每用户只保留最近 300 条。按"该用户第 300 新的行的 id"裁剪(id 序列全用户共享,
// 不能拿 MAX(id)-300 当阈值),且 running 中的任务行永不裁 —— 裁掉后 recordTaskEnd
// 会静默更新 0 行,任务永远显示进行中。
function trimChatHistory(owner: string) {
  const cutoff = db.prepare(
    'SELECT id FROM chat_history WHERE owner = ? ORDER BY id DESC LIMIT 1 OFFSET 299',
  ).get(owner) as { id: number } | undefined;
  if (!cutoff) return;
  db.prepare(`DELETE FROM chat_history WHERE owner = ? AND id < ? AND NOT (kind = 'task' AND status = 'running')`)
    .run(owner, cutoff.id);
}

function recordTaskEnd(taskRowId: number, status: 'done' | 'error', text: string) {
  db.prepare(`UPDATE chat_history SET status = ?, text = ? WHERE id = ? AND kind = 'task'`)
    .run(status, text.slice(0, 1000), taskRowId);
}

app.post('/agent/chat-append', (req, res, next) => {
  try {
    const body = requireBody(req);
    const text = redactSecrets(requireText(body.text, 'text required')).slice(0, 4000);
    const role = body.role === 'user' ? 'user' : 'agent';
    const prompt = typeof body.prompt === 'string' ? redactSecrets(body.prompt).slice(0, 2000) : '';
    const owner = requestUser(req);
    const info = db.prepare(`INSERT INTO chat_history (owner, role, text, prompt, kind) VALUES (?, ?, ?, ?, 'chat')`).run(owner, role, text, prompt);
    trimChatHistory(owner);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { next(e); }
});

app.post('/agent/chat-history', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT id, role, text, prompt, kind, status, label, created_at FROM chat_history WHERE owner = ? ORDER BY id DESC LIMIT 150').all(requestUser(req)) as Array<Record<string, unknown>>;
    res.json({ messages: rows.reverse() });
  } catch (e) { next(e); }
});

// 前端模型下拉数据源:该用户当前生效的模型列表 + 默认项(服务器托管时是白名单,
// 用户自带 key 时是设置里的模型列表)。绝不回 key/base 原文。
app.get('/agent/models', (req, res) => {
  const view = llmSettingsView(db, requestUser(req));
  res.json({
    models: view.effective.models,
    default: view.effective.model || null,
    serverManaged: view.server.hasApiKey,
    keySource: view.effective.keySource,
  });
});

// 设置:每用户一份(nginx basic-auth 用户名;直连为共享视角)。GET 只回脱敏视图,
// PUT 是补丁语义(没给的字段不动,给空串即清除),DELETE 整份清掉回落服务器配置。
app.get('/agent/settings', (req, res, next) => {
  try { res.json(llmSettingsView(db, requestUser(req))); } catch (e) { next(e); }
});

app.put('/agent/settings', (req, res, next) => {
  try {
    const body = requireBody(req);
    const owner = requestUser(req);
    saveUserLlmSettings(db, owner, body);
    console.log(`[settings] ${owner || 'shared'} updated ${Object.keys(body).join(',')}`);
    res.json(llmSettingsView(db, owner));
  } catch (e) { next(e); }
});

app.delete('/agent/settings', (req, res, next) => {
  try {
    const owner = requestUser(req);
    clearUserLlmSettings(db, owner);
    console.log(`[settings] ${owner || 'shared'} cleared`);
    res.json(llmSettingsView(db, owner));
  } catch (e) { next(e); }
});

// 用"保存后会生效的配置"发一次最小 chat completion,不落库;草稿字段可选。
app.post('/agent/settings/test', async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    res.json(await testLlmConnection(db, requestUser(req), body));
  } catch (e) { next(e); }
});

// Pure step planning: no app action, storage write or evaluator behavior loop.
app.post('/evaluator/interaction-step', createGuiInteractionPlanner({
  owner: requestUser,
  authorize(appId, owner) {
    const row = db.prepare('SELECT owner FROM agent_apps WHERE app_id=?').get(appId) as {owner:string}|undefined;
    if (!row || (row.owner && row.owner !== owner)) throw Object.assign(Error('Native app not found'), {status:404});
  },
  resolve(req, input) {
    // Only model/harness selection crosses this boundary. Credentials stay in
    // the same server resolver and DSH adapter used by Native runtime actions.
    const selected = Object.create(req) as express.Request;
    selected.body = {appId:input.appId,harness:input.harness,llm:{model:input.model}};
    const harness = runtimeSettings.forRequest(selected,input.appId);
    return {harness, llm:llmConfigFromRequest(selected)};
  },
  plan: planNativeGuiInteractionStep,
}));

app.post('/evaluator/run', async (req, res, next) => {
  try {
    const body = requireBody(req);
    const expectedBehaviorPrompt = body.expectedBehaviorPrompt ?? body.expectedBehavior ?? body.expectation;
    if(typeof body.appId==='string'&&body.appId.startsWith('dsh_')){
      res.json(await evaluateComplete(req,'behavior'));return;
    }
    const outDir=evaluatorArtifactDir(req);
    const report=await runEvaluatorAgent({
      appId:typeof body.appId==='string'?body.appId:undefined,
      user:requestUser(req),
      appName: requireText(body.appName, 'appName required'),
      expectedBehaviorPrompt: requireText(expectedBehaviorPrompt, 'expectedBehaviorPrompt required'),
      channel: body.channel === 'browser' ? 'browser' : 'behavior',
      apiBase: `http://127.0.0.1:${port}`,
      baseUrl: process.env.LIVEUI_FRONTEND_URL || `http://127.0.0.1:${port}`,
      outDir,
      chromePath: process.env.CHROME_PATH,
      headless: true,
      maxSteps: body.maxSteps === undefined ? undefined : Number(body.maxSteps),
      horizonTurns: body.horizonTurns === undefined ? undefined : Number(body.horizonTurns),
      knownPeople:Array.isArray(body.knownPeople)?body.knownPeople:undefined,
      llm: llmConfigFromRequest(req),
    }, evaluatorGateway(req));
    res.json(await evaluatorArtifacts.decorate(req,report,outDir));
  } catch (e) { next(e); }
});

app.post('/evaluator/gui', async (req, res, next) => {
  try {
    const body = requireBody(req);
    if(typeof body.appId==='string'&&body.appId.startsWith('dsh_')){
      res.json(await evaluateComplete(req,'gui'));return;
    }
    const outDir=evaluatorArtifactDir(req);
    const report=await runGuiEvaluatorAgent({
      appId:typeof body.appId==='string'?body.appId:undefined,
      appName: requireText(body.appName, 'appName required'),
      outDir,
      apiBase: `http://127.0.0.1:${port}`,
    }, evaluatorGateway(req));
    res.json(await evaluatorArtifacts.decorate(req,report,outDir));
  } catch (e) { next(e); }
});

function evaluatorArtifactDir(req:express.Request){
  return evaluatorArtifacts.directory(req);
}

async function evaluateComplete(req:express.Request,mode:'gui'|'behavior'){
  const body=requireBody(req),appId=requireText(body.appId,'appId required');
  const loaded=await completeApps.loadApp(req,appId);
  const outDir=evaluatorArtifactDir(req);
  const rawReport=await runCompleteAppEvaluator({appId,appName:loaded.app.name,html:loaded.html,store:loaded.store,mode,
    expectedBehaviorPrompt:mode==='behavior'?requireText(body.expectedBehaviorPrompt??body.expectedBehavior??body.expectation,'expectedBehaviorPrompt required'):undefined,
    steps:Array.isArray(body.steps)?body.steps:undefined,maxSteps:body.maxSteps===undefined?undefined:Number(body.maxSteps),
    llm:llmConfigFromRequest(req),chromePath:process.env.CHROME_PATH,
    outDir,
  },{ai:(prompt,context)=>completeApps.evaluateAction(req,appId,prompt,context)});
  const report=rawReport;
  // Browser probes use an isolated copy. Explicit promotion is opt-in so evaluation
  // cannot overwrite user edits made while the browser was running.
  if(mode==='behavior'&&report.passed&&body.persistStore===true){
    const current=await completeApps.loadApp(req,appId);
    const ordered=(store:Record<string,unknown>)=>JSON.stringify(Object.entries(store||{}).sort(([a],[b])=>a.localeCompare(b)));
    if(ordered(current.store)!==ordered(loaded.store))return evaluatorArtifacts.decorate(req,{...report,storagePersisted:false,persistenceError:'App storage changed during evaluation; no evaluator data was saved.'},outDir);
    await completeApps.saveStore(req,appId,report.finalStore);return evaluatorArtifacts.decorate(req,{...report,storagePersisted:true},outDir);
  }
  return evaluatorArtifacts.decorate(req,{...report,storagePersisted:false},outDir);
}

function evaluatorGateway(req:express.Request) {
  const user=requestUser(req);
  return {
    queryState:(input:any={})=>agentGateway.queryState({...input,user}),
    action:(input:any)=>agentGateway.action({...input,user,llm:llmConfigFromRequest(req)}),
  };
}

const dist = path.resolve(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(async(err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status ?? 500;
  if (status >= 500) console.error(err);
  let payload:any=errorPayload(err);
  if(err?.artifactsDir){try{payload=await evaluatorArtifacts.decorate(req,payload,err.artifactsDir);}catch{delete payload.artifactsDir;}}
  res.status(status).json(payload);
});

const host=process.env.HOST || '0.0.0.0';
const httpServer=app.listen(port, host, () => console.log(`LiveUI Agent (LIVEUIAGENT on) http://${host}:${port}`));
let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;
  shuttingDown=true;
  // Stop admission first. Native DSH disposal aborts and then waits for its
  // owned process groups to close before the host is allowed to exit.
  const force=setTimeout(()=>{
    httpServer.closeAllConnections();
    process.exit(1);
  },15000);
  force.unref();
  const closed=new Promise<void>(resolve=>httpServer.close(()=>resolve()));
  httpServer.closeIdleConnections();
  try {
    await development.dispose();
    await nativeDsh?.dispose();
    for(const runner of Object.values(domesticRunners))runner?.dispose();
    await closed;
    clearTimeout(force);
    db.close();
    process.exit(0);
  } catch {
    // Provider and child diagnostics can contain private inputs. The detailed
    // failure belongs to its authenticated task response, not shutdown logs.
    console.error('Native worker shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM',()=>{void shutdown();});
process.once('SIGINT',()=>{void shutdown();});
