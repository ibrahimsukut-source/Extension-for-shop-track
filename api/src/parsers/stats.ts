// Stats parser -> stats_daily (shop-level) and, when entries carry a listing_id,
// listing_stats_daily. Etsy's stats payloads vary; we treat any entry that has a
// date-like field as one daily row.
import type { ListingStatsDailyRow, Parser, StatsDailyRow } from "./types.js";
import { getArray, pick, toDateOnly, toInt, toMoney, toStr } from "./util.js";

function conversion(entry: Record<string, unknown>, visits: number | null, orders: number | null): number | null {
  const direct = pick(entry, ["conversion_rate", "conversionRate", "conversion"]);
  if (direct !== undefined) {
    const n = Number(toStr(direct));
    if (Number.isFinite(n)) return n > 1 ? n / 100 : n; // accept 2.5(%) or 0.025
  }
  if (visits && orders !== null && visits > 0) return orders / visits;
  return null;
}

export const parseStats: Parser = (body) => {
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

    statsDaily.push({
      statDate,
      visits,
      views,
      orders,
      revenue: revenue.value,
      currency: revenue.currency ?? toStr(pick(e, ["currency_code", "currency"])),
      conversionRate: conversion(e, visits, orders),
      trafficSources: pick(e, ["traffic_sources", "trafficSources", "sources"]) ?? null,
      topSearchTerms: pick(e, ["top_search_terms", "search_terms", "searchTerms"]) ?? null,
    });
  }

  return { statsDaily, listingStatsDaily };
};
