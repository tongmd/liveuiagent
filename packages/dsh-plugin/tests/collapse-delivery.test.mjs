import test from 'node:test';import assert from 'node:assert/strict';
import {validateBrowserDelivery} from '../browser-delivery.mjs';
const page=(expanded,hide)=>`<html><head><style>body{margin:0}.editor{display:block}${hide?'[aria-expanded="false"]+form{display:none}':''}</style></head><body><h1>阅读清单</h1><button type="button" aria-controls="bookForm" aria-expanded="${expanded}" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true')">添加一本</button><form id="bookForm" class="editor"><input aria-label="书名"></form></body></html>`;
test('explicit collapsed panel that remains visible is rejected without a business action',async()=>{
 const r=await validateBrowserDelivery(page('false',false));assert.equal(r.ok,false,JSON.stringify(r));assert(r.errors.some(e=>e.code==='browser_layout'&&e.message.includes('#bookForm')&&e.message.includes('remains visible')));
});
test('an initially expanded editor is collapsed, checked and restored using its explicit button',async()=>{
 const r=await validateBrowserDelivery(page('true',true));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.layoutChecks.length,2);assert.equal(r.businessBehaviorVerified,false);
});
test('an expanded-state toggle without CSS hiding is rejected after a real button click',async()=>{
 const r=await validateBrowserDelivery(page('true',false));assert.equal(r.ok,false,JSON.stringify(r));assert(r.errors.some(e=>e.message.includes('remains visible')));
});
test('disabled roles, tree/menu semantics and submit buttons are not disclosure probes',async()=>{
 const html='<html><body><h1>清单</h1><div role="button" aria-disabled="true" aria-expanded="true" aria-controls="panel" onclick="throw Error(\'disabled clicked\')">禁用</div><button type="button" role="treeitem" aria-expanded="true" aria-controls="panel" onclick="throw Error(\'tree clicked\')">树节点</button><button type="button" role="menuitem" aria-expanded="true" aria-controls="panel" onclick="throw Error(\'menu clicked\')">菜单</button><button type="submit" aria-expanded="true" aria-controls="panel" onclick="throw Error(\'submit clicked\')">保存</button><section id="panel">Visible content is valid for these skipped semantics</section></body></html>';
 const r=await validateBrowserDelivery(html);assert.equal(r.ok,true,JSON.stringify(r));
});
test('a disclosure that replaces its toggle and animates collapse still passes and restores',async()=>{
 const html=`<html><body><main id="app"></main><script>function render(open){document.getElementById('app').innerHTML=(open?'':'<div>Changed sibling structure</div>')+'<button id="toggle" type="button" aria-expanded="'+open+'" aria-controls="panel">编辑</button><section id="panel" style="overflow:hidden;height:'+(open?'100':'0')+'px">A real editor</section>';document.getElementById('toggle').onclick=()=>render(!open);if(!open)document.getElementById('panel').animate([{height:'100px'},{height:'0px'}],{duration:80});}render(true);</script></body></html>`;
 const r=await validateBrowserDelivery(html);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.layoutChecks.length,2);
});

test('conditional unmount on collapse and remount on restore is a valid disclosure',async()=>{
 const html=`<html><body><main id="app"></main><script>function render(open){document.getElementById('app').innerHTML='<button type="button" aria-expanded="'+open+'" aria-controls="panel">编辑</button>'+(open?'<section id="panel">A real editor</section>':'');document.querySelector('button').onclick=()=>render(!open);}render(true);</script></body></html>`;
 const r=await validateBrowserDelivery(html);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.layoutChecks.length,2);
});
