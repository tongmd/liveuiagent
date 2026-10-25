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
export async function validateBrowserDelivery(html, { chrome, signal, settleMs = 350, requireAgentAction = false } = {}) {
  let browser;
  let actionPhase = false;
  let outcome = 'failure';
  const agentCalls = [];
  const token = randomBytes(10).toString('hex');
  const syntheticRequest = `Process this current user request: delivery-check-${token}`;
  const serviceError = `Connected service unavailable: delivery-error-${token}`;
  const serviceSuccess = {ok:true,status:'succeeded',text:`Observed service result: delivery-success-${token}`,data:{entities:[{id:`delivery-${token}`,name:`Observed entity ${token}`,detail:`Observed detail ${token}`,group:`unknown-group-${token}`},{name:`Second entity ${token}`,detail:`Second detail ${token}`,group:`other-group-${token}`}],stats:[{label:`Observed count ${token}`,value:'1'}],evaluation:{pass:true,deficiencies:[]}}};
  let actionVerification;
  const errors = [];
  const add = (code, message) => { if (errors.length < 12 && !errors.some(e => e.code === code && e.message === message)) errors.push({ code, message: String(message).slice(0, 600) }); };
  const stop = () => browser?.process()?.kill('SIGKILL');
  const budgetMs = requireAgentAction ? 40000 : 25000;
  const deadline = setTimeout(() => { add('browser_deadline', `Browser delivery verification exceeded ${budgetMs / 1000} seconds`); stop(); }, budgetMs);
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
    if (requireAgentAction) await page.exposeFunction('__deliveryAgentAction', (key, prompt, context, primaryAction) => {
      if (key !== channel) throw Error('Invalid delivery bridge channel');
      if (!actionPhase || !primaryAction) { add('agent_action_before_submit', 'Call the host service from the bound primary submit action, not startup or input-change handlers'); throw Error('Service actions require an explicit user action'); }
      agentCalls.push({ prompt, context });
      // Count browser SDK invocations, not the real host's internal API plan.
      // Let both handlers run normally so duplicate writes are detected rather
      // than hidden by propagation suppression or a fake single-call wrapper.
      if (agentCalls.length > 1) add('agent_action_contract', `A single primary submit invoked window.liveuiagent.ai ${agentCalls.length} times on the ${outcome} probe. Use one host SDK invocation per submit; compose multiple service API operations inside that host action.`);
      return outcome === 'success' ? serviceSuccess : { ok: false, text: serviceError, error: serviceError, data: { ok: false, error: serviceError } };
    });
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    // Match the host's opaque-origin storage API. AI is unavailable during startup
    // checks: a real request must happen through an explicit user action later.
    const bootstrap = `<script>(${installDeliverySdk.toString()})(${JSON.stringify(channel)},${JSON.stringify(requireAgentAction)});</script>`;
    const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + policy + bootstrap) : policy + bootstrap + html;
    const loadApp = async () => {
      await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="app" sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
      await page.evaluate(({ html, channel }) => {
        const iframe = document.querySelector('#app');
        addEventListener('message', event => { if (event.source !== iframe.contentWindow || event.data?.channel !== channel) return;
          if (event.data.type === 'agent') {
            const { id, prompt, context, primaryAction } = event.data;
            window.__deliveryAgentAction(channel, prompt, context, primaryAction).then(value => iframe.contentWindow?.postMessage({ channel, id, type: 'agent-reply', value }, '*'), error => iframe.contentWindow?.postMessage({ channel, id, type: 'agent-reply', error: error.message }, '*'));
          } else void window.__deliveryViolation(channel, event.data.violation); });
        iframe.srcdoc = html;
      }, { html: injected, channel });
      const frame = await page.waitForFrame(frame => frame.parentFrame() === page.mainFrame());
      await frame.waitForFunction(() => document.readyState === 'complete');
      await new Promise(resolve => setTimeout(resolve, settleMs));
      if (requireAgentAction && await frame.evaluate(() => [...document.querySelectorAll('[data-liveui-view="records"]')].some(node => node.textContent.trim()))) {
        add('agent_action_contract', 'A fresh connected app must start with an empty data-liveui-view="records" surface. Do not prefill unobserved service records or business values. Put headings, empty-state text and user-provided editable drafts/preferences outside this observed-record surface; ask for missing amounts/dates rather than inventing service facts.');
      }
      return frame;
    };
    let frame = await loadApp();
    signal?.throwIfAborted();
    const visible = await frame.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      return [...body.querySelectorAll('*')].some(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && (e.textContent?.trim() || /^(INPUT|TEXTAREA|SELECT|CANVAS|SVG|IMG)$/.test(e.tagName)); });
    });
    if (!visible) add('browser_empty_page', 'Application has no visible content after startup');
    if (requireAgentAction && !errors.length) {
      try {
        const failure = await verifyAgentAction(frame, syntheticRequest, serviceError, agentCalls, () => { actionPhase = true; });
        if (!errors.length) {
          // A fresh opaque frame gives success an independent startup, storage and
          // trusted-click boundary; failure UI state must not mask success bugs.
          actionPhase = false; outcome = 'success'; agentCalls.length = 0;
          frame = await loadApp();
          const success = await verifyAgentAction(frame, syntheticRequest + ' success path', serviceSuccess.text, agentCalls, () => { actionPhase = true; }, serviceSuccess.data.entities);
          await new Promise(resolve => setTimeout(resolve, settleMs));
          actionPhase = false; outcome = 'failure'; agentCalls.length = 0;
          const retained = await verifyAgentAction(frame, syntheticRequest + ' retained failure', serviceError, agentCalls, () => { actionPhase = true; });
          actionVerification = {displayedDomainRecords:true,preservedRecordsOnFailure:true,calls:failure.calls + success.calls + retained.calls,forwardedInput:true,displayedHostError:true,displayedHostSuccess:true,failureCalls:failure.calls,successCalls:success.calls,scope:'synthetic-host-failure-and-success',realServiceExecuted:false};
        }
      }
      catch (error) { add('agent_action_contract', error.message); }
    }
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
  return { ok: errors.length === 0, errors, scope: requireAgentAction ? 'browser-agent-action-contract' : 'browser-startup', businessBehaviorVerified: false, ...(actionVerification ? { agentAction: actionVerification } : {}) };
}


