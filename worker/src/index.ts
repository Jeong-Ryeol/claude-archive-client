import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expandEnv, loadConfig, readPackageVersion, WORKER_DIR } from './config.js';
import { createClaudeEngine } from './engines/claude.js';
import { createCodexEngine } from './engines/codex.js';
import type { AnswerMsg, DecisionMsg, Job } from './engines/types.js';
import { createLogger } from './log.js';
import { JobQueue } from './queue.js';
import { findCodexBin, probeClaude, probeCodex, sysStats, type ClaudeProbe, type CodexProbe } from './sys.js';
import { Thumbnailer } from './thumb.js';
import { TopicRegistry } from './topics.js';
import { WorksState } from './upload.js';
import { readLocalVersion, Updater, UPDATE_EXIT_CODE } from './update.js';
import { planSnapshot } from './plan.js';
import { createProcessor, engineOfJob, isWorkFile, WorkQueue, WorkWatcher } from './watch.js';
import { WorkerLink, type Frame } from './ws.js';

const log = createLogger();
const cfg = loadConfig();
const version = readLocalVersion(WORKER_DIR) !== '0.0.0' ? readLocalVersion(WORKER_DIR) : readPackageVersion();
const noUpdate = process.argv.includes('--no-update');

if (!cfg.token) log.warn('config.json 에 token 이 비어 있음. 서버가 접속을 거부합니다.');
try {
  mkdirSync(path.join(WORKER_DIR, 'logs'), { recursive: true });
  writeFileSync(path.join(WORKER_DIR, 'logs', 'worker.pid'), String(process.pid));
} catch {
  /* 설치 스크립트의 정리용일 뿐 */
}
log.info({ worker: cfg.worker_id, endpoint: cfg.endpoint, claude_bin: cfg.claude_bin, archive_mcp: cfg.archive_mcp?.url ?? null, version }, '워커 시작');

// 엔진 확인은 10분 캐시 (재접속마다 프로세스를 띄우지 않게)
let probe: { at: number; v: ClaudeProbe } | null = null;
async function claudeInfo(): Promise<ClaudeProbe> {
  if (!probe || Date.now() - probe.at > 10 * 60_000) {
    probe = { at: Date.now(), v: await probeClaude(cfg.claude_bin) };
    log.info({ claude: probe.v }, '엔진 확인');
  }
  return probe.v;
}

let codexProbe: { at: number; v: CodexProbe } | null = null;
async function codexInfo(): Promise<CodexProbe> {
  if (!codexProbe || Date.now() - codexProbe.at > 10 * 60_000) {
    codexProbe = { at: Date.now(), v: await probeCodex(findCodexBin(WORKER_DIR)) };
    log.info({ codex: codexProbe.v }, '엔진 확인');
  }
  return codexProbe.v;
}

const engines = {
  claude: createClaudeEngine({ claudeBin: cfg.claude_bin, endpoint: cfg.endpoint, token: cfg.token, archive: cfg.archive_mcp, log }),
  codex: createCodexEngine({ endpoint: cfg.endpoint, token: cfg.token, archive: cfg.archive_mcp, log }),
};

const topics = new TopicRegistry({ log });

// ---- 작품: 폴더 감시 + talk 파일 이벤트 → 번들 → 업로드 ----
const worksState = new WorksState(path.join(WORKER_DIR, 'logs', 'works-state.json'));
const thumbs = new Thumbnailer({ log });
const works = new WorkQueue({
  log,
  process: createProcessor({
    endpoint: cfg.endpoint,
    token: cfg.token,
    state: worksState,
    thumb: thumbs,
    topicFor: (f) => topics.topicFor(f)?.id,
    log,
  }),
});
const watcher = new WorkWatcher({ log, onFile: (f) => works.touch(f) });
let frameRoots: string[] = [];
function refreshRoots(): void {
  try {
    watcher.setRoots([...cfg.watch_roots, ...frameRoots, ...topics.list().map((t) => t.folder)]);
  } catch (e) {
    log.warn({ err: String(e) }, '작품 감시 폴더 갱신 실패');
  }
}
refreshRoots();
// 아직 없는 폴더(예: 바탕 화면\claude)가 나중에 생기면 잡는다
setInterval(refreshRoots, 10 * 60_000).unref();

