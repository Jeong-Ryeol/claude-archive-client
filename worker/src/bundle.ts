import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import yazl from 'yazl';
import { isInside } from './topics.js';

export const MAX_FILES = 200;
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_MISSING = 50;
export const READ_TIMEOUT_MS = 10_000;
export const OVER_CAP = '용량 초과';

/** ingest `/ingest/work` meta 중 파일에서 나오는 부분 */
export interface FileMeta {
  source_path: string;
  entry: string;
  kind: 'html';
  title: string;
  sha256: string;
  mtime: string;
  bytes: number;
  missing: string[];
}

export type BundleResult =
  | { status: 'ok'; meta: FileMeta; zip: Buffer; files: string[] }
  /** OneDrive 자리표시자: 읽기가 10초 안에 안 됨. 메타만 올린다. */
  | { status: 'onedrive'; meta: FileMeta };

// ---------- 참조 수집 ----------

interface PNode {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: PNode[];
  content?: PNode;
  value?: string;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

export function cssRefs(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(CSS_URL)) out.push(m[2]);
  for (const m of css.matchAll(CSS_IMPORT)) out.push(m[2]);
  return out;
}

function srcsetRefs(v: string): string[] {
  // "a.png 1x, b.png 2x" (data: URL 안의 쉼표는 드물어 무시)
  return v
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function attr(n: PNode, name: string): string | undefined {
  return n.attrs?.find((a) => a.name === name)?.value;
}

function textOf(n: PNode): string {
  if (n.nodeName === '#text') return n.value ?? '';
  return (n.childNodes ?? []).map(textOf).join('');
}

function walk(n: PNode, fn: (n: PNode) => void): void {
  fn(n);
  for (const c of n.childNodes ?? []) walk(c, fn);
  if (n.content) walk(n.content, fn);
}

export interface HtmlInfo {
  refs: string[];
  title: string | null;
}

/** HTML 에서 로컬 파일 후보 참조와 제목(<title> → 첫 <h1>)을 뽑는다 */
export function scanHtml(html: string): HtmlInfo {
  const doc = parse(html) as unknown as PNode;
  const refs: string[] = [];
  let title: string | null = null;
  let h1: string | null = null;
  walk(doc, (n) => {
    const tag = n.tagName;
    if (!tag) return;
    const style = attr(n, 'style');
    if (style) refs.push(...cssRefs(style));
    switch (tag) {
      case 'title':
        if (title === null) title = clean(textOf(n));
        break;
      case 'h1':
        if (h1 === null) h1 = clean(textOf(n));
        break;
      case 'style':
        refs.push(...cssRefs(textOf(n)));
        break;
      case 'script': {
        const s = attr(n, 'src');
        if (s) refs.push(s);
        break;
      }
      case 'link': {
        const rel = (attr(n, 'rel') ?? '').toLowerCase().split(/\s+/);
        const href = attr(n, 'href');
        if (href && rel.some((r) => r === 'stylesheet' || r.includes('icon'))) refs.push(href);
        break;
      }
      case 'img':
      case 'source':
      case 'video':
      case 'audio': {
        const s = attr(n, 'src');
        if (s) refs.push(s);
        const set = attr(n, 'srcset');
        if (set) refs.push(...srcsetRefs(set));
        const poster = tag === 'video' ? attr(n, 'poster') : undefined;
        if (poster) refs.push(poster);
        break;
      }
    }
  });
  return { refs, title: title || h1 || null };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export type RefKind =
  /** 같은 폴더 트리 안의 파일 (rel 은 '/' 구분 상대 경로) */
  | { k: 'local'; rel: string; abs: string }
  /** 외부 URL·앵커·data: 등 — 번들에도 missing 에도 넣지 않음 */
  | { k: 'skip' }
  /** 절대 경로·file:·폴더 밖(..) — 열리지 않으므로 missing */
  | { k: 'bad' };

/** 참조 하나를 baseDir(참조한 파일의 폴더) 기준으로 판정. root 는 HTML 의 폴더(이 밖은 거부). */
export function classifyRef(ref: string, baseDir: string, root: string): RefKind {
  let r = ref.trim();
  if (!r || r.startsWith('#')) return { k: 'skip' };
  if (/^(https?:|data:|blob:|mailto:|tel:|javascript:|about:)/i.test(r) || r.startsWith('//')) return { k: 'skip' };
  if (/^file:/i.test(r)) return { k: 'bad' };
  // 윈도우 드라이브(C:\ C:/), UNC, 루트 절대 경로
  if (/^[a-zA-Z]:/.test(r) || r.startsWith('/') || r.startsWith('\\')) return { k: 'bad' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r)) return { k: 'skip' };
  r = r.replace(/[?#].*$/, '');
  try {
    r = decodeURIComponent(r);
  } catch {
    /* 그대로 */
  }
  r = r.replace(/\\/g, '/');
  if (!r) return { k: 'skip' };
  const abs = path.resolve(baseDir, r);
  if (!isInside(root, abs) || abs === path.resolve(root)) return { k: 'bad' };
  return { k: 'local', abs, rel: path.relative(root, abs).split(path.sep).join('/') };
}

// ---------- 읽기 ----------

/** 시간 안에 못 읽으면 reject (OneDrive 내려받기가 걸리는 파일) */
export function readWithTimeout(file: string, ms = READ_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`읽기 ${ms}ms 초과`)), ms);
    readFile(file).then(
      (b) => {
        clearTimeout(t);
        resolve(b);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function zipOf(entries: { name: string; data: Buffer; mtime: Date }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const e of entries) z.addBuffer(e.data, e.name, { mtime: e.mtime });
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
    z.end();
  });
}

