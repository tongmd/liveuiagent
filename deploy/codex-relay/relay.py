#!/usr/bin/env python3
"""Loopback-only, authenticated liveUI JSON inference through local Codex login.
No conversation resume, no business/tool execution, no request-body logging.
"""
import argparse, asyncio, contextlib, hmac, json, os, pathlib, shutil, signal, sys, time, uuid

VERSION='liveui-codex-relay-v1'
class RelayError(Exception):
 def __init__(self,code,message,status=502): self.code,self.message,self.status=code,message,status

def validate_request(body,allowed_models,default_model):
 if not isinstance(body,dict): raise RelayError('invalid_request','Request must be an object',400)
 if body.get('stream'): raise RelayError('invalid_request','Streaming is not supported',400)
 if body.get('tools') or body.get('functions'): raise RelayError('tools_not_allowed','Relay does not execute tools',400)
 model=body.get('model') or default_model
 if model not in allowed_models: raise RelayError('invalid_model','Model is not configured for this relay',400)
 messages=body.get('messages')
 if not isinstance(messages,list) or not 1<=len(messages)<=256: raise RelayError('invalid_messages','Expected 1 to 256 ordered messages',400)
 for m in messages:
  if not isinstance(m,dict) or m.get('role') not in ('system','developer','user','assistant') or not isinstance(m.get('content'),str): raise RelayError('invalid_messages','Only textual ordered messages are supported',400)
 fmt=body.get('response_format') or {}
 schema=None
 if fmt.get('type')=='json_schema':
  schema=fmt.get('json_schema',{}).get('schema')
  if not isinstance(schema,dict): raise RelayError('invalid_schema','Missing JSON schema',400)
 return model,messages,schema

async def terminate(proc):
 if proc.returncode is None:
  with contextlib.suppress(ProcessLookupError): os.killpg(proc.pid,signal.SIGTERM)
  try: await asyncio.wait_for(proc.wait(),2)
  except asyncio.TimeoutError:
   with contextlib.suppress(ProcessLookupError): os.killpg(proc.pid,signal.SIGKILL)
   await proc.wait()

AUTH_LOCK=asyncio.Lock()
AUTH_GENERATIONS={}
async def refresh_auth(executable,auth_file,expected_generation=None):
 key=str(pathlib.Path(auth_file).resolve())
 async with AUTH_LOCK:
  # Another request already refreshed this login while this request waited.
  if expected_generation is not None and AUTH_GENERATIONS.get(key,0)!=expected_generation:return
  env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','USER','LOGNAME','TMPDIR','LANG','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy')}
  env['CODEX_HOME']=str(auth_file.parent)
  proc=await asyncio.create_subprocess_exec(executable,'app-server','--stdio',env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True,limit=1024*1024)
  async def rpc(ident,method,params):
   proc.stdin.write((json.dumps({'id':ident,'method':method,'params':params})+'\n').encode());await proc.stdin.drain()
   while True:
    line=await proc.stdout.readline()
    if not line:raise RelayError('auth_refresh_failed','Codex authentication check failed',503)
    e=json.loads(line)
    if e.get('id')==ident:
     if 'error'in e:raise RelayError('auth_refresh_failed','Codex authentication refresh failed',503)
     return e.get('result',{})
  try:
   async def check():
    await rpc(1,'initialize',{'clientInfo':{'name':'liveui_auth_check','version':'1.0.0'}})
    proc.stdin.write(b'{"method":"initialized","params":{}}\n');await proc.stdin.drain()
    result=await rpc(2,'account/read',{'refreshToken':True})
    if not result.get('account'):raise RelayError('auth_required','Codex login is required on the relay Mac',503)
   await asyncio.wait_for(check(),25)
   AUTH_GENERATIONS[key]=AUTH_GENERATIONS.get(key,0)+1
  finally:await asyncio.shield(terminate(proc))

class ResponsesRunner:
 def __init__(self,executable,auth_file,effort='high',command_factory=None):
  self.executable,self.auth_file,self.effort=executable,pathlib.Path(auth_file),effort;self.command_factory=command_factory
 async def infer(self,model,messages,schema=None,response_format=None):
  # Only a definite authentication rejection warrants refresh plus one retry.
  generation=AUTH_GENERATIONS.get(str(self.auth_file.resolve()),0)
  try:return await self._infer_once(model,messages,schema,response_format)
  except RelayError as failure:
   if failure.code!='codex_http_401':raise
  await refresh_auth(self.executable,self.auth_file,expected_generation=generation)
  return await self._infer_once(model,messages,schema,response_format)
 async def _infer_once(self,model,messages,schema=None,response_format=None):
  env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','USER','LANG','TMPDIR','LIVEUI_CODEX_PROXY')}
  cmd=self.command_factory() if self.command_factory else [sys.executable,str(pathlib.Path(__file__).with_name('codex_response.py')),str(self.auth_file)]
  proc=await asyncio.create_subprocess_exec(*cmd,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True,limit=3*1024*1024)
  try:
   proc.stdin.write((json.dumps({'model':model,'messages':messages,'schema':schema,'effort':self.effort,'response_format':response_format},ensure_ascii=False)+'\n').encode());await proc.stdin.drain();proc.stdin.close()
   line=await proc.stdout.readline();await proc.wait()
   try:result=json.loads(line)
   except Exception:raise RelayError('codex_transport_failed','Codex returned an invalid transport response')
   if proc.returncode or result.get('error'):
    code=result.get('error','codex_transport_failed')
    # Child emits a closed list of safe error codes, never upstream response bodies.
    if not isinstance(code,str) or not all(c.isalnum() or c=='_' for c in code):code='codex_transport_failed'
    raise RelayError(code,'Codex inference failed ('+code+')',503 if code in ('codex_http_401','codex_http_429') else 502)
   content=result.get('content','')
   try:json.loads(content)
   except Exception:raise RelayError('invalid_json','Codex did not return valid JSON')
   return content,{'transport':'codex-responses','model':result.get('model') or model,'upstreamModel':result.get('upstreamModel'),'modelVerified':result.get('modelVerified',False)}
  finally:await asyncio.shield(terminate(proc))

