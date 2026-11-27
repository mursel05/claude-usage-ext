// ISOLATED world, on every claude.ai page (chats, projects, Code sessions…):
//  1. tells background.js when the user sends a message (which message, by its data-turn-key),
//     so the cost of that message can be measured on paid plans, and
//  2. shows what each sent message cost under it, e.g. "+2% 5h · +0% 7d".
// Costs come from background.js (msgCosts). Message ids are unique, so they are looked up across
// all conversations and the page URL format doesn't matter. Toggle: popup → "Show cost on messages".
(() => {
  if (window.top !== window) return;

  // claude.ai's user-message element. If claude.ai changes its markup, update this first.
  const USER_MESSAGE = '[data-testid="user-message"]';
  const BADGE = 'claude-usage-cost';
  // A new message counts as sent by the user only if they acted (Enter, send/retry/edit) this recently.
  const ACTION_WINDOW_MS = 30000;

  let byKey = new Map();
  let enabled = true;
  let timer = null;

  const fmt = (d) => (d == null ? '–' : `+${Number.isInteger(d) ? d : d.toFixed(1)}%`);

  function label(d) {
    if (!d || (d.fiveHour == null && d.weekly == null)) return null;
    return `${fmt(d.fiveHour)} 5h · ${fmt(d.weekly)} 7d`;
  }

  function index(msgCosts) {
    byKey = new Map();
    for (const c of Object.values(msgCosts ?? {})) for (const [k, v] of Object.entries(c.items ?? {})) byKey.set(k, v);
  }

  const keyOf = (el) => el.closest('[data-turn-key]')?.getAttribute('data-turn-key') ?? null;

  // ---------- 1. detect sent messages ----------

  let lastAction = 0;
  let path = null;
  let newestKey = null;
  let seen = new Set();

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest('[contenteditable="true"], textarea')) lastAction = Date.now();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target instanceof Element ? e.target.closest('button') : null;
      if (!b) return;
      const name = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('data-testid') ?? ''} ${b.type === 'submit' ? 'submit' : ''} ${b.textContent ?? ''}`;
      if (/retry|regenerate|try again/i.test(name)) {
        lastAction = Date.now();
        // A retry answers the same message again: its cost is added to that message.
        setTimeout(() => newestKey && sent(newestKey, true), 1000);
      } else if (/send|submit|save|edit/i.test(name)) {
        lastAction = Date.now();
      }
    },
    true,
  );

  let pendingKey = null; // sent from this tab, reply not finished yet
  let busySeen = false;

  function sent(key, retry = false) {
    pendingKey = key;
    busySeen = false;
    chrome.runtime.sendMessage({ type: 'message_sent', conv: location.pathname, key, retry }).catch(() => {});
  }

  // While Claude replies (chat or Code), the composer shows a Stop button. When it goes away the
  // reply is done, and the background takes its final reading for that message.
  const replying = () =>
    !!document.querySelector('button[data-testid*="stop" i], button[aria-label^="Stop" i], button[aria-label^="Interrupt" i]');
  setInterval(() => {
    if (!pendingKey) return;
    if (replying()) {
      busySeen = true;
    } else if (busySeen) {
      chrome.runtime.sendMessage({ type: 'reply_done', key: pendingKey }).catch(() => {});
      pendingKey = null;
    }
  }, 500);

  function detectSend(messages) {
    const newest = messages.length ? keyOf(messages[messages.length - 1]) : null;
    const recent = Date.now() - lastAction < ACTION_WINDOW_MS;

    if (location.pathname !== path) {
      // New page. A first message on an empty page (new chat → /chat/<id>, /code → session) is a send.
      const wasEmpty = newestKey == null;
      path = location.pathname;
      seen = new Set(messages.map(keyOf).filter(Boolean));
      newestKey = newest;
      if (newest && wasEmpty && recent && messages.length === 1) sent(newest);
      return;
    }
    if (newest && newest !== newestKey && !seen.has(newest)) {
      newestKey = newest;
      seen.add(newest);
      if (recent) sent(newest);
      return;
    }
    if (newest) newestKey = newest;
    for (const m of messages) {
      const k = keyOf(m);
      if (k) seen.add(k);
    }
  }

  // ---------- 2. show costs ----------

  function makeBadge() {
    const b = document.createElement('div');
    b.className = BADGE;
    b.title = 'Claude usage this message used (5-hour · weekly limit)';
    Object.assign(b.style, {
      font: '500 11px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif',
      fontVariantNumeric: 'tabular-nums',
      opacity: '0.55',
      marginTop: '4px',
      textAlign: 'right',
      alignSelf: 'flex-end',
      userSelect: 'none',
      pointerEvents: 'auto',
    });
    return b;
  }

  function render() {
    timer = null;
    const messages = [...document.querySelectorAll(USER_MESSAGE)];
    detectSend(messages);

    for (const el of messages) {
      // Right under the bubble, outside it: long messages are collapsed ("Show more") and would
      // hide or cut a label placed inside. The row is [bubble, hover actions]; the label goes between.
      const host = el.closest('[data-turn-key]') ?? el.parentElement;
      if (!host) continue;
      let bubble = el;
      while (bubble.parentElement && bubble.parentElement !== host) bubble = bubble.parentElement;
      let badge = host.querySelector(`:scope > .${BADGE}`);
      const key = keyOf(el);
      const text = enabled && key ? label(byKey.get(key)) : null;

      if (!text) {
        badge?.remove();
        continue;
      }
      if (!badge) badge = makeBadge();
      if (bubble.nextElementSibling !== badge) bubble.after(badge);
      if (badge.textContent !== text) badge.textContent = text;
    }
    if (!enabled) document.querySelectorAll(`.${BADGE}`).forEach((b) => b.remove());
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(render, 250);
  };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.msgCosts) index(ch.msgCosts.newValue);
    if (ch.showMsgCost) enabled = ch.showMsgCost.newValue !== false;
    if (ch.msgCosts || ch.showMsgCost) schedule();
  });

  chrome.storage.local.get(['msgCosts', 'showMsgCost']).then((s) => {
    index(s.msgCosts);
    enabled = s.showMsgCost !== false; // on by default
    // claude.ai is a SPA: re-render when messages appear or the conversation changes.
    // render() is idempotent, so its own badge inserts settle after one extra pass.
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  });
})();
