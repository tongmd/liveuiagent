import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserDelivery} from '../browser-delivery.mjs';
const html=override=>`<!doctype html><html><head><style>body{margin:0}.newcat{display:flex}${override}</style></head><body><h1>清单</h1><button>添加</button><div id="newCatRow" class="newcat" hidden><input aria-label="新分类"><button>确认</button></div><input type="hidden" value="internal"></body></html>`;
test('CSS cannot silently reveal a hidden editor at delivery viewports',async()=>{
 const result=await validateBrowserDelivery(html(''));
 assert.equal(result.ok,false,JSON.stringify(result));
 assert.equal(result.layoutChecks.length,2);
 assert(result.errors.some(e=>e.code==='browser_layout'&&e.message.includes('#newCatRow')&&e.message.includes('display:flex')));
});
test('a genuinely hidden editor and input type hidden pass the same real Chrome layout gate',async()=>{
 const result=await validateBrowserDelivery(html('[hidden]{display:none!important}'));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.layoutChecks.length,2);
});
