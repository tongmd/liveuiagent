import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommandRunner } from '../runner.mjs';

async function paths() {
  const root = await mkdtemp(path.join(tmpdir(), 'liveuiagent-runner-test-'));
  const work = path.join(root, 'work'); const home = path.join(root, 'home');
  await mkdir(work); await mkdir(home);
  return { work, home };
}

test('runner forwards stdin, cwd, DSH_HOME and JSONL events without a shell', async () => {
  const dirs = await paths();
  const code = `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{console.log('diagnostic');console.log(JSON.stringify({type:'tool_call',name:'write'}));process.stdout.write(JSON.stringify({type:'final',text:JSON.stringify({text,cwd:process.cwd(),home:process.env.DSH_HOME,arg:process.argv[1]})}));});`;
  const runner = createCommandRunner({ command: process.execPath, args: ['-e', code, '{work}'] });
  const events = [];
  const task = 'literal $(echo should-not-execute) `also literal`';
  const result = await runner.run({ ...dirs, task, signal: new AbortController().signal, onEvent: event => events.push(event) });
  assert.deepEqual(events.map(event => event.type), ['tool_call', 'final']);
  assert.deepEqual(JSON.parse(result.answer), { text: task, cwd: await realpath(dirs.work), home: dirs.home, arg: dirs.work });
  await runner.dispose();
});

test('selected model reaches a per-job profile and provider credentials only reach the child environment',async t=>{
  const dirs=await paths();
  const code=`const fs=require('node:fs');const p=process.argv[process.argv.indexOf('--patch')+1];console.log(JSON.stringify({type:'final',text:JSON.stringify({profile:fs.readFileSync(p,'utf8'),key:process.env.LIVEUI_LLM_API_KEY,base:process.env.LIVEUI_LLM_API_BASE})}));`;
  const runner=createCommandRunner({command:process.execPath,args:['-e',code,'--']});t.after(()=>runner.dispose());
  const result=JSON.parse((await runner.run({...dirs,task:'',model:'selected/model',provider:{apiKey:'private-fixture',apiBase:'https://provider.example/v1'},signal:new AbortController().signal,onEvent(){}})).answer);
  assert.match(result.profile,/selected\/model/);assert.match(result.profile,/apiKeyEnv: LIVEUI_LLM_API_KEY/);assert.ok(!result.profile.includes('private-fixture'));
  assert.equal(result.key,'private-fixture');assert.equal(result.base,'https://provider.example/v1');
  await assert.rejects(access(path.join(dirs.home,'liveui-model.patch.yml')));
});

test('runner abort kills an active process and reports cancellation', async () => {
  const dirs = await paths();
  const runner = createCommandRunner({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"ready"}));setInterval(()=>{},1000);'] });
  const controller = new AbortController();
  const task = runner.run({ ...dirs, task: '', signal: controller.signal, onEvent: event => { if (event.type === 'ready') controller.abort(new Error('cancelled for test')); } });
  await assert.rejects(task, /cancelled for test/);
  await runner.dispose();
});

test('nonzero process exits fail without exposing stderr as a user error', async () => {
  const dirs = await paths();
  const runner = createCommandRunner({ command: process.execPath, args: ['-e', 'console.error("sensitive test diagnostics");process.exit(7);'] });
  await assert.rejects(runner.run({ ...dirs, task: '', signal: new AbortController().signal, onEvent() {} }), { message: 'DSH exited with code 7' });
  await runner.dispose();
});

test('a provider error status fails even when the DSH process exits successfully',async t=>{
  const dirs=await paths();const runner=createCommandRunner({command:process.execPath,args:['-e',`console.log(JSON.stringify({type:'status',reason:{kind:'error',error:{code:'PI_AI_ERROR',message:'private diagnostics'}}}));console.log(JSON.stringify({type:'final',text:''}));`]});t.after(()=>runner.dispose());
  await assert.rejects(runner.run({...dirs,task:'',signal:new AbortController().signal,onEvent(){}}),{message:'DSH model request failed (PI_AI_ERROR)'});
});

test('runner forwards only platform and explicitly allowed environment variables', async t => {
  const originalAllowed = process.env.LIVEUIAGENT_TEST_ALLOWED;
  const originalPrivate = process.env.LIVEUIAGENT_TEST_PRIVATE;
  process.env.LIVEUIAGENT_TEST_ALLOWED = 'allowed-fixture';
  process.env.LIVEUIAGENT_TEST_PRIVATE = 'private-fixture';
  t.after(() => {
    for (const [name, value] of [['LIVEUIAGENT_TEST_ALLOWED', originalAllowed], ['LIVEUIAGENT_TEST_PRIVATE', originalPrivate]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const dirs = await paths();
  const code = 'console.log(JSON.stringify({type:"final",text:JSON.stringify({allowed:process.env.LIVEUIAGENT_TEST_ALLOWED,private:process.env.LIVEUIAGENT_TEST_PRIVATE,home:process.env.DSH_HOME})}));';
  const runner = createCommandRunner({ command: process.execPath, args: ['-e', code], passEnv: ['LIVEUIAGENT_TEST_ALLOWED', 'DSH_HOME'] });
  t.after(() => runner.dispose());
  const result = await runner.run({ ...dirs, task: '', signal: new AbortController().signal, onEvent() {} });
  assert.deepEqual(JSON.parse(result.answer), { allowed: 'allowed-fixture', home: dirs.home });
});

test('abort kills a descendant holding stdout after the group leader exits', { skip: process.platform === 'win32', timeout: 8000 }, async t => {
  const dirs = await paths();
  const descendant = 'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"ready",pid:process.pid}));setInterval(()=>{},1000);';
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});process.on('SIGTERM',()=>process.exit(0));`;
  const runner = createCommandRunner({ command: process.execPath, args: ['-e', parent] });
  const controller = new AbortController();
  let descendantPid;
  t.after(async () => {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await runner.dispose();
  });
  const result = runner.run({ ...dirs, task: '', signal: controller.signal, onEvent(event) {
    if (event.type === 'ready') { descendantPid = event.pid; controller.abort(new Error('cancel process tree')); }
  } });
  await assert.rejects(result, /cancel process tree/);
  assert.ok(descendantPid, 'descendant started and inherited the output pipe');
});

test('provider launcher overlay precedes headless JSON flag',async t=>{
  const dirs=await paths();
  const code=`console.log(JSON.stringify({type:'final',text:JSON.stringify(process.argv.slice(1))}));`;
  const runner=createCommandRunner({command:process.execPath,args:['-e',code,'--','--profile','headless','--json']});t.after(()=>runner.dispose());
  const argv=JSON.parse((await runner.run({...dirs,task:'',model:'fixture',provider:{apiKey:'private-fixture',apiBase:'http://provider.example/v1'},signal:new AbortController().signal,onEvent(){}})).answer);
  assert.ok(argv.indexOf('--patch')>=0);assert.ok(argv.indexOf('--patch')<argv.indexOf('--json'));
});
