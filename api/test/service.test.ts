import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { ingestApi, ingestEvents, ingestHttp } from "../src/service.js";
import type { Pool, PoolClient, Queryable } from "../src/repository.js";
import type { ApiRecord, ClassifiedRecord, EventInput } from "../src/schemas.js";

function record(over: Partial<ClassifiedRecord> = {}): ClassifiedRecord {
  return {
    captureType: "stats",
    source: "extension",
    method: "GET",
    url: "https://www.etsy.com/api/v3/ajax/.../stats",
    status: 200,
    shopId: "45678",
    shopTag: "shop-a",
    vpsHost: "vps-1",
    chromeProfile: "Profile 1",
    body: { visits: 10 },
    capturedAt: "2026-08-27T10:00:00.000Z",
    dedupKey: "dedup_stats_0001",
    ...over,
  };
}

// ── pg-mem integration: validates real SQL (columns, casts, COALESCE upsert,
//    JSONB) and that dedup reduces the table to a single row. Note: pg-mem
//    misreports rowCount on ON CONFLICT DO NOTHING, so accounting (accepted/
//    duplicates) is asserted separately below with a real-Postgres-accurate
//    fake pool.

test("ingestHttp: stores a record and creates the shop with backfilled etsy_shop_id", async () => {
  const pool = makeTestPool();
  await ingestHttp(pool, "shop-a", [record()]);

  const shops = await pool.query("SELECT shop_tag, etsy_shop_id, vps_host FROM shops");
  assert.equal(shops.rows.length, 1);
  assert.equal(shops.rows[0].shop_tag, "shop-a");
  assert.equal(String(shops.rows[0].etsy_shop_id), "45678");
  assert.equal(shops.rows[0].vps_host, "vps-1");

  const caps = await pool.query("SELECT capture_type, source, parsed FROM raw_captures");
  assert.equal(caps.rows.length, 1);
  assert.equal(caps.rows[0].capture_type, "stats");
  assert.equal(caps.rows[0].source, "extension");
  assert.equal(caps.rows[0].parsed, false);
});

test("ingestHttp: same dedup_key persists only one row (idempotent)", async () => {
  const pool = makeTestPool();
  await ingestHttp(pool, "shop-a", [record()]);
  await ingestHttp(pool, "shop-a", [record()]);
  const caps = await pool.query("SELECT count(*)::int AS n FROM raw_captures");
  assert.equal(caps.rows[0].n, 1);
});

test("ingestHttp: distinct dedup_keys all persist", async () => {
  const pool = makeTestPool();
  await ingestHttp(pool, "shop-a", [
    record({ dedupKey: "dk_aaaaaaa1" }),
    record({ dedupKey: "dk_aaaaaaa2" }),
    record({ dedupKey: "dk_aaaaaaa3" }),
  ]);
  const caps = await pool.query("SELECT count(*)::int AS n FROM raw_captures");
  assert.equal(caps.rows[0].n, 3);
});

test("ingestHttp: non-numeric shopId leaves etsy_shop_id null", async () => {
  const pool = makeTestPool();
  await ingestHttp(pool, "shop-a", [record({ shopId: "shop-a", dedupKey: "dk_nonnum1" })]);
  const shops = await pool.query("SELECT etsy_shop_id FROM shops WHERE shop_tag='shop-a'");
  assert.equal(shops.rows[0].etsy_shop_id, null);
});

test("ingestEvents: same event persists only one row (derived dedup_key)", async () => {
  const pool = makeTestPool();
  const ev: EventInput = {
    eventType: "price_change",
    entityType: "listing",
    entityId: "111",
    actor: null,
    origin: "snapshot_diff",
    occurredAt: "2026-08-27T10:00:00.000Z",
    payload: { old: 10, new: 12 },
  };
  await ingestEvents(pool, "shop-a", [ev]);
  await ingestEvents(pool, "shop-a", [ev]);
  const rows = await pool.query("SELECT count(*)::int AS n, min(event_type) AS et FROM events");
  assert.equal(rows.rows[0].n, 1);
  assert.equal(rows.rows[0].et, "price_change");
});

test("ingestApi: stores raw with source=api", async () => {
  const pool = makeTestPool();
  const rec: ApiRecord = {
    captureType: "order",
    url: "https://openapi.etsy.com/v3/.../receipts",
    status: 200,
    entityId: "rcpt_1",
    body: { receipt_id: 1 },
    capturedAt: "2026-08-27T10:00:00.000Z",
  };
  await ingestApi(pool, "shop-a", [rec]);
  const rows = await pool.query("SELECT source, capture_type FROM raw_captures");
  assert.equal(rows.rows[0].source, "api");
  assert.equal(rows.rows[0].capture_type, "order");
});

// ── Accounting: a fake pool with real-Postgres ON CONFLICT semantics
//    (conflicting insert affects 0 rows) to verify accepted/duplicates counts.

function makeFakePool(): Pool {
  const seenDedup = new Set<string>();
  const query: Queryable["query"] = async (text: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO shops/i.test(text)) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/INSERT INTO raw_captures/i.test(text)) {
      const key = String(params[6]); // dedup_key is the 7th param
      const isNew = !seenDedup.has(key);
      if (isNew) seenDedup.add(key);
      return { rows: [], rowCount: isNew ? 1 : 0 };
    }
    if (/INSERT INTO events/i.test(text)) {
      const key = String(params[8]); // dedup_key is the 9th param
      const isNew = !seenDedup.has(key);
      if (isNew) seenDedup.add(key);
      return { rows: [], rowCount: isNew ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client: PoolClient = { query, release() {} };
  return { query, async connect() { return client; } };
}

test("accounting: ingestHttp counts new vs duplicate correctly", async () => {
  const pool = makeFakePool();
  const first = await ingestHttp(pool, "shop-a", [record({ dedupKey: "dk_count01" })]);
  assert.deepEqual(first, { accepted: 1, duplicates: 0, total: 1 });

  const second = await ingestHttp(pool, "shop-a", [
    record({ dedupKey: "dk_count01" }), // duplicate
    record({ dedupKey: "dk_count02" }), // new
    record({ dedupKey: "dk_count03" }), // new
  ]);
  assert.deepEqual(second, { accepted: 2, duplicates: 1, total: 3 });
});

test("accounting: ingestEvents counts duplicates via derived key", async () => {
  const pool = makeFakePool();
  const ev: EventInput = {
    eventType: "ad_on",
    entityType: "ad",
    entityId: "9",
    actor: null,
    origin: "interception",
    occurredAt: "2026-08-27T10:00:00.000Z",
    payload: { state: "on" },
  };
  const first = await ingestEvents(pool, "shop-a", [ev]);
  assert.deepEqual(first, { accepted: 1, duplicates: 0, total: 1 });
  const second = await ingestEvents(pool, "shop-a", [ev]);
  assert.deepEqual(second, { accepted: 0, duplicates: 1, total: 1 });
});
