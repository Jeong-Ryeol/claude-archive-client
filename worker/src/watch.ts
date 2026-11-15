import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { bundleHtml, type BundleResult } from './bundle.js';
import type { Thumbnailer } from './thumb.js';
import { folderProblem, isInside } from './topics.js';
import { uploadWork, type UploadOpts, type UploadResult, type WorkMeta, type WorksState } from './upload.js';

type Log = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  debug?: (o: object, m?: string) => void;
};

/** 수집 경로: talk 파일 이벤트(정확한 출처) 또는 폴더 감시 */
export type WorkCtx =
  | { origin: 'talk'; thread_id: string; topic_id?: string; engine: WorkMeta['engine'] }
  | { origin: 'watch' };

export type WorkOutcome = 'uploaded' | 'skipped' | 'failed';
export type Processor = (file: string, ctx: WorkCtx) => Promise<WorkOutcome>;

export const IGNORED_DIRS = ['node_modules', '.git', '.svelte-kit', '__pycache__', 'dist', 'uploads'];
export const WATCH_DEPTH = 6;

export function isWorkFile(p: string): boolean {
  return /\.html$/i.test(p);
}

/** 경로 규칙: `\Codex\` 아래면 GPT, 그 외는 모름(아카이브 쪽 로그 매칭으로 나중에 확정) */
export function guessEngine(p: string): WorkMeta['engine'] {
  return /[\\/]codex[\\/]/i.test(p) ? 'gpt' : 'unknown';
}

/** job.engine('claude'|'codex') → 작품 engine */
export function engineOfJob(engine: string): WorkMeta['engine'] {
  return engine === 'codex' ? 'gpt' : engine === 'claude' ? 'claude' : 'unknown';
}

const keyOf = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

// ---------- 디바운스 + 직렬 처리 ----------

export interface WorkQueueOpts {
  process: Processor;
  debounceMs?: number;
  log?: Log;
}

/**
 * 경로별 2초 디바운스 뒤 한 번에 하나씩 처리한다(썸네일 브라우저를 한 개만 쓰게).
 * 같은 경로에 talk 맥락이 한 번이라도 붙으면 그 맥락으로 올린다.
 */
export class WorkQueue {
  private pending = new Map<string, { file: string; ctx: WorkCtx; timer: NodeJS.Timeout }>();
  private waiting: { key: string; file: string; ctx: WorkCtx }[] = [];
  private running: string | null = null;
  private counters = { uploaded: 0, failed: 0 };
  private idleWaiters: (() => void)[] = [];
  private closed = false;

  constructor(private readonly o: WorkQueueOpts) {}

  touch(file: string, ctx: WorkCtx = { origin: 'watch' }): void {
    if (this.closed) return;
    const key = keyOf(file);
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const merged = prev && prev.ctx.origin === 'talk' && ctx.origin === 'watch' ? prev.ctx : ctx;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.enqueue(key, path.resolve(file), merged);
    }, this.o.debounceMs ?? 2000);
    this.pending.set(key, { file, ctx: merged, timer });
  }

  private enqueue(key: string, file: string, ctx: WorkCtx): void {
    const w = this.waiting.find((x) => x.key === key);
    if (w) {
      if (ctx.origin === 'talk') w.ctx = ctx;
    } else this.waiting.push({ key, file, ctx });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    const next = this.waiting.shift();
    if (!next) {
      if (this.pending.size === 0) for (const r of this.idleWaiters.splice(0)) r();
      return;
    }
    this.running = next.key;
    let out: WorkOutcome;
    try {
      out = await this.o.process(next.file, next.ctx);
    } catch (e) {
      this.o.log?.warn({ file: next.file, err: String(e) }, '작품 처리 오류');
      out = 'failed';
    }
    if (out === 'uploaded') this.counters.uploaded++;
    else if (out === 'failed') this.counters.failed++;
    this.running = null;
    void this.pump();
  }

  stats(): { queued: number; uploaded: number; failed: number } {
    return { queued: this.pending.size + this.waiting.length + (this.running ? 1 : 0), ...this.counters };
  }

  /** 대기·처리 중인 게 없어지면 resolve (테스트·종료용) */
  idle(): Promise<void> {
    if (this.pending.size === 0 && this.waiting.length === 0 && this.running === null) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.waiting = [];
  }
}

// ---------- 폴더 감시 ----------

/** 감시할 루트: 절대 경로·시스템/드라이브 루트 아님·존재하는 폴더. 다른 루트 안에 든 루트는 뺀다. */
export function effectiveRoots(list: Iterable<string>, env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Map<string, string>();
  for (const raw of list) {
    if (typeof raw !== 'string' || folderProblem(raw, env)) continue;
    const p = path.resolve(raw.trim());
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!seen.has(keyOf(p))) seen.set(keyOf(p), p);
  }
  const all = [...seen.values()].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of all) if (!out.some((r) => isInside(r, p))) out.push(p);
  return out;
}

export interface WorkWatcherOpts {
  onFile: (file: string) => void;
  log?: Log;
  depth?: number;
  /** awaitWriteFinish 안정 시간 (기본 2초) */
  stabilityMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** chokidar 로 루트들 아래 `**\/*.html` 을 본다. 루트가 새로 생기면 그 루트만 처음부터 훑는다. */
export class WorkWatcher {
  private w: FSWatcher | null = null;
  private current: string[] = [];

