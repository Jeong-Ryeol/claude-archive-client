import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ev, Job } from './engines/types.js';

/** ingest `topics` 프레임의 한 줄 (topics 테이블 행). 워커가 쓰는 필드만 적었다. */
export interface Topic {
  id: string;
  name?: string;
  folder: string;
  rules_md?: string;
  active?: boolean;
  [k: string]: unknown;
}

export interface TopicsAck {
  t: 'topics_ack';
  count: number;
  errors: { id: string; message: string }[];
}

export const DEFAULT_RULES = [
  '# 이 방의 규칙',
  '',
  '- 답은 한국어로.',
  '- 한 번에 질문 1개.',
  '- 이 폴더 밖의 파일은 만들거나 고치지 않는다.',
  '',
].join('\n');

export const CWD_MISMATCH = '작업 폴더가 방 설정과 다릅니다';

const IS_WIN = process.platform === 'win32';
const POSIX_SYSTEM = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/var'];

function systemDirs(env: NodeJS.ProcessEnv): string[] {
  if (!IS_WIN) return POSIX_SYSTEM;
  const drive = env.SystemDrive || 'C:';
  return [
    env.SystemRoot || env.windir || `${drive}\\Windows`,
    env.ProgramFiles || `${drive}\\Program Files`,
    env['ProgramFiles(x86)'] || `${drive}\\Program Files (x86)`,
    env.ProgramData || `${drive}\\ProgramData`,
  ];
}

/** child 가 parent 와 같거나 그 안이면 true (윈도우는 대소문자 무시) */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 방 폴더로 쓸 수 없는 경로면 이유, 괜찮으면 null */
export function folderProblem(folder: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof folder !== 'string' || !folder.trim()) return '폴더가 비어 있음';
  const f = folder.trim();
  // 윈도우의 '\foo' 같은 드라이브 없는 경로도 막는다
  const abs = IS_WIN ? /^[a-zA-Z]:[\\/]|^\\\\[^\\]/.test(f) : path.isAbsolute(f);
  if (!abs) return `절대 경로가 아님: ${f}`;
  const p = path.resolve(f);
  if (path.parse(p).root === p || path.dirname(p) === p) return `드라이브 루트는 쓸 수 없음: ${p}`;
  for (const d of systemDirs(env)) {
    if (isInside(d, p)) return `시스템 폴더는 쓸 수 없음: ${p}`;
  }
  return null;
}

/** 내용이 같으면 쓰지 않는다. 썼으면 true */
async function writeIfChanged(file: string, text: string): Promise<boolean> {
  const next = Buffer.from(text, 'utf8');
  try {
    const cur = await readFile(file);
    if (cur.equals(next)) return false;
  } catch {
    /* 없음 */
  }
  await writeFile(file, next);
  return true;
}

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

/** 방 매핑표. topics 프레임을 받을 때마다 통째로 바꾸고, 폴더·규칙 파일을 맞춘다. */
export class TopicRegistry {
  private topics = new Map<string, Topic & { folder: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { log?: Log; env?: NodeJS.ProcessEnv } = {}) {}

  list(): Topic[] {
    return [...this.topics.values()];
  }

  /**
   * 매핑표를 바꾸고(즉시) 파일 작업을 한다(앞 프레임 처리 뒤에 차례로).
   * 반환값은 ingest 에 돌려줄 topics_ack.
   */
  apply(raw: unknown): Promise<TopicsAck> {
    const list = Array.isArray(raw) ? (raw as Topic[]) : [];
    const errors: TopicsAck['errors'] = [];
    const next = new Map<string, Topic & { folder: string }>();
    for (const t of list) {
      if (!t || typeof t !== 'object' || !t.id) continue;
      if (t.active === false) continue;
      const bad = folderProblem(t.folder, this.o.env);
      if (bad) {
        this.o.log?.warn({ topic: t.id, folder: t.folder, why: bad }, '방 폴더 거부');
        errors.push({ id: String(t.id), message: bad });
        continue;
      }
      next.set(String(t.id), { ...t, folder: path.resolve(String(t.folder).trim()) });
    }
    // job 검증은 바로 새 표로 (파일 작업을 기다리지 않음)
    this.topics = next;
    const run = async (): Promise<TopicsAck> => {
      for (const t of next.values()) {
        try {
          await mkdir(path.join(t.folder, 'uploads'), { recursive: true });
          const rules = typeof t.rules_md === 'string' && t.rules_md.trim() ? t.rules_md : DEFAULT_RULES;
          const a = await writeIfChanged(path.join(t.folder, 'CLAUDE.md'), rules);
          const b = await writeIfChanged(path.join(t.folder, 'AGENTS.md'), rules);
          if (a || b) this.o.log?.info({ topic: t.id, folder: t.folder }, '규칙 파일 갱신');
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.o.log?.warn({ topic: t.id, folder: t.folder, err: message }, '방 폴더 준비 실패');
          errors.push({ id: t.id, message });
        }
      }
      return { t: 'topics_ack', count: next.size, errors };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** cwd 가 활성 방 폴더 안이면 그 방 */
  topicFor(cwd: string): Topic | null {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    for (const t of this.topics.values()) if (isInside(t.folder, cwd)) return t;
    return null;
  }

  /** 실행하면 안 되는 job 이면 돌려보낼 error 이벤트, 괜찮으면 null */
  guard(job: Pick<Job, 'cwd'>): Ev | null {
    return this.topicFor(job.cwd) ? null : { k: 'error', kind: 'other', message: CWD_MISMATCH };
  }
}
