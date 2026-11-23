# Claude Usage Meter

A Brave / Chrome extension that shows your **claude.ai usage limits** (the 5-hour session window and the weekly window) while you chat. It works on **Free, Pro and Max**.

> Unofficial. Not affiliated with or endorsed by Anthropic. It reads claude.ai's own internal usage data, which can change without notice.

## Features

- **Meter above the message box.** Shows the 5-hour and weekly usage as bars with percentages. It sits just above the composer, aligned to its right edge, and moves with it when the box grows, the window is resized or the sidebar is toggled. It never blocks clicks.
- **Cost of every message.** Under each message you send, a small label shows how much of your limits that message used, e.g. `+2% 5h · +0% 7d`. A retry is added to the message it re-answers.
- **Toolbar badge.** The extension icon shows your 5-hour usage %, colored green (under 70%), amber (70–89%) or red (90% and up).
- **Popup.** Two ring gauges with time to reset and the exact reset time, plus when the data was last updated.
- **Notifications.** An alert at 80% and at 100% of each window, and another when a maxed-out window resets.
- **Free and paid plans.**
  - **Pro / Max:** reads the same data as *Settings → Usage*. It refreshes every 5 minutes, when you open the popup and right after each message, so usage from other devices or Claude Code shows up too.
  - **Free:** claude.ai sends no usage data to Free accounts except inside each reply, so the meter fills in after your first message and updates after each one.
- **Settings** (in the popup):
  - *Show on claude.ai*: turns the meter above the message box on or off.
  - *Show cost on messages*: turns the per-message labels on or off.
- **Private.** No account, no API key and no servers of its own. It only talks to claude.ai, with your existing browser session, and stores everything locally.

## Install

1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Reload any open claude.ai tab, and make sure you are signed in to claude.ai in the same browser.

To update, pull the latest code, click ↻ on the extension card, then reload claude.ai.

## Limitations

- claude.ai reports whole percents, so a short message often shows `+0%`. Its cost is still counted, and shows up once the total ticks over.
- Message costs are recorded from the moment you install the extension. Older messages show no label.
- On the Free plan there is nothing to poll, so the numbers update only when you send a message.
- These are claude.ai's internal endpoints and events, not a public API. If Anthropic changes them, the extension may stop working until it is updated.

## How it works

| Source | Used for | Data |
|---|---|---|
| `GET /api/organizations/{id}/usage` | Pro / Max | `five_hour` / `seven_day` → `{utilization (percent), resets_at}`, falling back to `limits[]` |
| `message_limit` event in the reply stream | Free | `windows["5h"]` / `windows["7d"]` → `{utilization (0–1), resets_at (unix seconds)}` |

The plan is detected from the endpoint: if it returns no data, the account is treated as Free, and this is re-checked hourly. If the endpoint is unreachable, the reply-stream numbers are used instead.

| File | Role |
|---|---|
| `src/api.js` | `/usage` client. Fetches from the service worker with your session cookie, and falls back to a same-origin fetch from an open claude.ai tab. The org is taken from the `lastActiveOrg` cookie, otherwise the first org with chat access. |
| `src/stream-hook.js` | Runs in the page. Wraps `fetch` and reads a **copy** of each reply stream (the page's own stream is untouched) for `message_limit`. When a reply finishes it reports which user message it answered: the request's `human_message_uuid` if that message is on the page, otherwise the newest message's `data-turn-key`. |
| `src/relay.js` | Passes stream events to the service worker, and runs the same-origin fallback fetch for `api.js`. |
| `src/usage.js` | Parsing, treating a window whose reset time has passed as 0%, and the per-message difference (`withDelta`). |
| `src/background.js` | Chooses the data source, updates the badge, re-checks resets every minute, sends notifications and stores per-message costs (`msgCosts`). |
| `src/overlay.js` | The meter above the message box (Shadow DOM, click-through). |
| `src/message-costs.js` | Writes the cost label under each sent message, matched by `data-turn-key`. |
| `popup/` | Gauges, reset times and the two toggles. |

**Permissions:** `storage`, `alarms`, `notifications`, `cookies` (only to read `lastActiveOrg`) and access to `claude.ai`.

## License

[MIT](LICENSE) © 2026 Mursal Haxverdiyev
