/**
 * Flowboard Bridge — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures Bearer token and proxies API calls through the browser context.
 */

const AGENT_WS_URLS  = ['ws://localhost:8355', 'ws://127.0.0.1:8355'];
const CALLBACK_URLS  = [
  'http://localhost:8434/api/ext/callback',
  'http://127.0.0.1:8434/api/ext/callback',
];

let activeWsUrlIdx   = 0;
let ws               = null;
let flowKey          = null;
let callbackSecret   = null; // Auth secret received from agent on WS connect
let state            = 'off'; // off | idle | running
let manualDisconnect = false;
let _initialized     = false;
let _reconnectTimer  = null;
let metrics = {
  tokenCapturedAt: null,
  requestCount:    0,
  successCount:    0,
  failedCount:     0,
  lastError:       null,
};

// Flow moved to flow.google.com in September 2026. In practice the only
// signed-in tab is flow.google.com/*; the labs.google patterns stay so an old
// pinned tab is still recognised rather than triggering a redundant spawn.
const flowUrls = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

// ─── URL → Log Type Classifier ─────────────────────────────

function classifyUrl(url) {
  if (url.includes('batchGenerateImages'))     return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync'))         return 'POLL';
  return 'API';
}

// ─── Request Log (last 50 entries) ─────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
});

async function init() {
  if (_initialized) {
    connectToAgent();
    return;
  }
  _initialized = true;
  // Note: deliberately not restoring `userInfo` from storage. We used
  // to persist it here, but Google profile fields (name + email) are
  // PII and chrome.storage.local is plaintext + readable by other
  // extensions on the profile that hold the `storage` permission.
  // The agent replays user_info on every WS reconnect anyway via
  // fetchAndPushUserInfo(token), so persistence buys nothing.
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret']);
  if (data.flowKey)        flowKey        = data.flowKey;
  if (data.metrics)        Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    const tokenChanged = flowKey !== token;
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    // Only emit on the WS when the token actually rotated. The listener
    // fires on EVERY outbound aisandbox-pa request — and the agent's
    // own poll loops generate dozens per minute. Re-sending the same
    // string each time pushed the agent into an effective infinite
    // /v1/credits refresh loop (one credits GET per poll). The agent
    // side has a defensive dedupe too, but quiet at the source first.
    if (tokenChanged) {
      console.log('[Flowboard] Bearer token captured');
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
      // Resolve the user's identity (email/name/picture) once per token —
      // saves the popup + AccountPanel from showing "Connected via
      // extension" placeholders. The token already has the userinfo.email
      // + userinfo.profile scopes Flow needs anyway, so this is a free
      // call. Errors are non-fatal and silent.
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let cachedUserInfo = null;

async function fetchAndPushUserInfo(token) {
  try {
    const resp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      console.warn('[Flowboard] userinfo fetch returned', resp.status);
      return;
    }
    const info = await resp.json();
    // In-memory only — DO NOT persist to chrome.storage.local. PII
    // there is plaintext on disk and readable by other extensions
    // with the `storage` permission. Lifetime = service-worker
    // lifetime; rebuilt on next token rotation if the SW recycles.
    cachedUserInfo = info;
    console.log('[Flowboard] userinfo captured for', info?.email || '<no email>');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: info }));
    }
  } catch (e) {
    console.warn('[Flowboard] userinfo fetch failed:', e?.message || e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  const targetUrl = AGENT_WS_URLS[activeWsUrlIdx % AGENT_WS_URLS.length];
  let didOpen = false;

  try {
    ws = new WebSocket(targetUrl);
  } catch (e) {
    console.error('[Flowboard] WS connect error:', targetUrl, e);
    activeWsUrlIdx = (activeWsUrlIdx + 1) % AGENT_WS_URLS.length;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    didOpen = true;
    console.log('[Flowboard] Connected to agent:', targetUrl);
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    chrome.alarms.clear('reconnect');
    if (metrics.lastError) {
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
    }
    setState('idle');

    const tokenAge = flowKey && metrics.tokenCapturedAt
      ? Date.now() - metrics.tokenCapturedAt
      : null;

    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge,
    }));

    // Resend token immediately so agent can start without waiting for a capture
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
    // Replay cached userinfo so the agent's AccountPanel populates on
    // reconnect without waiting for the next token rotation. If we
    // never resolved one yet but a token IS present, kick off a fetch.
    if (cachedUserInfo) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
    } else if (flowKey) {
      fetchAndPushUserInfo(flowKey);
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[Flowboard] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response — no-op
      } else if (msg.type === 'logout') {
        // Agent's /api/auth/logout invoked — drop in-memory identity
        // so the next reconnect picks up fresh credentials. Don't
        // touch chrome.storage (we don't persist identity there
        // anyway, but be explicit). The WS stays open; agent will
        // re-greet when the user logs back in.
        console.log('[Flowboard] logout requested by agent');
        cachedUserInfo = null;
        flowKey = null;
      } else if (msg.type === 'please_resend_userinfo') {
        // Agent's /api/auth/scan asks us to re-fetch userinfo when
        // its own cache is empty (e.g. agent restarted, or user
        // clicked "Scan extension" before WS finished its first
        // round-trip). If we have a cached profile, replay it
        // immediately; otherwise refetch from Google's userinfo
        // endpoint with whatever Bearer token we currently hold.
        if (cachedUserInfo) {
          ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
        } else if (flowKey) {
          fetchAndPushUserInfo(flowKey);
        } else {
          console.log('[Flowboard] please_resend_userinfo: no token captured yet');
        }
      } else if (msg.method === 'batch_rpc') {
        await handleBatchRpc(msg);
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'get_multimodal_tabs') {
        await handleGetMultimodalTabs(msg);
      } else if (msg.method === 'open_external_tab') {
        await handleOpenExternalTab(msg);
      } else if (msg.method === 'mj_list_assets') {
        await handleMjListAssets(msg);
      } else if (msg.method === 'mj_fetch_image') {
        await handleMjFetchImage(msg);
      } else if (msg.method === 'mj_imagine') {
        await handleMjImagine(msg);
      } else if (msg.method === 'muse_web_run') {
        await handleMuseWebRun(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      }
    } catch (e) {
      console.error('[Flowboard] Message error:', e);
    }
  };

  ws.onclose = () => {
    ws = null;
    setState('off');
    if (!manualDisconnect) {
      if (!didOpen) {
        // Flip between localhost and 127.0.0.1 if the handshake never opened
        // (e.g. a system proxy intercepting 127.0.0.1 while bypassing localhost).
        activeWsUrlIdx = (activeWsUrlIdx + 1) % AGENT_WS_URLS.length;
      }
      scheduleReconnect(!didOpen ? 500 : 2000);
    }
  };

  ws.onerror = (e) => {
    console.error('[Flowboard] WS error:', targetUrl, e);
    metrics.lastError = `WS_ERROR (${targetUrl})`;
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect(delayMs = 2000) {
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connectToAgent();
  }, delayMs);
  chrome.alarms.create('reconnect', { delayInMinutes: 0.5 });
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Send to Agent ──────────────────────────────────────────

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back from localhost → 127.0.0.1 → WS on HTTP failure.
 * Non-response messages use WS directly.
 */
