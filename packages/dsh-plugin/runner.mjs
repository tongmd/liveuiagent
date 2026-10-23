import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { providerPatch } from './model-config.mjs';

const platformEnv = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];

/** Start DSH with explicit argv and a task-owned directory; never run a shell interpolation. */
export function createCommandRunner(config) {
  if (!config || typeof config.command !== 'string' || !config.command.trim()) throw new Error('A DSH runner command is required');
  if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) throw new Error('DSH runner args must be strings');
  const passEnv = config.passEnv ?? ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'];
  if (!Array.isArray(passEnv) || passEnv.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('DSH runner passEnv must contain environment variable names');
  const active = new Set();
  let closed = false;
  return {
    modelSelection: true,
    providerOverride: true,
    modelOnly: false,
    async run({ work, home, task, signal, onEvent, model, provider }) {
      if (closed) throw new Error('DSH runner is closed');
      signal.throwIfAborted();
      const started = Date.now();
      const args = config.args.map(arg => arg.replaceAll('{work}', work).replaceAll('{home}', home));
      const env = Object.fromEntries([...platformEnv, ...passEnv].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
      let patch;
      if(provider){
        patch=path.join(home,'liveui-model.patch.yml');
        const sameProvider=Boolean(process.env.DEEPSEEK_BASE_URL)&&provider.apiBase.replace(/\/+$/,'')===process.env.DEEPSEEK_BASE_URL.replace(/\/+$/,'');
        await fs.writeFile(patch,providerPatch(model,sameProvider),{mode:0o600});
        args.push('--patch',patch);
        env.LIVEUI_LLM_API_BASE=provider.apiBase;
        env.LIVEUI_LLM_API_KEY=provider.apiKey;
      }
      const child = spawn(config.command, args, {
        cwd: work,
        env: { ...env, DSH_HOME: home, TERM: 'dumb' },
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let escalation;
      const kill = force => {
        if (!child.pid) return;
        // Descendants may retain stdout after the group leader has exited.
        if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
        try {
          if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
          else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      const abort = () => {
        kill(false);
        escalation ??= setTimeout(() => kill(true), 1000);
      };
      let buffer = '';
      let diagnostics = '';
      let answer = '';
      let failure;
      const line = value => {
        let event;
        try { event = JSON.parse(value); }
        catch { return; } // Non-JSON dependency diagnostics are not model events.
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
        if (event.type === 'error') failure = new Error('DSH reported a task error');
        if (event.type === 'status' && event.reason?.kind === 'error') failure = new Error(`DSH model request failed (${String(event.reason.error?.code || 'provider_error').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80)})`);
        if (event.type === 'final') answer = String(event.text ?? event.response ?? event.message ?? '');
        onEvent(event);
      };
      const completion = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 4 * 1024 * 1024) { failure = new Error('DSH emitted an oversized event'); abort(); return; }
          let end;
          try {
            while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
          } catch (error) { failure = error; abort(); }
        });
        child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-10000); });
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error; });
        child.on('error', reject);
        child.on('close', code => {
          try {
            if (buffer.trim()) line(buffer);
            if (signal.aborted) throw signal.reason ?? new Error('DSH task cancelled');
            if (failure) throw failure;
            if (code !== 0) throw new Error(`DSH exited with code ${code}`);
            resolve({ elapsedMs: Date.now() - started, diagnostics, answer });
          } catch (error) { reject(error); }
        });
        child.stdin.end(task);
      });
      const entry = { abort, completion };
      active.add(entry);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try { return await completion; }
      finally {
        clearTimeout(escalation);
        kill(true);
        signal.removeEventListener('abort', abort);
        active.delete(entry);
        if(patch)await fs.rm(patch,{force:true});
      }
    },
    async dispose() {
      closed = true;
      const entries = [...active];
      for (const entry of entries) entry.abort();
      await Promise.allSettled(entries.map(entry => entry.completion));
    },
  };
}
