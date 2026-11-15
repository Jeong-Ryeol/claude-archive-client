import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleHtml, classifyRef, OVER_CAP, scanHtml } from '../src/bundle.js';
import { Thumbnailer } from '../src/thumb.js';
import { uploadWork, WorksState, type UploadOpts, type UploadResult } from '../src/upload.js';
import { createProcessor, effectiveRoots, guessEngine, WorkQueue, WorkWatcher, type WorkCtx } from '../src/watch.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'works-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, data: string | Buffer = 'x'): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await sleep(25);
  }
}

describe('bundle', () => {
  it('상대 자산을 모으고, 없는 것·폴더 밖·절대 경로는 missing, 외부 URL 은 무시', async () => {
    put('site/css/a.css', 'body{background:url("../img/bg.png")} .x{background:url(nope.png)}');
    put('site/img/x.png', 'PNG');
    put('site/img/bg.png', 'BG');
    put('site/img/x2.png', 'PNG2');
    put('site/js/app.js', 'console.log(1)');
    put('site/fav.ico', 'ICO');
    put('site/v.mp4', 'MP4');
    put('outside.png', 'OUT');
    const html = put(
      'site/index.html',
      `<!doctype html><html><head><title>  내 작품  </title>
      <link rel="stylesheet" href="css/a.css"><link rel="icon" href="./fav.ico"><link rel="preconnect" href="other.css">
      <script src="js/app.js?v=3"></script><script src="https://cdn.example.com/x.js"></script>
      <style>.h{background:url('img/x.png')}</style></head><body>
      <h1>무시되는 h1</h1>
      <img src="img/x.png"><img srcset="img/x.png 1x, img/x2.png 2x">
      <img src="img/없음.png"><img src="../outside.png"><img src="C:\\abs\\a.png"><img src="file:///C:/a.png">
      <img src="data:image/png;base64,AAAA"><a href="#top">top</a>
      <video src="v.mp4"></video><div style="background:url(img/missing-bg.png)"></div>
      </body></html>`,
    );
    const b = await bundleHtml(html);
    expect(b.status).toBe('ok');
    if (b.status !== 'ok') return;
    expect(b.meta.entry).toBe('index.html');
    expect(b.meta.title).toBe('내 작품');
    expect(b.meta.kind).toBe('html');
    expect(b.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.meta.bytes).toBe(fs.statSync(html).size);
    expect(b.meta.source_path).toBe(path.resolve(html));
    expect(b.files.sort()).toEqual(
      ['index.html', 'css/a.css', 'fav.ico', 'js/app.js', 'img/x.png', 'img/x2.png', 'img/bg.png', 'v.mp4'].sort(),
    );
    expect(b.meta.missing.sort()).toEqual(
      ['img/없음.png', '../outside.png', 'C:\\abs\\a.png', 'file:///C:/a.png', 'img/missing-bg.png', 'css/nope.png'].sort(),
    );
    expect(b.zip.subarray(0, 2).toString()).toBe('PK');
    expect(b.zip.includes(Buffer.from('css/a.css'))).toBe(true);
  });

  it('폴더 밖으로 나가는 참조는 번들에 넣지 않는다', () => {
    const root = path.join(dir, 'a');
    expect(classifyRef('../b/x.png', root, root).k).toBe('bad');
    expect(classifyRef('sub/../../x.png', root, root).k).toBe('bad');
    expect(classifyRef('/etc/passwd', root, root).k).toBe('bad');
    expect(classifyRef('\\\\server\\share\\x.png', root, root).k).toBe('bad');
    expect(classifyRef('//cdn.example.com/x.js', root, root).k).toBe('skip');
    expect(classifyRef('sub/../x%20y.png', root, root)).toEqual({ k: 'local', rel: 'x y.png', abs: path.join(root, 'x y.png') });
  });

  it('상한을 넘으면 더 넣지 않고 용량 초과로 기록', async () => {
    for (let i = 0; i < 5; i++) put(`p/${i}.png`, 'x'.repeat(10));
    const html = put('p/index.html', [0, 1, 2, 3, 4].map((i) => `<img src="${i}.png">`).join(''));
    const b = await bundleHtml(html, { maxFiles: 3 });
    if (b.status !== 'ok') throw new Error('ok 아님');
    expect(b.files).toEqual(['index.html', '0.png', '1.png']);
    expect(b.meta.missing).toEqual([`2.png (${OVER_CAP})`, `3.png (${OVER_CAP})`, `4.png (${OVER_CAP})`]);
    const c = await bundleHtml(html, { maxBytes: 100 });
    if (c.status !== 'ok') throw new Error('ok 아님');
    expect(c.meta.missing.every((m) => m.endsWith(`(${OVER_CAP})`))).toBe(true);
  });

  it('missing 은 중복 없이 50개까지', async () => {
    const html = put('m/index.html', Array.from({ length: 80 }, (_, i) => `<img src="n${i}.png"><img src="n${i}.png">`).join(''));
    const b = await bundleHtml(html);
    expect(b.meta.missing.length).toBe(50);
    expect(new Set(b.meta.missing).size).toBe(50);
  });
});

