import {beginRegisteredGuiNativeAttempt}from'./gui-planning-recovery.js';
import {createNativeInputCapture} from './native-input-capture.js';
import {nativeStructuredJsonPolicyMetadata} from './native-structured-json-policy.js';
import {persistNativeInferenceDiagnostic} from './native-inference-diagnostics.js';
import fs from 'node:fs/promises';
import { createNativeDshRelay } from './dsh-native-relay.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// DSH is the reasoning harness for a host-controlled Native agent. No DSH tool
// executes AppWorld actions: the host validates the returned JSON and owns API
// permissions, SQLite writes, agent handoffs and Native UI state.
export const NATIVE_DSH_DISABLED_PLUGINS = [
  'tool-plugin-manager', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs',
  'tool-fs-search', 'tool-skill', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-web',
  'mcp-resources', 'workflow-ptc', 'skill-filesystem',
  'session-title-llm', 'session-telemetry-otel', 'plugin-manager',
  'config-editor', 'settings', 'command-feedback', 'command-goal', 'plan-mode',
  'llm-retry', 'compaction-basic', 'command-compact', 'tool-result-pruner', 'image-offload', 'agent-instructions',
];
export const NATIVE_DSH_TOOL_GUARD = `export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => 'Native reasoning workers cannot execute tools. The host owns business operations.');
  ctx.on('agent/created', ({agent}) => agent.ctx.tools.restrict({allow: []}));
  ctx.provide('nativeReasoningBoundary', {tools: 'denied'});
}
`;
export function nativeDshProfilePatch(guardPath?:string) {
  return NATIVE_DSH_DISABLED_PLUGINS.map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    '- id: system-prompt\n  config:\n    personaPrefix: >-\n      You are a Native application agent reasoning worker. Return the exact JSON requested by the host. You have no tools. The host owns all external APIs, databases, UI rendering and agent orchestration. Never claim that you executed an external operation.\n    personaSuffix: ""\n' + (guardPath ? '- insert:\n    - id: native-reasoning-boundary\n      name: '+JSON.stringify(guardPath)+'\n- id: headless-runner\n  inject: [headlessStartup, nativeReasoningBoundary]\n' : '');
}

type Runner = {
  run(input: {work:string;home:string;task:string;model:string;provider?:{apiBase:string;apiKey:string};signal:AbortSignal;onEvent:(event:any)=>void;onDiagnostic?:(event:any)=>void}): Promise<{answer:string}>;
  dispose(): Promise<void>;
};
type Config = {
  root: string;
  projectRoot: string;
  diagnosticRoot?: string;
  /** Opt-in private host request capture, sibling of this adapter task root only. */
  diagnosticInputRoot?: string;
  command: string;
  args?: string[];
  provider?: {apiBase:string;apiKey:string};
  maxConcurrent?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
  runnerFactory?: (config:{command:string;args:string[];passEnv:string[];isolatedHome?:boolean}) => Runner | Promise<Runner>;
};
const transportError = (message:string,code:string) => Object.assign(new Error(message),{code});

export function nativeDshTask(request: Record<string,unknown>, maxBytes = 2 * 1024 * 1024) {
  if (!Array.isArray(request.messages) || !request.messages.length) throw transportError('Native DSH requires the complete message list','dsh_native_messages_required');
  if(typeof request.model!=='string'||!request.model.trim())throw transportError('Native DSH model is required','dsh_native_model_required');
  // The entire host-supplied conversation and schema are transmitted. Oversized
  // requests fail instead of silently pruning history or truncating a handoff.
  const payload=JSON.stringify(request);
  if(Buffer.byteLength(payload)>maxBytes)throw transportError('Native DSH request exceeds the configured context transfer limit','dsh_native_context_too_large');
  return 'Produce the next assistant response for this exact host conversation. Respect its ordered system, user, assistant and tool messages. This is a JSON reasoning task, not a request to create files or execute tools. The host will validate your answer and execute any allowed business operation itself. Return only the requested JSON object, without Markdown fences or commentary. Do not shorten the supplied context.\n\nComplete host inference request (JSON):\n'+payload;
}

