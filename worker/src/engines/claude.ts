import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ARCHIVE_APPEND, ARCHIVE_SERVER, ARCHIVE_TOOLS, type ArchiveMcp } from '../archive.js';
import { WORKER_DIR } from '../config.js';
import { attachmentLines, downloadAttachments, type DownloadResult } from '../attach.js';
import type { Engine, EngineCtl, Ev, Job } from './types.js';
import { friendlyError } from './errors.js';

export type QueryFn = (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  interrupt(): Promise<unknown>;
  close?(): void;
};

export interface ClaudeDeps {
  claudeBin: string;
  endpoint?: string;
  token?: string;
  query?: QueryFn;
  fetch?: typeof fetch;
  questionTimeoutMs?: number;
  stopGraceMs?: number;
  defaultTurnTokens?: number;
  /** 교차검증 MCP 서버 스크립트(빌드된 dist/mcp/codex-review.js) */
  codexReviewScript?: string;
  /** 아카이브 검색 MCP (있으면 모든 턴에 붙인다. job.archive === false 면 뺀다) */
  archive?: ArchiveMcp | null;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export const QUESTION_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_TURN_TOKENS = 60_000;
const DISALLOWED = ['Bash(rm -rf *)', 'Bash(format *)', 'Bash(del /s *)'];
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];
export const REVIEW_TOOL = 'mcp__codex__codex_review';
export const CROSS_CHECK_APPEND = '답을 확정하기 전에 codex_review 도구로 한 번 교차검증하고, 의견이 갈리면 둘 다 짧게 적어라.';
const REVIEW_LABEL = 'GPT 검증';

const RE_LIMIT = /\b429\b|rate[ _-]?limit|usage limit|limit reached|hit your limit|too many requests|한도/i;
const RE_AUTH =
  /authentication_failed|\b401\b|invalid api key|not logged in|please run \/login|oauth token.*(expired|revoked)|log ?in again|login required|unauthorized/i;

export function classifyError(text: string): 'limit' | 'auth' | 'other' {
  if (RE_LIMIT.test(text)) return 'limit';
  if (RE_AUTH.test(text)) return 'auth';
  return 'other';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 도구별 한 줄 요약 */
export function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(i.file_path);
    case 'NotebookEdit':
      return str(i.notebook_path);
    case 'Bash':
      return str(i.command).replace(/\s+/g, ' ').slice(0, 60);
    case 'WebSearch':
      return str(i.query);
    case 'WebFetch':
      return str(i.url);
    case 'Glob':
    case 'Grep':
      return str(i.pattern);
    case 'Agent':
    case 'Task':
      return str(i.description);
    case REVIEW_TOOL:
      return str(i.task).replace(/\s+/g, ' ').slice(0, 60);
    case 'AskUserQuestion':
      return str((i.questions as { question?: string }[] | undefined)?.[0]?.question).slice(0, 60);
    default: {
      const s = JSON.stringify(input ?? '');
      return s.length > 60 ? s.slice(0, 60) + '…' : s;
    }
  }
}

function filePathOf(name: string, input: Record<string, unknown>): string {
  return name === 'NotebookEdit' ? str(input.notebook_path) : str(input.file_path);
}

function textOfToolResult(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('');
  return '';
}

export function buildUserMessage(prompt: string, att: DownloadResult = { files: [], failed: [] }): SDKUserMessage {
  const blocks: Array<Record<string, unknown>> = [];
  for (const f of att.files) {
    if (f.mime) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } });
    }
  }
  const lines = attachmentLines(att);
  blocks.push({ type: 'text', text: lines ? `${prompt}\n\n${lines}` : prompt });
  return {
    type: 'user',
    message: { role: 'user', content: blocks as never },
    parent_tool_use_id: null,
  };
}

type ToolRec = { name: string; summary: string; file?: string; existed?: boolean };
type QuestionList = Extract<Ev, { k: 'question' }>['questions'];

