import type { Ev } from './types.js';

export const AUTH_TEXT = {
  claude: 'Claude 로그인이 필요합니다 (노트북에서 Claude 앱을 한 번 열어 주세요)',
  codex: 'ChatGPT 로그인이 필요합니다 (노트북에서 codex login)',
} as const;

/** auth 오류는 사람이 읽을 문구로 바꾸고 원문은 detail 에 남긴다. kind 는 그대로. */
export function friendlyError(engine: keyof typeof AUTH_TEXT, ev: Ev): Ev {
  if (ev.k !== 'error' || ev.kind !== 'auth' || ev.message === AUTH_TEXT[engine]) return ev;
  return { ...ev, message: AUTH_TEXT[engine], detail: ev.detail ?? ev.message };
}
