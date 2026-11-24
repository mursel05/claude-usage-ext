// ISOLATED world: usage meter (5h / 7d bars + percents) pinned just above the message composer,
// aligned to its right edge. Not draggable, nothing to open. Toggle: popup → "Show on claude.ai".
(() => {
  if (window.top !== window) return;

  const GAP = 8;
  let snapshot = null;
  let enabled = true;
  let host, els, timer, frame;

  // Keep in sync with src/usage.js (content scripts can't import ES modules).
  const age = (w, now) => (!w ? null : w.resetsAt && w.resetsAt <= now ? { percent: 0, resetsAt: null } : w);
  const colorFor = (p) => (p >= 90 ? '#ef4444' : p >= 70 ? '#f59e0b' : '#22c55e');

  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .pill {
      position: fixed; z-index: 2147483000; pointer-events: none;
      display: flex; flex-direction: column; gap: 4px;
      min-width: 128px; padding: 7px 10px; border-radius: 12px;
      background: rgba(31, 30, 29, 0.9); color: #f5f4ed;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.25), inset 0 0 0 1px rgba(255,255,255,0.08);
      font: 600 11.5px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-variant-numeric: tabular-nums;
    }
    .row { display: grid; grid-template-columns: 20px 1fr 32px; align-items: center; gap: 6px; }
    .lbl { color: #a3a29a; }
    .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.14); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; border-radius: 3px; transition: width .4s ease, background .3s; }
    .pct { text-align: right; }
  `;

  /** Outermost painted box (background/border/shadow + rounded) around the editor, under 200px tall. */
  function composerBox() {
    const editor =
      document.querySelector('[data-testid="chat-input"]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]');
    if (!editor) return null;
    let best = editor;
    for (let el = editor.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.height > 200) break;
      const s = getComputedStyle(el);
      const painted =
        parseFloat(s.borderTopWidth) > 0 ||
        s.boxShadow !== 'none' ||
        (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent');
      if (painted && parseFloat(s.borderTopLeftRadius) > 0) best = el;
    }
    return best;
  }

  /** True when something (Settings, a modal, a full-page panel) sits on top of the message box. */
  function covered(r) {
    if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]')) return true;
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 24)));
    const hit = document.elementFromPoint(x, y);
    return !!hit && !composerBox()?.contains(hit) && !hit.contains(composerBox());
  }

  function place() {
    frame = null;
    if (!els) return;
    const s = els.pill.style;
    const r = composerBox()?.getBoundingClientRect();
    // Only pages with a message box (chat, new chat, projects, code…) show the meter, and only
    // while that box is actually visible: not behind Settings or another dialog.
    const show = !!r && r.width > 0 && !covered(r);
    if (els.pill.hidden === show) els.pill.hidden = !show;
    if (!show) return;

    const pw = els.pill.offsetWidth || 150;
    const ph = els.pill.offsetHeight || 44;
    const above = { left: r.right - pw, top: r.top - GAP - ph, width: pw, height: ph };
    const side = { left: r.right + GAP, top: r.top, width: pw, height: ph };
    // Above the box, right-aligned. If page content sits there (e.g. the greeting on a new chat)
    // and there is room, beside the box's top-right corner instead.
    const useSide = overlapsContent(above) && side.left + pw + GAP <= window.innerWidth;
    const pos = useSide ? side : above;
    s.left = `${Math.round(Math.max(0, pos.left))}px`;
    s.top = `${Math.round(Math.max(0, pos.top))}px`;
  }

  /** True if text, images or controls of the page (outside the chat transcript) are in or near rect. */
  function overlapsContent(rect) {
    const box = composerBox();
    // Checked with a margin, so the meter never butts right up against text either.
    const m = 16;
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      for (const fy of [0, 0.5, 1]) {
        const x = rect.left - m + (rect.width + 2 * m) * fx;
        const y = rect.top - m / 2 + (rect.height + m) * fy;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === host || el === document.body || el === document.documentElement) continue;
          if (box?.contains(el) || el.closest('[data-testid="transcript-sizer"]')) break;
          if (isContent(el)) return true;
          break; // only the topmost page element matters
        }
      }
    }
    return false;
  }

  function isContent(el) {
    if (el.closest('svg, img, video, canvas, button, a, input, textarea, select, [role="button"]')) return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }

  const schedulePlace = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };

  function mount() {
    if (host) return;
    host = document.createElement('claude-usage-overlay');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="pill">
        <div class="row" data-k="fiveHour"><span class="lbl">5h</span><span class="bar"><i></i></span><span class="pct">&ndash;</span></div>
        <div class="row" data-k="weekly"><span class="lbl">7d</span><span class="bar"><i></i></span><span class="pct">&ndash;</span></div>
      </div>`;
    els = { pill: root.querySelector('.pill'), rows: [...root.querySelectorAll('.row')] };
    document.documentElement.appendChild(host);
    render();
    place();
    window.addEventListener('resize', schedulePlace);
    // The composer grows with long input and moves on navigation/sidebar toggles.
    timer = setInterval(() => {
      render();
      schedulePlace();
    }, 500);
  }

  function unmount() {
    host?.remove();
    host = els = null;
    clearInterval(timer);
    window.removeEventListener('resize', schedulePlace);
  }

  function render() {
    if (!els) return;
    const now = Date.now();
    for (const row of els.rows) {
      const w = age(snapshot?.[row.dataset.k], now);
      const bar = row.querySelector('i');
      const pct = row.querySelector('.pct');
      if (w?.percent == null) {
        bar.style.width = '0';
        pct.textContent = '–';
        continue;
      }
      bar.style.width = `${w.percent}%`;
      bar.style.background = colorFor(w.percent);
      pct.textContent = `${Math.round(w.percent)}%`;
    }
  }

  function apply() {
    enabled ? mount() : unmount();
  }

  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.snapshot) snapshot = c.snapshot.newValue ?? null;
    if (c.overlay) {
      enabled = c.overlay.newValue !== false;
      apply();
    }
    render();
  });

  chrome.storage.local.get(['snapshot', 'overlay']).then((s) => {
    snapshot = s.snapshot ?? null;
    enabled = s.overlay !== false; // on by default
    chrome.storage.local.remove('overlayPos'); // left over from the draggable version
    document.body ? apply() : document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
})();
