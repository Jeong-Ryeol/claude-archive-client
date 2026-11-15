import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../src/engines/claude.js';
import { Mailbox } from '../src/inbox.js';
import type { AnswerMsg, DecisionMsg, EngineCtl, Ev, Job } from '../src/engines/types.js';

export type Step = SDKMessage | ((ctx: FakeCtx) => Promise<SDKMessage[] | void> | SDKMessage[] | void);

export interface FakeCtx {
  options: Options;
  firstUser: SDKUserMessage | null;
  interrupted: boolean;
}

/** 스크립트대로 SDK 메시지를 흘리는 가짜 query. 함수 단계는 canUseTool 호출 등에 쓴다. */
export function fakeQuery(steps: Step[], seen: { ctx?: FakeCtx } = {}): QueryFn {
  return ({ prompt, options }) => {
    const ctx: FakeCtx = { options, firstUser: null, interrupted: false };
    seen.ctx = ctx;
    let wake: (() => void) | null = null;
    async function* it(): AsyncGenerator<SDKMessage> {
      const r = await prompt[Symbol.asyncIterator]().next();
      ctx.firstUser = r.value ?? null;
      for (const s of steps) {
        if (ctx.interrupted) {
          yield result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
          return;
        }
        if (options.abortController?.signal.aborted) throw new Error('aborted');
        if (typeof s === 'function') {
          const out = await s(ctx);
          for (const m of out ?? []) yield m;
        } else yield s;
      }
      // 스크립트가 끝났는데 result 가 없으면 interrupt/abort 까지 멈춰 있는다
      await new Promise<void>((res) => {
        wake = res;
        options.abortController?.signal.addEventListener('abort', () => res());
      });
      if (ctx.interrupted) yield result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
    }
    const g = it();
    return Object.assign(g, {
      interrupt: async () => {
        ctx.interrupted = true;
        wake?.();
      },
      close: () => {},
    });
  };
}

const base = { uuid: '00000000-0000-0000-0000-000000000000' as const, session_id: 'sess-1' };

export function init(id = 'sess-1'): SDKMessage {
  return { type: 'system', subtype: 'init', ...base, session_id: id } as unknown as SDKMessage;
}
export function delta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ...base,
  } as unknown as SDKMessage;
}
export function toolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg-' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...base,
  } as unknown as SDKMessage;
}
export function toolResult(id: string, isError = false, content = 'ok'): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
    ...base,
  } as unknown as SDKMessage;
}
export function result(o: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '완료',
    duration_ms: 1234,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    errors: [],
    ...base,
    ...o,
  } as unknown as SDKMessage;
}

export function makeCtl() {
  const answers = new Mailbox<AnswerMsg>();
  const decisions = new Mailbox<DecisionMsg>();
  const ac = new AbortController();
  const ctl: EngineCtl = { answer$: answers, decision$: decisions, signal: ac.signal };
  return { ctl, answers, decisions, ac };
}

export function job(o: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    thread_id: '11111111-1111-1111-1111-111111111111',
    engine: 'claude',
    resume: null,
    cwd: process.cwd(),
    prompt: '안녕',
    ...o,
  };
}

export function collector() {
  const evs: Ev[] = [];
  return { evs, emit: (e: Ev) => evs.push(e) };
}
