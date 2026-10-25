import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserDelivery } from '../browser-delivery.mjs';
const app = (handler, extra = '') => `<html><head></head><body><form id="taskForm" data-liveui-action="agent.invoke"><label>Task<textarea id="task" name="task"></textarea></label><button type="submit" data-liveui-action="agent.invoke">Run task</button></form><p id="result"></p><p id="status"></p>${extra}<script>document.querySelector('#taskForm').onsubmit=async event=>{event.preventDefault();const task=document.querySelector('#task').value;const output=document.querySelector('#result');${handler}};</script></body></html>`;
const good = `const reply=await window.liveuiagent.ai(task,{request:task});if(reply.ok===false||reply.data?.ok===false){output.textContent=reply.error||reply.data?.error||reply.text;return;}output.textContent=reply.text;`;
const check = html => validateBrowserDelivery(html,{requireAgentAction:true});
test('real primary form submission invokes SDK, forwards synthetic input and visibly renders host failure', async () => {
  const result=await check(app(good));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.scope,'browser-agent-action-contract');
  assert.deepEqual(result.agentAction,{calls:1,forwardedInput:true,displayedHostError:true,scope:'synthetic-host-failure',realServiceExecuted:false});
  assert.equal(result.businessBehaviorVerified,false);
});
test('local-only save cannot satisfy the service contract despite valid HTML and JavaScript', async () => {
  const result=await check(app('localStorage.setItem("task",task);output.textContent="Saved!";'));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/did not call window.liveuiagent.ai/);
});
test('an SDK call that discards the current task input fails', async () => {
  const result=await check(app('const reply=await window.liveuiagent.ai("Fixed unrelated task",{});output.textContent=reply.text;'));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/discarded the current/);
});
test('hidden host failure cannot be treated as a working service UI', async () => {
  const result=await check(app('const reply=await window.liveuiagent.ai(task,{});localStorage.setItem("hidden",reply.text);'));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/actual error was not visibly shown/);
});
test('showing host failure together with a success claim fails', async () => {
  const result=await check(app('const reply=await window.liveuiagent.ai(task,{});output.textContent=reply.text;document.querySelector("#status").textContent="Saved!";'));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/displayed a success claim/);
});
test('multiple explicit primary bindings fail instead of clicking an arbitrary action', async () => {
  const result=await check(app(good,'<button data-liveui-action="agent.invoke">Another action</button>'));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/found 2/);
});
test('missing binding fails even when the script contains an SDK call', async () => {
  const result=await check(app(good).replaceAll(' data-liveui-action="agent.invoke"',''));
  assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/found 0/);
});
test('ordinary local application keeps startup-only rules and needs no host action binding', async () => {
  const result=await validateBrowserDelivery('<html><body><button>Count</button><script>document.querySelector("button").onclick=()=>{};</script></body></html>');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.scope,'browser-startup');assert.equal(result.agentAction,undefined);
});

test('an input-change SDK call cannot masquerade as a working primary submit action', async () => {
  const html=app('output.textContent="No service call from submit";').replace('</script>', 'document.querySelector("textarea").oninput=()=>window.liveuiagent.ai(document.querySelector("textarea").value,{}).catch(()=>{});</script>');
  const result=await check(html);
  assert.equal(result.ok,false);assert(result.errors.some(error=>error.code==='agent_action_before_submit'));
});

test('a correctly bound primary action hidden behind a tab reports visibility rather than missing wiring', async () => {
  const hidden=app(good).replace('<body>','<body><h1>Reading organizer</h1><button>Notes</button>').replace('<form','<section hidden><form').replace('</form>','</form></section>');
  const result=await check(hidden);
  assert.equal(result.ok,false);
  const error=result.errors.find(error=>error.code==='agent_action_contract');
  assert.match(error.message,/bound primary action control\(s\), but all are hidden on initial open/);
  assert.match(error.message,/initially visible/);
  assert.match(error.message,/without prior tab navigation/);
  assert.doesNotMatch(error.message,/Mark the real primary form/);
});
