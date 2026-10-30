import test from 'node:test';
import assert from 'node:assert/strict';
import {wantsLiveuiDevelopment} from '../server/development-routes.js';

test('ordinary host editing language enters development including the actual numbered request',()=>{
 for(const prompt of [
  '1. liveui回复信息的ui要改，怎么有两个弹窗啊？而且UI非常的丑\n2. 要记录每个应用充分的信息，比如调哪些API、用哪个harness和模型生成。',
  'liveui回复信息的UI要改', '把liveui的回复界面改一下',
  '请把 liveUI 的聊天窗口重新设计一下', '修改liveUI的输入框',
  'liveUI界面重新设计，保留已有功能', '请调整liveUI的应用列表布局',
 ])assert.equal(wantsLiveuiDevelopment({prompt}),true,prompt);
});
test('mentions, quoted tasks, generated Apps, questions and negative commands do not become source edits',()=>{
 for(const prompt of [
  '用liveUI做一个清单App','修改liveUI生成的清单App','把liveUI里的飞机大战改成游戏',
  '做一个介绍liveUI界面如何修改的网页','如何修改liveUI回复界面？',
  '“liveUI回复界面要改”是什么意思','> liveUI回复界面要改',
  '1. “liveUI回复界面要改”是什么意思','不要修改liveUI的输入框',
  'liveUI回复界面不用改','liveUI回复界面不要修改',
  'liveUI界面不要重新设计','liveUI回复界面不需要改',
  'liveUI界面如何修改？','liveUI回复界面要改吗？',
  'liveUI界面里生成的记账App要改','liveUI界面中的"修改"按钮是什么意思？',
 ])assert.equal(wantsLiveuiDevelopment({prompt}),false,prompt);
});
