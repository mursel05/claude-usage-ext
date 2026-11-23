import { currentUsage } from '../src/usage.js';

const CIRC = 2 * Math.PI * 42;
const $ = (s) => document.querySelector(s);

let snapshot = null;
let apiError = null;

function colorFor(p) {
  if (p >= 90) return '#dc2626';
  if (p >= 70) return '#d97706';
  return '#16a34a';
}

function countdown(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  if (m > 0) return `${mm}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

function absolute(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(
    [],
    sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' },
  );
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function renderGauge(el, w) {
  const pct = el.querySelector('.pct');
  const bar = el.querySelector('.bar');
  const reset = el.querySelector('.reset');

  if (w?.percent == null) {
    pct.textContent = '–';
    bar.style.strokeDashoffset = CIRC;
    reset.textContent = '';
    return;
  }
  const p = w.percent;
  pct.textContent = `${Math.round(p)}%`;
  bar.style.setProperty('--c', colorFor(p));
  bar.style.strokeDashoffset = CIRC * (1 - p / 100);
  if (w.resetsAt) {
    reset.innerHTML = `Resets in ${countdown(w.resetsAt)}<br>${absolute(w.resetsAt)}`;
  } else {
    reset.textContent = p === 0 ? 'Window reset' : '';
  }
}

function render() {
  const u = currentUsage(snapshot);
  $('#empty').hidden = !!u;
  $('#empty-text').innerHTML =
    apiError === 'auth'
      ? 'Sign in to <a href="https://claude.ai/login" target="_blank">claude.ai</a> in this browser.'
      : 'No data yet. Send a message on <a href="https://claude.ai/new" target="_blank">claude.ai</a> and the meter will fill in.';
  renderGauge($('#g-five'), u?.fiveHour);
  renderGauge($('#g-week'), u?.weekly);
  $('#updated').textContent = u ? `Updated ${ago(u.at)}` : '';
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.snapshot) snapshot = changes.snapshot.newValue ?? null;
  if (changes.apiError) apiError = changes.apiError.newValue ?? null;
  if (changes.snapshot || changes.apiError) render();
});

const overlayToggle = $('#overlay');
overlayToggle.addEventListener('change', () => chrome.storage.local.set({ overlay: overlayToggle.checked }));
const msgCostToggle = $('#msgcost');
msgCostToggle.addEventListener('change', () => chrome.storage.local.set({ showMsgCost: msgCostToggle.checked }));

(async () => {
  const s = await chrome.storage.local.get(['snapshot', 'overlay', 'apiError', 'showMsgCost']);
  snapshot = s.snapshot ?? null;
  apiError = s.apiError ?? null;
  overlayToggle.checked = s.overlay !== false; // on by default
  msgCostToggle.checked = s.showMsgCost !== false;
  render();
  chrome.runtime.sendMessage({ type: 'get' }).catch(() => {}); // refresh badge too
  setInterval(render, 1000);
})();
