// Analysis-engine data access (spec §6/§7). Two writers feed the causal layer:
//   * upsertIntervention   — the "what I did" ledger (from the detector)
//   * buildMetricTimeseries — collapses the wide daily-stats tables into the
//     long-format metric_timeseries the estimators consume (one row per
//     shop/scope/entity/metric/day).
// Plus a few read helpers for the dashboard's Intervention Ledger.
import type { Queryable } from "../repository.js";
import { makeDedupKey } from "../lib/dedup.js";
import type { Intervention } from "./interventions.js";

const j = (v: unknown) => JSON.stringify(v ?? null);

/** Idempotent insert of one detected intervention. Returns true if new. */
export async function upsertIntervention(
  q: Queryable,
  shopId: number,
  iv: Intervention
): Promise<boolean> {
  const dedupKey = makeDedupKey({
    shopId: String(shopId),
    captureType: `intervention:${iv.interventionType}`,
    key: iv.entityId ?? "",
    body: JSON.stringify({ before: iv.beforeValue, after: iv.afterValue }),
    capturedAtMs: Date.parse(iv.occurredAt),
  });
  const res = await q.query(
    `INSERT INTO interventions
       (shop_id, intervention_type, entity_type, entity_id, occurred_at,
        before_value, after_value, magnitude, source, is_clean_window, confidence, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      shopId,
      iv.interventionType,
      iv.entityType,
      iv.entityId,
      iv.occurredAt,
      j(iv.beforeValue),
      j(iv.afterValue),
      iv.magnitude,
      iv.source,
      null, // is_clean_window: filled later by clean_window_flagger (P1)
      iv.confidence,
      dedupKey,
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

// Fixed metric whitelists → interpolated into SQL. NEVER derived from input, so
// safe from injection. Shop metrics come from stats_daily, listing metrics from
// listing_stats_daily.
const SHOP_METRICS = ["views", "visits", "orders", "revenue", "conversion_rate"] as const;
const LISTING_METRICS = ["views", "visits", "favorites", "orders", "revenue"] as const;

/**
 * Rebuild metric_timeseries from the wide daily tables. Idempotent: re-running
 * refreshes values in place (ON CONFLICT DO UPDATE). Scopes to one shop when
 * shopId is given, else rebuilds all. Returns the number of upserted rows.
 */
export async function buildMetricTimeseries(q: Queryable, shopId?: number): Promise<number> {
  const filter = shopId != null ? " AND shop_id = $1" : "";
  const params = shopId != null ? [shopId] : [];
  let n = 0;

  for (const m of SHOP_METRICS) {
    const res = await q.query(
      `INSERT INTO metric_timeseries (shop_id, scope, entity_id, metric, metric_date, value)
       SELECT shop_id, 'shop', '', '${m}', stat_date, ${m}
         FROM stats_daily
        WHERE ${m} IS NOT NULL AND stat_date IS NOT NULL${filter}
       ON CONFLICT (shop_id, scope, entity_id, metric, metric_date)
       DO UPDATE SET value = EXCLUDED.value`,
      params
    );
    n += res.rowCount ?? 0;
  }

  for (const m of LISTING_METRICS) {
    const res = await q.query(
      `INSERT INTO metric_timeseries (shop_id, scope, entity_id, metric, metric_date, value)
       SELECT shop_id, 'listing', CAST(listing_id AS TEXT), '${m}', stat_date, ${m}
         FROM listing_stats_daily
        WHERE ${m} IS NOT NULL AND stat_date IS NOT NULL${filter}
       ON CONFLICT (shop_id, scope, entity_id, metric, metric_date)
       DO UPDATE SET value = EXCLUDED.value`,
      params
    );
    n += res.rowCount ?? 0;
  }

  return n;
}

export async function countInterventions(q: Queryable): Promise<number> {
  const res = await q.query(`SELECT count(*)::int AS n FROM interventions`);
  return res.rows[0]?.n ?? 0;
}

export async function countMetricPoints(q: Queryable): Promise<number> {
  const res = await q.query(`SELECT count(*)::int AS n FROM metric_timeseries`);
  return res.rows[0]?.n ?? 0;
}

/** Most recent interventions for the dashboard's Intervention Ledger (§8.1). */
export async function getInterventionLedger(q: Queryable, limit = 40): Promise<any[]> {
  const res = await q.query(
    `SELECT intervention_type, entity_type, entity_id, occurred_at,
            before_value, after_value, magnitude, source, confidence
       FROM interventions
      ORDER BY occurred_at DESC, id DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** Most recent computed effects for the dashboard's Effect Cards (§8.2). */
export async function getEffectCards(q: Queryable, limit = 30): Promise<any[]> {
  const res = await q.query(
    `SELECT ef.metric, ef.effect_window, ef.point_estimate, ef.ci_low, ef.ci_high,
            ef.control_adjusted, ef.confidence_label, ef.caveats, ef.computed_at,
            x.method, x.entity_id, x.baseline_start, x.baseline_end,
            iv.intervention_type, iv.occurred_at, iv.entity_type
       FROM effects ef
       JOIN experiments x ON x.id = ef.experiment_id
       JOIN interventions iv ON iv.id = x.intervention_id
      ORDER BY ef.computed_at DESC, ef.id DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}
