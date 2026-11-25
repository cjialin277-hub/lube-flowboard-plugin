/**
 * Lube Studio · Flow 桥接助手 — Popup UI
 */

let _manualDisconnect = false;

function render(status) {
  if (!status) return;

  _manualDisconnect = status.manualDisconnect;

  const dotEl = document.getElementById('status-dot');
  if (status.manualDisconnect || !status.connected) {
    dotEl.className = 'section-value dot-offline';
    dotEl.textContent = '○ 未连接本地服务';
  } else if (status.state === 'running') {
    dotEl.className = 'section-value dot-running';
    dotEl.textContent = '▶ 生成请求执行中…';
  } else {
    dotEl.className = 'section-value dot-connected';
    dotEl.textContent = '● 已连接本地画布';
  }

  document.getElementById('token-row').textContent = '页内实时签名 ✓（无需Token）';

  const m = status.metrics || {};
  document.getElementById('stats-row').textContent =
    `${m.requestCount || 0} · ✓ ${m.successCount || 0} · ✗ ${m.failedCount || 0}`;

  const errSection = document.getElementById('error-section');
  const errRow     = document.getElementById('error-row');
  if (m.lastError) {
    errSection.style.display = 'flex';
    errRow.textContent = m.lastError;
  } else {
    errSection.style.display = 'none';
  }

  const btn = document.getElementById('btn-toggle');
  if (status.manualDisconnect) {
    btn.textContent = '重新连接本地画布';
    btn.className   = 'reconnect';
  } else {
    btn.textContent = '断开本地桥接';
    btn.className   = 'disconnect';
  }
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (reply) => {
    if (chrome.runtime.lastError) return;
    render(reply);
  });
}

fetchStatus();
setInterval(fetchStatus, 1500);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') fetchStatus();
});

document.getElementById('btn-flow-tab').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' });
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  const type = _manualDisconnect ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type }, () => {
    if (chrome.runtime.lastError) return;
    fetchStatus();
  });
});
