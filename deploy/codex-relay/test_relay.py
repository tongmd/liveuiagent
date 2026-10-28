"""No network/model calls: wire validation and subprocess lifecycle regression tests."""
import asyncio,json,os,pathlib,sys,tempfile,unittest
from relay import Relay,RelayError,ResponsesRunner,validate_request
from codex_response import make_payload,parse_events

FAKE='''import sys,json,time,os,pathlib
pid=pathlib.Path(sys.argv[2]);tmp=pid.with_suffix('.new');tmp.write_text(str(os.getpid()));tmp.replace(pid)
request=json.loads(sys.stdin.readline())
mode=sys.argv[1]
if mode=='format':assert request['response_format']=='json_object'
if mode=='hang':time.sleep(30)
if mode in ('tool','error'):
 print(json.dumps({'error':'tool_output_rejected' if mode=='tool' else 'response_failed'}),flush=True);sys.exit(1)
print(json.dumps({'content':'{"ok":true}','model':'test-model'}),flush=True)
'''
class WireTests(unittest.TestCase):
 def test_explicit_json_object_format_reaches_responses_payload(self):
  p=make_payload('test-model',[{'role':'user','content':'Return JSON'}],None,'high',True)
  self.assertEqual(p['text'],{'format':{'type':'json_object'}})
  self.assertEqual(p['tools'],[])
 def test_ordered_roles_no_tools_or_private_context(self):
  messages=[{'role':'system','content':'host instruction'},{'role':'user','content':'request'},{'role':'assistant','content':'prior response'},{'role':'user','content':'followup'}]
  p=make_payload('test-model',messages,None,'high')
  self.assertEqual(p['tools'],[]);self.assertEqual(p['tool_choice'],'none');self.assertFalse(p['store'])
  self.assertEqual([m['role'] for m in p['input']],['developer','user','assistant','user'])
  self.assertEqual([m['content'] for m in p['input']],[m['content'] for m in messages])
  self.assertNotIn('additional_tools',json.dumps(p));self.assertNotIn('SKILL.md',json.dumps(p))
 def test_tools_and_tool_messages_rejected(self):
  for body in [{'tools':[{}],'messages':[{'role':'user','content':'x'}]},{'messages':[{'role':'tool','content':'x'}]}]:
   with self.assertRaises(RelayError):validate_request(body,{'test-model'},'test-model')
 def test_completed_sse_model_metadata(self):
  lines=[{'type':'response.output_text.delta','delta':'{"ok":true}'},{'type':'response.completed','response':{'status':'completed','model':'test-model','output':[]}}]
  metadata={};self.assertEqual(parse_events([b'data: '+json.dumps(x).encode() for x in lines],'test-model',metadata),'{"ok":true}');self.assertTrue(metadata['modelVerified'])
 def test_missing_model_not_claimed_verified(self):
  lines=[{'type':'response.completed','response':{'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':'{"ok":true}'}]}]}}]
  metadata={};parse_events([b'data: '+json.dumps(x).encode() for x in lines],'test-model',metadata);self.assertFalse(metadata['modelVerified'])
 def test_model_mismatch(self):
  lines=[b'data: '+json.dumps({'type':'response.completed','response':{'model':'other','output':[]}}).encode()]
  with self.assertRaisesRegex(RuntimeError,'model_mismatch'):parse_events(lines,'test-model')
 def test_incomplete_invalid_json_and_tool_rejected(self):
  for events in [[{'type':'response.output_text.delta','delta':'{"ok":true}'}],[{'type':'response.output_item.added','item':{'type':'function_call','name':'shell'}}],[{'type':'response.completed','response':{'output':[{'type':'function_call','name':'shell'}]}}],[{'type':'response.output_text.delta','delta':'not json'},{'type':'response.completed','response':{}}]]:
   with self.assertRaises(RuntimeError):parse_events([b'data: '+json.dumps(x).encode() for x in events])

class ProcessTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=pathlib.Path(self.tmp.name);(self.p/'fake.py').write_text(FAKE);self.servers=[]
 async def asyncTearDown(self):
  for server in self.servers:server.close();await server.wait_closed()
  self.tmp.cleanup()
 def runner(self,mode):return ResponsesRunner(sys.executable,self.p/'noauth',command_factory=lambda:[sys.executable,str(self.p/'fake.py'),mode,str(self.p/'pid')])
 def assert_dead(self):
  pid=int((self.p/'pid').read_text())
  with self.assertRaises(ProcessLookupError):os.kill(pid,0)
 async def test_completed(self):
  text,meta=await self.runner('ok').infer('test-model',[{'role':'user','content':'x'}]);self.assertEqual(json.loads(text),{'ok':True});self.assert_dead()
 async def test_error_redacted(self):
  with self.assertRaises(RelayError) as ctx:await self.runner('error').infer('test-model',[])
  self.assertEqual(ctx.exception.code,'response_failed');self.assert_dead()
 async def test_tool_rejected(self):
  with self.assertRaises(RelayError) as ctx:await self.runner('tool').infer('test-model',[])
  self.assertEqual(ctx.exception.code,'tool_output_rejected');self.assert_dead()
 async def start(self,mode,timeout=2):
  relay=Relay(self.runner(mode),'x'*40,model='test-model',timeout=timeout)
  s=await asyncio.start_server(relay.handle,'127.0.0.1',0);self.servers.append(s);return s.sockets[0].getsockname()[1],relay
 async def request(self,port,token=True,keep_open=False,response_format=None):
  r,w=await asyncio.open_connection('127.0.0.1',port)
  body={'messages':[{'role':'user','content':'test'}]}
  if response_format:body['response_format']={'type':response_format}
  data=json.dumps(body).encode();auth='x'*40 if token else 'wrong'
  w.write(f'POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer {auth}\r\nContent-Length: {len(data)}\r\n\r\n'.encode()+data);await w.drain()
  if keep_open:return r,w
  out=await r.read();w.close();await w.wait_closed();return out
 async def test_timeout_reaps(self):
  port,relay=await self.start('hang',1);out=await self.request(port);self.assertIn(b'504',out);self.assert_dead();self.assertEqual(relay.active,0)
 async def test_abort_reaps(self):
  port,relay=await self.start('hang',10);r,w=await self.request(port,keep_open=True)
  for _ in range(300):
   if (self.p/'pid').exists():break
   await asyncio.sleep(.01)
  self.assertTrue((self.p/'pid').exists());w.close();await w.wait_closed()
  for _ in range(300):
   if relay.active==0:break
   await asyncio.sleep(.01)
  self.assert_dead();self.assertEqual(relay.active,0)
 async def test_auth_and_capacity_no_child_started(self):
  port,relay=await self.start('hang',10);out=await self.request(port,False);self.assertIn(b'401',out);self.assertFalse((self.p/'pid').exists())
  relay.active=4;out=await self.request(port);self.assertIn(b'429',out);self.assertFalse((self.p/'pid').exists());relay.active=0
 async def test_http_response_contract(self):
  port,_=await self.start('ok');out=await self.request(port);body=json.loads(out.split(b'\r\n\r\n',1)[1]);self.assertEqual(json.loads(body['choices'][0]['message']['content']),{'ok':True});self.assertEqual(body['liveui']['toolsExecuted'],0)
 async def test_http_json_format_reaches_real_child(self):
  port,_=await self.start('format');out=await self.request(port,response_format='json_object');body=json.loads(out.split(b'\r\n\r\n',1)[1]);self.assertEqual(json.loads(body['choices'][0]['message']['content']),{'ok':True});self.assert_dead()
if __name__=='__main__':unittest.main()