export function parseNativeDshAnswer(answer:string) {
  if(typeof answer!=='string'||!answer.trim())throw transportError('Native DSH returned no final answer','dsh_native_empty_answer');
  // Strict JSON avoids accepting an unrelated object hidden inside prose or a
  // shell transcript as a valid agent result.
  let parsed:unknown;
  try { parsed=JSON.parse(answer); } catch { throw transportError('Native DSH final answer was not valid JSON','dsh_native_invalid_json'); }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw transportError('Native DSH final answer must be a JSON object','dsh_native_invalid_json');
  return parsed;
}

export function createDshNativeInference(config:Config) {
  if(!path.isAbsolute(config.root)||!path.isAbsolute(config.projectRoot))throw new Error('Native DSH paths must be absolute');
  if(config.diagnosticRoot&&!path.isAbsolute(config.diagnosticRoot))throw new Error('Native diagnostics path must be absolute');
  if(!config.command.trim())throw new Error('Native DSH command required');
  const maxConcurrent=config.maxConcurrent??4;
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw new Error('Native DSH maxConcurrent must be 1–8');
  const inputCapture=createNativeInputCapture(config.root,config.diagnosticInputRoot);
  let active=0;
  let closed=false;
  const running=new Set<AbortController>();
  const completions=new Set<Promise<void>>();
  const waiting:Array<{resolve:()=>void;reject:(error:Error)=>void;signal:AbortSignal;abort:()=>void}>=[];
  async function acquire(signal:AbortSignal) {
    signal.throwIfAborted();
    if(active<maxConcurrent){active++;return;}
    await new Promise<void>((resolve,reject)=>{
      const entry={resolve:()=>{signal.removeEventListener('abort',entry.abort);active++;resolve();},reject,signal,abort:()=>{const i=waiting.indexOf(entry);if(i>=0)waiting.splice(i,1);reject(signal.reason);}};
      waiting.push(entry);signal.addEventListener('abort',entry.abort,{once:true});
      if(signal.aborted)entry.abort();
    });
  }
  function release(){active--;const entry=waiting.shift();if(entry)entry.resolve();}
  return {
    maxConcurrent,
    async chatCompletion(request:Record<string,unknown>,options?:{timeoutMs:number;roleLabel?:string;provider?:{apiBase:string;apiKey:string}}) {
      if(closed)throw transportError('Native DSH transport is closed','dsh_native_closed');
      // Freeze exactly the JSON wire value once before any queued awaits.
      // Capture and relay must not observe a caller mutating the original object.
      request=JSON.parse(JSON.stringify(request));
      const task=nativeDshTask(request,config.maxRequestBytes);
      const budget=Math.min(options?.timeoutMs??config.timeoutMs??120000,config.timeoutMs??120000);
      if(!Number.isFinite(budget)||budget<=0)throw transportError('Native DSH deadline expired','dsh_native_timeout');
      const id=randomUUID(),startedAt=Date.now();
      const guiAttempt=beginRegisteredGuiNativeAttempt({id,model:String(request.model),role:String(options?.roleLabel||''),effectiveDeadlineAt:startedAt+budget,request,standardProducer:!config.runnerFactory&&Boolean(options?.provider??config.provider)});
      const diagnostic:Record<string,any>={schemaVersion:1,id,roleLabel:String(options?.roleLabel||'Unspecified role').replace(/[^A-Za-z0-9 _-]/g,'').slice(0,80),model:String(request.model).slice(0,160),requestBytes:Buffer.byteLength(JSON.stringify(request)),taskBytes:Buffer.byteLength(task),messageCount:Array.isArray(request.messages)?request.messages.length:0,budgetMs:budget,maxConcurrent,startedAt,queueWaitMs:null,acquiredAt:null,executionMs:null,outcome:'pending',runnerEvents:[],modelEventCounts:{},relay:{providerRequests:0,responseBytes:0}};
      const policy=nativeStructuredJsonPolicyMetadata(request);if(policy)diagnostic.structuredJsonPolicy=policy;
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(transportError('Native DSH inference timed out','dsh_native_timeout')),budget);
      running.add(controller);
      let markComplete!:()=>void;
      const completion=new Promise<void>(resolve=>{markComplete=resolve;});
      completions.add(completion);
      let acquired=false;
      let dir:string|undefined;
      let runner:Runner|undefined;
      let relay:Awaited<ReturnType<typeof createNativeDshRelay>>|undefined;
      try {
        await acquire(controller.signal);acquired=true;diagnostic.acquiredAt=Date.now();diagnostic.queueWaitMs=Date.now()-startedAt;
        if(closed)throw transportError('Native DSH transport is closed','dsh_native_closed');
        await fs.mkdir(config.root,{recursive:true,mode:0o700});
        dir=await fs.mkdtemp(path.join(config.root,'native-agent-'));
        await fs.chmod(dir,0o700);
        const work=path.join(dir,'work'),home=path.join(dir,'dsh-home');
        await Promise.all([fs.mkdir(work,{mode:0o700}),fs.mkdir(home,{mode:0o700})]);
        const patch=path.join(dir,'native-reasoning.patch.yml');
        const guard=path.join(dir,'native-reasoning-boundary.mjs');
        await fs.writeFile(guard,NATIVE_DSH_TOOL_GUARD,{mode:0o600});
        await fs.writeFile(patch,nativeDshProfilePatch(guard),{mode:0o600});
        const args=[...(config.args??['--profile','headless','--json'])];
        const appFlags=args.findIndex(arg=>arg==='--json');
        args.splice(appFlags<0?args.length:appFlags,0,'--patch',patch);
        const factory=config.runnerFactory??(async (runnerConfig:any)=>{
          const module=await import(pathToFileURL(path.join(config.projectRoot,'packages/dsh-plugin/runner.mjs')).href);
          return module.createCommandRunner(runnerConfig);
        });
        // The command runner's environment allowlist excludes all application,
        // AppWorld, Telegram, database and host authentication credentials.
        runner=await factory({command:config.command,args,passEnv:[],isolatedHome:true});
        controller.signal.throwIfAborted();
        const provider=options?.provider??config.provider;
        if(config.diagnosticInputRoot)diagnostic.inputCapture=await inputCapture.capture(id,request,provider?.apiKey);
        if(provider)relay=await createNativeDshRelay({provider,request,signal:controller.signal});
        controller.signal.throwIfAborted();
        const result=await runner!.run({work,home,task,model:String(request.model),provider:relay?.provider,signal:controller.signal,onDiagnostic(event){
          const safe:Record<string,unknown>={};
          for(const key of ['phase','pid','startedAt','elapsedMs','exitCode','signalCode','stdoutBytes','stderrBytes','terminationRequested','forcedKillRequested']){const value=event?.[key];if(typeof value==='number'||typeof value==='boolean'||value===null)safe[key]=value;else if(typeof value==='string'&&['phase','signalCode'].includes(key))safe[key]=value.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);}
          if(diagnostic.runnerEvents.length<8)diagnostic.runnerEvents.push(safe);
        },onEvent(event){
          const kind=['status','final','error','tool_call','tool','tool_start','message','delta','assistant_delta'].includes(event?.type)?event.type:'other';diagnostic.modelEventCounts[kind]=(diagnostic.modelEventCounts[kind]||0)+1;
          if(event?.type==='tool_call'||event?.type==='tool'||event?.type==='tool_start'){
            controller.abort(transportError('Native DSH attempted a forbidden local tool','dsh_native_tool_forbidden'));
          }
        }});
        controller.signal.throwIfAborted();
        diagnostic.answerCharacters=result.answer.length;
        const parsed=parseNativeDshAnswer(result.answer);diagnostic.outcome='succeeded';
        return {id:'dsh-native-'+randomUUID(),object:'chat.completion',model:request.model,
          choices:[{index:0,message:{role:'assistant',content:JSON.stringify(parsed)},finish_reason:'stop'}],
          execution:{harness:'dsh',delivery:'native',toolsExecutedBy:'host'}};
      } catch(error) {
        diagnostic.outcome=controller.signal.aborted?'aborted':'failed';diagnostic.errorCode=String((error as any)?.code||'native_inference_failed').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);
        const relayDetails=relay?.diagnostics();
        const details=relayDetails?Object.fromEntries(Object.entries(relayDetails).filter(([k])=>k!=='handlersDrained'&&k!=='handlerCount')):undefined;
        if(details?.code&&!controller.signal.aborted)throw Object.assign(new Error(String(details.message)),{code:details.code,nativeInference:details});
        if(error&&typeof error==='object'&&details)Object.assign(error,{nativeInference:details});
        throw error;
      } finally {
        clearTimeout(timer);running.delete(controller);
        diagnostic.runnerCreated=Boolean(runner);diagnostic.runnerDisposed=false;diagnostic.workspaceRemoved=!dir;
        try {await runner?.dispose();diagnostic.runnerDisposed=Boolean(runner);} catch(error){diagnostic.outcome='cleanup_failed';diagnostic.cleanupErrorPhase='runner_dispose';throw error;} finally {try {await relay?.close();} catch(error){diagnostic.outcome='cleanup_failed';diagnostic.cleanupErrorPhase='relay_close';throw error;} finally {try {if(dir)await fs.rm(dir,{recursive:true,force:true});diagnostic.workspaceRemoved=true;} catch(error){diagnostic.outcome='cleanup_failed';diagnostic.cleanupErrorPhase='workspace_remove';throw error;} finally {
          if(acquired)release();
          diagnostic.finishedAt=Date.now();diagnostic.queueWaitMs??=Date.now()-startedAt;diagnostic.executionMs=diagnostic.acquiredAt===null?null:Date.now()-diagnostic.acquiredAt;
          const relayMetadata=relay?.diagnostics();if(relayMetadata){const safe:Record<string,unknown>={};for(const key of ['providerRequests','upstreamStatus','responseBytes','prompt_tokens','completion_tokens','total_tokens','reasoning_tokens','contentCharacters','reasoningCharacters'])if(typeof relayMetadata[key]==='number')safe[key]=relayMetadata[key];for(const key of ['finish_reason','code'])if(typeof relayMetadata[key]==='string')safe[key]=String(relayMetadata[key]).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);diagnostic.relay=safe;}
          try {
          const diagnosticSaved=await persistNativeInferenceDiagnostic(config.diagnosticRoot,id,diagnostic);
          if(guiAttempt&&diagnosticSaved){
            const r=relay?.diagnostics()??{},settled=diagnostic.runnerEvents.filter((e:any)=>e.phase==='settled');
            const clean=diagnostic.runnerDisposed===true&&diagnostic.workspaceRemoved===true&&r.handlersDrained===true&&r.handlerCount===0&&!controller.signal.aborted;
            guiAttempt.completed=clean;guiAttempt.success=clean&&diagnostic.outcome==='succeeded'&&r.providerRequests===1&&r.upstreamStatus===200&&r.finish_reason==='stop';
            guiAttempt.eligibleEof=clean&&diagnostic.outcome==='failed'&&r.code==='dsh_native_upstream_transport'&&r.providerRequests===1&&r.responseBytes===0&&['upstreamStatus','finish_reason','prompt_tokens','completion_tokens','total_tokens','reasoning_tokens'].every(k=>!Object.hasOwn(r,k))&&settled.length===1&&settled[0].exitCode===1&&settled[0].signalCode===null&&settled[0].terminationRequested===false&&settled[0].forcedKillRequested===false&&!['tool_call','tool','tool_start'].some(k=>diagnostic.modelEventCounts[k]);
          }
          } finally {completions.delete(completion);markComplete();}
        }}}
      }
    },
    async dispose(){closed=true;for(const controller of running)controller.abort(transportError('Native DSH transport closed','dsh_native_closed'));for(const entry of waiting.splice(0)){entry.signal.removeEventListener('abort',entry.abort);entry.reject(transportError('Native DSH transport closed','dsh_native_closed'));}await Promise.allSettled([...completions]);},
  };
}
