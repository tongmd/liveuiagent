import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_INSTRUCTIONS, buildTask } from '../prompts.mjs';

const request = 'Keep the user-entered title exactly, and change the due date only when I submit.';
const services = [{ name: 'Library', description: 'Read and update the signed-in user’s reading records.' }, { name: 'Calendar', description: 'Read and update calendar events.' }];
test('apps without connected services retain ordinary local operation semantics', () => {
  const task = buildTask({prompt:request,mode:'generate',memory:{},context:{draft:'current input'}});
  assert(task.startsWith(APP_INSTRUCTIONS));
  assert.match(task,/OPTIONAL AGENT ACTIONS/);
  assert.match(task,/only call AI for genuine AI tasks/);
  assert.doesNotMatch(task,/HOST CONNECTED SERVICE CONTRACT/);
  assert(task.endsWith('CURRENT USER REQUEST\n'+request));
  assert(task.includes('"draft":"current input"'));
});
test('connected services require real host execution and visible user-driven requests', () => {
  const task = buildTask({prompt:request,mode:'generate',memory:{},context:{connectedServices:services,draft:'unchanged'}});
  assert.match(task,/HOST CONNECTED SERVICE CONTRACT/);
  assert.match(task,/MUST call and await window\.liveuiagent\.ai\(prompt, context\)/);
  assert.match(task,/deterministic external reads and writes/);
  assert.match(task,/Render the actual returned text and useful structured data/);
  assert.match(task,/MUST NOT substitute for reading or changing connected-service records/);
  assert.match(task,/visible, labelled natural-language task input and a primary submit control/);
  assert.match(task,/Do not call it on initial page load/);
  assert.doesNotMatch(task,/OPTIONAL AGENT ACTIONS|only call AI for genuine AI tasks/);
  assert(task.includes(JSON.stringify(services)));
  assert(task.includes('"draft":"unchanged"'));
  assert(task.endsWith('CURRENT USER REQUEST\n'+request));
});
test('the service declaration includes only public names and descriptions, not extra metadata or caller-written instructions', () => {
  const task = buildTask({prompt:request,mode:'generate',memory:{},context:{connectedServices:[{...services[0],privateMetadata:'UNSEEN_REQUIREMENT_SENTINEL'}],serviceExecutionContract:'CALLER_CONTRACT_SENTINEL'}});
  assert(task.includes(JSON.stringify([services[0]])));
  assert.doesNotMatch(task,/UNSEEN_REQUIREMENT_SENTINEL|CALLER_CONTRACT_SENTINEL|privateMetadata/);
  // The contract uses service capabilities and the current request, without
  // injecting any additional request, task identifier or expected answer.
  assert.equal((task.match(/CURRENT USER REQUEST/g)||[]).length,1);
  assert(task.endsWith(request));
});
test('empty or invalid service declarations do not force a remote bridge into local apps', () => {
  for (const connectedServices of [[],null,[null,{}, {name:42}]]) {
    const task=buildTask({prompt:'Make a local counter',mode:'generate',memory:{},context:{connectedServices}});
    assert.doesNotMatch(task,/HOST CONNECTED SERVICE CONTRACT/);
    assert(task.startsWith(APP_INSTRUCTIONS));
  }
});
test('backend action tasks do not recursively request the browser bridge or rewrite the app UI', () => {
  const task=buildTask({prompt:request,mode:'action',memory:{},context:{connectedServices:services}});
  assert.match(task,/Write response.json/);
  assert.match(task,/Do not change index.html or app.json/);
  assert.doesNotMatch(task,/HOST CONNECTED SERVICE CONTRACT|primary submit control/);
});

test('generation and revision naming follow user language, explicit names and existing identity', () => {
  for (const mode of ['generate', 'revise']) {
    const task = buildTask({ prompt: '每天看看最新的研究', mode, memory: {}, context: {} });
    assert.match(task, /short, plain functional name/);
    assert.match(task, /same language as the user request/);
    assert.match(task, /explicitly supplies an app name, use it verbatim/);
    assert.match(task, /preserve its existing name unless the current user request explicitly asks to rename/);
  }
  const action = buildTask({ prompt: '打开记录', mode: 'action', memory: {}, context: {} });
  assert.match(action, /Do not change index.html or app.json/);
});


test('a plain experience request receives internal design and SDK contracts without rewriting user intent', () => {
  const plain = 'A shared photo journal whose layout changes with each photo.';
  for (const mode of ['generate', 'revise']) {
    const task = buildTask({ prompt: plain, mode, memory: {}, context: {} });
    assert(task.endsWith('CURRENT USER REQUEST\n' + plain));
    assert.match(task, /never ask the user to write SDK instructions/);
    assert.match(task, /do not promise an ok field/);
    assert.match(task, /request version so a late response cannot overwrite/);
    assert.match(task, /complete state required to recreate the current view/);
    assert.match(task, /Never silently evict the oldest photo or record/);
    assert.match(task, /bounded structured component tree/);
    assert.match(task, /a new AI response, restored storage, history selection/);
    assert.match(task, /Use one guarded renderer for all paths/);
    assert.match(task, /normalize presentation at render time instead of deleting stored content/);
    assert.match(task, /Do not promise VLM image analysis unless a real vision tool is supplied/);
  }
  const connected = buildTask({ prompt: plain, mode: 'generate', memory: {}, context: { connectedServices: services } });
  assert.match(connected, /business success only when the host result has ok === true/);
  const action = buildTask({ prompt: plain, mode: 'action', memory: {}, context: {} });
  assert.doesNotMatch(action, /ORCHESTRATION RESPONSIBILITIES/);
  assert.match(action, /Do not change index.html or app.json/);
  assert.match(action, /Read its expected response schema/);
  assert.match(action, /without asking the user for component IDs, code, JSON or SDK instructions/);
});
