import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDelivery } from '../delivery.mjs';

async function fixture(t, script = 'let count = 0;') {
  const work = await mkdtemp(path.join(tmpdir(), 'liveui-delivery-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(path.join(work, 'index.html'), `<html><body>${' '.repeat(1100)}<script>${script}</script></body></html>`);
  await writeFile(path.join(work, 'app.json'), JSON.stringify({ name: 'Counter' }));
  return work;
}
test('validates delivered files without executing application JS', async t => {
  const work = await fixture(t, 'throw new Error("Must not execute");');
  const result = await validateDelivery(work);
  assert.equal(result.ok, true);
  assert.equal(result.meta.name, 'Counter');
});
test('missing metadata and unfinished HTML remain incomplete', async t => {
  const work = await fixture(t);
  await rm(path.join(work, 'app.json'));
  await writeFile(path.join(work, 'index.html'), '<html><body><script>let x =');
  const result = await validateDelivery(work);
  assert.equal(result.ok, false);
  assert(result.errors.some(e => e.code === 'metadata_missing_or_invalid'));
  assert(result.errors.some(e => e.code === 'html_incomplete'));
});
test('invalid executable JS is rejected but JSON data script is not treated as JS', async t => {
  const work = await fixture(t, 'const count = ;');
  const invalid = await validateDelivery(work);
  assert(invalid.errors.some(e => e.code === 'script_syntax'));
  await writeFile(path.join(work, 'index.html'), `<html><body>${' '.repeat(1100)}<script type="application/ld+json">{"name":"App"}</script><script type="module">export const count = 1;</script></body></html>`);
  assert.equal((await validateDelivery(work)).ok, true);
});
test('symlinked delivery is rejected', async t => {
  const work = await fixture(t);
  await rm(path.join(work, 'app.json'));
  await symlink(path.join(work, 'index.html'), path.join(work, 'app.json'));
  assert.equal((await validateDelivery(work)).ok, false);
});