describe('제목', () => {
  it('<title> → 첫 <h1> → 파일명', async () => {
    expect(scanHtml('<title>\n 가 \n 나 </title><h1>h</h1>').title).toBe('가 나');
    expect(scanHtml('<body><h1>첫 <b>제목</b></h1><h1>둘</h1>').title).toBe('첫 제목');
    expect(scanHtml('<title>  </title><h1>대신</h1>').title).toBe('대신');
    expect(scanHtml('<p>없음</p>').title).toBeNull();
    const f = put('그림 연습.html', '<p>x</p>');
    expect((await bundleHtml(f)).meta.title).toBe('그림 연습');
  });
});

describe('엔진·루트', () => {
  it('Codex 폴더면 gpt', () => {
    expect(guessEngine('C:\\Users\\a\\Documents\\Codex\\x\\a.html')).toBe('gpt');
    expect(guessEngine('C:\\Users\\a\\Documents\\codex\\a.html')).toBe('gpt');
    expect(guessEngine('C:\\Users\\a\\Desktop\\claude\\a.html')).toBe('unknown');
    expect(guessEngine('C:\\Users\\a\\Codexy\\a.html')).toBe('unknown');
  });

  it('없는 폴더·안쪽 폴더·중복은 뺀다', () => {
    const a = path.join(dir, 'a');
    fs.mkdirSync(path.join(a, 'b'), { recursive: true });
    expect(effectiveRoots([a, path.join(a, 'b'), path.join(dir, 'none'), a + path.sep, 'rel'])).toEqual([a]);
  });
});

describe('디바운스', () => {
  it('짧은 시간 여러 번 바뀌어도 한 번만 처리, talk 맥락이 이긴다', async () => {
    const calls: [string, WorkCtx][] = [];
    const q = new WorkQueue({ debounceMs: 80, process: async (f, c) => (calls.push([f, c]), 'uploaded') });
    const f = path.join(dir, 'a.html');
    for (let i = 0; i < 5; i++) {
      q.touch(f);
      await sleep(15);
    }
    q.touch(f, { origin: 'talk', thread_id: 't1', engine: 'claude', topic_id: 'coding' });
    q.touch(f);
    expect(q.stats().queued).toBe(1);
    await sleep(20);
    await q.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ origin: 'talk', thread_id: 't1', engine: 'claude', topic_id: 'coding' });
    expect(q.stats()).toEqual({ queued: 0, uploaded: 1, failed: 0 });
  });

  it('chokidar: 초기 스캔 + 연속 저장은 업로드 1번, 제외 폴더는 무시, 새 루트만 스캔', async () => {
    const root = path.join(dir, 'root');
    put('root/old.html', '<title>old</title>');
    put('root/node_modules/pkg/x.html', 'no');
    put('root/sub/uploads/y.html', 'no');
    put('root/a.txt', 'no');
    const calls: string[] = [];
    const q = new WorkQueue({ debounceMs: 150, process: async (f) => (calls.push(path.basename(f)), 'uploaded') });
    const w = new WorkWatcher({ onFile: (f) => q.touch(f), stabilityMs: 150 });
    try {
      w.setRoots([root]);
      await until(() => calls.includes('old.html'));
      const f = path.join(root, 'deep', 'new.html');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(f, `<p>${i}</p>`);
        await sleep(40);
      }
      await until(() => calls.includes('new.html'));
      await sleep(500);
      await q.idle();
      expect(calls.filter((c) => c === 'new.html')).toHaveLength(1);
      expect(calls).not.toContain('x.html');
      expect(calls).not.toContain('y.html');

      // 루트 추가: 새 루트만 스캔 (old.html 다시 안 옴)
      const root2 = path.join(dir, 'root2');
      put('root2/two.html', '<p>2</p>');
      const { added } = w.setRoots([root, root2]);
      expect(added).toEqual([root2]);
      await until(() => calls.includes('two.html'));
      await sleep(400);
      expect(calls.filter((c) => c === 'old.html')).toHaveLength(1);
      expect(w.roots()).toEqual([root, root2]);
    } finally {
      await w.close();
      q.close();
    }
  });
});

