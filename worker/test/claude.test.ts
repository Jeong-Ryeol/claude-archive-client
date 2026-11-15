import { describe, expect, it } from 'vitest';
import { ARCHIVE_APPEND, ARCHIVE_TOOLS } from '../src/archive.js';
import { classifyError, createClaudeEngine, CROSS_CHECK_APPEND } from '../src/engines/claude.js';
import { collector, delta, fakeQuery, init, job, makeCtl, result, toolResult, toolUse, type FakeCtx } from './fake.js';

const QUESTIONS = [
  {
    question: '어느 쪽?',
    header: '선택',
    multiSelect: false,
    options: [
      { label: 'A', description: '첫째' },
      { label: 'B', description: '둘째' },
    ],
  },
];

describe('claude 엔진', () => {
  it('init → delta → AskUserQuestion → answer → result', async () => {
    const seen: { ctx?: FakeCtx } = {};
    let permission: unknown;
    const { ctl, answers } = makeCtl();
    const q = fakeQuery(
      [
        init('sess-9'),
        delta('안'),
        delta('녕'),
        toolUse('tu1', 'AskUserQuestion', { questions: QUESTIONS }),
        async (ctx) => {
          permission = await ctx.options.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, {
            signal: new AbortController().signal,
            toolUseID: 'tu1',
          } as never);
          return [toolResult('tu1')];
        },
        toolUse('tu2', 'Write', { file_path: 'out/새파일.html', content: 'x' }),
        toolResult('tu2'),
        result({ result: '끝' }),
      ],
      seen,
    );
    const engine = createClaudeEngine({ claudeBin: 'claude.exe', query: q });
    const { evs, emit } = collector();
    const wrapped = (e: (typeof evs)[number]) => {
      emit(e);
      if (e.k === 'question') answers.put(e.id, { job_id: 'job-1', question_id: e.id, answers: { '어느 쪽?': 'B' } });
    };
    await engine.run(job({ system_append: '규칙', model: 'sonnet', permission_mode: 'acceptEdits', tools: ['Read'] }), wrapped, ctl);

    expect(evs.map((e) => e.k)).toEqual(['session', 'delta', 'delta', 'tool', 'question', 'tool', 'tool', 'tool', 'file', 'done']);
    expect(evs[0]).toEqual({ k: 'session', id: 'sess-9' });
    expect(permission).toEqual({ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { '어느 쪽?': 'B' } } });
    expect(evs.find((e) => e.k === 'file')).toMatchObject({ kind: 'add' });
    expect(evs.at(-1)).toEqual({ k: 'done', text: '끝', usage: { input: 12, output: 20, cached: 5 }, cost_usd: 0.01, ms: 1234 });

    const o = seen.ctx!.options;
    expect(o.sessionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(o.resume).toBeUndefined();
    expect(o.pathToClaudeCodeExecutable).toBe('claude.exe');
    expect(o.permissionMode).toBe('acceptEdits');
    expect(o.allowedTools).toEqual(['Read']);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: '규칙' });
    expect(o.settingSources).toEqual(['user', 'project']);
    expect(o.includePartialMessages).toBe(true);
    expect(o.maxTurns).toBe(40);
    expect(o.env?.DISABLE_AUTOUPDATER).toBe('1');
    expect(seen.ctx!.firstUser?.message.content).toEqual([{ type: 'text', text: '안녕' }]);
  });

  it('교차검증: MCP 서버 부착·지시 추가·GPT 검증 tool 이벤트', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    const q = fakeQuery(
      [
        init(),
        toolUse('r1', 'mcp__codex__codex_review', { task: '결론 확인', paths: [] }),
        toolResult('r1', false, '문제 없음\n\n(codex 사용량: 입력 1 · 출력 2 · 캐시 0)'),
        result(),
      ],
      seen,
    );
    const { evs, emit } = collector();
    await createClaudeEngine({ claudeBin: 'x', query: q, codexReviewScript: 'C:/w/dist/mcp/codex-review.js' }).run(
      job({ cross_check: true, system_append: '규칙', tools: ['Read'] }),
      emit,
      ctl,
    );
    const o = seen.ctx!.options;
    const srv = (o.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>).codex;
    expect(srv.command).toBe(process.execPath);
    expect(srv.args).toEqual(['C:/w/dist/mcp/codex-review.js']);
    expect(srv.env.TALK_CWD).toBe(process.cwd());
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: `규칙\n\n${CROSS_CHECK_APPEND}` });
    expect(o.allowedTools).toEqual(['Read', 'mcp__codex__codex_review']);
    expect(evs.filter((e) => e.k === 'tool')).toEqual([
      { k: 'tool', name: 'GPT 검증', summary: '결론 확인', status: 'start' },
      { k: 'tool', name: 'GPT 검증', summary: '결론 확인 (codex 사용량: 입력 1 · 출력 2 · 캐시 0)', status: 'done' },
    ]);
  });

  it('맥락(job.context)은 질문 앞에 빈 줄 하나 두고 붙임', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    await createClaudeEngine({ claudeBin: 'x', query: fakeQuery([result()], seen) }).run(
      job({ prompt: '이어서 해줘', context: ' 직전 답변 요약: A 로 하기로 함 ' }),
      () => {},
      ctl,
    );
    expect(seen.ctx!.firstUser?.message.content).toEqual([{ type: 'text', text: '직전 답변 요약: A 로 하기로 함\n\n이어서 해줘' }]);
  });

  it('아카이브 MCP: http 서버·허용 도구·안내 문구를 붙인다', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const archive = { url: 'http://nas:8900/mcp', token: 'tok' };
    const engine = createClaudeEngine({ claudeBin: 'claude.exe', query: fakeQuery([init('s'), result({ result: 'ok' })], seen), archive });
    await engine.run(job({ system_append: '규칙', tools: ['Read'] }), collector().emit, makeCtl().ctl);
    const o = seen.ctx!.options;
    expect(o.mcpServers).toEqual({ archive: { type: 'http', url: 'http://nas:8900/mcp', headers: { Authorization: 'Bearer tok' } } });
    expect(o.allowedTools).toEqual(['Read', ...ARCHIVE_TOOLS]);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: `규칙\n\n${ARCHIVE_APPEND}` });

    // 교차검증과 같이 쓰면 두 서버가 다 붙는다
    await engine.run(job({ cross_check: true }), collector().emit, makeCtl().ctl);
    expect(Object.keys(seen.ctx!.options.mcpServers as object).sort()).toEqual(['archive', 'codex']);

    // 서버가 끄라고 하면(job.archive === false) 붙이지 않는다
    await engine.run(job({ archive: false, tools: ['Read'] }), collector().emit, makeCtl().ctl);
    expect(seen.ctx!.options.mcpServers).toBeUndefined();
    expect(seen.ctx!.options.allowedTools).toEqual(['Read']);
  });

  it('교차검증 아님 → mcpServers 없음', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    await createClaudeEngine({ claudeBin: 'x', query: fakeQuery([result()], seen) }).run(job(), () => {}, ctl);
    expect(seen.ctx!.options.mcpServers).toBeUndefined();
  });

  it('질문 30분 초과 → deny', async () => {
    let permission: unknown;
    const { ctl } = makeCtl();
    const q = fakeQuery([
      async (ctx) => {
        permission = await ctx.options.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, {
          signal: new AbortController().signal,
          toolUseID: 'tu1',
        } as never);
      },
      result(),
    ]);
    const engine = createClaudeEngine({ claudeBin: 'x', query: q, questionTimeoutMs: 20 });
    await engine.run(job(), () => {}, ctl);
    expect(permission).toEqual({ behavior: 'deny', message: '사용자가 30분 안에 답하지 않음. 질문을 짧게 다시 해 주세요.' });
  });

  it('승인 거부 → deny, 이어쓰기는 resume', async () => {
    const seen: { ctx?: FakeCtx } = {};
    let permission: unknown;
    const { ctl, decisions } = makeCtl();
    const q = fakeQuery(
      [
        toolUse('b1', 'Bash', { command: 'npm install' }),
        async (ctx) => {
          permission = await ctx.options.canUseTool!('Bash', { command: 'npm install' }, {
            signal: new AbortController().signal,
            toolUseID: 'b1',
          } as never);
          return [toolResult('b1', true, '거부')];
        },
        result(),
      ],
      seen,
    );
    const engine = createClaudeEngine({ claudeBin: 'x', query: q });
    const { evs, emit } = collector();
    await engine.run(
      job({ resume: 'old-sess' }),
      (e) => {
        emit(e);
        if (e.k === 'approval') decisions.put(e.id, { job_id: 'job-1', approval_id: e.id, allow: false, remember: false });
      },
      ctl,
    );
    expect(permission).toEqual({ behavior: 'deny', message: '사용자가 거부함' });
    expect(evs.find((e) => e.k === 'approval')).toEqual({
      k: 'approval',
      id: 'b1',
      tool: 'Bash',
      summary: 'npm install',
      input: { command: 'npm install' },
    });
    expect(evs.filter((e) => e.k === 'tool').map((e) => (e as { status: string }).status)).toEqual(['start', 'fail']);
    expect(seen.ctx!.options.resume).toBe('old-sess');
    expect(seen.ctx!.options.sessionId).toBeUndefined();
  });

  it('승인 + 기억 → 세션 범위 allow 규칙', async () => {
    let permission: unknown;
    const { ctl, decisions } = makeCtl();
    const q = fakeQuery([
      async (ctx) => {
        permission = await ctx.options.canUseTool!('WebFetch', { url: 'https://a' }, {
          signal: new AbortController().signal,
          toolUseID: 'w1',
        } as never);
      },
      result(),
    ]);
    const engine = createClaudeEngine({ claudeBin: 'x', query: q });
    await engine.run(
      job(),
      (e) => {
        if (e.k === 'approval') decisions.put(e.id, { job_id: 'job-1', approval_id: e.id, allow: true, remember: true });
      },
      ctl,
    );
    expect(permission).toEqual({
      behavior: 'allow',
      updatedInput: { url: 'https://a' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }],
    });
  });

  it('한도 문구 → error limit', async () => {
    const { ctl } = makeCtl();
    const q = fakeQuery([
      init(),
      result({ subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm" }),
    ]);
    const { evs, emit } = collector();
    await createClaudeEngine({ claudeBin: 'x', query: q }).run(job(), emit, ctl);
    expect(evs.at(-1)).toMatchObject({ k: 'error', kind: 'limit' });
    expect(evs.filter((e) => e.k === 'error')).toHaveLength(1);
  });

  it('예외 429 → limit, 로그인 문구 → auth', () => {
    expect(classifyError('API Error: 429 {"type":"error"}')).toBe('limit');
    expect(classifyError('Invalid API key · Please run /login')).toBe('auth');
    expect(classifyError('something else')).toBe('other');
  });

  it('턴 토큰 상한 초과 → error budget 후 interrupt', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    const q = fakeQuery([init(), delta('가'.repeat(30)), delta('나'.repeat(30)), delta('다'.repeat(30))], seen);
    const { evs, emit } = collector();
    await createClaudeEngine({ claudeBin: 'x', query: q, stopGraceMs: 50 }).run(job({ budget: { turn_tokens: 15 } }), emit, ctl);
    expect(seen.ctx!.interrupted).toBe(true);
    const errs = evs.filter((e) => e.k === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ kind: 'budget' });
    expect(evs.filter((e) => e.k === 'delta')).toHaveLength(2);
    expect(evs.some((e) => e.k === 'done')).toBe(false);
  });

  it('멈춤 → interrupt 후 error aborted', async () => {
    const seen: { ctx?: FakeCtx } = {};
    const { ctl, ac } = makeCtl();
    const q = fakeQuery([init(), delta('하나')], seen);
    const { evs, emit } = collector();
    const p = createClaudeEngine({ claudeBin: 'x', query: q, stopGraceMs: 50 }).run(job(), emit, ctl);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(seen.ctx!.interrupted).toBe(true);
    expect(evs.at(-1)).toMatchObject({ k: 'error', kind: 'aborted' });
  });

  it('첨부 이미지 → uploads/ 저장 + base64 블록', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    let headers: unknown;
    const fakeFetch = (async (_u: URL, init: { headers: unknown }) => {
      headers = init.headers;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const q = fakeQuery([result()], seen);
    await createClaudeEngine({ claudeBin: 'x', query: q, endpoint: 'http://nas:8800', token: 'tk', fetch: fakeFetch }).run(
      job({ cwd: dir, attachments: [{ name: '사진.png', url: '/api/talk/attach/1' }] }),
      () => {},
      ctl,
    );
    expect(headers).toEqual({ 'X-Ingest-Token': 'tk' });
    expect(fs.readFileSync(path.join(dir, 'uploads', '사진.png'))).toEqual(Buffer.from([1, 2, 3]));
    const content = seen.ctx!.firstUser!.message.content as Array<{ type: string; source?: { data: string } }>;
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } });
    expect(content[1].type).toBe('text');
  });

  it('첨부 실패는 턴을 막지 않고 프롬프트에 한 줄', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
    const seen: { ctx?: FakeCtx } = {};
    const { ctl } = makeCtl();
    const { evs, emit } = collector();
    const fakeFetch = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await createClaudeEngine({ claudeBin: 'x', query: fakeQuery([result()], seen), endpoint: 'http://nas:8800', fetch: fakeFetch }).run(
      job({ cwd: dir, prompt: '봐줘', attachments: [{ name: '사진.png', url: '/api/talk/attach/1' }] }),
      emit,
      ctl,
    );
    expect(evs.at(-1)).toMatchObject({ k: 'done' });
    const content = seen.ctx!.firstUser!.message.content as Array<{ type: string; text?: string }>;
    expect(content).toEqual([{ type: 'text', text: '봐줘\n\n첨부 내려받기 실패: 사진.png' }]);
  });
});
