// Ads parser -> ads_daily. listing_id = 0 denotes the shop-wide total.
//
// Handles Etsy's real ad-traffic shape { stats: [{clickCount, timestamp}],
// comparisonStats: [...] } by summing hourly clicks into daily rows (this
// endpoint gives clicks only; spend/impressions stay null). Also handles a
// richer per-day entry shape { date, spend, impressions, clicks, ... }.
import type { AdsDailyRow, Parser } from "./types.js";
import { getArray, isObject, pick, toDateOnly, toInt, toMoney, toStr } from "./util.js";

export const SHOP_TOTAL_LISTING = 0;

/** Sum an array of {clickCount, timestamp} into clicks-per-day. */
function clicksByDay(arr: unknown): Map<string, number> {
  const byDay = new Map<string, number>();
  if (!Array.isArray(arr)) return byDay;
  for (const e of arr) {
    if (!isObject(e)) continue;
    const day = toDateOnly(pick(e, ["timestamp", "date", "day"]));
    const clicks = toInt(pick(e, ["clickCount", "clicks", "click_count"]));
    if (!day || clicks === null) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + clicks);
  }
  return byDay;
}

export const parseAds: Parser = (body) => {
  const adsDaily: AdsDailyRow[] = [];

  // Shape 1: ad-traffic click stats. Only `stats` is the current period;
  // `comparisonStats` is the previous period and is intentionally ignored here.
  if (isObject(body) && (Array.isArray(body.stats) || Array.isArray(body.comparisonStats))) {
    for (const [statDate, clicks] of clicksByDay(body.stats)) {
      adsDaily.push({
        statDate,
        listingId: SHOP_TOTAL_LISTING,
        state: null,
        spend: null,
        impressions: null,
        clicks,
        ordersFromAds: null,
        revenueFromAds: null,
      });
    }
    return { adsDaily };
  }

  // Shape 2: richer per-day entries.
  const entries = getArray(body, ["ads", "advertising", "campaigns", "daily", "results"]);
  for (const e of entries) {
    const statDate = toDateOnly(pick(e, ["date", "day", "stat_date"]));
    if (!statDate) continue;
    const spend = toMoney(pick(e, ["spend", "cost", "amount_spent"]));
    const revenue = toMoney(pick(e, ["revenue", "revenue_from_ads", "sales"]));
    adsDaily.push({
      statDate,
      listingId: toInt(pick(e, ["listing_id", "listingId"])) ?? SHOP_TOTAL_LISTING,
      state: toStr(pick(e, ["state", "status"])),
      spend: spend.value,
      impressions: toInt(pick(e, ["impressions", "views"])),
      clicks: toInt(pick(e, ["clicks", "click_count", "clickCount"])),
      ordersFromAds: toInt(pick(e, ["orders", "orders_from_ads", "conversions"])),
      revenueFromAds: revenue.value,
    });
  }
  return { adsDaily };
};
