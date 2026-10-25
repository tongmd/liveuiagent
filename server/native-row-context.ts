const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'entityName', 'entityId', 'appRecordId', 'sourceComponentId']);

// Designer-authored row inputs are explicit references to existing composer slots.
// Entity identity is issued separately by the host and cannot be overridden here.
export function nativeRowSlotContext(raw: unknown, slots: Iterable<string>): Record<string, {path: string}> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('row action context must be an object of known slot bindings');
  const known = new Set(slots);
  const result: Record<string, {path: string}> = {};
  for (const [key, descriptor] of Object.entries(raw)) {
    if (forbidden.has(key) || !known.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`row action context key "${key}" is not an allowed business slot`);
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || Object.keys(descriptor).length !== 1
      || !Object.hasOwn(descriptor, 'path') || (descriptor as any).path !== `/draft/slots/${key}`) {
      throw new Error(`row action slot "${key}" must bind exactly /draft/slots/${key}`);
    }
    result[key] = {path: `/draft/slots/${key}`};
  }
  return result;
}
