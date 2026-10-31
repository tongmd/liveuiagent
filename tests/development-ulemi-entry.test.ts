import test from 'node:test';
import assert from 'node:assert/strict';
import {wantsLiveuiDevelopment} from '../server/development-routes.js';

test('Ulemi host changes use the development workspace under its visible product name',()=>{
 for(const prompt of ['修改 Ulemi 本身，修复调试工具','修一下ulemi源码','请用Codex修复Ulemi宿主','Ulemi回复信息的UI要改一下','把 Ulemi 输入框改一下','继续调试Ulemi，把失败处理好','Please debug Ulemi source code']) assert.equal(wantsLiveuiDevelopment({prompt}),true,prompt);
 assert.equal(wantsLiveuiDevelopment({target:'ulemi',prompt:'fix source'}),true);
});

test('Ulemi app requests, quotations, questions and negated edits stay outside source editing',()=>{
 for(const prompt of ['用Ulemi生成一个计数器','创建介绍如何修改Ulemi本身的页面','“修改Ulemi本身”是什么意思','> 修改Ulemi源码','Ulemi界面怎么改？','不要修改Ulemi界面','Ulemi里生成的应用界面要改一下','只讨论Ulemi界面怎么改','继续','改一下']) assert.equal(wantsLiveuiDevelopment({prompt}),false,prompt);
});
