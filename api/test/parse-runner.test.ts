import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool, seedCapture } from "./helpers.js";
import { parseAll } from "../src/parse/runner.js";

const SHOP = 1;

test("runner: listing snapshots + snapshot-diff derives a price_change event", async () => {
  const pool = makeTestPool();
  // Two captures of the same listing at different times, price changes 20 -> 25.
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "listing",
    body: { listings: [{ listing_id: 7, title: "Mug", state: "active", price: { amount: 2000, divisor: 100 }, images: [{ url: "u1" }, { url: "u2" }] }] },
    capturedAt: "2026-08-25T10:00:00.000Z",
  });
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "listing",
    body: { listings: [{ listing_id: 7, title: "Mug", state: "active", price: { amount: 2500, divisor: 100 }, images: [{ url: "u1" }, { url: "u2" }] }] },
    capturedAt: "2026-08-26T10:00:00.000Z",
  });

  const summary = await parseAll(pool);
  assert.equal(summary.captures, 2);

  const snaps = await pool.query("SELECT count(*)::int AS n FROM listing_snapshots WHERE listing_id=7");
  assert.equal(snaps.rows[0].n, 2);

  const events = await pool.query("SELECT event_type, origin FROM events WHERE entity_id='7'");
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].event_type, "price_change");
  assert.equal(events.rows[0].origin, "snapshot_diff");

  // Everything consumed.
  const pending = await pool.query("SELECT count(*)::int AS n FROM raw_captures WHERE parsed=false");
  assert.equal(pending.rows[0].n, 0);
});

test("runner: first snapshot alone derives no event", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "listing",
    body: { listings: [{ listing_id: 8, title: "Hat", state: "active", price: { amount: 1000, divisor: 100 } }] },
    capturedAt: "2026-08-25T10:00:00.000Z",
  });
  await parseAll(pool);
  const events = await pool.query("SELECT count(*)::int AS n FROM events");
  assert.equal(events.rows[0].n, 0);
});

test("runner: stats capture populates stats_daily", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "stats",
    body: { results: [{ date: "2026-08-26", visits: 100, views: 200, orders: 4 }] },
    capturedAt: "2026-08-26T23:00:00.000Z",
  });
  await parseAll(pool);
  const rows = await pool.query("SELECT visits, views, orders FROM stats_daily WHERE stat_date='2026-08-26'");
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].visits, 100);
});

test("runner: ads capture populates ads_daily with sentinel listing 0", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "ads",
    body: { ads: [{ date: "2026-08-26", spend: { amount: 500, divisor: 100 }, impressions: 900, clicks: 20 }] },
    capturedAt: "2026-08-26T23:00:00.000Z",
  });
  await parseAll(pool);
  const rows = await pool.query("SELECT listing_id, clicks FROM ads_daily");
  assert.equal(rows.rows.length, 1);
  assert.equal(Number(rows.rows[0].listing_id), 0);
  assert.equal(rows.rows[0].clicks, 20);
});

test("runner: order capture populates orders + order_items", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "order",
    body: { receipts: [{ receipt_id: 555, created_timestamp: 1756288800, grandtotal: { amount: 3000, divisor: 100 }, status: "paid", transactions: [{ listing_id: 7, quantity: 2, price: { amount: 1500, divisor: 100 } }] }] },
    capturedAt: "2026-08-27T10:00:00.000Z",
  });
  await parseAll(pool);
  const o = await pool.query("SELECT total, status FROM orders WHERE receipt_id=555");
  assert.equal(o.rows.length, 1);
  assert.equal(Number(o.rows[0].total), 30);
  const items = await pool.query("SELECT count(*)::int AS n FROM order_items WHERE receipt_id=555");
  assert.equal(items.rows[0].n, 1);
});

test("runner: review capture populates reviews", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "review",
    body: { reviews: [{ review_id: "rv1", listing_id: 7, rating: 5, review: "great", create_timestamp: 1756288800 }] },
    capturedAt: "2026-08-27T10:00:00.000Z",
  });
  await parseAll(pool);
  const r = await pool.query("SELECT rating FROM reviews WHERE review_id='rv1'");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].rating, 5);
});

test("runner: re-running is idempotent (no duplicate snapshots/events)", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "listing",
    body: { listings: [{ listing_id: 9, state: "active", price: { amount: 1000, divisor: 100 } }] },
    capturedAt: "2026-08-25T10:00:00.000Z",
  });
  await parseAll(pool);
  // Re-seed the same logical data at the same instant and re-parse.
  await seedCapture(pool, {
    shopId: SHOP,
    captureType: "listing",
    body: { listings: [{ listing_id: 9, state: "active", price: { amount: 1000, divisor: 100 } }] },
    capturedAt: "2026-08-25T10:00:00.000Z",
  });
  await parseAll(pool);
  const snaps = await pool.query("SELECT count(*)::int AS n FROM listing_snapshots WHERE listing_id=9");
  assert.equal(snaps.rows[0].n, 1); // same (shop, listing, captured_at) -> one row
  const events = await pool.query("SELECT count(*)::int AS n FROM events");
  assert.equal(events.rows[0].n, 0);
});
