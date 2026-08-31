# Ingestion API (Phase 2)

Central ingestion service (spec §4): validates, deduplicates, and normalizes
captured data into PostgreSQL. Node.js (TypeScript, ESM) + Fastify + Zod + `pg`.

## Endpoints

| Method & path      | Body                              | Purpose |
|--------------------|-----------------------------------|---------|
| `GET  /`           | —                                 | Live read-only dashboard (HTML) |
| `GET  /dashboard/data` | —                             | Dashboard JSON (gated by `DASHBOARD_KEY` when set) |
| `GET  /health`     | —                                 | Liveness (open, no auth) |
| `POST /ingest/http`| `{ records: ClassifiedRecord[] }` | Raw captured internal responses from the extension / sweeper |
| `POST /ingest/event`| `{ events: EventInput[] }`       | DOM / derived action events |
| `POST /ingest/api` | `{ records: ApiRecord[] }`        | Public API puller output (orders/listings/reviews) |

All `/ingest/*` routes require `Authorization: Bearer <token>` and return
`202` with `{ accepted, duplicates, total }`.

## Behavior (spec §4)

- **Auth:** one unique token per VPS/shop. `INGEST_TOKENS` maps `shop_tag → token`;
  the server resolves the token back to its shop. A leaked token affects only
  that one shop. Unknown token → `401`.
- **Dedup:** every row carries a deterministic `dedup_key`
  (`sha256(shop_id|type|key|time_bucket|content_hash)`, matching the extension).
  Inserts use `ON CONFLICT (dedup_key) DO NOTHING`, so the same payload captured
  by both extension and sweeper collapses to one row. The public API puller and
  event routes derive the key server-side when a client omits it.
- **`raw_captures` first:** `/ingest/http` and `/ingest/api` store the raw body
  (`parsed = false`) so parsing (Phase 3) can be re-run without re-capture.
- **Shop upsert:** shops are created on first sight by `shop_tag`;
  `etsy_shop_id` and VPS metadata are backfilled as they're learned.
- **Validation:** Zod schemas reject malformed payloads (`400`); batches over
  `MAX_BATCH` are rejected (`413`).

The `/ingest/http` contract matches the extension's `ClassifiedRecord`
(`extension/src/lib/types.ts`) — the extension's forward path already targets it.

## Run locally

```bash
cd api
npm install
cp .env.example .env            # fill DATABASE_URL + INGEST_TOKENS
docker compose up -d            # or point DATABASE_URL at any Postgres
npm run migrate                 # applies ../db/schema.sql
npm run dev                     # http://localhost:8080
```

## Scripts

```bash
npm run dev        # watch-mode server (tsx)
npm start          # run server
npm run migrate    # apply db/schema.sql
npm run parse      # Phase 3: parse unparsed raw_captures -> normalized tables
npm run typecheck  # tsc --noEmit
npm test           # unit + integration (pg-mem) + route tests
```

## Phase 3 — parsers, snapshots & derived events

`npm run parse` drains unparsed `raw_captures` into the normalized tables and is
idempotent + re-runnable (spec §3). Run it on a schedule (cron / BullMQ, §8).

- **Parsers** (`src/parsers/`): one per `capture_type` — `stats`, `listing`,
  `ads`, `order`, `review`, `messages`. They probe candidate field names and
  coerce loosely (Etsy's internal shapes aren't contractual), never throwing on
  unexpected input; unknown types are left `parsed = false` for a future parser.
- **Populated tables:** `stats_daily`, `listing_stats_daily`, `listing_snapshots`,
  `ads_daily` (`listing_id = 0` = shop total), `orders` + `order_items`,
  `reviews`, `message_threads` + `messages`. Buyer PII is stored only as a hash.
- **Snapshot diff** (`src/parse/diff.ts`, spec §2.5): the most reliable action
  detection — comparing a listing's consecutive snapshots emits `price_change`,
  `deactivated`/`activated`/`state_change`, `photo_changed`, `title_change`,
  `tag_change` events (`origin = snapshot_diff`), catching out-of-browser edits too.
- **Response time** (`response_metrics` view, §5.1): first `out` after the first
  `in`, per thread.

## Tests

- **Config / dedup:** token-map parsing and dedup-key determinism.
- **Service (pg-mem):** real SQL — shop upsert/backfill, JSONB storage, and that
  duplicate keys reduce the table to a single row.
- **Accounting (fake pool):** `accepted`/`duplicates` counts under real-Postgres
  `ON CONFLICT` semantics (pg-mem misreports `rowCount` on DO NOTHING, so
  accounting is verified separately).
- **Routes (fastify.inject):** auth `401`, validation `400`, batch cap `413`,
  and the `202` happy path.

The full path is additionally validated end-to-end against a real PostgreSQL 16
during development (migrate → boot → ingest → dedup).

## Wiring the extension

In the extension's Options, set **Ingestion API host** to this server's URL and
the **Bearer token** to this shop's token from `INGEST_TOKENS`, then enable
forwarding. Captures then POST to `<host>/ingest/http` with batching + retry.