function installDeliverySdk(channel, agentEnabled) {
  const values = Object.create(null), pending = new Map(); let sequence = 0, primaryAction = false;
  addEventListener('click', event => { if (event.isTrusted && event.target.closest?.('[data-delivery-primary="true"]')) primaryAction = true; }, true);
  const storage = { getItem: k => Object.hasOwn(values, String(k)) ? values[String(k)] : null, setItem: (k, v) => { values[String(k)] = String(v); }, removeItem: k => { delete values[k]; }, clear: () => { for (const k of Object.keys(values)) delete values[k]; }, key: i => Object.keys(values)[i] ?? null, get length() { return Object.keys(values).length; } };
  Object.defineProperty(window, 'localStorage', { value: storage });
  window.liveuiagent = { storage, ai: (prompt, context) => {
    if (!agentEnabled) return Promise.reject(Error('AI actions require a user action; unavailable during delivery startup verification'));
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parent.postMessage({ channel, id, type: 'agent', prompt, context, primaryAction }, '*'); });
  }, download: () => { throw Error('Downloads require a user action during delivery verification'); } };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.type !== 'agent-reply') return;
    const item = pending.get(event.data.id); if (!item) return; pending.delete(event.data.id);
    event.data.error ? item.reject(Error(event.data.error)) : item.resolve(event.data.value);
  });
  addEventListener('securitypolicyviolation', event => parent.postMessage({ channel, violation: 'Blocked ' + event.violatedDirective }, '*'));
}

