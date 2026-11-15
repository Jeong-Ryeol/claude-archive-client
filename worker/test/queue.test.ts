import { describe, expect, it } from 'vitest';
import type { Engine, Ev, Job } from '../src/engines/types.js';
import { JobQueue } from '../src/queue.js';
import { job } from './fake.js';

/** 신호가 오거나 release 될 때까지 도는 가짜 엔진 */
function slowEngine(log: string[]) {
  const releases = new Map<string, () => void>();
  const engine: Engine = {
    async run(j, emit, ctl) {
      log.push('start:' + j.job_id);
      await new Promise<void>((res) => {
        releases.set(j.job_id, res);
        ctl.signal.addEventListener('abort', () => {
          emit({ k: 'error', kind: 'aborted', message: '멈춤' });
          res();
        });
      });
      log.push('end:' + j.job_id);
    },
  };
  return { engine, release: (id: string) => releases.get(id)?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('작업 큐', () => {
  it('전역 2개, 같은 스레드는 순서대로', async () => {
    const log: string[] = [];
    const { engine, release } = slowEngine(log);
    const q = new JobQueue({ concurrency: 2, engines: { claude: engine }, emit: () => {} });
    q.add(job({ job_id: 'a1', thread_id: 'A' }));
    q.add(job({ job_id: 'a2', thread_id: 'A' }));
    q.add(job({ job_id: 'b1', thread_id: 'B' }));
    q.add(job({ job_id: 'c1', thread_id: 'C' }));
    await tick();
    // a2 는 A 가 돌고 있어 건너뛰고 b1 이 먼저
    expect(log).toEqual(['start:a1', 'start:b1']);
    expect(q.stats()).toEqual({ queue: 2, running: 2 });
    release('a1');
    await tick();
    expect(log.slice(2)).toEqual(['end:a1', 'start:a2']);
    release('b1');
    await tick();
    expect(log).toContain('start:c1');
    release('a2');
    release('c1');
    await tick();
    expect(q.stats()).toEqual({ queue: 0, running: 0 });
  });

  it('abort: 실행 중이면 신호, 대기 중이면 빼고 aborted', async () => {
    const log: string[] = [];
    const evs: Array<[string, Ev]> = [];
    const { engine } = slowEngine(log);
    const q = new JobQueue({ concurrency: 1, engines: { claude: engine }, emit: (j: Job, e) => evs.push([j.job_id, e]) });
    q.add(job({ job_id: 'x', thread_id: 'X' }));
    q.add(job({ job_id: 'y', thread_id: 'Y' }));
    await tick();
    expect(q.abort('y')).toBe(true);
    expect(evs).toEqual([['y', { k: 'error', kind: 'aborted', message: '실행 전에 멈춤' }]]);
    expect(q.abort('x')).toBe(true);
    await tick();
    expect(evs[1]).toEqual(['x', { k: 'error', kind: 'aborted', message: '멈춤' }]);
    expect(log).toEqual(['start:x', 'end:x']);
    expect(q.abort('nope')).toBe(false);
  });

  it('answer/decision 은 job_id 로 해당 작업에 전달', async () => {
    let got: unknown[] = [];
    const engine: Engine = {
      async run(_j, _e, ctl) {
        got = await Promise.all([ctl.answer$.wait('q1', 1000), ctl.decision$.wait('p1', 1000)]);
      },
    };
    const q = new JobQueue({ concurrency: 2, engines: { claude: engine }, emit: () => {} });
    q.add(job({ job_id: 'j' }));
    await tick();
    expect(q.answer({ job_id: 'other', question_id: 'q1', answers: {} })).toBe(false);
    expect(q.answer({ job_id: 'j', question_id: 'q1', answers: { a: 'b' } })).toBe(true);
    expect(q.decision({ job_id: 'j', approval_id: 'p1', allow: true, remember: false })).toBe(true);
    await tick();
    expect(got).toEqual([
      { job_id: 'j', question_id: 'q1', answers: { a: 'b' } },
      { job_id: 'j', approval_id: 'p1', allow: true, remember: false },
    ]);
  });

  it('모르는 엔진 → error other', async () => {
    const evs: Ev[] = [];
    const q = new JobQueue({ concurrency: 1, engines: {}, emit: (_j, e) => evs.push(e) });
    q.add(job({ engine: 'codex' }));
    await tick();
    expect(evs[0]).toMatchObject({ k: 'error', kind: 'other' });
  });
});
