import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSemanticSurface, validateSemanticSurfaceDesign, type SurfaceContract} from '../server/native-surface-design.js';
import {designAppSurface, validateDesignedOverview} from '../server/liveuiagent.js';
import {assertRowActionPayload, rowActionSlotMap} from '../server/native-action-slots.js';

const fields: SurfaceContract['businessFields'] = [
  {name: 'topic', label: 'Study topic', type: 'string', required: true},
  {name: 'minutes', label: 'Study minutes', type: 'number'},
  {name: 'day', label: 'Study date', type: 'date'},
  {name: 'enabled', label: 'Reminder enabled', type: 'boolean'},
  {name: 'rating', label: 'Focus rating', type: 'select', options: [{label: 'Low', value: 'low'}, {label: 'High', value: 'high'}]},
  {name: 'notes', label: 'Study notes', type: 'text'},
];
const actions: SurfaceContract['actions'] = [
  {actionId: 'actions.add.run', label: 'Add session'},
  {actionId: 'actions.edit.run', label: 'Edit session', perItem: true, consumedSlots: ['minutes', 'enabled']},
  {actionId: 'actions.remove.run', label: 'Remove session', perItem: true, consumedSlots: []},
  {actionId: 'actions.finish.run', label: 'Finish session', perItem: true, consumedSlots: []},
];
const contract = {businessFields: fields, actions, persistedStateFields: fields};
const design = () => ({schemaVersion: 1, sectionOrder: ['summary', 'composer', 'records'], layout: {fields: 'paired-short', records: 'cards'}, headings: {records: 'Study sessions', composer: 'New session'}, recordFields: ['minutes', 'enabled']});
const reply = (value: unknown) => ({choices: [{message: {content: JSON.stringify(value)}}]});
function checked(raw = design(), input: SurfaceContract = contract) {
  const compiled = compileSemanticSurface(raw, input);
  const nodes = validateDesignedOverview(compiled.components, {slots: input.businessFields, actionIds: input.actions.map(action => action.actionId), rowActionSlots: rowActionSlotMap(input.actions, input.businessFields.map(field => field.name)), requireWidgets: true});
  assert.ok(nodes, 'the real strict validator accepts the compiled tree');
  return {...compiled, nodes};
}
function graph(nodes: Array<Record<string, any>>) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  assert.equal(byId.size, nodes.length);
  const references = new Map<string, number>();
  for (const node of nodes) {
    const children = [...(typeof node.child === 'string' ? [node.child] : []), ...(Array.isArray(node.children) ? node.children : []), ...(node.children?.componentId ? [node.children.componentId] : [])];
    for (const id of children) { assert.ok(byId.has(id), `referenced ${id} exists`); references.set(id, (references.get(id) ?? 0) + 1); }
  }
  for (const id of byId.keys()) assert.equal(references.get(id) ?? 0, id === 'overview' ? 0 : 1, `exactly one reference to ${id}`);
}

test('compiler removes the four actual defect classes: graph, unique slots, all actions and per-item scope', () => {
  const {components, nodes} = checked(); graph(components);
  graph(checked({...design(),recordFields:fields.map(field=>field.name)}).components);
  assert.ok(components.find(node=>node.id==='summary')!.children.includes('result'));
  assert.equal(components.filter(node=>node.text?.path==='/draft/result').length,1,'one actual result binding lives in summary, not duplicated after a long list');
  assert.equal(components[0].children.includes('result'),false);
  const inputs = components.filter(node => node.component === 'TextField');
  assert.deepEqual(inputs.map(node => node.label), fields.map(field => field.label), 'verified business labels cannot be renamed by a second model');
  assert.deepEqual(inputs.map(node => node.value.path), fields.map(field => `/draft/slots/${field.name}`));
  assert.deepEqual(inputs.map(node => node.variant), ['shortText', 'stepper', 'date', 'toggle', 'choice', 'longText']);
  assert.ok(inputs.every(node => !node.disabled && !node.hidden && !node.readOnly));
  assert.deepEqual(nodes.find(node => node.id === 'd_field_4')!.options, fields[4].options, 'host injects the actual typed choices');
  const buttons = components.filter(node => node.component === 'Button');
  for(const button of buttons) assert.equal(components.find(node=>node.id===button.child)!.text,actions.find(action=>action.actionId===button.action.event.name)!.label);
  assert.deepEqual(buttons.map(node => node.action.event.name).sort(), actions.map(action => action.actionId).sort());
  assert.equal(components.find(node => node.id === 'composer')!.children.filter((id: string) => id.startsWith('action_')).length, 1);
  assert.equal(components.find(node => node.id === 'item_body')!.children.filter((id: string) => id.startsWith('action_')).length, 3);
  const duplicate=structuredClone(components);duplicate.find(node=>node.id==='composer')!.children.push('duplicate_add');duplicate.push({id:'duplicate_add',component:'Button',child:'duplicate_add_label',action:{event:{name:'actions.add.run'}}},{id:'duplicate_add_label',component:'Text',text:'Add session'});
  assert.equal(validateDesignedOverview(duplicate,{slots:fields,actionIds:actions.map(action=>action.actionId),rowActionSlots:rowActionSlotMap(actions,fields.map(field=>field.name)),requireWidgets:true}),null,'a second composer entry for the same action is rejected');
  const target = {entityName: 'Second session', entityId: 'second',appRecordId:''};
  const payload = {...target, sourceComponentId: 'd_action_1', minutes: 0, enabled: false};
  assert.doesNotThrow(() => assertRowActionPayload(actions[1], payload, fields.map(field => field.name), [target], {messages: [{updateComponents: {components: nodes}}]}, 'edit.run'));
  assert.equal(payload.minutes, 0); assert.equal(payload.enabled, false);
  assert.throws(() => assertRowActionPayload(actions[1], {...payload, entityId: 'other',appRecordId:''}, fields.map(field => field.name), [target], {messages: [{updateComponents: {components: nodes}}]}, 'edit.run'), /unique current/);
});

