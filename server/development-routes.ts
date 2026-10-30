import type express from 'express';
import type Database from 'better-sqlite3';
import type {LlmRuntimeConfig} from './liveuiagent.js';
import {createDevelopmentWorkspace} from './development-workspace.js';
import {redactSecrets} from './llm-settings.js';

const fail=(message:string,code:string,status=400)=>Object.assign(new Error(message),{code,status});

/** Only an explicit host-edit instruction selects the development workspace.
 * Mentioning liveUI in an app requirement, quoted example or source text does not. */
export function wantsLiveuiDevelopment(body:unknown):boolean {
  if(!body||typeof body!=='object'||Array.isArray(body))return false;
  const value=body as Record<string,unknown>;
  if(value.target==='liveui')return true;
  if(typeof value.developmentConversationId==='string'&&value.developmentConversationId.trim())return true;
  if(typeof value.prompt!=='string')return false;
  const prompt=value.prompt.trim();
  if(/^["'“‘「『`>]/.test(prompt))return false;
  if(wantsDevelopmentContinuation(prompt))return true;
  return /^(?:(?:请|请你|帮我|请帮我|直接|现在)\s*)?(?:(?:用|使用)\s*(?:codex|native|dsh|qwen|kimi|zcode)\s*)?(?:修改|修复|改进|调整|更新|改|调试)(?:一下|好)?\s*liveui\s*(?:本身|宿主|源码|源代码|的源码|的源代码|的宿主)(?:\b|[\s，。,:：]|$)/i.test(prompt)
    || /^(?:please\s+)?(?:fix|modify|edit|debug|update)\s+(?:the\s+)?liveui\s+(?:itself|host|source(?:\s+code)?)(?:\b)/i.test(prompt);
}

function wantsDevelopmentContinuation(prompt:string){return /^(?:请\s*)?继续(?:修改|修复|改进|调整|调试)\s*liveui(?:\s*(?:本身|宿主|源码|源代码))?(?:[\s，。,:：]|$)/i.test(prompt.trim());}

/** Reuse the selected host adapter. Credentials and untrusted body callbacks
 * never become model context, and native HTTP has an absolute response bound. */
export async function developmentCompletion(llm:LlmRuntimeConfig,messages:unknown[],timeoutMs:number):Promise<string> {
  if(!llm.model||(!llm.chatCompletion&&(!llm.apiBase||!llm.apiKey)))throw fail('所选 harness 尚未连接','llm_config_required',422);
  const budget=Math.max(1,Math.min(180000,timeoutMs));
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const stop=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('开发请求模型响应超时','development_model_timeout',504));},budget);});
  const request={model:llm.model,messages,temperature:0.1,max_tokens:8192,response_format:{type:'json_object'}};
  try {
    const inference=async()=>{
      if(llm.chatCompletion)return llm.chatCompletion(request,{timeoutMs:budget,roleLabel:'liveUI development'});
      const response=await fetch(llm.apiBase!.replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+llm.apiKey},body:JSON.stringify(request),signal:controller.signal});
      if(!response.ok)throw fail('开发请求模型接口失败（HTTP '+response.status+'）','development_provider_error',502);
      const reader=response.body?.getReader();if(!reader)throw fail('模型响应为空','development_provider_empty',502);
      const parts:Uint8Array[]=[];let size=0;
      try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>2*1024*1024)throw fail('模型响应超过大小限制','development_provider_limit',502);parts.push(next.value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('模型响应不是有效 JSON','development_provider_format',502);}
    };
    const result:any=await Promise.race([inference(),stop]);
    const content=result?.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>1024*1024)throw fail('模型未返回有效开发指令','development_provider_format',502);
    return content;
  } finally {clearTimeout(timer);}
}

type WorkspaceConfig=Parameters<typeof createDevelopmentWorkspace>[0];
export type DevelopmentRouteOptions={
  /** This callback must resolve nginx's authenticated owner, never body.owner.
   * The host port must remain private; untrusted clients cannot set this header. */
  userOf:(req:express.Request)=>string;
  llmOf:(req:express.Request)=>LlmRuntimeConfig|undefined;
  harnessFor:(req:express.Request)=>string;
  context:WorkspaceConfig['runtimeContext'];
  runTest?:WorkspaceConfig['runTest'];
  allowedTests?:WorkspaceConfig['allowedTests'];
  owners?:string[];
  sourceRoot?:string;
  workspaceRoot?:string;
  sourceCommit?:string;
  maxSteps?:number;
  timeoutMs?:number;
};

