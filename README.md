# Etsy Multi-Shop Tracker

Centralized tracking & analytics for many Etsy shops (each on its own VPS /
Chrome profile). It records **every daily action** (listing add/remove/deactivate/
edit/photo change, ads on/off, price changes, message replies, reviews, orders)
and **every state metric** (stats, traffic sources, conversion, listing state),
then correlates *"which strategy did I apply → what was the result"* to find the
right shop-management method.

See the full design in [`docs/spec.md`](docs/spec.md).

## Why two collection methods

Etsy's **public API** does not expose stats, message threads, granular ads data,
or edit history — but the seller panel's **internal endpoints** do. Strategy:
use the public API as the stable backbone and fill the gaps by **intercepting**
the browser's internal API responses.

```
Each VPS (isolated Chrome profile)
  ├── [A] Extension (MV3)  — fetch/XHR interception + DOM action capture
  ├── [B] CDP Sweeper      — daily guaranteed snapshot of key pages
  └── [C] API Puller       — orders/listings/reviews from the public API
                       │  HTTPS POST (per-VPS Bearer token)
                       ▼
Central server: Ingestion API → PostgreSQL (events + snapshots) → Analytics
```

## Monorepo layout

| Path          | What                                                          | Phase |
|---------------|--------------------------------------------------------------|-------|
| `extension/`  | MV3 Chrome extension — the core capture engine               | **1 ✅** |
| `db/`         | PostgreSQL schema (event log + snapshot time series)         | **2 ✅** |
| `api/`        | Central ingestion API (dedup + validation + normalization)   | **2 ✅** |
| `sweeper/`    | CDP Sweeper (puppeteer-core) — daily guaranteed page sweep    | 4 |
| `analytics/`  | Correlation / control-group / health-score queries           | 5 |

## Build order (phases)

1. **Phase 1 — PoC:** Extension + fetch/XHR interception. Observe internal
   endpoints in DevTools, fill `endpoints.config.json`, dump captured JSON
   locally and confirm the right data arrives. ← **implemented**
2. **Phase 2 — Central DB + ingestion:** schema, `POST /ingest/http`, dedup +
   `raw_captures`; wire the extension to it. ← **implemented**
3. **Phase 3 — Parsers + snapshot/event:** per-`type` parsers; populate
   `listing_snapshots`, `stats_daily`, `messages`; derive events via snapshot diff.
4. **Phase 4 — CDP Sweeper + multi-VPS:** daily guaranteed sweep; per-VPS
   isolated profile + token; public API puller.
5. **Phase 5 — Analytics + dashboard:** before/after + control-group views,
   health scores, reports; then visualization.

## Current status

**Phases 1 & 2 are implemented and tested.**
- Phase 1 — the MV3 extension: see [`extension/README.md`](extension/README.md).
- Phase 2 — DB schema (`db/schema.sql`) + the ingestion API
  ([`api/README.md`](api/README.md)), validated end-to-end against real Postgres.

`sweeper/` and `analytics/` are stubbed with notes for the phases that build them.

## Security & isolation (summary)

- **Each VPS = separate Chrome profile = separate Etsy account.** No cookie/profile sharing.
- **Separate ingestion token per VPS**; tokens live in `.env`, never in the repo.
- Central API is HTTPS-only and rejects requests without a token.
- **PII minimization:** store `buyer_hash`, never raw buyer name/address.
- Chrome remote-debugging port (`9222`) bound to localhost only.

## Known risks

Automated access + multiple accounts is a gray area under Etsy's ToS and carries
account-suspension risk. This repo is the technical implementation; the risk/
business decision is the operator's. Internal endpoints can change — parsing runs
off `raw_captures` so it can be re-run, and endpoint matching stays config-driven.
