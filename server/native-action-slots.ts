import {opaqueIdentity} from './opaque-identity.js';
const reserved = new Set(['entityName', 'entityId', 'sourceComponentId', '__proto__', 'prototype', 'constructor']);

export function requireConsumedSlots(raw: unknown, known?: Iterable<string>): string[] {
  if (!Array.isArray(raw)) throw Error('perItem action consumedSlots must be an explicit array');
  const names = known ? new Set(known) : undefined;
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      || reserved.has(value) || (names && !names.has(value)) || seen.has(value)) {
      throw Error('Invalid, duplicate or unknown consumed slot');
    }
    seen.add(value);
  }
  return [...seen];
}

// Resolve against the final normalized slot order once; never infer from required.
export function consumedSlotsFromIndices(raw: unknown, names: string[]): string[] {
  if (new Set(names).size !== names.length) throw Error('Business slot normalized names collide');
  if (!Array.isArray(raw)) throw Error('perItem action consumedSlotIndices must be an explicit array (empty for identity-only)');
  const seen = new Set<number>();
  for (const value of raw) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= names.length || seen.has(value)) {
      throw Error('Invalid, duplicate or out-of-range consumedSlotIndices');
    }
    seen.add(value);
  }
  return requireConsumedSlots([...seen].map(index => names[index]), names);
}

export function rowActionSlotMap(
  actions: Array<{actionId: string; perItem?: boolean; consumedSlots?: unknown}>,
  slots: Iterable<string>,
): Record<string, string[]> {
  const rows = actions.filter(action => action.perItem === true);
  if (rows.length > 3) throw Error('At most three distinct perItem actions are supported');
  const result: Record<string, string[]> = {};
  for (const action of rows) {
    const id = action.actionId.replace(/^actions\./, '');
    if (reserved.has(id) || !/^[A-Za-z0-9_.-]+$/.test(id)) throw Error('Invalid perItem action id');
    if (Object.hasOwn(result, id)) throw Error('Duplicate perItem action');
    result[id] = requireConsumedSlots(action.consumedSlots, slots);
  }
  return result;
}

export function assertExactRowBindings(bindings: Record<string, unknown>, consumed: string[]) {
  const actual = Object.keys(bindings);
  if (actual.length !== consumed.length || actual.some(name => !consumed.includes(name))) {
    throw Error('Row context must contain exactly its declared consumedSlots; optional editable values must not be omitted');
  }
}

// Routing validation never grants a tool permission or invents an input value.
// Targets and surface must come from the already owner/app-authorized stored app.
export function assertRowActionPayload(
  action: {perItem?: boolean; consumedSlots?: unknown}, payload: Record<string, unknown>, known: string[],
  targets: Array<{entityName: string; entityId: string}>, surface: any, actionId: string,
) {
  if (action.perItem !== true) return;
  const consumed = requireConsumedSlots(action.consumedSlots, known);
  const expected = ['entityName', 'entityId', 'sourceComponentId', ...consumed];
  if (Object.keys(payload).length !== expected.length || expected.some(key => !Object.hasOwn(payload, key))
    || Object.keys(payload).some(key => !expected.includes(key))) {
    throw Error('Row action payload must contain exactly identity, sourceComponentId and declared consumedSlots');
  }
  if (typeof payload.entityName !== 'string' || !payload.entityName
    || typeof payload.entityId !== 'string' || typeof payload.sourceComponentId !== 'string') {
    throw Error('Row action needs explicit current entity identity and source');
  }
  opaqueIdentity(payload.entityId);
  for (const target of targets) opaqueIdentity(target.entityId);
  for (const name of consumed) {
    const value = payload[name];
    if ((value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      || (typeof value === 'number' && !Number.isFinite(value))) {
      throw Error('Row slot value must be a scalar or null');
    }
  }
  if (targets.filter(row => row.entityName === payload.entityName && row.entityId === payload.entityId).length !== 1) {
    throw Error('Row target is not a unique current owner/app entity');
  }
  const components = new Map<string, any>((surface?.messages ?? [])
    .flatMap((message: any) => message.updateComponents?.components ?? [])
    .map((node: any) => [node.id, node]));
  const scoped = new Set<string>();
  const visit = (id: string) => {
    if (scoped.has(id)) return;
    scoped.add(id);
    const node = components.get(id);
    if (node?.child) visit(node.child);
    if (Array.isArray(node?.children)) node.children.forEach(visit);
  };
  for (const node of components.values()) {
    if (node.component === 'List' && node.children?.path === '/entities') visit(node.children.componentId);
  }
  const node = components.get(String(payload.sourceComponentId));
  const event = node?.action?.event;
  if (!scoped.has(String(payload.sourceComponentId)) || node?.component !== 'Button' || event?.name !== `actions.${actionId}`) {
    throw Error('Row action source does not match its current entity-bound action');
  }
  const context = event.context;
  if (!context || Object.keys(context).length !== consumed.length + 2
    || context.entityName?.path !== '/entityName' || context.entityId?.path !== '/id'
    || consumed.some(name => context[name]?.path !== `/draft/slots/${name}`)) {
    throw Error('Row action source bindings disagree with consumedSlots');
  }
}

export type ConsumedGroundingField={label:string;value:string;valueState?:'empty_string'|'null'};
/** Present empty/null is a submitted value, not an absent slot or an inferred
 * instruction. Identity-only row actions never inherit unrelated composer data. */
export function consumedGroundingFields(raw:unknown,payload:Record<string,unknown>,fields:Array<{name:string;label:string}>):ConsumedGroundingField[]{
 const consumed=requireConsumedSlots(raw,fields.map(field=>field.name));
 return consumed.map(name=>{
  if(!Object.hasOwn(payload,name))throw Error('Consumed grounding slot is absent');
  const value=payload[name];const field=fields.find(field=>field.name===name)!;
  if(value===null)return{label:field.label,value:'',valueState:'null'};
  if(typeof value==='string')return{label:field.label,value,...(value===''?{valueState:'empty_string' as const}:{})};
  if(typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return{label:field.label,value:String(value)};
  throw Error('Consumed grounding slot must be a present scalar or null');
 });
}
