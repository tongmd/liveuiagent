import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../frontend/snapshot/rich-workspaces.js', import.meta.url), 'utf8');
function mount(app, snapshot, status = 200) {
  const effects = [], states = [], rendered = [];
  let stateIndex = 0, refIndex = 0;
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: initial => { const i = stateIndex++; states[i] = i === 0 && snapshot ? snapshot : initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => ({ current: refIndex++ === 2 && snapshot ? snapshot : initial }),
    useEffect: effect => { effects.push(effect); }
  };
  const window = { __liveuiagentReact: React, __liveuiStructuredRuntime: () => ({ render: (...args) => rendered.push(args) }) };
  const sandbox = { window, AbortSignal, setTimeout, sessionStorage: { getItem: () => null }, fetch: async () => ({ ok: status === 200, status, json: async () => status === 200 ? snapshot : {} }) };
  vm.runInNewContext(source, sandbox);
  const tree = window.LiveUIAgentRichWorkspace({ app });
  return { tree, states, effects, rendered };
}
function nodes(tree) { return [tree, ...tree.children.filter(n => n && typeof n === 'object').flatMap(nodes)]; }

test('English app has English input, submit label and initial loading status', () => {
  const view = mount({ appId: 'test-en', name: 'Function Comparison' });
  const all = nodes(view.tree);
  assert.equal(all.find(n => n.tag === 'textarea').props.placeholder, 'Describe a change');
  assert.equal(all.find(n => n.tag === 'textarea').props['aria-label'], 'Update this app');
  assert.equal(all.find(n => n.tag === 'button').children[0], 'Generate');
  assert.equal(view.states[1], 'Opening…');
});

test('Chinese app keeps Chinese chrome; latest request can change its language', () => {
  const app = { appId: 'test-zh', name: '函数对比' };
  const original = mount(app);
  assert.equal(nodes(original.tree).find(n => n.tag === 'textarea').props.placeholder, '描述想怎样调整这个应用');
  const changed = mount(app, { app, lastRequest: 'Use English throughout.', version: 2, tree: { type: 'Text', text: 'Functions' } });
  assert.equal(nodes(changed.tree).find(n => n.tag === 'textarea').props.placeholder, 'Describe a change');
});

test('Non-JSON HTTP failure keeps its code and follows the app language', async () => {
  for (const [name, expected] of [['Function Comparison', 'Request failed (503)'], ['函数对比', '请求失败（503）']]) {
    const view = mount({ appId: 'test-error', name }, undefined, 503);
    const cleanup = view.effects[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.states[1], expected);
    cleanup();
  }
});
