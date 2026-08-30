// Ads parser -> ads_daily (+ ad on/off toggles). listing_id = 0 denotes the
// shop-wide total. Etsy has TWO separate ad programs that both report at
// shop-wide granularity — Offsite Ads (clicks only, via ad-traffic) and
// on-site Etsy Ads (spend/impressions/ROAS, via prolist/stats). ads_daily's
// key includes `channel` so parsing one never clobbers the other's row for
// the same (shop, date, listing=0).
//
// Handles Etsy's real offsite ad-traffic shape { stats: [{clickCount,
// timestamp}], comparisonStats: [...] } by summing hourly clicks into daily
// rows (channel='offsite'; this endpoint gives clicks only, spend/impressions
// stay null). Handles the real on-site GET /prolist/stats shape
// { graphStats: [{impressionCount, clickCount, spentTotal, conversions,
// revenue, roas, timestamp}], comparisonGraphStats: [...] } — real capture
// from OrnamentsPoint (shop 32467610) — as channel='onsite' daily rows;
// spentTotal/revenue are minor-unit integers (matches Etsy's amount/divisor=
// 100 money convention elsewhere: e.g. revenue 2727 / spentTotal 1112 = 2.45,
// exactly the reported roas). comparisonGraphStats is the previous period and
// is intentionally ignored, same as offsite's comparisonStats. Also handles a
// richer generic per-day entry shape { date, spend, impressions, clicks, ...
// } (channel='unknown' — origin not identifiable from shape alone), and the
// real POST /prolist/listings toggle response { listings: {"<listingId>":
// boolean}, countOfAdvertisedListings }, which carries no daily metric but is
// itself an intervention (spec §4 ad-level: etsy_ads_on / etsy_ads_off) —
// promoted via adToggles instead of adsDaily.
import type { AdsDailyRow, AdToggleRow, Parser } from "./types.js";
import { getArray, isObject, pick, toDateOnly, toInt, toMoney, toStr } from "./util.js";

export const SHOP_TOTAL_LISTING = 0;

/** True for the toggle-response shape: `listings` is an id -> boolean map. */
function isToggleShape(body: unknown): body is { listings: Record<string, unknown> } {
  if (!isObject(body) || !isObject(body.listings)) return false;
  const vals = Object.values(body.listings);
  return vals.length > 0 && vals.every((v) => typeof v === "boolean");
}

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

/** Minor-unit integer (Etsy money convention, divisor=100) -> major-unit number. */
function minorToMajor(v: unknown): number | null {
  const n = toInt(v);
  return n === null ? null : n / 100;
}

export const parseAds: Parser = (body) => {
  const adsDaily: AdsDailyRow[] = [];

  // Shape 0: ad on/off toggle response — checked first, it's the most specific
  // shape (a bare id -> boolean map, no stats/entries arrays at all).
  if (isToggleShape(body)) {
    const adToggles: AdToggleRow[] = [];
    for (const [id, v] of Object.entries(body.listings)) {
      const listingId = toInt(id);
      if (listingId === null || typeof v !== "boolean") continue;
      adToggles.push({ listingId, isAdvertised: v });
    }
    return { adToggles };
  }

  // Shape 1: offsite ad-traffic click stats. Only `stats` is the current
  // period; `comparisonStats` is the previous period, ignored.
  if (isObject(body) && (Array.isArray(body.stats) || Array.isArray(body.comparisonStats))) {
    for (const [statDate, clicks] of clicksByDay(body.stats)) {
      adsDaily.push({
        statDate,
        listingId: SHOP_TOTAL_LISTING,
        channel: "offsite",
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

  // Shape 1b: on-site Etsy Ads daily stats (real GET /prolist/stats shape).
  // Only `graphStats` is the current period; `comparisonGraphStats` is the
  // previous period, ignored.
  if (isObject(body) && Array.isArray(body.graphStats)) {
    for (const e of body.graphStats) {
      if (!isObject(e)) continue;
      const statDate = toDateOnly(e.timestamp);
      if (!statDate) continue;
      adsDaily.push({
        statDate,
        listingId: SHOP_TOTAL_LISTING,
        channel: "onsite",
        state: null,
        spend: minorToMajor(e.spentTotal),
        impressions: toInt(e.impressionCount),
        clicks: toInt(e.clickCount),
        ordersFromAds: toInt(e.conversions),
        revenueFromAds: minorToMajor(e.revenue),
      });
    }
    return { adsDaily };
  }

  // Shape 2: richer per-day entries (origin not identifiable from shape alone).
  const entries = getArray(body, ["ads", "advertising", "campaigns", "daily", "results"]);
  for (const e of entries) {
    const statDate = toDateOnly(pick(e, ["date", "day", "stat_date"]));
    if (!statDate) continue;
    const spend = toMoney(pick(e, ["spend", "cost", "amount_spent"]));
    const revenue = toMoney(pick(e, ["revenue", "revenue_from_ads", "sales"]));
    adsDaily.push({
      statDate,
      listingId: toInt(pick(e, ["listing_id", "listingId"])) ?? SHOP_TOTAL_LISTING,
      channel: "unknown",
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