class Relay:
 def __init__(self,runner,token,model='gpt-6-astra',models=None,timeout=180,max_concurrency=4,max_body=2*1024*1024):
  self.runner,self.token,self.model=runner,token,model;self.models=set(models or [model]);self.timeout=min(timeout,300);self.max_concurrency=max_concurrency;self.active=0;self.max_body=max_body
 async def handle(self,reader,writer):
  status=200; payload=None; admitted=False
  try:
   raw=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),10)
   if len(raw)>16384: raise RelayError('headers_too_large','Headers too large',431)
   lines=raw.decode('latin1').split('\r\n'); method,path,_=lines[0].split(' ',2)
   headers={}
   for line in lines[1:]:
    if ':' in line:
     k,v=line.split(':',1);k=k.lower()
     if k in headers: raise RelayError('invalid_request','Duplicate headers',400)
     headers[k]=v.strip()
   if not hmac.compare_digest(headers.get('authorization',''),f'Bearer {self.token}'): raise RelayError('unauthorized','Authentication required',401)
   if method=='GET' and path=='/health': payload={'status':'ok','service':VERSION,'model':self.model,'active':self.active,'capacity':self.max_concurrency,'tools':False}
   elif method=='POST' and path=='/v1/chat/completions':
    if 'transfer-encoding' in headers: raise RelayError('invalid_request','Chunked requests not supported',400)
    try: length=int(headers.get('content-length','0'))
    except ValueError: raise RelayError('invalid_request','Invalid content length',400)
    if not 0<length<=self.max_body: raise RelayError('request_too_large','Request exceeds body limit',413)
    try: body=json.loads(await asyncio.wait_for(reader.readexactly(length),15))
    except (ValueError,asyncio.IncompleteReadError): raise RelayError('invalid_request','Invalid JSON body',400)
    model,messages,schema=validate_request(body,self.models,self.model)
    if self.active>=self.max_concurrency: raise RelayError('busy','Relay inference capacity reached',429)
    try: requested=float(headers.get('x-liveui-timeout-ms',self.timeout*1000))/1000
    except ValueError: raise RelayError('invalid_timeout','Invalid timeout',400)
    timeout=max(.05,min(self.timeout,requested))
    self.active+=1;admitted=True;start=time.monotonic()
    response_format=(body.get('response_format') or {}).get('type')
    work=asyncio.create_task(self.runner.infer(model,messages,schema,response_format='json_object')) if response_format=='json_object' else asyncio.create_task(self.runner.infer(model,messages,schema)); disconnect=asyncio.create_task(reader.read(1))
    try:
     done,_=await asyncio.wait([work,disconnect],timeout=timeout,return_when=asyncio.FIRST_COMPLETED)
     if disconnect in done: raise RelayError('client_disconnected','Client disconnected',499)
     if work not in done: raise RelayError('timeout','Codex inference deadline exceeded',504)
     content,meta=await work
    finally:
     for task in (work,disconnect):
      if not task.done():task.cancel()
     await asyncio.gather(work,disconnect,return_exceptions=True)
    payload={'id':'chatcmpl-codex-'+uuid.uuid4().hex,'object':'chat.completion','created':int(time.time()),'model':meta.get('model') or model,'choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'liveui':{'transport':'codex-responses','elapsedMs':round((time.monotonic()-start)*1000),'toolsExecuted':0,'upstreamModel':meta.get('upstreamModel'),'modelVerified':meta.get('modelVerified',False)}}
   else: raise RelayError('not_found','Route not found',404)
  except RelayError as e: status=e.status;payload={'error':{'code':e.code,'message':e.message}}
  except (asyncio.TimeoutError,asyncio.LimitOverrunError): status=408;payload={'error':{'code':'request_timeout','message':'Request timed out'}}
  except Exception: status=502;payload={'error':{'code':'relay_error','message':'Codex relay request failed'}}
  finally:
   if admitted:self.active-=1
   if payload is not None and status!=499:
    data=json.dumps(payload,ensure_ascii=False).encode()
    with contextlib.suppress(Exception):
     writer.write(f'HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n'.encode()+data);await writer.drain()
   writer.close()
   with contextlib.suppress(Exception):await writer.wait_closed()

async def main():
 p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=19503);p.add_argument('--token-file',required=True);p.add_argument('--auth-file',default=str(pathlib.Path.home()/'.codex/auth.json'));p.add_argument('--codex',default=shutil.which('codex') or 'codex');p.add_argument('--model',default='gpt-6-astra');p.add_argument('--effort',default='high',choices=['low','medium','high']);p.add_argument('--timeout',type=int,default=180);a=p.parse_args()
 token=pathlib.Path(a.token_file).read_text().strip()
 if len(token)<32:raise SystemExit('Relay bearer must contain at least 32 characters')
 runner=ResponsesRunner(a.codex,a.auth_file,a.effort); relay=Relay(runner,token,a.model)
 server=await asyncio.start_server(relay.handle,'127.0.0.1',a.port,limit=16384)
 print(json.dumps({'service':VERSION,'listen':f'127.0.0.1:{a.port}','model':a.model}),flush=True)
 async with server:await server.serve_forever()
if __name__=='__main__':asyncio.run(main())
