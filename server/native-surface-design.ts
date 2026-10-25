import { rowActionSlotMap } from './native-action-slots.js';

type FieldType = 'string' | 'text' | 'select' | 'boolean' | 'date' | 'number';
export type SurfaceField = {name: string; label: string; type?: FieldType; required?: boolean; options?: Array<{label: string; value: string}>};
export type SurfaceAction = {actionId: string; label: string; perItem?: boolean; consumedSlots?: string[]};
export type SurfaceContract = {businessFields: SurfaceField[]; actions: SurfaceAction[]; persistedStateFields: Array<{name: string; label: string}>};
export type SemanticSurfaceDesign = {
  schemaVersion: 1;
  sectionOrder: Array<'summary' | 'records' | 'composer'>;
  layout: {fields: 'paired-short' | 'stacked'; records: 'cards' | 'compact'};
  headings: {records: string; composer: string};
  fieldLabels: Record<string, string>;
  recordFields: string[];
};

export function assertSurfaceContract(contract: SurfaceContract): void {
  const fields = contract.businessFields;
  const actions = contract.actions;
  if (fields.length < 1 || fields.length > 6 || new Set(fields.map(field => field.name)).size !== fields.length) throw Error('Surface contract needs 1-6 distinct business fields');
  if (actions.length < 1 || actions.length > 4 || new Set(actions.map(action => action.actionId.replace(/^actions\./, ''))).size !== actions.length) throw Error('Surface contract needs 1-4 distinct actions');
  rowActionSlotMap(actions, fields.map(field => field.name));
}

function object(raw: unknown, keys?: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Design must contain JSON objects');
  const value = raw as Record<string, unknown>;
  if (keys && (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))) {
    throw Error(`Design object requires exactly: ${keys.join(', ')}`);
  }
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw Error(`Design choice must be one of: ${allowed.join(', ')}`);
  return value as T;
}
function label(raw: unknown, min = 1): string {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.length < min || raw.length > 18 || /[\d\n\r<>]|\{\{|\}\}/u.test(raw)) {
    throw Error('Design labels must be plain human text of 1-18 characters, without numeric facts, markup or bindings');
  }
  return raw;
}
function labels(raw: unknown, known: string[], min: number): Record<string, string> {
  const values = object(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!known.includes(key)) throw Error('Design label references an unknown slot or action');
    result[key] = label(value, min);
  }
  return result;
}

/** The only model-facing design grammar. It cannot declare controls or bindings. */
export function validateSemanticSurfaceDesign(raw: unknown, contract: SurfaceContract): SemanticSurfaceDesign {
  const value = object(raw, ['schemaVersion', 'sectionOrder', 'layout', 'headings', 'fieldLabels', 'recordFields']);
  if (value.schemaVersion !== 1) throw Error('Design schemaVersion must be 1');
  if (!Array.isArray(value.sectionOrder) || value.sectionOrder.length !== 3 || new Set(value.sectionOrder).size !== 3) {
    throw Error('Design sectionOrder must contain summary, records and composer exactly once');
  }
  const sectionOrder = value.sectionOrder.map(item => choice(item, ['summary', 'records', 'composer'] as const));
  const layout = object(value.layout, ['fields', 'records']);
  const headings = object(value.headings, ['records', 'composer']);
  if (!Array.isArray(value.recordFields) || new Set(value.recordFields).size !== value.recordFields.length
    || value.recordFields.some(item => typeof item !== 'string' || !contract.persistedStateFields.some(field => field.name === item))) {
    throw Error('Design recordFields must be distinct declared persisted field names');
  }
  return {
    schemaVersion: 1, sectionOrder,
    layout: {fields: choice(layout.fields, ['paired-short', 'stacked']), records: choice(layout.records, ['cards', 'compact'])},
    headings: {records: label(headings.records), composer: label(headings.composer)},
    fieldLabels: labels(value.fieldLabels, contract.businessFields.map(field => field.name), 2),
    recordFields: value.recordFields as string[],
  };
}

export const semanticSurfaceDesignPolicy = [
  'Design the semantic layout, style and human copy of this consumer app. The host compiles its controls from the supplied validated business fields and actions.',
  'Return ONLY JSON with exactly these required keys: {"schemaVersion":1,"sectionOrder":["summary","records","composer"],"layout":{"fields":"paired-short","records":"cards"},"headings":{"records":"...","composer":"..."},"fieldLabels":{},"recordFields":[]}.',
  'sectionOrder is any permutation containing summary, records and composer exactly once. Choose field layout paired-short or stacked; records style cards or compact. Layout is a phone-width single column, never a desktop table.',
  'Use intention-specific labels in the same language as the user. headings are required. fieldLabels is an optional map of label overrides, keyed ONLY by exact supplied slot names; an empty map keeps the already model-designed business labels. It never adds, removes or disables any control. Action labels and operation verbs are fixed by the verified action contract; do not output actionLabels or rename an operation.',
  'All labels are plain human text of 1-18 characters (field labels at least 2); no digits, values, dates, percentages, markup, bindings, internal jargon or claims of success. Do not repeat the app name. Action labels are taken directly from the supplied action purpose and cannot be changed here.',
  'recordFields is an ordered subset of supplied persistedStateFields names to display beside each real entity. These values are local preferences/targets, not external service facts. Unknown/null remains Not set; never invent a value.',
  'Do NOT output components, component IDs, field declarations, options, paths, events, contexts, entity identity or executable code. The host always exposes every real typed business field exactly once, every action, real entity title/detail, result and computed stats. Per-item actions use exact host-selected row identity and consumed slots. Your design cannot replace these requirements.',
].join('\n');

