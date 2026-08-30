import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool, seedCapture } from "./helpers.js";
import { parseAll } from "../src/parse/runner.js";
import { detectListingInterventions } from "../src/analysis/interventions.js";
import { buildMetricTimeseries } from "../src/analysis/repository.js";
import { parseAds } from "../src/parsers/ads.js";
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

test("ads parser: real prolist/stats (on-site Etsy Ads) graphStats -> ads_daily rows", () => {
  // Real OrnamentsPoint capture: GET /prolist/stats response (trimmed to 2 days).
  const out = parseAds(
    {
      graphStats: [
        { impressionCount: 990, clickCount: 7, spentTotal: 1112, conversions: 2, revenue: 2727, clickRate: 0.7, roas: 2.45, timestamp: 1787976000 },
        { impressionCount: 0, clickCount: 0, spentTotal: 0, conversions: 0, revenue: 0, clickRate: 0, roas: 0, timestamp: 1785556800 },
      ],
      comparisonGraphStats: [{ impressionCount: 999, clickCount: 99, spentTotal: 999, conversions: 9, revenue: 999, timestamp: 1782878400 }],
    },
    { shopId: 1, capturedAt: "t" }
  );
  assert.equal(out.adsDaily?.length, 2);
  const day = out.adsDaily!.find((r) => r.spend! > 0)!;
  assert.equal(day.channel, "onsite");
  assert.equal(day.listingId, 0);
  assert.equal(day.spend, 11.12); // 1112 minor units -> 11.12
  assert.equal(day.revenueFromAds, 27.27);
  assert.equal(day.impressions, 990);
  assert.equal(day.clicks, 7);
  assert.equal(day.ordersFromAds, 2);
});

test("runner: on-site Etsy Ads and offsite Ads write separate rows for the same day (no clobber)", async () => {
  const pool = makeTestPool();
  // Same calendar day (2026-08-29), two different ad programs -> must land as
  // two distinct rows, not one overwriting the other.
  await seedCapture(pool, {
    shopId: SHOP, captureType: "ads",
    body: { stats: [{ timestamp: "2026-08-29T10:00:00Z", clickCount: 20 }] }, // offsite: clicks only
    capturedAt: "2026-08-29T23:00:00.000Z",
  });
  await seedCapture(pool, {
    shopId: SHOP, captureType: "ads",
    body: { graphStats: [{ impressionCount: 990, clickCount: 7, spentTotal: 1112, conversions: 2, revenue: 2727, timestamp: 1787976000 /* 2026-08-29 */ }] }, // onsite: spend/ROAS
    capturedAt: "2026-08-29T23:05:00.000Z",
  });
  await parseAll(pool);
  const rows = await pool.query("SELECT channel, clicks, spend FROM ads_daily WHERE stat_date='2026-08-29' ORDER BY channel");
  assert.equal(rows.rows.length, 2);
  const offsite = rows.rows.find((r: any) => r.channel === "offsite");
  const onsite = rows.rows.find((r: any) => r.channel === "onsite");
  assert.equal(offsite.clicks, 20);
  assert.equal(offsite.spend, null);
  assert.equal(onsite.clicks, 7);
  assert.equal(Number(onsite.spend), 11.12);
});

test("ads parser: real prolist/listings toggle response -> adToggles", () => {
  // Real OrnamentsPoint capture: POST /prolist/listings response.
  const out = parseAds({ listings: { "4438707768": false }, countOfAdvertisedListings: 91 }, { shopId: 1, capturedAt: "t" });
  assert.deepEqual(out.adToggles, [{ listingId: 4438707768, isAdvertised: false }]);
  assert.equal(out.adsDaily, undefined);
});

test("runner: ad toggle capture promotes an etsy_ads_off intervention", async () => {
  const pool = makeTestPool();
  await seedCapture(pool, {
    shopId: SHOP, captureType: "ads",
    body: { listings: { "4438707768": false }, countOfAdvertisedListings: 91 },
    capturedAt: "2026-08-29T12:00:00.000Z",
  });
  const summary = await parseAll(pool);
  assert.equal(summary.interventions, 1);

  const iv = await pool.query("SELECT intervention_type, entity_id, after_value, source, confidence FROM interventions WHERE entity_id='4438707768'");
  assert.equal(iv.rows.length, 1);
  assert.equal(iv.rows[0].intervention_type, "etsy_ads_off");
  assert.equal(iv.rows[0].after_value, false);
  assert.equal(iv.rows[0].source, "interception");
  assert.equal(Number(iv.rows[0].confidence), 0.95);
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
