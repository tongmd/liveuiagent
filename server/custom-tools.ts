// Command-line desk plugins: every *.json file in the plugins dir declares ONE new
// desk tool whose implementation is an arbitrary command line. 加新工具 = 放一个
// JSON 文件(或用 scripts/desk-tool.mjs add),每个 desk 回合重新读目录 —— 不用改代码、
// 不用重启,数量不限。
//
// Spec file shape (desk-plugins/<apiName>.json):
//   {
//     "apiName":  "stock_price",              // ^[a-z][a-z0-9_]{1,63}$, must be unique
//     "purpose":  "Get the live stock price for a ticker symbol.",
//     "argsHint": "ticker*",                  // catalog args line, * marks required
//     "command":  ["python3", "tools/stock.py", "{ticker}"],
//     "timeoutMs": 15000                      // optional, 1s..120s
//   }
//
// Invocation protocol: `{name}` placeholders in argv are substituted with the agent's
// arg values (one argv element each — no shell, so no shell injection), AND the full
// args object is written to the child's stdin as JSON. The command prints its result
// to stdout: JSON object if it can, plain text otherwise. Non-zero exit / timeout
// becomes {ok:false,error} — loop data the agent can react to, not a crash.
//
// Trust model: the plugins DIR is owner-trusted server config (whoever can write it
// already owns the box). The ARGS are agent/model-chosen and untrusted — scripts must
// validate them; placeholder substitution never passes through a shell.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DeskToolSpec, DeskToolContext } from './desk-tools.js';

const API_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_OUTPUT_CHARS = 200_000; // raw capture cap
const MAX_RESULT_CHARS = 6_000;   // what actually enters the agent loop
const DEFAULT_TIMEOUT_MS = 15_000;

type CustomSpecFile = {
  apiName: string;
  purpose: string;
  argsHint?: string;
  command: string[];
  timeoutMs?: number;
};

export function customDeskToolsDir(): string {
  return process.env.LIVEUIAGENT_DESK_TOOLS_DIR || path.join(process.cwd(), 'desk-plugins');
}

function specError(file: string, message: string): Error {
  // 坏的插件文件必须炸得指名道姓,而不是被静默跳过 —— 否则"工具没生效"毫无线索。
  return new Error(`desk plugin ${file}: ${message}`);
}

function parseSpecFile(dir: string, file: string, takenNames: Set<string>): CustomSpecFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (error) {
    throw specError(file, `invalid JSON (${(error as Error).message})`);
  }
  const spec = raw as Record<string, unknown>;
  const apiName = String(spec.apiName || '');
  if (!API_NAME_RE.test(apiName)) throw specError(file, `apiName must match ${API_NAME_RE}`);
  if (takenNames.has(apiName)) throw specError(file, `apiName "${apiName}" already taken by a builtin or another plugin`);
  const purpose = String(spec.purpose || '').trim();
  if (!purpose || purpose.length > 300) throw specError(file, 'purpose must be a non-empty string of at most 300 chars');
  const command = spec.command;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === 'string' && part.length)) {
    throw specError(file, 'command must be a non-empty array of non-empty strings');
  }
  const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(spec.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw specError(file, 'timeoutMs must be between 1000 and 120000');
  }
  return { apiName, purpose, argsHint: String(spec.argsHint ?? '').trim(), command: command as string[], timeoutMs };
}

function substituteArgv(command: string[], args: Record<string, unknown>): string[] {
  return command.map((part) =>
    part.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => (args[key] === undefined || args[key] === null ? '' : String(args[key]))));
}

function runCommandTool(spec: CustomSpecFile, args: Record<string, unknown>, ctx: DeskToolContext): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const argv = substituteArgv(spec.command, args);
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LIVEUIAGENT_USER: ctx.user, LIVEUIAGENT_SELECTED_APP: ctx.selectedAppId ?? '' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `${spec.apiName} timed out after ${spec.timeoutMs}ms` });
    }, spec.timeoutMs);
    child.on('error', (error) => finish({ ok: false, error: `${spec.apiName} failed to start: ${error.message}` }));
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    // 有的命令(如 curl)根本不读 stdin,写入会 EPIPE —— 吞掉写入错误,协议照旧。
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(args ?? {}));
    child.stdin.end();
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: `${spec.apiName} exited ${code}: ${(stderr || stdout).trim().slice(0, 500)}` });
        return;
      }
      const text = stdout.trim().slice(0, MAX_RESULT_CHARS);
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finish({ ok: true, ...(parsed as Record<string, unknown>) });
          return;
        }
      } catch { /* plain-text output is fine */ }
      finish({ ok: true, output: text });
    });
  });
}

// Read the plugins dir and materialise every spec as a DeskToolSpec. Called once per
// desk turn (a handful of tiny files — hot reload beats caching here). A missing dir
// simply means "no custom tools"; a BROKEN spec file throws with its filename.
export function loadCustomDeskTools(builtinNames: string[]): DeskToolSpec[] {
  const dir = customDeskToolsDir();
  if (!fs.existsSync(dir)) return [];
  const takenNames = new Set(builtinNames);
  const tools: DeskToolSpec[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const spec = parseSpecFile(dir, file, takenNames);
    takenNames.add(spec.apiName);
    tools.push({
      id: `tool.custom.${spec.apiName}`,
      apiName: spec.apiName,
      label: `Custom Tool (${spec.apiName})`,
      purpose: spec.purpose,
      argsHint: spec.argsHint || '(none)',
      invoke: (args, ctx) => runCommandTool(spec, args as Record<string, unknown>, ctx),
    });
  }
  return tools;
}