async function verifyAgentAction(frame, request, serviceError, calls, beginAction, successEntities = null) {
  const binding = await frame.evaluate(() => {
    const visible = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const candidates = new Set(), hiddenControls = new Set();
    for (const node of document.querySelectorAll('[data-liveui-action="agent.invoke"]')) {
      // A form owns its real submit controls (including external form= controls),
      // not every preset/filter button that happens to sit inside it. An explicit
      // control binding remains primary even when its type is button.
      const controls = node instanceof HTMLFormElement
        ? [...node.elements].filter(control => control.form === node && ((control instanceof HTMLButtonElement && control.type === 'submit') || (control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type))))
        : [node];
      for (const control of controls) {
        if (control.matches('button,input[type="submit"],input[type="image"],input[type="button"]')) {
          if (visible(control)) candidates.add(control); else hiddenControls.add(control);
        }
      }
    }
    if (!candidates.size && hiddenControls.size) throw Error(`Found ${hiddenControls.size} bound primary action control(s), but all are hidden on initial open. Move the primary task form and submit button out of hidden tabs/panels, or make that panel initially visible. The real service workflow must be usable immediately without prior tab navigation.`);
    if (candidates.size !== 1) throw Error(`Expected one visible agent.invoke action after form/button deduplication; found ${candidates.size}. Mark the real primary form and submit button with data-liveui-action="agent.invoke".`);
    const button = [...candidates][0];
    const fields = [...(button.form ? button.form.elements : document.querySelectorAll('input,textarea'))].filter(node => visible(node) && !node.disabled);
    const textareas = fields.filter(node => node instanceof HTMLTextAreaElement);
    const textInputs = fields.filter(node => node instanceof HTMLInputElement && node.type === 'text');
    const named = [...textareas, ...textInputs].filter(node => /task|request|instruction|prompt/i.test([node.name,node.id,node.getAttribute('aria-label'),...(node.labels || [])].map(x => typeof x === 'string' ? x : x?.textContent || '').join(' ')));
    const choices = named.length === 1 ? named : textareas.length === 1 ? textareas : textInputs;
    if (choices.length !== 1) throw Error(`Expected one clear natural-language task input in the primary action form; found ${choices.length}. Keep it separate from secondary record-entry fields.`);
    button.setAttribute('data-delivery-primary', 'true'); choices[0].setAttribute('data-delivery-request', 'true');
    return { before: document.body.innerText, records: [...document.querySelectorAll('[data-liveui-view="records"]')].map(node => node.innerText), required: fields.filter(node => node.required && node !== choices[0]).map((node, i) => { node.setAttribute('data-delivery-required', String(i)); return { index:i, tag:node.tagName, type:node.type }; }) };
  });
  for (const field of binding.required) {
    const selector = `[data-delivery-required="${field.index}"]`;
    const node = await frame.$(selector);
    if (field.tag === 'SELECT') {
      const value = await node.evaluate(e => [...e.options].find(o => !o.disabled && o.value)?.value);
      if (value !== undefined) await node.select(value);
    } else if (['checkbox','radio'].includes(field.type)) { if (!await node.evaluate(e => e.checked)) await node.click(); }
    else if (field.type !== 'hidden') {
      const value = { number:'1', date:'2026-01-01', time:'12:00', email:'delivery@example.invalid', url:'https://example.invalid' }[field.type] || 'Delivery sample';
      await node.evaluate((e, value) => { e.value = value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }, value);
    }
  }
  const input = await frame.$('[data-delivery-request="true"]');
  await input.click({ clickCount: 3 }); await input.press('Backspace'); await input.type(request);
  const button = await frame.$('[data-delivery-primary="true"]');
  if (await button.evaluate(node => node.disabled)) throw Error('The primary action stayed disabled after entering the current task; enable a usable submit control.');
  beginAction();
  await button.click();
  const deadline = Date.now() + 3500;
  let after = '';
  while (Date.now() < deadline) {
    after = await frame.evaluate(() => document.body.innerText);
    // Keep the whole bounded probe window open after the first rendered
    // response: a second async submit listener may call the SDK after it.
    if (calls.length > 1) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (calls.length > 1) throw Error(`Expected exactly one window.liveuiagent.ai invocation for one primary submit; observed ${calls.length}. Remove duplicate submit/click listeners, not domain behavior.`);
  if (!calls.length) throw Error('The primary user action did not call window.liveuiagent.ai. Wire its submit/click handler to await the host bridge; browser-only saves are not external service operations.');
  if (!calls.some(call => JSON.stringify(call).includes(request))) throw Error('The host call discarded the current natural-language input. Forward the complete entered request and fields in prompt/context.');
  if (successEntities) {
    if (!after.includes(serviceError)) throw Error('The host returned ok:true but its actual observed result was not visibly shown. Render the returned text/data rather than a local success placeholder.');
    await verifyDomainProjection(frame, successEntities);
    return {calls:calls.length,forwardedInput:true,displayedHostSuccess:true,scope:'synthetic-host-success',realServiceExecuted:false};
  }
  if (!after.includes(serviceError)) throw Error('The host returned ok:false but the actual error was not visibly shown. Render returned text/data.error and do not silently hide a failed service operation.');
  const recordsAfter = await frame.evaluate(() => [...document.querySelectorAll('[data-liveui-view="records"]')].map(node => node.innerText));
  if (JSON.stringify(recordsAfter) !== JSON.stringify(binding.records)) throw Error('The host returned ok:false but the domain records changed. Preserve prior observed records on failure.');
  const fresh = after.split('\n').map(line => line.trim()).filter(line => line && !binding.before.split('\n').map(x => x.trim()).includes(line));
  if (fresh.some(line => /^(success(?:ful(?:ly)?)?|saved|added|created|updated|done|completed)[.!]?$/i.test(line) || /\b(?:successfully (?:saved|added|created|updated)|(?:saved|added|created|updated) successfully|operation completed)\b/i.test(line))) throw Error('The host returned ok:false but the app displayed a success claim. Show the real error and do not mark external writes as successful.');
  return { calls: calls.length, forwardedInput: true, displayedHostError: true, scope:'synthetic-host-failure', realServiceExecuted:false };
}

// Inspect only designated domain record surfaces, never the generic host result.
async function verifyDomainProjection(frame, entities) {
  const missing = await frame.evaluate(entities => {
    const core = '#liveui-host-workflow,#liveui-task-result,#liveui-task-entities,#liveui-task-stats';
    const visible = node => {
      for (let e = node; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    };
    const texts = [...document.querySelectorAll('[data-liveui-view="records"]')]
      .filter(node => !node.matches('html,body') && !node.closest(core) && !node.querySelector(core) && visible(node))
      .map(node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const parts = []; let item;
        while ((item = walker.nextNode())) {
          const parent = item.parentElement;
          if (parent && !parent.closest(core) && !parent.closest('script,style,template') && visible(parent)) parts.push(item.textContent);
        }
        return parts.join(' ').replace(/\s+/g, ' ');
      });
    return entities.flatMap((entity, index) => ['name','detail','group'].filter(key => entity[key] != null && entity[key] !== '' && !texts.some(text => text.includes(String(entity[key]).replace(/\s+/g, ' ')))).map(key => `entity ${index + 1} ${key}`));
  }, entities);
  if (missing.length) throw Error('The host returned actual entities but the visible domain record surface omitted ' + missing.join(', ') + '. Render all returned name/detail/group in a data-liveui-view="records" collection outside the core host result. Keep unknown groups with a generic record fallback; do not require unpromised service fields.');
}
