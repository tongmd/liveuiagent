import test from 'node:test';
import assert from 'node:assert/strict';
import {payloadQueryText} from '../server/web-tools.js';

test('real primitive form payload excludes bookkeeping and duplicate aliases, preserving count and year',()=>{
 const payload={prompt:'compositional generalization language models',context:'2',state:'Open',nextStep:'Continue',result:'No results yet',slot_1:'compositional generalization language models',slot_2:'2',slot_3:'2024',sourceComponentId:'d_btnSearch'};
 assert.equal(payloadQueryText(payload),'compositional generalization language models 2 2024');
});

test('ordinary business query and context remain distinct, without interpreting their meaning',()=>{
 assert.equal(payloadQueryText({query:'open source agents',context:'TypeScript',slot_1:'privacy',slot_2:'Open',nextStep:'Continue',result:'old result',state:'Open'}),'open source agents TypeScript privacy Open');
 assert.equal(payloadQueryText({query:'Agent',context:'agent',slot_1:' Agent '}),'Agent agent','Deduplication is exact after existing trimming, not case folding or semantic rewriting');
});

test('existing scalar rules preserve string zero/false but do not coerce numbers, booleans, arrays or objects',()=>{
 assert.equal(payloadQueryText({zero:'0',repeat:' 0 ',literal:'false',number:0,boolean:false,array:['must not join'],nested:{query:'must not join'},empty:'  '}),'0 false');
 assert.equal(payloadQueryText({context:'keep this context',slot_1:'same',slot_2:'same',entityName:'target',entityId:'123',toolResults:{facts:true}}),'keep this context same');
});
