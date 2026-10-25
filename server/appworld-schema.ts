import type { AppWorldToolCapability } from './appworld-bridge.js';
type Schema = Record<string, any>;
export function resolveApiSchema(value: any, doc: Schema, seen = new Set<string>()): any {
  if (Array.isArray(value)) return value.map(item => resolveApiSchema(item, doc, seen));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const ref = String(value.$ref);
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error(`Unsupported AppWorld schema reference: ${ref}`);
    const target = ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    if (!target) throw new Error(`Missing AppWorld schema reference: ${ref}`);
    const next = new Set(seen); next.add(ref);
    return resolveApiSchema({...target, ...Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$ref'))}, doc, next);
  }
  const resolved = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveApiSchema(v, doc, seen)]));
  if (resolved.allOf) {
    const properties: Schema = {...resolved.properties};
    const required = new Set<string>(resolved.required || []);
    for (const branch of resolved.allOf) {
      for (const [key, schema] of Object.entries(branch.properties || {})) {
        if (Object.hasOwn(properties, key) && JSON.stringify(properties[key]) !== JSON.stringify(schema)) throw new Error(`Conflicting AppWorld allOf property: ${key}`);
        properties[key] = schema;
      }
      for (const key of branch.required || []) required.add(key);
    }
    if (Object.keys(properties).length) { resolved.properties = properties; resolved.required = [...required]; }
  }
  return resolved;
}
export function validateApiValue(value: any, schema: Schema, label: string): void {
  const fail = () => { throw new Error(`Invalid AppWorld argument ${label}`); };
  if (schema.anyOf || schema.oneOf) {
    const matches = (schema.anyOf || schema.oneOf).filter((s: Schema) => { try { validateApiValue(value, s, label); return true; } catch { return false; } });
    if (!matches.length || (schema.oneOf && matches.length !== 1)) fail();
  }
  for (const s of schema.allOf || []) validateApiValue(value, s, label);
  if (value === null && schema.nullable) return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((t: string) => t === 'null' ? value === null : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t)) fail();
  if (schema.enum && !schema.enum.some((v: any) => JSON.stringify(v) === JSON.stringify(value))) fail();
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail();
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) fail();
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail();
    if (schema.items) value.forEach((v, i) => validateApiValue(v, schema.items, `${label}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (value[k] === undefined) throw new Error(`Missing AppWorld argument ${label}.${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validateApiValue(v, schema.properties[k], `${label}.${k}`);
      else if (schema.additionalProperties === false) throw new Error(`Unknown AppWorld argument ${label}.${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateApiValue(v, schema.additionalProperties, `${label}.${k}`);
    }
  }
}
export function appWorldCatalogLine(tool: AppWorldToolCapability): string {
  const schema = tool.inputSchema as Schema | undefined;
  const required = new Set([...(schema?.required || []), ...(tool.requiredParams || [])]);
  const names = [...new Set([...required, ...Object.keys(schema?.properties || {})])];
  const args = names.map(name => `${name}${required.has(name) ? '*' : ''}: ${JSON.stringify(schema?.properties?.[name] || {})}`);
  return `- ${tool.apiName} [${tool.method}]: ${tool.purpose.replace(/\s+/g, ' ').slice(0, 140)} args(*=required): ${args.join(', ') || 'none'}`;
}
