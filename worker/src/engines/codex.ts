import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import type { Input, SandboxMode, ThreadEvent, ThreadItem, ThreadOptions, UserInput } from '@openai/codex-sdk';
import { attachmentLines, downloadAttachments, type DownloadResult } from '../attach.js';
import { DEFAULT_TURN_TOKENS } from './claude.js';
import { ARCHIVE_APPEND, codexArchiveOptions, type ArchiveMcp } from '../archive.js';
import type { Engine, EngineCtl, Ev, Job } from './types.js';
import { friendlyError } from './errors.js';

/** SDK 의 Thread 중 쓰는 부분만 (테스트에서 가짜로 바꾼다) */
export interface ThreadLike {
  readonly id: string | null;
  runStreamed(input: Input, opts?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexLike {
  startThread(o?: ThreadOptions): ThreadLike;
  resumeThread(id: string, o?: ThreadOptions): ThreadLike;
}

export interface CodexDeps {
  endpoint?: string;
  token?: string;
  codex?: CodexLike;
  /** 아카이브 검색 MCP (있으면 Codex 설정에 붙이고 프롬프트 머리에 안내를 넣는다) */
  archive?: ArchiveMcp | null;
  fetch?: typeof fetch;
  defaultTurnTokens?: number;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write'];

const RE_LIMIT = /rate[ _-]?limit|usage limit|quota|\b429\b|too many requests|한도/i;
const RE_AUTH = /log ?in|unauthori[sz]ed|\b401\b|not logged in|auth(entication)? (failed|required)|token (expired|revoked)/i;

export function classifyCodexError(text: string): 'limit' | 'auth' | 'other' {
  if (RE_LIMIT.test(text)) return 'limit';
  if (RE_AUTH.test(text)) return 'auth';
  return 'other';
}

/** SDK 의 env 는 process.env 를 통째로 대신하므로 문자열 값만 골라 넘긴다 */
export function envRecord(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function createCodexClient(env: Record<string, string> = envRecord(), archive?: ArchiveMcp | null): CodexLike {
  return new Codex(codexArchiveOptions(env, archive)) as unknown as CodexLike;
}

export function threadOptions(job: Job, log?: CodexDeps['log']): ThreadOptions {
  let sandbox = (job.sandbox || 'workspace-write') as SandboxMode;
  if (!SANDBOXES.includes(sandbox)) {
    log?.warn({ sandbox }, '허용하지 않는 샌드박스, workspace-write 로 바꿈');
    sandbox = 'workspace-write';
  }
  return {
    workingDirectory: job.cwd,
    skipGitRepoCheck: true,
    sandboxMode: sandbox,
    approvalPolicy: 'never',
    model: job.model ?? undefined,
    modelReasoningEffort: codexEffort(job.effort),
    networkAccessEnabled: true,
    webSearchMode: 'live',
  };
}

/** 텍스트(안내 + 맥락 + 질문 + 첨부 줄) 하나와 내려받은 이미지마다 local_image */
export function buildCodexInput(job: Job, att: DownloadResult = { files: [], failed: [] }, hint = ''): UserInput[] {
  const parts: string[] = [];
  if (hint.trim()) parts.push(hint.trim());
  if (job.context?.trim()) parts.push(job.context.trim());
  parts.push(job.prompt);
  const lines = attachmentLines(att);
  if (lines) parts.push(lines);
  const input: UserInput[] = [{ type: 'text', text: parts.join('\n\n') }];
  for (const f of att.files) if (f.mime) input.push({ type: 'local_image', path: f.path });
  return input;
}

function oneLine(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function argsSummary(a: unknown): string {
  const s = typeof a === 'string' ? a : JSON.stringify(a ?? '');
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

export function createCodexEngine(deps: CodexDeps = {}): Engine {
  let client = deps.codex ?? null;

  return {
    async run(job: Job, emitRaw: (ev: Ev) => void, ctl: EngineCtl): Promise<void> {
      const t0 = Date.now();
      let ended = false;
      const emit = (ev: Ev) => {
        if (ended) return;
        if (ev.k === 'done' || ev.k === 'error') ended = true;
        emitRaw(friendlyError('codex', ev));
      };

      if (ctl.signal.aborted) return emit({ k: 'error', kind: 'aborted', message: '사용자가 멈춤' });
      if (!path.isAbsolute(job.cwd)) {
        return emit({ k: 'error', kind: 'other', message: `작업 폴더가 절대 경로가 아님: ${job.cwd}` });
      }
      mkdirSync(job.cwd, { recursive: true });

      const files = await downloadAttachments(
        job.cwd,
        job.attachments ?? [],
        { endpoint: deps.endpoint ?? 'http://localhost', token: deps.token ?? '', fetch: deps.fetch },
        deps.log,
      );

      // 멈춤·예산 초과는 signal 로 codex 프로세스를 죽인다
      const ac = new AbortController();
      let stopReason: 'aborted' | 'budget' | null = null;
      const stop = (why: 'aborted' | 'budget') => {
        if (stopReason) return;
        stopReason = why;
        ac.abort();
      };
      const onCtlAbort = () => stop('aborted');
      ctl.signal.addEventListener('abort', onCtlAbort, { once: true });

      // 예산: Codex 는 usage 가 턴 끝에만 오므로 그 전까지 글자수로 추정
      const limit = job.budget?.turn_tokens ?? deps.defaultTurnTokens ?? DEFAULT_TURN_TOKENS;
      let estChars = 0;
      const checkBudget = () => {
        if (stopReason || !(limit > 0)) return;
        const used = Math.ceil(estChars / 3);
        if (used > limit) {
          emit({ k: 'error', kind: 'budget', message: `이번 턴 토큰 상한(${limit}) 초과로 멈춤 (추정 ${used})` });
          stop('budget');
        }
      };

      const messages: string[] = [];
      const started = new Set<string>();
      let lastError: string | null = null;

      const toolOf = (item: ThreadItem): { name: string; summary: string } | null => {
        switch (item.type) {
          case 'command_execution':
            return { name: '명령', summary: oneLine(item.command) };
          case 'web_search':
            return { name: '검색', summary: oneLine(item.query, 120) };
          case 'mcp_tool_call':
            return { name: `${item.server}.${item.tool}`, summary: argsSummary(item.arguments) };
          default:
            return null;
        }
      };

      const handle = (e: ThreadEvent): void => {
        switch (e.type) {
          case 'thread.started':
            emit({ k: 'session', id: e.thread_id });
            return;
          case 'item.started': {
            const t = toolOf(e.item);
            if (t && !started.has(e.item.id)) {
              started.add(e.item.id);
              emit({ k: 'tool', ...t, status: 'start' });
            }
            return;
          }
          case 'item.updated':
            return;
          case 'item.completed': {
            const item = e.item;
            switch (item.type) {
              case 'agent_message':
                messages.push(item.text);
                emit({ k: 'delta', text: item.text });
                estChars += item.text.length;
                break;
              case 'reasoning':
                estChars += item.text.length;
                break;
              case 'command_execution': {
                const ok = item.status !== 'failed' && (item.exit_code === undefined || item.exit_code === 0);
                emit({ k: 'tool', ...toolOf(item)!, status: ok ? 'done' : 'fail' });
                estChars += (item.command.length + (item.aggregated_output?.length ?? 0)) * 0.75;
                break;
              }
              case 'web_search':
                emit({ k: 'tool', ...toolOf(item)!, status: 'done' });
                break;
              case 'mcp_tool_call':
                emit({ k: 'tool', ...toolOf(item)!, status: item.status === 'failed' ? 'fail' : 'done' });
                estChars += JSON.stringify(item.result?.content ?? '').length * 0.75;
                break;
              case 'file_change':
                if (item.status === 'completed') {
                  for (const c of item.changes) emit({ k: 'file', path: path.resolve(job.cwd, c.path), kind: c.kind });
                }
                break;
              case 'error':
                lastError = item.message;
                break;
              default:
                break;
            }
            started.delete(item.id);
            checkBudget();
            return;
          }
          case 'turn.completed': {
            if (stopReason) return;
            const u = e.usage;
            emit({
              k: 'done',
              text: messages.join('\n\n'),
              usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cached: u?.cached_input_tokens ?? 0 },
              ms: Date.now() - t0,
            });
            return;
          }
          case 'turn.failed': {
            if (stopReason) return;
            const msg = e.error?.message || lastError || '알 수 없는 오류';
            emit({ k: 'error', kind: classifyCodexError(`${msg}\n${lastError ?? ''}`), message: msg });
            return;
          }
          case 'error':
            // 재접속 알림처럼 회복되는 경우가 있어 바로 끝내지 않고, 턴이 결과 없이 끝나면 이 문구로 알린다
            lastError = e.message;
            return;
          default:
            return;
        }
      };

      try {
        if (ctl.signal.aborted) stop('aborted');
        if (stopReason) return;
        client ??= createCodexClient(envRecord(), deps.archive);
        const opts = threadOptions(job, deps.log);
        const thread = job.resume ? client.resumeThread(job.resume, opts) : client.startThread(opts);
        const hint = deps.archive && job.archive !== false ? ARCHIVE_APPEND : '';
        const { events } = await thread.runStreamed(buildCodexInput(job, files, hint), { signal: ac.signal });
        for await (const e of events) {
          handle(e);
          // 끝난 뒤에도 프로세스가 스스로 닫히도록 끝까지 읽는다(세션 기록 보존). 멈춤·예산만 바로 나간다.
          if (stopReason) break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!stopReason) emit({ k: 'error', kind: classifyCodexError(`${msg}\n${lastError ?? ''}`), message: lastError ?? msg });
      } finally {
        ctl.signal.removeEventListener('abort', onCtlAbort);
        if (stopReason === 'aborted') emit({ k: 'error', kind: 'aborted', message: '사용자가 멈춤' });
        if (lastError) emit({ k: 'error', kind: classifyCodexError(lastError), message: lastError });
        emit({ k: 'error', kind: 'other', message: '결과 없이 끝남' });
      }
    },
  };
}

/** 작업의 생각 깊이 → Codex reasoning effort. max 는 Codex 에 없어 xhigh 로 */
export function codexEffort(v: string | null | undefined): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (v === 'max') return 'xhigh';
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' ? v : undefined;
}
