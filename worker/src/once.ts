// 서버 없이 이 PC 에서 엔진 한 턴 실행: npm run once -- --cwd <폴더> [--engine claude|codex] [--bin <claude.exe>] [--model <m>] [--cross yes] "<질문>"
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig, resolveClaudeBin } from './config.js';
import { createClaudeEngine } from './engines/claude.js';
import { createCodexEngine } from './engines/codex.js';
import type { Ev, Job } from './engines/types.js';
import { Mailbox } from './inbox.js';
import type { AnswerMsg, DecisionMsg } from './engines/types.js';

function parse(argv: string[]) {
  const o: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { o, prompt: rest.join(' ') };
}

const { o, prompt } = parse(process.argv.slice(2));
if (!prompt || !o.cwd) {
  console.error('사용법: npm run once -- --cwd <폴더> "<질문>"');
  process.exit(2);
}
const cfg = loadConfig();
const bin = o.bin ? resolveClaudeBin(o.bin) : cfg.claude_bin;
const engineName = o.engine ?? 'claude';
const engine =
  engineName === 'codex'
    ? createCodexEngine({ endpoint: cfg.endpoint, token: cfg.token })
    : createClaudeEngine({ claudeBin: bin, endpoint: cfg.endpoint, token: cfg.token });
const answers = new Mailbox<AnswerMsg>();
const decisions = new Mailbox<DecisionMsg>();
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());

const job: Job = {
  job_id: randomUUID(),
  thread_id: o.session ?? randomUUID(),
  engine: engineName,
  resume: o.resume ?? null,
  cwd: path.resolve(o.cwd),
  model: o.model ?? null,
  permission_mode: o.mode ?? 'default',
  sandbox: o.sandbox,
  cross_check: o.cross === 'yes',
  tools: o.tools ? o.tools.split(',') : [],
  prompt,
  system_append: '답은 한국어로.',
  budget: o.budget ? { turn_tokens: Number(o.budget) } : undefined,
};

const emit = (ev: Ev) => {
  console.log(JSON.stringify(ev));
  if (ev.k === 'question') {
    // 스모크 테스트용: 첫 보기로 자동 응답
    const a: Record<string, string> = {};
    for (const q of ev.questions) a[q.question] = q.options[0].label;
    answers.put(ev.id, { job_id: job.job_id, question_id: ev.id, answers: a });
  } else if (ev.k === 'approval') {
    // 승인은 --allow yes 일 때만 허용
    decisions.put(ev.id, { job_id: job.job_id, approval_id: ev.id, allow: o.allow === 'yes', remember: false });
  }
};

console.error(JSON.stringify({ bin, cwd: job.cwd, session: job.thread_id }));
await engine.run(job, emit, { answer$: answers, decision$: decisions, signal: ac.signal });
