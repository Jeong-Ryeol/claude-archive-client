import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';

/** 화면이 아는 공통 이벤트. 엔진별 이벤트는 전부 이 꼴로 바꿔 보낸다. */
export type Ev =
  | { k: 'session'; id: string }
  | { k: 'delta'; text: string }
  | { k: 'tool'; name: string; summary: string; status: 'start' | 'done' | 'fail' }
  | { k: 'question'; id: string; questions: AskUserQuestionInput['questions'] }
  | { k: 'approval'; id: string; tool: string; summary: string; input: unknown }
  | { k: 'file'; path: string; kind: 'add' | 'update' | 'delete' }
  | { k: 'done'; text: string; usage: { input: number; output: number; cached: number }; cost_usd?: number; ms: number }
  | { k: 'error'; kind: 'limit' | 'auth' | 'aborted' | 'budget' | 'other'; message: string; detail?: string };

export interface Attachment {
  name: string;
  url: string;
  mime?: string | null;
}

/** ingest → 워커 `job` 프레임 (t 제외) */
export interface Job {
  job_id: string;
  thread_id: string;
  engine: string;
  resume: string | null;
  cwd: string;
  model?: string | null;
  /** 생각 깊이: low | medium | high | xhigh | max. 없으면 엔진 기본 */
  effort?: string | null;
  permission_mode?: string;
  tools?: string[];
  sandbox?: string;
  rules_md?: string;
  prompt: string;
  attachments?: Attachment[];
  system_append?: string;
  /** 엔진을 바꾼 첫 턴 등에 넘기는 직전 맥락(Codex 는 프롬프트 앞에 붙인다) */
  context?: string | null;
  /** Claude 턴에 Codex 교차검증(MCP codex_review)을 붙인다 */
  cross_check?: boolean;
  budget?: { turn_tokens?: number; hour_tokens?: number };
}

export interface AnswerMsg {
  job_id: string;
  question_id: string;
  answers: Record<string, string>;
  response?: string;
}

export interface DecisionMsg {
  job_id: string;
  approval_id: string;
  allow: boolean;
  remember: boolean;
}

/** id 로 응답을 기다리는 우편함. 먼저 도착한 응답은 보관했다가 넘긴다. */
export interface Inbox<T> {
  /** 응답이 오면 그 값, 시간 초과면 null. signal 이 끊기면 reject. */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<T | null>;
}

export interface EngineCtl {
  answer$: Inbox<AnswerMsg>;
  decision$: Inbox<DecisionMsg>;
  signal: AbortSignal;
}

export interface Engine {
  run(job: Job, emit: (ev: Ev) => void, ctl: EngineCtl): Promise<void>;
}