async function postCallbackWithFallback(bodyJson) {
  const headers = {
    'Content-Type':      'application/json',
    'X-Callback-Secret': callbackSecret || '',
  };
  for (const url of CALLBACK_URLS) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: bodyJson });
      if (resp.ok) return true;
    } catch {
      // Try next URL
    }
  }
  return false;
}

function sendToAgent(msg) {
  if (msg.id) {
    const bodyJson = JSON.stringify(msg);
    postCallbackWithFallback(bodyJson).then((ok) => {
      if (!ok && ws?.readyState === WebSocket.OPEN) {
        ws.send(bodyJson);
      }
    });
    return;
  }
  // Non-response messages (ping, status, token_captured)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Page-context RPC runner (the current path) ─────────────
//
// Flow's rewritten frontend signs its calls with the session cookie plus a
// per-page `at` token, and every generate also carries a single-use reCAPTCHA.
// None of that can be replayed from the service worker, so the request has to
// be issued by the Flow page itself: mint a fresh captcha through the
// grecaptcha bridge, then run the batchexecute POST in the page's MAIN world,
// where `at` / `f.sid` / `bl` live.

const CAPTCHA_SLOT = '__CAPTCHA__';
const MAX_RPC_TEXT = 32000000; // the project listing alone is past 17 MB
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Pick the Flow tab that best matches the target project / multi-account session.
 * Prevents an old `/u/0/` tab (`tabs[0]`) from hijacking requests meant for a
 * newly opened `/u/1/project/<uuid>` tab.
 */
function pickBestFlowTab(tabs, freqStr = '') {
  if (!Array.isArray(tabs) || !tabs.length) return null;
  const uuids = (freqStr || '').match(UUID_RE) || [];
  // 1) Non-discarded tab whose URL explicitly contains one of the UUIDs in freq (e.g. project_id)
  for (const id of uuids) {
    const lower = id.toLowerCase();
    const exactLive = tabs.find((t) => !t.discarded && (t.url || '').toLowerCase().includes(lower));
    if (exactLive) return exactLive;
    const exactAny = tabs.find((t) => (t.url || '').toLowerCase().includes(lower));
    if (exactAny) return exactAny;
  }
  // 2) Active (foreground) non-discarded Flow tab
  const activeTab = tabs.find((t) => !t.discarded && t.active);
  if (activeTab) return activeTab;
  // 3) Prefer the most recently opened non-discarded tab (end of list) over stale tabs[0]
  const liveTabs = tabs.filter((t) => !t.discarded);
  if (liveTabs.length) return liveTabs[liveTabs.length - 1];
  return tabs[tabs.length - 1];
}

async function runBatchRpc(cmd) {
  const tabs = await chrome.tabs.query({ url: flowUrls });
  let candidate = pickBestFlowTab(tabs, cmd.freq);
  if (!candidate) {
    // No Flow tab — open one and give the app a moment to boot, otherwise
    // WIZ_global_data is not on the page yet and `at` comes back empty. Hold
    // the exact created tab id so a redirect or a stale tab cannot hijack
    // the recovery.
    let opened;
    try {
      opened = await openFlowTabResilient(false);
      await sleep(5000);
      candidate = opened?.id ? await chrome.tabs.get(opened.id).catch(() => null) : null;
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!candidate) return { error: 'NO_FLOW_TAB' };
  }
  // Chrome discards backgrounded tabs; executeScript throws on a dead one.
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  let freq = cmd.freq;
  if (cmd.captchaAction) {
    const solved = await solveCaptcha(cmd.id, cmd.captchaAction, tab.id);
    if (!solved?.token) return { error: `CAPTCHA_FAILED: ${solved?.error || 'no token'}` };
    freq = freq.split(CAPTCHA_SLOT).join(solved.token);
  }

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [cmd.rpcid, freq, MAX_RPC_TEXT, cmd.match || null],
    func: async (rpcid, freqStr, maxText, match) => {
      let wiz = globalThis.WIZ_global_data || {};
      if (!wiz.SNlM0e) {
        try {
          const gd = document.querySelector('script[data-id="_gd"]')?.textContent || '';
          const m = gd.match(/WIZ_global_data\s*=\s*(\{[\s\S]*?\});/);
          if (m) wiz = JSON.parse(m[1]);
        } catch {
          // keep empty wiz fallback
        }
      }
      const at = wiz.SNlM0e;
      const sid = wiz.FdrFJe;
      const bl = wiz.cfb2h;
      if (!at) return { error: 'NO_AT_TOKEN' };
      const reqid = Math.floor(Math.random() * 900000) + 100000;
      // Match Flow's own WIZ metadata. GEM_PIX_2 (Nano Banana Pro) rejects
      // image generation when source-path is missing, even where the lighter
      // models tolerate it. Preserve `/u/<N>` prefix on multi-account tabs!
      const sourcePath = location.pathname || '/';
      const uPrefix = (sourcePath.match(/^\/u\/\d+/) || [''])[0];
      const basePath = wiz.Im6cmf || `${uPrefix}/_/AiSandboxAngularFrontend`;
      const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
      const url =
        `${basePath}/data/batchexecute?rpcids=${encodeURIComponent(rpcid)}` +
        `&source-path=${encodeURIComponent(sourcePath)}` +
        `&bl=${encodeURIComponent(bl || '')}&f.sid=${encodeURIComponent(sid || '')}` +
        `&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({ 'f.req': freqStr, at }),
      });
      const text = await resp.text();
      // The project listing is tens of megabytes and all we ever want from it
      // is one entry. Cutting it down in the page keeps that payload out of
      // the bridge on every poll — shipping it whole gets it truncated, which
      // loses roughly half of all lookups depending on where the id sorts.
      if (match) {
        const found = text.indexOf(match);   // not `at` — that is the CSRF token above
        return {
          status: resp.status,
          matched: found !== -1,
          text: found === -1 ? '' : text.slice(found, found + 800),
        };
      }
      return { status: resp.status, text: text.slice(0, maxText) };
    },
  });

  return injected?.result || { error: 'NO_INJECTION_RESULT' };
}

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, freq, captchaAction, match } = params || {};
  if (!rpcid || !freq) {
    sendToAgent({ id, status: 400, error: 'INVALID_BATCH_RPC' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;
  // Polls and listing lookups run constantly; only the generates are worth a
  // row in the log the popup shows.
  const visible = hasCaptcha;
  if (visible) {
    addRequestLog({
      id,
      type: `RPC:${rpcid}`,
      time: new Date().toISOString(),
      status: 'processing',
      error: null,
      url: rpcid,
      payloadSummary: freq.slice(0, 200),
    });
  }

  try {
    const out = await runBatchRpc({ id, rpcid, freq, captchaAction, match });
    if (out.error) {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = out.error; }
      if (visible) updateRequestLog(id, { status: 'failed', error: out.error });
      sendToAgent({ id, status: 502, error: out.error });
    } else {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      if (visible) {
        updateRequestLog(id, {
          status: 'success',
          httpStatus: out.status,
          responseSummary: (out.text || '').slice(0, 300),
        });
      }
      sendToAgent({ id, status: out.status, data: out.text });
    }
  } catch (e) {
    const err = e?.message || 'BATCH_RPC_FAILED';
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = err; }
    if (visible) updateRequestLog(id, { status: 'failed', error: err });
    sendToAgent({ id, status: 500, error: err });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── API Request Proxy (legacy) ─────────────────────────────
//
// The pre-migration REST path. aisandbox-pa required the `Bearer ya29.…`
// captured below, and flow.google.com does not mint one, so this answers
// NO_FLOW_KEY for real work now. Kept for the manual `proxy` request type,
// and so an extension updated ahead of its agent stays backwards compatible.

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params || {};

  if (!url || !url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, status: 400, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  addRequestLog({
    id,
    type:   classifyUrl(url),
    time:   new Date().toISOString(),
    status: 'processing',
    url,
  });

  try {
    // Step 0: Fail fast if we have no bearer token. Avoids burning a reCAPTCHA
    // solve (rate-limited + single-use) only to discover later that we can't
    // send the request.
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(id, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flowboard] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(id, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body clone if present
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    const fetchHeaders = { ...(headers || {}), authorization: `Bearer ${flowKey}` };

    const response = await fetch(url, {
      method:      method || 'POST',
      headers:     fetchHeaders,
      credentials: 'include',
      body:        method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({ id, status: response.status, data: responseData });

    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(id, { status: 'success', httpStatus: response.status });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(id, { status: 'failed', httpStatus: response.status, error: `API_${response.status}` });
    }
  } catch (e) {
    sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message || 'API_REQUEST_FAILED'; }
    updateRequestLog(id, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── Token Refresh (minimal) ────────────────────────────────

let _openingFlowTab = false;

const FLOW_URL = 'https://flow.google.com/';

/**
 * Open a Flow tab even when Chrome has zero windows. `chrome.tabs.create`
 * throws "No current window" in that state because it needs a window
 * context to attach to; `chrome.windows.create` spawns a fresh window
 * and tab in one call. Falls back through both paths so we recover from
 * "all-windows-closed but service-worker-still-alive" silently.
 */
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('No current window')) throw e;
    console.log('[Flowboard] No Chrome window — spawning a fresh one for Flow');
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',
    });
    return win.tabs?.[0] ?? null;
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  if (!tabs.length) {
    if (_openingFlowTab) return;
    _openingFlowTab = true;
    try {
      console.log('[Flowboard] No Flow tab — opening in background');
      await openFlowTabResilient(false);
    } catch (e) {
      console.error('[Flowboard] Failed to open Flow tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }

  try {
    // Trigger a credentialed request so the page re-issues an Authorization header
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func:   () => fetch('/fx/tools/flow', { credentials: 'include' }),
    });
    console.log('[Flowboard] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[Flowboard] Token refresh failed:', e);
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry. Both the inject + re-send can
    // throw "No current window" / "No tab with id" if the tab dies in
    // between (Chrome aggressively discards background tabs). Surface
    // those verbatim so solveCaptcha's loop can move to the next
    // candidate instead of bubbling a confusing message to the user.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still
 *  shows up in `chrome.tabs.query` but cross-context calls fail with
 *  "No current window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    const fresh = await chrome.tabs.get(tab.id);
    return fresh;
  } catch {
    return null;
  }
}

function captchaFromTab(tabId, requestId, captchaAction) {
  return Promise.race([
    requestCaptchaFromTab(tabId, requestId, captchaAction),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
  ]);
}

async function solveCaptcha(requestId, captchaAction, preferredTabId = null) {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  // No Flow tab at all — spawn one (handles "no Chrome window" via the
  // resilient helper).
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Try the preferred tab first (same tab where runBatchRpc will execute),
  // then fall back through remaining Flow tabs.
  const rawCandidates = await chrome.tabs.query({ url: flowUrls });
  const candidates = preferredTabId
    ? [
        ...rawCandidates.filter((t) => t.id === preferredTabId),
        ...rawCandidates.filter((t) => t.id !== preferredTabId),
      ]
    : rawCandidates;
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await captchaFromTab(live.id, requestId, captchaAction);
      // A tab that replies without a token is a tab sitting on a page that
      // never loaded grecaptcha — another Flow tab may well be fine. Returning
      // on the first reply let one stale tab veto every generation.
      if (!resp?.token) {
        errors.push(resp?.error || 'NO_TOKEN');
        continue;
      }
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, tab discarded again,
      // or page navigated away). Move on to the next candidate.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // All candidates failed — last-ditch: spawn a fresh Flow tab and try THAT
  // exact tab once. This handles every existing Flow tab being in a window we
  // could not recover from. Previously this re-queried all Flow tabs and took
  // fresh[0], which could pick the same stale tab again while leaking the
  // newly created one on every retry.
  let recoveryTab = null;
  try {
    recoveryTab = await openFlowTabResilient(false);
    await sleep(3000);
    const target = recoveryTab?.id
      ? await chrome.tabs.get(recoveryTab.id).catch(() => null)
      : null;
    if (!target || target.discarded) return { error: 'NO_FLOW_TAB' };
    return await captchaFromTab(target.id, requestId, captchaAction);
  } catch (e) {
    return { error: e?.message || errors[0] || 'NO_FLOW_TAB' };
  } finally {
    // A recovery tab is disposable: there were already Flow tabs available for
    // the signed RPC itself. Do not let captcha retries accumulate tabs.
    if (recoveryTab?.id) {
      try { await chrome.tabs.remove(recoveryTab.id); } catch { /* already gone */ }
    }
  }
}

// ─── TRPC Request Proxy ─────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  // Tightly scoped to TRPC endpoints — prevents the agent from navigating to
  // arbitrary labs.google paths (e.g. /fx/api/trpc/account.deleteAccount would
  // also match /fx/api/trpc/ but account-level mutations should be gated server
  // side if they're ever needed).
  if (!url || !url.startsWith('https://labs.google/fx/api/trpc/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls are silent — don't add to request log, don't bump metrics

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body:    body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flowboard] tRPC request failed:', e);
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── Multi-Modal Bridge: Midjourney (www.midjourney.com) & Meta Muse (muse.ai) ───

const mjUrls = ['https://www.midjourney.com/*'];
const museUrls = ['https://muse.ai/*'];

async function handleGetMultimodalTabs(msg) {
  const { id } = msg;
  try {
    const [flowTabs, mjTabs, museTabs] = await Promise.all([
      chrome.tabs.query({ url: flowUrls }),
      chrome.tabs.query({ url: mjUrls }),
      chrome.tabs.query({ url: museUrls }),
    ]);
    const bestFlow = pickBestFlowTab(flowTabs, '');
    const bestMj = mjTabs.find((t) => !t.discarded && t.active) || mjTabs.find((t) => !t.discarded) || mjTabs[0] || null;
    const bestMuse = museTabs.find((t) => !t.discarded && t.active) || museTabs.find((t) => !t.discarded) || museTabs[0] || null;

    let mjMeta = null;
    if (bestMj) {
      try {
        const liveMj = await reviveTabIfNeeded(bestMj);
        if (liveMj) {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: liveMj.id },
            world: 'MAIN',
            func: () => {
              const u = new URL(location.href);
              const folder = u.searchParams.get('folder') || '';
              const hasInputBar = !!document.getElementById('desktop_input_bar');
              const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
                (i.currentSrc || i.src || '').includes('cdn.midjourney.com/'),
              );
              return {
                url: location.href,
                title: document.title,
                folder,
                hasInputBar,
                visibleImageCount: imgs.length,
              };
            },
          });
          mjMeta = res?.result || null;
        }
      } catch {
        // non-fatal
      }
    }

    let museMeta = null;
    if (bestMuse) {
      try {
        const liveMuse = await reviveTabIfNeeded(bestMuse);
        if (liveMuse) {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: liveMuse.id },
            world: 'MAIN',
            func: () => {
              const body = (document.body?.innerText || '').toLowerCase();
              const hasTextarea = !!document.querySelector('textarea');
              const loginHint = ['log in', 'sign in', 'create an account'].some((h) => body.includes(h));
              return {
                url: location.href,
                title: document.title,
                ready: hasTextarea && !loginHint,
                hasTextarea,
                loginRequired: loginHint && !hasTextarea,
              };
            },
          });
          museMeta = res?.result || null;
        }
      } catch {
        // non-fatal
      }
    }

    sendToAgent({
      id,
      status: 200,
      data: {
        flow: {
          connected: !!bestFlow,
          tabCount: flowTabs.length,
          url: bestFlow?.url || '',
        },
        midjourney: {
          connected: !!bestMj,
          tabCount: mjTabs.length,
          url: bestMj?.url || '',
          ...(mjMeta || {}),
        },
        muse: {
          connected: !!bestMuse,
          tabCount: museTabs.length,
          url: bestMuse?.url || '',
          ...(museMeta || {}),
        },
      },
    });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'MULTIMODAL_TABS_FAILED' });
  }
}

async function handleOpenExternalTab(msg) {
  const { id, params = {} } = msg;
  const target = params.target || 'muse';
  const url =
    target === 'midjourney'
      ? params.url || 'https://www.midjourney.com/imagine'
      : params.url || 'https://muse.ai/thread/new';
  try {
    const queryUrls = target === 'midjourney' ? mjUrls : museUrls;
    const existing = await chrome.tabs.query({ url: queryUrls });
    if (existing.length > 0) {
      const tab = existing[existing.length - 1];
      await chrome.tabs.update(tab.id, { active: Boolean(params.focus) });
      sendToAgent({ id, status: 200, data: { tabId: tab.id, url: tab.url, reused: true } });
      return;
    }
    const created = await chrome.tabs.create({ url, active: Boolean(params.focus) });
    sendToAgent({ id, status: 200, data: { tabId: created.id, url: created.url || url, reused: false } });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'OPEN_EXTERNAL_TAB_FAILED' });
  }
}

async function handleMjListAssets(msg) {
  const { id, params = {} } = msg;
  const limit = Math.min(Math.max(Number(params.limit) || 40, 1), 120);
  try {
    const mjTabs = await chrome.tabs.query({ url: mjUrls });
    const cand = mjTabs.find((t) => !t.discarded && t.active) || mjTabs.find((t) => !t.discarded) || mjTabs[0];
    if (!cand) {
      sendToAgent({ id, error: 'NO_MIDJOURNEY_TAB' });
      return;
    }
    const tab = await reviveTabIfNeeded(cand);
    if (!tab) {
      sendToAgent({ id, error: 'MIDJOURNEY_TAB_DISCARDED' });
      return;
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [limit],
      func: (maxItems) => {
        const u = new URL(location.href);
        const folder = u.searchParams.get('folder') || '';
        const seen = new Set();
        const items = [];
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const img of imgs) {
          const src = img.currentSrc || img.src || '';
          if (!src.includes('cdn.midjourney.com/')) continue;
          // Case 1: Generated job grid image: https://cdn.midjourney.com/<jobId>/0_<idx>_384_N.webp?...
          const mJob = src.match(/cdn\.midjourney\.com\/([0-9a-f-]{36})\/0_(\d+)/i);
          if (mJob) {
            const jobId = mJob[1].toLowerCase();
            const variantIdx = Number(mJob[2]);
            const key = `${jobId}_${variantIdx}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fullUrl = `https://cdn.midjourney.com/${jobId}/0_${variantIdx}.jpeg`;
            items.push({
              key,
              kind: 'job',
              jobId,
              variantIdx,
              thumbUrl: src,
              fullUrl,
              width: img.naturalWidth || 685,
              height: img.naturalHeight || 384,
              alt: (img.alt || '').trim(),
            });
            if (items.length >= maxItems) break;
            continue;
          }
          // Case 2: Uploaded reference asset: https://cdn.midjourney.com/u/<userId>/<hash>_384_N.jpg
          const mUp = src.match(/cdn\.midjourney\.com\/u\/([0-9a-f-]{36})\/([0-9a-f]+?)(?:_\d+_[A-Z])?\.(jpg|jpeg|png|webp)/i);
          if (mUp) {
            const userId = mUp[1].toLowerCase();
            const hash = mUp[2].toLowerCase();
            const key = `u_${hash.slice(0, 16)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fullUrl = `https://cdn.midjourney.com/u/${userId}/${hash}.jpg`;
            items.push({
              key,
              kind: 'upload',
              jobId: hash.slice(0, 16),
              variantIdx: 0,
              thumbUrl: src,
              fullUrl,
              width: img.naturalWidth || 512,
              height: img.naturalHeight || 512,
              alt: (img.alt || '').trim(),
            });
            if (items.length >= maxItems) break;
          }
        }
        return {
          url: location.href,
          folder,
          count: items.length,
          items,
        };
      },
    });
    sendToAgent({ id, status: 200, data: res?.result || { items: [] } });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'MJ_LIST_ASSETS_FAILED' });
  }
}

