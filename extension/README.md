# Etsy Shop Tracker — Extension (Phase 1)

MV3 Chrome extension that captures Etsy's **internal JSON API responses** by
monkey-patching `fetch` and `XMLHttpRequest` in the page's MAIN world, then
classifies and stores them. This is the core capture engine (spec §2).

## How it works

```
MAIN world            ISOLATED world          Service worker
interceptor.js  ──▶   bridge.js         ──▶   background.js
(patch fetch/XHR)     (postMessage relay)     (classify → shop id → dedup →
actions.js ──────────▶ (DOM action capture)    store locally + console; and,
                                               if configured, forward to API)
```

- **`interceptor.js`** (MAIN world, `document_start`): wraps `fetch`/`XHR`,
  clones JSON responses, and `postMessage`s them. Defensive — never breaks the
  host page; idempotent install guard.
- **`bridge.js`** (ISOLATED): the only path from page → extension; relays tagged
  messages to the service worker.
- **`actions.js`** (ISOLATED): secondary DOM click capture (§2.4). Best-effort;
  the authoritative signals are interception + central snapshot diffing (§2.5).
- **`background.js`** (SW): classifies each capture against
  `config/endpoints.config.json`, resolves `shop_id` (body → URL → shop tag),
  computes a deterministic `dedup_key`, stores the last 200 records in
  `chrome.storage.local`, logs to the console, and — when an API host/token are
  configured — enqueues and forwards them with batching + backoff retry.
- **`options.html/js`**: per-VPS settings (shop tag, VPS metadata, optional API
  host + token) and a live view of recent captures.

## Config-driven endpoints (§2.2)

Endpoint paths are **not** hard-coded. Edit
[`src/config/endpoints.config.json`](src/config/endpoints.config.json) —
`"*"` is a wildcard, matching is case-insensitive and substring-based, and the
first matching pattern wins. Observe real paths in DevTools → Network and update
them there; a config miss simply drops the response as noise.

## Build

```bash
cd extension
npm install
npm run build      # → dist/  (load this unpacked in Chrome)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm test           # unit tests for classify + shop-id logic
npm run test:e2e   # opt-in: loads the extension in real Chromium (see e2e/README.md)
```

The `test:e2e` run proves the interception pipeline works in a real browser:
`fetch` + `XHR` JSON responses are captured, classified, `shop_id`-resolved, and
unmatched URLs dropped. It has also been validated as a full loop
(extension → ingestion API → PostgreSQL → parse job).

## Load & verify (Phase 1 acceptance)

1. `npm run build`.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select `extension/dist`.
3. Open the extension's **Options**, set a **Shop tag** (e.g. `my-shop-01`).
   Leave the API section empty to stay local-only.
4. Log into `https://www.etsy.com`, open your shop dashboard/stats/messages.
5. Open the service worker console (Options page → `chrome://extensions` →
   *Inspect views: service worker*). You should see `[tracker] captured …` lines.
6. Back on the Options page, click **Refresh** to see recent captures.

## Enabling API forwarding (Phase 2 preview)

Set **Ingestion API host** + **Bearer token** in Options and tick *Enable
forwarding*. Saving requests host permission for the API origin. Records are then
POSTed to `<apiHost>/ingest/http` as `{ records: [...] }` with batching and
exponential-backoff retry via a `chrome.alarms` flush loop. Until the API exists
(Phase 2), keep this off.

## Notes

- Requires Chrome 111+ (`content_scripts` `world: "MAIN"`).
- Only JSON responses on `https://www.etsy.com/*` are considered.
- `chrome.storage.local` here is a bounded inspection buffer, not durable
  storage — the ingestion API is the source of truth once wired up.