  constructor(private readonly o: WorkWatcherOpts) {}

  roots(): string[] {
    return [...this.current];
  }

  private ignored = (p: string, stats?: { isFile(): boolean; isDirectory(): boolean }): boolean => {
    const root = this.current.find((r) => isInside(r, p));
    if (root) {
      const segs = path.relative(root, p).split(/[\\/]/).map((s) => s.toLowerCase());
      if (segs.some((s) => IGNORED_DIRS.includes(s))) return true;
    }
    return !!stats?.isFile() && !isWorkFile(p);
  };

  private ensure(): FSWatcher {
    if (this.w) return this.w;
    const stab = this.o.stabilityMs ?? 2000;
    const w = chokidar.watch([], {
      ignored: this.ignored,
      ignoreInitial: false,
      depth: this.o.depth ?? WATCH_DEPTH,
      awaitWriteFinish: { stabilityThreshold: stab, pollInterval: Math.min(100, Math.max(20, Math.floor(stab / 4))) },
      ignorePermissionErrors: true,
      persistent: true,
    });
    const hit = (p: string) => {
      if (isWorkFile(p) && !this.ignored(p)) this.o.onFile(path.resolve(p));
    };
    w.on('add', hit);
    w.on('change', hit);
    w.on('error', (e) => this.o.log?.warn({ err: String(e) }, '감시 오류'));
    this.w = w;
    return w;
  }

  /** 루트를 바꾼다. 추가된 루트만 watch(add) — chokidar 가 그 루트의 기존 파일을 add 로 낸다(초기 스캔). */
  setRoots(list: Iterable<string>): { added: string[]; removed: string[] } {
    const next = effectiveRoots(list, this.o.env);
    const nextKeys = new Set(next.map(keyOf));
    const curKeys = new Set(this.current.map(keyOf));
    const added = next.filter((r) => !curKeys.has(keyOf(r)));
    const removed = this.current.filter((r) => !nextKeys.has(keyOf(r)));
    this.current = next;
    if (removed.length && this.w) this.w.unwatch(removed);
    if (added.length) this.ensure().add(added);
    if (added.length || removed.length) this.o.log?.info({ roots: next, added, removed }, '작품 감시 폴더');
    return { added, removed };
  }

  async close(): Promise<void> {
    const w = this.w;
    this.w = null;
    if (w) await w.close();
  }
}

// ---------- 번들 → 썸네일 → 업로드 ----------

export interface ProcessorOpts {
  endpoint: string;
  token: string;
  state: WorksState;
  thumb?: Pick<Thumbnailer, 'shot'> | null;
  /** 경로가 든 활성 방 id */
  topicFor?: (file: string) => string | undefined;
  log?: Log;
  bundle?: (file: string) => Promise<BundleResult>;
  upload?: (o: UploadOpts) => Promise<UploadResult>;
}

export function createProcessor(o: ProcessorOpts): Processor {
  const bundle = o.bundle ?? ((f: string) => bundleHtml(f));
  const upload = o.upload ?? uploadWork;
  return async (file, ctx) => {
    if (!isWorkFile(file)) return 'skipped';
    let b: BundleResult;
    try {
      b = await bundle(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || !existsSync(file)) return 'skipped';
      o.log?.warn({ file, err: String(e) }, '작품 묶기 실패');
      return 'failed';
    }
    const mark = b.status === 'onedrive' ? `onedrive:${b.meta.mtime}:${b.meta.bytes}` : b.meta.sha256;
    const same = o.state.isSame(file, mark);
    // 감시로 본 파일은 같은 내용이면 건너뜀. talk 은 출처(thread) 연결 때문에 보낸다(서버가 existing 으로 답함).
    if (same && ctx.origin === 'watch') return 'skipped';

    const topic = ctx.origin === 'talk' ? (ctx.topic_id ?? o.topicFor?.(file)) : o.topicFor?.(file);
    const meta: WorkMeta = {
      ...b.meta,
      origin: ctx.origin,
      engine: ctx.origin === 'talk' ? ctx.engine : guessEngine(file),
      ...(topic ? { topic_id: topic } : {}),
      ...(ctx.origin === 'talk' ? { thread_id: ctx.thread_id } : {}),
      ...(b.status === 'onedrive' ? { status: 'onedrive' as const } : {}),
    };
    const thumb = b.status === 'ok' && !same && o.thumb ? await o.thumb.shot(file) : null;
    const r = await upload({
      endpoint: o.endpoint,
      token: o.token,
      meta,
      bundle: b.status === 'ok' ? b.zip : null,
      thumb,
    });
    if (r.ok) {
      o.state.set(file, mark);
      o.log?.info(
        { file, origin: ctx.origin, id: r.body.id, version: r.body.version, status: r.body.status, existing: r.body.existing ?? false, missing: meta.missing.length },
        '작품 업로드',
      );
      return 'uploaded';
    }
    o.log?.warn({ file, kind: r.kind, status: r.status, detail: r.detail }, r.kind === 'client' ? '작품 업로드 거부(버림)' : '작품 업로드 실패');
    return 'failed';
  };
}
