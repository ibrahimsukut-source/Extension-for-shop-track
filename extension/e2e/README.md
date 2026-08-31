# Extension E2E (opt-in)

`interception.mjs` loads the built extension into real Chromium and verifies the
full capture pipeline — `interceptor.js` (MAIN world) → `bridge.js` (ISOLATED) →
`background.js` (service worker) — actually captures a `fetch` and an `XHR`,
classifies them, resolves `shop_id`, and drops unmatched noise.

It is **not** part of `npm test` (that stays fast and browser-free). Run it
explicitly:

```bash
npm run build
npm run test:e2e            # headful; on a headless box: xvfb-run -a npm run test:e2e
```

- Needs a Chromium binary. It auto-discovers the Playwright-managed Chromium
  under `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`); override with
  `CHROME_PATH=/path/to/chrome`.
- The test copies `dist/` to a temp dir and widens the content-script matches to
  a local `127.0.0.1` origin so it can serve a synthetic page + JSON endpoints
  (the committed manifest still only matches `https://www.etsy.com/*`).
- Extensions load reliably only in headful Chromium, hence `xvfb-run` on servers.
