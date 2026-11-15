import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { WORKER_DIR } from './config.js';

const KEEP_DAYS = 7;

function day(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** logs/worker.log 에 쓰고, 날짜가 바뀌면 worker.YYYY-MM-DD.log 로 넘긴다. 7개까지 보관. */
export class DailyFile {
  private cur: string;
  private readonly file: string;

  constructor(private readonly dir: string, private readonly base = 'worker') {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${base}.log`);
    this.cur = existsSync(this.file) ? day(statSync(this.file).mtime) : day();
    this.rotate();
  }

  private rotate(): void {
    const today = day();
    if (today === this.cur) return;
    if (existsSync(this.file)) {
      try {
        renameSync(this.file, path.join(this.dir, `${this.base}.${this.cur}.log`));
      } catch {
        /* 다른 프로세스가 잡고 있으면 다음 기회에 */
      }
    }
    this.cur = today;
    const re = new RegExp(`^${this.base}\\.\\d{4}-\\d{2}-\\d{2}\\.log$`);
    const old = readdirSync(this.dir).filter((f) => re.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_DAYS))) {
      try {
        unlinkSync(path.join(this.dir, f));
      } catch {
        /* 무시 */
      }
    }
  }

  write(msg: string): void {
    this.rotate();
    try {
      appendFileSync(this.file, msg);
    } catch {
      /* 로그 실패로 워커가 죽지 않게 */
    }
  }
}

export type Logger = pino.Logger;

export function createLogger(opts: { dir?: string; level?: string; file?: boolean } = {}): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (opts.file !== false) {
    streams.push({ stream: new DailyFile(opts.dir ?? path.join(WORKER_DIR, 'logs')) });
  }
  return pino(
    { level: opts.level ?? process.env.LOG_LEVEL ?? 'info', base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  );
}
