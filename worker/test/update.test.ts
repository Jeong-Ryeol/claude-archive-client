import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { friendlyError } from '../src/engines/errors.js';
import { extractWorkerSubtree, fetchRemoteVersion, shouldUpdate, Updater } from '../src/update.js';

const log = pino({ level: 'silent' });

function makeZip(files: Record<string, string>): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const [name, body] of Object.entries(files)) z.addBuffer(Buffer.from(body), name);
  z.end();
  return new Promise((ok, no) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => ok(Buffer.concat(chunks)));
    z.outputStream.on('error', no);
  });
}

const fakeFetch = (body: string | Error, status = 200) =>
  (async () => {
    if (body instanceof Error) throw body;
    return new Response(body, { status });
  }) as unknown as typeof fetch;

describe('업데이트 판단', () => {
  it('같으면 그대로, 다르면 업데이트, 이상한 값·없음은 무시', () => {
    expect(shouldUpdate('0.2.0', '0.2.0\n')).toBe(false);
    expect(shouldUpdate('0.2.0', '0.3.0')).toBe(true);
    expect(shouldUpdate('0.2.0', '0.1.9')).toBe(true);
    expect(shouldUpdate('0.2.0', null)).toBe(false);
    expect(shouldUpdate('0.2.0', '<html>404</html>')).toBe(false);
  });

  it('원격 확인: 성공은 값, 실패·HTTP 오류는 null', async () => {
    expect(await fetchRemoteVersion('x', fakeFetch('0.3.0\n'))).toBe('0.3.0');
    expect(await fetchRemoteVersion('x', fakeFetch(new Error('ENOTFOUND')))).toBeNull();
    expect(await fetchRemoteVersion('x', fakeFetch('Not Found', 404))).toBeNull();
  });

  it('Updater: 같은 버전이면 same, 확인 실패면 failed 로 계속 (재시작 없음)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    writeFileSync(path.join(dir, 'VERSION'), '0.2.0\n');
    let restarted = false;
    const mk = (f: typeof fetch) => new Updater({ dir, log, fetchImpl: f, restart: () => (restarted = true) });
    expect(await mk(fakeFetch('0.2.0')).check()).toBe('same');
    expect(await mk(fakeFetch(new Error('timeout'))).check()).toBe('failed');
    expect(restarted).toBe(false);
  });

  it('Updater: zip 받기 실패면 지금 버전 유지, 같은 버전은 다시 시도 안 함', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    writeFileSync(path.join(dir, 'VERSION'), '0.2.0\n');
    let calls = 0;
    const f = (async (url: string) => {
      calls++;
      return url === 'v' ? new Response('0.3.0') : new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    const u = new Updater({ dir, log, fetchImpl: f, versionUrl: 'v', zipUrl: 'z', restart: () => {} });
    expect(await u.check()).toBe('failed');
    expect(await u.check()).toBe('same');
    expect(calls).toBe(3);
    expect(readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()).toBe('0.2.0');
  });
});

describe('zip 의 worker/ 만 풀기', () => {
  it('worker/ 아래만, config.json·logs·node_modules 는 건너뜀', async () => {
    const zip = await makeZip({
      'claude-archive-client-main/README.md': 'top',
      'claude-archive-client-main/pc-agent/a.ps1': 'x',
      'claude-archive-client-main/worker/VERSION': '0.3.0\n',
      'claude-archive-client-main/worker/src/index.ts': 'code',
      'claude-archive-client-main/worker/config.json': '{"token":"new"}',
      'claude-archive-client-main/worker/logs/worker.log': 'nope',
      'claude-archive-client-main/worker/node_modules/x/index.js': 'nope',
      'claude-archive-client-main/worker/test/config.json': 'nested ok',
    });
    const dest = mkdtempSync(path.join(os.tmpdir(), 'ext-'));
    writeFileSync(path.join(dest, 'config.json'), '{"token":"keep"}');
    const n = await extractWorkerSubtree(zip, dest);
    expect(n).toBe(3);
    expect(readFileSync(path.join(dest, 'VERSION'), 'utf8')).toBe('0.3.0\n');
    expect(readFileSync(path.join(dest, 'src', 'index.ts'), 'utf8')).toBe('code');
    expect(readFileSync(path.join(dest, 'test', 'config.json'), 'utf8')).toBe('nested ok');
    expect(readFileSync(path.join(dest, 'config.json'), 'utf8')).toBe('{"token":"keep"}');
    expect(existsSync(path.join(dest, 'logs'))).toBe(false);
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(dest, 'README.md'))).toBe(false);
    expect(existsSync(path.join(dest, 'pc-agent'))).toBe(false);
  });

  it('worker/ 가 없으면 오류', async () => {
    const zip = await makeZip({ 'repo-main/README.md': 'x' });
    await expect(extractWorkerSubtree(zip, mkdtempSync(path.join(os.tmpdir(), 'ext-')))).rejects.toThrow('worker/');
  });
});

describe('친절한 오류 문구', () => {
  it('auth 는 문구를 바꾸고 원문은 detail, kind 유지', () => {
    expect(friendlyError('codex', { k: 'error', kind: 'auth', message: '401 Unauthorized' })).toEqual({
      k: 'error',
      kind: 'auth',
      message: 'ChatGPT 로그인이 필요합니다 (노트북에서 codex login)',
      detail: '401 Unauthorized',
    });
    expect(friendlyError('claude', { k: 'error', kind: 'auth', message: 'Invalid API key · Please run /login' })).toEqual({
      k: 'error',
      kind: 'auth',
      message: 'Claude 로그인이 필요합니다 (노트북에서 Claude 앱을 한 번 열어 주세요)',
      detail: 'Invalid API key · Please run /login',
    });
  });

  it('auth 가 아니면 그대로', () => {
    const lim = { k: 'error', kind: 'limit', message: '429' } as const;
    expect(friendlyError('codex', lim)).toBe(lim);
    const d = { k: 'delta', text: 'hi' } as const;
    expect(friendlyError('claude', d)).toBe(d);
  });
});
