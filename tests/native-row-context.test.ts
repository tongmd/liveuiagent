import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRowSlotContext} from '../server/native-row-context.js';

test('row slots require explicit exact known bindings and leave identity-only actions empty', () => {
  assert.deepEqual(nativeRowSlotContext(undefined, ['folder', 'amount']), {});
  assert.deepEqual(nativeRowSlotContext({folder: {path: '/draft/slots/folder'}}, ['folder', 'amount']), {folder: {path: '/draft/slots/folder'}});
});
test('row slots reject identity overrides, unknown, prototype, literals and nested descriptors', () => {
  for (const raw of [null, [], {unknown: {path: '/draft/slots/unknown'}}, {entityId: {path: '/draft/slots/entityId'}}, {sourceComponentId: {path: '/draft/slots/sourceComponentId'}}, JSON.parse('{"__proto__":{"path":"/draft/slots/__proto__"}}'), {folder: 'New folder'}, {folder: {path: '/draft/slots/amount'}}, {folder: {path: '/draft/slots/folder', extra: {}}}, {folder: {path: '/entities/0/name'}}]) {
    assert.throws(() => nativeRowSlotContext(raw, ['folder', 'amount', 'entityId', 'sourceComponentId', '__proto__']));
  }
});
