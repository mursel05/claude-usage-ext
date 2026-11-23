// ISOLATED world.
// 1) Forwards message_limit events from stream-hook.js to the service worker (Free plan data,
//    and the "a message was just sent" signal for paid plans).
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (d?.source !== 'claude-usage-ext:message_limit' || typeof d.payload !== 'object') return; // null = no event
  chrome.runtime.sendMessage({ type: 'message_limit', payload: d.payload, meta: d.meta ?? null }).catch(() => {});
});

// 2) Same-origin fallback for the service worker's /api requests (see src/api.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'fetch' || !msg.path?.startsWith('/api/')) return;
  fetch(msg.path, { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(async (r) => sendResponse({ ok: r.ok, status: r.status, body: r.ok ? await r.json() : null }))
    .catch(() => sendResponse({ ok: false, status: 0 }));
  return true;
});
