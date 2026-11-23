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

  function place() {
    frame = null;
    if (!els) return;
    const s = els.pill.style;
    const r = composerBox()?.getBoundingClientRect();
    if (!r || r.width === 0) {
      // No composer on this page: bottom-right of the window.
      s.right = `${16}px`;
      s.bottom = `${16}px`;
      return;
    }
    s.right = `${Math.max(0, window.innerWidth - r.right)}px`;
    s.bottom = `${Math.max(0, window.innerHeight - r.top) + GAP}px`;
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
