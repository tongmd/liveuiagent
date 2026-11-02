import type express from 'express';
import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {createApplicationAccess} from './application-access.js';
import {runApplicationAgent} from './application-agent.js';
import type {LlmRuntimeConfig} from './liveuiagent.js';

const fail=(message:string,code:string,status=400)=>Object.assign(new Error(message),{code,status});
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Options={
  userOf:(req:express.Request)=>string;
  llmOf:(req:express.Request)=>LlmRuntimeConfig|undefined;
  harnessFor:(req:express.Request)=>string;
  bindingOf:(owner:string,id:string)=>string|undefined;
  during:<T>(req:express.Request,id:string,work:()=>Promise<T>)=>Promise<T>;
  nativePatch:(input:any)=>Promise<any>;
  rich:{load:(owner:string,id:string)=>any;start:(req:express.Request,id?:string,management?:{harness:string;llm:LlmRuntimeConfig})=>any;jobOf:(owner:string,id:string)=>any};
  html:{loadApp:(req:express.Request,id:string)=>Promise<any>;reviseManaged:(req:express.Request,id:string,onProgress?:(s:string)=>void)=>Promise<any>};
};

/** Format-neutral application tools run above App write locks, using the same
 * authenticated owner and model connection for every supported harness. */
export function installApplicationRoutes(app:express.Express,db:Database.Database,options:Options){
  db.exec(`CREATE TABLE IF NOT EXISTS application_management_jobs(owner TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,PRIMARY KEY(owner,request_id))`);
  for(const row of db.prepare("SELECT owner,request_id,result_json FROM application_management_jobs WHERE status='running'").all() as any[]){
    let prior:any={};try{prior=JSON.parse(row.result_json||'{}');}catch{}
    db.prepare("UPDATE application_management_jobs SET status='error',result_json=? WHERE owner=? AND request_id=?").run(JSON.stringify({...prior,error:'Application request interrupted. Read its completed edits and current applications before submitting a new edit.',code:'application_interrupted',status:409}),row.owner,row.request_id);
  }
  const pending=new Map<string,Promise<any>>();let active=0,providerPending=0;
  const cloned=(req:express.Request,body:any)=>Object.assign(Object.create(req),{body}) as express.Request;
  function clean(req:express.Request){const body={...req.body};for(const key of ['appId','selectedAppId','delivery','completeApp','owner','hostContext','runtimeContext'])delete body[key];return cloned(req,body);}
  function accessFor(req:express.Request){return createApplicationAccess(db,{harnessOf:options.bindingOf,htmlRead:async(owner,id)=>{
    if(owner!==options.userOf(req))throw fail('Application not found','app_missing',404);
    return options.html.loadApp(req,id);
  }});}
  app.get('/agent/applications',(req,res,next)=>{try{const owner=options.userOf(req);res.setHeader('Cache-Control','no-store');res.json(accessFor(req).list(owner,{offset:req.query.offset===undefined?undefined:Number(req.query.offset),limit:req.query.limit===undefined?undefined:Number(req.query.limit)}));}catch(e){next(e);}});
  app.get('/agent/applications/:id',async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store');res.json(await accessFor(req).read(options.userOf(req),String(req.params.id),{section:req.query.section as any,offset:req.query.offset===undefined?undefined:Number(req.query.offset),maxChars:req.query.maxChars===undefined?undefined:Number(req.query.maxChars),expectedToken:req.query.expectedToken as string|undefined}));}catch(e){next(e);}});
  app.get('/agent/application-requests/:id',(req,res,next)=>{try{
    const owner=options.userOf(req);if(!owner)throw fail('Please sign in','authentication_required',401);
    const row=db.prepare('SELECT status,result_json FROM application_management_jobs WHERE owner=? AND request_id=?').get(owner,String(req.params.id)) as any;
    if(!row)throw fail('Request not found','application_request_missing',404);
    res.setHeader('Cache-Control','no-store');res.json({requestId:req.params.id,status:row.status,...(row.result_json?{result:JSON.parse(row.result_json)}:{})});
  }catch(e){next(e);}});
  app.post('/agent/run',async(req,res,next)=>{
    const owner=options.userOf(req);
    if(!owner||typeof req.body?.prompt!=='string')return next();
    let heartbeat:ReturnType<typeof setInterval>|undefined;let stream=false;
    const started=Date.now();
    const send=(event:string,data:any)=>{if(stream&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    const begin=()=>{if(!stream&&String(req.header('accept')||'').includes('text/event-stream')){stream=true;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': ping\n\n');},15000);}};
    const progress=(step:string)=>send('progress',{step,elapsedMs:Date.now()-started});
    try{
      if(req.body.prompt.length>16000)throw fail('Application request is too long','application_prompt_limit');
      const access=accessFor(req);if(!access.list(owner,{limit:1}).total)return next();
      const selected=clean(req),harness=options.harnessFor(selected),original=options.llmOf(selected);
      if(!original)throw fail('Selected agent is not connected','harness_unavailable',503);
      const llm:LlmRuntimeConfig={...original,onProgress:progress};
      if(original.chatCompletion)llm.chatCompletion=async(...args:Parameters<NonNullable<LlmRuntimeConfig['chatCompletion']>>)=>{providerPending++;try{return await original.chatCompletion!(...args);}finally{providerPending--;}};
      const requestId=req.body.clientRequestId??randomUUID();
      if(typeof requestId!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(requestId))throw fail('Invalid request identifier','application_request_invalid');
      const signature=sha({prompt:req.body.prompt,selectedAppId:req.body.selectedAppId||null,harness,model:llm.model});
      const prior=db.prepare('SELECT * FROM application_management_jobs WHERE owner=? AND request_id=?').get(owner,requestId) as any;
      const key=owner+'\0'+requestId;
      if(prior&&prior.signature!==signature)throw fail('Request identifier already belongs to another request','application_request_conflict',409);
      const execute=async()=>{
        active++;
        db.prepare('INSERT INTO application_management_jobs VALUES (?,?,?,?,NULL)').run(owner,requestId,signature,'running');
        const receipts:{attemptedAppIds:string[];completedEdits:any[]}={attemptedAppIds:[],completedEdits:[]};
        const saveReceipts=()=>db.prepare('UPDATE application_management_jobs SET result_json=? WHERE owner=? AND request_id=?').run(JSON.stringify(receipts),owner,requestId);
        try{
          const outcome=await runApplicationAgent({prompt:req.body.prompt,selectedAppId:req.body.selectedAppId,llm,harness,onHandled:()=>begin(),onProgress:progress,access:{
            list:args=>Promise.resolve(access.list(owner,args)),
            read:({appId,...args}:any)=>access.read(owner,appId,args),
            revise:async({appId,prompt,expectedToken}:any)=>options.during(req,appId,async()=>{
              const before=await access.snapshot(owner,appId);
              if(before.token!==expectedToken)throw fail('Application changed. Read its current version before editing.','application_conflict',409);
              receipts.attemptedAppIds.push(appId);saveReceipts();
              let result:any;
              if(before.format==='native'){
                result=await options.nativePatch({appId,prompt,llm,user:owner,expectedContentHash:sha(before.content)});
                result={ok:true,appId,execution:{harness,model:llm.model,delivery:'native'},name:result.appSummary?.name};
              }else if(before.format==='workspace'){
                const revision=cloned(req,{prompt,expectedVersion:Number(before.version),clientRequestId:'manage-'+sha({requestId,appId}).slice(0,40),viewport:req.body.viewport,displayEnvironment:req.body.displayEnvironment});
                const job=options.rich.start(revision,appId,{harness,llm});let current=job;
                while(current.status==='running'){progress(current.stage||'Editing application');await new Promise(r=>setTimeout(r,750));current=options.rich.jobOf(owner,job.id);}
                if(current.status!=='done')throw Object.assign(fail(current.error||'Application edit failed',current.code||'application_edit_failed',502),{jobId:job.id});
                result={ok:true,appId,jobId:job.id,execution:job.execution};
              }else{
                // HTML files belong to the coding runtime. The selected agent
                // controls the edit; that runtime validates and publishes it.
                const revision=cloned(req,{prompt,appId,displayEnvironment:req.body.displayEnvironment});
                revision.header=((name:string)=>name.toLowerCase().startsWith('x-liveuiagent-llm-')?undefined:req.header(name)) as typeof req.header;revision.get=revision.header;
                result=await options.html.reviseManaged(revision,appId,progress);
              }
              const after=await access.snapshot(owner,appId);
              const receipt={...result,...(result.delegated?{executor:'dsh'}:{}),version:after.version,token:after.token,changed:after.token!==before.token,managerExecution:{harness,model:llm.model}};
              receipts.completedEdits.push(receipt);saveReceipts();return receipt;
            }),
          }});
          db.prepare('UPDATE application_management_jobs SET status=?,result_json=? WHERE owner=? AND request_id=?').run('done',JSON.stringify(outcome),owner,requestId);return outcome;
        }catch(e:any){const value={...receipts,...(e.unconfirmedAppIds?{unconfirmedAppIds:e.unconfirmedAppIds}:{}),error:e.message,status:e.status||500,code:e.code||'application_management_failed',...(e.jobId?{jobId:e.jobId}:{})};Object.assign(e,value);db.prepare('UPDATE application_management_jobs SET status=?,result_json=? WHERE owner=? AND request_id=?').run('error',JSON.stringify(value),owner,requestId);throw e;}
        finally{active--;}
      };
      let outcome:any;
      if(prior){
        if(prior.status==='error')throw Object.assign(new Error(JSON.parse(prior.result_json).error),JSON.parse(prior.result_json));
        if(prior.status==='done')outcome=JSON.parse(prior.result_json);
        else {const existing=pending.get(key);if(!existing)throw fail('Original application request is still being reconciled; do not resubmit','application_request_pending',409);outcome=await existing;}
      }else{const operation=execute();pending.set(key,operation);try{outcome=await operation;}finally{pending.delete(key);}}
      if(!outcome.handled){
        // A selected App supplies context, not an instruction to regenerate it.
        // Preserve explicit new-App format; unrelated conversation returns to
        // the ordinary desk route without the old selected-format shortcut.
        const body={...req.body};delete body.selectedAppId;delete body.appId;
        if(outcome.intent!=='create'){delete body.delivery;delete body.completeApp;}
        req.body=body;return next();
      }
      begin();const result=outcome.result??outcome;
      if(stream){send('result',result);res.end();}else res.json(result);
    }catch(e:any){if(stream){send('error',{error:e.message,code:e.code,jobId:e.jobId,completedEdits:e.completedEdits,attemptedAppIds:e.attemptedAppIds});res.end();}else res.status(e.status||500).json({error:e.message,code:e.code,jobId:e.jobId,completedEdits:e.completedEdits,attemptedAppIds:e.attemptedAppIds});}
    finally{if(heartbeat)clearInterval(heartbeat);}
  });
  return {activeCount:()=>active+providerPending};
}
