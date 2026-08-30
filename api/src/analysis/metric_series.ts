// Read helper over metric_timeseries (the long-format table metric_builder
// fills) for the effect estimator: one entity/metric's daily values in a date
// range, nulls dropped (a missing day just isn't counted — never treated as 0).
import type { Queryable } from "../repository.js";
import { toDateOnlyStr } from "./dates.js";

export interface MetricPoint {
  date: string;
  value: number;
}

export async function getMetricSeries(
  q: Queryable,
  shopId: number,
  scope: "shop" | "listing",
  entityId: string,
  metric: string,
  fromDate: string,
  toDate: string
): Promise<MetricPoint[]> {
  const res = await q.query(
    `SELECT metric_date, value
       FROM metric_timeseries
      WHERE shop_id=$1 AND scope=$2 AND entity_id=$3 AND metric=$4
        AND metric_date >= $5 AND metric_date <= $6
      ORDER BY metric_date`,
    [shopId, scope, entityId, metric, fromDate, toDate]
  );
  const points: MetricPoint[] = [];
  for (const r of res.rows) {
    if (r.value === null || r.value === undefined) continue;
    points.push({ date: toDateOnlyStr(r.metric_date), value: Number(r.value) });
  }
  return points;
}

export function mean(points: MetricPoint[]): number | null {
  if (points.length === 0) return null;
  return points.reduce((s, p) => s + p.value, 0) / points.length;
}
