// P1 verification (spec §10): control_selector + effect_estimator (ITS/DiD) +
// clean_window_flagger, exercised end to end through computeEffects — the
// "produce one Effect Card on a real intervention, verify by eye" checkpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { insertListingSnapshot, upsertListingStatsDaily } from "../src/parsed_repository.js";
import { upsertIntervention } from "../src/analysis/repository.js";
import { buildMetricTimeseries } from "../src/analysis/repository.js";
import { computeEffects } from "../src/analysis/compute.js";
import { flagCleanWindows } from "../src/analysis/clean_window.js";
import { selectControls } from "../src/analysis/control_selector.js";
import type { Pool } from "../src/repository.js";

const SHOP = 1;
const TREATED = 101;
const CONTROL = 102;
const SECTION = 555;

// day0 = the intervention day. Baseline: day0-14..day0-1. Post: day0+1..day0+14.
const DAY0 = "2026-06-15";

function isoDaysBefore(days: number): string {
  const d = new Date(DAY0 + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function isoDaysAfter(days: number): string {
  const d = new Date(DAY0 + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Seed 14 baseline + 14 post days of listing_stats_daily for one listing. */
async function seedListingHistory(
  pool: Pool,
  listingId: number,
  baselineRevenue: number,
  postRevenue: number
): Promise<void> {
  for (let i = 14; i >= 1; i--) {
    await upsertListingStatsDaily(pool, SHOP, {
      listingId,
      statDate: isoDaysBefore(i),
      views: null,
      visits: 5,
      favorites: null,
      orders: 1,
      revenue: baselineRevenue,
    });
  }
  for (let i = 1; i <= 14; i++) {
    await upsertListingStatsDaily(pool, SHOP, {
      listingId,
      statDate: isoDaysAfter(i),
      views: null,
      visits: 8,
      favorites: null,
      orders: 2,
      revenue: postRevenue,
    });
  }
}

async function seedListingSnapshot(pool: Pool, listingId: number, price: number): Promise<void> {
  await insertListingSnapshot(pool, SHOP, isoDaysBefore(20) + "T09:00:00.000Z", {
    listingId,
    title: "Test listing",
    state: "active",
    price,
    currency: "TRY",
    quantity: 5,
    tags: null,
    numImages: 2,
    imageHashes: null,
    sectionId: SECTION,
    views: null,
    favorites: null,
    raw: null,
  });
}

/** Build the full scenario: treated listing gets a real uplift, control drifts a little (general trend). */
async function seedScenario(pool: Pool): Promise<void> {
  await seedListingSnapshot(pool, TREATED, 20);
  await seedListingSnapshot(pool, CONTROL, 21); // similar price -> good control match

  await seedListingHistory(pool, TREATED, 10, 20); // +10 raw uplift
  await seedListingHistory(pool, CONTROL, 10, 12); // +2 general-trend drift

  await upsertIntervention(pool, SHOP, {
    interventionType: "price_changed",
    entityType: "listing",
    entityId: String(TREATED),
    occurredAt: DAY0 + "T10:00:00.000Z",
    beforeValue: 20,
    afterValue: 25,
    magnitude: 5,
    source: "snapshot_diff",
    confidence: 0.9,
  });

  await buildMetricTimeseries(pool);
}

test("control_selector: finds the same-section, similar-price, untouched sibling", async () => {
  const pool = makeTestPool();
  await seedScenario(pool);

  const controls = await selectControls(pool, SHOP, TREATED, DAY0 + "T10:00:00.000Z");
  assert.equal(controls.length, 1);
  assert.equal(controls[0].controlEntity, String(CONTROL));

  const stored = await pool.query("SELECT count(*)::int AS n FROM control_assignments WHERE treated_entity=$1", [String(TREATED)]);
  assert.equal(stored.rows[0].n, 1);
});

test("clean_window_flagger: a lone intervention is clean; an overlapping one is not", async () => {
  const pool = makeTestPool();
  await seedScenario(pool);
  await flagCleanWindows(pool, SHOP);

  let row = await pool.query("SELECT is_clean_window FROM interventions WHERE entity_id=$1", [String(TREATED)]);
  assert.equal(row.rows[0].is_clean_window, true);

  // Add a shop-wide intervention in the same window -> both should flip to dirty.
  await upsertIntervention(pool, SHOP, {
    interventionType: "ad_budget_changed",
    entityType: "shop",
    entityId: null,
    occurredAt: DAY0 + "T11:00:00.000Z",
    beforeValue: null,
    afterValue: 75,
    magnitude: null,
    source: "interception",
    confidence: 0.95,
  });
  await flagCleanWindows(pool, SHOP);
  row = await pool.query("SELECT is_clean_window FROM interventions WHERE entity_id=$1", [String(TREATED)]);
  assert.equal(row.rows[0].is_clean_window, false);
});

test("computeEffects: DiD nets out the control's own drift (Effect Card, real numbers)", async () => {
  const pool = makeTestPool();
  await seedScenario(pool);

  const written = await computeEffects(pool, SHOP);
  assert.ok(written > 0, "expected at least one effect to be written");

  const rows = await pool.query(
    `SELECT e.metric, x.method, e.point_estimate, e.control_adjusted, e.confidence_label, e.caveats
       FROM effects e
       JOIN experiments x ON x.id = e.experiment_id
      WHERE x.entity_id = $1 AND e.metric = 'revenue'`,
    [String(TREATED)]
  );
  assert.equal(rows.rows.length, 1);
  const r = rows.rows[0];

  // Treated: +10 raw (20-10). Control: +2 (12-10). DiD = 10 - 2 = 8, exactly
  // (constant daily values -> exact means, no floating noise to tolerate).
  assert.equal(r.method, "did");
  assert.equal(r.control_adjusted, true);
  assert.equal(Number(r.point_estimate), 8);
  assert.equal(r.confidence_label, "medium");
  assert.ok(Array.isArray(r.caveats) && r.caveats.length > 0);
  assert.ok(r.caveats.some((c: string) => c.includes("gözlemsel")), "must include the non-causal disclaimer");

  // Idempotent: re-running must not duplicate any effect (already-estimated
  // interventions are skipped via the NOT EXISTS guard in computeEffects).
  const again = await computeEffects(pool, SHOP);
  assert.equal(again, 0);
});

test("estimateEffect: no data at all -> null point estimate, low confidence, no crash", async () => {
  const pool = makeTestPool();
  const { estimateEffect } = await import("../src/analysis/effect_estimator.js");
  const result = await estimateEffect(pool, {
    shopId: SHOP,
    scope: "listing",
    entityId: "999999",
    metric: "revenue",
    occurredAt: DAY0 + "T10:00:00.000Z",
    interventionType: "price_changed",
    isCleanWindow: null,
  });
  assert.equal(result.pointEstimate, null);
  assert.equal(result.confidenceLabel, "low");
  assert.ok(result.caveats.length > 0);
});
