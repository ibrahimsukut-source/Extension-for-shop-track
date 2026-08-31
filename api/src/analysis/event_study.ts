// event_study_aggregator (spec §7, §8.3 Strategy Panel). Pools every computed
// effect of the same (intervention_type, metric) pair across all listings and
// times into one generalized estimate: "when I've done X before, the average
// effect on Y was Z, across N instances". A pure read-time rollup over the
// `effects` table P1 already populates — no new storage, always current.
import type { Queryable } from "../repository.js";

export interface EventStudyRow {
  interventionType: string;
  metric: string;
  n: number;
  meanEffect: number;
  stdDev: number | null;
  nControlAdjusted: number;
  nMedium: number;
  nLow: number;
}

export async function getEventStudy(q: Queryable, shopId?: number): Promise<EventStudyRow[]> {
  const filter = shopId != null ? "WHERE shop_id=$1" : "";
  const params = shopId != null ? [shopId] : [];
  const res = await q.query(
    `SELECT intervention_type, metric, point_estimate, control_adjusted, confidence_label
       FROM effects ${filter}`,
    params
  );

  interface Group {
    interventionType: string;
    metric: string;
    values: number[];
    controlAdjusted: number;
    medium: number;
    low: number;
  }
  const groups = new Map<string, Group>();
  for (const r of res.rows) {
    if (r.point_estimate === null || r.point_estimate === undefined) continue;
    const key = `${r.intervention_type}::${r.metric}`;
    let g = groups.get(key);
    if (!g) {
      g = { interventionType: r.intervention_type, metric: r.metric, values: [], controlAdjusted: 0, medium: 0, low: 0 };
      groups.set(key, g);
    }
    g.values.push(Number(r.point_estimate));
    if (r.control_adjusted) g.controlAdjusted++;
    if (r.confidence_label === "medium") g.medium++;
    else g.low++;
  }

  const out: EventStudyRow[] = [];
  for (const g of groups.values()) {
    const n = g.values.length;
    const meanEffect = g.values.reduce((s, v) => s + v, 0) / n;
    const stdDev = n >= 2 ? Math.sqrt(g.values.reduce((s, v) => s + (v - meanEffect) ** 2, 0) / (n - 1)) : null;
    out.push({
      interventionType: g.interventionType,
      metric: g.metric,
      n,
      meanEffect,
      stdDev,
      nControlAdjusted: g.controlAdjusted,
      nMedium: g.medium,
      nLow: g.low,
    });
  }
  out.sort((a, b) => b.n - a.n || a.interventionType.localeCompare(b.interventionType) || a.metric.localeCompare(b.metric));
  return out;
}
