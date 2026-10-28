import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Synthetic local input for the isolated browser check, never production data. */
export function validateVerificationInput(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['filename', 'content'].includes(key))
    || typeof value.filename !== 'string' || value.filename.length > 128
    || !/^[^/\\\u0000-\u001f]+\.(txt|csv)$/i.test(value.filename)
    || typeof value.content !== 'string' || !value.content.trim()
    || Buffer.byteLength(value.content, 'utf8') > 16384) {
    throw new Error('verificationInput must contain only filename (.txt or .csv, no path) and nonempty synthetic content up to 16KB');
  }
  return { filename: value.filename, content: value.content };
}

async function readOutput(work, name, limit) {
  const file = path.join(work, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(`${name} is not a regular file within the size limit`);
  return fs.readFile(file, 'utf8');
}
function syntaxCheck(script, module) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', ...(module ? ['--input-type=module'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = '';
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('Syntax check timed out'); }, 5000);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-5000); });
    child.stdin.on('error', () => {});
    child.on('error', error => finish(error.message));
    child.on('close', code => finish(code === 0 ? null : diagnostic || `Syntax check exited ${code}`));
    child.stdin.end(script);
  });
}

/** Validate delivery without executing generated code or modifying the workspace. */
export async function validateDelivery(work) {
  const errors = [];
  let html, meta;
  try { html = await readOutput(work, 'index.html', 3000000); }
  catch (error) { errors.push({ code: 'html_missing_or_invalid', message: error.code === 'ENOENT' ? 'index.html is missing' : error.message }); }
  try {
    meta = JSON.parse(await readOutput(work, 'app.json', 100000));
    if (!meta || Array.isArray(meta) || typeof meta.name !== 'string' || !meta.name.trim()) throw new Error('app.json must contain a nonempty name');
    if (meta.verificationInput !== undefined) meta.verificationInput = validateVerificationInput(meta.verificationInput);
  } catch (error) { errors.push({ code: 'metadata_missing_or_invalid', message: error.code === 'ENOENT' ? 'app.json is missing' : error.message }); }
  if (html !== undefined) {
    if (html.length < 1000 || !/<html[\s>]/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
      errors.push({ code: 'html_incomplete', message: 'index.html must be a complete HTML document of at least 1000 characters' });
    }
    // Raw-text script elements terminate at </script> in HTML, even inside JS strings.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    let checkedScripts = 0;
    for (const [index, match] of scripts.entries()) {
      const attrs = match[1];
      const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const kind = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').toLowerCase();
      if (kind && !['module', 'text/javascript', 'application/javascript'].includes(kind)) continue;
      if (/\bsrc\s*=/i.test(attrs)) { errors.push({ code: 'external_script', message: `Script ${index + 1} uses an external source; deliver a standalone app` }); continue; }
      checkedScripts++;
      const failure = await syntaxCheck(match[2], kind === 'module');
      if (failure) errors.push({ code: 'script_syntax', message: `Script ${index + 1}: ${failure}` });
    }
    if (!checkedScripts) errors.push({ code: 'script_missing', message: 'index.html must contain executable inline JavaScript' });
  }
  return errors.length ? { ok: false, errors } : { ok: true, html, meta, errors: [] };
}
