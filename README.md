# Claude Usage Meter

Brave/Chrome (MV3) extension that shows claude.ai 5-hour and weekly usage — Free, Pro and Max.

## Install
1. `brave://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Reload any open claude.ai tab

## Data sources
| Plan | Source | Updates |
|---|---|---|
| Pro / Max | `GET /api/organizations/{id}/usage` → `five_hour` / `seven_day` `{utilization (percent), resets_at}` (falls back to `limits[]`) | every 5 min, on popup open, ~1.5 s after each message. Includes usage from other devices / Claude Code. |
| Free | That endpoint returns only nulls, so the `message_limit` SSE event of each completion stream is used: `windows.5h` / `windows.7d` `{utilization (0–1), resets_at (unix s)}` | after each message |

The plan is detected from the endpoint (re-checked hourly on Free). If the API is unreachable, the stream numbers are used.
Both sources send whole percents, so a short message often shows +0%. Costs are recorded from install onward; older messages show nothing.

| File | Role |
|---|---|
| `src/api.js` | `/usage` client. Service-worker fetch with the session cookie; falls back to a same-origin fetch from an open claude.ai tab (via `relay.js`). Org = `lastActiveOrg` cookie, else first org with `chat`. |
| `src/stream-hook.js` | MAIN-world content script. Wraps `fetch`, scans a **clone** of `.../completion` streams for `message_limit`. The page's own stream is untouched. |
| `src/relay.js` | Isolated content script: forwards the stream event; serves the API fallback fetch. |
| `src/usage.js` | Pure parsing, reset aging, per-message delta (`withDelta`). |
| `src/background.js` | Source selection, badge (5-hour %), 1-min reset re-check, notifications at 80% / 100% / reset. |
| `src/overlay.js` | Usage meter (5h / 7d bars + percents) fixed 8px above the message composer, right-aligned with it; follows resizes, sidebar toggles and a growing input. Shadow DOM, click-through. Toggle: popup → **Show on claude.ai** (on by default). |
| `src/message-costs.js` | Shows each sent message's cost under it on claude.ai (`+2% 5h · +0% 7d`). Each cost is keyed by the user message's id (`turn_message_uuids.human_message_uuid` from the request, else the newest `[data-testid="user-message"]` row's `data-turn-key`) and rendered under that message. Toggle: popup → **Show cost on messages**. |
| `popup/` | Ring gauges, reset countdowns, overlay and message-cost toggles. |

Permissions: `storage`, `alarms`, `notifications`, `cookies` (reads `lastActiveOrg` only) and host access to `claude.ai`.

These are claude.ai internal endpoints/events, not a public API — they can change without notice.
