import { spawn } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Logger } from './log.js';

export const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/Jeong-Ryeol/claude-archive-client/main/worker/VERSION';
export const DEFAULT_UPDATE_ZIP = 'https://github.com/Jeong-Ryeol/claude-archive-client/archive/refs/heads/main.zip';
/** run-hidden.vbs 가 이 코드를 보면 5초 뒤 다시 띄운다 */
export const UPDATE_EXIT_CODE = 75;
const CHECK_EVERY_MS = 6 * 3600_000;

/** 업데이트가 덮어쓰지 않는 것 (worker/ 기준 첫 마디) */
const KEEP = new Set(['config.json', 'logs', 'node_modules', '.update']);

export function readLocalVersion(dir: string): string {
  try {
    return readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 원격 VERSION 이 버전 꼴이고 로컬과 다르면 true (배포본이 기준이라 낮은 버전으로 되돌리기도 허용) */
export function shouldUpdate(local: string, remote: string | null): boolean {
  if (!remote) return false;
  const r = remote.trim();
  if (!/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(r)) return false;
  return r !== local.trim();
}

/** 원격 VERSION. 실패·시간 초과면 null. */
export async function fetchRemoteVersion(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const t = (await res.text()).trim();
    return t.length > 0 && t.length < 64 ? t : null;
  } catch {
    return null;
  }
}

/**
 * zip 안의 `<최상위>/worker/` 아래만 dest 에 푼다. config.json·logs·node_modules 는 건너뛴다.
 * 풀린 파일 수를 돌려준다. worker/ 가 없으면 오류.
 */
export async function extractWorkerSubtree(zip: Buffer, dest: string): Promise<number> {
  const root = path.resolve(dest);
  const zf = await new Promise<yauzl.ZipFile>((ok, no) =>
    yauzl.fromBuffer(zip, { lazyEntries: true, decodeStrings: true }, (e, z) => (e || !z ? no(e ?? new Error('zip 열기 실패')) : ok(z))),
  );
  let count = 0;
  try {
    await new Promise<void>((ok, no) => {
      zf.on('error', no);
      zf.on('end', () => ok());
      zf.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const m = /^[^/]+\/worker\/(.+)$/.exec(entry.fileName.replace(/\\/g, '/'));
          const rel = m?.[1];
          if (!rel || rel.endsWith('/') || KEEP.has(rel.split('/')[0]!)) return zf.readEntry();
          const out = path.resolve(root, rel);
          if (!out.startsWith(root + path.sep)) throw new Error(`zip 경로 이상: ${entry.fileName}`);
          mkdirSync(path.dirname(out), { recursive: true });
          const rs = await new Promise<NodeJS.ReadableStream>((a, b) => zf.openReadStream(entry, (e, s) => (e || !s ? b(e ?? new Error('읽기 실패')) : a(s))));
          await pipeline(rs, createWriteStream(out));
          count++;
          zf.readEntry();
        })().catch(no);
      });
      zf.readEntry();
    });
  } finally {
    zf.close();
  }
  if (count === 0) throw new Error('zip 에 worker/ 가 없음');
  return count;
}

/** process.execPath 옆의 npm-cli.js. npm.cmd 는 shell 없이 spawn 이 막혀(EINVAL) node 로 직접 실행한다. */
export function findNpmCli(execPath = process.execPath): string | null {
  const dir = path.dirname(execPath);
  for (const p of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runNpm(cwd: string, args: string[], timeoutMs: number): Promise<void> {
  const cli = findNpmCli();
  if (!cli) return Promise.reject(new Error(`npm 을 찾지 못함 (${path.dirname(process.execPath)})`));
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [cli, ...args, '--no-audit', '--no-fund'], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      no(e);
    });
    p.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else no(new Error(`npm ${args.join(' ')} 실패 (${code ?? sig}): ${tail.trim().slice(-500)}`));
    });
  });
}

export interface UpdaterOpts {
  dir: string;
  log: Logger;
  versionUrl?: string;
  zipUrl?: string;
  fetchImpl?: typeof fetch;
  /** 진행 중인 작업이 없으면 true. 파일 교체·재시작은 이게 true 일 때까지 미룬다. */
  idle?: () => boolean;
  /** 새 버전이 깔린 뒤 호출 (기본: process.exit(75)) */
  restart?: () => void;
}

