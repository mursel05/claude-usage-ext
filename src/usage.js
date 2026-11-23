// Pure helpers, shared by the service worker, popup and tests.

// 0.07 * 100 === 7.000000000000001; keep percents clean.
const round2 = (n) => Math.round(n * 100) / 100;

/** windows["5h"|"7d"]: {"status", "resets_at": <unix seconds>, "utilization": 0..1} */
function parseWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    percent: round2(Math.min(100, Math.max(0, w.utilization * 100))),
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null,
  };
}

/** Turns a `message_limit` payload into a snapshot, or null if it has no usable numbers. */
export function parseMessageLimit(ml, now = Date.now()) {
  const windows = ml?.windows ?? {};
  let fiveHour = parseWindow(windows['5h']);

  // Fallback: the resolved session limit carries the same 5-hour percent.
  const lim = ml?.resolved?.limit;
  if (!fiveHour && lim?.kind === 'session' && typeof lim.percent === 'number') {
    const t = Date.parse(lim.resets_at);
    fiveHour = { percent: lim.percent, resetsAt: Number.isNaN(t) ? null : t };
  }

  const weekly = parseWindow(windows['7d']);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, at: now };
}

/** Once a window's reset time has passed, that window is empty again. */
function age(w, now) {
  if (!w) return null;
  return w.resetsAt && w.resetsAt <= now ? { percent: 0, resetsAt: null } : w;
}

/** Current view of a stored snapshot. */
export function currentUsage(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  return {
    fiveHour: age(snapshot.fiveHour, now),
    weekly: age(snapshot.weekly, now),
    delta: snapshot.delta ?? null,
    at: snapshot.at,
  };
}

const SAME_WINDOW_MS = 2 * 60 * 1000;

/**
 * Adds `delta` = how many percentage points each window grew since the previous snapshot,
 * i.e. what the last message cost. null when it can't be known (first message ever, or the
 * window changed in a way we can't compare).
 */
export function withDelta(prev, next) {
  const before = currentUsage(prev, next.at);
  const diff = (k) => {
    const n = next[k];
    const p = before?.[k];
    if (!n || !p) return null;
    const sameWindow = p.resetsAt && n.resetsAt && Math.abs(p.resetsAt - n.resetsAt) < SAME_WINDOW_MS;
    if (sameWindow) return round2(Math.max(0, n.percent - p.percent));
    if (p.percent === 0) return n.percent; // previous window had reset: this message opened a new one
    return null;
  };
  return { ...next, delta: { fiveHour: diff('fiveHour'), weekly: diff('weekly') } };
}

/** "+1%", "+0.5%", or "–" when unknown. */
export function formatDelta(d) {
  if (d == null) return '–';
  return `+${Number.isInteger(d) ? d : d.toFixed(1)}%`;
}
