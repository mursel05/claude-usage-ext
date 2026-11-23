// Runs in claude.ai's MAIN world. Wraps fetch to watch completion requests:
//  - notes which user message the reply belongs to (its id), to show the cost under it, and
//  - scans a clone of the response stream for the `message_limit` SSE event (the Free plan's
//    only usage source). The page reads its own stream untouched.
// The event is forwarded once the stream has finished, so the reply is fully accounted.
(() => {
  if (window.__claudeUsageHook) return;
  window.__claudeUsageHook = true;

  const TAG = 'claude-usage-ext:message_limit';
  const COMPLETION = /\/chat_conversations\/([^/?]+)\/(retry_)?completion(\?|$)/;
  const origFetch = window.fetch;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** The human message's id, if the request body carries it (turn_message_uuids). */
  async function readHumanUuid(input, init) {
    try {
      let body = init?.body;
      if (body == null && input instanceof Request) body = await input.clone().text();
      if (typeof body !== 'string') return null;
      const id = JSON.parse(body)?.turn_message_uuids?.human_message_uuid;
      return typeof id === 'string' && UUID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** Fallback: the newest user message on the page (the one this reply answers). */
  function lastUserMessageId(conv) {
    if (!location.pathname.includes(conv)) return null; // user switched chats meanwhile
    const all = document.querySelectorAll('[data-testid="user-message"]');
    const el = all[all.length - 1];
    const id = el?.closest('[data-turn-key]')?.getAttribute('data-turn-key');
    return id && UUID.test(id) ? id : null;
  }

  window.fetch = async function (...args) {
    const [input, init] = args;
    let match = null;
    let humanP = null;
    try {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      match = url.match(COMPLETION);
      if (match) humanP = readHumanUuid(input, init);
    } catch {
      match = null;
    }

    const res = await origFetch.apply(this, args);
    try {
      if (match && res.ok && res.body) {
        const conv = match[1];
        const retry = !!match[2];
        scan(res.clone().body).then(async (ml) => {
          if (!ml) return;
          const key = (humanP && (await humanP)) || lastUserMessageId(conv);
          const meta = { conv, retry, key };
          window.postMessage({ source: TAG, payload: ml, meta }, location.origin);
        });
      }
    } catch {
      // Never break the page.
    }
    return res;
  };

  /** Resolves with the message_limit payload after the stream ends (null if none). */
  async function scan(body) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let found = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:') || !line.includes('"message_limit"')) continue;
          try {
            const evt = JSON.parse(line.slice(5));
            if (evt?.type === 'message_limit' && evt.message_limit) found = evt.message_limit;
          } catch {
            // Partial or non-JSON line: ignore.
          }
        }
      }
    } catch {
      // Stream aborted (Stop button, navigation): report what we have.
    }
    return found;
  }
})();
