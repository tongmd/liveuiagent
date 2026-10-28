#!/usr/bin/env python3
"""Single Codex OAuth inference subprocess. Never exposes a tool or executes code."""
import json,os,sys,urllib.request,urllib.error
ENDPOINT='https://chatgpt.com/backend-api/codex/responses'
INSTRUCTIONS='You are liveUI JSON inference. Follow the ordered system/developer/user/assistant conversation supplied below. Return exactly the JSON object or value requested, without markdown. You have no tools. Do not execute commands, access files, contact services, or perform business actions; the liveUI host owns all such actions.'

def make_payload(model,messages,schema,effort):
 # Preserve roles and order. Responses calls use developer for system policies.
 # No private session, skill catalog, environment, or filesystem context is added.
 payload={'model':model,'instructions':INSTRUCTIONS,'input':[{'role':'developer' if m['role']=='system' else m['role'],'content':m['content']} for m in messages],
          'tools':[],'tool_choice':'none','parallel_tool_calls':False,'stream':True,'store':False,'reasoning':{'effort':effort}}
 if schema is not None:payload['text']={'format':{'type':'json_schema','name':'liveui_result','schema':schema,'strict':True}}
 return payload

def parse_events(lines,expected_model=None,metadata=None):
 chunks=[];complete=None;total=0
 for line in lines:
  if not line.startswith(b'data:'):continue
  data=line[5:].strip()
  if data==b'[DONE]':continue
  try:event=json.loads(data)
  except Exception:raise RuntimeError('invalid_sse')
  kind=event.get('type','')
  if kind in ('response.output_item.added','response.output_item.done'):
   item=event.get('item',{});typ=item.get('type')
   if typ not in ('message','reasoning'):raise RuntimeError('tool_output_rejected')
  if kind=='response.output_text.delta':
   chunk=event.get('delta','');total+=len(chunk.encode())
   if total>2*1024*1024:raise RuntimeError('output_too_large')
   chunks.append(chunk)
  elif kind in ('error','response.failed','response.incomplete'):raise RuntimeError('response_failed')
  elif kind=='response.completed':
   complete=event.get('response',{})
   if complete.get('status') not in (None,'completed'):raise RuntimeError('response_failed')
   for item in complete.get('output',[]):
    if item.get('type') not in ('message','reasoning'):raise RuntimeError('tool_output_rejected')
 if complete is None:raise RuntimeError('incomplete_response')
 if expected_model and complete.get('model') and complete['model']!=expected_model:raise RuntimeError('model_mismatch')
 if metadata is not None:metadata['upstreamModel']=complete.get('model');metadata['modelVerified']=bool(complete.get('model'))
 content=''.join(chunks).strip()
 if not content:
  content=''.join(part.get('text','') for item in complete.get('output',[]) if item.get('type')=='message' for part in item.get('content',[]) if part.get('type')=='output_text').strip()
 try:json.loads(content)
 except Exception:raise RuntimeError('invalid_json')
 return content

def main():
 request=json.loads(sys.stdin.readline())
 auth=json.load(open(sys.argv[1]))
 if auth.get('auth_mode')!='chatgpt':raise RuntimeError('chatgpt_login_required')
 tokens=auth.get('tokens',{})
 if not tokens.get('access_token') or not tokens.get('account_id'):raise RuntimeError('login_required')
 payload=make_payload(request['model'],request['messages'],request.get('schema'),request['effort'])
 headers={'Authorization':'Bearer '+tokens['access_token'],'ChatGPT-Account-Id':tokens['account_id'],'Content-Type':'application/json','Accept':'text/event-stream','originator':'codex_cli_rs'}
 proxy=os.environ.get('LIVEUI_CODEX_PROXY','')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy} if proxy else {}))
 req=urllib.request.Request(ENDPOINT,data=json.dumps(payload,ensure_ascii=False).encode(),headers=headers)
 meta={}
 try:
  with opener.open(req,timeout=60) as response:content=parse_events(response,request['model'],meta)
 except urllib.error.HTTPError as e:raise RuntimeError('codex_http_'+str(e.code))
 print(json.dumps({'content':content,'transport':'codex-responses','model':request['model'],**meta},ensure_ascii=False),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:
  allowed={'chatgpt_login_required','login_required','invalid_sse','tool_output_rejected','output_too_large','response_failed','incomplete_response','invalid_json','model_mismatch'}
  error=str(e) if str(e) in allowed or str(e).startswith('codex_http_') and str(e)[11:].isdigit() else 'codex_transport_failed'
  print(json.dumps({'error':error}),flush=True);sys.exit(1)
