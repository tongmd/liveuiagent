import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createNativeDshRelay} from './dsh-native-relay.js';
import {harnessLabel,type DomesticHarnessId} from './harness-catalog.js';

type Provider={apiBase:string;apiKey:string};
const qwenDenied=['agent','enter_worktree','exit_worktree','get_goal','list_agents','record_artifact','report_findings','send_message','skill','task_stop','update_goal','tool_call','tool_search'];
const zcodeDenied='Glob Grep AskUserQuestion Bash Edit EnterPlanMode ExitPlanMode Read TaskOutput TaskStop TodoRead TodoWrite WebFetch Write ReadSessionContext ReplyToChannel';
const prompt='Complete the host conversation provided by the inference endpoint. Return only the requested JSON. Application tools and persistence are managed by the host.';
const failure=(id:string,suffix:string,message:string,status=502)=>Object.assign(new Error(`${harnessLabel(id)}：${message}`),{code:`${id}_${suffix}`,status});

/** Official headless CLIs act as reasoning workers, just like the DSH adapter.
 * The host owns app tools, role messages, provider credentials and persistence.
 * Each call gets a private configuration and one expiring loopback capability.
 * Never inherit account login state, MCP servers, API secrets or user hooks. */
export async function prepareHarnessRun(id:DomesticHarnessId,run:string,model:string,provider:Provider) {
  const work=path.join(run,'work'),config=path.join(run,'config');
  await mkdir(work,{mode:0o700});await mkdir(config,{mode:0o700});
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'en_US.UTF-8',NO_COLOR:'1'};
  const json=(file:string,value:unknown)=>writeFile(file,JSON.stringify(value),{mode:0o600});
  if(id==='qwen') {
    await json(path.join(config,'settings.json'),{
      security:{auth:{selectedType:'openai'}},tools:{core:['__liveui_no_tools__'],toolSearch:{enabled:false}},
      permissions:{deny:qwenDenied},memory:{enableManagedAutoMemory:false,enableManagedAutoDream:false},
      skills:{disabledLevels:['project','user','extension','bundled']},telemetry:{enabled:false},mcpServers:{},
    });
    Object.assign(env,{QWEN_HOME:config,OPENAI_API_KEY:provider.apiKey,OPENAI_BASE_URL:provider.apiBase,OPENAI_MODEL:model});
    return {cwd:work,env,args:['--auth-type','openai','--model',model,'--core-tools','__liveui_no_tools__','--max-tool-calls','0','--output-format','json','--prompt',prompt]};
  }
  if(id==='kimi') {
    const agent=path.join(run,'agent.md');
    await writeFile(agent,'---\nname: liveui\ndescription: LiveUI application reasoning\ntools: []\nsubagents: []\n---\n'+prompt,{mode:0o600});
    Object.assign(env,{KIMI_CODE_HOME:config,KIMI_MODEL_API_KEY:provider.apiKey,KIMI_MODEL_BASE_URL:provider.apiBase,KIMI_MODEL_NAME:model,KIMI_MODEL_PROVIDER_TYPE:'openai'});
    return {cwd:work,env,args:['--agent-file',agent,'--output-format','stream-json','-p',prompt]};
  }
  const providerFile=path.join(run,'provider.json');
  await json(providerFile,{schemaVersion:1,config:{
    providerConfigRules:{providerRules:[{providerId:'liveui',providerName:'LiveUI API',config:{group:'standard-personal',access:{type:'api-key',apiKey:provider.apiKey},api:{type:'openai-chat-completions',baseUrl:provider.apiBase},personalModelIds:[model]}}]},
    modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]},defaultModelSelection:{providerId:'liveui',modelId:model},
  }});
  await json(path.join(work,'zcode.json'),{features:{mcp:false,subagent:false,memory:false,skill:false},memory:{use:false},plugins:{enabled:false},skills:{enabled:false},hooks:{enabled:false}});
  Object.assign(env,{ZCODE_DATA_BASE_DIR:config,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:providerFile});
  return {cwd:work,env,args:['--disallowed-tools',zcodeDenied,'--mode','plan','--json','--no-color','-p',prompt]};
}

export function parseHarnessAnswer(id:DomesticHarnessId,stdout:string):string {
  let content:unknown;
  try {
    if(id==='qwen') {
      const events=JSON.parse(stdout);
      if(!Array.isArray(events)||events.some(e=>e.type==='tool_use'||e.message?.content?.some((c:any)=>c.type==='tool_use')))throw Error();
      const result=events.filter(e=>e.type==='result');
      if(result.length!==1||result[0].is_error||result[0].subtype!=='success'||result[0].stats?.tools?.totalCalls>0)throw Error();
      content=result[0].result;
    } else if(id==='kimi') {
      const events=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(events.some(e=>e.role==='tool'||e.tool_calls?.length||e.type==='error'))throw Error();
      const messages=events.filter(e=>e.role==='assistant');
      if(messages.length!==1)throw Error();content=messages[0].content;
    } else {
      const result=JSON.parse(stdout);
      if(result.error||result.projection?.status!=='idle'||(result.usage?.modelRequestCount!==undefined&&result.usage.modelRequestCount!==1))throw Error();
      content=result.response;
    }
    if(typeof content!=='string'||!content.trim())throw Error();
    // The existing orchestration layer validates the requested JSON schema.
    return content;
  }catch{throw failure(id,'response_invalid','没有返回完整的文本结果，请保留原请求重试');}
}

