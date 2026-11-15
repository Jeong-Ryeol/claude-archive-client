import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { codexPlanFrom, findRollout, noteClaudeRateLimit, noteClaudeUsage, planSnapshot, refreshCodexPlan, resetPlan } from '../src/plan.js';
import { pullClaudeUsage } from '../src/engines/claude.js';

const NOW = new Date('2026-11-15T09:00:00Z');

describe('구독 사용량', () => {
  beforeEach(() => resetPlan());

  it('Claude /usage 응답 → 5시간·주간·모델별', () => {
    const p = noteClaudeUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 41.5, resets_at: '2026-11-15T12:00:00Z' },
        seven_day: { utilization: 22, resets_at: '2026-11-20T00:00:00Z' },
        model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: null }],
      },
    }, NOW);
    expect(p).toEqual({
      five_hour: { pct: 41.5, resets_at: '2026-11-15T12:00:00Z' },
      seven_day: { pct: 22, resets_at: '2026-11-20T00:00:00Z' },
      models: [{ name: 'Fable', pct: 10, resets_at: null }],
      at: NOW.toISOString(),
    });
    expect(planSnapshot().claude).toEqual(p);
  });

  it('rate_limit_event (실측 모양): 비율 → %, 초 → 시각, 없는 창은 이전 값 유지', () => {
    const p = noteClaudeRateLimit({ status: 'allowed_warning', resetsAt: 1794739200, rateLimitType: 'five_hour', utilization: 0.95,
      unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: 1794739200 }, seven_day: { utilization: 0.43, resetsAt: 1794841200 } } }, NOW);
    expect(p?.five_hour).toEqual({ pct: 95, resets_at: new Date(1794739200 * 1000).toISOString() });
    expect(p?.seven_day?.pct).toBe(43);
    noteClaudeRateLimit({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1794739200 }, NOW);
    expect(planSnapshot().claude?.five_hour?.pct).toBe(50);
    expect(planSnapshot().claude?.seven_day?.pct).toBe(43);
    expect(noteClaudeRateLimit({ status: 'allowed' })).toBeNull();
  });

  it('요금제 한도가 없으면(API 키 등) 이전 값을 지우지 않는다', () => {
    noteClaudeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: null } } }, NOW);
    expect(noteClaudeUsage({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(planSnapshot().claude?.five_hour?.pct).toBe(5);
  });

  it('Codex rate_limits → 창 길이로 5시간·주간 구분, resets_at 은 초', () => {
    const p = codexPlanFrom({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 1795264961 },
      secondary: { used_percent: 30, window_minutes: 300, resets_at: 1794740000 } }, NOW);
    expect(p?.seven_day).toEqual({ pct: 1, resets_at: new Date(1795264961 * 1000).toISOString() });
    expect(p?.five_hour?.pct).toBe(30);
    expect(codexPlanFrom({ primary: null, secondary: null })).toBeNull();
  });

  it('세션 기록 파일의 마지막 rate_limits 를 읽는다', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const sid = '01a1de43-69e2-7390-ab1b-4c4c2acdf205';
    const dir = path.join(home, '.codex', 'sessions', '2026', '11', '15');
    mkdirSync(dir, { recursive: true });
    const tc = (pct: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
      rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: 1795264961 } } } });
    writeFileSync(path.join(dir, `rollout-2026-11-15T17-12-02-${sid}.jsonl`), [tc(1), '{"type":"x"}', tc(3), ''].join('\n'));
    expect(findRollout(sid, home)).toContain(sid);
    expect(findRollout('없는-세션', home)).toBeNull();
    expect((await refreshCodexPlan(sid, home))?.seven_day?.pct).toBe(3);
    expect(planSnapshot().codex?.seven_day?.pct).toBe(3);
  });

  it('SDK 에 사용량 API 가 없거나 실패해도 조용히', async () => {
    await pullClaudeUsage(null);
    await pullClaudeUsage({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }), interrupt: async () => {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('x'); } } as never);
    await pullClaudeUsage({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }), interrupt: async () => {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 9, resets_at: null } } }) } as never);
    expect(planSnapshot().claude?.seven_day?.pct).toBe(9);
  });
});
