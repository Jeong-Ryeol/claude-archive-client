import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  endpoint: string;
  token: string;
  worker_id: string;
  claude_bin: string;
  concurrency: number;
  /** 작품 감시 폴더(%VAR% 펼친 절대 경로) */
  watch_roots: string[];
  /** 자동 업데이트 (기본 켬, --no-update 로 끔) */
  auto_update: boolean;
  update_url?: string;
  update_zip?: string;
}

/** worker/ 폴더 (src 또는 dist 의 한 단계 위) */
export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(WORKER_DIR, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** %VAR% 와 ${VAR} 를 환경변수로 펼친다 */
export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, k) => env[k] ?? env[k.toUpperCase()] ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => env[k] ?? m);
}

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** PATH 에서 실행 파일(claude.exe)을 찾는다. .cmd 래퍼는 spawn 이 안 되므로 보지 않는다. */
export function findOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, EXE);
    if (existsSync(p)) return p;
  }
  return null;
}

function localBin(env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.local', 'bin', EXE);
}

/** 기본: %USERPROFILE%/.local/bin/claude.exe → PATH 의 claude.exe → 없으면 기본 경로 그대로(probe 가 실패로 보고) */
export function defaultClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  const local = localBin(env);
  if (existsSync(local)) return local;
  return findOnPath(env) ?? local;
}

export function resolveClaudeBin(v: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!v || !v.trim()) return defaultClaudeBin(env);
  const p = expandEnv(v.trim(), env);
  if (existsSync(p)) return p;
  return defaultClaudeBin(env);
}

/** 작품 감시 기본 폴더 (설계 §작품 수집 경로 2) */
export const DEFAULT_WATCH_ROOTS = [
  '%USERPROFILE%/Desktop/claude',
  '%USERPROFILE%/OneDrive/바탕 화면/백업함/claude',
  '%USERPROFILE%/Documents/Codex',
  '%LOCALAPPDATA%/Temp/claude',
];

function normalizeRoots(v: unknown, env: NodeJS.ProcessEnv): string[] {
  const list = Array.isArray(v) ? v : DEFAULT_WATCH_ROOTS;
  return list
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map((x) => expandEnv(x.trim(), env))
    .filter((x) => !/%[A-Za-z_][A-Za-z0-9_()]*%/.test(x) && path.isAbsolute(x))
    .map((x) => path.resolve(x));
}

export function normalizeConfig(raw: Partial<Config>, env: NodeJS.ProcessEnv = process.env): Config {
  const endpoint = String(env.TALK_ENDPOINT || raw.endpoint || 'http://100.103.235.96:8800').replace(/\/+$/, '');
  const conc = Number(raw.concurrency ?? 2);
  return {
    endpoint,
    token: String(env.TALK_TOKEN || raw.token || ''),
    worker_id: String(raw.worker_id || '').trim() || os.hostname(),
    claude_bin: resolveClaudeBin(env.TALK_CLAUDE_BIN || raw.claude_bin, env),
    concurrency: Number.isFinite(conc) && conc >= 1 ? Math.floor(conc) : 2,
    watch_roots: normalizeRoots(raw.watch_roots, env),
    auto_update: raw.auto_update !== false,
    ...(typeof raw.update_url === 'string' && raw.update_url.trim() ? { update_url: raw.update_url.trim() } : {}),
    ...(typeof raw.update_zip === 'string' && raw.update_zip.trim() ? { update_zip: raw.update_zip.trim() } : {}),
  };
}

export function loadConfig(file = process.env.TALK_CONFIG || path.join(WORKER_DIR, 'config.json')): Config {
  let raw: Partial<Config> = {};
  if (existsSync(file)) {
    // 메모장이 붙이는 BOM 제거
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  return normalizeConfig(raw);
}
