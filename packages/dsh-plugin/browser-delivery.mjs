import { validatePresentationContract } from './presentation-contract.mjs';
import { normalizeDeliveryViewport } from './delivery-viewport.mjs';
export { normalizeDeliveryViewport } from './delivery-viewport.mjs';
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
export async function validateBrowserDelivery(html, { chrome, signal, settleMs = 350, requireAgentAction = false, viewport, presentationContract } = {}) {
  const presentation=validatePresentationContract(presentationContract);
  let browser;
  let actionPhase = false;
  let outcome = 'failure';
  const agentCalls = [];
  const token = randomBytes(10).toString('hex');
  const syntheticRequest = `Process this current user request: delivery-check-${token}`;
  const serviceError = `Connected service unavailable: delivery-error-${token}`;
  const serviceSuccess = {ok:true,status:'succeeded',text:`Observed service result: delivery-success-${token}`,data:{entities:[{id:`delivery-${token}`,name:`Observed entity ${token}`,detail:`Observed detail ${token}`,group:`unknown-group-${token}`},{name:`Second entity ${token}`,detail:`Second detail ${token}`,group:`other-group-${token}`}],stats:[{label:`Observed count ${token}`,value:'1'}],evaluation:{pass:true,deficiencies:[]}}};
  let actionVerification, presentationVerification;
  let presentationCalls=0;
  const errors = [];
  const layoutChecks = [];
  const requestedViewport = normalizeDeliveryViewport(viewport);
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
    if(presentation)await page.exposeFunction('__deliveryPresentationAction',(key,prompt,context)=>{
      if(key!==channel||context?.uiProtocol!=='liveui-tree-v1'||typeof prompt!=='string'||!prompt.includes('delivery-ui-'))throw Error('Invalid presentation bridge request');
      const variant=++presentationCalls;
      return{text:'Controlled geometry',requestId:context.requestId,data:{tree:{type:'Stack',children:[{type:'Scene3D',scene:{title:'Geometry '+variant,grid:true,objects:[{id:'probe-'+token+'-'+variant,shape:variant===1?'box':'torus',position:[0,0,0],scale:[1,1,1],color:variant===1?'#6366f1':'#10b981'}]}},...(context.records||[]).map(r=>({type:'List',recordId:r.id,children:[]})),...(context.photos||[]).map(p=>({type:'Image',photoId:p.id}))]}}};
    });
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    // Match the host's opaque-origin storage API. AI is unavailable during startup
    // checks: a real request must happen through an explicit user action later.
    const structuredRuntime = await fs.readFile(new URL('../../frontend/snapshot/structured-ui-runtime.js', import.meta.url),'utf8');
    const bootstrap = `<script>(${installDeliverySdk.toString()})(${JSON.stringify(channel)},${JSON.stringify(requireAgentAction)},${JSON.stringify(Boolean(presentation))});</script>`;
    const runtimeBootstrap='<script>'+structuredRuntime+`;(()=>{let saveCount=0;window.liveuiagent.save=async(k,v)=>{window.liveuiagent.storage.setItem(k,v);saveCount++;return {ok:true};};Object.defineProperty(window,'__deliveryUiSaveCount',{value:()=>saveCount,writable:false});const ui=window.__liveuiStructuredRuntime(window.liveuiagent);const originalGenerate=ui.generate;let generationCount=0;Object.defineProperty(ui,'generate',{value:async function(...args){generationCount++;return originalGenerate.apply(ui,args);},writable:false});Object.defineProperty(window,'__deliveryUiGenerationCount',{value:()=>generationCount,writable:false});Object.defineProperty(window.liveuiagent,'ui',{value:Object.freeze(ui),writable:false});})();</script>`;
    const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + policy + bootstrap + runtimeBootstrap) : policy + bootstrap + runtimeBootstrap + html;
    const loadApp = async () => {
      await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="app" sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
      await page.evaluate(({ html, channel }) => {
        const iframe = document.querySelector('#app');
        addEventListener('message', event => { if (event.source !== iframe.contentWindow || event.data?.channel !== channel) return;
          if(event.data.type==='presentation'){const {id,prompt,context}=event.data;window.__deliveryPresentationAction(channel,prompt,context).then(value=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',value},'*'),error=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',error:error.message},'*'));}
          else if (event.data.type === 'agent') {
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
    // Measure the app iframe, not the outer host page. Reuse this same browser,
    // SDK policy and total deadline; resizing never calls real AI or services.
    const viewports = [requestedViewport ?? {width:1280,height:900}, {width:390,height:844}];
    for (const size of viewports.filter((v,i,a)=>a.findIndex(x=>x.width===v.width&&x.height===v.height)===i)) {
      await page.setViewport(size);
      await new Promise(resolve => setTimeout(resolve, 50));
      const measured = await frame.evaluate(measureDeliveryLayout);
      measured.violations.push(...await verifyExplicitDisclosures(frame));
      layoutChecks.push({...size,...measured});
      for (const violation of measured.violations) add('browser_layout', `${size.width}x${size.height}: ${violation}`);
    }
    await page.setViewport(requestedViewport ?? {width:1280,height:900});
    if(presentation&&!errors.length){try{presentationVerification=await verifyPresentation(frame);}catch(error){add('browser_presentation_contract',error.message);}}
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
  return { ok: errors.length === 0, errors, scope: requireAgentAction ? 'browser-agent-action-contract' : 'browser-startup', businessBehaviorVerified: false, layoutChecks, ...(actionVerification ? { agentAction: actionVerification } : {}),...(presentationVerification?{presentation:presentationVerification}:{}) };
}


async function verifyPresentation(frame){
  const target=await frame.evaluate(()=>{
    const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    if(document.querySelector('meta[name="liveui-ui-protocol"]')?.content!=='liveui-tree-v1')throw Error('Declare liveui-tree-v1 through the host protocol meta tag; a custom Canvas2D renderer is not the requested maintained 3D component.');
    const inputs=[...document.querySelectorAll('input[data-liveui-ui-request],textarea[data-liveui-ui-request]')].filter(visible);
    const buttons=[...document.querySelectorAll('button[data-liveui-action="ui.generate"],input[type="submit"][data-liveui-action="ui.generate"]')].filter(visible);
    if(inputs.length!==1||buttons.length!==1||buttons[0].disabled||inputs[0].disabled)throw Error('Provide one visible editable data-liveui-ui-request input and one enabled data-liveui-action="ui.generate" button, connected to await window.liveuiagent.ui.generate.');
    inputs[0].setAttribute('data-delivery-ui-input','true');buttons[0].setAttribute('data-delivery-ui-button','true');return true;
  });
  if(!target)throw Error('Structured UI controls are unavailable');
  const states=[];
  for(let variant=1;variant<=2;variant++){
    const previous=await frame.evaluate(()=>({generations:window.__deliveryUiGenerationCount(),saves:window.__deliveryUiSaveCount()}));
    await frame.$eval('[data-delivery-ui-input="true"]',(node,value)=>{const proto=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},'delivery-ui-'+variant+' generate a new interactive 3D scene');
    await frame.click('[data-delivery-ui-button="true"]');
    await frame.waitForFunction(({previous,variant})=>{
      const component=[...document.querySelectorAll('[data-liveui-component="Scene3D"]')].find(n=>n.textContent.includes('Geometry '+variant));
      if(!component||window.__deliveryUiGenerationCount()!==previous.generations+1||window.__deliveryUiSaveCount()<=previous.saves)return false;
      const canvas=component.querySelector('section[data-renderer="webgl"] canvas');if(!canvas)return false;const r=canvas.getBoundingClientRect();return r.width>=160&&r.height>=100&&r.top<innerHeight&&r.bottom>0;
    },{timeout:4000}, {previous,variant});
    const result=await frame.evaluate(variant=>{
      const component=[...document.querySelectorAll('[data-liveui-component="Scene3D"]')].find(n=>n.textContent.includes('Geometry '+variant));const canvas=component.querySelector('canvas'),gl=canvas.getContext('webgl');
      if(!gl||gl.isContextLost())throw Error('Scene3D has no live WebGL context');const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let changed=0;for(let i=4;i<pixels.length;i+=4)if(Math.abs(pixels[i]-pixels[0])+Math.abs(pixels[i+1]-pixels[1])+Math.abs(pixels[i+2]-pixels[2])>20)changed++;
      if(changed<100)throw Error('Scene3D must render nonempty geometry, not an empty canvas or text label');
      return{variant,pixelsChanged:changed,canvasWidth:canvas.width,canvasHeight:canvas.height,view:component.querySelector('[data-renderer]').dataset.view};
    },variant);states.push(result);
  }
  return{scope:'controlled-presentation-variants',generationCalls:2,storageAcknowledgements:true,realProviderCalls:0,realBusinessCalls:0,variants:states};
}

function installDeliverySdk(channel, agentEnabled, presentationEnabled) {
  const values = Object.create(null), pending = new Map(); let sequence = 0, primaryAction = false;
  addEventListener('click', event => { if (event.isTrusted && event.target.closest?.('[data-delivery-primary="true"]')) primaryAction = true; }, true);
  const storage = { getItem: k => Object.hasOwn(values, String(k)) ? values[String(k)] : null, setItem: (k, v) => { values[String(k)] = String(v); }, removeItem: k => { delete values[k]; }, clear: () => { for (const k of Object.keys(values)) delete values[k]; }, key: i => Object.keys(values)[i] ?? null, get length() { return Object.keys(values).length; } };
  Object.defineProperty(window, 'localStorage', { value: storage });
  window.liveuiagent = { storage, ai: (prompt, context) => {
    if (!agentEnabled&&!(presentationEnabled&&context?.uiProtocol==='liveui-tree-v1')) return Promise.reject(Error('AI actions require a user action; unavailable during delivery startup verification'));
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parent.postMessage({ channel, id, type: presentationEnabled&&context?.uiProtocol==='liveui-tree-v1'?'presentation':'agent', prompt, context, primaryAction }, '*'); });
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


function measureDeliveryLayout() {
  const width = document.documentElement.clientWidth, height = innerHeight;
  const violations = [], nodes = [...document.body.querySelectorAll('*')];
  const leakedHidden = nodes.find(node => node.hasAttribute('hidden') && !(node.tagName === 'INPUT' && node.type === 'hidden') && getComputedStyle(node).display !== 'none');
  if (leakedHidden) violations.push(`Element ${leakedHidden.tagName.toLowerCase()}${leakedHidden.id ? '#'+leakedHidden.id : ''} has the hidden attribute but CSS overrides it with display:${getComputedStyle(leakedHidden).display}. Preserve hidden-state behavior, for example with [hidden]{display:none !important}; do not show collapsed editors or remove the hidden state.`);
  const shown = node => { const r=node.getBoundingClientRect(),s=getComputedStyle(node); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  if (document.documentElement.scrollWidth > width + 3 || document.body.scrollWidth > width + 3)
    violations.push(`Horizontal page overflow: content ${Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}px exceeds iframe ${width}px. Wrap text and collapse columns; do not hide content.`);
  for (const node of nodes.filter(shown)) {
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName) && (rect.left < -3 || rect.right > width+3)) {
      violations.push(`Control ${node.tagName.toLowerCase()} extends outside iframe width. Make the control and its parent responsive.`); break;
    }
  }
  const oversized = nodes.filter(shown).find(node => {
    const text=[...node.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
    return text.length>=24 && parseFloat(getComputedStyle(node).fontSize)>64;
  });
  if(oversized) violations.push(`Long text uses ${getComputedStyle(oversized).fontSize} type. Use readable semantic heading/body sizes on every render path, including restored views.`);
  return {iframeWidth:width,iframeHeight:height,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),violations};
}

async function verifyExplicitDisclosures(frame) {
  // Only explicit disclosure buttons. Never submit, invoke a host action or
  // follow a link. Resolve again after each click: React may replace the DOM.
  const targets = await frame.evaluate(() => [...new Set([...document.querySelectorAll('[aria-expanded][aria-controls]')].map(n=>n.getAttribute('aria-controls')?.trim()).filter(t=>t&&!/\s/.test(t)))]);
  const violations=[];let checked=0;
  for(const target of targets) {
    const initial=await frame.evaluateHandle(resolveDisclosureControl,target),button=initial.asElement();
    if(!button){await initial.dispose();continue;}
    if(checked++>=3){await initial.dispose();break;}
    const expanded=await button.evaluate(n=>n.getAttribute('aria-expanded'));
    try {
      if(expanded==='true')await button.click();
      const result=await frame.evaluate(settleDisclosurePanel,target);
      const current=await frame.evaluateHandle(resolveDisclosureControl,target,false);
      const now=await current.asElement()?.evaluate(n=>n.getAttribute('aria-expanded'));
      await current.dispose();
      if(now!=='false')violations.push(`Disclosure for #${target} did not collapse after its explicit toggle.`);
      else if(!result.hidden)violations.push(`Disclosure for #${target} reports aria-expanded=false but its controlled panel remains visible (display:${result.display}, ${Math.round(result.width)}x${Math.round(result.height)}). Hide the controlled panel when collapsed and keep the toggle state consistent.`);
    } finally {
      if(expanded==='true') {
        const current=await frame.evaluateHandle(resolveDisclosureControl,target,false),restore=current.asElement();
        if(restore&&await restore.evaluate(n=>n.getAttribute('aria-expanded')==='false')) {
          await restore.click();await frame.evaluate(settleDisclosurePanel,target);
          const restored=await frame.evaluateHandle(resolveDisclosureControl,target);
          if(!restored.asElement()||!await restored.asElement().evaluate(n=>n.getAttribute('aria-expanded')==='true'))violations.push(`Disclosure for #${target} could not restore its original expanded control and panel.`);
          await restored.dispose();
        }
        await current.dispose();
      }
      await initial.dispose();
    }
  }
  return violations;
}
function resolveDisclosureControl(target, requireTarget=true) {
  const count=[...document.querySelectorAll('[id]')].filter(n=>n.id===target).length;
  if(count>1||(requireTarget&&count!==1))return null;
  const controls=[...document.querySelectorAll('[aria-expanded][aria-controls]')].filter(node=>{
    const role=node.getAttribute('role'),safeButton=node.tagName==='BUTTON'
      ? node.getAttribute('type')==='button'&&(!role||role==='button')
      : role==='button'&&node.tagName!=='INPUT'&&!node.hasAttribute('href');
    const r=node.getBoundingClientRect(),s=getComputedStyle(node);
    return safeButton&&node.getAttribute('aria-controls')?.trim()===target&&/^(true|false)$/.test(node.getAttribute('aria-expanded'))&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!node.closest('[data-liveui-action]')&&!node.disabled&&node.getAttribute('aria-disabled')!=='true';
  });
  return controls.length===1?controls[0]:null;
}
async function settleDisclosurePanel(target) {
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const panel=document.getElementById(target);
  if(!panel)return {hidden:true};
  const animations=panel.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming()?.endTime));
  await Promise.all(animations.map(a=>a.finished.catch(()=>{})));
  const r=panel.getBoundingClientRect(),s=getComputedStyle(panel);
  return {hidden:s.display==='none'||s.visibility==='hidden'||s.contentVisibility==='hidden'||s.opacity==='0'||(parseFloat(s.maxHeight)===0&&['hidden','clip'].includes(s.overflowY))||r.width===0||r.height===0||panel.getClientRects().length===0,display:s.display,width:r.width,height:r.height};
}
