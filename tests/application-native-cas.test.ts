import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveUIRuntime} from '../server/liveuiagent.js';

test('native application edit rejects stale content inside its existing write lock, without model calls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'application-cas-'));
  const db=new Database(':memory:');const prior=process.env.APPWORLD_ENABLED;
  process.env.APPWORLD_ENABLED='false';
  const runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:process.cwd()});
  if(prior===undefined)delete process.env.APPWORLD_ENABLED;else process.env.APPWORLD_ENABLED=prior;
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.prepare(`INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES('app','Fixture','Fixture',?,?,?,'1','alice')`).run('{"manifest":{"name":"Original"}}','{"records":[{"value":73}]}','{"count":2}');
  const before=db.prepare('SELECT * FROM agent_apps').all();let calls=0;
  const input={appId:'app',prompt:'Change the heading',user:'alice',expectedContentHash:'0'.repeat(64),llm:{model:'fixture',chatCompletion:async()=>{calls++;throw Error('Must not infer for a stale edit');}}};
  await assert.rejects(runtime.patchApp(input),(e:any)=>e.status===409&&/changed before editing/.test(e.message));
  await assert.rejects(runtime.patchApp(input),(e:any)=>e.status===409);
  await assert.rejects(runtime.patchApp({...input,user:'bob'}),(e:any)=>e.status===404);
  assert.equal(calls,0);assert.deepEqual(db.prepare('SELECT * FROM agent_apps').all(),before);
});
