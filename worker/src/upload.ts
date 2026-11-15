import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FileMeta } from './bundle.js';

/** `/ingest/work` meta 전체 */
export interface WorkMeta extends FileMeta {
  origin: 'talk' | 'watch';
  engine: 'claude' | 'gpt' | 'unknown';
  topic_id?: string;
  thread_id?: string;
  /** OneDrive 자리표시자일 때만 'onedrive' (bundle 없음) */
  status?: 'onedrive';
}

export interface WorkResponse {
  id?: number | string;
  version?: number;
  sha12?: string;
  status?: string;
  url?: string;
  existing?: boolean;
  [k: string]: unknown;
}

export type UploadResult =
  | { ok: true; status: number; body: WorkResponse }
  /** client: 4xx(버림) · server: 5xx 재시도 끝 · network: 연결 실패 재시도 끝 */
  | { ok: false; kind: 'client' | 'server' | 'network'; status?: number; detail: string };

export interface UploadOpts {
  endpoint: string;
  token: string;
  meta: WorkMeta;
  bundle?: Buffer | null;
  thumb?: Buffer | null;
  /** 재시도 횟수(첫 시도 제외). 기본 3 */
  retries?: number;
  /** 첫 재시도 대기(ms), 매번 2배. 기본 1000 */
  backoffMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function form(o: UploadOpts): FormData {
  const fd = new FormData();
  fd.set('meta', JSON.stringify(o.meta));
  if (o.bundle) fd.set('bundle', new Blob([new Uint8Array(o.bundle)], { type: 'application/zip' }), 'bundle.zip');
  if (o.thumb) fd.set('thumb', new Blob([new Uint8Array(o.thumb)], { type: 'image/png' }), 'thumb.png');
  return fd;
}

/** multipart POST `<endpoint>/ingest/work`. 네트워크 오류·5xx 는 재시도, 4xx 는 바로 실패. */
export async function uploadWork(o: UploadOpts): Promise<UploadResult> {
  const f = o.fetchImpl ?? fetch;
  const url = o.endpoint.replace(/\/+$/, '') + '/ingest/work';
  const retries = o.retries ?? 3;
  let wait = o.backoffMs ?? 1000;
  let last: UploadResult = { ok: false, kind: 'network', detail: '시도 안 함' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(wait);
      wait *= 2;
    }
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'X-Ingest-Token': o.token },
        body: form(o),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      last = { ok: false, kind: 'network', detail: e instanceof Error ? e.message : String(e) };
      continue;
    }
    const raw = await res.text().catch(() => '');
    let body: WorkResponse = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (res.ok) return { ok: true, status: res.status, body };
    const detail = typeof body.detail === 'string' ? body.detail : raw.slice(0, 300) || res.statusText;
    if (res.status >= 400 && res.status < 500) return { ok: false, kind: 'client', status: res.status, detail };
    last = { ok: false, kind: 'server', status: res.status, detail };
  }
  return last;
}

/** 올린 파일의 sha256 기록 (`logs/works-state.json` = {source_path: sha256}). 재시작해도 안 바뀐 파일은 건너뛴다. */
export class WorksState {
  private map: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        for (const [k, v] of Object.entries(j)) if (typeof v === 'string') this.map[k] = v;
      }
    } catch {
      /* 없거나 깨짐 → 빈 표 */
    }
  }

  private key(p: string): string {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  }

  get(p: string): string | undefined {
    return this.map[this.key(p)];
  }

  isSame(p: string, sha: string): boolean {
    return !!sha && this.map[this.key(p)] === sha;
  }

  set(p: string, sha: string): void {
    this.map[this.key(p)] = sha;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 1000);
      this.timer.unref?.();
    }
  }

  get size(): number {
    return Object.keys(this.map).length;
  }

  /** 바로 디스크에 쓴다(임시 파일 → 이름 바꾸기) */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.map));
      renameSync(tmp, this.file);
    } catch {
      /* 다음 기회에 */
    }
  }
}
