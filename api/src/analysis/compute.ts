// Orchestrator: for every intervention that doesn't have an effect yet, flag
// clean windows, estimate effects on the metrics relevant to its scope, and
// persist experiments + effects rows. Idempotent (an intervention with an
// existing experiment row is skipped), so it's cheap to call on every parse
// pass — the debounced scheduler already provides the cadence.
import type { Queryable } from "../repository.js";
import { flagCleanWindows } from "./clean_window.js";
import { estimateEffect, EFFECT_WINDOW } from "./effect_estimator.js";

const LISTING_METRICS = ["visits", "orders", "revenue"];
const SHOP_METRICS = ["visits", "orders", "revenue"];

const j = (v: unknown) => JSON.stringify(v ?? null);

/** Compute effect cards for one shop's not-yet-estimated interventions. Returns count written. */
export async function computeEffects(q: Queryable, shopId: number): Promise<number> {
  await flagCleanWindows(q, shopId);

  // Anti-join (not a correlated NOT EXISTS) — pg-mem's correlated-subquery
  // support is limited; LEFT JOIN + IS NULL is the portable equivalent.
  const pending = await q.query(
    `SELECT i.id, i.intervention_type, i.entity_type, i.entity_id, i.occurred_at, i.is_clean_window
       FROM interventions i
       LEFT JOIN experiments x ON x.intervention_id = i.id
      WHERE i.shop_id=$1 AND x.id IS NULL
      ORDER BY i.occurred_at`,
    [shopId]
  );

  let written = 0;
  for (const iv of pending.rows) {
    const scope: "shop" | "listing" = iv.entity_type === "shop" ? "shop" : "listing";
    if (scope === "listing" && (iv.entity_id === null || iv.entity_id === undefined)) continue; // malformed, skip
    const entityId = scope === "shop" ? "" : String(iv.entity_id);
    const metrics = scope === "shop" ? SHOP_METRICS : LISTING_METRICS;
    const occurredAt = new Date(iv.occurred_at).toISOString();
    const interventionId = Number(iv.id);

    for (const metric of metrics) {
      const result = await estimateEffect(q, {
        shopId,
        scope,
        entityId,
        metric,
        occurredAt,
        interventionType: iv.intervention_type,
        isCleanWindow: iv.is_clean_window,
      });
      if (result.pointEstimate === null) continue; // no data yet -> nothing worth storing

      const expRes = await q.query(
        `INSERT INTO experiments
           (intervention_id, shop_id, entity_id, metric, method, baseline_start, baseline_end, effect_window)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [interventionId, shopId, entityId, metric, result.method, result.baselineStart, result.baselineEnd, EFFECT_WINDOW]
      );
      const experimentId = expRes.rows[0].id;

      await q.query(
        `INSERT INTO effects
           (experiment_id, shop_id, intervention_type, metric, effect_window,
            point_estimate, ci_low, ci_high, control_adjusted, confidence_label, caveats)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [
          experimentId,
          shopId,
          iv.intervention_type,
          metric,
          EFFECT_WINDOW,
          result.pointEstimate,
          result.ciLow,
          result.ciHigh,
          result.controlAdjusted,
          result.confidenceLabel,
          j(result.caveats),
        ]
      );
      written++;
    }
  }
  return written;
}
