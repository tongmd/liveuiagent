type DisplayField = {name: string; type?: string; hiddenInForm?: boolean};
const internal = new Set(['id','app_id','appId','owner','recordId','appRecordId','revision','updatedAt','prompt','context','state','nextStep','result','__proto__','prototype','constructor']);
export function stateDisplayFields(fields: DisplayField[]) {
  return fields.filter(field => field && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) && !field.hiddenInForm && !internal.has(field.name)
    && !/password|credential|secret|token|api_?key|authorization/i.test(field.name)
    && ['string','text','select','date','number','boolean'].includes(field.type || 'string'));
}
export function stateDisplayPaths(fields: DisplayField[]) {
  return new Set(stateDisplayFields(fields).flatMap(field => [`appState/${field.name}`, `/appState/${field.name}`]));
}
// Display-only projection. Missing local metadata is unknown, never an invented
// zero or business result. The real SQLite values and execution evidence stay intact.
export function stateDisplayValues(fields: DisplayField[], values: unknown): Record<string, string | number | boolean> {
  const source = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {};
  return Object.fromEntries(stateDisplayFields(fields).map(field => {
    const value = Object.hasOwn(source, field.name) ? source[field.name] : undefined;
    const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string';
    return [field.name, valid ? value as string | number | boolean : 'Not set'];
  }));
}
