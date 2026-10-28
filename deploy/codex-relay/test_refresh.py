"""Only fake inference and fake app-server subprocesses are used."""
import asyncio,json,pathlib,tempfile,unittest
from unittest.mock import AsyncMock,patch
import relay
FAKE_AUTH='''#!/usr/bin/env python3
import sys,json,pathlib
p=pathlib.Path(__file__).with_name('refreshes');p.open('a').write('refresh\\n')
for line in sys.stdin:
 req=json.loads(line)
 if 'id' not in req:continue
 result={'account':{'id':'fake'}} if req['method']=='account/read' else {}
 print(json.dumps({'id':req['id'],'result':result}),flush=True)
'''
class RefreshTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.exe=self.root/'fake-codex';self.exe.write_text(FAKE_AUTH);self.exe.chmod(0o700)
  relay.AUTH_LOCK=asyncio.Lock();relay.AUTH_GENERATIONS.clear()
 async def asyncTearDown(self):self.tmp.cleanup()
 def runner(self):return relay.ResponsesRunner(str(self.exe),self.root/'auth.json')
 async def test_success_direct_does_not_refresh(self):
  r=self.runner();r._infer_once=AsyncMock(return_value=('{}',{}))
  with patch.object(relay,'refresh_auth',new=AsyncMock()) as refresh:
   self.assertEqual(await r.infer('model',[]),('{}',{}));refresh.assert_not_awaited();self.assertEqual(r._infer_once.await_count,1)
 async def test_401_refreshes_once_and_retries_once(self):
  r=self.runner();r._infer_once=AsyncMock(side_effect=[relay.RelayError('codex_http_401','safe'),('{}',{})])
  self.assertEqual(await r.infer('model',[]),('{}',{}));self.assertEqual(r._infer_once.await_count,2);self.assertEqual((self.root/'refreshes').read_text().splitlines(),['refresh'])
 async def test_second_401_is_terminal(self):
  r=self.runner();r._infer_once=AsyncMock(side_effect=relay.RelayError('codex_http_401','safe'))
  with self.assertRaises(relay.RelayError):await r.infer('model',[])
  self.assertEqual(r._infer_once.await_count,2);self.assertEqual((self.root/'refreshes').read_text().splitlines(),['refresh'])
 async def test_other_failures_never_refresh_or_replay(self):
  for code in ['codex_http_429','response_failed','incomplete_response','invalid_json','codex_transport_failed','timeout']:
   r=self.runner();r._infer_once=AsyncMock(side_effect=relay.RelayError(code,'safe'))
   with patch.object(relay,'refresh_auth',new=AsyncMock()) as refresh:
    with self.assertRaises(relay.RelayError):await r.infer('model',[])
    refresh.assert_not_awaited();self.assertEqual(r._infer_once.await_count,1)
 async def test_concurrent_401s_share_single_refresh(self):
  runners=[self.runner(),self.runner()]
  for r in runners:
   calls=[0]
   async def infer_once(*args,calls=calls):
    calls[0]+=1
    if calls[0]==1:await asyncio.sleep(.02);raise relay.RelayError('codex_http_401','safe')
    return '{}',{}
   r._infer_once=infer_once
  self.assertEqual(await asyncio.gather(*(r.infer('model',[]) for r in runners)),[('{}',{}),('{}',{})]);self.assertEqual((self.root/'refreshes').read_text().splitlines(),['refresh'])
 async def test_refresh_failure_does_not_replay_inference(self):
  r=self.runner();r._infer_once=AsyncMock(side_effect=relay.RelayError('codex_http_401','safe'))
  with patch.object(relay,'refresh_auth',new=AsyncMock(side_effect=relay.RelayError('auth_refresh_failed','safe'))):
   with self.assertRaises(relay.RelayError) as error:await r.infer('model',[])
   self.assertEqual(error.exception.code,'auth_refresh_failed');self.assertEqual(r._infer_once.await_count,1)
if __name__=='__main__':unittest.main()
