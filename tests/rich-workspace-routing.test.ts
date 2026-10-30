import test from 'node:test';
import assert from 'node:assert/strict';
import {wantsRichWorkspace} from '../server/rich-workspaces.js';

test('ordinary visual application requests reach the shared workspace path',()=>{
  for(const prompt of [
    '搭一个3D房间布局工具',
    '帮我画函数图，比较两条曲线',
    '给我绘制研究路线图',
    '我需要一个可以旋转的三维应用',
    'I want an interactive 3D room planner',
    'Please draw a project dependency diagram',
    'Design a dashboard with a scatter plot',
    'Visualize these values in a chart',
  ]) assert.equal(wantsRichWorkspace({prompt}),true,prompt);
});

test('explicit HTML and ordinary explanations keep their original delivery',()=>{
  assert.equal(wantsRichWorkspace({delivery:'html',prompt:'创建一个3D房间应用'}),false);
  assert.equal(wantsRichWorkspace({delivery:'workspace',prompt:'Organize my desk'}),true);
  for(const prompt of [
    '解释如何创建3D应用',
    '请介绍图表设计',
    'What does create a 3D scene mean?',
    'How do I build a diagram?',
    '不要创建3D应用',
    "Don't create a 3D app",
    'Compare the plotted values',
    'Create a reading list',
  ]) assert.equal(wantsRichWorkspace({prompt}),false,prompt);
});
