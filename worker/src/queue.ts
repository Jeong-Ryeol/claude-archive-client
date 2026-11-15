import { Mailbox } from './inbox.js';
import type { AnswerMsg, DecisionMsg, Engine, Ev, Job } from './engines/types.js';

interface Running {
  job: Job;
  ac: AbortController;
  answers: Mailbox<AnswerMsg>;
  decisions: Mailbox<DecisionMsg>;
}

export interface QueueOpts {
  concurrency: number;
  engines: Record<string, Engine>;
  emit: (job: Job, ev: Ev) => void;
  onIdle?: () => void;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

/** 전역 동시 실행 N개, 스레드당 1개. 나머지는 도착 순서대로 기다린다. */
export class JobQueue {
  private waiting: Job[] = [];
  private running = new Map<string, Running>();
  private seen = new Set<string>();

  constructor(private readonly o: QueueOpts) {}

  stats(): { queue: number; running: number } {
    return { queue: this.waiting.length, running: this.running.size };
  }

  runningJobs(): Job[] {
    return [...this.running.values()].map((r) => r.job);
  }

  add(job: Job): void {
    if (this.seen.has(job.job_id)) {
      this.o.log?.warn({ job_id: job.job_id }, '이미 받은 작업, 무시');
      return;
    }
    this.seen.add(job.job_id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    this.waiting.push(job);
    this.pump();
  }

  abort(job_id: string): boolean {
    const r = this.running.get(job_id);
    if (r) {
      r.ac.abort();
      return true;
    }
    const i = this.waiting.findIndex((j) => j.job_id === job_id);
    if (i >= 0) {
      const [job] = this.waiting.splice(i, 1);
      this.o.emit(job, { k: 'error', kind: 'aborted', message: '실행 전에 멈춤' });
      return true;
    }
    return false;
  }

  answer(msg: AnswerMsg): boolean {
    const r = this.running.get(msg.job_id);
    if (!r) return false;
    r.answers.put(msg.question_id, msg);
    return true;
  }

  decision(msg: DecisionMsg): boolean {
    const r = this.running.get(msg.job_id);
    if (!r) return false;
    r.decisions.put(msg.approval_id, msg);
    return true;
  }

  /** 종료 시 실행 중인 작업을 모두 멈춘다 */
  abortAll(): void {
    for (const r of this.running.values()) r.ac.abort();
    for (const j of this.waiting.splice(0)) {
      this.o.emit(j, { k: 'error', kind: 'aborted', message: '워커 종료' });
    }
  }

  private busyThreads(): Set<string> {
    return new Set([...this.running.values()].map((r) => r.job.thread_id));
  }

  private pump(): void {
    while (this.running.size < this.o.concurrency) {
      const busy = this.busyThreads();
      const i = this.waiting.findIndex((j) => !busy.has(j.thread_id));
      if (i < 0) break;
      const [job] = this.waiting.splice(i, 1);
      this.start(job);
    }
    if (this.running.size === 0 && this.waiting.length === 0) this.o.onIdle?.();
  }

  private start(job: Job): void {
    const r: Running = { job, ac: new AbortController(), answers: new Mailbox(), decisions: new Mailbox() };
    this.running.set(job.job_id, r);
    const engine = this.o.engines[job.engine];
    const emit = (ev: Ev) => this.o.emit(job, ev);
    this.o.log?.info({ job_id: job.job_id, thread_id: job.thread_id, engine: job.engine }, '작업 시작');
    const p = engine
      ? engine.run(job, emit, { answer$: r.answers, decision$: r.decisions, signal: r.ac.signal })
      : Promise.reject(new Error(`지원하지 않는 엔진: ${job.engine}`));
    p.catch((e: unknown) => {
      this.o.log?.error({ job_id: job.job_id, err: String(e) }, '작업 실패');
      emit({ k: 'error', kind: 'other', message: e instanceof Error ? e.message : String(e) });
    }).finally(() => {
      this.running.delete(job.job_id);
      this.o.log?.info({ job_id: job.job_id }, '작업 끝');
      this.pump();
    });
  }
}