/** Pure primary-path compiler; no inference, service access, data values or fallback. */
export function compileSemanticSurface(raw: unknown, contract: SurfaceContract): {design: SemanticSurfaceDesign; components: Array<Record<string, any>>} {
  assertSurfaceContract(contract);
  const design = validateSemanticSurfaceDesign(raw, contract);
  const fields = contract.businessFields;
  const actions = contract.actions;
  const rows = rowActionSlotMap(actions, fields.map(field => field.name));
  const components: Array<Record<string, any>> = [];
  const add = (id: string, component: string, props: Record<string, unknown> = {}) => { components.push({id, component, ...props}); return id; };
  const button = (action: SurfaceAction, index: number, perItem: boolean, primary = false) => {
    const id = `action_${index}`;
    const text = add(`${id}_label`, 'Text', {text: action.label});
    const name = action.actionId.replace(/^actions\./, '');
    const context = Object.fromEntries((rows[name] ?? []).map(slot => [slot, {path: `/draft/slots/${slot}`} ]));
    return add(id, 'Button', {child: text, variant: primary ? 'primary' : 'default', action: {event: {name: `actions.${name}`, ...(perItem ? {context} : {})}}});
  };
  const hero = add('hero', 'StatBlock', {label: {path: '/draft/statLabel'}, value: {path: '/draft/statValue'}});
  const stats = add('stats', 'StatGrid', {path: '/stats'});
  add('summary', 'Column', {children: [hero, stats]});
  const title = add('item_title', 'Text', {text: {path: 'title'}, variant: 'h3'});
  const detail = add('item_detail', 'Text', {text: {path: 'detail'}, variant: 'caption'});
  const badge = add('item_group', 'Badge', {text: {path: 'tag'}});
  const itemChildren = [title, detail, badge];
  design.recordFields.forEach((name, index) => {
    itemChildren.push(add(`local_${index}_label`, 'Text', {text: contract.persistedStateFields.find(field => field.name === name)!.label, variant: 'caption'}));
    itemChildren.push(add(`local_${index}_value`, 'Text', {text: {path: `appState/${name}`}, variant: 'body'}));
  });
  // Separate rows keep three legitimate item actions usable at phone width.
  actions.forEach((action, index) => { if (action.perItem === true) itemChildren.push(button(action, index, true)); });
  const body = add('item_body', 'Column', {children: itemChildren});
  const item = design.layout.records === 'cards' ? add('item', 'Card', {child: body}) : body;
  const list = add('items', 'List', {children: {componentId: item, path: '/entities'}});
  const listHeading = add('records_heading', 'SectionHeading', {title: design.headings.records});
  add('records', 'Column', {children: [listHeading, list]});
  const result = add('result', 'Text', {text: {path: '/draft/result'}, variant: 'body'});
  const composerHeading = add('composer_heading', 'SectionHeading', {title: design.headings.composer});
  const fieldRows: string[] = [];
  let pair: string[] = [];
  const flush = () => { if (pair.length) { fieldRows.push(add(`field_row_${fieldRows.length}`, 'Row', {children: pair})); pair = []; } };
  fields.forEach((field, index) => {
    const variant = ({date: 'date', select: 'choice', boolean: 'toggle', number: 'stepper', text: 'longText', string: 'shortText'} as const)[field.type ?? 'string'];
    if (!variant) throw Error('Unknown business field type');
    // Options and required stay in the host business contract; the existing validator injects options.
    const id = add(`field_${index}`, 'TextField', {label: design.fieldLabels[field.name] ?? field.label, value: {path: `/draft/slots/${field.name}`}, variant});
    if (design.layout.fields === 'paired-short' && ['shortText', 'date', 'stepper'].includes(variant)) {
      pair.push(id); if (pair.length === 2) flush();
    } else { flush(); fieldRows.push(id); }
  });
  flush();
  const composerButtons: string[] = [];
  actions.forEach((action, index) => { if (action.perItem !== true) composerButtons.push(button(action, index, false, composerButtons.length === 0)); });
  // Each button occupies its own ordinary vertical row; long labels never require a wide toolbar.
  add('composer', 'Column', {children: [composerHeading, ...fieldRows, ...composerButtons]});
  components.unshift({id: 'overview', component: 'Column', children: [...design.sectionOrder, result]});
  return {design, components};
}
