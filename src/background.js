import { parseMessageLimit, currentUsage, withDelta } from './usage.js';
import { fetchApiUsage, AuthError } from './api.js';

// Data sources:
//  - Paid (Pro/Max): /api/organizations/{id}/usage — polled every 5 min, on popup open and right
//    after each message. Authoritative: also reflects usage from other devices / Claude Code.
//  - Free: that endpoint is empty, so the `message_limit` event of each completion stream is used.
// `plan` ('paid' | 'free') is detected from the endpoint and re-checked hourly for Free accounts.

const TICK = 'tick'; // 1 min: re-evaluate resets, badge
const POLL = 'poll'; // 5 min: API refresh
const FREE_RECHECK_MS = 60 * 60 * 1000;
const AFTER_MESSAGE_DELAY_MS = 2500; // let the server account the message before reading /usage
const THRESHOLDS = [80, 100];
const WINDOWS = [
  ['fiveHour', '5-hour limit'],
  ['weekly', 'Weekly limit'],
];

const store = chrome.storage.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- badge ----------

function colorFor(p) {
  if (p >= 90) return '#dc2626';
  if (p >= 70) return '#d97706';
  return '#16a34a';
}

async function updateBadge(usage) {
  const p = usage?.fiveHour?.percent;
  if (p == null) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Claude usage — send a message on claude.ai to load' });
    return;
  }
  await chrome.action.setBadgeText({ text: `${Math.round(p)}` });
  await chrome.action.setBadgeBackgroundColor({ color: colorFor(p) });
  await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  const w = usage.weekly?.percent;
  await chrome.action.setTitle({
    title: `Claude usage — 5-hour: ${Math.round(p)}%` + (w != null ? ` · weekly: ${Math.round(w)}%` : ''),
  });
}

// ---------- notifications ----------

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: '/icons/128.png', title, message, priority: 1 });
}