/** Install before rich/complete Apps so an explicit host-development request
 * cannot accidentally generate another application. No implicit enablement. */
export function installDevelopmentRoutes(app:express.Express,_db:Database.Database,options:DevelopmentRouteOptions){
  const owners=new Set(options.owners??(process.env.LIVEUI_DEVELOPMENT_OWNERS||'').split(',').map(x=>x.trim()).filter(Boolean));
  const sourceRoot=options.sourceRoot??process.env.LIVEUI_DEVELOPMENT_SOURCE;
  const root=options.workspaceRoot??process.env.LIVEUI_DEVELOPMENT_ROOT;
  const configured=Boolean(owners.size&&sourceRoot&&root);
  const workspace=configured?createDevelopmentWorkspace({root:root!,sourceRoot:sourceRoot!,sourceCommit:options.sourceCommit,
    runtimeContext:options.context,runTest:options.runTest,allowedTests:options.allowedTests,maxSteps:options.maxSteps,timeoutMs:options.timeoutMs,
    infer:async()=>{throw fail('本请求缺少已绑定的模型连接','development_inference_missing',503);},
  }):undefined;
  function ownerOf(req:express.Request){
    const owner=options.userOf(req);
    if(!owner)throw fail('请先登录','development_owner_required',401);
    if(!owners.has(owner))throw fail('当前账户未启用 liveUI 源码开发','development_owner_denied',403);
    if(!workspace)throw fail('liveUI 源码开发工作区尚未配置','development_unavailable',503);
    return owner;
  }
  function cleanRequest(req:express.Request){
    const body={...req.body};
    // Selected App is context only. It must not choose the old App's harness,
    // force legacy DSH inference or switch this request to HTML delivery.
    for(const key of ['appId','selectedAppId','delivery','completeApp','hostContext','runtimeContext','owner'])delete body[key];
    return Object.assign(Object.create(req),{body}) as express.Request;
  }
  async function start(req:express.Request){
    const owner=ownerOf(req),body=req.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.prompt!=='string'||!body.prompt.trim())throw fail('请提供修改需求','development_invalid');
    const requestId=body.clientRequestId;
    if(typeof requestId!=='string'||!requestId.trim())throw fail('请求缺少 clientRequestId；请刷新页面再提交','development_request_id_required');
    const selected=cleanRequest(req),llm=options.llmOf(selected),harness=options.harnessFor(selected);
    if(!llm?.model||(!llm.chatCompletion&&(!llm.apiBase||!llm.apiKey)))throw fail('所选 harness 尚未连接','llm_config_required',422);
    const selectedNode=Array.isArray(body.canvasState?.nodes)?body.canvasState.nodes.find((node:any)=>node?.id===body.selectedNodeId):undefined;
    const appId=body.selectedAppId??body.appId??selectedNode?.appId;
    if(appId!==undefined&&(typeof appId!=='string'||appId.length>200))throw fail('应用标识无效','development_invalid');
    let conversationId=body.developmentConversationId??body.conversationId;
    if(conversationId!==undefined&&typeof conversationId!=='string')throw fail('开发会话标识无效','development_invalid');
    if(!conversationId&&wantsDevelopmentContinuation(body.prompt)){
      const previous=(await workspace!.list(owner)).filter(item=>item.harness===harness&&item.model===llm.model).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(!previous)throw fail('当前 harness 没有可继续的开发会话，请先提交修改 liveUI 的需求','development_conversation_missing',404);
      conversationId=previous.id;
    }
    return workspace!.submit({owner,prompt:body.prompt,harness,model:llm.model,clientRequestId:requestId,
      ...(appId?{appId}:{}),...(conversationId?{conversationId}:{}),
    },{infer:({messages,timeoutMs})=>developmentCompletion(llm,messages,timeoutMs)});
  }
  const output=(job:any)=>{
    const result=job.result;
    const testLabel=result?.validation==='passed'?'当前代码测试通过':result?.validation==='failed'?'当前代码测试失败':result?.validation==='stale'?'测试之后代码有变化，尚未重新验证':'尚未运行测试';
    const changed=Array.isArray(result?.changedFiles)?result.changedFiles:[];
    const answer=['liveUI 开发会话：'+job.conversationId,changed.length?'已在隔离源码工作区修改 '+changed.length+' 个文件：'+changed.join('、'):'没有源码文件变更',testLabel+'；未部署到运行中的 liveUI。',result?.diff?'实际修改：\n```diff\n'+result.diff+'\n```':''].filter(Boolean).join('\n\n');
    return {type:'answered',question:job.prompt,answer,jobId:job.id,developmentConversationId:job.conversationId,
      execution:{harness:job.harness,model:job.model,delivery:'development'},development:{...result,deployed:false,status:job.status},
      trace:[{agent:job.harness,step:'Edit liveUI source in isolated workspace',status:job.status==='done'?'done':'error',jobId:job.id}]};
  };
  const route=(handler:(req:express.Request,res:express.Response)=>unknown)=>async(req:express.Request,res:express.Response,next:express.NextFunction)=>{
    try{res.setHeader('Cache-Control','private, no-store');await handler(req,res);}catch(error){next(error);}
  };
  app.get('/agent/development/status',route((req,res)=>{const owner=ownerOf(req);res.json({configured:true,...workspace!.status(owner)});}));
  app.get('/agent/development/conversations',route(async(req,res)=>{const owner=ownerOf(req);res.json({conversations:await workspace!.list(owner)});}));
  app.get('/agent/development/conversations/:id',route(async(req,res)=>{const owner=ownerOf(req);res.json(await workspace!.getConversation(owner,String(req.params.id)));}));
  app.get('/agent/development/jobs/:id',route(async(req,res)=>{const owner=ownerOf(req);res.json(await workspace!.getJob(owner,String(req.params.id)));}));
  app.get('/agent/development/requests/:id',route(async(req,res)=>{const owner=ownerOf(req);res.json(await workspace!.getRequest(owner,String(req.params.id)));}));
  app.get('/agent/development/jobs/:id/patch',route(async(req,res)=>{const owner=ownerOf(req),job=await workspace!.getJob(owner,String(req.params.id));if(!job.result)throw fail('该任务尚未生成修改结果','development_pending',409);res.type('text/plain').send(job.result.diff);}));
  app.post('/agent/development/submit',route(async(req,res)=>res.status(202).json(await start(req))));
  app.post('/agent/run',async(req,res,next)=>{
    if(!wantsLiveuiDevelopment(req.body))return next();
    let streamed=false;
    try{
      const job=await start(req),owner=ownerOf(req);
      streamed=String(req.header('accept')||'').includes('text/event-stream');
      if(streamed)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      const send=(event:string,data:unknown)=>{if(!res.destroyed&&!res.writableEnded)res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');};
      let current=job,lastStage='',lastHeartbeat=Date.now();
      while(current.status==='running'){
        if(res.destroyed)return;
        const stage=current.steps+':'+current.stage;
        if(streamed&&stage!==lastStage){send('progress',{step:current.stage,jobId:current.id,developmentConversationId:current.conversationId,elapsedMs:Date.now()-Date.parse(current.createdAt)});lastStage=stage;}
        if(streamed&&Date.now()-lastHeartbeat>15000){res.write(': ping\n\n');lastHeartbeat=Date.now();}
        await new Promise(resolve=>setTimeout(resolve,500));current=await workspace!.getJob(owner,job.id);
      }
      if(res.destroyed)return;
      if(current.status!=='done'){
        const payload={error:redactSecrets(current.error||'开发任务中断，原会话和修改已保留'),code:current.code||'development_interrupted',jobId:job.id,developmentConversationId:job.conversationId,...(current.result?{development:current.result}:{})};
        if(streamed){send('error',payload);res.end();return;}
        res.status(502).json(payload);return;
      }
      const result=output(current);if(streamed){send('result',result);res.end();}else res.setHeader('Cache-Control','private, no-store').json(result);
    }catch(error:any){if(streamed){if(!res.destroyed){res.write('event: error\ndata: '+JSON.stringify({error:redactSecrets(String(error?.message||'开发任务失败')),code:error?.code||'development_failed'})+'\n\n');res.end();}}else next(error);}
  });
  return {configured,activeCount:()=>workspace?.status().activeCount??0,status:()=>workspace?.status()??{activeCount:0,active:[],capacity:0},dispose:()=>workspace?.dispose()??Promise.resolve()};
}

