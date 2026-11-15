import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attachmentLines, downloadAttachments, imageMime, safeName } from '../src/attach.js';
import { buildUserMessage } from '../src/engines/claude.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let server: http.Server;
let endpoint: string;
let lastToken: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastToken = req.headers['x-ingest-token'] as string | undefined;
    if (lastToken !== 'tk') {
      res.writeHead(401).end();
      return;
    }
    switch (req.url) {
      case '/a/png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      case '/a/txt':
        res.writeHead(200, { 'content-type': 'text/plain' }).end('메모');
        return;
      case '/a/noext':
        res.writeHead(200, { 'content-type': 'image/webp' }).end(PNG);
        return;
      case '/a/big':
        // content-length 없이 흘려서 스트리밍 상한을 시험
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(600));
        res.end(Buffer.alloc(600));
        return;
      default:
        if (req.url?.startsWith('/api/talk/attach/')) {
          res.writeHead(200, { 'content-type': 'image/png', 'x-path': req.url }).end(PNG);
          return;
        }
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
  lastToken = undefined;
});

describe('첨부 내려받기', () => {
  it('토큰을 붙여 uploads/ 에 저장, 이미지는 mime', async () => {
    const r = await downloadAttachments(
      dir,
      [
        { name: '사진.png', url: '/a/png', mime: 'image/png' },
        { name: '메모.txt', url: `${endpoint}/a/txt` },
      ],
      { endpoint, token: 'tk' },
    );
    expect(lastToken).toBe('tk');
    expect(r.failed).toEqual([]);
    expect(r.files.map((f) => [f.name, f.mime])).toEqual([
      ['사진.png', 'image/png'],
      ['메모.txt', null],
    ]);
    expect(fs.readFileSync(path.join(dir, 'uploads', '사진.png'))).toEqual(PNG);
    expect(fs.readFileSync(path.join(dir, 'uploads', '메모.txt'), 'utf8')).toBe('메모');
  });

  it('같은 이름은 덮어쓴다', async () => {
    fs.mkdirSync(path.join(dir, 'uploads'));
    fs.writeFileSync(path.join(dir, 'uploads', 'x.png'), 'old');
    await downloadAttachments(dir, [{ name: 'x.png', url: '/a/png' }], { endpoint, token: 'tk' });
    expect(fs.readFileSync(path.join(dir, 'uploads', 'x.png'))).toEqual(PNG);
  });

  it('토큰이 틀림·404·상한 초과는 failed 로, 나머지는 계속', async () => {
    const bad = await downloadAttachments(dir, [{ name: 'a.png', url: '/a/png' }], { endpoint, token: 'nope' });
    expect(bad).toEqual({ files: [], failed: ['a.png'] });

    const r = await downloadAttachments(
      dir,
      [
        { name: '없음.png', url: '/a/missing' },
        { name: 'big.bin', url: '/a/big' },
        { name: 'ok.png', url: '/a/png' },
      ],
      { endpoint, token: 'tk', maxBytes: 1000 },
    );
    expect(r.failed).toEqual(['없음.png', 'big.bin']);
    expect(r.files.map((f) => f.name)).toEqual(['ok.png']);
    expect(fs.existsSync(path.join(dir, 'uploads', 'big.bin'))).toBe(false);
  });

  it('경로만 온 url 은 endpoint 기준으로 풀고 토큰을 붙인다', async () => {
    let seen = '';
    const spy = (async (u: URL, init: RequestInit) => {
      seen = u.toString();
      return fetch(u, init);
    }) as unknown as typeof fetch;
    const url = '/api/talk/attach/11111111-1111-1111-1111-111111111111/' + encodeURIComponent('사진.png');
    const r = await downloadAttachments(dir, [{ name: '사진.png', url }], { endpoint, token: 'tk', fetch: spy });
    expect(seen).toBe(endpoint + url);
    expect(lastToken).toBe('tk');
    expect(r.failed).toEqual([]);
    expect(r.files[0]).toMatchObject({ name: '사진.png', mime: 'image/png' });
    expect(fs.readFileSync(path.join(dir, 'uploads', '사진.png'))).toEqual(PNG);
  });

  it('다른 주소에는 토큰을 보내지 않는다', async () => {
    let headers: unknown;
    const fakeFetch = (async (_u: URL, init: { headers: unknown }) => {
      headers = init.headers;
      return new Response(PNG);
    }) as unknown as typeof fetch;
    await downloadAttachments(dir, [{ name: 'e.png', url: 'https://elsewhere.example/e.png' }], {
      endpoint,
      token: 'tk',
      fetch: fakeFetch,
    });
    expect(headers).toEqual({});
  });

  it('확장자가 없으면 응답 content-type 으로 이미지 판정', async () => {
    const r = await downloadAttachments(dir, [{ name: 'camera', url: '/a/noext' }], { endpoint, token: 'tk' });
    expect(r.files[0].mime).toBe('image/webp');
  });

  it('이름 정리·mime 판정', () => {
    expect(safeName('..\\..\\etc/passwd')).toBe('passwd');
    expect(safeName('..')).toBe('file');
    expect(safeName('a:b?.png')).toBe('a_b_.png');
    expect(imageMime('X.JPG')).toBe('image/jpeg');
    expect(imageMime('a.svg', 'image/svg+xml')).toBeNull();
    expect(imageMime('a', 'image/jpg')).toBe('image/jpeg');
  });
});

describe('user 메시지', () => {
  it('이미지 → base64 블록, 모든 파일 경로와 실패 줄을 프롬프트 끝에', async () => {
    const r = await downloadAttachments(
      dir,
      [
        { name: 'p.png', url: '/a/png' },
        { name: 'm.txt', url: '/a/txt' },
        { name: '깨짐.jpg', url: '/a/missing' },
      ],
      { endpoint, token: 'tk' },
    );
    const msg = buildUserMessage('이거 봐줘', r);
    const content = msg.message.content as unknown as Array<Record<string, any>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    });
    const p = path.join(dir, 'uploads', 'p.png');
    const m = path.join(dir, 'uploads', 'm.txt');
    expect(content[1]).toEqual({
      type: 'text',
      text: `이거 봐줘\n\n첨부 파일: ${p}\n첨부 파일: ${m}\n첨부 내려받기 실패: 깨짐.jpg`,
    });
    expect(attachmentLines({ files: [], failed: [] })).toBe('');
    expect(buildUserMessage('그냥').message.content).toEqual([{ type: 'text', text: '그냥' }]);
  });
});
