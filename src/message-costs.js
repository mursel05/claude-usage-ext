// ISOLATED world: shows what each sent message cost under that message on claude.ai,
// e.g. "+2% 5h · +0% 7d". Data comes from background.js (msgCosts), keyed by conversation and
// by the message id (data-turn-key). Toggle: popup → "Show cost on messages".
(() => {
  if (window.top !== window) return;

  // claude.ai's user-message element. If claude.ai changes its markup, update this first.
  const USER_MESSAGE = '[data-testid="user-message"]';
  const BADGE = 'claude-usage-cost';

  let costs = {};
  let enabled = true;
  let timer = null;
  let lastLog = '';
  const log = (...a) => console.info('[Usage Meter]', ...a);

  const conversationId = () => location.pathname.match(/\/chat\/([0-9a-f-]{36})/i)?.[1] ?? null;
  const fmt = (d) => (d == null ? '–' : `+${Number.isInteger(d) ? d : d.toFixed(1)}%`);

  function label(d) {
    if (!d || (d.fiveHour == null && d.weekly == null)) return null;
    return `${fmt(d.fiveHour)} 5h · ${fmt(d.weekly)} 7d`;
  }

  function makeBadge() {
    const b = document.createElement('div');
    b.className = BADGE;
    b.title = 'Claude usage this message used (5-hour · weekly limit)';
    Object.assign(b.style, {
      font: '500 11px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif',
      fontVariantNumeric: 'tabular-nums',
      opacity: '0.55',
      marginTop: '4px',
      userSelect: 'none',
      pointerEvents: 'auto',
    });
    return b;
  }

  function render() {
    timer = null;
    const conv = conversationId();
    const c = enabled && conv ? costs[conv] : null;

    for (const el of document.querySelectorAll(USER_MESSAGE)) {
      const next = el.nextElementSibling;
      let badge = next?.classList.contains(BADGE) ? next : null;

      // Each message row carries its permanent id in data-turn-key.
      const key = el.closest('[data-turn-key]')?.getAttribute('data-turn-key');
      const text = c && key ? label(c.items?.[key]) : null;

      if (!text) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = makeBadge();
        el.after(badge);
      }
      if (badge.textContent !== text) badge.textContent = text;
    }
    // Diagnostics: which message ids are on the page vs. which have a stored cost.
    if (conv) {
      const onPage = [...document.querySelectorAll(USER_MESSAGE)].map(
        (el) => el.closest('[data-turn-key]')?.getAttribute('data-turn-key') ?? '(no data-turn-key)',
      );
      const line = JSON.stringify({ conv, onPage, stored: Object.keys(c?.items ?? {}) });
      if (line !== lastLog) log('messages', JSON.parse((lastLog = line)));
    }
    if (!enabled) document.querySelectorAll(`.${BADGE}`).forEach((b) => b.remove());
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(render, 250);
  };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.lastMessage?.newValue) log('cost result', ch.lastMessage.newValue);
    if (ch.msgCosts) costs = ch.msgCosts.newValue ?? {};
    if (ch.showMsgCost) enabled = ch.showMsgCost.newValue !== false;
    if (ch.msgCosts || ch.showMsgCost) schedule();
  });

  chrome.storage.local.get(['msgCosts', 'showMsgCost']).then((s) => {
    costs = s.msgCosts ?? {};
    enabled = s.showMsgCost !== false; // on by default
    // claude.ai is a SPA: re-render when messages appear or the conversation changes.
    // render() is idempotent, so its own badge inserts settle after one extra pass.
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  });
})();
