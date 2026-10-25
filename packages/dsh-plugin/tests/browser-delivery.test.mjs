import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserDelivery } from '../browser-delivery.mjs';
const html = script => `<html><head></head><body><button>Save</button><output id="result"></output><script>${script}</script></body></html>`;
test('real opaque browser startup supports host storage without claiming business verification', async () => {
  const result = await validateBrowserDelivery(html("localStorage.setItem('note','saved');document.querySelector('#result').textContent=localStorage.getItem('note');"));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.businessBehaviorVerified,false);
});
test('runtime exceptions fail despite syntactically valid script', async () => {
  const result = await validateBrowserDelivery(html("document.querySelector('#missing').onclick=()=>{};"));
  assert.equal(result.ok,false); assert(result.errors.some(e=>e.code==='browser_script_error'));
});
test('CSP blocks external connections and returns a failed gate', async () => {
  const result = await validateBrowserDelivery(html("fetch('https://example.com/private').catch(()=>{});"));
  assert.equal(result.ok,false); assert(result.errors.some(e=>e.code==='browser_policy_violation'||e.code==='browser_console_error'));
});
test('broken browser executable fails explicitly', async () => {
  const result = await validateBrowserDelivery(html(''),{chrome:process.execPath});
  assert.equal(result.ok,false); assert(result.errors.some(e=>e.code==='browser_unavailable'));
});
