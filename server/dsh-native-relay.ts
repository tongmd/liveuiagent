import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

// A per-inference capability. The DSH process sees only this short-lived token;
// provider credentials and provider-specific sampling/reasoning stay in the host.
export async function createNativeDshRelay(input:{provider:{apiBase:string;apiKey:string};request:Record<string,unknown>;signal:AbortSignal;maxRequestBytes?:number;fetchImpl?:typeof fetch}) {
 const upstream=new URL(input.provider.apiBase.replace(/\/+$/,'')+'/chat/completions');
 if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash)throw new Error('Invalid Native DSH provider URL');
 const key=randomBytes(32).toString('hex');
 const secret=Buffer.from('Bearer '+key);
 const limit=input.maxRequestBytes??4*1024*1024;
 const sockets=new Set<import('node:net').Socket>();
 const requests=new Set<AbortController>();
 let closed=false;let providerRequests=0;
 const protectedFields=new Set(['model','messages','tools','tool_choice','parallel_tool_calls','stream','stream_options']);
 const parameters=Object.fromEntries(Object.entries(input.request).filter(([name])=>!protectedFields.has(name)));
 function fail(res:http.ServerResponse,status:number,code:string){if(!res.headersSent){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:code,code}}));}else res.destroy();}
 const server=http.createServer(async(req,res)=>{
  if(closed||input.signal.aborted)return fail(res,503,'native_relay_closed');
  const auth=Buffer.from(String(req.headers.authorization||''));
  if(auth.length!==secret.length||!timingSafeEqual(auth,secret))return fail(res,401,'native_relay_unauthorized');
  if(req.method!=='POST'||req.url!=='/v1/chat/completions')return fail(res,404,'native_relay_route_not_found');
  const controller=new AbortController();requests.add(controller);
  const abort=()=>controller.abort(input.signal.reason??new Error('Native inference cancelled'));
  input.signal.addEventListener('abort',abort,{once:true});
  const disconnected=()=>{if(!res.writableFinished)controller.abort(new Error('Native relay client disconnected'));};
  res.on('close',disconnected);
  try {
   let size=0;const chunks:Buffer[]=[];
   for await(const chunk of req){size+=chunk.length;if(size>limit){fail(res,413,'native_relay_request_too_large');return;}chunks.push(chunk);}
   let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail(res,400,'native_relay_invalid_json');}
   if(!body||typeof body!=='object'||Array.isArray(body)||!Array.isArray(body.messages))return fail(res,400,'native_relay_invalid_request');
   if(body.model!==input.request.model)return fail(res,409,'native_relay_model_mismatch');
   // Even a future plugin cannot use this relay to acquire model tools. Native
   // role inference is pure reasoning; authenticated host code owns tool APIs.
   if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length))return fail(res,400,'native_relay_tools_forbidden');
   if(body.tool_choice!==undefined&&body.tool_choice!=='none')return fail(res,400,'native_relay_tools_forbidden');
   const forwarded:Record<string,any>={...body,...parameters,model:body.model,messages:body.messages,stream:body.stream};
   delete forwarded.tools;delete forwarded.tool_choice;delete forwarded.parallel_tool_calls;
   // Adapters may choose the other OpenAI token spelling by default. Do not
   // leave a 32768-token adapter default beside a host's explicit 1024 cap.
   if(Object.hasOwn(input.request,'max_tokens')&&!Object.hasOwn(input.request,'max_completion_tokens'))delete forwarded.max_completion_tokens;
   if(Object.hasOwn(input.request,'max_completion_tokens')&&!Object.hasOwn(input.request,'max_tokens'))delete forwarded.max_tokens;
   const serialized=JSON.stringify(forwarded);
   if(Buffer.byteLength(serialized)>limit)return fail(res,413,'native_relay_request_too_large');
   if(providerRequests!==0)return fail(res,409,'native_relay_retry_forbidden');
   providerRequests++;
   const upstreamResponse=await (input.fetchImpl??fetch)(upstream,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+input.provider.apiKey},body:serialized,signal:controller.signal,redirect:'error'});
   let responseBytes=0;const decoder=new TextDecoder();let sseBuffer='';
   const isSse=Boolean(upstreamResponse.headers.get('content-type')?.includes('text/event-stream'));
   const rejectLength=(value:any)=>{if(value?.choices?.some((choice:any)=>choice.finish_reason==='length'))throw new Error('Native model output reached its token limit');};
   const responseHeaders={'content-type':upstreamResponse.headers.get('content-type')||'application/json','cache-control':'no-store'};
   if(!isSse){
    const buffered:Buffer[]=[];
    if(upstreamResponse.body)for await(const chunk of upstreamResponse.body as any){controller.signal.throwIfAborted();responseBytes+=chunk.length;if(responseBytes>16*1024*1024)throw new Error('Native relay response too large');buffered.push(Buffer.from(chunk));}
    const bytes=Buffer.concat(buffered);let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{if(upstreamResponse.ok)throw new Error('Native provider returned invalid JSON');}
    if(parsed)rejectLength(parsed);res.writeHead(upstreamResponse.status,responseHeaders);res.end(bytes);return;
   }
   res.writeHead(upstreamResponse.status,responseHeaders);
   if(upstreamResponse.body){for await(const chunk of upstreamResponse.body as any){if(controller.signal.aborted)throw controller.signal.reason;responseBytes+=chunk.length;if(responseBytes>16*1024*1024)throw new Error('Native relay response too large');
    if(isSse){sseBuffer=(sseBuffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');let end;while((end=sseBuffer.indexOf('\n\n'))>=0){const event=sseBuffer.slice(0,end);sseBuffer=sseBuffer.slice(end+2);const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data&&data!=='[DONE]'){let parsed;try{parsed=JSON.parse(data);}catch{}if(parsed)rejectLength(parsed);}}if(sseBuffer.length>limit)throw new Error('Native relay event too large');}
    if(!res.write(chunk))await new Promise<void>((resolve,reject)=>{res.once('drain',resolve);res.once('close',()=>reject(new Error('Relay client closed')));});}}
   res.end();
  }catch{fail(res,input.signal.aborted?504:502,input.signal.aborted?'native_relay_deadline':'native_relay_upstream_error');}
  finally{input.signal.removeEventListener('abort',abort);res.removeListener('close',disconnected);requests.delete(controller);}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.headersTimeout=10000;server.requestTimeout=0;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('Native relay failed to bind loopback');
 let closing:Promise<void>|undefined;
 function close():Promise<void>{
  if(closing)return closing;
  closed=true;input.signal.removeEventListener('abort',abortAll);
  for(const controller of requests)controller.abort(new Error('Native relay closed'));
  closing=new Promise<void>(resolve=>server.close(()=>resolve()));
  server.closeAllConnections();for(const socket of sockets)socket.destroy();return closing;
 }
 const abortAll=()=>{void close();};
 input.signal.addEventListener('abort',abortAll,{once:true});
 if(input.signal.aborted)await close();
 return {provider:{apiBase:`http://127.0.0.1:${address.port}/v1`,apiKey:key},close};
}
