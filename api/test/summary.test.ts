// P3 verification: AI structured summary export (JSON + Markdown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { ensureShop } from "../src/repository.js";
import { upsertIntervention } from "../src/analysis/repository.js";
import { buildAnalysisSummary, toMarkdown, DISCLAIMER } from "../src/analysis/summary.js";

test("buildAnalysisSummary: empty DB -> well-formed, empty summary (no crash)", async () => {
  const pool = makeTestPool();
  const s = await buildAnalysisSummary(pool);
  assert.deepEqual(s.shops, []);
  assert.equal(s.totals.interventions, 0);
  assert.equal(s.totals.effects, 0);
  assert.deepEqual(s.interventions, []);
  assert.deepEqual(s.effects, []);
  assert.deepEqual(s.strategyPanel, []);
  assert.deepEqual(s.changePoints, []);
  assert.equal(s.disclaimer, DISCLAIMER);

  const md = toMarkdown(s);
  assert.ok(md.includes("Etsy Mağaza Analiz Özeti"));
  assert.ok(md.includes(DISCLAIMER));
});

test("buildAnalysisSummary: includes a real intervention; Markdown carries the caveat/disclaimer framing", async () => {
  const pool = makeTestPool();
  const shopId = await ensureShop(pool, { shopTag: "summary-shop" });
  await upsertIntervention(pool, shopId, {
    interventionType: "price_changed",
    entityType: "listing",
    entityId: "101",
    occurredAt: "2026-06-15T10:00:00.000Z",
    beforeValue: 20,
    afterValue: 25,
    magnitude: 5,
    source: "snapshot_diff",
    confidence: 0.9,
  });

  const s = await buildAnalysisSummary(pool);
  assert.equal(s.shops.length, 1);
  assert.equal(s.shops[0].shopTag, "summary-shop");
  assert.equal(s.totals.interventions, 1);
  assert.equal(s.interventions.length, 1);
  assert.equal(s.interventions[0].intervention_type, "price_changed");

  const md = toMarkdown(s);
  assert.ok(md.includes("price_changed"));
  assert.ok(md.includes("summary-shop"));
  // The disclaimer names the anti-pattern ("X arttı DOLAYI Y") only to warn
  // against it, framed with "yerine" (instead) — never asserted as fact.
  assert.ok(md.includes("DOLAYI") && md.includes("yerine"));
});
