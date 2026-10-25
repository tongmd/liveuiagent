import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveUIRuntime } from '../server/liveuiagent.js';

function setup(t: any, includeShared = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-canvas-owner-'));
  const db = new Database(':memory:');
  const old = process.env.APPWORLD_ENABLED; process.env.APPWORLD_ENABLED = 'false';
  const runtime = createLiveUIRuntime(db, { registryRoot: path.join(root, 'apps'), projectRoot: process.cwd() });
  if (old === undefined) delete process.env.APPWORLD_ENABLED; else process.env.APPWORLD_ENABLED = old;
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const app = db.prepare(`INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,? ,?,'{}','{}','1.0.0',?)`);
  const rows: Array<[string,string]> = [['alice-app', 'alice'], ['bob-app', 'bob']];
  if (includeShared) rows.push(['shared-app', '']);
  for (const [id, owner] of rows) app.run(id, id, id, JSON.stringify({ manifest: { name: id } }), owner);
  const nodes = rows.map(([id], n) => ({ id: `node_${id}`, type: 'app_card', appId: id, position: { x: n * 180, y: 72 }, size: { width: 104, height: 124 }, status: 'ready' }));
  const edge = (id: string, from: string, to: string) => ({ id, type: 'app_connection', sourceAppId: from, targetAppId: to, label: 'private edge', prompt: 'private prompt', status: 'active', permissionsRequired: [], createdAt: '2026-01-01T00:00:00Z' });
  const edges = includeShared ? [edge('alice-shared', 'alice-app', 'shared-app'), edge('bob-shared', 'bob-app', 'shared-app'), edge('cross-owner', 'alice-app', 'bob-app')] : [edge('cross-owner', 'alice-app', 'bob-app')];
  const canvas = { canvasId: 'home', selectedNodeId: 'node_bob-app', nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, inputDock: { position: 'bottom', placeholder: 'Ask' } };
  db.prepare('UPDATE canvas_states SET state_json=? WHERE canvas_id=?').run(JSON.stringify(canvas), 'home');
  const stored = () => JSON.parse((db.prepare('SELECT state_json FROM canvas_states WHERE canvas_id=?').get('home') as any).state_json);
  return { db, runtime, stored };
}

test('two owners can move their own and shared tiles without exposing another owner or deleting global tiles', async t => {
  const { runtime, stored } = setup(t);
  const before = stored();
  await assert.rejects(runtime.patchCanvas({ canvasId: 'home', nodeId: 'node_bob-app', position: { x: 400, y: 500 }, user: 'alice' }), (e: any) => e.status === 404);
  assert.deepEqual(stored(), before, 'foreign move must perform no global write');
  const alice = await runtime.patchCanvas({ canvasId: 'home', nodeId: 'node_alice-app', position: { x: 400, y: 500 }, user: 'alice' });
  assert.deepEqual(alice.canvasState.nodes.map(n => n.appId), ['alice-app', 'shared-app']);
  assert.deepEqual(alice.canvasState.edges.map(e => e.id), ['alice-shared']);
  assert.equal(alice.canvasState.selectedNodeId, 'node_alice-app');
  assert.equal(stored().nodes.length, 3, 'filtered response must not replace global canvas');
  assert.deepEqual(stored().nodes.find((n: any) => n.appId === 'bob-app').position, before.nodes[1].position);
  const bob = await runtime.patchCanvas({ canvasId: 'home', nodeId: 'node_shared-app', position: { x: 99, y: 88 }, user: 'bob' });
  assert.deepEqual(bob.canvasState.nodes.map(n => n.appId), ['bob-app', 'shared-app']);
  assert.deepEqual(bob.canvasState.edges.map(e => e.id), ['bob-shared']);
  assert.deepEqual(bob.canvasState.nodes.find(n => n.appId === 'shared-app')?.position, { x: 99, y: 88 });
});

test('query-state hides other owners, dangling edges, and selected IDs without rewriting their canvas', async t => {
  const { runtime, stored } = setup(t, false);
  const before = stored();
  const result = await runtime.queryState({ user: 'charlie' });
  assert.deepEqual(result.apps, []); assert.deepEqual(result.canvasState.nodes, []); assert.deepEqual(result.canvasState.edges, []);
  assert.equal(result.canvasState.selectedNodeId, undefined);
  assert.deepEqual(stored(), before);
});

test('deleting an owned app returns only remaining visible/shared tiles while another owner retains its node', async t => {
  const { runtime, stored, db } = setup(t);
  const removed = await runtime.removeApp({ appId: 'alice-app', user: 'alice' });
  assert.deepEqual(removed.canvasState.nodes.map(n => n.appId), ['shared-app']);
  assert.deepEqual(removed.canvasState.edges, []); assert.equal(removed.canvasState.selectedNodeId, undefined);
  assert.equal(stored().nodes.some((n: any) => n.appId === 'bob-app'), true);
  assert.equal((db.prepare('SELECT owner FROM agent_apps WHERE app_id=?').get('bob-app') as any).owner, 'bob');
});
