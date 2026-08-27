// Ads parser -> ads_daily. listing_id = 0 denotes the shop-wide total (the DB
// primary key cannot hold NULL, so 0 is the sentinel for "all listings").
import type { AdsDailyRow, Parser } from "./types.js";
import { getArray, pick, toDateOnly, toInt, toMoney, toStr } from "./util.js";

export const SHOP_TOTAL_LISTING = 0;

export const parseAds: Parser = (body) => {
  const entries = getArray(body, ["ads", "advertising", "campaigns", "daily", "results"]);
  const adsDaily: AdsDailyRow[] = [];

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
      clicks: toInt(pick(e, ["clicks", "click_count"])),
      ordersFromAds: toInt(pick(e, ["orders", "orders_from_ads", "conversions"])),
      revenueFromAds: revenue.value,
    });
  }

  return { adsDaily };
};