test('all cardinalities and semantic layout choices compile complete trees; no model omission removes controls', () => {
  assert.equal(checked({...design(),sectionOrder:['records','summary','composer']}).components[0].children[0],'records','review-oriented records-first order stays supported');
  for (let count = 1; count <= 6; count++) for (let actionCount = 1; actionCount <= 4; actionCount++) for (const records of ['cards', 'compact']) {
    const input = {...contract, businessFields: fields.slice(0, count), actions: actions.slice(0, actionCount).map(action => ({...action, ...(action.perItem ? {consumedSlots: []} : {})}))};
    const value = {...design(), sectionOrder: ['composer', 'summary', 'records'], layout: {fields: 'stacked', records}, recordFields: []};
    const {components} = checked(value, input); graph(components);
    assert.equal(components.filter(node => node.component === 'TextField').length, count);
    assert.equal(components.filter(node => node.component === 'Button').length, actionCount);
    assert.equal(components[0].children[0], 'composer');
  }
});

test('strict semantic grammar rejects missing keys, duplicate order, legacy trees and injected bindings or business values', () => {
  const variants: unknown[] = [{components: []}];
  for (const key of Object.keys(design())) { const value: any = design(); delete value[key]; variants.push(value); }
  variants.push({...design(), sectionOrder: ['summary', 'records', 'records']}, {...design(), sectionOrder: ['summary', 'records', 'unknown']}, {...design(), layout: {fields: 'desktop', records: 'cards'}}, {...design(), fieldLabels: {not_declared: 'Unknown field'}}, {...design(), fieldLabels: {topic: {path: '/owner'}}}, {...design(), recordFields: ['owner']}, {...design(), recordFields: ['minutes', 'minutes']}, {...design(), headings: {records: 'Total $99', composer: 'New session'}}, {...design(), actionLabels: {'actions.remove.run':'Check'}}, {...design(), events: {run: 'execute'}}, {...design(), layout: {fields: 'stacked', records: 'cards', hidden: true}});
  for (const value of variants) assert.throws(() => validateSemanticSurfaceDesign(value, contract));
  assert.throws(() => checked({...design(), fieldLabels: {topic: 'Quantity'}}), /requires exactly/, 'even plausible renaming of a verified field is rejected');
});

test('strict design is the only inference path, bounded semantic repair retains the same fields/actions and no extra calls', async () => {
  const requests: any[] = []; let observed: unknown;
  const result = await designAppSurface({name: 'Sessions', description: 'Track study sessions', sourcePrompt: 'Keep my study sessions', businessFields: fields, actions, onDesign: value => { observed = value; }, llm: {model: 'fixture', chatCompletion: async request => { requests.push(request); return reply(requests.length === 1 ? {components: []} : design()); }}});
  assert.equal(requests.length, 2); graph(result); assert.equal(result.filter(node => node.component === 'TextField').length, 6);
  const first = JSON.parse(requests[0].messages[1].content); const second = JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(first.slots, second.slots); assert.deepEqual(first.actions, second.actions); assert.match(second.previousAttemptRejected, /exactly/);
  assert.deepEqual(observed, design()); assert.ok(result.some(node => node.component === 'List'));
  let calls = 0;
  await assert.rejects(designAppSurface({name: 'Sessions', description: 'Track sessions', sourcePrompt: 'Keep sessions', businessFields: fields, actions, llm: {model: 'fixture', chatCompletion: async () => { calls++; return reply({components: []}); }}}), /after 3 attempt/);
  assert.equal(calls, 3, 'invalid semantic output never triggers a legacy/fallback tree or extra inference budget');
});

test('legitimate all-row apps compile two or three exact row actions without inventing a global operation', async () => {
  for (const count of [2,3]) {
    const input = {...contract, actions: actions.slice(1,count+1)};
    const {components, nodes} = checked(design(), input); graph(components);
    assert.equal(components.filter(node=>node.component==='Button').length,count);
    assert.equal(components.find(node=>node.id==='composer')!.children.some((id:string)=>id.startsWith('action_')),false);
    const missing=structuredClone(components).filter(node=>!['action_0','action_0_label'].includes(node.id));missing.find(node=>node.id==='item_body')!.children=missing.find(node=>node.id==='item_body')!.children.filter((id:string)=>id!=='action_0');
    assert.equal(validateDesignedOverview(missing,{slots:fields,actionIds:input.actions.map(action=>action.actionId),rowActionSlots:rowActionSlotMap(input.actions,fields.map(field=>field.name)),requireWidgets:true}),null,'all-row support does not admit a missing action');
    const target={entityName:'Selected session',entityId:'selected',appRecordId:''};
    assert.doesNotThrow(()=>assertRowActionPayload(input.actions[0],{...target,sourceComponentId:'d_action_0',minutes:0,enabled:false},fields.map(field=>field.name),[target],{messages:[{updateComponents:{components:nodes}}]},'edit.run'));
    let calls=0;
    const result=await designAppSurface({name:'Sessions',description:'Edit selected sessions',sourcePrompt:'Edit selected sessions',businessFields:fields,actions:input.actions,llm:{model:'fixture',chatCompletion:async()=>{calls++;return reply(design());}}});
    assert.equal(calls,1);assert.equal(result.filter(node=>node.component==='Button').length,count);
  }
});