async function handleMjFetchImage(msg) {
  const { id, params = {} } = msg;
  const fullUrl = params.fullUrl || '';
  const thumbUrl = params.thumbUrl || '';
  if (!fullUrl && !thumbUrl) {
    sendToAgent({ id, error: 'MISSING_MJ_IMAGE_URL' });
    return;
  }
  try {
    const mjTabs = await chrome.tabs.query({ url: mjUrls });
    const cand = mjTabs.find((t) => !t.discarded && t.active) || mjTabs.find((t) => !t.discarded) || mjTabs[0];
    if (!cand) {
      sendToAgent({ id, error: 'NO_MIDJOURNEY_TAB' });
      return;
    }
    const tab = await reviveTabIfNeeded(cand);
    if (!tab) {
      sendToAgent({ id, error: 'MIDJOURNEY_TAB_DISCARDED' });
      return;
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [fullUrl, thumbUrl],
      func: async (primaryUrl, fallbackUrl) => {
        const tryFetch = async (u) => {
          if (!u) return null;
          const r = await fetch(u);
          if (!r.ok) return null;
          const b = await r.blob();
          if (!b || b.size < 1000) return null;
          const buf = new Uint8Array(await b.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          }
          return { mime: b.type || 'image/jpeg', size: b.size, b64: btoa(s), urlUsed: u };
        };
        const got = (await tryFetch(primaryUrl)) || (await tryFetch(fallbackUrl));
        if (!got) return { error: 'MJ_CDN_FETCH_FAILED' };
        return got;
      },
    });
    const out = res?.result;
    if (!out || out.error) {
      sendToAgent({ id, error: out?.error || 'MJ_FETCH_EMPTY' });
      return;
    }
    sendToAgent({ id, status: 200, data: out });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'MJ_FETCH_IMAGE_FAILED' });
  }
}

