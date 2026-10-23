/* LiveUIAgent settings and application evaluation. Runtime contracts stay server-owned. */
(() => {
  'use strict';
  const endpoint = path => window.__liveuiPath ? window.__liveuiPath(path) : `${location.pathname.startsWith('/liveui') ? '/liveui' : ''}${path}`;
  let settings = null, runtime = null, busy = false, strip, modelSelect, harnessSelect, message, panel;
  const evaluation = { apps: [], appId: '', mode: 'gui', expectation: '', running: false, result: null, error: '', loaded: false };

  async function api(path, method = 'GET', body, timeout = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(endpoint(path), {
        method, credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; }
      catch { throw Error(response.status === 401 ? 'Your session has expired. Please sign in again.' : 'The server returned an unreadable response. Please try again.'); }
      if (!response.ok) throw Error(data.error || `Request failed (${response.status})`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('The request timed out. Check task status before submitting again; it may still be running.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === 'text') node.textContent = value;
      else if (name === 'class') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else if (value !== undefined) node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  }
  const button = (text, onclick, props = {}) => el('button', { type: 'button', text, onclick, ...props });
  const option = (id, label, disabled = false) => {
    const node = el('option', { value: id, text: label }); node.disabled = disabled; return node;
  };
  function status(text, error = false, pending = false) {
    message.textContent = text;
    message.classList.toggle('is-error', error);
    message.classList.toggle('is-pending', pending);
  }
  function currentModel() { return settings?.effective?.model || ''; }
  function choices() { return Array.isArray(runtime?.choices) ? runtime.choices.map(item => ({ ...item, label: item.id === 'native' ? 'LiveUIAgent' : item.label })) : []; }
  function harnessLabel(id) { return choices().find(item => item.id === id)?.label || (id === 'dsh' ? 'DSH' : id === 'native' ? 'LiveUIAgent' : id || 'Not loaded'); }
  function runtimeWarning() {
    if (runtime?.harness !== 'dsh' || runtime?.model?.configurable !== false) return '';
    return runtime.model.reason || `This DSH service does not support model switching${runtime.model.runnerDefault ? `; use ${runtime.model.runnerDefault}` : ''}.`;
  }

  function renderSettings() {
    const model = currentModel();
    const models = [...new Set([model, ...(settings?.effective?.models || [])].filter(Boolean))];
    modelSelect.replaceChildren(...(models.length ? models.map(id => option(id, id)) : [option('', 'Configure a model')]));
    modelSelect.value = model;
    modelSelect.disabled = busy || !models.length;
    modelSelect.title = model || 'Add a model in settings';
    harnessSelect.replaceChildren(...(choices().length ? choices().map(item => option(item.id, `${item.label}${item.available ? '' : ' · Unavailable'}`, !item.available)) : [option('', 'Harness not loaded')]));
    harnessSelect.value = runtime?.harness || '';
    harnessSelect.disabled = busy || !runtime;
    const active = choices().find(item => item.id === runtime?.harness);
    harnessSelect.title = active?.reason || 'The harness for new apps. Existing apps keep their original harness.';
    strip.setAttribute('aria-busy', String(busy));
  }

  async function refresh() {
    const results = await Promise.allSettled([api('/agent/settings'), api('/agent/runtime-settings')]);
    if (results[0].status === 'fulfilled') settings = results[0].value;
    if (results[1].status === 'fulfilled') runtime = results[1].value;
    renderSettings();
    const failed = results.filter(item => item.status === 'rejected');
    if (failed.length) status(failed.map(item => item.reason.message).join(' · '), true);
    else {
      const active = choices().find(item => item.id === runtime.harness);
      status(active && !active.available ? active.reason || 'The selected harness is unavailable' : runtimeWarning() || (settings?.effective?.keySource === 'none' ? 'Configure an API connection in settings.' : 'New apps use this harness. Existing apps keep their original harness.'), !!active && !active.available || !!runtimeWarning());
    }
  }

  async function changeModel() {
    const chosen = modelSelect.value;
    busy = true; renderSettings(); status('Saving model…', false, true);
    try {
      settings = await api('/agent/settings', 'PUT', { model: chosen });
      window.__liveuiSettings = settings;
      window.dispatchEvent(new CustomEvent('liveui:settings', { detail: settings }));
      status(`Model saved: ${currentModel() || 'Not configured'}.`);
    } catch (error) { status(error.message, true); }
    finally { busy = false; renderSettings(); }
  }

  async function changeHarness() {
    const chosen = harnessSelect.value;
    busy = true; renderSettings(); status('Saving harness…', false, true);
    try {
      runtime = await api('/agent/runtime-settings', 'PATCH', { harness: chosen });
      window.dispatchEvent(new CustomEvent('liveui:runtime', { detail: runtime }));
      status(runtimeWarning() || `New apps will use ${harnessLabel(runtime.harness)}. Existing apps keep their original harness.`, !!runtimeWarning());
    } catch (error) { status(error.message, true); }
    finally { busy = false; renderSettings(); }
  }

  function closePanel() {
    if (!panel) return;
    panel.close(); panel.remove(); panel = null;
    strip.querySelector('[data-evaluation-open]')?.focus();
  }
  function showAvailability() {
    if (panel) closePanel();
    panel = el('dialog', { class: 'liveui-panel', 'aria-label': 'Model and harness' });
    panel.append(el('div', { class: 'liveui-panel-heading' }, [el('h2', { text: 'Model and harness' }), button('Close', closePanel)]));
    panel.append(el('p', { text: `Current model: ${currentModel() || 'Not configured'}. New app harness: ${harnessLabel(runtime?.harness)}.` }));
    if (runtimeWarning()) panel.append(el('p', { class: 'liveui-notice', text: runtimeWarning() }));
    for (const item of choices()) panel.append(el('article', { class: 'liveui-runtime-option' }, [
      el('strong', { text: `${item.label} · ${item.available ? 'Available' : 'Unavailable'}` }),
      el('p', { text: item.reason || (item.id === 'native' ? 'Build interactive apps with actions managed by LiveUIAgent.' : 'Build complete HTML apps with DSH.') })
    ]));
    panel.append(el('p', { class: 'liveui-muted', text: 'Harness changes apply to new apps. Existing apps use their original harness for edits and actions.' }));
    panel.append(button('Model and API settings', () => {
      closePanel();
      const existing = document.querySelector('.settings-fab');
      if (existing) existing.click(); else status('Settings are still loading. Please try again shortly.', true);
    }, { class: 'liveui-primary' }));
    document.body.append(panel); panel.showModal();
  }

  function selectedApp() { return evaluation.apps.find(app => app.appId === evaluation.appId); }
  function isComplete(app) { return !!app && (app.completeApp || String(app.appId).startsWith('dsh_')); }
  function openEvaluation() {
    if (panel) closePanel();
    panel = el('dialog', { class: 'liveui-panel liveui-evaluation', 'aria-label': 'Evaluate app' });
    document.body.append(panel); renderEvaluation(); panel.showModal();
    loadApps();
  }
  async function loadApps() {
    try {
      const state = await api('/agent/query-state', 'POST', {});
      evaluation.apps = Array.isArray(state.apps) ? state.apps : [];
      evaluation.loaded = true;
      if (!selectedApp()) evaluation.appId = evaluation.apps.find(app => !isComplete(app))?.appId || evaluation.apps[0]?.appId || '';
      if (panel?.classList.contains('liveui-evaluation')) renderEvaluation();
    } catch (error) {
      evaluation.error = error.message;
      if (panel?.classList.contains('liveui-evaluation')) renderEvaluation();
    }
  }
  function downloadReport() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(evaluation.result, null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: 'liveuiagent-evaluation.json' }); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderReport(container, result) {
    const passed = result.status ? result.status === 'passed' : result.passed;
    const verdict = result.verdict || result;
    container.append(el('strong', { text: passed === true ? 'Evaluation passed' : passed === false ? 'Evaluation failed' : 'Evaluation complete' }));
    container.append(el('p', { class: 'liveui-muted', text: `${result.appName || 'App'}${result.harness ? ` · ${harnessLabel(result.harness)}` : ''}${result.storageMode === 'isolated-copy' ? ' · Isolated data copy' : ''}` }));
    if (verdict.summary) container.append(el('p', { text: verdict.summary }));
    if (result.scores) {
      const rows = Object.entries(result.scores).map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: String(value) })]));
      container.append(el('dl', { class: 'liveui-score-grid' }, rows));
    }
    const findings = [...(verdict.failures || []), ...(result.blockingFindings || []), ...(result.findings || []), ...(verdict.evidence || [])];
    if (findings.length) container.append(el('ul', {}, [...new Set(findings)].map(text => el('li', { text: String(text) }))));
    container.append(button('Download JSON report', downloadReport));
    const artifacts = (result.artifacts?.files || []).filter(file => typeof file.url === 'string' && /^\/evaluator\/artifacts\//.test(file.url));
    if (artifacts.length) {
      const links = el('div', { class: 'liveui-artifact-links', 'aria-label': 'Screenshots and evaluation files' });
      for (const file of artifacts) links.append(el('a', { href: endpoint(file.url), target: '_blank', rel: 'noopener', text: file.name || 'View evaluation file' }));
      container.append(links);
    }
    container.append(el('details', {}, [el('summary', { text: 'View full report' }), el('pre', { text: JSON.stringify(result, null, 2) })]));
  }
  function renderEvaluation() {
    if (!panel?.classList.contains('liveui-evaluation')) return;
    const app = selectedApp();
    panel.replaceChildren(el('div', { class: 'liveui-panel-heading' }, [el('h2', { text: 'Evaluate app' }), button('Close', closePanel)]));
    const appPicker = el('select', { 'aria-label': 'App to evaluate', onchange: event => { evaluation.appId = event.target.value; evaluation.result = null; evaluation.error = ''; renderEvaluation(); } },
      evaluation.apps.length ? evaluation.apps.map(item => option(item.appId, `${item.name} · ${isComplete(item) ? 'DSH' : 'LiveUIAgent'}`)) : [option('', evaluation.loaded ? 'No apps yet' : 'Loading apps…')]);
    appPicker.value = evaluation.appId; appPicker.disabled = evaluation.running;
    const modePicker = el('select', { 'aria-label': 'Evaluation mode', onchange: event => { evaluation.mode = event.target.value; evaluation.result = null; evaluation.error = ''; renderEvaluation(); } }, [option('gui', 'Interface check'), option('behavior', 'Behavior evaluation')]);
    modePicker.value = evaluation.mode; modePicker.disabled = evaluation.running;
    panel.append(el('label', { class: 'liveui-field' }, [el('span', { text: 'Select app' }), appPicker]));
    panel.append(el('label', { class: 'liveui-field' }, [el('span', { text: 'Evaluation mode' }), modePicker]));
    const explanation = isComplete(app)
      ? evaluation.mode === 'gui' ? 'Check desktop and mobile layouts, labels, and runtime errors in a real browser. No evaluator model is called.' : 'The evaluator model interacts with the app in a real browser for up to 8 steps and checks the results. In-app AI actions also call a model.'
      : evaluation.mode === 'gui' ? 'Check visible content, inputs, and button bindings. No evaluator model is called.' : 'The evaluator model tests the expected behavior for up to 8 steps. This calls a model and may change app data.';
    panel.append(el('p', { class: 'liveui-muted', text: explanation }));
    if (isComplete(app)) panel.append(el('p', { class: 'liveui-notice', text: 'Uses an isolated copy of saved data. Evaluation records stay in this copy; reopening checks whether they were saved.' }));
    if (evaluation.mode === 'behavior') {
      const expectation = el('textarea', { rows: '4', maxlength: '4000', 'aria-label': 'Expected behavior', placeholder: 'For example: add a test record and check that it remains after reopening.', oninput: event => {
        evaluation.expectation = event.target.value;
        panel.querySelector('[data-evaluation-run]').disabled = evaluation.running || !selectedApp() || !evaluation.expectation.trim();
      } });
      expectation.value = evaluation.expectation; expectation.disabled = evaluation.running;
      panel.append(el('label', { class: 'liveui-field' }, [el('span', { text: 'Expected behavior' }), expectation]));
      panel.append(el('p', { class: 'liveui-muted', text: `Evaluator model: ${currentModel() || 'Configure a model first'}` }));
    }
    const run = button(evaluation.running ? 'Evaluating…' : 'Run evaluation', runEvaluation, { class: 'liveui-primary', 'data-evaluation-run': '' });
    run.disabled = evaluation.running || !app || (evaluation.mode === 'behavior' && !evaluation.expectation.trim());
    panel.append(el('div', { class: 'liveui-panel-actions' }, [run, button('Refresh apps', loadApps)]));
    if (evaluation.error) panel.append(el('p', { class: 'liveui-error', role: 'alert', text: evaluation.error }));
    if (evaluation.running) panel.append(el('p', { role: 'status', text: 'You can close this panel. Keep this page open to receive the result.' }));
    if (evaluation.result) {
      const report = el('section', { class: 'liveui-report', 'aria-label': 'Evaluation result' }); renderReport(report, evaluation.result); panel.append(report);
    }
  }
  async function runEvaluation() {
    const app = selectedApp();
    if (!app || evaluation.running) return;
    evaluation.running = true; evaluation.error = ''; evaluation.result = null; renderEvaluation();
    try {
      const payload = { appId: app.appId, appName: app.name };
      if (evaluation.mode === 'behavior') Object.assign(payload, { expectedBehaviorPrompt: evaluation.expectation.trim(), channel: 'behavior', maxSteps: 8, horizonTurns: 3 });
      evaluation.result = await api(evaluation.mode === 'gui' ? '/evaluator/gui' : '/evaluator/run', 'POST', payload, 900000);
      status(`Evaluation complete: ${app.name}.`);
    } catch (error) { evaluation.error = error.message; status(`Evaluation failed: ${error.message}`, true); }
    finally { evaluation.running = false; renderEvaluation(); }
  }

  function annotateWindows() {
    for (const sheet of document.querySelectorAll('.app-sheet')) {
      const title = sheet.querySelector('.sheet-title-block');
      if (!title || title.querySelector('.liveui-app-runtime')) continue;
      title.append(el('small', { class: 'liveui-app-runtime', text: sheet.classList.contains('complete-sheet') ? 'DSH · HTML app' : 'LiveUIAgent · Interactive app' }));
    }
  }
  function updateViewport() {
    const viewport = window.visualViewport;
    const editing = document.activeElement?.matches('.liveui-composer textarea');
    const inset = editing && viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty('--liveui-keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--liveui-viewport-height', `${viewport?.height || window.innerHeight}px`);
    document.body.classList.toggle('liveui-keyboard-open', inset > 80);
  }
  function attachControls() {
    const slot = document.querySelector('[data-liveui-composer-controls]');
    if (slot && strip && strip.parentElement !== slot) slot.append(strip);
  }
  function mount() {
    modelSelect = el('select', { 'aria-label': 'Current model', onchange: changeModel });
    harnessSelect = el('select', { 'aria-label': 'New app harness', onchange: changeHarness });
    message = el('p', { class: 'liveui-runtime-status is-pending', role: 'status', text: 'Loading settings…' });
    strip = el('section', { class: 'liveui-runtime-controls', 'aria-label': 'LiveUIAgent model and harness' }, [
      el('div', { class: 'liveui-runtime-row' }, [
        el('label', {}, [el('span', { text: 'Model' }), modelSelect]),
        el('label', {}, [el('span', { text: 'Harness' }), harnessSelect]),
        button('Settings', showAvailability, { title: 'Model, API, and harness settings' }),
        button('Evaluate', openEvaluation, { 'data-evaluation-open': '', title: 'Evaluate an app' }),
        button('↻', refresh, { 'aria-label': 'Reload settings', title: 'Reload settings' })
      ]), message
    ]);
    attachControls(); renderSettings();
    window.__liveuiControlsReady = refresh();
    window.addEventListener('liveui:settings-applied', event => { settings = event.detail; renderSettings(); });
    window.addEventListener('focus', () => { if (!busy) refresh(); });
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    document.addEventListener('focusin', updateViewport);
    document.addEventListener('focusout', () => requestAnimationFrame(updateViewport));
    updateViewport();
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel) { event.stopPropagation(); closePanel(); } }, true);
    new MutationObserver(() => { attachControls(); annotateWindows(); }).observe(document.body, { childList: true, subtree: true });
    attachControls(); annotateWindows();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
