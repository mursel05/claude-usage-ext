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

  /** Outermost painted box (background/border/shadow + rounded) around the editor, below page size. */
  function composerBox() {
    const editor =
      document.querySelector('[data-testid="chat-input"]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]');
    if (!editor) return null;
    let best = editor;
    for (let el = editor.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      // The box grows with attachments and long drafts; stop before reaching page-level containers.
      if (r.height > window.innerHeight * 0.6) break;
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

    s.left = s.top = '';
    s.right = `${Math.max(0, window.innerWidth - r.right)}px`;
    s.bottom = `${Math.max(0, window.innerHeight - dockTop(r)) + GAP}px`;
  }

  /**
   * Top of what claude.ai shows docked on top of the message box: notices ("You've used 75%…"),
   * Claude's questions with their choices, etc. They live in the same sticky footer as the box,
   * so the meter goes above them instead of covering them. Without such content: the box's top.
   */
  function dockTop(r) {
    const box = composerBox();
    let dock = null;
    for (let el = box?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.getBoundingClientRect().height > window.innerHeight * 0.6) break;
      if (getComputedStyle(el).position === 'sticky') dock = el;
    }
    if (!dock) return r.top;
    let top = r.top;
    // Only what is under the meter's own column (right end of the box) matters; e.g. the centred
    // "jump to latest" arrow doesn't push it up.
    const left = r.right - (els.pill.offsetWidth || 150);
    for (const el of dock.querySelectorAll('*')) {
      if (el === box || box.contains(el) || el.contains(box)) continue;
      const e = el.getBoundingClientRect();
      if (e.width < 1 || e.height < 1 || e.bottom > r.top + 1 || e.top >= top) continue;
      if (e.right < left || e.left > r.right) continue;
      if (hasContent(el)) top = e.top;
    }
    return top;
  }

  function hasContent(el) {
    if (el.matches('svg, img, button, input, textarea, [role="button"], [role="radio"], [role="option"]')) return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    const s = getComputedStyle(el);
    return parseFloat(s.borderTopWidth) > 0 || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent');
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
