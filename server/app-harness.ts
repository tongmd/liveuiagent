import {createHash, randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type express from 'express';
import type {HarnessId} from './harness-catalog.js';
import type {HarnessChoice} from './runtime-settings.js';
import {runtimeError} from './runtime-settings.js';

/** The application remains host-owned. Changing its executor changes no
 * application source, data, permissions, conversation, or interaction state. */
export function createAppHarness(db:Database.Database, options:{
  userOf:(req:express.Request)=>string;
  choicesOf:(req:express.Request)=>HarnessChoice[];
  modelOf:(req:express.Request,id:HarnessId)=>Promise<{id?:unknown;models?:unknown;[key:string]:unknown}>;
  connect:(req:express.Request,id:HarnessId,model:string,appId:string)=>{model?:string}|undefined;
  binding:{get:(owner:string,id:string)=>HarnessId|undefined;save:(owner:string,id:string,harness:HarnessId)=>void};
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_executor_settings (
    owner TEXT NOT NULL, app_id TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner,app_id));
    CREATE TABLE IF NOT EXISTS app_executor_events (
    event_id TEXT PRIMARY KEY, owner TEXT NOT NULL, app_id TEXT NOT NULL,
    previous_harness TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL,
    revision INTEGER NOT NULL, created_at TEXT NOT NULL);`);
  const leases=new Map<string,number>();
  const key=(owner:string,id:string)=>owner+'\0'+id;
  const table=(name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function ownerOf(req:express.Request){const owner=options.userOf(req);if(!owner)throw runtimeError('请先登录','authentication_required',401);return owner;}
  function setting(owner:string,id:string){return db.prepare('SELECT * FROM app_executor_settings WHERE owner=? AND app_id=?').get(owner,id) as any;}
  function load(owner:string,id:string){
    if(id.startsWith('visual_')&&table('rich_workspaces')){
      const row=db.prepare('SELECT snapshot_json FROM rich_workspaces WHERE owner=? AND app_id=?').get(owner,id) as any;
      if(row){const snapshot=JSON.parse(row.snapshot_json);return {format:'workspace',raw:row.snapshot_json,snapshot,harness:(snapshot.app.harness||options.binding.get(owner,id)||'codex') as HarnessId};}
    }else if(id.startsWith('dsh_')&&table('complete_apps')){
      const row=db.prepare('SELECT info_json FROM complete_apps WHERE owner=? AND app_id=?').get(owner,id) as any;
      if(row)return {format:'html',raw:row.info_json,harness:'dsh' as HarnessId};
    }else if(table('agent_apps')){
      const row=db.prepare('SELECT * FROM agent_apps WHERE owner=? AND app_id=?').get(owner,id) as any;
      if(row)return {format:'native',raw:JSON.stringify(row),harness:options.binding.get(owner,id)||'native' as HarnessId};
    }
    throw runtimeError('应用不存在','app_missing',404);
  }
  function token(owner:string,id:string,stored:ReturnType<typeof load>){return createHash('sha256').update(JSON.stringify({content:stored.raw,harness:stored.harness,binding:options.binding.get(owner,id),executor:setting(owner,id)||null})).digest('hex');}
  function busy(owner:string,id:string){
    if(leases.get(key(owner,id)))return true;
    for(const [name,column] of [['rich_workspace_jobs','job_json'],['complete_host_actions','result_json']]){
      if(table(name)&&db.prepare(`SELECT 1 FROM ${name} WHERE owner=? AND app_id=? AND json_extract(${column},'$.status') IN ('running','queued') LIMIT 1`).get(owner,id))return true;
    }
    return false;
  }
  async function choices(req:express.Request,format:string){
    return Promise.all(options.choicesOf(req).map(async choice=>{
      if(format==='html'&&choice.id!=='dsh')return {...choice,available:false,reason:'此应用使用 HTML 编码运行时，目前仅支持 DeepSeek Harness',model:null,models:[]};
      try{
        const info=await options.modelOf(req,choice.id),models=Array.isArray(info.models)?info.models.filter((v):v is string=>typeof v==='string'):typeof info.id==='string'?[info.id]:[];
        const model=typeof info.id==='string'?info.id:null;
        return {...choice,available:choice.available&&Boolean(model),...(!model?{reason:'请先配置此 Agent 的模型'}:{}),model,models};
      }catch{return {...choice,available:false,reason:'暂时无法读取模型配置',model:null,models:[]};}
    }));
  }
  async function view(req:express.Request,id:string){
    const owner=ownerOf(req);load(owner,id);const available=await choices(req,load(owner,id).format);
    // Refresh after async provider capability reads, so the token describes the
    // same current content and binding returned to the caller.
    const stored=load(owner,id),saved=setting(owner,id);
    return {appId:id,format:stored.format,harness:stored.harness,model:saved?.model||stored.snapshot?.app.model||available.find(c=>c.id===stored.harness)?.model||null,
      token:token(owner,id,stored),revision:saved?.revision||0,busy:busy(owner,id),choices:available};
  }
  async function change(req:express.Request,id:string){
    const owner=ownerOf(req),body=req.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['harness','model','expectedToken'].includes(k))||typeof body.expectedToken!=='string'||!/^[a-f0-9]{64}$/.test(body.expectedToken))throw runtimeError('请重新打开 Agent 选择后重试','app_harness_invalid');
    const stored=load(owner,id);
    if(token(owner,id,stored)!==body.expectedToken)throw runtimeError('应用已变化，请刷新后重试','app_harness_conflict',409);
    if(busy(owner,id))throw runtimeError('请等待当前任务完成再切换 Agent','app_harness_busy',409);
    if(stored.format==='html'&&body.harness!=='dsh')throw runtimeError('此 HTML 应用尚不支持其他 Agent，原应用已保留','app_harness_format_unsupported',422);
    const selected=(await choices(req,stored.format)).find(c=>c.id===body.harness);
    if(!selected)throw runtimeError('未知 Agent','harness_unknown');
    if(!selected.available)throw runtimeError(selected.reason||'Agent 暂不可用','harness_unavailable',503);
    const model=body.model??selected.model;
    if(typeof model!=='string'||!selected.models.includes(model))throw runtimeError('请选择此 Agent 支持的模型','harness_model_unavailable',422);
    // Resolving a transport is local validation, never a model request. It also
    // enforces model-family rules and Codex's authenticated owner allowlist.
    const connected=options.connect(req,selected.id,model,id);
    if(!connected?.model||connected.model!==model)throw runtimeError('Agent 模型连接不可用','harness_model_mismatch',409);
    let changed=false;
    db.transaction(()=>{
      const current=load(owner,id);
      if(token(owner,id,current)!==body.expectedToken)throw runtimeError('应用已变化，请刷新后重试','app_harness_conflict',409);
      if(busy(owner,id))throw runtimeError('请等待当前任务完成再切换 Agent','app_harness_busy',409);
      const prior=setting(owner,id);
      if(prior?.harness===selected.id&&prior.model===model)return;
      const revision=(prior?.revision||0)+1,at=new Date().toISOString();
      if(current.format==='workspace'){
        const snapshot=current.snapshot;
        snapshot.app.harness=selected.id;snapshot.app.model=model;
        snapshot.version++;snapshot.app.revision=snapshot.version;snapshot.app.updatedAt=at;
        db.prepare('UPDATE rich_workspaces SET snapshot_json=? WHERE owner=? AND app_id=?').run(JSON.stringify(snapshot),owner,id);
      }
      if(current.format!=='html')options.binding.save(owner,id,selected.id);
      db.prepare(`INSERT INTO app_executor_settings VALUES (?,?,?,?,?,?) ON CONFLICT(owner,app_id) DO UPDATE SET harness=excluded.harness,model=excluded.model,revision=excluded.revision,updated_at=excluded.updated_at`).run(owner,id,selected.id,model,revision,at);
      db.prepare('INSERT INTO app_executor_events VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),owner,id,current.harness,selected.id,model,revision,at);
      changed=true;
    })();
    return {...await view(req,id),changed};
  }
  async function during<T>(req:express.Request,id:string|undefined,fn:()=>Promise<T>):Promise<T>{
    if(!id)return fn();
    const lock=key(options.userOf(req),id);leases.set(lock,(leases.get(lock)||0)+1);
    try{return await fn();}finally{const remaining=(leases.get(lock)||1)-1;if(remaining)leases.set(lock,remaining);else leases.delete(lock);}
  }
  function install(app:express.Express){
    app.get('/agent/apps/:id/harness',async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store');res.json(await view(req,req.params.id));}catch(e){next(e);}});
    app.patch('/agent/apps/:id/harness',async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store');res.json(await change(req,req.params.id));}catch(e){next(e);}});
  }
  function modelFor(owner:string,id:string){return setting(owner,id)?.model as string|undefined;}
  function requestModel(req:express.Request){
    const body=req.body||{},id=String(body.appId||body.selectedAppId||'');
    // An explicitly selected per-app executor is authoritative. Legacy clients
    // may still send their global model in every request; it must not change
    // the selected app's executor. Use this app's selector to change its model.
    return (id?modelFor(options.userOf(req),id):undefined)??body.llm?.model??req.header('x-liveuiagent-llm-model')??'';
  }
  function assertConnection<T extends {model?:string}|undefined>(req:express.Request,connection:T):T {
    const id=String(req.body?.appId||req.body?.selectedAppId||''),pinned=id?modelFor(options.userOf(req),id):undefined;
    if(pinned&&connection?.model!==pinned)throw runtimeError('此应用所选模型暂不可用，请在 Agent 设置中重新选择','app_model_unavailable',409);
    return connection;
  }
  return {install,view,change,during,busy,modelFor,requestModel,assertConnection};
}
