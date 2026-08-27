# CDP Sweeper (Phase 4 — not yet implemented)

Daily guaranteed snapshot (spec §3). Connects with `puppeteer-core` to an
already-logged-in Chrome started with `--remote-debugging-port=9222` (bound to
localhost only), and visits the key seller pages once per day so the extension
captures a guaranteed snapshot even if the operator never opened them:

```
/your/shops/me/dashboard
/your/shops/me/stats            (also sweep day/week/month period selectors)
/your/shops/me/tools/listings
/your/shops/me/conversations
/your/shops/me/advertising
```

Single collection path: the sweeper only **opens** pages; the extension does the
capturing (fewer bugs). Run via cron at end of day.
