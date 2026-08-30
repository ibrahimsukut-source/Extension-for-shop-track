// shop_level_analyzer (spec §7): finds shifts in a shop-wide daily metric that
// aren't explained by any logged intervention — a platform algorithm change,
// an external traffic event, a seasonal turn nobody clicked a button for.
// Simple two-window comparison (trailing 7 days vs leading 7 days) rather than
// a full statistical change-point model: transparent, cheap, and easy to
// sanity-check by eye against the raw series it's built from.
import type { Queryable } from "../repository.js";
import { getMetricSeries, mean } from "./metric_series.js";

export interface ChangePoint {
  date: string;
  metric: string;
  before: number;
  after: number;
  delta: number;
  relDelta: number | null; // null when `before` is ~0 (relative change is meaningless there)
  direction: "up" | "down";
}

const WINDOW_DAYS = 7;
const REL_THRESHOLD = 0.4; // >=40% shift between the two windows
const MIN_BASE = 1; // ignore swings off a near-zero base (relative % there is noise)
const SUPPRESSION_DAYS = 10; // don't report two change points within this many days of each other

/**
 * Detect change points for one shop-scope metric over its full history.
 * Returns at most one change point per SUPPRESSION_DAYS window, keeping the
 * strongest (largest |relDelta|) candidate in each window.
 */
export async function detectChangePoints(q: Queryable, shopId: number, metric: string): Promise<ChangePoint[]> {
  const series = await getMetricSeries(q, shopId, "shop", "", metric, "1970-01-01", "9999-12-31");
  if (series.length < WINDOW_DAYS * 2 + 1) return [];

  const candidates: ChangePoint[] = [];
  for (let i = WINDOW_DAYS; i + WINDOW_DAYS <= series.length; i++) {
    const beforeWindow = series.slice(i - WINDOW_DAYS, i);
    const afterWindow = series.slice(i, i + WINDOW_DAYS);
    const before = mean(beforeWindow)!;
    const after = mean(afterWindow)!;
    const delta = after - before;
    const relDelta = before >= MIN_BASE ? delta / before : null;
    if (relDelta !== null && Math.abs(relDelta) >= REL_THRESHOLD) {
      candidates.push({ date: series[i].date, metric, before, after, delta, relDelta, direction: delta > 0 ? "up" : "down" });
    }
  }

  // Non-max suppression: walk candidates in date order, keep the strongest
  // one in each SUPPRESSION_DAYS neighborhood.
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  const kept: ChangePoint[] = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(c);
      continue;
    }
    const daysSince = (new Date(c.date).getTime() - new Date(last.date).getTime()) / 86_400_000;
    if (daysSince > SUPPRESSION_DAYS) {
      kept.push(c);
    } else if (Math.abs(c.relDelta ?? 0) > Math.abs(last.relDelta ?? 0)) {
      kept[kept.length - 1] = c; // stronger candidate in the same neighborhood wins
    }
  }
  return kept;
}

const DEFAULT_METRICS = ["visits", "orders", "revenue"];

/** Convenience: change points across the usual shop-level decision metrics. */
export async function detectAllChangePoints(q: Queryable, shopId: number, metrics: string[] = DEFAULT_METRICS): Promise<ChangePoint[]> {
  const results = await Promise.all(metrics.map((m) => detectChangePoints(q, shopId, m)));
  return results.flat().sort((a, b) => b.date.localeCompare(a.date));
}
