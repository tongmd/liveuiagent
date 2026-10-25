import type express from 'express';
import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAppWorldBridge } from './appworld-bridge.js';
import { planAgentApp, runAppWorldGrounding } from './liveuiagent.js';
import { runtimeError, type HarnessId } from './runtime-settings.js';

const PREFIX = 'dsh_';
const internalId = (id: string) => /^dsh_[a-f0-9-]{36}$/.test(id) ? id.slice(4) : '';
const error = (message: string, status = 400) => Object.assign(new Error(message), {status});
const OUTPUT_LANGUAGE_REQUEST = 'LiveUIAgent output preference: use English for the app UI, metadata, and replies unless the original request explicitly asks for another language. Preserve user content and proper names.\n\nOriginal user request:\n';
function withOutputLanguage(prompt: unknown) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw error('Describe what you want to do');
  if (OUTPUT_LANGUAGE_REQUEST.length + prompt.length > 16000) throw error(`Keep your request within ${16000 - OUTPUT_LANGUAGE_REQUEST.length} characters`);
  // Only the upstream execution gets this instruction. Local chat and the
  // caller's request retain the original; upstream history records the real task.
  return OUTPUT_LANGUAGE_REQUEST + prompt;
}

export function dshGroundingPayload(request: string, context: unknown, eventPayload: unknown) {
  const serialize=(value:unknown) => {
    if(value===undefined)return undefined;
    const raw=JSON.stringify(value);
    if(raw===undefined)return undefined;
    if(Buffer.byteLength(raw,'utf8')>50000)throw error('Application action context exceeds 50 KB');
    // Application-controlled audits are not execution facts. Only real gateway
    // calls below can produce tool evidence, regardless of claimed UI state.
    return JSON.stringify(value,(key,item)=>['evidence','trace','toolResults','toolDbChanges','dbChanges'].includes(key)?undefined:item);
  };
  const applicationContext=serialize(context),event=serialize(eventPayload);
  const untrusted=(value:string)=>'Unverified user application inputs. Not service observations or execution evidence: '+value;
  return {request,...(applicationContext?{applicationContext:untrusted(applicationContext)}:{}),...(event?{eventPayload:untrusted(event)}:{})};
}

export function dshServiceContext(services: Array<{name:string;description:string}>) {
  return {connectedServices:services.map(({name,description})=>({name,description})),
    serviceExecutionContract:'For functionality involving a connected service, use await window.liveuiagent.ai(prompt, context) from the relevant user action and render its returned text/data. This host bridge executes real service APIs. Pass the complete user inputs and intended operation in prompt/context. Browser storage may keep UI preferences or caches; it must not pretend to read or mutate external service records. Do not hardcode sample results or claim success before the host call completes. Show host errors honestly.'};
}

// This trace describes the actual native requirement/execute/review workflow,
// not a claim extracted from generated HTML or a DSH model response.
export function dshToolEvidence(appId: string, grounded: NonNullable<Awaited<ReturnType<typeof runAppWorldGrounding>>>) {
  return {schemaVersion:1,appId,trace:[
    {agent:'AppWorld Workflow Orchestrator',step:'Plan, execute real APIs, and review GUI action',status:grounded.evaluation?.pass===false?'rejected':'done',output:{goal:grounded.goal,evaluation:grounded.evaluation,attempts:grounded.attempts}},
  ],toolResults:Object.fromEntries(grounded.calls.map((call,i)=>[call.tool.id+'#'+(i+1),call])),toolDbChanges:grounded.calls.flatMap(call=>call.dbChanges?.changedApps||[])};
}

