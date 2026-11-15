import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Input, ThreadEvent, ThreadItem, ThreadOptions } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_APPEND, codexArchiveOptions } from '../src/archive.js';
import { buildCodexInput, classifyCodexError, createCodexEngine, type CodexLike } from '../src/engines/codex.js';
import { runReview, reviewOptions } from '../src/mcp/codex-review.js';
import { parseCodexLogin, probeCodex } from '../src/sys.js';
import { JobQueue } from '../src/queue.js';
import type { Engine, Ev } from '../src/engines/types.js';
import { collector, job, makeCtl } from './fake.js';

type Step = ThreadEvent | 'hang' | Error;

interface Seen {
  method?: 'start' | 'resume';
  resumeId?: string;
  opts?: ThreadOptions;
  input?: Input;
  signal?: AbortSignal;
}

/** 스크립트대로 ThreadEvent 를 흘리는 가짜 Codex. 'hang' 이면 signal 이 끊길 때까지 멈춘다. */
function fakeCodex(steps: Step[], seen: Seen = {}): CodexLike {
  const thread = {
    id: null,
    async runStreamed(input: Input, o?: { signal?: AbortSignal }) {
      seen.input = input;
      seen.signal = o?.signal;
      async function* gen(): AsyncGenerator<ThreadEvent> {
        for (const s of steps) {
          if (o?.signal?.aborted) throw new Error('aborted');
          if (s === 'hang') {
            await new Promise<void>((res) => o?.signal?.addEventListener('abort', () => res()));
            throw new Error('aborted');
          }
          if (s instanceof Error) throw s;
          yield s;
        }
      }
      return { events: gen() };
    },
  };
  return {
    startThread(opts) {
      seen.method = 'start';
      seen.opts = opts;
      return thread;
    },
    resumeThread(id, opts) {
      seen.method = 'resume';
      seen.resumeId = id;
      seen.opts = opts;
      return thread;
    },
  };
}

const started = (id = 'th-1'): ThreadEvent => ({ type: 'thread.started', thread_id: id });
const itemStarted = (item: ThreadItem): ThreadEvent => ({ type: 'item.started', item });
const itemDone = (item: ThreadItem): ThreadEvent => ({ type: 'item.completed', item });
const msg = (text: string, id = 'm' + text.length): ThreadEvent => itemDone({ id, type: 'agent_message', text });
const completed = (): ThreadEvent => ({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 3 },
});
const failed = (message: string): ThreadEvent => ({ type: 'turn.failed', error: { message } });

async function runWith(steps: Step[], j = job({ engine: 'codex' }), seen: Seen = {}) {
  const { ctl, ac } = makeCtl();
  const { evs, emit } = collector();
  const p = createCodexEngine({ codex: fakeCodex(steps, seen) }).run(j, emit, ctl);
  return { p, evs, ac, seen };
}