export interface BundleOpts {
  readTimeoutMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * HTML 하나를 zip 으로 묶는다. HTML 은 zip 루트에 파일명 그대로(entry), 자산은 HTML 폴더 기준 상대 경로.
 * 읽을 수 없는 0바이트 파일 등은 throw.
 */
export async function bundleHtml(file: string, o: BundleOpts = {}): Promise<BundleResult> {
  const source = path.resolve(file);
  const root = path.dirname(source);
  const entry = path.basename(source);
  const maxFiles = o.maxFiles ?? MAX_FILES;
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  const st = await stat(source);
  const fallbackTitle = entry.replace(/\.html?$/i, '') || entry;

  let html: Buffer;
  try {
    html = await readWithTimeout(source, o.readTimeoutMs ?? READ_TIMEOUT_MS);
  } catch (e) {
    if (st.size > 0) {
      return {
        status: 'onedrive',
        meta: {
          source_path: source,
          entry,
          kind: 'html',
          title: fallbackTitle,
          sha256: '',
          mtime: st.mtime.toISOString(),
          bytes: st.size,
          missing: [],
        },
      };
    }
    throw e;
  }

  const text = html.toString('utf8');
  const info = scanHtml(text);
  const missing: string[] = [];
  const addMissing = (s: string) => {
    if (missing.length < MAX_MISSING && !missing.includes(s)) missing.push(s);
  };

  const entries: { name: string; data: Buffer; mtime: Date }[] = [{ name: entry, data: html, mtime: st.mtime }];
  const taken = new Set<string>([entry.toLowerCase()]);
  let total = html.length;
  let full = false;

  // CSS 안의 url() 은 그 CSS 폴더 기준으로 한 단계 더 따라간다
  const todo: { ref: string; base: string }[] = info.refs.map((ref) => ({ ref, base: root }));
  for (let i = 0; i < todo.length; i++) {
    const { ref, base } = todo[i];
    const c = classifyRef(ref, base, root);
    if (c.k === 'skip') continue;
    if (c.k === 'bad') {
      addMissing(ref.trim());
      continue;
    }
    const key = c.rel.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    let s;
    try {
      s = await stat(c.abs);
    } catch {
      s = null;
    }
    if (!s?.isFile()) {
      addMissing(c.rel);
      continue;
    }
    if (full || entries.length >= maxFiles || total + s.size > maxBytes) {
      full = true;
      addMissing(`${c.rel} (${OVER_CAP})`);
      continue;
    }
    let data: Buffer;
    try {
      data = await readWithTimeout(c.abs, o.readTimeoutMs ?? READ_TIMEOUT_MS);
    } catch {
      addMissing(c.rel);
      continue;
    }
    entries.push({ name: c.rel, data, mtime: s.mtime });
    total += data.length;
    if (/\.css$/i.test(c.rel) && base === root) {
      for (const r of cssRefs(data.toString('utf8'))) todo.push({ ref: r, base: path.dirname(c.abs) });
    }
  }

  return {
    status: 'ok',
    meta: {
      source_path: source,
      entry,
      kind: 'html',
      title: info.title || fallbackTitle,
      sha256: sha256(html),
      mtime: st.mtime.toISOString(),
      bytes: html.length,
      missing,
    },
    zip: await zipOf(entries),
    files: entries.map((e) => e.name),
  };
}
