# Ingestion API (Phase 2 — not yet implemented)

Central ingestion service. Planned per spec §4:

- **Endpoints:** `POST /ingest/http` (raw captured responses — server parses),
  `POST /ingest/event` (DOM/action events), `POST /ingest/api` (public API puller
  output).
- **Auth:** separate Bearer token per VPS; reject requests without a valid token.
- **Dedup:** deterministic `dedup_key = sha256(shop_id|type|entity_id|captured_at_bucket|content_hash)`.
  The extension already computes a compatible key (see `extension/src/lib/dedup.ts`).
- **Idempotent upsert** into `raw_captures`; keep unparseable bodies for re-parsing.
- **Validation:** Zod schemas; batch acceptance + backpressure.

**Suggested stack:** Node.js (TypeScript) + Fastify + Zod + PostgreSQL (JSONB),
parameterized SQL. Schema is in [`../db/schema.sql`](../db/schema.sql).

The extension's outbound contract to match: `POST /ingest/http` with body
`{ "records": ClassifiedRecord[] }` and header `Authorization: Bearer <token>`.
See `ClassifiedRecord` in `extension/src/lib/types.ts`.
