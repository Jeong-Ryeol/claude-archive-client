// claude.ai 의 sessionKey 쿠키가 바뀔 때마다 아카이브 서버로 보낸다.
// 서버 주소·토큰은 설정 페이지에서 입력 (chrome.storage.sync).

const COOKIE = { url: 'https://claude.ai/', name: 'sessionKey' };

async function cfg() {
  return chrome.storage.sync.get({ endpoint: '', token: '' });
}

async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
}

async function sync(force = false) {
  const { endpoint, token } = await cfg();
  if (!endpoint || !token) return setStatus({ ok: false, msg: '설정 필요 (서버 주소·토큰)' });

  const c = await chrome.cookies.get(COOKIE);
  if (!c?.value) return setStatus({ ok: false, msg: 'claude.ai 에 로그인돼 있지 않음' });

  const h = await hash(c.value);
  const { lastHash } = await chrome.storage.local.get('lastHash');
  if (!force && lastHash === h) return setStatus({ ok: true, msg: '변경 없음', keyHash: h });

  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') + '/ingest/sessionkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ key: c.value, expires: c.expirationDate ?? null })
    });
    if (!r.ok) return setStatus({ ok: false, msg: `서버 응답 ${r.status}`, keyHash: h });
    await chrome.storage.local.set({ lastHash: h });
    return setStatus({ ok: true, msg: '키 전송 완료', keyHash: h });
  } catch (e) {
    return setStatus({ ok: false, msg: `서버 연결 실패: ${e.message}`, keyHash: h });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 10 });
  sync();
});
chrome.runtime.onStartup.addListener(() => sync());
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') sync(); });
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name === 'sessionKey' && info.cookie.domain.includes('claude.ai') && !info.removed) sync();
});
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg === 'sync-now') sync(true).then(() => reply(true));
  return true;
});
