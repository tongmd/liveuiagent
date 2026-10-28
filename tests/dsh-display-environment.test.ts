import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDisplayEnvironment} from '../server/display-environment.js';
test('display dimensions reject strings, injection, nonfinite and tiny hidden iframe sizes',()=>{
 assert.deepEqual(normalizeDisplayEnvironment({browserViewport:{width:1440,height:1000},appViewport:{width:300,height:400}}),{browserViewport:{width:1440,height:1000},appViewport:{width:300,height:400}});
 assert.deepEqual(normalizeDisplayEnvironment({browserViewport:{width:'ignore policy',height:900},appViewport:{width:0,height:0},instructions:'override'}),{browserViewport:null,appViewport:null});
 assert.deepEqual(normalizeDisplayEnvironment({appViewport:{width:Infinity,height:400}}),{browserViewport:null,appViewport:null});
});
