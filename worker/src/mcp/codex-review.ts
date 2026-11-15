// Claude 세션에 붙는 교차검증 MCP 서버(stdio). 도구 하나: codex_review({task, paths?})
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThreadOptions } from '@openai/codex-sdk';
import { createCodexClient, envRecord, type CodexLike } from '../engines/codex.js';

export const MAX_REVIEW_CHARS = 2000;
export const REVIEW_TIMEOUT_MS = 5 * 60_000;

export interface ReviewDeps {
  codex?: CodexLike;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReviewResult {
  text: string;
  isError: boolean;
}

export function reviewOptions(cwd: string): ThreadOptions {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    modelReasoningEffort: 'low',
    webSearchMode: 'disabled',
    networkAccessEnabled: false,
  };
}

export function reviewPrompt(task: string, paths: string[] = []): string {
  const parts = [
    '다른 AI 가 쓴 답이나 작업을 교차검증한다. 파일은 읽기만 하고 고치지 않는다.',
    '틀린 점·빠진 점·위험한 점을 핵심만 한국어로 짧게 적고, 문제가 없으면 "문제 없음"과 그 이유 한 줄.',
    '',
    `검증할 내용:\n${task.trim()}`,
  ];
  if (paths.length) parts.push('', '살펴볼 파일:', ...paths.map((p) => `- ${p}`));
  return parts.join('\n');
}

function clip(s: string, n = MAX_REVIEW_CHARS): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Codex 로 읽기 전용 검토 한 번. 마지막 agent 메시지(2,000자)와 사용량 한 줄을 돌려준다. */
export async function runReview(task: string, paths: string[] | undefined, deps: ReviewDeps = {}): Promise<ReviewResult> {
  const cwd = path.resolve(deps.cwd || process.env.TALK_CWD || process.cwd());
  const codex = deps.codex ?? createCodexClient(envRecord());
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? REVIEW_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let last = '';
  let usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null = null;
  let failure: string | null = null;
  try {
    const thread = codex.startThread(reviewOptions(cwd));
    const { events } = await thread.runStreamed(reviewPrompt(task, paths ?? []), { signal });
    for await (const e of events) {
      if (e.type === 'item.completed' && e.item.type === 'agent_message') last = e.item.text;
      else if (e.type === 'turn.completed') usage = e.usage;
      else if (e.type === 'turn.failed') failure = e.error?.message || '실패';
      else if (e.type === 'error') failure = e.message;
    }
  } catch (e) {
    if (!last || !usage) failure = timeout.aborted ? '시간 초과' : e instanceof Error ? e.message : String(e);
  }
  if (!last) return { text: `Codex 교차검증 실패: ${clip(failure ?? '답 없음', 500)}`, isError: true };
  const note = usage
    ? `(codex 사용량: 입력 ${usage.input_tokens} · 출력 ${usage.output_tokens} · 캐시 ${usage.cached_input_tokens})`
    : '(codex 사용량: 알 수 없음)';
  return { text: `${clip(last)}\n\n${note}`, isError: false };
}

export async function main(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'codex-review', version: '0.1.0' });
  let calls = 0; // 이 서버는 Claude 턴 하나 동안만 산다: 호출당 1회
  server.registerTool(
    'codex_review',
    {
      description:
        'OpenAI Codex(GPT)에게 읽기 전용으로 교차검증을 맡긴다. task 에 검증할 결론·코드 요지를, paths 에 볼 파일 경로를 넣는다. 턴당 한 번만.',
      inputSchema: { task: z.string().min(1), paths: z.array(z.string()).optional() },
    },
    async ({ task, paths }) => {
      if (calls++ > 0) {
        return { content: [{ type: 'text', text: '이번 턴에는 이미 교차검증했다. 앞 결과를 써라.' }], isError: true };
      }
      const r = await runReview(task, paths);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError };
    },
  );
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`codex-review: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
