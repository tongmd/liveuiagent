import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserDelivery, normalizeDeliveryViewport } from '../browser-delivery.mjs';
import { buildTask } from '../prompts.mjs';
const page = content => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style></head><body>${content}</body></html>`;
test('reported iframe size is bounded and distinguished from unknown fallback',()=>{
  assert.deepEqual(normalizeDeliveryViewport({width:952.2,height:702.3}),{width:952,height:702});
  assert.equal(normalizeDeliveryViewport({width:'952',height:700}),null);
  assert.equal(normalizeDeliveryViewport({width:1e9,height:700}),null);
  const task=buildTask({prompt:'a reading list',mode:'generate',context:{hostViewport:{width:952,height:702}}});
  assert(task.includes('952 x 702 CSS pixels'));
  assert(buildTask({prompt:'a reading list',mode:'generate'}).includes('No host iframe measurement'));
});
test('a desktop-only fixed-width app fails the mobile layout and supplies a concrete repair error',async()=>{
  const result=await validateBrowserDelivery(page('<main style="width:960px"><button style="float:right">Save</button><p>A reading list</p></main>'));
  assert.equal(result.ok,false,JSON.stringify(result));
  assert(result.errors.some(e=>e.code==='browser_layout'&&e.message.includes('390x844')));
  assert.equal(result.layoutChecks.length,2);
});
test('a responsive app fits actual iframe plus mobile and preserves normal vertical scrolling',async()=>{
  const result=await validateBrowserDelivery(page('<main style="width:100%;max-width:960px;padding:20px"><h1 style="font-size:32px">My reading list</h1><textarea style="width:100%;height:1200px" aria-label="Note"></textarea><button>Save</button></main>'),{viewport:{width:952,height:702}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.layoutChecks[0].iframeWidth,952);
  assert.equal(result.layoutChecks[1].iframeWidth,390);
  assert.equal(result.businessBehaviorVerified,false);
});
test('restored oversized direct text is rejected even with overflow hidden',async()=>{
  const result=await validateBrowserDelivery(page('<main style="overflow:hidden"><h1 style="font-size:104px">This is a long restored photo caption</h1></main>'));
  assert.equal(result.ok,false,JSON.stringify(result));
  assert(result.errors.some(e=>e.message.includes('104px')));
});

test('body margin and a deliberately scrollable table do not create a false page-overflow failure',async()=>{
 const result=await validateBrowserDelivery(page('<main style="margin:8px"><div style="overflow-x:auto"><table style="width:1200px"><tr><td>Wide data table</td></tr></table></div></main>'));
 assert.equal(result.ok,true,JSON.stringify(result));
});
