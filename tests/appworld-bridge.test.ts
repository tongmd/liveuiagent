import {AppWorldRequestNotStartedError} from '../server/appworld-request-error.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { resolveApiSchema, appWorldCatalogLine } from '../server/appworld-schema.js';
import { createAppWorldBridge } from '../server/appworld-bridge.js';

async function main() {
  fs.mkdirSync('.test-runs', { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.resolve('.test-runs/appworld-'));
  let apiBase = 'http://127.0.0.1';


  const openapi = {
    openapi: '3.1.0',
    components: {schemas: {Note: {type:'object', required:['text'], properties:{text:{type:'string'},sourceComponentId:{type:'string'}}}}},
    paths: {
      '/login': {post:{operationId:'explicit_login',requestBody:{content:{'application/x-www-form-urlencoded':{schema:{type:'object',properties:{username:{type:'string'},password:{type:'string'},scope:{type:'string',default:''}},required:['username','password']}}}},responses:{'200':{description:'ok'}}}},
      '/notes/{note_id}': {
        parameters:[{name:'note_id', in:'path', required:true, schema:{type:'integer'}}],
        patch: {operationId:'update_note', parameters:[{name:'notify', in:'query', schema:{type:'boolean'}}],
          requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Note'}}}}, responses:{'200':{description:'ok'}}},
      },
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

  // Real frozen Spotify search parameters; authentication is outside this mock's scope.
  const spotify = JSON.parse(fs.readFileSync(new URL('./fixtures/spotify-search-openapi.json', import.meta.url), 'utf8'));
  for (const item of Object.values(spotify.paths) as any[]) item.get.security = [{OAuth2:[]}];
  const gmail = JSON.parse(fs.readFileSync(new URL('./fixtures/gmail-reply-openapi.json', import.meta.url), 'utf8'));
  // Keep real protected operation security: credentials come only from host login.
  const secret = 'mock-host-session-secret';
  const authHeaders: unknown[] = [];
  const requests: Array<{url: string; body: string}> = [];
  const snapshots: Record<string, string> = {
    '/dbs': JSON.stringify({ simple_note: '/tmp/appworld/simple_note.db' }),
    '/api_docs/app_descriptions': JSON.stringify([
      { name: 'api_docs', description: 'API documentation app' },
      { name: 'simple_note', description: 'Simple note app' },
      { name: 'spotify', description: 'Spotify mock' },
      { name: 'gmail', description: 'Gmail mock' },
    ]),
    '/simple_note/openapi.json': JSON.stringify(openapi),
    '/spotify/openapi.json': JSON.stringify(spotify),
    '/gmail/openapi.json': JSON.stringify(gmail),
    '/notes': JSON.stringify({ ok: true }),
    '/dbs/save': JSON.stringify({ message: 'saved' }),
  };

  let replyFailureMode: 'none'|'server'|'unauthenticated' = 'none';
  let replyEffects = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', apiBase);
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk) => bodyChunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const key = url.pathname;
      if (key === '/simple_note/login') {
        assert.equal(req.headers['content-type'],'application/x-www-form-urlencoded');
        requests.push({url:url.toString(),body:Buffer.concat(bodyChunks).toString('utf8')});
        res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return;
      }
      if (key.endsWith('/auth/token')) {
        res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({access_token:secret})); return;
      }
      if (key.startsWith('/spotify/spotify/') || key.startsWith('/gmail/gmail/')) authHeaders.push(req.headers.authorization);
      if (key === '/spotify/spotify/songs' || key === '/spotify/spotify/artists') {
        requests.push({url: url.toString(), body: Buffer.concat(bodyChunks).toString('utf8')});
        res.writeHead(200, {'content-type': 'application/json'}); res.end('[]'); return;
      }
      if (req.method === 'POST' && key === '/gmail/gmail/email_threads/8/emails/9/reply') {
        requests.push({url:url.toString(),body:Buffer.concat(bodyChunks).toString('utf8')});
        if (replyFailureMode === 'unauthenticated') { replyFailureMode = 'none'; res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({message:'authentication required'})); return; }
        replyEffects++;
        if (replyFailureMode === 'server') { res.writeHead(503, {'content-type':'application/json'}); res.end(JSON.stringify({message:'token expired after reply side effect'})); return; }
        res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return;
      }
      if (req.method === 'PATCH' && key === '/simple_note/notes/7') {
        requests.push({url:url.toString(),body:Buffer.concat(bodyChunks).toString('utf8')});
        res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return;
      }
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
      apps: ['simple_note', 'spotify', 'gmail'],
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
    const login = tools.find(t => t.apiName === 'explicit_login')!;
    assert(appWorldCatalogLine(login).includes('username*')); assert(appWorldCatalogLine(login).includes('password*'));
    await assert.rejects(bridge!.callTool(login.id, {}), /Missing AppWorld argument/);
    await bridge!.callTool(login.id, {username:'mock+user@example.test',password:'mock & only=credential'});
    assert.equal(new URLSearchParams(requests.at(-1)!.body).get('username'),'mock+user@example.test');
    assert.equal(new URLSearchParams(requests.at(-1)!.body).get('password'),'mock & only=credential');
    assert(!appWorldCatalogLine(login).includes('mock & only=credential'));
    const update = tools.find(t => t.apiName === 'update_note')!;
    assert.deepEqual(new Set(update.requiredParams), new Set(['text','note_id']));
    await assert.rejects(bridge!.callTool(update.id, {note_id:7}), /Missing AppWorld argument/);
    await bridge!.callTool(update.id, {note_id:7, notify:false, text:'updated',sourceComponentId:'declared-business-value'});
    assert.equal(new URL(requests.at(-1)!.url).searchParams.get('notify'), 'false');
    assert.deepEqual(JSON.parse(requests.at(-1)!.body), {text:'updated',sourceComponentId:'declared-business-value'});
    for (const route of ['/spotify/songs', '/spotify/artists']) {
      const tool = tools.find(t => t.path === route)!;
      assert(tool, 'real search tool discovered');
      const schema = tool.inputSchema as any;
      assert.equal(schema.properties.page_limit.maximum, 20);
      assert.equal(schema.properties.page_limit.default, 5);
      assert(!tool.requiredParams!.includes('page_limit'), 'optional pagination stays optional');
      const line = appWorldCatalogLine(tool);
      for (const name of Object.keys(schema.properties)) assert(line.includes(`${name}:`), `catalog must retain ${name}`);
      assert(line.includes('"maximum":20'), 'catalog exposes paging bound');
      const args = {query: 'indie', page_index: 1, page_limit: 20, ...(route.endsWith('songs') ? {artist_id: 36} : {})};
      const observed = await bridge!.callTool(tool.id, {...args, sourceComponentId:'button',toolResults:[]});
      assert(!JSON.stringify(observed).includes(secret));
      assert(!appWorldCatalogLine(tool).includes(secret));
      const sent = new URL(requests.at(-1)!.url);
      for (const [key, value] of Object.entries(args)) assert.equal(sent.searchParams.get(key), String(value));
      assert.equal(requests.at(-1)!.body, '');
      const count = requests.length;
      await assert.rejects(bridge!.callTool(tool.id, {query:'indie', imaginary_filter:true}), /Unknown AppWorld argument/);
      await assert.rejects(bridge!.callTool(tool.id, {page_limit:21}), /Invalid AppWorld argument/);
      await assert.rejects(bridge!.callTool(tool.id, {page_index:-1}), /Invalid AppWorld argument/);
      await assert.rejects(bridge!.callTool(tool.id, {page_limit:'20'}), /Invalid AppWorld argument/);
      assert.equal(requests.length, count, 'invalid requests never reach HTTP');
      await bridge!.callTool(tool.id, {}); // all search params really are optional
    }

    assert(authHeaders.length > 0 && authHeaders.every(header => header === `Bearer ${secret}`));
    const reply = tools.find(t => t.path.endsWith('/reply'))!;
    assert.deepEqual(new Set(reply.requiredParams), new Set(['body','email_thread_id','email_id']));
    assert(appWorldCatalogLine(reply).includes('email_addresses:'));
    assert(appWorldCatalogLine(reply).includes('otherwise, to the sender'));
    const beforeInvalidReply = requests.length;
    await assert.rejects(bridge!.callTool(reply.id, {email_thread_id:8,email_id:9}), (error: unknown) => {
      assert(error instanceof AppWorldRequestNotStartedError);
      assert.match(error.message, /Missing AppWorld argument/);
      assert(error.cause instanceof Error);
      assert.equal(error.message, error.cause.message, 'keep the original local rejection and cause');
      return true;
    });
    assert.equal(requests.length, beforeInvalidReply, 'typed no-request proof never dispatched a business HTTP request');
    await bridge!.callTool(reply.id, {email_thread_id:8,email_id:9,body:'Reply text',email_addresses:['recipient@example.test']});
    assert.deepEqual(JSON.parse(requests.at(-1)!.body), {body:'Reply text',email_addresses:['recipient@example.test']});
    assert.equal(new URL(requests.at(-1)!.url).search, '');
    assert.equal(authHeaders.at(-1), `Bearer ${secret}`);
    assert(!appWorldCatalogLine(reply).includes(secret));
    const beforeFailedReply = requests.length;
    replyFailureMode = 'server';
    await assert.rejects(bridge!.callTool(reply.id, {email_thread_id:8,email_id:9,body:'uncertain reply',email_addresses:['recipient@example.test']}), /503/);
    assert.equal(requests.length, beforeFailedReply + 1, 'a reply failure containing auth words is never replayed inside the bridge');
    replyFailureMode = 'none';
    const beforeUnauthenticatedReply = requests.length, beforeEffects = replyEffects;
    replyFailureMode = 'unauthenticated';
    await bridge!.callTool(reply.id, {email_thread_id:8,email_id:9,body:'valid after auth refresh',email_addresses:['recipient@example.test']});
    assert.equal(requests.length, beforeUnauthenticatedReply + 2, 'actual HTTP401 can refresh once');
    assert.equal(replyEffects, beforeEffects + 1, 'the unauthenticated rejection had no send effect');
    assert.throws(() => resolveApiSchema({$ref:'#/components/schemas/missing'}, {}), /Missing/);
    assert.throws(() => resolveApiSchema({$ref:'https://example.test/schema'}, {}), /Unsupported/);
    assert.throws(() => resolveApiSchema({$ref:'#/self'}, {self:{$ref:'#/self'}}), /Unsupported/);
    const composed = resolveApiSchema({allOf:[{type:'object',properties:{body:{type:'string'}},required:['body']},{properties:{optional:{type:'integer'}}}]}, {});
    assert.deepEqual(composed.required,['body']); assert(composed.properties.optional);
    const conflicting = structuredClone(openapi) as any;
    conflicting.paths['/notes/{note_id}'].patch.parameters.push({name:'text',in:'query',schema:{type:'string'}});
    snapshots['/simple_note/openapi.json'] = JSON.stringify(conflicting);
    const invalidBridge = createAppWorldBridge(tmpRoot)!;
    await assert.rejects(invalidBridge.getCapabilities(), /Ambiguous AppWorld parameter.*text/);
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
