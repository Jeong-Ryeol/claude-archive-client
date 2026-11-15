/**
 * 구독 사용량 — Claude 앱·ChatGPT 의 "사용량" 화면과 같은 값(5시간·주간 %, 초기화 시각).
 * 엔진이 턴마다 갱신하고, beat 프레임의 sys.plan 으로 서버에 보낸다.
 * - Claude: Agent SDK 의 /usage 데이터 (실험용 API — 없거나 실패하면 그냥 비워 둔다)
 * - GPT: Codex 세션 기록(rollout)의 token_count 이벤트에 붙은 rate_limits
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PlanWindow = { pct: number; resets_at: string | null };
export type ClaudePlan = {
  five_hour: PlanWindow | null;
  seven_day: PlanWindow | null;
  models: { name: string; pct: number; resets_at: string | null }[];
  at: string;
};
export type CodexPlan = { five_hour: PlanWindow | null; seven_day: PlanWindow | null; at: string };
export type PlanSnapshot = { claude: ClaudePlan | null; codex: CodexPlan | null };

let claude: ClaudePlan | null = null;
let codex: CodexPlan | null = null;

export function planSnapshot(): PlanSnapshot {
  return { claude, codex };
}

/** 시험용 */
export function resetPlan(): void {
  claude = null;
  codex = null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function win(w: unknown): PlanWindow | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as { utilization?: unknown; resets_at?: unknown };
  const pct = num(o.utilization);
  return pct == null ? null : { pct, resets_at: typeof o.resets_at === 'string' ? o.resets_at : null };
}

/** SDK usage_EXPERIMENTAL…() 응답 → 저장. 요금제 한도가 없는 로그인(API 키 등)이면 무시. */
export function noteClaudeUsage(resp: unknown, now = new Date()): ClaudePlan | null {
  const r = resp as { rate_limits_available?: unknown; rate_limits?: Record<string, unknown> | null } | null;
  if (!r || r.rate_limits_available !== true || !r.rate_limits) return null;
  const rl = r.rate_limits;
  const models: ClaudePlan['models'] = [];
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const w = win(m);
    const name = (m as { display_name?: unknown }).display_name;
    if (w && typeof name === 'string') models.push({ name, ...w });
  }
  const next: ClaudePlan = { five_hour: win(rl.five_hour), seven_day: win(rl.seven_day), models, at: now.toISOString() };
  if (!next.five_hour && !next.seven_day && !models.length) return null;
  claude = next;
  return next;
}

/**
 * Claude 턴마다 오는 rate_limit_event 의 rate_limit_info → 저장 (이게 주 출처. 실측 11/15:
 * {"rateLimitType":"five_hour","utilization":0.95,"resetsAt":1794739200,
 *  "unifiedWindows":{"five_hour":{"utilization":0.95,"resetsAt":…},"seven_day":{"utilization":0.43,"resetsAt":…}}})
 * utilization 은 0~1 비율, resetsAt 은 초. 없는 창은 이전 값을 유지한다.
 */
export function noteClaudeRateLimit(info: unknown, now = new Date()): ClaudePlan | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as { unifiedWindows?: Record<string, unknown>; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown };
  const frac = (x: unknown): PlanWindow | null => {
    const o = (x ?? {}) as { utilization?: unknown; resetsAt?: unknown };
    const u = num(o.utilization);
    if (u == null) return null;
    const r = num(o.resetsAt);
    return { pct: Math.round(u * 1000) / 10, resets_at: r != null ? new Date(r > 1e12 ? r : r * 1000).toISOString() : null };
  };
  let five = frac(i.unifiedWindows?.five_hour);
  let seven = frac(i.unifiedWindows?.seven_day);
  if (!five && !seven) {
    const one = frac(i);
    if (i.rateLimitType === 'five_hour') five = one;
    else if (i.rateLimitType === 'seven_day') seven = one;
  }
  if (!five && !seven) return null;
  claude = { five_hour: five ?? claude?.five_hour ?? null, seven_day: seven ?? claude?.seven_day ?? null,
    models: claude?.models ?? [], at: now.toISOString() };
  return claude;
}

/** rollout 의 rate_limits({primary, secondary}: used_percent·window_minutes·resets_at 초) → 5시간·주간 */
export function codexPlanFrom(rl: unknown, now = new Date()): CodexPlan | null {
  if (!rl || typeof rl !== 'object') return null;
  const out: CodexPlan = { five_hour: null, seven_day: null, at: now.toISOString() };
  for (const key of ['primary', 'secondary']) {
    const w = (rl as Record<string, unknown>)[key] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null;
    const pct = num(w?.used_percent);
    const mins = num(w?.window_minutes);
    if (pct == null || mins == null) continue;
    const r = num(w?.resets_at);
    const pw = { pct, resets_at: r != null ? new Date((r > 1e12 ? r : r * 1000)).toISOString() : null };
    if (mins <= 24 * 60) out.five_hour = pw;      // 300분 창
    else out.seven_day = pw;                       // 10080분 창
  }
  return out.five_hour || out.seven_day ? out : null;
}

export function noteCodexRateLimits(rl: unknown, now = new Date()): CodexPlan | null {
  const p = codexPlanFrom(rl, now);
  if (p) codex = p;
  return p;
}

/** ~/.codex/sessions/YYYY/MM/DD 중 최근 며칠에서 이 세션의 rollout 파일 */
export function findRollout(sessionId: string, home = os.homedir(), days = 3): string | null {
  const root = path.join(home, '.codex', 'sessions');
  if (!sessionId || !existsSync(root)) return null;
  const dirs: string[] = [];
  const kids = (d: string) => {
    try {
      return readdirSync(d).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of kids(root))
    for (const m of kids(path.join(root, y)))
      for (const d of kids(path.join(root, y, m))) {
        dirs.push(path.join(root, y, m, d));
        if (dirs.length >= days) break;
      }
  for (const d of dirs.slice(0, days)) {
    try {
      const f = readdirSync(d).find((n) => n.includes(sessionId) && n.endsWith('.jsonl'));
      if (f) return path.join(d, f);
    } catch {
      /* 다음 폴더 */
    }
  }
  return null;
}

/** 파일 끝 쪽(최대 4MB)에서 마지막 rate_limits */
export async function lastRateLimits(file: string): Promise<unknown | null> {
  const size = statSync(file).size;
  const start = Math.max(0, size - 4 * 1024 * 1024);
  let text = '';
  for await (const chunk of createReadStream(file, { start, encoding: 'utf8' })) text += chunk;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(l) as { payload?: { rate_limits?: unknown } };
      if (o.payload?.rate_limits) return o.payload.rate_limits;
    } catch {
      /* 앞 조각이 잘린 줄 */
    }
  }
  return null;
}

/** 턴이 끝난 Codex 세션의 기록에서 사용량을 읽어 저장 (실패는 조용히) */
export async function refreshCodexPlan(sessionId: string | null, home = os.homedir()): Promise<CodexPlan | null> {
  if (!sessionId) return null;
  try {
    const f = findRollout(sessionId, home);
    if (!f) return null;
    return noteCodexRateLimits(await lastRateLimits(f));
  } catch {
    return null;
  }
}
