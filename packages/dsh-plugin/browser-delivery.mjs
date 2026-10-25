import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer-core';

async function executable(explicit) {
  for (const file of [explicit, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (!file) continue;
    try { await fs.access(file); return file; } catch { /* next installed browser */ }
  }
  throw Error('Chrome is required for delivery verification; configure CHROME_PATH');
}

// Deliberately a startup gate, not a claim that business workflows pass.
export async function validateBrowserDelivery(html, { chrome, signal, settleMs = 350 } = {}) {
  let browser;
  const errors = [];
  const add = (code, message) => { if (errors.length < 12 && !errors.some(e => e.code === code && e.message === message)) errors.push({ code, message: String(message).slice(0, 600) }); };
  const stop = () => browser?.process()?.kill('SIGKILL');
  const deadline = setTimeout(() => { add('browser_deadline', 'Browser startup verification exceeded 25 seconds'); stop(); }, 25000);
  try {
    signal?.throwIfAborted();
    browser = await puppeteer.launch({ executablePath: await executable(chrome), headless: true, timeout: 10000, protocolTimeout: 5000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    signal?.addEventListener('abort', stop, { once: true });
    signal?.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', error => add('browser_script_error', error.message));
    page.on('console', event => { if (event.type() === 'error') add('browser_console_error', event.text()); });
    page.on('dialog', async dialog => { add('browser_dialog', `Unexpected ${dialog.type()}: ${dialog.message()}`); await dialog.dismiss().catch(() => {}); });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/^(about:|data:|blob:)/.test(request.url())) void request.continue().catch(() => {});
      else { add('browser_external_request', 'Standalone app attempted an external request'); void request.abort().catch(() => {}); }
    });
    const channel = randomBytes(16).toString('hex');
    await page.exposeFunction('__deliveryViolation', (key, message) => { if (key === channel) add('browser_policy_violation', message); });
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    // Match the host's opaque-origin storage API. AI is unavailable during startup
    // checks: a real request must happen through an explicit user action later.
    const bootstrap = `<script>(()=>{const values=Object.create(null);const storage={getItem:k=>Object.hasOwn(values,String(k))?values[String(k)]:null,setItem:(k,v)=>{values[String(k)]=String(v)},removeItem:k=>{delete values[String(k)]},clear:()=>{for(const k of Object.keys(values))delete values[k]},key:i=>Object.keys(values)[i]??null,get length(){return Object.keys(values).length}};Object.defineProperty(window,'localStorage',{value:storage});window.liveuiagent={storage,ai:async()=>{throw Error('AI actions require a user action; unavailable during delivery startup verification')},download:()=>{throw Error('Downloads require a user action during delivery verification')}};addEventListener('securitypolicyviolation',e=>parent.postMessage({channel:${JSON.stringify(channel)},violation:'Blocked '+e.violatedDirective},'*'));})();</script>`;
    const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + policy + bootstrap) : policy + bootstrap + html;
    await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="app" sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
    await page.evaluate(({ html, channel }) => {
      const iframe = document.querySelector('#app');
      addEventListener('message', event => { if (event.source === iframe.contentWindow && event.data?.channel === channel) void window.__deliveryViolation(channel, event.data.violation); });
      iframe.srcdoc = html;
    }, { html: injected, channel });
    const frame = await page.waitForFrame(frame => frame.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => document.readyState === 'complete');
    await new Promise(resolve => setTimeout(resolve, settleMs));
    signal?.throwIfAborted();
    const visible = await frame.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      return [...body.querySelectorAll('*')].some(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && (e.textContent?.trim() || /^(INPUT|TEXTAREA|SELECT|CANVAS|SVG|IMG)$/.test(e.tagName)); });
    });
    if (!visible) add('browser_empty_page', 'Application has no visible content after startup');
  } catch (error) {
    add(browser ? 'browser_verification_failed' : 'browser_unavailable', error.message);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    if (browser) {
      const timer = setTimeout(stop, 2000);
      try { await browser.close(); } catch { stop(); } finally { clearTimeout(timer); }
    }
  }
  return { ok: errors.length === 0, errors, scope: 'browser-startup', businessBehaviorVerified: false };
}
