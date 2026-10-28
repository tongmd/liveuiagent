// Real browser, local fixtures only. No model requests or user data.
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const source=await fs.readFile(new URL('../frontend/snapshot/runtime-controls.js',import.meta.url),'utf8');
const requests=[];let harness='native';
const model=()=>harness==='codex'?{id:'gpt-6-astra',configurable:false,providerConfigurable:false}:{id:'DeepSeek-V4.1-Flash',configurable:true};
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;requests.push({path:req.url,method:req.method,body:raw});
  res.setHeader('content-type','application/json');
  if(req.url==='/agent/runtime-settings') {if(req.method==='PATCH')harness=JSON.parse(raw).harness;res.end(JSON.stringify({harness,model:model(),choices:[{id:'native',label:'LiveUIAgent',available:true},{id:'codex',label:'Codex',available:true}]}));return;}
  if(req.url==='/agent/settings'){res.end(JSON.stringify({effective:{model:'DeepSeek-V4.1-Flash',models:['DeepSeek-V4.1-Flash'],keySource:'server'}}));return;}
  if(req.url==='/runtime-controls.js'){res.setHeader('content-type','text/javascript');res.end(source);return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><div data-liveui-composer-controls></div><script src="/runtime-controls.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-gpu']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[aria-label="Current model"]').value==='DeepSeek-V4.1-Flash');
  await page.select('[aria-label="New app harness"]','codex');await page.waitForFunction(()=>document.querySelector('[aria-label="Current model"]').value==='gpt-6-astra');
  assert.deepEqual(await page.$eval('[aria-label="Current model"]',n=>({disabled:n.disabled,models:[...n.options].map(o=>o.value)})),{disabled:true,models:['gpt-6-astra']});
  await page.click('[title="Model, API, and harness settings"]');assert.match(await page.$eval('dialog',n=>n.textContent),/Codex reasoning with LiveUIAgent actions/);await page.keyboard.press('Escape');
  await page.reload();await page.waitForFunction(()=>document.querySelector('[aria-label="Current model"]').value==='gpt-6-astra');
  await page.select('[aria-label="New app harness"]','native');await page.waitForFunction(()=>document.querySelector('[aria-label="Current model"]').value==='DeepSeek-V4.1-Flash'&&!document.querySelector('[aria-label="Current model"]').disabled);
  assert.equal(requests.filter(r=>r.path==='/agent/settings'&&r.method==='PUT').length,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['Codex selected','fixed truthful Codex model','reload persists selection','old provider model preserved','no provider writes','no page errors']}));
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