async function handleMjImagine(msg) {
  const { id, params = {} } = msg;
  const prompt = (params.prompt || '').trim();
  const count = Math.min(Math.max(Number(params.count) || 1, 1), 4);
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 140000, 20000), 240000);
  if (!prompt) {
    sendToAgent({ id, error: 'EMPTY_MJ_PROMPT' });
    return;
  }
  setState('running');
  try {
    let mjTabs = await chrome.tabs.query({ url: mjUrls });
    let cand = mjTabs.find((t) => !t.discarded && t.active) || mjTabs.find((t) => !t.discarded) || mjTabs[0];
    if (!cand) {
      cand = await chrome.tabs.create({ url: 'https://www.midjourney.com/imagine', active: false });
      await sleep(5000);
    }
    const tab = await reviveTabIfNeeded(cand);
    if (!tab) {
      sendToAgent({ id, error: 'NO_MIDJOURNEY_TAB' });
      return;
    }

    // Step 1: Snapshot existing job IDs on the page and submit into #desktop_input_bar
    const [subRes] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [prompt],
      func: (promptText) => {
        const ta = document.getElementById('desktop_input_bar');
        if (!ta) return { error: 'NO_MJ_INPUT_BAR' };
        const beforeJobs = [];
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || '';
          const m = src.match(/cdn\.midjourney\.com\/([0-9a-f-]{36})\/0_/i);
          if (m) beforeJobs.push(m[1].toLowerCase());
        }
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(ta, promptText);
        } else {
          ta.value = promptText;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        const evInit = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        };
        ta.dispatchEvent(new KeyboardEvent('keydown', evInit));
        ta.dispatchEvent(new KeyboardEvent('keypress', evInit));
        ta.dispatchEvent(new KeyboardEvent('keyup', evInit));
        return { ok: true, beforeJobs: Array.from(new Set(beforeJobs)), leftInInput: ta.value.length };
      },
    });
    const sub = subRes?.result;
    if (!sub || sub.error) {
      sendToAgent({ id, error: sub?.error || 'MJ_SUBMIT_FAILED' });
      return;
    }
    const knownSet = new Set(sub.beforeJobs || []);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(3000);
      const [pollRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [Array.from(knownSet), count],
        func: async (beforeList, wantCount) => {
          const oldSet = new Set(beforeList);
          const candidateJobs = [];
          for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            const m = src.match(/cdn\.midjourney\.com\/([0-9a-f-]{36})\/0_(\d+)/i);
            if (m) {
              const jid = m[1].toLowerCase();
              if (!oldSet.has(jid) && !candidateJobs.includes(jid)) {
                candidateJobs.push(jid);
              }
            }
          }
          if (!candidateJobs.length) return { done: false };
          const jobId = candidateJobs[0];
          const images = [];
          for (let idx = 0; idx < wantCount; idx++) {
            const fullUrl = `https://cdn.midjourney.com/${jobId}/0_${idx}.jpeg`;
            try {
              const r = await fetch(fullUrl);
              if (!r.ok) return { done: false, jobId };
              const b = await r.blob();
              if (!b || b.size < 25000) return { done: false, jobId };
              const buf = new Uint8Array(await b.arrayBuffer());
              let s = '';
              for (let i = 0; i < buf.length; i += 0x8000) {
                s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
              }
              images.push({
                jobId,
                variantIdx: idx,
                mime: b.type || 'image/jpeg',
                size: b.size,
                b64: btoa(s),
                url: fullUrl,
              });
            } catch {
              return { done: false, jobId };
            }
          }
          return { done: true, jobId, images };
        },
      });
      const p = pollRes?.result;
      if (p?.done && Array.isArray(p.images) && p.images.length > 0) {
        sendToAgent({ id, status: 200, data: { jobId: p.jobId, images: p.images } });
        return;
      }
    }
    sendToAgent({ id, error: 'MJ_WEB_TIMEOUT' });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'MJ_IMAGINE_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleMuseWebRun(msg) {
  const { id, params = {} } = msg;
  const kind = params.kind || 'image'; // 'image' | 'video' | 'llm'
  const prompt = (params.prompt || '').trim();
  const attachments = Array.isArray(params.attachments) ? params.attachments : [];
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 150000, 15000), 240000);
  if (!prompt) {
    sendToAgent({ id, error: 'EMPTY_MUSE_PROMPT' });
    return;
  }
  setState('running');
  try {
    let museTabs = await chrome.tabs.query({ url: museUrls });
    let cand = museTabs.find((t) => !t.discarded && t.active) || museTabs.find((t) => !t.discarded) || museTabs[0];
    if (!cand) {
      sendToAgent({ id, error: 'NO_MUSE_TAB' });
      return;
    }
    const tab = await reviveTabIfNeeded(cand);
    if (!tab) {
      sendToAgent({ id, error: 'MUSE_TAB_DISCARDED' });
      return;
    }

    // Step 1: Check if muse.ai is hydrated & logged in, snapshot existing bubbles/attachments, attach files, and click Send
    const [subRes] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [prompt, attachments],
      func: async (promptText, files) => {
        const body = (document.body?.innerText || '').toLowerCase();
        const ta = document.querySelector('textarea');
        if (!ta) {
          const loginHint = ['log in', 'sign in', 'create an account'].some((h) => body.includes(h));
          return { error: loginHint ? 'MUSE_LOGIN_REQUIRED' : 'MUSE_NO_TEXTAREA' };
        }
        const beforeBubbles = document.querySelectorAll('div[class*="hatch-agent-bubble-bg"]').length;
        const beforeAtts = Array.from(
          document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]'),
        ).map((a) => a.getAttribute('data-testid') || '');

        if (Array.isArray(files) && files.length > 0) {
          const fileInput = document.querySelector('input[type="file"]');
          if (fileInput) {
            for (const f of files) {
              try {
                const bin = atob(f.b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const dt = new DataTransfer();
                dt.items.add(new File([bytes], f.filename || 'ref.jpg', { type: f.mime || 'image/jpeg' }));
                fileInput.files = dt.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise((r) => setTimeout(r, 400));
              } catch {
                // continue
              }
            }
          }
        }

        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(ta, promptText);
        } else {
          ta.value = promptText;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));

        const sendBtn = Array.from(document.querySelectorAll('button,[role=button]'))
          .filter((b) => b.offsetParent !== null)
          .find((b) => /send|发送/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')));
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          const evInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          ta.dispatchEvent(new KeyboardEvent('keydown', evInit));
        }
        return { ok: true, beforeBubbles, beforeAtts };
      },
    });
    const sub = subRes?.result;
    if (!sub || sub.error) {
      sendToAgent({ id, error: sub?.error || 'MUSE_SUBMIT_FAILED' });
      return;
    }

    const beforeBubbles = sub.beforeBubbles || 0;
    const beforeAttSet = new Set(sub.beforeAtts || []);
    const deadline = Date.now() + timeoutMs;
    let stableCount = 0;
    let lastTextSeen = '';

    while (Date.now() < deadline) {
      await sleep(2000);
      const [pollRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [beforeBubbles, Array.from(beforeAttSet), kind],
        func: async (minBubbles, oldAtts, wantKind) => {
          // Auto-deny any inline public-link approval cards so Muse never blocks
          for (const card of document.querySelectorAll('[data-testid="hatch-inline-approval-card"]')) {
            const btn = Array.from(card.querySelectorAll('button,[role=button]')).find((b) =>
              /^(deny|decline|reject|don.t allow)$/i.test((b.innerText || '').trim()),
            );
            if (btn && !btn.disabled) btn.click();
          }

          const generating = !!document.querySelector('button[aria-label*="Stop" i]');
          const bubbles = Array.from(document.querySelectorAll('div[class*="hatch-agent-bubble-bg"]'));
          const lastText = bubbles.length > minBubbles ? (bubbles[bubbles.length - 1].innerText || '').trim() : '';

          if (wantKind === 'llm') {
            return { generating, bubbleCount: bubbles.length, lastText };
          }

          const oldSet = new Set(oldAtts);
          const atts = Array.from(
            document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]'),
          );
          for (const a of atts) {
            const tid = a.getAttribute('data-testid') || '';
            if (oldSet.has(tid)) continue;
            const v = a.querySelector('video');
            const img = a.querySelector('img');
            const m = wantKind === 'video' ? v : img || v;
            const src = m ? m.currentSrc || m.src || '' : '';
            if (src && !generating) {
              try {
                const r = await fetch(src);
                const b = await r.blob();
                if (b && b.size > 1000) {
                  const buf = new Uint8Array(await b.arrayBuffer());
                  let s = '';
                  for (let i = 0; i < buf.length; i += 0x8000) {
                    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
                  }
                  return {
                    done: true,
                    generating: false,
                    lastText,
                    media: {
                      mime: b.type || (wantKind === 'video' ? 'video/mp4' : 'image/webp'),
                      size: b.size,
                      b64: btoa(s),
                    },
                  };
                }
              } catch {
                // keep polling
              }
            }
          }
          return { done: false, generating, bubbleCount: bubbles.length, lastText };
        },
      });
      const p = pollRes?.result;
      if (!p) continue;
      if (kind === 'llm') {
        if (!p.generating && p.bubbleCount > beforeBubbles && p.lastText) {
          if (p.lastText === lastTextSeen) {
            stableCount += 1;
            if (stableCount >= 2) {
              sendToAgent({ id, status: 200, data: { text: p.lastText } });
              return;
            }
          } else {
            lastTextSeen = p.lastText;
            stableCount = 1;
          }
        }
      } else if (p.done && p.media) {
        sendToAgent({ id, status: 200, data: { text: p.lastText || '', media: p.media } });
        return;
      }
    }
    sendToAgent({ id, error: 'MUSE_WEB_TIMEOUT' });
  } catch (e) {
    sendToAgent({ id, error: e?.message || 'MUSE_WEB_RUN_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── State & Badge ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors  = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[newState] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

// ─── Popup Message Handlers ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected:       ws?.readyState === WebSocket.OPEN,
      flowKeyPresent:  !!flowKey,
      manualDisconnect,
      tokenAge:        metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount:  metrics.failedCount,
        lastError:    metrics.lastError,
      },
      state,
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    ws?.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({ url: flowUrls }).then(async (tabs) => {
      try {
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          reply({ ok: true, tabId: tabs[0].id });
        } else {
          // User-initiated → focus the new window so they can see it.
          const tab = await openFlowTabResilient(true);
          reply({ ok: true, tabId: tab?.id });
        }
      } catch (e) {
        reply({ error: e.message });
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

console.log('[Flowboard] Extension loaded');
init();
