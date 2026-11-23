// Paid plans (Pro/Max): read the same endpoint as claude.ai → Settings → Usage.
// On the Free plan this endpoint returns only nulls; fetchApiUsage() then resolves to null and
// the extension keeps using the per-message stream data instead.
// Internal web endpoint, not a public API: it can change without notice.

const BASE = 'https://claude.ai';

export class AuthError extends Error {}

/**
 * GET a claude.ai JSON path. First from the service worker (host permission attaches the
 * session cookies). If that is rejected (e.g. a Cloudflare challenge), retry from an open
 * claude.ai tab via relay.js, where the request is same-origin like the site's own.
 */
async function getJson(path) {
  let status = 0;
  try {
    const res = await fetch(BASE + path, { credentials: 'include', headers: { Accept: 'application/json' } });
    status = res.status;
    if (res.ok) return await res.json();
  } catch {
    // network error: try the tab, then report
  }

  const tabs = await chrome.tabs.query({ url: `${BASE}/*` }).catch(() => []);
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'fetch', path });
      if (r?.ok) return r.body;
      if (r?.status) status = r.status;
      break;
    } catch {
      // tab has no content script yet (opened before install): try the next one
    }
  }

  if (status === 401 || status === 403) throw new AuthError(`HTTP ${status}`);
  throw new Error(status ? `HTTP ${status}` : 'Offline');
}

async function resolveOrgId(cachedId) {
  if (cachedId) return cachedId;
  const orgs = await getJson('/api/organizations');
  const chatOrgs = Array.isArray(orgs) ? orgs.filter((o) => o.capabilities?.includes('chat')) : [];
  if (!chatOrgs.length) throw new AuthError('No claude.ai organization');
  const cookie = await chrome.cookies.get({ url: BASE, name: 'lastActiveOrg' }).catch(() => null);
  return (chatOrgs.find((o) => o.uuid === cookie?.value) ?? chatOrgs[0]).uuid;
}

/** five_hour / seven_day: {"utilization": 42.0 (percent), "resets_at": ISO string} */
function parseWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return {
    percent: Math.round(Math.min(100, Math.max(0, w.utilization)) * 100) / 100,
    resetsAt: Number.isNaN(t) ? null : t,
  };
}

function fromLimits(limits, kind) {
  const l = Array.isArray(limits) ? limits.find((x) => x?.kind === kind) : null;
  return l ? parseWindow({ utilization: l.percent, resets_at: l.resets_at }) : null;
}

/**
 * @returns {Promise<{orgId: string, usage: {fiveHour, weekly} | null}>}
 *   usage is null on the Free plan (endpoint has no data).
 */
export async function fetchApiUsage(cachedOrgId) {
  let orgId = await resolveOrgId(cachedOrgId);
  let raw;
  try {
    raw = await getJson(`/api/organizations/${orgId}/usage`);
  } catch (e) {
    if (!cachedOrgId) throw e;
    // Cached org may be stale (switched account/org): resolve again once.
    orgId = await resolveOrgId(null);
    raw = await getJson(`/api/organizations/${orgId}/usage`);
  }
  const fiveHour = parseWindow(raw?.five_hour) ?? fromLimits(raw?.limits, 'session');
  const weekly = parseWindow(raw?.seven_day) ?? fromLimits(raw?.limits, 'weekly_all');
  return { orgId, usage: fiveHour || weekly ? { fiveHour, weekly } : null };
}