/**
 * 원격 VERSION 이 다르면 zip 을 받아 .update/stage 에 풀고, 거기서 설치·빌드한 뒤
 * node_modules 를 바꿔 끼우고 나머지 파일을 덮어쓴다. 어느 단계든 실패하면 지금 버전 그대로.
 */
export class Updater {
  private busy = false;
  private readonly failed = new Set<string>();
  private fetchFailLogged = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: UpdaterOpts) {}

  start(): void {
    // 지난 업데이트의 찌꺼기(옛 node_modules 등) 정리
    try {
      rmSync(path.join(this.o.dir, '.update'), { recursive: true, force: true });
    } catch {
      /* 잠긴 파일이면 다음 기회에 */
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<'same' | 'updated' | 'failed' | 'skipped'> {
    if (this.busy) return 'skipped';
    this.busy = true;
    try {
      const { dir, log } = this.o;
      const url = this.o.versionUrl ?? DEFAULT_UPDATE_URL;
      const local = readLocalVersion(dir);
      const remote = await fetchRemoteVersion(url, this.o.fetchImpl);
      if (remote === null) {
        if (!this.fetchFailLogged) log.warn({ url }, '업데이트 확인 실패 (다음 확인 때 다시)');
        this.fetchFailLogged = true;
        return 'failed';
      }
      this.fetchFailLogged = false;
      if (!shouldUpdate(local, remote) || this.failed.has(remote)) return 'same';
      log.info({ local, remote }, '새 버전 발견, 업데이트 시작');
      try {
        await this.install(remote);
      } catch (e) {
        // 같은 버전은 이 프로세스가 사는 동안 다시 시도하지 않는다 (로그 한 번)
        this.failed.add(remote);
        log.error({ remote, err: String(e) }, '업데이트 실패, 지금 버전으로 계속');
        return 'failed';
      }
      log.info({ from: local, to: remote }, '업데이트 완료, 재시작');
      (this.o.restart ?? (() => process.exit(UPDATE_EXIT_CODE)))();
      return 'updated';
    } finally {
      this.busy = false;
    }
  }

  private async install(remote: string): Promise<void> {
    const { dir } = this.o;
    const work = path.join(dir, '.update');
    const stage = path.join(work, 'stage');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    const res = await (this.o.fetchImpl ?? fetch)(this.o.zipUrl ?? DEFAULT_UPDATE_ZIP, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) throw new Error(`zip 받기 실패: HTTP ${res.status}`);
    const n = await extractWorkerSubtree(Buffer.from(await res.arrayBuffer()), stage);
    const staged = readLocalVersion(stage);
    if (staged !== remote) throw new Error(`zip 의 VERSION(${staged}) 이 원격(${remote}) 과 다름`);
    this.o.log.info({ files: n }, '업데이트 파일 풀림, 설치 중');

    // 배포본엔 dist 가 없어 빌드가 필요하다: 전체 설치 → 빌드 → 개발 도구 정리 (install.ps1 과 같은 순서)
    await runNpm(stage, ['ci'], 10 * 60_000);
    await runNpm(stage, ['run', 'build'], 5 * 60_000);
    await runNpm(stage, ['prune', '--omit=dev'], 5 * 60_000);
    if (!existsSync(path.join(stage, 'dist', 'index.js'))) throw new Error('빌드 결과(dist/index.js) 없음');

    // 진행 중인 작업(엔진 실행 파일이 node_modules 안에 있음)이 끝난 뒤 바꿔 끼운다
    while (this.o.idle && !this.o.idle()) await new Promise((r) => setTimeout(r, 10_000));
    // node_modules 먼저 바꿔 끼운다. 여기서 실패하면 아무것도 안 바뀐 상태.
    const nm = path.join(dir, 'node_modules');
    const oldNm = path.join(work, 'old_node_modules');
    if (existsSync(nm)) renameSync(nm, oldNm);
    try {
      renameSync(path.join(stage, 'node_modules'), nm);
    } catch (e) {
      if (existsSync(oldNm)) renameSync(oldNm, nm);
      throw e;
    }
    // 나머지(소스·dist·스크립트). VERSION 은 마지막에 써서 반쯤 깔린 상태를 새 버전으로 오인하지 않게.
    for (const name of readdirSync(stage)) {
      if (KEEP.has(name) || name === 'VERSION') continue;
      cpSync(path.join(stage, name), path.join(dir, name), { recursive: true, force: true });
    }
    writeFileSync(path.join(dir, 'VERSION'), `${remote}\n`);
  }
}
