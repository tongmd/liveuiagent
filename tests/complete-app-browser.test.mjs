import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromeStartupProbe} from './chrome-startup-probe.mjs';
import {CompleteAppBrowser} from '../dist-server/server/complete-app-evaluator.js';

test('closed Chrome releases only its owned stdio, including pipes inherited by crash reporters',async()=>{
 const events=[];
 const stream=name=>({destroy(){events.push(name)}});
 const child={exitCode:0,signalCode:null,stdin:stream('stdin'),stdout:stream('stdout'),stderr:stream('stderr')};
 const browser=new CompleteAppBrowser({},'fixture','unused');
 browser.browser={process:()=>child,close:async()=>{events.push('closed')}};
 await browser.close();assert.deepEqual(events,['closed','stdin','stdout','stderr']);assert.equal(browser.browser,undefined);
 await browser.close();assert.equal(events.length,4);
 const liveChild={...child,exitCode:null};browser.browser={process:()=>liveChild,close:async()=>{throw Error('still running')}};
 await assert.rejects(browser.close(),/still running/);assert.equal(events.length,4,'do not destroy a still-running process stdio');assert.ok(browser.browser,'retain a still-running browser for cleanup retry');
});

test('real Chrome repeated open/close destroys its exited child pipes',async t=>{
 let chrome;
 for(const candidate of [process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome']) {
  if(!candidate)continue;try{await fs.access(candidate);chrome=candidate;break;}catch{}
 }
 if(!chrome){t.skip('Chrome unavailable; browser lifecycle is unexecuted');return;}
 const probe=process.env.LIVEUIAGENT_CHROME_STARTUP_DIAGNOSTICS==='1'?await chromeStartupProbe(chrome,path.resolve('artifacts/chrome-startup')):undefined;if(probe)t.after(()=>probe.close());
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-browser-close-'));
 const browser=new CompleteAppBrowser({request:async()=>({html:'<!doctype html><html><body><h1>Saved notes</h1><label>Note<input></label><button>Save</button></body></html>',store:{}})},'fixture',out,probe?.executable??chrome);
 try {
  for(let i=0;i<2;i++){
   await browser.open();const child=browser.browser.process();assert.ok(child);
   await browser.close();assert.notEqual(child.exitCode,null);
   for(const stream of [child.stdin,child.stdout,child.stderr])if(stream)assert.equal(stream.destroyed,true);
  }
 }finally{await browser.close();await fs.rm(out,{recursive:true,force:true});}
});
