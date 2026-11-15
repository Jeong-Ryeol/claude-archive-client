import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from './engines/types.js';

export interface Downloaded {
  name: string;
  path: string;
  /** 이미지(png/jpg/jpeg/webp/gif)일 때만 media type, 아니면 null */
  mime: string | null;
  data: Buffer;
}

export interface DownloadResult {
  files: Downloaded[];
  /** 내려받지 못한 첨부의 원래 이름 */
  failed: string[];
}

export const MAX_BYTES = 20 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const IMAGE_TYPES = new Set(Object.values(IMAGE_MIME));

/** 확장자로 먼저, 없으면 받은 mime 으로. 지원하는 이미지가 아니면 null */
export function imageMime(name: string, mime?: string | null): string | null {
  const byExt = IMAGE_MIME[path.extname(name).toLowerCase()];
  if (byExt) return byExt;
  const m = (mime ?? '').toLowerCase().split(';')[0].trim();
  return m === 'image/jpg' ? 'image/jpeg' : IMAGE_TYPES.has(m) ? m : null;
}

export function safeName(name: string): string {
  const base = path.posix.basename(String(name ?? '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : 'file';
}

export interface FetchOpts {
  endpoint: string;
  token: string;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error(`너무 큼 (${len} bytes)`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`너무 큼 (>${max} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * job.attachments 를 <cwd>/uploads/ 에 내려받는다(같은 이름은 덮어씀).
 * 토큰은 ingest 와 같은 주소일 때만 붙인다. 하나가 실패해도 나머지는 계속한다.
 */
export async function downloadAttachments(
  cwd: string,
  list: Attachment[],
  o: FetchOpts,
  log?: { warn: (o: object, m?: string) => void },
): Promise<DownloadResult> {
  const out: DownloadResult = { files: [], failed: [] };
  if (!list?.length) return out;
  const f = o.fetch ?? fetch;
  const max = o.maxBytes ?? MAX_BYTES;
  const dir = path.join(cwd, 'uploads');
  const base = new URL(o.endpoint);
  for (const a of list) {
    const label = String(a?.name ?? a?.url ?? '?');
    try {
      await mkdir(dir, { recursive: true });
      const url = new URL(a.url, base);
      const headers: Record<string, string> = {};
      if (url.origin === base.origin && o.token) headers['X-Ingest-Token'] = o.token;
      const res = await f(url, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await readCapped(res, max);
      const name = safeName(a.name);
      const file = path.join(dir, name);
      await writeFile(file, data);
      out.files.push({ name, path: file, mime: imageMime(name, a.mime ?? res.headers.get('content-type')), data });
    } catch (e) {
      log?.warn({ name: label, err: e instanceof Error ? e.message : String(e) }, '첨부 내려받기 실패');
      out.failed.push(label);
    }
  }
  return out;
}

/** 프롬프트 끝에 붙일 첨부 줄 (모든 엔진 공통) */
export function attachmentLines(r: DownloadResult): string {
  const lines = [...r.files.map((f) => `첨부 파일: ${f.path}`), ...r.failed.map((n) => `첨부 내려받기 실패: ${n}`)];
  return lines.join('\n');
}
