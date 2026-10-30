import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';

const {wantsLiveuiDevelopment, installDevelopmentRoutes} = await tsImport('../server/development-routes.ts', import.meta.url);

test('colloquial Chinese host repair selects development without an explicit target', () => {
  for (const prompt of ['修一下liveUI本身', '请修一下 liveUI 本身', '帮我修一下liveUI本身的开发入口']) {
    assert.equal(wantsLiveuiDevelopment({prompt}), true, prompt);
  }
});

test('ordinary App requests and quoted host instructions stay on the ordinary path', () => {
  for (const prompt of [
    '用liveUI做一个清单App',
    '修一下清单App',
    '修一下liveUI生成的清单App',
    '修一下liveUI',
    '创建一个说明如何修一下liveUI本身的页面',
    '“修一下liveUI本身”是什么意思',
    '> 修一下liveUI本身',
  ]) assert.equal(wantsLiveuiDevelopment({prompt}), false, prompt);
});

test('existing development intent forms and explicit selectors remain supported', () => {
  for (const prompt of [
    '修改 liveUI 本身，把按钮改一下', '修复liveUI宿主，处理错误',
    '请帮我修改liveUI源码', '帮我改liveUI本身的搜索框',
    '调整一下liveUI源代码', '更新liveUI的源码', '调试liveUI的宿主',
    '请用codex修改liveUI本身', 'Edit liveUI source code',
    'please fix the liveUI host', '继续修改liveUI，把入口改好',
  ]) assert.equal(wantsLiveuiDevelopment({prompt}), true, prompt);
  assert.equal(wantsLiveuiDevelopment({target: 'liveui', prompt: 'fix'}), true);
  assert.equal(wantsLiveuiDevelopment({developmentConversationId: 'existing', prompt: '继续'}), true);
  for (const body of [null, [], {}, {prompt: 123}]) assert.equal(wantsLiveuiDevelopment(body), false);
});

test('/agent/run dispatches host repair to development and lets the checklist App fall through', async () => {
  // Capture the real middleware without opening a server or creating a workspace.
  // The development branch must still enforce its owner guard, not create an App.
  const posts = new Map();
  const app = {get() {}, post(path, handler) { posts.set(path, handler); }};
  let ownerChecks = 0;
  const dev = installDevelopmentRoutes(app, null, {
    owners: [], sourceRoot: '', workspaceRoot: '',
    userOf() { ownerChecks++; return ''; },
    llmOf() { throw new Error('must not invoke inference'); },
    harnessFor() { throw new Error('must not select a harness'); },
    context: async () => ({}),
  });
  try {
    const route = posts.get('/agent/run');
    const errors = [];
    await route({body: {prompt: '修一下liveUI本身'}}, {}, error => errors.push(error));
    assert.equal(ownerChecks, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'development_owner_required');

    let ordinaryCalls = 0;
    await route({body: {prompt: '用liveUI做一个清单App'}}, {}, error => {
      assert.equal(error, undefined);
      ordinaryCalls++;
    });
    assert.equal(ordinaryCalls, 1);
    assert.equal(ownerChecks, 1, 'ordinary App requests must bypass development guards');
  } finally {
    await dev.dispose();
  }
});
