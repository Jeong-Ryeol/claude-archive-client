import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeProbe {
  ok: boolean;
  version: string | null;
  /** 로그인되어 있으면 구독 종류(max/pro…) 또는 true, 안 되어 있으면 false, 확인 못 하면 null */
  login: string | boolean | null;
  path: string;
}

export type RunFn = (bin: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: [stdout, stderr].map((x) => String(x ?? '')).join('\n').trim() });
      },
    );
  });
}

export async function probeClaude(bin: string): Promise<ClaudeProbe> {
  const r: ClaudeProbe = { ok: false, version: null, login: null, path: bin };
  const v = await run(bin, ['--version']);
  const m = v.out.match(/(\d+\.\d+\.\d+)/);
  if (v.code !== 0 || !m) return r;
  r.version = m[1];
  // 옛 버전은 'auth' 하위 명령이 없어 'auth status' 를 프롬프트로 실행해 버린다. 도움말에서 먼저 확인.
  const help = await run(bin, ['--help']);
  if (/^\s+auth\b/m.test(help.out)) {
    const a = await run(bin, ['auth', 'status']);
    try {
      const j = JSON.parse(a.out.slice(a.out.indexOf('{')));
      r.login = j.loggedIn ? (j.subscriptionType ?? true) : false;
    } catch {
      r.login = null;
    }
  }
  r.ok = r.login !== false;
  return r;
}

export type CodexProbe = ClaudeProbe;

const CODEX_EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

function findFile(dir: string, name: string, depth = 5): string | null {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return path.join(dir, e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findFile(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 동봉 codex.exe (node_modules/@openai/codex-win32-x64/vendor/**) → 없으면 PATH 의 codex.exe. 못 찾으면 null */
export function findCodexBin(workerDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const roots = [
    path.join(workerDir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
    path.join(workerDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
  ];
  for (const r of roots) {
    const hit = findFile(r, CODEX_EXE);
    if (hit) return hit;
  }
  for (const d of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, CODEX_EXE);
    if (existsSync(p)) return p;
  }
  return null;
}

/** `codex login status` 출력 → 'chatgpt' | 'api' | true(종류 모름) | false(미로그인) | null(판단 불가) */
export function parseCodexLogin(out: string): string | boolean | null {
  if (/not logged in/i.test(out)) return false;
  const m = out.match(/logged in using (?:an? )?(chatgpt|api key|[\w-]+)/i);
  if (m) return /api/i.test(m[1]) ? 'api' : m[1].toLowerCase();
  if (/logged in/i.test(out)) return true;
  return null;
}

/** 버전·로그인 상태만 본다(모델 호출 없음) */
export async function probeCodex(bin: string | null, runFn: RunFn = run): Promise<CodexProbe> {
  const r: CodexProbe = { ok: false, version: null, login: null, path: bin ?? '' };
  if (!bin) return r;
  const v = await runFn(bin, ['--version']);
  const m = v.out.match(/(\d+\.\d+\.\d+)/);
  if (v.code !== 0 || !m) return r;
  r.version = m[1];
  const a = await runFn(bin, ['login', 'status']);
  r.login = parseCodexLogin(a.out);
  r.ok = r.login !== false;
  return r;
}

let lastCpu = os.cpus();

/** 직전 호출 이후 평균 CPU 사용률(%) */
export function cpuPercent(): number {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    idle += t.idle - p.idle;
    total += t.user - p.user + t.nice - p.nice + t.sys - p.sys + t.idle - p.idle + t.irq - p.irq;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

export async function sysStats(dir: string): Promise<{ cpu: number; ram_free_mb: number; disk_free_gb: number | null }> {
  let disk: number | null = null;
  try {
    const s = await statfs(dir);
    disk = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    disk = null;
  }
  return { cpu: cpuPercent(), ram_free_mb: Math.round(os.freemem() / 1024 ** 2), disk_free_gb: disk };
}
