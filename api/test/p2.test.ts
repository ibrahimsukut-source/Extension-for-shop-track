// P2 verification: event_study_aggregator (pooled effects) and
// shop_level_analyzer (change-point detection independent of interventions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { getEventStudy } from "../src/analysis/event_study.js";
import { detectChangePoints } from "../src/analysis/shop_level_analyzer.js";
import type { Pool } from "../src/repository.js";

const SHOP = 1;

async function insertEffect(
  pool: Pool,
  interventionType: string,
  metric: string,
  pointEstimate: number,
  controlAdjusted: boolean,
  confidence: "low" | "medium"
): Promise<void> {
  const exp = await pool.query(
    `INSERT INTO experiments (intervention_id, shop_id, entity_id, metric, method, baseline_start, baseline_end, effect_window)
     VALUES (1,$1,'101',$2,'its','2026-01-01','2026-01-14','t+1..t+14') RETURNING id`,
    [SHOP, metric]
  );
  await pool.query(
    `INSERT INTO effects (experiment_id, shop_id, intervention_type, metric, effect_window, point_estimate, ci_low, ci_high, control_adjusted, confidence_label, caveats)
     VALUES ($1,$2,$3,$4,'t+1..t+14',$5,null,null,$6,$7,'[]'::jsonb)`,
    [exp.rows[0].id, SHOP, interventionType, metric, pointEstimate, controlAdjusted, confidence]
  );
}

test("event_study: pools effects by (intervention_type, metric) into mean/n/dispersion", async () => {
  const pool = makeTestPool();
  await insertEffect(pool, "price_changed", "revenue", 10, true, "medium");
  await insertEffect(pool, "price_changed", "revenue", 20, false, "low");
  await insertEffect(pool, "price_changed", "visits", 5, true, "medium");
  await insertEffect(pool, "photo_changed", "revenue", 3, false, "low");

  const result = await getEventStudy(pool, SHOP);
  const priceRevenue = result.find((r) => r.interventionType === "price_changed" && r.metric === "revenue");
  assert.ok(priceRevenue, "expected a price_changed/revenue group");
  assert.equal(priceRevenue!.n, 2);
  assert.equal(priceRevenue!.meanEffect, 15); // (10+20)/2
  assert.equal(priceRevenue!.nControlAdjusted, 1);
  assert.equal(priceRevenue!.nMedium, 1);
  assert.equal(priceRevenue!.nLow, 1);
  assert.ok(priceRevenue!.stdDev! > 0);

  const photoRevenue = result.find((r) => r.interventionType === "photo_changed" && r.metric === "revenue");
  assert.equal(photoRevenue!.n, 1);
  assert.equal(photoRevenue!.stdDev, null); // n=1 -> no dispersion
});

test("event_study: empty effects table -> empty result, no crash", async () => {
  const pool = makeTestPool();
  const result = await getEventStudy(pool, SHOP);
  assert.deepEqual(result, []);
});

async function seedFlatThenJump(pool: Pool, metric: string, before: number, after: number): Promise<void> {
  const base = new Date("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < 28; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    const value = i < 14 ? before : after;
    await pool.query(
      `INSERT INTO metric_timeseries (shop_id, scope, entity_id, metric, metric_date, value) VALUES ($1,'shop','',$2,$3,$4)`,
      [SHOP, metric, d.toISOString().slice(0, 10), value]
    );
  }
}

test("shop_level_analyzer: detects a genuine 14-day level shift, collapsed to one change point", async () => {
  const pool = makeTestPool();
  await seedFlatThenJump(pool, "revenue", 10, 30);

  const cps = await detectChangePoints(pool, SHOP, "revenue");
  assert.equal(cps.length, 1, "must collapse the whole transition neighborhood into one change point");
  assert.equal(cps[0].direction, "up");
  assert.ok(cps[0].relDelta! > 1.5, `expected a strong relative jump, got ${cps[0].relDelta}`);
});

test("shop_level_analyzer: a flat series has no change points", async () => {
  const pool = makeTestPool();
  await seedFlatThenJump(pool, "revenue", 10, 10); // no real jump
  const cps = await detectChangePoints(pool, SHOP, "revenue");
  assert.equal(cps.length, 0);
});

test("shop_level_analyzer: short series (not enough history) -> no crash, empty result", async () => {
  const pool = makeTestPool();
  await pool.query(`INSERT INTO metric_timeseries (shop_id, scope, entity_id, metric, metric_date, value) VALUES ($1,'shop','','revenue','2026-01-01',10)`, [SHOP]);
  const cps = await detectChangePoints(pool, SHOP, "revenue");
  assert.deepEqual(cps, []);
});
