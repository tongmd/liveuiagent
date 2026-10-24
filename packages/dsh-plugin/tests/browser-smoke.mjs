// Optional local Chrome acceptance test; intentionally excluded from *.test.mjs CI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import { createLiveUIAgentPlugin } from '../index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
await fs.mkdir(path.join(root, '.test-runs'), { recursive: true });
const scratch = await fs.mkdtemp(path.join(root, '.test-runs/dsh-browser-'));
const ctx = new Context();
let browser;
let releaseHeldTask;
let revision = 0;
const records = new Map();
const errors = [];

function counterHtml(version) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Counter fixture</title>
  <style>body{margin:0;padding:48px;background:#f2f5f2;color:#20382d;font:16px system-ui}main{max-width:680px;margin:auto;padding:36px;border-radius:24px;background:white;box-shadow:0 12px 40px #20382d0d}small{color:#657d6d;letter-spacing:2px}h1{font-size:30px}output{display:block;font-size:88px;margin:20px 0}button{border:0;border-radius:12px;padding:14px 22px;background:#28714e;color:white;font-size:16px;cursor:pointer}#ask{background:#e7efe9;color:#28714e;margin-left:12px}p{line-height:1.8;color:#63746a}#answer{min-height:28px}</style>
  </head><body><main><small>LIVEUIAGENT · BROWSER FIXTURE</small><h1>日常计数器</h1><p>本地浏览器验收应用 · 第${version}次生成。点击按钮后，计数会保存到当前应用；重新打开或修改应用后继续保留。</p><output id="count">0</output><button id="add">增加一次 ＋</button><button id="ask">解释当前计数</button><p id="answer"></p></main>
  <script>let count=Number(localStorage.getItem('count')||0);const output=document.querySelector('#count');output.textContent=count;document.querySelector('#add').onclick=()=>{output.textContent=++count;localStorage.setItem('count',String(count));};document.querySelector('#ask').onclick=async()=>{const answer=document.querySelector('#answer');answer.textContent='处理中';try{const result=await liveuiagent.ai('解释当前计数',{count});answer.textContent=result.text;}catch(error){answer.textContent='失败：'+error.message;}};</script></body></html>`;
}

const runner = {
  async run({ work, task, signal, onEvent }) {
    if (task.includes('BROWSER_HOLD')) {
      await new Promise((resolve, reject) => {
        releaseHeldTask = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    onEvent({ type: 'tool_call', name: 'write_file' });
    if (task.includes('Write response.json')) {
      await fs.writeFile(path.join(work, 'response.json'), JSON.stringify({ text: '这是浏览器测试中的计数说明。' }));
    } else {
      await fs.writeFile(path.join(work, 'index.html'), counterHtml(++revision));
      await fs.writeFile(path.join(work, 'app.json'), JSON.stringify({ name: '日常计数器', description: '点击、保存、重新打开，修改后也保留计数。', accent: '#28714e' }));
    }
    onEvent({ type: 'final', text: 'Browser fixture completed' });
    return { elapsedMs: 1 };
  },
  async dispose() {},
};

try {
  ctx.provide('credentials', {
    async modifyRecord(key, change) {
      const next = await change(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
  });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(Connection, {});
  ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
    if (ctx.connection.authorizeIndex(req, res)) res.end('Authenticated DSH fixture');
  } });
  await ctx.plugin(createLiveUIAgentPlugin({ createRunner: () => runner }), {
    basePath: '/liveuiagent', dataDir: path.join(scratch, 'data'), owner: 'browser-operator', model: 'Browser fixture',
  });
  const base = `http://127.0.0.1:${ctx.webServer.port}`;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: path.join(scratch, 'chrome-profile'),
    defaultViewport: { width: 1440, height: 1050, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  // The actual native launch token is consumed by Chrome, never logged by this test.
  await page.goto(ctx.connection.authenticatedUrl(`${base}/`));
  await page.goto(`${base}/liveuiagent/`);
  await page.waitForFunction(() => document.querySelector('#user-name').textContent === 'browser-operator');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await page.$eval('.brand', node => node.textContent.includes('liveUI')), true);
  assert.equal(await page.$eval('#create-submit', node => node.textContent.trim()), 'Create App ↗');
  assert.equal(await page.$eval('#memory-dialog h2', node => node.textContent), 'Memory');
  assert.equal(await page.$eval('.sidebar-bottom small', node => node.textContent), 'Browser fixture');
  await page.type('#create-prompt', '创建一个可保存的日常计数器');
  await page.click('#create-submit');
  await page.waitForFunction(() => document.querySelector('#revision-label').textContent === 'v1');
  const appFrame = async () => {
    const element = await page.$('#app-frame');
    const frame = await element.contentFrame();
    await frame.waitForSelector('#count');
    return frame;
  };
  let frame = await appFrame();
  await frame.click('#add');
  await frame.click('#add');
  await page.waitForFunction(() => document.querySelector('#saved-status').textContent === 'Saved');
  assert.equal(await frame.$eval('#count', node => node.textContent), '2');
  const previousDocument = await page.$eval('#app-frame', node => node.srcdoc);
  await page.click('#refresh-app');
  await page.waitForFunction(previous => document.querySelector('#app-frame').srcdoc !== previous, {}, previousDocument);
  frame = await appFrame();
  await frame.waitForFunction(() => document.querySelector('#count').textContent === '2');
  await page.type('#edit-prompt', '把计数器样式再调整一下，保留已保存的数据');
  await page.click('#edit-submit');
  await page.waitForFunction(() => document.querySelector('#revision-label').textContent === 'v2');
  frame = await appFrame();
  assert.equal(await frame.$eval('#count', node => node.textContent), '2');
  const saved = await page.evaluate(async () => {
    const state = await (await fetch('./api/state')).json();
    return (await fetch('./api/apps/' + state.apps[0].id)).json();
  });
  assert.equal(saved.app.revision, 2);
  assert.deepEqual(saved.store, { count: '2' });
  const screenshot = path.join(scratch, 'liveuiagent-counter-v2.png');
  await page.screenshot({ path: screenshot, fullPage: true });

  // A failed poll must release the shared UI without pretending the backend task succeeded.
  let failNextPoll = false;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (failNextPoll && /\/api\/jobs\//.test(new URL(request.url()).pathname)) {
      failNextPoll = false;
      void request.abort('failed');
    } else void request.continue();
  });
  async function recovered() {
    const deadline = Date.now() + 15000;
    while (failNextPoll) {
      assert.ok(Date.now() < deadline, 'the intended job poll must actually fail');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await page.waitForFunction(() => !document.querySelector('#create-submit').disabled
      && !document.querySelector('#edit-submit').disabled
      && document.querySelector('#job-panel').hidden
      && document.querySelector('#toast').textContent.includes('The task may still be running'));
    const before = await page.$eval('#job-time', node => node.textContent);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await page.$eval('#job-time', node => node.textContent), before, 'the task clock stopped');
  }
  failNextPoll = true;
  await frame.click('#ask');
  await recovered();
  await frame.waitForFunction(() => document.querySelector('#answer').textContent.startsWith('失败：'));

  failNextPoll = true;
  await page.type('#edit-prompt', '再调整一次');
  await page.click('#edit-submit');
  await recovered();
  assert.equal(await page.$eval('#revision-label', node => node.textContent), 'v2', 'failed polling does not report a successful revision');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#user-name').textContent === 'browser-operator');
  const queued = await page.evaluate(async () => {
    const response = await fetch('./api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'BROWSER_HOLD' }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(queued.status, 202);
  failNextPoll = true;
  await page.reload();
  await recovered();
  assert.ok(releaseHeldTask, 'a running task was resumed after reload');
  releaseHeldTask();
  assert.deepEqual(errors, [], 'browser page and iframe scripts have no uncaught errors');
  console.log(JSON.stringify({ passed: ['native-cookie-login', 'generate', 'iframe-store', 'reopen', 'revise-preserves-store', 'ai-poll-failure', 'generate-poll-failure', 'resume-poll-failure'], screenshot }, null, 2));
} finally {
  releaseHeldTask?.();
  await browser?.close();
  await ctx.fiber.dispose();
}