describe('업로드', () => {
  let server: http.Server;
  let url: string;
  let replies: { status: number; body: object }[];
  let got: { token: string | undefined; meta: Record<string, unknown>; bundle: number; thumb: number }[];

  beforeEach(async () => {
    replies = [];
    got = [];
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const fd = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const size = (k: string) => (fd.get(k) instanceof Blob ? (fd.get(k) as Blob).size : 0);
      got.push({ token: req.headers['x-ingest-token'] as string, meta: JSON.parse(String(fd.get('meta'))), bundle: size('bundle'), thumb: size('thumb') });
      const r = replies.shift() ?? { status: 201, body: { id: 1, version: 1, sha12: 'abc', status: 'ok', url: '/works/1' } };
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const meta = {
    source_path: 'C:\\x\\a.html', entry: 'a.html', kind: 'html' as const, title: 't', sha256: 'f'.repeat(64),
    mtime: new Date(0).toISOString(), bytes: 3, missing: [], origin: 'watch' as const, engine: 'unknown' as const,
  };

  it('503 다음 201 이면 재시도해서 성공', async () => {
    replies.push({ status: 503, body: { detail: 'busy' } });
    const r = await uploadWork({ endpoint: url + '/', token: 'tok', meta, bundle: Buffer.from('PKzip'), thumb: Buffer.from('png'), backoffMs: 10 });
    expect(r).toEqual({ ok: true, status: 201, body: { id: 1, version: 1, sha12: 'abc', status: 'ok', url: '/works/1' } });
    expect(got).toHaveLength(2);
    expect(got[1]).toEqual({ token: 'tok', meta, bundle: 5, thumb: 3 });
  });

  it('4xx 는 재시도하지 않고 detail 을 돌려준다, 5xx 는 3번 재시도 후 포기', async () => {
    replies.push({ status: 422, body: { detail: '경로 탈출' } });
    expect(await uploadWork({ endpoint: url, token: 't', meta, backoffMs: 5 })).toEqual({ ok: false, kind: 'client', status: 422, detail: '경로 탈출' });
    expect(got).toHaveLength(1);
    for (let i = 0; i < 4; i++) replies.push({ status: 502, body: {} });
    const r = await uploadWork({ endpoint: url, token: 't', meta, backoffMs: 5 });
    expect(r).toMatchObject({ ok: false, kind: 'server', status: 502 });
    expect(got).toHaveLength(5);
  });

  it('연결이 안 되면 network 실패', async () => {
    const r = await uploadWork({ endpoint: 'http://127.0.0.1:1', token: 't', meta, retries: 1, backoffMs: 5 });
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });
});

describe('상태 파일·처리기', () => {
  it('같은 sha 는 재시작 후에도 건너뛰고, 바뀌면 올린다. talk 은 같은 내용이어도 보낸다', async () => {
    const stateFile = path.join(dir, 'logs', 'works-state.json');
    const html = put('Codex/proj/index.html', '<title>A</title><img src="a.png">');
    put('Codex/proj/a.png', 'PNG');
    const sent: UploadOpts[] = [];
    const upload = async (o: UploadOpts): Promise<UploadResult> => (sent.push(o), { ok: true, status: 201, body: { id: 7 } });
    const thumb = { shot: vi.fn(async () => Buffer.from('thumb')) };
    const mk = () =>
      createProcessor({ endpoint: 'http://x', token: 't', state: new WorksState(stateFile), upload, thumb, topicFor: (f) => (f.includes('proj') ? 'coding' : undefined) });

    let p = mk();
    expect(await p(html, { origin: 'watch' })).toBe('uploaded');
    expect(sent[0].meta).toMatchObject({ origin: 'watch', engine: 'gpt', topic_id: 'coding', entry: 'index.html', title: 'A', missing: [] });
    expect(sent[0].meta.thread_id).toBeUndefined();
    expect(sent[0].bundle?.subarray(0, 2).toString()).toBe('PK');
    expect(sent[0].thumb?.toString()).toBe('thumb');
    expect(await p(html, { origin: 'watch' })).toBe('skipped');

    // 재시작: 상태 파일에서 읽는다
    await sleep(1100); // 상태 파일은 1초 모아서 쓴다
    p = mk();
    expect(await p(html, { origin: 'watch' })).toBe('skipped');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ [process.platform === 'win32' ? path.resolve(html).toLowerCase() : path.resolve(html)]: sent[0].meta.sha256 });

    expect(await p(html, { origin: 'talk', thread_id: 'th', engine: 'claude' })).toBe('uploaded');
    expect(sent[1].meta).toMatchObject({ origin: 'talk', thread_id: 'th', engine: 'claude', topic_id: 'coding' });
    expect(sent[1].thumb).toBeNull(); // 같은 내용이면 썸네일 생략

    fs.writeFileSync(html, '<title>B</title>');
    expect(await p(html, { origin: 'watch' })).toBe('uploaded');
    expect(sent[2].meta.title).toBe('B');
    expect(thumb.shot).toHaveBeenCalledTimes(2);
  });

  it('4xx 면 failed, 상태에 남기지 않는다. 사라진 파일은 skipped', async () => {
    const state = new WorksState(path.join(dir, 's.json'));
    const html = put('x.html', '<p>x</p>');
    const p = createProcessor({ endpoint: 'http://x', token: 't', state, upload: async () => ({ ok: false, kind: 'client', status: 400, detail: 'bad' }) });
    expect(await p(html, { origin: 'watch' })).toBe('failed');
    expect(state.size).toBe(0);
    expect(await p(path.join(dir, 'gone.html'), { origin: 'watch' })).toBe('skipped');
  });

  it('OneDrive 자리표시자: 번들 없이 status=onedrive 메타만', async () => {
    const state = new WorksState(path.join(dir, 's.json'));
    const html = put('od.html', '<p>x</p>');
    const sent: UploadOpts[] = [];
    const p = createProcessor({
      endpoint: 'http://x', token: 't', state,
      bundle: async (f) => ({ status: 'onedrive', meta: { source_path: f, entry: 'od.html', kind: 'html', title: 'od', sha256: '', mtime: new Date(0).toISOString(), bytes: 8, missing: [] } }),
      upload: async (o) => (sent.push(o), { ok: true, status: 201, body: {} }),
    });
    expect(await p(html, { origin: 'watch' })).toBe('uploaded');
    expect(sent[0].meta.status).toBe('onedrive');
    expect(sent[0].bundle).toBeNull();
    expect(await p(html, { origin: 'watch' })).toBe('skipped');
  });
});

describe('썸네일', () => {
  it('브라우저 채널이 없으면 null, 경고는 한 번만', async () => {
    const warn = vi.fn();
    const launch = vi.fn(async () => {
      throw new Error("Chromium distribution 'msedge' is not found");
    });
    const t = new Thumbnailer({ launch: launch as never, log: { warn } });
    expect(await t.shot(path.join(dir, 'a.html'))).toBeNull();
    expect(await t.shot(path.join(dir, 'a.html'))).toBeNull();
    expect(launch).toHaveBeenCalledTimes(4);
    expect(launch.mock.calls.map((c) => (c as unknown as [{ channel: string }])[0].channel)).toEqual(['msedge', 'chrome', 'msedge', 'chrome']);
    expect(warn).toHaveBeenCalledTimes(1);
    await t.close();
  });
});