function fmtReset(ts) {
  if (!ts) return 'soon';
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

async function maybeNotify(prev, next) {
  const { notified = {} } = await store.get('notified');

  for (const [key, label] of WINDOWS) {
    const w = next?.[key];
    if (w?.percent == null) continue;

    // Thresholds fire once per window cycle (a cycle is identified by its reset minute).
    const id = `${key}:${w.resetsAt ? Math.round(w.resetsAt / 60000) : 'none'}`;
    const sent = notified[id] ?? [];
    const hit = [...THRESHOLDS].reverse().find((t) => w.percent >= t && !sent.includes(t));
    if (hit) {
      THRESHOLDS.filter((t) => t <= hit).forEach((t) => sent.includes(t) || sent.push(t));
      notify(
        `${label}: ${Math.round(w.percent)}%`,
        hit >= 100 ? `Limit reached. Resets ${fmtReset(w.resetsAt)}.` : `Resets ${fmtReset(w.resetsAt)}.`,
      );
    }
    notified[id] = sent;

    if (prev?.[key]?.percent >= 100 && w.percent < 100) notify(`${label} reset`, 'You can use Claude again.');
  }

  const live = new Set(
    WINDOWS.map(([k]) => `${k}:${next?.[k]?.resetsAt ? Math.round(next[k].resetsAt / 60000) : 'none'}`),
  );
  for (const k of Object.keys(notified)) if (!live.has(k)) delete notified[k];
  await store.set({ notified });
}

// ---------- state ----------

/** Recomputes the current view (windows may have reset since the data was read). */
async function recompute() {
  const { snapshot, view: prev } = await store.get(['snapshot', 'view']);
  const view = currentUsage(snapshot);
  await store.set({ view });
  await updateBadge(view);
  await maybeNotify(prev, view);
  return view;
}

/**
 * Reads /usage. Returns true if it produced data (paid plan).
 * fromMessage: compute the per-message delta against the previous reading.
 */
let polling = null;
function pollApi({ fromMessage = false } = {}) {
  polling ??= (async () => {
    const { snapshot: prev, orgId } = await store.get(['snapshot', 'orgId']);
    try {
      const { orgId: id, usage } = await fetchApiUsage(orgId);
      if (!usage) {
        await store.set({ plan: 'free', planCheckedAt: Date.now(), orgId: id, apiError: null });
        return false;
      }
      const next = { ...usage, at: Date.now(), source: 'api' };
      const snapshot = fromMessage ? withDelta(prev, next) : { ...next, delta: prev?.delta ?? null };
      await store.set({ snapshot, plan: 'paid', planCheckedAt: Date.now(), orgId: id, apiError: null });
      return true;
    } catch (e) {
      const auth = e instanceof AuthError;
      await store.set({ apiError: auth ? 'auth' : 'network', ...(auth ? { orgId: null } : {}) });
      return false;
    } finally {
      await recompute();
      await updateActive();
    }
  })().finally(() => (polling = null));
  return polling;
}

async function shouldPoll() {
  const { plan, planCheckedAt = 0 } = await store.get(['plan', 'planCheckedAt']);
  return plan !== 'free' || Date.now() - planCheckedAt > FREE_RECHECK_MS;
}

// ---------- per-message cost (shown next to each sent message on claude.ai) ----------

const MAX_CONVERSATIONS = 300;

/**
 * msgCosts: { [conversationId]: { t, items: { [userMessageId]: {fiveHour, weekly} } } }
 * A retry re-answers the same user message, so its cost is added to that message.
 */
async function recordCost(meta, delta) {
  if (!meta?.conv || !meta.key) return;
  if (!delta || (delta.fiveHour == null && delta.weekly == null)) return;
  const { msgCosts = {} } = await store.get('msgCosts');
  const c = (msgCosts[meta.conv] ??= { t: 0, items: {} });
  c.t = Date.now();

  const prev = c.items[meta.key];
  const add = (a, b) => (a == null ? b : b == null ? a : Math.round((a + b) * 100) / 100);
  c.items[meta.key] =
    prev && meta.retry
      ? { fiveHour: add(prev.fiveHour, delta.fiveHour), weekly: add(prev.weekly, delta.weekly) }
      : { fiveHour: delta.fiveHour, weekly: delta.weekly };

  // Keep storage bounded: drop the least recently used conversations.
  const ids = Object.keys(msgCosts);
  if (ids.length > MAX_CONVERSATIONS) {
    ids.sort((a, b) => msgCosts[a].t - msgCosts[b].t);
    for (const id of ids.slice(0, ids.length - MAX_CONVERSATIONS)) delete msgCosts[id];
  }
  await store.set({ msgCosts });
}

// Paid plans: a sent message stays "active" until its reply finishes (the page's Stop button goes
// away), the next message is sent, or ACTIVE_MAX_MS passes. Its cost is /usage now minus /usage
// when it was sent, re-read every 30 s and at the end, so long replies (tools, Code sessions) are
// fully counted whatever transport the page uses. /usage is account-wide: usage from elsewhere in
// the same minutes (another tab, Claude Code) lands on this message too.
// active: { conv, key, base: {fiveHour, weekly}, prev (retry: cost so far), since }
const ACTIVE = 'active';
const ACTIVE_MAX_MS = 20 * 60 * 1000;
const SAME_WINDOW_MS = 2 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/** Percentage points used in a window since `base`; if the window reset meanwhile, all of `now`. */
function growth(base, now) {
  if (!base || !now) return null;
  const same = base.resetsAt && now.resetsAt && Math.abs(base.resetsAt - now.resetsAt) < SAME_WINDOW_MS;
  return same ? round2(Math.max(0, now.percent - base.percent)) : now.percent;
}

async function onMessageSent({ conv, key, retry }) {
  if (!conv || !key) return;
  const { plan, active } = await store.get(['plan', 'active']);
  if (plan === 'free') return; // Free: the cost comes from the reply stream (onMessageLimit)

  if (retry && active?.key === key) {
    await store.set({ active: { ...active, since: Date.now() } });
  } else {
    await pollApi(); // fresh reading before the reply uses anything
    const { snapshot, plan: p, msgCosts = {} } = await store.get(['snapshot', 'plan', 'msgCosts']);
    const base = currentUsage(snapshot);
    if (p === 'free' || !base) return;
    // A retry answers the same message again: add to what it already cost.
    const prev = retry ? Object.values(msgCosts).find((c) => c.items?.[key])?.items[key] ?? null : null;
    await store.set({
      active: { conv, key, prev, base: { fiveHour: base.fiveHour, weekly: base.weekly }, since: Date.now() },
    });
  }
  chrome.alarms.create(ACTIVE, { periodInMinutes: 0.5 });
}

/** The reply finished: final reading, then stop measuring (later usage is not this message's). */
async function onReplyDone({ key }) {
  await sleep(AFTER_MESSAGE_DELAY_MS); // let the server account the reply (and onMessageSent settle)
  const { active } = await store.get('active');
  if (active?.key !== key) return;
  await pollApi();
  const { active: now } = await store.get('active');
  if (now?.key !== key) return; // a newer message was sent meanwhile
  await store.remove('active');
  await chrome.alarms.clear(ACTIVE);
}

/** Called after every /usage read: updates the active message's cost. */
async function updateActive() {
  const { active, snapshot } = await store.get(['active', 'snapshot']);
  if (!active) return;
  if (Date.now() - active.since > ACTIVE_MAX_MS) {
    await store.remove('active');
    await chrome.alarms.clear(ACTIVE);
    return;
  }
  if (snapshot?.source !== 'api') return;
  const now = currentUsage(snapshot);
  const plus = (a, b) => (a == null ? b : b == null ? a : round2(a + b));
  await recordCost(
    { conv: active.conv, key: active.key },
    {
      fiveHour: plus(active.prev?.fiveHour, growth(active.base.fiveHour, now?.fiveHour)),
      weekly: plus(active.prev?.weekly, growth(active.base.weekly, now?.weekly)),
    },
  );
}

async function onMessageLimit(payload, meta) {
  const streamSnap = parseMessageLimit(payload);
  const { plan } = await store.get('plan');

  // Paid: the cost is tracked by the active message; just read /usage now that the reply is done.
  if (plan !== 'free') {
    await sleep(AFTER_MESSAGE_DELAY_MS);
    if (await pollApi()) return;
  }

  // Free plan, or the API was unreachable: use the stream numbers.
  if (!streamSnap) return;
  const { snapshot: prev } = await store.get('snapshot');
  const snapshot = withDelta(prev, { ...streamSnap, source: 'stream' });
  await store.set({ snapshot });
  await recompute();
  await recordCost(meta, snapshot.delta);
}

// ---------- triggers ----------

function ensureAlarms() {
  chrome.alarms.get(TICK, (a) => a || chrome.alarms.create(TICK, { periodInMinutes: 1 }));
  chrome.alarms.get(POLL, (a) => a || chrome.alarms.create(POLL, { periodInMinutes: 5, delayInMinutes: 0.1 }));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['lastMessage', 'dbgSent', 'dbgBg', 'dbgErr']); // old diagnostics
  // Test data from development builds.
  chrome.storage.local.get('msgCosts').then(({ msgCosts }) => {
    if (msgCosts?.__debug) {
      delete msgCosts.__debug;
      chrome.storage.local.set({ msgCosts });
    }
  });
  ensureAlarms();
  pollApi();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  recompute();
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === TICK) recompute();
  if (a.name === POLL && (await shouldPoll())) pollApi();
  if (a.name === ACTIVE) pollApi();
});

chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: 'https://claude.ai/new' }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'get') {
    // Popup opened: fresh API read for paid plans.
    shouldPoll()
      .then((p) => (p ? pollApi() : null))
      .then(recompute)
      .then(sendResponse);
    return true;
  }
  if (!sender.url?.startsWith('https://claude.ai/')) return;
  if (msg?.type === 'message_limit') onMessageLimit(msg.payload, msg.meta);
  if (msg?.type === 'message_sent') onMessageSent(msg);
  if (msg?.type === 'reply_done') onReplyDone(msg);
});