let link: WorkerLink;
const queue = new JobQueue({
  concurrency: cfg.concurrency,
  engines,
  log,
  emit: (job, ev) => {
    if (ev.k !== 'delta') log.info({ job_id: job.job_id, ev: ev.k, ...(ev.k === 'error' ? { kind: ev.kind, msg: ev.message } : {}) }, '이벤트');
    link.send({ t: 'ev', job_id: job.job_id, thread_id: job.thread_id, ev });
    if (ev.k === 'file' && ev.kind !== 'delete' && isWorkFile(ev.path)) {
      works.touch(ev.path, {
        origin: 'talk',
        thread_id: job.thread_id,
        topic_id: topics.topicFor(job.cwd)?.id,
        engine: engineOfJob(job.engine),
      });
    }
  },
});

function onFrame(f: Frame): void {
  switch (f.t) {
    case 'job': {
      const job = f as unknown as Job;
      const bad = topics.guard(job);
      if (bad) {
        log.warn({ job_id: job.job_id, cwd: job.cwd }, '방 폴더 밖의 작업, 거부');
        link.send({ t: 'ev', job_id: job.job_id, thread_id: job.thread_id, ev: bad });
        return;
      }
      queue.add(job);
      return;
    }
    case 'abort':
      if (!queue.abort(String(f.job_id))) log.warn({ job_id: f.job_id }, '멈출 작업 없음');
      return;
    case 'answer':
      if (!queue.answer(f as unknown as AnswerMsg)) log.warn({ job_id: f.job_id }, '답을 받을 작업 없음');
      return;
    case 'decision':
      if (!queue.decision(f as unknown as DecisionMsg)) log.warn({ job_id: f.job_id }, '승인을 받을 작업 없음');
      return;
    case 'topics':
      topics
        .apply(f.topics)
        .then((ack) => {
          log.info({ count: ack.count, errors: ack.errors.length }, '방 매핑표 적용');
          link.send({ ...ack });
          refreshRoots();
        })
        .catch((e) => log.error({ err: String(e) }, '방 매핑표 적용 실패'));
      return;
    case 'watch':
      frameRoots = Array.isArray(f.roots) ? f.roots.filter((r): r is string => typeof r === 'string').map((r) => expandEnv(r)) : [];
      refreshRoots();
      return;
    default:
      log.debug({ t: f.t }, '알 수 없는 프레임');
  }
}

link = new WorkerLink({
  endpoint: cfg.endpoint,
  token: cfg.token,
  workerId: cfg.worker_id,
  log,
  onFrame,
  hello: async () => ({ version, engines: { claude: await claudeInfo(), codex: await codexInfo() }, watch_roots: watcher.roots() }),
  // sys.plan = 구독 사용량(5시간·주간 %). 서버는 sys 를 통째로 저장하므로 서버 스키마를 안 바꿔도 된다
  beat: async () => ({ ...queue.stats(), works: works.stats(), sys: { ...(await sysStats(WORKER_DIR)), plan: planSnapshot() } }),
});
link.start();

let updater: Updater | null = null;
if (cfg.auto_update && !noUpdate) {
  updater = new Updater({
    dir: WORKER_DIR,
    log,
    versionUrl: cfg.update_url,
    zipUrl: cfg.update_zip,
    idle: () => {
      const s = queue.stats();
      return s.running === 0 && s.queue === 0;
    },
    restart: () => quit('update', UPDATE_EXIT_CODE),
  });
  updater.start();
} else {
  log.info({ flag: noUpdate, config: cfg.auto_update }, '자동 업데이트 꺼짐');
}

let quitting = false;
function quit(sig: string, code = 0): void {
  if (quitting) return;
  quitting = true;
  log.info({ sig, code }, '워커 종료');
  updater?.stop();
  process.exitCode = code;
  queue.abortAll();
  works.close();
  worksState.flush();
  void watcher.close();
  void thumbs.close();
  setTimeout(() => {
    link.stop();
    process.exit(code);
  }, 3000).unref();
}
process.on('SIGINT', () => quit('SIGINT'));
process.on('SIGTERM', () => quit('SIGTERM'));
process.on('unhandledRejection', (e) => log.error({ err: String(e) }, '처리 안 된 오류'));