describe('codex 엔진', () => {
  it('thread.started → agent_message → turn.completed (usage)', async () => {
    const seen: Seen = {};
    const { p, evs } = await runWith([started('th-9'), { type: 'turn.started' }, msg('첫 답'), msg('둘째 답'), completed()], undefined, seen);
    await p;
    expect(evs.map((e) => e.k)).toEqual(['session', 'delta', 'delta', 'done']);
    expect(evs[0]).toEqual({ k: 'session', id: 'th-9' });
    expect(evs[1]).toEqual({ k: 'delta', text: '첫 답' });
    expect(evs.at(-1)).toMatchObject({ k: 'done', text: '첫 답\n\n둘째 답', usage: { input: 100, output: 7, cached: 40 } });
    expect(typeof (evs.at(-1) as { ms: number }).ms).toBe('number');
    expect(seen.method).toBe('start');
    expect(seen.opts).toEqual({
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      model: undefined,
      networkAccessEnabled: true,
      webSearchMode: 'live',
    });
    expect(seen.input).toEqual([{ type: 'text', text: '안녕' }]);
  });

  it('이어쓰기는 resumeThread, 샌드박스·모델 반영, danger-full-access 는 막음', async () => {
    const s1: Seen = {};
    await (await runWith([completed()], job({ engine: 'codex', resume: 'th-old', sandbox: 'read-only', model: 'gpt-5.5' }), s1)).p;
    expect(s1.method).toBe('resume');
    expect(s1.resumeId).toBe('th-old');
    expect(s1.opts).toMatchObject({ sandboxMode: 'read-only', model: 'gpt-5.5' });
    const s2: Seen = {};
    await (await runWith([completed()], job({ engine: 'codex', sandbox: 'danger-full-access' }), s2)).p;
    expect(s2.opts?.sandboxMode).toBe('workspace-write');
  });

  it('명령·파일·검색·MCP 매핑', async () => {
    const cmd = { id: 'c1', type: 'command_execution' as const, command: 'npm   test ' + 'x'.repeat(80), aggregated_output: '', status: 'in_progress' as const };
    const { p, evs } = await runWith([
      started(),
      itemStarted(cmd),
      { type: 'item.updated', item: { ...cmd, aggregated_output: '...' } },
      itemDone({ ...cmd, aggregated_output: 'ok', exit_code: 0, status: 'completed' }),
      itemStarted({ id: 'c2', type: 'command_execution', command: 'false', aggregated_output: '', status: 'in_progress' }),
      itemDone({ id: 'c2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' }),
      itemDone({
        id: 'f1',
        type: 'file_change',
        status: 'completed',
        changes: [
          { path: 'out/a.html', kind: 'add' },
          { path: path.join(process.cwd(), 'b.txt'), kind: 'update' },
        ],
      }),
      itemDone({ id: 'f2', type: 'file_change', status: 'failed', changes: [{ path: 'nope.txt', kind: 'add' }] }),
      itemDone({ id: 'w1', type: 'web_search', query: '서울 날씨' }),
      itemStarted({ id: 'p1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'in_progress' }),
      itemDone({ id: 'p1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'completed' }),
      msg('끝'),
      completed(),
    ]);
    await p;
    const tools = evs.filter((e): e is Extract<Ev, { k: 'tool' }> => e.k === 'tool');
    expect(tools).toEqual([
      { k: 'tool', name: '명령', summary: ('npm test ' + 'x'.repeat(80)).slice(0, 60), status: 'start' },
      { k: 'tool', name: '명령', summary: ('npm test ' + 'x'.repeat(80)).slice(0, 60), status: 'done' },
      { k: 'tool', name: '명령', summary: 'false', status: 'start' },
      { k: 'tool', name: '명령', summary: 'false', status: 'fail' },
      { k: 'tool', name: '검색', summary: '서울 날씨', status: 'done' },
      { k: 'tool', name: 'docs.search', summary: '{"q":"x"}', status: 'start' },
      { k: 'tool', name: 'docs.search', summary: '{"q":"x"}', status: 'done' },
    ]);
    expect(evs.filter((e) => e.k === 'file')).toEqual([
      { k: 'file', path: path.resolve(process.cwd(), 'out/a.html'), kind: 'add' },
      { k: 'file', path: path.join(process.cwd(), 'b.txt'), kind: 'update' },
    ]);
    expect(evs.at(-1)).toMatchObject({ k: 'done', text: '끝' });
  });

  it('turn.failed → limit / auth / other', async () => {
    for (const [m, kind] of [
      ["You've hit your usage limit. Try again at 5:00 PM.", 'limit'],
      ['stream error: 429 Too Many Requests', 'limit'],
      ['401 Unauthorized: Please log in again', 'auth'],
      ['Not logged in. Run codex login', 'auth'],
      ['model overloaded', 'other'],
    ] as const) {
      const { p, evs } = await runWith([started(), failed(m)]);
      await p;
      const errs = evs.filter((e) => e.k === 'error');
      expect(errs).toEqual([
        kind === 'auth'
          ? { k: 'error', kind, message: 'ChatGPT 로그인이 필요합니다 (노트북에서 codex login)', detail: m }
          : { k: 'error', kind, message: m },
      ]);
    }
  });

  it('error 이벤트 뒤 프로세스 종료 → 그 문구로 error 한 번', async () => {
    const { p, evs } = await runWith([started(), { type: 'error', message: 'Quota exceeded' }, new Error('Codex Exec exited with code 1: ')]);
    await p;
    expect(evs.filter((e) => e.k === 'error')).toEqual([{ k: 'error', kind: 'limit', message: 'Quota exceeded' }]);
  });

  it('회복된 error 이벤트는 done 을 막지 않음', async () => {
    const { p, evs } = await runWith([started(), { type: 'error', message: 'Reconnecting... 1/5' }, msg('됨'), completed()]);
    await p;
    expect(evs.at(-1)).toMatchObject({ k: 'done', text: '됨' });
    expect(evs.filter((e) => e.k === 'error')).toHaveLength(0);
  });

  it('멈춤 → signal 로 프로세스 종료, error aborted', async () => {
    const { p, evs, ac, seen } = await runWith([started(), msg('하나'), 'hang']);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(seen.signal?.aborted).toBe(true);
    expect(evs.filter((e) => e.k === 'error')).toEqual([{ k: 'error', kind: 'aborted', message: '사용자가 멈춤' }]);
  });

  it('턴 토큰 상한 초과 → error budget 후 중단', async () => {
    const { p, evs, seen } = await runWith(
      [started(), msg('가'.repeat(30), 'a'), msg('나'.repeat(30), 'b'), msg('다'.repeat(30), 'c'), completed()],
      job({ engine: 'codex', budget: { turn_tokens: 15 } }),
    );
    await p;
    expect(seen.signal?.aborted).toBe(true);
    expect(evs.filter((e) => e.k === 'delta')).toHaveLength(2);
    expect(evs.filter((e) => e.k === 'error')).toEqual([expect.objectContaining({ kind: 'budget' })]);
    expect(evs.some((e) => e.k === 'done')).toBe(false);
  });

  it('맥락 앞에 붙이기 + 첨부 이미지 local_image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
    const seen: Seen = {};
    const { ctl } = makeCtl();
    const fakeFetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    await createCodexEngine({ codex: fakeCodex([completed()], seen), endpoint: 'http://nas:8800', fetch: fakeFetch }).run(
      job({
        engine: 'codex',
        cwd: dir,
        prompt: '이거 봐줘',
        context: '직전 답변 요약: A 로 하기로 함',
        attachments: [
          { name: '사진.png', url: '/api/talk/attach/1' },
          { name: '메모.txt', url: '/api/talk/attach/2' },
        ],
      }),
      () => {},
      ctl,
    );
    const png = path.join(dir, 'uploads', '사진.png');
    const txt = path.join(dir, 'uploads', '메모.txt');
    expect(seen.input).toEqual([
      { type: 'text', text: `직전 답변 요약: A 로 하기로 함\n\n이거 봐줘\n\n첨부 파일: ${png}\n첨부 파일: ${txt}` },
      { type: 'local_image', path: png },
    ]);
  });

  it('아카이브 MCP: Codex 설정 덮어쓰기·토큰 환경변수·안내 문구', async () => {
    const archive = { url: 'http://nas:8900/mcp', token: 'tok' };
    expect(codexArchiveOptions({ A: '1' }, archive)).toEqual({
      env: { A: '1', ARCHIVE_MCP_TOKEN: 'tok' },
      config: { mcp_servers: { archive: { url: 'http://nas:8900/mcp', bearer_token_env_var: 'ARCHIVE_MCP_TOKEN' } } },
    });
    expect(codexArchiveOptions({ A: '1' }, null)).toEqual({ env: { A: '1' } });
    expect(buildCodexInput(job({ prompt: 'q', context: '맥락' }), undefined, ARCHIVE_APPEND)).toEqual([
      { type: 'text', text: `${ARCHIVE_APPEND}\n\n맥락\n\nq` },
    ]);

    // 엔진: archive 가 있으면 프롬프트 앞에 안내가 붙고, job.archive === false 면 안 붙는다
    const seen: Seen = {};
    const done: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as ThreadEvent,
    ];
    const engine = createCodexEngine({ codex: fakeCodex(done, seen), archive });
    await engine.run(job({ prompt: 'q' }), collector().emit, makeCtl().ctl);
    expect((seen.input as { text: string }[])[0].text).toBe(`${ARCHIVE_APPEND}\n\nq`);
    await engine.run(job({ prompt: 'q', archive: false }), collector().emit, makeCtl().ctl);
    expect((seen.input as { text: string }[])[0].text).toBe('q');
  });

  it('buildCodexInput: 맥락 없음·첨부 실패', () => {
    expect(buildCodexInput(job({ prompt: 'q', context: '  ' }), { files: [], failed: ['x.png'] })).toEqual([
      { type: 'text', text: 'q\n\n첨부 내려받기 실패: x.png' },
    ]);
  });

  it('classifyCodexError', () => {
    expect(classifyCodexError('rate limit reached')).toBe('limit');
    expect(classifyCodexError('insufficient_quota')).toBe('limit');
    expect(classifyCodexError('unexpected status 401')).toBe('auth');
    expect(classifyCodexError('boom')).toBe('other');
  });
});

describe('엔진 선택', () => {
  it('job.engine 으로 고르고 모르는 엔진은 error', async () => {
    const ran: string[] = [];
    const mk = (name: string): Engine => ({
      async run(_j, emit) {
        ran.push(name);
        emit({ k: 'done', text: name, usage: { input: 0, output: 0, cached: 0 }, ms: 0 });
      },
    });
    const evs: Array<[string, Ev]> = [];
    const q = new JobQueue({ concurrency: 3, engines: { claude: mk('claude'), codex: mk('codex') }, emit: (j, e) => evs.push([j.job_id, e]) });
    q.add(job({ job_id: 'j1', thread_id: 'A', engine: 'codex' }));
    q.add(job({ job_id: 'j2', thread_id: 'B', engine: 'claude' }));
    q.add(job({ job_id: 'j3', thread_id: 'C', engine: 'gemini' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(ran.sort()).toEqual(['claude', 'codex']);
    expect(evs.find(([id]) => id === 'j3')?.[1]).toEqual({ k: 'error', kind: 'other', message: '지원하지 않는 엔진: gemini' });
  });
});

describe('codex 확인 (hello)', () => {
  it('login status 해석', () => {
    expect(parseCodexLogin('Not logged in')).toBe(false);
    expect(parseCodexLogin('Logged in using ChatGPT')).toBe('chatgpt');
    expect(parseCodexLogin('Logged in using an API key - sk-proj-***abcd')).toBe('api');
    expect(parseCodexLogin('')).toBeNull();
  });

  it('probeCodex: 버전·로그인만 실행', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, args: string[]) => {
      calls.push(args);
      return args[0] === '--version' ? { code: 0, out: 'codex-cli 0.163.0' } : { code: 0, out: 'Logged in using ChatGPT' };
    };
    expect(await probeCodex('C:/x/codex.exe', run)).toEqual({ ok: true, version: '0.163.0', login: 'chatgpt', path: 'C:/x/codex.exe' });
    expect(calls).toEqual([['--version'], ['login', 'status']]);
    expect(await probeCodex(null, run)).toEqual({ ok: false, version: null, login: null, path: '' });
  });
});

describe('교차검증 MCP runReview', () => {
  it('읽기 전용 옵션, 마지막 메시지 2,000자 + 사용량 한 줄', async () => {
    const seen: Seen = {};
    const long = '가'.repeat(3000);
    const r = await runReview('결론: X 가 맞다', ['src/a.ts'], {
      codex: fakeCodex([started(), msg('중간'), msg(long, 'z'), completed()], seen),
      cwd: 'C:/rooms/code',
    });
    expect(seen.method).toBe('start');
    expect(seen.opts).toEqual(reviewOptions(path.resolve('C:/rooms/code')));
    expect(seen.opts).toMatchObject({ sandboxMode: 'read-only', modelReasoningEffort: 'low', webSearchMode: 'disabled', approvalPolicy: 'never' });
    expect(String(seen.input)).toContain('결론: X 가 맞다');
    expect(String(seen.input)).toContain('- src/a.ts');
    expect(r.isError).toBe(false);
    const [body, note] = r.text.split('\n\n');
    expect(body.length).toBe(2000);
    expect(note).toBe('(codex 사용량: 입력 100 · 출력 7 · 캐시 40)');
  });

  it('실패 → isError', async () => {
    const r = await runReview('x', undefined, { codex: fakeCodex([started(), failed('usage limit')]), cwd: process.cwd() });
    expect(r).toEqual({ text: 'Codex 교차검증 실패: usage limit', isError: true });
  });
});