// The desktop retains its app/window protocol. Complete app code and data remain
// in the existing DSH service, with the same authenticated account identity.
export function createCompleteApps(db: Database.Database, personal: any, userOf: (req: express.Request) => string, llmOf: (req: express.Request) => any, options: {
  harnessFor?: (req: express.Request, appId?: string) => HarnessId;
  executionOf?: (req: express.Request) => { model?: string; provider?: { apiBase: string; apiKey: string } };
} = {}) {
  const toolBridge = createAppWorldBridge(process.cwd());
  const jobEvidence = new Map<string, any>();
  const toolPlans = new Map<string, Promise<string[]>>();
  const evidenceKey = (req: express.Request, id: string) => JSON.stringify([userOf(req), id]);
  const configuredBase = process.env.LIVEUIAGENT_DSH_API_BASE?.trim();
  const userPrefix = process.env.LIVEUI_DSH_USER_PREFIX?.trim() || '';
  const emptyAccountRoot = process.env.LIVEUI_DSH_EMPTY_ACCOUNT_ROOT?.trim() || '';
  if (userPrefix && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(userPrefix)) {
    throw new Error('LIVEUI_DSH_USER_PREFIX must be 1–100 letters, digits, dots, underscores, colons or hyphens');
  }
  if (emptyAccountRoot && (!userPrefix || !path.isAbsolute(emptyAccountRoot))) {
    throw new Error('LIVEUI_DSH_EMPTY_ACCOUNT_ROOT requires an absolute path and a nonempty LIVEUI_DSH_USER_PREFIX');
  }
  const initializedAccounts = new Map<string, Promise<void>>();
  async function initializeEmptyAccount(upstreamOwner: string) {
    if (!emptyAccountRoot) return;
    if (!initializedAccounts.has(upstreamOwner)) {
      const pending = (async () => {
        const key = createHash('sha256').update(upstreamOwner).digest('hex');
        const directory = path.join(emptyAccountRoot, 'accounts', key);
        const stateFile = path.join(directory, 'state.json');
        await fs.mkdir(directory, {recursive:true,mode:0o700});
        if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Workspace account must be a real directory');
        try {
          const stat = await fs.lstat(stateFile);
          if (!stat.isFile()) throw new Error('Existing workspace state must be a regular file');
        } catch (e:any) {
          if (e.code !== 'ENOENT') throw e;
          // Publish a complete file exclusively: concurrent workers never see a
          // partially written account, and an existing account is never replaced.
          const temporary = path.join(directory, '.liveui-init-'+randomUUID()+'.json');
          try {
            await fs.writeFile(temporary, JSON.stringify({apps:[],jobs:[],memory:{manual:'',entries:[]},memoryFormatVersion:1,seedVersion:1})+'\n', {flag:'wx',mode:0o600});
            try { await fs.link(temporary, stateFile); } catch (publish:any) { if (publish.code !== 'EEXIST') throw publish; }
          } finally { await fs.rm(temporary, {force:true}); }
        }
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        if (!Array.isArray(state.apps) || !Array.isArray(state.jobs) || !state.seedVersion) {
          throw new Error('Existing workspace requires explicit migration before example-free startup');
        }
      })();
      initializedAccounts.set(upstreamOwner, pending);
      pending.catch(()=>initializedAccounts.delete(upstreamOwner));
    }
    try { await initializedAccounts.get(upstreamOwner); }
    catch { throw runtimeError('The isolated application workspace could not be initialized. Check its configured storage permissions and state.', 'dsh_workspace_initialization_failed', 503); }
  }
  let apiBase: URL | undefined;
  if (configuredBase) {
    apiBase = new URL(configuredBase.replace(/\/+$/, '') + '/');
    if (!['http:', 'https:'].includes(apiBase.protocol) || apiBase.username || apiBase.password || apiBase.search || apiBase.hash) {
      throw new Error('LIVEUIAGENT_DSH_API_BASE must be an HTTP(S) API base without credentials, query, or fragment');
    }
  }
  db.exec('CREATE TABLE IF NOT EXISTS complete_apps(owner TEXT NOT NULL,app_id TEXT NOT NULL,info_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,app_id))');
  async function dsh(req: express.Request, route: string, method = 'GET', data?: any) {
    const owner = userOf(req);
    if (!owner) throw error('Please sign in to your account',401);
    if (!apiBase) throw Object.assign(error('Complete app service is not configured', 503), {code:'dsh_config_required',requiredConfig:['LIVEUIAGENT_DSH_API_BASE']});
    const upstreamOwner = userPrefix + owner;
    if (upstreamOwner.length > 200) throw runtimeError('The configured application workspace identity is too long', 'dsh_workspace_identity_invalid', 503);
    await initializeEmptyAccount(upstreamOwner);
    const r = await fetch(new URL(route, apiBase), {method,headers:{'X-LiveUIAgent-User':upstreamOwner,...(method !== 'GET' ? {'Content-Type':'application/json'} : {})},body:data === undefined ? undefined : JSON.stringify(data),signal:AbortSignal.timeout(35000)});
    const value: any = await r.json();
    if (!r.ok) throw Object.assign(error(value.error || 'The app service is temporarily unavailable',r.status), {code:value.code});
    // Upstream/model-generated evidence is never an authority.
    delete value.evidence;
    if (route.startsWith('jobs/')) {
      const evidence=jobEvidence.get(evidenceKey(req,route.slice(5)));
      if(evidence)value.evidence=evidence;
    }
    return value;
  }
  async function capabilities(req: express.Request) {
    if (!apiBase || !userOf(req)) return {model:'',modelSelection:false,providerOverride:false};
    try { return await dsh(req,'runtime-settings'); }
    catch (e: any) {
      if (e.status !== 404) throw e;
      const state = await dsh(req,'state');
      return {model:state.engine?.model || '',modelSelection:false,providerOverride:false};
    }
  }
  async function execution(req: express.Request) {
    const requested = options.executionOf?.(req) || {};
    const capability = await capabilities(req);
    const model = requested.model || capability.model || '';
    if (requested.model && !capability.modelSelection && requested.model !== capability.model) {
      throw runtimeError('This DSH service cannot select the requested model. Upgrade its runner or select the configured DSH model.', 'harness_model_unsupported', 422);
    }
    if (requested.provider && !capability.providerOverride) {
      throw runtimeError('This DSH service cannot accept the selected model provider. Upgrade its runner before using these model settings.', 'harness_provider_unsupported', 422);
    }
    return {
      model,
      ...(requested.provider && capability.providerOverride ? {provider:requested.provider} : {}),
    };
  }
  function rememberMetadata(owner: string, apps: any[]) {
    const save = db.prepare('INSERT INTO complete_apps VALUES (?,?,?,?) ON CONFLICT(owner,app_id) DO UPDATE SET info_json=excluded.info_json,updated_at=excluded.updated_at');
    const active = new Set(apps.map(a=>PREFIX+a.id));
    db.transaction(()=>{
      for (const a of apps) save.run(owner,PREFIX+a.id,JSON.stringify(a),a.updatedAt || a.createdAt);
      for (const row of db.prepare('SELECT app_id FROM complete_apps WHERE owner=?').all(owner) as any[]) if (!active.has(row.app_id)) db.prepare('DELETE FROM complete_apps WHERE owner=? AND app_id=?').run(owner,row.app_id);
    })();
  }
  function record(a: any) {
    const appId = PREFIX + a.id;
    const color = /^#[a-f\d]{6}$/i.test(a.accent) ? a.accent : '#426b57';
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#263c32"/></linearGradient></defs><rect x="5" y="5" width="86" height="86" rx="23" fill="url(#bg)"/><rect x="23" y="24" width="50" height="48" rx="8" fill="white" fill-opacity=".94"/><path d="M23 38h50M41 38v34" stroke="${color}" stroke-width="3"/><path d="M49 48h15M49 56h11M49 64h15" stroke="${color}" stroke-width="3" stroke-linecap="round"/></svg>`;
    const surfaceId = 'surface_' + appId;
    const components = [{id:'root',component:'Column',children:['status']},{id:'status',component:'Text',text:{literal:'Opening app…'},variant:'body'}];
    const a2ui = {protocol:'a2ui',surfaceId,initialData:{},messages:[{createSurface:{surfaceId}},{updateComponents:{surfaceId,components}},{updateDataModel:{surfaceId,value:{}}}]};
    const presentation = {glyph:a.name.slice(0,1),accent:color,tagline:a.description.slice(0,32),metric:'',metricLabel:'',collection:a.name,actionVerb:'Open',live:true,rows:0};
    const preview = {accent:color,chips:a.features || [],metrics:[],sampleRecords:[],presentation,widget:{kind:'entities',items:(a.features||[]).slice(0,4).map((name:string,i:number)=>({id:'feature_'+i,name,detail:'Open the app to use this feature'})),stats:[],itemLabel:'Features'}};
    const manifest = {schemaVersion:'0.1.0',appId,name:a.name,description:a.description,icon:'assets/icon.svg',entry:'pages.home',platforms:['web'],layoutModes:['phone','tablet','desktop'],permissions:['storage.app','llm.call'],version:String(a.revision),intent:{agentApp:true,kind:'complete_app',presentation}};
    return {appId,name:a.name,description:a.description,version:String(a.revision),icon:'assets/icon.svg',status:'ready',records:0,updatedAt:a.updatedAt || a.createdAt,preview,completeApp:{id:a.id,revision:a.revision},appPackage:{manifest,ui:{meta:{a2ui,agentWorkflow:[{actionRoutes:[{actionId:'agent.invoke',endpoint:'/agent/complete/apps/'+appId+'/action'}]}]}},actions:{actions:{'agent.invoke':{id:'agent.invoke',type:'agent',steps:[{capability:'agent.backend'}]}}},assets:{icon:{svg:icon}},dataSchema:{collections:{}},agents:{},memory:{}},appData:{},runtimeState:{}};
  }
  async function merge(req: express.Request, result: any) {
    let s:any;try{s=await dsh(req,'state');rememberMetadata(userOf(req),s.apps);}catch(e:any){if(e.code==='dsh_workspace_initialization_failed'||e.code==='dsh_workspace_identity_invalid')throw e;s={apps:(db.prepare('SELECT info_json FROM complete_apps WHERE owner=?').all(userOf(req)) as any[]).map(r=>JSON.parse(r.info_json))};}
    const apps = [...result.apps,...s.apps.map(record)];
    const nodes = [...result.canvasState.nodes];
    for (const a of s.apps) { const appId=PREFIX+a.id; if (!nodes.some(n=>n.appId===appId)) nodes.push({id:'node_'+appId,type:'app_card',appId,position:{x:72+(nodes.length%4)*180,y:72+Math.floor(nodes.length/4)*180},size:{width:104,height:124},status:'ready'}); }
    return {...result,apps,canvasState:{...result.canvasState,nodes},summary:{...result.summary,appCount:apps.length,apps:apps.map(({appPackage,appData,runtimeState,...a}:any)=>a)}};
  }
  async function contextual(req: express.Request, appId?: string) {
    const llm = llmOf(req);
    await personal.prepare(req,llm);
    return {personalContext:JSON.parse(llm?.personalContext || '[]'),...(appId ? {appId} : {})};
  }
  async function start(req: express.Request, appId?: string) {
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw error('Describe what you want to do');
    const context = {...await contextual(req,appId),...(toolBridge && process.env.LIVEUIAGENT_APPWORLD_GROUNDING !== 'off' ? dshServiceContext(await toolBridge.getAppDescriptions()) : {})};
    const selected = await execution(req);
    const job = await dsh(req,'generate','POST',{prompt:withOutputLanguage(prompt),...(appId ? {appId:internalId(appId)} : {}),context,...selected});
    return {...job, execution:{harness:'dsh',model:job.model || selected.model}};
  }
  async function run(req: express.Request,res: express.Response,next: express.NextFunction,appId?: string) {
    const stream = String(req.header('accept') || '').includes('text/event-stream');
    const taskRow=Number(db.prepare("INSERT INTO chat_history(owner,role,text,prompt,kind,status,label) VALUES (?,'agent','',?,'task','running',?)").run(userOf(req),String(req.body.prompt||'').slice(0,2000),'Create: '+String(req.body.prompt||'').slice(0,60)).lastInsertRowid);
    const finishTask=(status:string,text:string)=>db.prepare('UPDATE chat_history SET status=?,text=? WHERE id=? AND owner=?').run(status,text.slice(0,1000),taskRow,userOf(req));
    const startAt=Date.now(); let heartbeat: ReturnType<typeof setInterval> | undefined;
    const send=(event:string,value:any)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);};
    if (stream) {res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'}); heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': ping\n\n')},15000);send('progress',{step:'Reviewing your request',elapsedMs:0});}
    try {
      const job=await start(req,appId);let current=job;
      while (['queued','running'].includes(current.status)) {
        if(stream&&!res.destroyed)send('progress',{step:current.stage,elapsedMs:Date.now()-startAt});
        await new Promise(r=>setTimeout(r,2000));current=await dsh(req,'jobs/'+job.id);
      }
      if(current.status!=='done')throw error(current.error || 'Task cancelled',current.status==='cancelled'?409:502);
      const s=await dsh(req,'state');rememberMetadata(userOf(req),s.apps);
      const a=record(s.apps.find((a:any)=>a.id===job.appId));
      const result={type:appId?'app_patched':'app_created',appSummary:{appId:a.appId,name:a.name},appPackage:a.appPackage,execution:job.execution,trace:[{agent:'deepseek-harness',step:'complete-app',status:'done',message:`${current.toolCalls} tool calls`}],contextualMemory:personal.requestStatus(req)};
      finishTask('done',a.name+' is ready');if(stream)send('result',result);else res.json(result);
    }catch(e:any){finishTask('error',e.message);if(stream)send('error',{error:e.message,...(e.code?{code:e.code}:{})});else next(e)}finally{if(heartbeat)clearInterval(heartbeat);if(stream)res.end()}
  }
  async function action(req: express.Request, appId: string, body=req.body) {
    const id = internalId(appId);
    if (!id) throw error('App not found',404);
    const actionPrompt=withOutputLanguage(body?.prompt || body?.actionId);
    const groundingPayload=dshGroundingPayload(String(body?.prompt||body?.actionId||''),body?.context,body?.eventPayload);
    const saved=await dsh(req,'apps/'+id);
    const selected = await execution(req);
    let evidence:any;let groundedContext:any;
    if(toolBridge && process.env.LIVEUIAGENT_APPWORLD_GROUNDING !== 'off') {
      const llm=llmOf(req);
      const planKey=JSON.stringify([userOf(req),appId,saved.app.revision,saved.app.description]);
      if(!toolPlans.has(planKey)){
        if(toolPlans.size>=1000)toolPlans.delete(toolPlans.keys().next().value!);
        const pending=planAgentApp([saved.app.name,saved.app.description].join('\n'),llm,toolBridge).then(plan=>plan.toolCapabilities.map(t=>t.permission));
        toolPlans.set(planKey,pending);pending.catch(()=>toolPlans.delete(planKey));
      }
      const permissions=await toolPlans.get(planKey)!;
      const grounded=await runAppWorldGrounding({bridge:toolBridge,permissions,payload:groundingPayload,appName:saved.app.name,appPurpose:saved.app.description,llm});
      if(grounded) {
        if(!grounded.calls.length)throw runtimeError('No real business API call completed','dsh_tool_execution_empty',502);
        evidence=dshToolEvidence(appId,grounded);
        groundedContext={summary:grounded.summary,entities:grounded.entities,stats:grounded.stats,evaluation:grounded.evaluation,instruction:'Render these actual executed results. Do not repeat API mutations or claim unobserved outcomes.'};
      }
    }
    const job = await dsh(req,'apps/'+id+'/action','POST',{
      prompt:actionPrompt,
      context:{...body?.context,eventPayload:body?.eventPayload,personalContext:personal.recall(userOf(req),appId),...(groundedContext?{executedTools:groundedContext}:{})},
      ...selected,
    });
    if(evidence){if(jobEvidence.size>=1000)jobEvidence.delete(jobEvidence.keys().next().value!);jobEvidence.set(evidenceKey(req,job.id),evidence);}
    return {...job,...(evidence?{evidence}:{}),execution:{harness:'dsh',model:job.model || selected.model}};
  }
  function checkAppHarness(req: express.Request, appId: string) { options.harnessFor?.(req,appId); }
  function install(app: express.Express) {
    app.use('/agent/complete',(req,res,next)=>{const origin=req.header('origin');if(origin&&new URL(origin).host!==req.header('host')){res.status(403).json({error:'Invalid request origin'});return;}next();});
    app.post('/agent/run',(req,res,next)=>{
      try {
        const appId = req.body?.selectedAppId;
        const harness = options.harnessFor ? options.harnessFor(req,appId) : (req.body?.completeApp===true ? 'dsh' : 'native');
        if (harness === 'dsh') void run(req,res,next,appId); else next();
      } catch(e) { next(e); }
    });
    app.post('/agent/patch-app',async(req,res,next)=>{
      try { const appId=String(req.body?.appId || '');checkAppHarness(req,appId);if(!internalId(appId))return next();res.status(202).json(await start(req,appId)); } catch(e) { next(e); }
    });
    app.post('/agent/action',async(req,res,next)=>{
      try { const appId=String(req.body?.appId || '');checkAppHarness(req,appId);if(!internalId(appId))return next();res.status(202).json(await action(req,appId)); } catch(e) { next(e); }
    });
    app.get('/agent/complete/state',async(req,res,next)=>{try{res.json(await dsh(req,'state'))}catch(e){next(e)}});
    app.get('/agent/complete/jobs/:id',async(req,res,next)=>{try{res.json(await dsh(req,'jobs/'+req.params.id))}catch(e){next(e)}});
    app.delete('/agent/complete/jobs/:id',async(req,res,next)=>{try{res.json(await dsh(req,'jobs/'+req.params.id,'DELETE'))}catch(e){next(e)}});
    app.get('/agent/complete/apps/:id',async(req,res,next)=>{try{const id=internalId(String(req.params.id));if(!id)throw error('App not found',404);res.json(await dsh(req,'apps/'+id))}catch(e){next(e)}});
    app.put('/agent/complete/apps/:id/store',async(req,res,next)=>{try{const id=internalId(String(req.params.id));if(!id)throw error('App not found',404);res.json(await dsh(req,'apps/'+id+'/store','PUT',req.body))}catch(e){next(e)}});
    app.post('/agent/complete/apps/:id/revise',async(req,res,next)=>{try{const id=String(req.params.id);checkAppHarness(req,id);if(!internalId(id))throw error('App not found',404);req.body.appId=id;res.status(202).json(await start(req,id))}catch(e){next(e)}});
    app.post('/agent/complete/apps/:id/action',async(req,res,next)=>{try{const appId=String(req.params.id);checkAppHarness(req,appId);res.status(202).json(await action(req,appId))}catch(e){next(e)}});
    app.post('/agent/complete/apps/:id/interaction',async(req,res,next)=>{try{
      const appId=String(req.params.id),id=internalId(appId);if(!id)throw error('App not found',404);
      const a=await dsh(req,'apps/'+id);
      const fields=Array.isArray(req.body?.fields)?req.body.fields.slice(0,12).filter((f:any)=>typeof f?.value==='string'&&f.value.trim()&&f.value.length<=2000).map((f:any)=>({label:String(f.label||'').slice(0,100),value:f.value})):[];
      if(!fields.length){res.json({ok:true});return;}
      res.status(202).json({ok:true});
      void personal.observe(userOf(req),{text:JSON.stringify({userInputs:fields}),appId,kind:'app_form_input',app:{name:a.app.name,description:a.app.description}},llmOf(req)).catch(()=>{});
    }catch(e){next(e)}});
    app.post('/agent/remove-app',async(req,res,next)=>{if(!internalId(String(req.body?.appId)))return next();try{const id=internalId(req.body.appId),a=await dsh(req,'apps/'+id);await dsh(req,'apps/'+id,'DELETE');db.prepare('DELETE FROM complete_apps WHERE owner=? AND app_id=?').run(userOf(req),req.body.appId);res.json({type:'app_removed',appId:req.body.appId,name:a.app.name,trace:[]})}catch(e){next(e)}});
  }
  async function loadApp(req:express.Request,appId:string){const id=internalId(appId);if(!id)throw error('App not found',404);return dsh(req,'apps/'+id);}
  async function saveStore(req:express.Request,appId:string,store:unknown){const id=internalId(appId);if(!id)throw error('App not found',404);return dsh(req,'apps/'+id+'/store','PUT',store);}
  async function evaluateAction(req:express.Request,appId:string,prompt:string,context:unknown){
    const job=await action(req,appId,{prompt,context});let current=job;const deadline=Date.now()+16*60*1000;
    while(['queued','running'].includes(current.status)){
      if(Date.now()>deadline)throw runtimeError('Application AI action exceeded the evaluation deadline','evaluator_action_timeout',504);
      await new Promise(resolve=>setTimeout(resolve,1000));current=await dsh(req,'jobs/'+job.id);
    }
    if(current.status!=='done')throw runtimeError(current.error||'Application AI action did not complete','evaluator_action_failed',502);
    const {evidence: _untrusted, ...result}=current.result||{};
    return {...result,...(current.evidence?{evidence:current.evidence}:{})};
  }
  return {merge,install,capabilities,loadApp,saveStore,evaluateAction,configured:Boolean(apiBase)};
}
