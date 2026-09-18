const $ = (id) => document.getElementById(id);

async function showStatus() {
  const { status } = await chrome.storage.local.get('status');
  const el = $('status');
  if (!status) { el.textContent = '아직 실행 안 됨'; el.className = ''; return; }
  el.className = status.ok ? 'ok' : 'bad';
  el.textContent = `${status.ok ? '✅' : '⚠️'} ${status.msg}\n${new Date(status.at).toLocaleString()}` +
    (status.keyHash ? `\n키 지문 ${status.keyHash}` : '');
}

(async () => {
  const { endpoint, token } = await chrome.storage.sync.get({ endpoint: '', token: '' });
  $('endpoint').value = endpoint; $('token').value = token;
  showStatus();
})();

$('save').onclick = async () => {
  const endpoint = $('endpoint').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!/^https?:\/\//.test(endpoint)) { alert('주소는 http:// 또는 https:// 로 시작해야 합니다'); return; }
  // 서버 주소에 대한 접근 권한을 사용자 클릭 시점에 요청 (MV3 규칙)
  const origin = new URL(endpoint).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { alert('서버 주소 접근 권한이 필요합니다'); return; }
  await chrome.storage.sync.set({ endpoint, token });
  await chrome.storage.local.remove('lastHash');
  chrome.runtime.sendMessage('sync-now', () => showStatus());
};

$('now').onclick = () => chrome.runtime.sendMessage('sync-now', () => showStatus());
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.status) showStatus(); });
