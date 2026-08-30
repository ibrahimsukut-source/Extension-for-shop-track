import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool, seedCapture } from "./helpers.js";
import { parseAll } from "../src/parse/runner.js";
import { detectListingInterventions } from "../src/analysis/interventions.js";
import { buildMetricTimeseries } from "../src/analysis/repository.js";
import type { ListingSnapshotRow } from "../src/parsers/types.js";
import type { PriorSnapshot } from "../src/parse/diff.js";

const SHOP = 1;

const prior = (o: Partial<PriorSnapshot> = {}): PriorSnapshot => ({
  state: "active", price: 20, title: "Mug", tags: ["a", "b"], numImages: 2, imageHashes: ["h1", "h2"], quantity: 5, ...o,
});
const next = (o: Partial<ListingSnapshotRow> = {}): ListingSnapshotRow => ({
  listingId: 7, title: "Mug", state: "active", price: 20, currency: "TRY", quantity: 5,
  tags: ["a", "b"], numImages: 2, imageHashes: ["h1", "h2"], sectionId: null, views: null, favorites: null, raw: null, ...o,
});

test("detector: price change → price_changed with signed magnitude", () => {
  const ivs = detectListingInterventions(prior(), next({ price: 25 }), "2026-08-26T10:00:00.000Z");
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].interventionType, "price_changed");
  assert.equal(ivs[0].magnitude, 5);
  assert.equal(ivs[0].source, "snapshot_diff");
});

test("detector: active→inactive is listing_deactivated; reverse is reactivated", () => {
  assert.equal(detectListingInterventions(prior(), next({ state: "inactive" }), "t")[0].interventionType, "listing_deactivated");
  assert.equal(detectListingInterventions(prior({ state: "inactive" }), next({ state: "active" }), "t")[0].interventionType, "listing_reactivated");
});

test("detector: quantity change → quantity_changed with delta", () => {
  const ivs = detectListingInterventions(prior(), next({ quantity: 2 }), "t");
  assert.equal(ivs[0].interventionType, "quantity_changed");
  assert.equal(ivs[0].magnitude, -3);
});

test("detector: identical snapshots produce nothing", () => {
  assert.equal(detectListingInterventions(prior(), next(), "t").length, 0);
});

test("runner: snapshot diff promotes a first-class intervention", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP, captureType: "listing",
    body: { listings: [{ listing_id: 7, state: "active", price: { amount: 2000, divisor: 100 } }] },
    capturedAt: "2026-08-25T10:00:00.000Z",
  });
  await seedCapture(pool, {
    shopId: SHOP, captureType: "listing",
    body: { listings: [{ listing_id: 7, state: "active", price: { amount: 2500, divisor: 100 } }] },
    capturedAt: "2026-08-26T10:00:00.000Z",
  });
  const summary = await parseAll(pool);
  assert.equal(summary.interventions, 1);

  const iv = await pool.query("SELECT intervention_type, magnitude, source FROM interventions WHERE entity_id='7'");
  assert.equal(iv.rows.length, 1);
  assert.equal(iv.rows[0].intervention_type, "price_changed");
  assert.equal(Number(iv.rows[0].magnitude), 5);
  assert.equal(iv.rows[0].source, "snapshot_diff");
});

test("runner: re-parsing the same diff does not duplicate interventions", async () => {
  const pool = makeTestPool();
  for (const [t, amt] of [["2026-08-25T10:00:00.000Z", 2000], ["2026-08-26T10:00:00.000Z", 2500]] as const) {
    await seedCapture(pool, {
      shopId: SHOP, captureType: "listing",
      body: { listings: [{ listing_id: 7, state: "active", price: { amount: amt, divisor: 100 } }] },
      capturedAt: t,
    });
  }
  await parseAll(pool);
  // Re-seed identical second observation; diff repeats but dedup_key collapses it.
  await seedCapture(pool, {
    shopId: SHOP, captureType: "listing",
    body: { listings: [{ listing_id: 7, state: "active", price: { amount: 2500, divisor: 100 } }] },
    capturedAt: "2026-08-26T10:00:00.000Z",
  });
  await parseAll(pool);
  const n = await pool.query("SELECT count(*)::int AS n FROM interventions WHERE entity_id='7'");
  assert.equal(n.rows[0].n, 1);
});

test("metric_builder: shop stats flow into long-format metric_timeseries", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP, captureType: "stats",
    body: { results: [{ date: "2026-08-26", visits: 100, views: 200, orders: 4 }] },
    capturedAt: "2026-08-26T23:00:00.000Z",
  });
  const summary = await parseAll(pool);
  assert.ok(summary.metricPoints >= 3, `expected ≥3 metric points, got ${summary.metricPoints}`);

  const views = await pool.query(
    "SELECT value FROM metric_timeseries WHERE scope='shop' AND metric='views' AND metric_date='2026-08-26'"
  );
  assert.equal(views.rows.length, 1);
  assert.equal(Number(views.rows[0].value), 200);
});

test("metric_builder: idempotent refresh (rebuild overwrites, no duplicate rows)", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP, captureType: "stats",
    body: { results: [{ date: "2026-08-26", visits: 100, views: 200, orders: 4 }] },
    capturedAt: "2026-08-26T23:00:00.000Z",
  });
  await parseAll(pool);
  const before = await pool.query("SELECT count(*)::int AS n FROM metric_timeseries");
  await buildMetricTimeseries(pool);
  const after = await pool.query("SELECT count(*)::int AS n FROM metric_timeseries");
  assert.equal(before.rows[0].n, after.rows[0].n);
});
