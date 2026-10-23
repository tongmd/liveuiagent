import { createHash } from 'node:crypto';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Validate every source before copying any file, including scripts/styles that
// the preserved HTML loads separately. Filenames must remain inside the bundle.
export async function verifyFrontendSnapshot(snapshotDirectory = path.join(root, 'frontend/snapshot')) {
  const manifest = JSON.parse(await readFile(path.join(snapshotDirectory, 'manifest.json'), 'utf8'));
  if (![1, 2].includes(manifest.formatVersion)) throw new Error('Unsupported frontend snapshot manifest format');
  const entries = manifest.formatVersion === 1
    ? [{ file: manifest.file, sha256: manifest.sha256 }]
    : manifest.resources;
  if (!Array.isArray(entries) || !entries.length) throw new Error('Frontend snapshot manifest has no resources');
  const names = new Set();
  const resources = [];
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.file)
      || entry.file === 'manifest.json' || names.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Invalid or duplicate frontend snapshot resource');
    }
    names.add(entry.file);
    const source = path.join(snapshotDirectory, entry.file);
    const bytes = await readFile(source);
    if (hash(bytes) !== entry.sha256 || (entry.bytes !== undefined && entry.bytes !== bytes.length)) {
      throw new Error(`Frontend snapshot hash mismatch: ${entry.file}; review the source before updating its manifest.`);
    }
    resources.push({ ...entry, source });
  }
  const html = resources.find((entry) => entry.file === 'index.html');
  if (!html || manifest.file !== html.file || manifest.sha256 !== html.sha256) {
    throw new Error('Frontend entry point does not match the resource manifest');
  }
  return { manifest, resources };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { resources } = await verifyFrontendSnapshot();
  if (process.argv.includes('--check')) {
    console.log(`Frontend snapshot verified: ${resources.length} resources`);
  } else {
    await mkdir(path.join(root, 'dist'), { recursive: true });
    for (const resource of resources) {
      const target = path.join(root, 'dist', resource.file);
      await copyFile(resource.source, target);
      if (hash(await readFile(target)) !== resource.sha256) throw new Error(`Copied frontend hash mismatch: ${resource.file}`);
    }
    console.log(`Frontend copied and verified: ${resources.length} resources`);
  }
}
