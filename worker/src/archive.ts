/**
 * 아카이브 검색(MCP) 연결 — 채팅방의 Claude·GPT 가 사용자의 지난 대화를 찾아볼 수 있게 한다.
 * 서버는 NAS 의 mcp 컨테이너(8900, Bearer). 도구는 전부 읽기 전용이라 묻지 않고 쓰게 둔다.
 */

export interface ArchiveMcp {
  url: string;
  token: string;
}

export const ARCHIVE_SERVER = 'archive';
/** Codex 가 Bearer 토큰을 읽어 갈 환경변수 (설정 파일에 값을 적지 않으려고) */
export const ARCHIVE_TOKEN_ENV = 'ARCHIVE_MCP_TOKEN';
export const ARCHIVE_TOOLS = ['search', 'get_pair', 'get_conversation', 'recent', 'list_wiki', 'get_wiki'].map(
  (t) => `mcp__${ARCHIVE_SERVER}__${t}`,
);

/** 시스템 프롬프트(Claude) / 프롬프트 머리(Codex) 에 붙이는 안내 */
export const ARCHIVE_APPEND =
  '- 이 사용자의 지난 대화가 아카이브에 모여 있다. 사용자 본인, 예전에 한 일·정한 것·좋아하는 방식과 관련될 수 있는 질문이면 ' +
  '답하기 전에 archive 도구로 먼저 찾아본다(search 로 찾고, 필요하면 get_pair·get_conversation 으로 원문, list_wiki·get_wiki 로 정리된 글). ' +
  '찾은 내용은 언제 나눈 이야기인지와 함께 답에 반영하고, 못 찾았으면 못 찾았다고 말한다. 일반 지식만 묻는 질문에는 쓰지 않는다.';

/**
 * endpoint(http://host:8800) → MCP 주소(http://host:8900/mcp). url 을 주면 그 값, 'off' 면 끔.
 * 토큰이 없으면 붙이지 않는다(서버가 401 을 내면 엔진이 매 턴 오류를 띄운다).
 */
export function archiveMcpOf(endpoint: string, token: string, url?: string | null, mcpToken?: string | null): ArchiveMcp | null {
  const u = (url ?? '').trim();
  if (/^(off|none|false|0)$/i.test(u)) return null;
  const tok = (mcpToken ?? '').trim() || token.trim();
  if (!tok) return null;
  if (u) return { url: u, token: tok };
  try {
    const e = new URL(endpoint);
    e.port = '8900';
    e.pathname = '/mcp';
    e.search = '';
    e.hash = '';
    return { url: e.toString(), token: tok };
  } catch {
    return null;
  }
}

/** Codex SDK 옵션: ~/.codex/config.toml 은 건드리지 않고 실행 옵션(--config)과 환경변수로만 붙인다 */
export function codexArchiveOptions(
  env: Record<string, string>,
  archive: ArchiveMcp | null | undefined,
): {
  env: Record<string, string>;
  config?: { mcp_servers: Record<string, { url: string; bearer_token_env_var: string; default_tools_approval_mode: string }> };
} {
  if (!archive) return { env };
  return {
    env: { ...env, [ARCHIVE_TOKEN_ENV]: archive.token },
    config: {
      mcp_servers: {
        // 채팅방 실행은 approval 'never' 라 승인이 필요한 MCP 도구는 자동 거절된다 → 이 서버(읽기 전용)는 미리 승인
        [ARCHIVE_SERVER]: { url: archive.url, bearer_token_env_var: ARCHIVE_TOKEN_ENV, default_tools_approval_mode: 'approve' },
      },
    },
  };
}
