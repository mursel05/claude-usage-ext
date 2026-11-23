// Runs in claude.ai's MAIN world. Wraps fetch to watch reply streams:
//  - legacy REST: POST .../chat_conversations/<id>/(retry_)completion (SSE, JSON events)
//  - current:     POST /claudeai-rpc/...ConversationService/StreamTimeline (Connect, protobuf)
// When a reply stream the user started finishes, it tells the extension which user message the
// reply belongs to, so the extension can read /usage and show what that message cost. It also
// scans the stream for the `message_limit` event (the Free plan's usage data, legacy JSON form).
// The page reads its own stream untouched.
(() => {
  if (window.__claudeUsageHook) return;
  window.__claudeUsageHook = true;

  const TAG = 'claude-usage-ext:message_limit';
  const LEGACY = /\/chat_conversations\/([0-9a-f-]{36})\/(retry_)?completion(\?|$)/i;
  const RPC_STREAM = /\/claudeai-rpc\/[^?]*ConversationService\/Stream[A-Za-z]*(\?|$)/;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const USER_MESSAGE = '[data-testid="user-message"]';
  // A reply stream counts as the user's only if they sent/retried/edited shortly before it.
  // Opening a chat also starts a timeline stream; that one must not be billed to a message.
  const ACTION_WINDOW_MS = 20000;
  const origFetch = window.fetch;

  // Diagnostics: filter the page console by "Usage Meter".
  const log = (...a) => console.info('[Usage Meter]', ...a);

  // ---------- what the user just did ----------

  let lastActionAt = 0;
  const ACTION_BUTTON = /send|submit|retry|regenerate|try again|save|edit/i;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest('[contenteditable="true"], textarea')) lastActionAt = Date.now();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target instanceof Element ? e.target.closest('button') : null;
      if (!b) return;
      const name = `${b.getAttribute('aria-label') ?? ''} ${b.type === 'submit' ? 'submit' : ''} ${b.textContent ?? ''}`;
      if (ACTION_BUTTON.test(name)) lastActionAt = Date.now();
    },
    true,
  );

  // ---------- which message / conversation ----------

  const urlOf = (input) => (typeof input === 'string' ? input : input instanceof Request ? input.url : String(input));
  const methodOf = (input, init) => (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

  /** Request body as text (protobuf bodies decode lossily, which is fine for finding ids). */
  async function bodyText(input, init) {
    try {
      const b = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : null);
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
      if (b instanceof Blob) return await b.text();
    } catch {
      // ignore
    }
    return '';
  }

  /** Legacy JSON body: turn_message_uuids.human_message_uuid. */
  function humanUuidFromJson(text) {
    try {
      const id = JSON.parse(text)?.turn_message_uuids?.human_message_uuid;
      return typeof id === 'string' && UUID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** The newest user message on the page (the one this reply answers). */
  function lastUserMessageId(conv) {
    if (conv && !location.pathname.includes(conv)) return null; // user switched chats meanwhile
    const all = document.querySelectorAll(USER_MESSAGE);
    const id = all[all.length - 1]?.closest('[data-turn-key]')?.getAttribute('data-turn-key');
    return id && UUID.test(id) ? id : null;
  }

  /** Prefer the request's id if that message is on the page; otherwise the newest user message. */
  function resolveKey(fromBody, conv) {
    if (fromBody && document.querySelector(`[data-turn-key="${fromBody}"] ${USER_MESSAGE}`)) return fromBody;
    return lastUserMessageId(conv) ?? fromBody;
  }

  const convFromPath = () => location.pathname.match(UUID)?.[0] ?? null;

  // ---------- fetch wrapper ----------

  window.fetch = async function (...args) {
    const [input, init] = args;
    let kind = null; // 'legacy' | 'rpc'
    let legacy = null;
    let started = 0;
    let textP = null;
    try {
      const url = urlOf(input);
      legacy = url.match(LEGACY);
      if (legacy) kind = 'legacy';
      else if (methodOf(input, init) === 'POST' && RPC_STREAM.test(url)) kind = 'rpc';
      if (kind) {
        started = Date.now();
        textP = bodyText(input, init);
        log('reply started', kind, url.split('/').pop());
      }
    } catch {
      kind = null;
    }

    const res = await origFetch.apply(this, args);
    try {
      if (kind && !(res.ok && res.body)) log('reply not readable', res.status);
      if (kind && res.ok && res.body) {
        const userStarted = kind === 'legacy' || started - lastActionAt < ACTION_WINDOW_MS;
        scan(res.clone().body).then(async (ml) => {
          const text = (await textP) || '';
          const conv = legacy?.[1] ?? text.match(UUID)?.[0] ?? convFromPath();
          const key = resolveKey(kind === 'legacy' ? humanUuidFromJson(text) : null, conv);
          const meta = { conv, retry: !!legacy?.[2], key };
          log('reply finished', { kind, ...meta, userStarted, messageLimitEvent: !!ml });
          // Free plan data is useful either way; a cost is only recorded for user-started replies.
          if (!userStarted && !ml) return;
          window.postMessage({ source: TAG, payload: ml, meta: userStarted ? meta : null }, location.origin);
        });
      }
    } catch {
      // Never break the page.
    }
    return res;
  };

  /** Resolves after the stream ends with its message_limit payload (null if there was none). */
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
        if (buf.length > 1 << 20) buf = buf.slice(-4096); // binary streams have few newlines
      }
    } catch {
      // Stream aborted (Stop button, navigation): report what we have.
    }
    return found;
  }
})();
