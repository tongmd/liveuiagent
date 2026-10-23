import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Explicit maintainer operation after reviewing changed frontend resources.
const directory = fileURLToPath(new URL('../frontend/snapshot/', import.meta.url));
const filename = path.join(directory, 'manifest.json');
const manifest = JSON.parse(await readFile(filename, 'utf8'));
const names = [...new Set([...manifest.resources.map(entry => entry.file), ...process.argv.slice(2)])];
manifest.resources = [];
for (const file of names) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file === 'manifest.json') throw new Error(`Invalid resource: ${file}`);
  const bytes = await readFile(path.join(directory, file));
  manifest.resources.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
manifest.sha256 = manifest.resources.find(entry => entry.file === manifest.file).sha256;
manifest.modified = new Date().toISOString().slice(0, 10);
manifest.kind = 'maintained-integrated-frontend-with-sidecars';
manifest.provenance = 'Based on the reviewed October 2026 LIVEUIAGENT deployment import; maintained as LiveUIAgent with explicit branding, subpath routing, and editable runtime controls.';
await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${manifest.resources.length} reviewed frontend resources.`);