export function createClaudeEngine(deps: ClaudeDeps): Engine {
  const query = deps.query ?? (sdkQuery as unknown as QueryFn);
  const qTimeout = deps.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
  const grace = deps.stopGraceMs ?? 2000;

  return {
    async run(job: Job, emitRaw: (ev: Ev) => void, ctl: EngineCtl): Promise<void> {
      const t0 = Date.now();
      let ended = false; // done/error 는 한 번만
      const emit = (ev: Ev) => {
        if (ended) return;
        if (ev.k === 'done' || ev.k === 'error') ended = true;
        emitRaw(friendlyError('claude', ev));
      };

      if (ctl.signal.aborted) return emit({ k: 'error', kind: 'aborted', message: '사용자가 멈춤' });
      if (!path.isAbsolute(job.cwd)) {
        return emit({ k: 'error', kind: 'other', message: `작업 폴더가 절대 경로가 아님: ${job.cwd}` });
      }
      mkdirSync(job.cwd, { recursive: true });

      // 첨부 실패는 턴을 막지 않고 프롬프트에 한 줄로 알린다
      const files = await downloadAttachments(
        job.cwd,
        job.attachments ?? [],
        { endpoint: deps.endpoint ?? 'http://localhost', token: deps.token ?? '', fetch: deps.fetch },
        deps.log,
      );

      const abortController = new AbortController();
      let stopReason: 'aborted' | 'budget' | null = null;
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      let q: ReturnType<QueryFn> | null = null;
      let killTimer: NodeJS.Timeout | undefined;

      // 멈춤: interrupt 후 grace 안에 안 끝나면 프로세스 abort
      const stop = (why: 'aborted' | 'budget') => {
        if (stopReason) return;
        stopReason = why;
        finish();
        q?.interrupt().catch(() => {});
        killTimer = setTimeout(() => abortController.abort(), grace);
      };
      const onCtlAbort = () => stop('aborted');
      ctl.signal.addEventListener('abort', onCtlAbort, { once: true });
      if (ctl.signal.aborted) stop('aborted');

      // 예산: 글자수 추정과 API usage(캐시 읽기 제외) 중 큰 값
      const limit = job.budget?.turn_tokens ?? deps.defaultTurnTokens ?? DEFAULT_TURN_TOKENS;
      let estChars = 0;
      const apiUsage = new Map<string, number>();
      const estimate = () => {
        let byApi = 0;
        for (const v of apiUsage.values()) byApi += v;
        return Math.max(Math.ceil(estChars / 3), byApi);
      };
      const checkBudget = () => {
        if (stopReason || !(limit > 0)) return;
        const used = estimate();
        if (used > limit) {
          emit({ k: 'error', kind: 'budget', message: `이번 턴 토큰 상한(${limit}) 초과로 멈춤 (추정 ${used})` });
          stop('budget');
        }
      };

      const tools = new Map<string, ToolRec>();
      let hintKind: 'limit' | 'auth' | null = null;

      const canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
        const id = opts.toolUseID;
        const sig = AbortSignal.any([opts.signal, ctl.signal]);
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions?: QuestionList }).questions as QuestionList;
          emit({ k: 'question', id, questions });
          let a;
          try {
            a = await ctl.answer$.wait(id, qTimeout, sig);
          } catch {
            return { behavior: 'deny', message: '사용자가 멈춤', interrupt: true };
          }
          if (!a) return { behavior: 'deny', message: '사용자가 30분 안에 답하지 않음. 질문을 짧게 다시 해 주세요.' };
          const updated: Record<string, unknown> = { questions, answers: a.answers };
          if (a.response && questions?.[0]) updated.annotations = { [questions[0].question]: { notes: a.response } };
          return { behavior: 'allow', updatedInput: updated };
        }
        emit({ k: 'approval', id, tool: toolName, summary: summarize(toolName, input), input });
        let d;
        try {
          d = await ctl.decision$.wait(id, qTimeout, sig);
        } catch {
          return { behavior: 'deny', message: '사용자가 멈춤', interrupt: true };
        }
        if (!d) return { behavior: 'deny', message: '사용자가 30분 안에 응답하지 않음' };
        if (!d.allow) return { behavior: 'deny', message: '사용자가 거부함' };
        let updatedPermissions: PermissionUpdate[] | undefined;
        if (d.remember) {
          updatedPermissions = opts.suggestions?.length
            ? opts.suggestions.map((s) => ({ ...s, destination: 'session' }) as PermissionUpdate)
            : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
        }
        return { behavior: 'allow', updatedInput: input, updatedPermissions };
      };

      const cross = job.cross_check === true;
      const reviewScript = deps.codexReviewScript ?? path.join(WORKER_DIR, 'dist', 'mcp', 'codex-review.js');
      const archive = job.archive === false ? null : (deps.archive ?? null);
      const append = [job.system_append ?? '', cross ? CROSS_CHECK_APPEND : '', archive ? ARCHIVE_APPEND : '']
        .filter(Boolean)
        .join('\n\n');
      const mcpServers = {
        ...(cross
          ? {
              codex: {
                type: 'stdio' as const,
                command: process.execPath,
                args: [reviewScript],
                env: { ...(process.env as Record<string, string>), TALK_CWD: job.cwd },
              },
            }
          : {}),
        ...(archive
          ? { [ARCHIVE_SERVER]: { type: 'http' as const, url: archive.url, headers: { Authorization: `Bearer ${archive.token}` } } }
          : {}),
      };

      const mode = (job.permission_mode || 'default') as PermissionMode;
      if (!MODES.includes(mode)) deps.log?.warn({ mode }, '허용하지 않는 권한 모드, default 로 바꿈');
      const options: Options = {
        cwd: job.cwd,
        pathToClaudeCodeExecutable: deps.claudeBin,
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        ...(job.resume ? { resume: job.resume } : { sessionId: job.thread_id }),
        permissionMode: MODES.includes(mode) ? mode : 'default',
        allowedTools: [...(job.tools ?? []), ...(cross ? [REVIEW_TOOL] : []), ...(archive ? ARCHIVE_TOOLS : [])],
        disallowedTools: DISALLOWED,
        tools: { type: 'preset', preset: 'claude_code' },
        toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        settingSources: ['user', 'project'],
        ...(job.model ? { model: job.model } : {}),
        ...(claudeEffort(job.effort) ? { effort: claudeEffort(job.effort) } : {}),
        includePartialMessages: true,
        maxTurns: 40,
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        abortController,
        canUseTool,
      };

      // 스트리밍 입력: user 메시지 하나를 내고 턴이 끝날 때까지 열어 둔다
      async function* gen(): AsyncGenerator<SDKUserMessage> {
        // 엔진을 바꾼 첫 턴: 직전 맥락을 질문 앞에 붙인다(Codex 와 같은 꼴)
        const ctxText = job.context?.trim();
        yield buildUserMessage(ctxText ? `${ctxText}\n\n${job.prompt}` : job.prompt, files);
        await finished;
      }

      const handle = (m: SDKMessage): void => {
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') emit({ k: 'session', id: m.session_id });
            return;
          case 'stream_event': {
            if (m.parent_tool_use_id) return;
            const e = m.event;
            if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
              emit({ k: 'delta', text: e.delta.text });
              estChars += e.delta.text.length;
              checkBudget();
            }
            return;
          }
          case 'assistant': {
            if (m.error === 'rate_limit') hintKind = 'limit';
            else if (m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed') hintKind = 'auth';
            const u = m.message?.usage;
            if (u && m.message.id) {
              // 상한 추정엔 새 입력·출력만: 캐시 생성·읽기는 세션 맥락이지 이번 턴의 일이 아니다
              apiUsage.set(m.message.id, (u.input_tokens ?? 0) + (u.output_tokens ?? 0));
            }
            for (const b of m.message?.content ?? []) {
              if (b.type !== 'tool_use') continue;
              const input = (b.input ?? {}) as Record<string, unknown>;
              const rec: ToolRec = { name: b.name === REVIEW_TOOL ? REVIEW_LABEL : b.name, summary: summarize(b.name, input) };
              if (FILE_TOOLS.has(b.name)) {
                const fp = filePathOf(b.name, input);
                if (fp) {
                  rec.file = path.resolve(job.cwd, fp);
                  rec.existed = existsSync(rec.file);
                }
              }
              tools.set(b.id, rec);
              estChars += JSON.stringify(input).length * 0.75;
              if (!m.parent_tool_use_id) emit({ k: 'tool', name: rec.name, summary: rec.summary, status: 'start' });
            }
            checkBudget();
            return;
          }
          case 'user': {
            const content = m.message?.content;
            if (!Array.isArray(content)) return;
            for (const b of content) {
              if (b.type !== 'tool_result') continue;
              const rec = tools.get(b.tool_use_id);
              if (!rec) continue;
              tools.delete(b.tool_use_id);
              estChars += textOfToolResult(b.content).length * 0.75;
              if (m.parent_tool_use_id) continue;
              const ok = !b.is_error;
              // 교차검증은 사용량 한 줄을 요약에 남긴다
              const note = rec.name === REVIEW_LABEL ? textOfToolResult(b.content).match(/\(codex 사용량:[^)]*\)/)?.[0] : undefined;
              emit({ k: 'tool', name: rec.name, summary: note ? `${rec.summary} ${note}` : rec.summary, status: ok ? 'done' : 'fail' });
              if (ok && rec.file) emit({ k: 'file', path: rec.file, kind: rec.existed ? 'update' : 'add' });
            }
            checkBudget();
            return;
          }
          case 'rate_limit_event':
            if (m.rate_limit_info?.status === 'rejected') hintKind = 'limit';
            return;
          case 'result': {
            if (stopReason) return;
            if (m.subtype === 'success' && !m.is_error) {
              const u = m.usage;
              emit({
                k: 'done',
                text: m.result,
                usage: {
                  input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
                  output: u?.output_tokens ?? 0,
                  cached: u?.cache_read_input_tokens ?? 0,
                },
                cost_usd: m.total_cost_usd,
                ms: m.duration_ms ?? Date.now() - t0,
              });
              return;
            }
            const text = m.subtype === 'success' ? m.result : [m.subtype, ...(m.errors ?? [])].filter(Boolean).join(': ');
            emit({ k: 'error', kind: hintKind ?? classifyError(text), message: text || '알 수 없는 오류' });
            return;
          }
          default:
            return;
        }
      };

      try {
        if (stopReason) return;
        q = query({ prompt: gen(), options });
        for await (const m of q) {
          handle(m);
          if (m.type === 'result') break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!stopReason) emit({ k: 'error', kind: hintKind ?? classifyError(msg), message: msg });
      } finally {
        finish();
        ctl.signal.removeEventListener('abort', onCtlAbort);
        if (killTimer) clearTimeout(killTimer);
        try {
          q?.close?.();
        } catch {
          /* 이미 닫힘 */
        }
        if (stopReason === 'aborted') emit({ k: 'error', kind: 'aborted', message: '사용자가 멈춤' });
        emit({ k: 'error', kind: 'other', message: '결과 없이 끝남' });
      }
    },
  };
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** 작업의 생각 깊이 → SDK effort. 모르는 값은 버린다 (엔진 기본) */
export function claudeEffort(v: string | null | undefined): (typeof CLAUDE_EFFORTS)[number] | undefined {
  return CLAUDE_EFFORTS.find((e) => e === v);
}
