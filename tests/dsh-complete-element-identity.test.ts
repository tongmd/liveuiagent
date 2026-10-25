import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompleteAppBrowser} from '../server/complete-app-evaluator.js';
async function fixture(t:any){
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'complete-identity-'));
 const html=`<!doctype html><html><body><label>First<input id="first" data-liveui-eval-id="e2"></label><label>Second<input id="second" aria-label="Second" data-liveui-eval-id="e1"></label><label>Energy<input type="radio" id="e1" name="energy" value="steady"></label><button id="done" data-liveui-eval-id="e1">Done</button><output id="result"></output><script>document.querySelector('#done').onclick=()=>document.querySelector('#result').textContent='clicked';window.__liveuiEvalIdentity={document,ids:new WeakMap(),counter:0};</script></body></html>`;
 const transport={async request(){return{html,store:{}};}};
 const browser=new CompleteAppBrowser(transport,'dsh_identity_fixture',out,process.env.CHROME_PATH,{actionTimeoutMs:10000,bridgeTimeoutMs:10000});
 t.after(async()=>{await browser.close();await fs.rm(out,{recursive:true,force:true});});await browser.open();return browser;
}
test('element targets remain stable across insertion removal and multiple snapshots',async t=>{
 const browser=await fixture(t);const first=await browser.snapshot();const secondId=first.fields.find(f=>f.label==='Second')!.target,firstId=first.fields.find(f=>f.label==='First')!.target;
 await browser.perform({kind:'fill',target:firstId,value:'first despite native e1 radio'});
 await browser.frame!.evaluate(()=>{const node=document.createElement('input');node.id='new';node.setAttribute('aria-label','Inserted');document.body.prepend(node);document.querySelector('#first')!.remove();});
 const next=await browser.snapshot();assert.equal(next.fields.find(f=>f.label==='Second')!.target,secondId);assert.notEqual(next.fields.find(f=>f.label==='Inserted')!.target,firstId);assert.notEqual(next.fields.find(f=>f.label==='Inserted')!.target,secondId);
 await assert.rejects(browser.perform({kind:'fill',target:firstId,value:'must not rebind'}),/Expected one visible target.*found 0/);
 for(let i=0;i<3;i++)assert.equal((await browser.snapshot()).fields.find(f=>f.label==='Second')!.target,secondId);
 await browser.perform({kind:'fill',target:secondId,value:'original element'});assert.equal(await browser.frame!.evaluate(()=>(document.querySelector('#second') as HTMLInputElement).value),'original element');assert.equal(await browser.frame!.evaluate(()=>(document.querySelector('#new') as HTMLInputElement).value),'');
});
test('cloned or forged eval attributes and page realm state cannot alias a target',async t=>{
 const browser=await fixture(t);const initial=await browser.snapshot();const target=initial.fields.find(f=>f.label==='Second')!.target;const button=initial.buttons.find(f=>f.label==='Done')!.target;
 await browser.frame!.evaluate(({target,button})=>{const original=document.querySelector('#second')!;original.setAttribute('data-liveui-eval-id',target);const clone=original.cloneNode(true) as HTMLElement;clone.id='cloned';clone.setAttribute('data-liveui-eval-id',target);document.body.prepend(clone);document.querySelector('#done')!.setAttribute('data-liveui-eval-id',target);const decoy=document.createElement('button');decoy.id=button;decoy.textContent='Decoy';decoy.setAttribute('data-liveui-eval-id',button);document.body.prepend(decoy);(window as any).__liveuiEvalIdentity={document,ids:new WeakMap([[clone,target]]),counter:999};},{target,button});
 const observed=await browser.snapshot();assert.equal(new Set(observed.fields.map(f=>f.target)).size,observed.fields.length);assert.equal(observed.fields.find(f=>f.label==='Second'&&f.target===target)!.target,target);assert.notEqual(observed.fields.find(f=>f.target!==target&&f.label==='Second')!.target,target);
 await browser.perform({kind:'fill',target,value:'trusted original'});assert.equal(await browser.frame!.evaluate(()=>(document.querySelector('#second') as HTMLInputElement).value),'trusted original');assert.equal(await browser.frame!.evaluate(()=>(document.querySelector('#cloned') as HTMLInputElement).value),'');
 await browser.perform({kind:'click',target:button});assert.match((await browser.snapshot()).visibleText,/clicked/);
});
test('labels and selectors retain strict ambiguity checks after stable identity allocation',async t=>{
 const browser=await fixture(t);await browser.frame!.evaluate(()=>{const node=document.querySelector('#second')!.cloneNode(true) as HTMLElement;node.id='duplicate';document.body.append(node);});await assert.rejects(browser.perform({kind:'fill',target:'Second',value:'no'}),/Expected one visible target.*found 2/);await browser.perform({kind:'fill',target:'#second',value:'selected'});assert.equal(await browser.frame!.evaluate(()=>(document.querySelector('#second') as HTMLInputElement).value),'selected');
});
