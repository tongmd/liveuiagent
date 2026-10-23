import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createAppWorldBridge } from '../server/appworld-bridge.js';

async function main() {
  fs.mkdirSync('.test-runs', { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.resolve('.test-runs/appworld-'));
  let apiBase = 'http://127.0.0.1';


  const openapi = {
    openapi: '3.1.0',
    paths: {
      '/notes': {
        post: {
          operationId: 'create_note_notes_post',
          summary: 'Create note',
          description: 'Create a note in the remote AppWorld app',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
    },
  };

  const snapshots: Record<string, string> = {
    '/dbs': JSON.stringify({ simple_note: '/tmp/appworld/simple_note.db' }),
    '/api_docs/app_descriptions': JSON.stringify([
      { name: 'api_docs', description: 'API documentation app' },
      { name: 'simple_note', description: 'Simple note app' },
    ]),
    '/simple_note/openapi.json': JSON.stringify(openapi),
    '/notes': JSON.stringify({ ok: true }),
    '/dbs/save': JSON.stringify({ message: 'saved' }),
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', apiBase);
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk) => bodyChunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const key = url.pathname;
      if (req.method === 'POST' && key === '/simple_note/notes') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true, body: Buffer.concat(bodyChunks).toString('utf8') }));
        return;
      }
      const value = snapshots[key];
      if (!value) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(value);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const previousApiBase = process.env.APPWORLD_API_BASE;
  const previousGrounding = process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
  process.env.APPWORLD_API_BASE = apiBase;
  process.env.LIVEUIAGENT_APPWORLD_GROUNDING = 'on';
  fs.writeFileSync(path.join(tmpRoot, 'liveuiagent.config.json'), JSON.stringify({
    appworld: {
      enabled: true,
      apiBase,
      snapshotRoot: './snapshots',
      exposeAllTools: true,
      apps: ['simple_note'],
      timeoutMs: 2000,
    },
    gui_debug_policy: {
      mode: 'workflow_first',
      fix_scope: 'generation_pipeline',
      forbidden: [],
      required_fix_path: [],
      acceptance: [],
    },
  }, null, 2));

  try {
    const bridge = createAppWorldBridge(tmpRoot);
    assert(bridge, 'bridge should be created');
    const tools = await bridge!.getCapabilities();
    assert(tools.some((tool) => tool.id === 'tool.appworld.simple_note.create_note_notes_post'), 'discovered AppWorld tool missing');
    const result = await bridge!.callTool('tool.appworld.simple_note.create_note_notes_post', { text: 'hello' });
    assert.equal((result.response as any).created, true, 'AppWorld tool did not execute');
    assert(result.dbChanges, 'db change summary missing');
    assert(Array.isArray(result.dbChanges?.changedApps), 'db change summary must have changed apps');
  } finally {
    if (previousApiBase === undefined) delete process.env.APPWORLD_API_BASE;
    else process.env.APPWORLD_API_BASE = previousApiBase;
    if (previousGrounding === undefined) delete process.env.LIVEUIAGENT_APPWORLD_GROUNDING;
    else process.env.LIVEUIAGENT_APPWORLD_GROUNDING = previousGrounding;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    console.log(`AppWorld bridge mock passed; retained scratch: ${path.relative(process.cwd(), tmpRoot)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
