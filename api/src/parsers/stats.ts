// Stats parser -> stats_daily (shop-level) + listing_stats_daily.
//
// Primary path handles Etsy's real shop-analytics-stats shape (observed on the
// live seller panel): { metrics_summary:{visits,orders,revenue,conversion_rate},
// traffic_breakdown:{etsy_traffic,user_traffic}, start_date "MM/DD/YYYY",
// listings:{listings:[{id,visits,orders,revenue,favorites,badge_text}]} }.
// A generic array-based fallback remains for other/older stats payloads.
import type { JsonObject } from "./util.js";
import type { ListingStatsDailyRow, ParseOutput, Parser, StatsDailyRow } from "./types.js";
import { getArray, isObject, pick, toDateOnly, toInt, toMoney, toStr } from "./util.js";

/** Etsy stats dates are US format "MM/DD/YYYY"; normalize to YYYY-MM-DD (no TZ shift). */
function usDate(v: unknown): string | null {
  const s = toStr(v);
  if (s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return toDateOnly(v);
}

/** "0%" | "2.5%" -> fraction (0 | 0.025); accepts already-fraction values too. */
function percentToFraction(v: unknown): number | null {
  const s = toStr(v);
  if (s === null) return null;
  const n = Number(s.replace("%", "").trim());
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/** Flatten traffic_breakdown.{etsy_traffic,user_traffic}.traffic_sources -> {key: visits}. */
function trafficSources(tb: unknown): Record<string, number> | null {
  if (!isObject(tb)) return null;
  const out: Record<string, number> = {};
  for (const groupKey of ["etsy_traffic", "user_traffic"]) {
    const group = tb[groupKey];
    if (isObject(group) && Array.isArray(group.traffic_sources)) {
      for (const src of group.traffic_sources) {
        if (!isObject(src)) continue;
        const key = toStr(pick(src, ["short_key", "source_key"]));
        const visits = toInt(pick(src, ["visits"]));
        if (key && visits !== null) out[key] = visits;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Primary path: the shop-analytics-stats object. Returns null if not that shape. */
function parseAnalyticsStats(body: JsonObject): ParseOutput | null {
  const ms = body.metrics_summary;
  if (!isObject(ms)) return null;

  const statDate = usDate(body.start_date) ?? usDate(body.end_date);
  if (!statDate) return null;

  const metric = (k: string): JsonObject => (isObject(ms[k]) ? (ms[k] as JsonObject) : {});
  const revenue = metric("revenue");
  const listingsWrap = isObject(body.listings) ? body.listings : {};

  // "Shoppers viewed your listings 11 times" -> 11
  let views: number | null = null;
  const header = toStr(pick(listingsWrap, ["section_header"]));
  const viewsMatch = header && /([\d,]+)\s+times/.exec(header);
  if (viewsMatch) views = toInt(viewsMatch[1]);

  const statsDaily: StatsDailyRow[] = [
    {
      statDate,
      visits: toInt(pick(metric("visits"), ["total"])),
      views,
      orders: toInt(pick(metric("orders"), ["total"])),
      revenue: toMoney(pick(revenue, ["long_total", "total"])).value,
      currency: toStr(pick(body, ["currency_filter"])),
      conversionRate: percentToFraction(pick(metric("conversion_rate"), ["total"])),
      trafficSources: trafficSources(body.traffic_breakdown),
      topSearchTerms: null,
    },
  ];

  const listingStatsDaily: ListingStatsDailyRow[] = [];
  const rows = isObject(listingsWrap) ? listingsWrap.listings : undefined;
  if (Array.isArray(rows)) {
    for (const l of rows) {
      if (!isObject(l)) continue;
      const listingId = toInt(pick(l, ["id", "listing_id"]));
      if (listingId === null) continue;
      listingStatsDaily.push({
        listingId,
        statDate,
        views: null,
        visits: toInt(pick(l, ["visits"])),
        favorites: toInt(pick(l, ["favorites"])),
        orders: toInt(pick(l, ["orders"])),
        revenue: toMoney(pick(l, ["revenue"])).value,
      });
    }
  }

  return { statsDaily, listingStatsDaily };
}

/** Generic fallback: an array of per-day entries each carrying a date field. */
function parseGenericStats(body: unknown): ParseOutput {
  const entries = getArray(body, ["stats", "daily", "days", "series", "results"]);
  const statsDaily: StatsDailyRow[] = [];
  const listingStatsDaily: ListingStatsDailyRow[] = [];

  for (const e of entries) {
    const statDate = toDateOnly(pick(e, ["date", "day", "stat_date", "timestamp"]));
    if (!statDate) continue;

    const visits = toInt(pick(e, ["visits", "visit_count"]));
    const views = toInt(pick(e, ["views", "view_count"]));
    const orders = toInt(pick(e, ["orders", "order_count", "num_orders"]));
    const revenue = toMoney(pick(e, ["revenue", "total_revenue", "sales"]));
    const listingId = toInt(pick(e, ["listing_id", "listingId"]));

    if (listingId !== null) {
      listingStatsDaily.push({
        listingId,
        statDate,
        views,
        visits,
        favorites: toInt(pick(e, ["favorites", "num_favorers"])),
        orders,
        revenue: revenue.value,
      });
      continue;
    }

    const conv = pick(e, ["conversion_rate", "conversionRate", "conversion"]);
    statsDaily.push({
      statDate,
      visits,
      views,
      orders,
      revenue: revenue.value,
      currency: revenue.currency ?? toStr(pick(e, ["currency_code", "currency"])),
      conversionRate:
        conv !== undefined ? percentToFraction(conv) : visits && orders !== null && visits > 0 ? orders / visits : null,
      trafficSources: pick(e, ["traffic_sources", "trafficSources", "sources"]) ?? null,
      topSearchTerms: pick(e, ["top_search_terms", "search_terms", "searchTerms"]) ?? null,
    });
  }

  return { statsDaily, listingStatsDaily };
}

export const parseStats: Parser = (body) => {
  if (isObject(body)) {
    const analytics = parseAnalyticsStats(body);
    if (analytics) return analytics;
  }
  return parseGenericStats(body);
};
