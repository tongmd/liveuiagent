// Real browser feedback integration with local HTTP/SSE fixtures only.
// No external provider, production account, or model request is used.
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = process.env.LIVEUI_TEST_FRONTEND_DIR || fileURLToPath(new URL('../frontend/snapshot', import.meta.url));
const output = process.env.LIVEUI_TEST_OUTPUT_DIR || path.join(os.tmpdir(), 'liveui-feedback-test');
await fs.mkdir(output, { recursive: true });
const seen = [], pending = new Map(), history = [], jobs = new Map();
const model = 'fixture/a';
const settings = { user: { models: [model], hasApiKey: false }, server: { models: [model], model, hasApiKey: true }, effective: { models: [model], model, keySource: 'server' }, warnings: [] };
const runtime = { harness: 'codex', choices: [{ id: 'native', label: 'Native', available: true }, { id: 'codex', label: 'Codex', available: true }], model: { id: model, source: 'server', configurable: true } };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/^\/liveui/, '') || '/';
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : undefined;
    seen.push({ pathname, method: req.method, input });
    const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (pathname === '/agent/settings') return reply(settings);
    if (pathname === '/agent/runtime-settings') return reply(runtime);
    if (pathname === '/agent/models') return reply({ models: [model], default: model });
    if (pathname === '/agent/personal') return reply({ layout: {}, materialLayout: {}, appearances: {}, memories: [], apps: [], enabledShared: [], hidden: [] });
    if (pathname === '/agent/query-state') return reply({ canvasState: { canvasId: 'home', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, inputDock: { position: 'bottom', placeholder: '' } }, apps: [], summary: { text: 'Fixture', apps: [] } });
    if (pathname === '/agent/chat-history') return reply({ messages: history });
    if (pathname === '/agent/chat-append') { const row = { id: history.length + 1, ...input, created_at: new Date().toISOString(), kind: 'chat' }; history.push(row); return reply({ id: row.id }); }
    if (pathname === '/agent/run') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.flushHeaders(); pending.set(input.prompt, { res, input }); return; }
    if (pathname.startsWith('/agent/development/jobs/')) { const job = jobs.get(pathname.split('/').at(-1)); return reply(job || { error: 'Unknown fixture job' }, job ? 200 : 404); }
    if (pathname.startsWith('/agent/')) return reply({ error: 'Unexpected fixture route ' + pathname }, 404);
    const file = pathname === '/' ? '/index.html' : pathname;
    const data = await fs.readFile(root + file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' }); res.end(data);
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, base = origin + '/liveui/';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const results = [];
const viewports = process.env.LIVEUI_TEST_VIEWPORTS ? JSON.parse(process.env.LIVEUI_TEST_VIEWPORTS) : [[1280, 900], [390, 844], [320, 680], [390, 420]];
assert(Array.isArray(viewports) && viewports.length && viewports.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => Number.isInteger(value) && value > 0)), 'Viewport selection must be [[width,height],…]');
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Fixture request did not arrive'); };
async function type(page, value) { await page.focus('.frontend-prompt textarea'); await page.$eval('.frontend-prompt textarea', (node, text) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function submit(page, prompt) { await type(page, prompt); await page.click('.frontend-generate'); await wait(() => pending.has(prompt)); return pending.get(prompt).input; }
function event(prompt, name, data, close = false) { const request = pending.get(prompt); assert(request, prompt); request.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); if (close) { request.res.end(); pending.delete(prompt); } }
function answer(prompt, text) { event(prompt, 'result', { type: 'answered', answer: text, trace: [] }, true); }
async function expectPanel(page, text) { await page.waitForFunction(value => document.querySelector('.morph-answer')?.textContent.includes(value), {}, text); assert.equal(await page.$$eval('.morph-answer', nodes => nodes.length), 1, 'One feedback panel'); assert.equal(await page.$$eval('.liveuiagent-toast', nodes => nodes.length), 0, 'No duplicate toast'); }
async function geometry(page) {
  const value = await page.evaluate(() => {
    const panel = document.querySelector('.morph-answer'), composer = document.querySelector('.liveui-composer');
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    const send = document.querySelector('.frontend-generate'), r = send.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const close = panel.querySelector('button[aria-label="Close answer"]'), cr = close.getBoundingClientRect(), closeHit = document.elementFromPoint(cr.x + cr.width / 2, cr.y + cr.height / 2);
    return { panel: box(panel), composer: box(composer), width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1, sendReachable: hit === send || send.contains(hit), closeReachable: closeHit === close || close.contains(closeHit), sendDisabled: send.disabled };
  });
  assert.equal(value.overflow, false, 'No horizontal overflow');
  assert(value.panel.x >= -1 && value.panel.right <= value.width + 1, 'Panel fits viewport width');
  assert(value.panel.y >= -1 && value.panel.bottom <= value.height + 1, 'Panel fits viewport height');
  assert(value.panel.bottom <= value.composer.y + 2 || value.panel.y >= value.composer.bottom - 2, 'Panel does not cover composer');
  assert.equal(value.sendReachable, true, 'Send remains directly clickable');
  assert.equal(value.closeReachable, true, 'Close is not covered by Memory or other host controls');
  assert.equal(value.sendDisabled, false, 'Send remains enabled');
  return value;
}
try {
  for (const [width, height] of viewports) {
    const label = `${width}x${height}`, page = await browser.newPage(), errors = [];
    console.log('feedback viewport', label);
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(origin + '/') || request.url().startsWith('data:') ? request.continue() : request.abort());
    await page.evaluateOnNewDocument(() => { window.__feedbackObserved = { maxToasts: 0, maxPanels: 0 }; new MutationObserver(() => { const state = window.__feedbackObserved; state.maxToasts = Math.max(state.maxToasts, document.querySelectorAll('.liveuiagent-toast').length); state.maxPanels = Math.max(state.maxPanels, document.querySelectorAll('.morph-answer').length); }).observe(document, { childList: true, subtree: true }); });
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.liveui-runtime-controls');
    const prompt = 'Explain the saved applications ' + label;
    await submit(page, prompt);
    for (let i = 1; i <= 40; i++) event(prompt, 'progress', { step: 'Reading saved content ' + i, elapsedMs: i * 2000 });
    // The active material composer does not mount the legacy morph-command-state.
    // Observe the actual persisted-in-memory Activity row instead.
    await page.click('.history-fab');
    await page.waitForFunction(() => document.querySelector('.history-panel')?.textContent.includes('Reading saved content 40'));
    assert.equal(await page.$$eval('.history-panel .history-item', rows => rows.filter(row => row.textContent.includes('Reading saved content')).length), 1, 'All heartbeats share one Activity row');
    await page.click('.history-panel button[aria-label="Close activity"]');
    assert.equal(await page.$$eval('.morph-answer,.liveuiagent-toast', nodes => nodes.length), 0, 'Progress does not open result panels or toasts');
    assert.equal(seen.filter(row => row.pathname === '/agent/chat-append' && row.input.prompt === prompt).length, 0, 'Progress is not persisted as repeated chat');
    const hostile = '<img src=x onerror="window.__feedbackXss=true">';
    const text = `Saved applications stay available. ${hostile}\n\n` + Array.from({ length: 24 }, (_, i) => `Detail ${i + 1}: This is a real textual reply with enough content to exercise scrolling and wrapping.`).join('\n');
    answer(prompt, text); await expectPanel(page, hostile);
    await wait(() => seen.some(row => row.pathname === '/agent/chat-append' && row.input.prompt === prompt));
    assert.equal(seen.filter(row => row.pathname === '/agent/chat-append' && row.input.prompt === prompt).length, 1, 'Answer persisted exactly once');
    assert.equal(await page.$eval('.morph-answer', node => node.querySelectorAll('img,script').length), 0, 'Response is text, never HTML');
    assert.equal(await page.evaluate(() => Boolean(window.__feedbackXss)), false);
    await type(page, 'Draft remains editable ' + label);
    const long = await geometry(page);
    const scroll = await page.$eval('.morph-answer', panel => { const candidates = [panel, ...panel.querySelectorAll('*')]; const target = candidates.find(node => node.scrollHeight > node.clientHeight + 3 && /auto|scroll/.test(getComputedStyle(node).overflowY)); if (!target) return null; target.scrollTop = target.scrollHeight; return { top: target.scrollTop, height: target.clientHeight }; });
    assert(scroll?.top > 0, 'Long reply has an operable internal scroller');
    await page.screenshot({ path: path.join(output, 'feedback-long-' + label + '.png') });
    await page.click('.morph-answer button[aria-label="Close answer"]');
    await page.waitForFunction(() => !document.querySelector('.morph-answer'));
    assert.equal(await page.$eval('.frontend-prompt textarea', node => node.value), 'Draft remains editable ' + label);
    const a = 'Parallel A ' + label, b = 'Parallel B ' + label;
    await submit(page, a); await submit(page, b);
    assert(pending.has(a), 'A remains running when B is submitted');
    await type(page, 'Preserved parallel draft ' + label);
    answer(b, 'B completed ' + label); await expectPanel(page, 'B completed ' + label);
    event(a, 'error', { error: 'Connection failed for A ' + label, code: 'fixture_failure' }, true);
    await expectPanel(page, 'Connection failed for A ' + label);
    assert.equal(await page.$eval('.frontend-prompt textarea', node => node.value), 'Preserved parallel draft ' + label);
    await geometry(page);
    for (const request of [a, b]) { await wait(() => seen.some(row => row.pathname === '/agent/chat-append' && row.input.prompt === request)); assert.equal(seen.filter(row => row.pathname === '/agent/chat-append' && row.input.prompt === request).length, 1, 'Each concurrent result has one correctly associated history row'); }
    if (width === 390 && height === 844) {
      const dev = '修改liveUI本身，把回复做简洁 ' + label, jobId = 'devjob_feedback_fixture', conversationId = 'dev_feedback_fixture';
      await submit(page, dev);
      event(dev, 'progress', { step: 'Editing source', elapsedMs: 100, jobId, developmentConversationId: conversationId });
      const makeJob = status => ({ id: jobId, conversationId, prompt: dev, status: 'done', result: { validation: 'passed', changedFiles: ['frontend/example.js'], deployed: status === 'deployed', deployment: { status, ...(status === 'deployed' ? { receipt: { status: 'deployed', transactionId: 'fixture_transaction' } } : {}) } } });
      jobs.set(jobId, makeJob('queued'));
      event(dev, 'result', { type: 'answered', answer: 'The source update passed its tests.', trace: [], jobId, developmentConversationId: conversationId, development: jobs.get(jobId).result }, true);
      await expectPanel(page, 'The source update passed its tests.');
      await page.evaluate(() => { window.__feedbackPanelBeforeUpdate = document.querySelector('.morph-answer'); });
      jobs.set(jobId, makeJob('reviewing'));
      await page.waitForFunction(() => /review|审查/i.test(document.querySelector('.morph-answer')?.textContent || ''), { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.__feedbackPanelBeforeUpdate === document.querySelector('.morph-answer')), true, 'Development progress updates the existing panel');
      jobs.set(jobId, makeJob('deployed'));
      await page.waitForFunction(() => /deployed|已上线/i.test(document.querySelector('.morph-answer')?.textContent || ''), { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.__feedbackPanelBeforeUpdate === document.querySelector('.morph-answer')), true, 'Deployment receipt updates the same panel');
      assert.equal(await page.$eval('.ulemi-reply-state', node => node.textContent), 'Deployed', 'Fixed product status is English');
      assert.equal(await page.$eval('.ulemi-reply-question', node => node.textContent), dev, 'Original user language is preserved');
      assert.equal(seen.filter(row => row.pathname === '/agent/run' && row.input.prompt === dev).length, 1, 'Tracking does not resubmit development');
      await expectPanel(page, 'The source update passed its tests.'); await type(page, 'Next instruction after deployment'); await geometry(page);
    }
    const observed = await page.evaluate(() => window.__feedbackObserved);
    assert.equal(observed.maxToasts, 0, 'No transient duplicate toast was mounted at any time');
    assert(observed.maxPanels <= 1, 'At most one response panel was mounted');
    assert.deepEqual(errors, [], 'No browser errors');
    await page.screenshot({ path: path.join(output, 'feedback-final-' + label + '.png') });
    results.push({ width, height, long, observed }); await page.close();
  }
  const verification = { passed: true, modelRequests: 0, results, checks: ['one visible answer', 'single answer persistence', '40 progress events without popup/history spam', 'long reply scrolling', 'text-only XSS rendering', 'close keeps draft', 'concurrent replies and failure association', 'development phases update one panel', 'no original request replay', 'desktop/mobile/short keyboard viewport', 'Send remains reachable'] };
  await fs.writeFile(path.join(output, 'feedback-verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification));
} finally {
  for (const { res } of pending.values()) res.end();
  const child = browser.process(); let timer;
  await Promise.race([browser.close(), new Promise(resolve => { timer = setTimeout(() => { child?.kill('SIGTERM'); browser.disconnect(); resolve(); }, 5000); })]); clearTimeout(timer);
  const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
}