function runProcess(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv},signal:AbortSignal,id:DomesticHarnessId):Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{...options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',bytes=0,problem:Error|undefined;
    const stop=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const abort=()=>{problem=failure(id,'timeout','生成超时，原应用和请求已保留',504);stop();};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(part:string)=>{bytes+=Buffer.byteLength(part);if(bytes>16*1024*1024){problem=failure(id,'output_limit','输出超过大小限制');stop();}else stdout+=part;});
    // Vendor diagnostics may contain the full request. Drain but never expose or
    // persist them; safe provider HTTP/timeout information comes from the relay.
    child.stderr.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>16*1024*1024){problem=failure(id,'output_limit','输出超过大小限制');stop();}});
    child.once('error',()=>{problem=failure(id,'launch_failed','运行时启动失败，请检查服务配置',503);});
    child.once('close',code=>{signal.removeEventListener('abort',abort);stop();if(problem)reject(problem);else if(code!==0)reject(failure(id,'process_failed',`运行时异常退出（${code??'signal'}），原请求已保留`));else resolve(stdout);});
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}

export function createDomesticHarnessInference(input:{id:DomesticHarnessId;command:string;args?:string[];root:string;maxConcurrent?:number;timeoutMs?:number}) {
  const maxConcurrent=input.maxConcurrent??2,limit=input.timeoutMs??180000;
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8||!Number.isFinite(limit)||limit<1||limit>300000)throw Error('Invalid harness execution limits');
  let active=0,disposed=false;const controllers=new Set<AbortController>();
  async function chatCompletion(request:Record<string,unknown>,options:{provider:Provider;timeoutMs?:number;onProgress?:(step:string)=>void}) {
    if(disposed)throw failure(input.id,'unavailable','服务正在关闭',503);
    const budget=Math.min(options.timeoutMs??limit,limit);
    if(!Number.isFinite(budget)||budget<=0)throw failure(input.id,'timeout','生成超时',504);
    if(!request.model||!Array.isArray(request.messages))throw failure(input.id,'request_invalid','缺少模型或上下文',400);
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),budget);let acquired=false,run:string|undefined,relay:Awaited<ReturnType<typeof createNativeDshRelay>>|undefined;
    try {
      options.onProgress?.(`${harnessLabel(input.id)} · ${request.model} · 等待执行`);
      while(active>=maxConcurrent){await new Promise<void>(resolve=>setTimeout(resolve,25));if(controller.signal.aborted)throw failure(input.id,'timeout','排队超时，原请求已保留',504);}
      controller.signal.throwIfAborted();active++;acquired=true;
      await mkdir(input.root,{recursive:true,mode:0o700});run=await mkdtemp(path.join(input.root,'run-'));
      relay=await createNativeDshRelay({provider:options.provider,request,signal:controller.signal});
      const prepared=await prepareHarnessRun(input.id,run,String(request.model),relay.provider);
      options.onProgress?.(`${harnessLabel(input.id)} · ${request.model} · 正在生成`);
      let stdout:string;
      try{stdout=await runProcess(input.command,[...(input.args??[]),...prepared.args],prepared,controller.signal,input.id);}
      catch(error){const diagnostic=relay.diagnostics();if(diagnostic.code)throw failure(input.id,String(diagnostic.code).replace(/^dsh_native_/,'provider_'),String(diagnostic.message));throw error;}
      const diagnostic=relay.diagnostics();
      if(diagnostic.code||diagnostic.providerRequests!==1)throw failure(input.id,'provider_failed',String(diagnostic.message||'运行时未完成模型调用'));
      const content=parseHarnessAnswer(input.id,stdout);
      options.onProgress?.(`${harnessLabel(input.id)} · 返回结果，正在校验`);
      return {model:request.model,choices:[{message:{role:'assistant',content},finish_reason:'stop'}]};
    }catch(error){if(controller.signal.aborted)throw failure(input.id,'timeout','生成超时，原应用和请求已保留',504);throw error;}
    finally{clearTimeout(timer);await relay?.close();if(run)await rm(run,{recursive:true,force:true});if(acquired)active--;controllers.delete(controller);}
  }
  return {maxConcurrent,chatCompletion,dispose(){disposed=true;for(const controller of controllers)controller.abort();}};
}

export function domesticHarnessFromEnv(id:DomesticHarnessId,root:string,env:NodeJS.ProcessEnv=process.env) {
  const prefix=`LIVEUI_${id.toUpperCase()}`,command=env[`${prefix}_COMMAND`]?.trim();
  if(!command)return undefined;
  const args=env[`${prefix}_ARGS`]?JSON.parse(env[`${prefix}_ARGS`]!):[];
  if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error(`Invalid ${prefix}_ARGS`);
  return createDomesticHarnessInference({id,command,args,root:path.join(root,id),maxConcurrent:Number(env.LIVEUI_DOMESTIC_MAX_CONCURRENT||2),timeoutMs:Number(env.LIVEUI_DOMESTIC_TIMEOUT_MS||180000)});
}
