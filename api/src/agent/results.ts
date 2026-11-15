// Turns an agent's job result into stored state:
//   * "latest" tables the command center reads (campaign, listings, keywords, shop stats),
//   * raw captures fed through the existing ingest → parse pipeline, so ads_daily,
//     stats_daily and the intervention ledger (ad on/off, budget) stay in sync
//     with what the agent saw and did — the causal engine gets every command
//     as a precisely-timed intervention for free.
import type { Pool, Queryable } from "../repository.js";
import { ensureShop, withTransaction } from "../repository.js";
import { ingestApi } from "../service.js";
import { logAction, type JobRow } from "./repo.js";

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, "")))) return Math.round(Number(v.replace(/,/g, "")));
  return null;
};
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, "")))) return Number(v.replace(/,/g, ""));
  return null;
};
const dayFromTs = (ts: unknown): string | null => {
  const n = num(ts);
  if (n === null) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
};

export interface AdsCollectResult {
  shop?: { id?: number | string; name?: string; currency?: string };
  range: { start: string; end: string };
  campaign?: { totalDailyBudget?: number; isActive?: boolean; status?: number } | null;
  minBudgetCents?: number | null;
  maxBudgetCents?: number | null;
  promotedCount?: number | null;
  shopStats?: Record<string, any> | null;
  listings?: Array<{ listing: Record<string, any>; totalStats: Record<string, any> }>;
  yesterday?: { date: string; listings: Array<{ listing: Record<string, any>; totalStats: Record<string, any> }> } | null;
  queries?: Record<string, Array<Record<string, any>>>;
}

export interface ShopStatsCollectResult {
  rangeKey: string;
  startDate?: string;
  endDate?: string;
  metrics?: Record<string, any>;
  traffic?: unknown;
  topListings?: unknown;
}

export interface ActionResultItem {
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  verified?: boolean | null;
}

export interface WriteJobResult {
  actions?: ActionResultItem[];
  /** Raw Etsy responses of the write calls (fed to the parsers). */
  captures?: Array<{ url: string; status?: number; body: unknown }>;
}

async function storeAds(c: Queryable, shopTag: string, r: AdsCollectResult): Promise<{ listings: number; queries: number }> {
  const now = new Date().toISOString();
  const currency = r.shop?.currency ?? null;
  const ss = isObj(r.shopStats) ? r.shopStats : null;
  const daily = Array.isArray(ss?.graphStats)
    ? ss!.graphStats.map((g: any) => ({
        date: dayFromTs(g.timestamp),
        impressions: int(g.impressionCount),
        clicks: int(g.clickCount),
        spendCents: int(g.spentTotal),
        orders: int(g.conversions),
        revenueCents: int(g.revenue),
      }))
    : null;
  await c.query(
    `INSERT INTO ads_campaign_latest (shop_tag, budget_cents, is_active, status, min_budget_cents, max_budget_cents,
       promoted_count, currency, range_start, range_end, totals, daily, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
     ON CONFLICT (shop_tag) DO UPDATE SET budget_cents = EXCLUDED.budget_cents, is_active = EXCLUDED.is_active,
       status = EXCLUDED.status, min_budget_cents = EXCLUDED.min_budget_cents, max_budget_cents = EXCLUDED.max_budget_cents,
       promoted_count = EXCLUDED.promoted_count, currency = EXCLUDED.currency, range_start = EXCLUDED.range_start,
       range_end = EXCLUDED.range_end, totals = EXCLUDED.totals, daily = EXCLUDED.daily, captured_at = EXCLUDED.captured_at`,
    [
      shopTag,
      int(r.campaign?.totalDailyBudget),
      typeof r.campaign?.isActive === "boolean" ? r.campaign.isActive : null,
      int(r.campaign?.status),
      int(r.minBudgetCents),
      int(r.maxBudgetCents),
      int(r.promotedCount),
      currency,
      r.range.start,
      r.range.end,
      JSON.stringify(ss?.totalStats ?? null),
      JSON.stringify(daily),
      now,
    ]
  );

  let listings = 0;
  for (const entry of r.listings ?? []) {
    const l = entry?.listing;
    const t = entry?.totalStats ?? {};
    const id = int(l?.listingId);
    if (!isObj(l) || id === null) continue;
    await c.query(
      `INSERT INTO ads_listing_latest (shop_tag, listing_id, range_start, range_end, title, image_url, is_promoted, strategy,
         price_minor, currency, quantity, section, impressions, clicks, spend_cents, orders, revenue_cents, roas, click_rate, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (shop_tag, listing_id) DO UPDATE SET range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end,
         title = EXCLUDED.title, image_url = EXCLUDED.image_url, is_promoted = EXCLUDED.is_promoted, strategy = EXCLUDED.strategy,
         price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency, quantity = EXCLUDED.quantity, section = EXCLUDED.section,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, spend_cents = EXCLUDED.spend_cents, orders = EXCLUDED.orders,
         revenue_cents = EXCLUDED.revenue_cents, roas = EXCLUDED.roas, click_rate = EXCLUDED.click_rate, captured_at = EXCLUDED.captured_at`,
      [
        shopTag,
        id,
        r.range.start,
        r.range.end,
        typeof l.title === "string" ? l.title : null,
        typeof l.imageUrlFullxfull === "string" ? l.imageUrlFullxfull.replace("il_fullxfull", "il_170x135") : null,
        typeof l.isPromoted === "boolean" ? l.isPromoted : null,
        int(l.listingStrategy?.strategy),
        int(l.priceInt),
        typeof l.currencyCode === "string" ? l.currencyCode : null,
        int(l.quantity),
        typeof l.sectionName === "string" ? l.sectionName : null,
        int(t.impressionCount),
        int(t.clickCount),
        int(t.spentTotal),
        int(t.conversions),
        int(t.revenue),
        num(t.roas),
        num(t.clickRate),
        now,
      ]
    );
    listings++;
  }

  let queries = 0;
  for (const [lid, rows] of Object.entries(r.queries ?? {})) {
    const listingId = int(lid);
    if (listingId === null || !Array.isArray(rows)) continue;
    await c.query(`DELETE FROM ads_query_latest WHERE shop_tag = $1 AND listing_id = $2`, [shopTag, listingId]);
    const seen = new Set<string>();
    for (const q of rows) {
      const query = typeof q?.stemmed_query === "string" ? q.stemmed_query : typeof q?.query === "string" ? q.query : null;
      if (!query || seen.has(query)) continue;
      seen.add(query);
      await c.query(
        `INSERT INTO ads_query_latest (shop_tag, listing_id, query, range_start, impressions, clicks, orders, cost_cents,
           revenue_cents, roas, click_rate, is_relevant, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          shopTag,
          listingId,
          query,
          r.range.start,
          int(q.impression_counts ?? q.impression_count),
          int(q.click_count),
          int(q.order_count),
          int(q.cost),
          int(q.revenue),
          num(q.roas),
          num(q.click_rate),
          typeof q.is_relevant === "boolean" ? q.is_relevant : null,
          now,
        ]
      );
      queries++;
    }
  }

  // Yesterday's per-listing totals → ads_daily (one row per listing per day).
  if (r.yesterday && Array.isArray(r.yesterday.listings) && /^\d{4}-\d{2}-\d{2}$/.test(r.yesterday.date)) {
    const shopId = await ensureShop(c, { shopTag, etsyShopId: r.shop?.id != null ? String(r.shop.id) : null });
    for (const entry of r.yesterday.listings) {
      const id = int(entry?.listing?.listingId);
      const t = entry?.totalStats ?? {};
      if (id === null) continue;
      const spend = int(t.spentTotal);
      const rev = int(t.revenue);
      await c.query(
        `INSERT INTO ads_daily (shop_id, stat_date, listing_id, channel, state, spend, impressions, clicks, orders_from_ads, revenue_from_ads)
         VALUES ($1,$2,$3,'onsite',$4,$5,$6,$7,$8,$9)
         ON CONFLICT (shop_id, stat_date, listing_id, channel) DO UPDATE SET state = EXCLUDED.state, spend = EXCLUDED.spend,
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, orders_from_ads = EXCLUDED.orders_from_ads,
           revenue_from_ads = EXCLUDED.revenue_from_ads`,
        [
          shopId,
          r.yesterday.date,
          id,
          entry.listing.isPromoted === true ? "on" : entry.listing.isPromoted === false ? "off" : null,
          spend === null ? null : spend / 100,
          int(t.impressionCount),
          int(t.clickCount),
          int(t.conversions),
          rev === null ? null : rev / 100,
        ]
      );
    }
  }
  return { listings, queries };
}

async function storeShopStats(c: Queryable, shopTag: string, r: ShopStatsCollectResult): Promise<void> {
  const m = isObj(r.metrics) ? r.metrics : {};
  const entries = (k: string): Array<{ timestamp: number; value: number }> =>
    Array.isArray(m[k]?.entries) ? m[k].entries.filter((e: any) => isObj(e)) : [];
  const byDay = new Map<string, Record<string, number | null>>();
  for (const k of ["visits", "orders", "revenue", "conversion_rate"]) {
    for (const e of entries(k)) {
      const d = dayFromTs(e.timestamp);
      if (!d) continue;
      const row = byDay.get(d) ?? {};
      row[k] = num(e.value);
      byDay.set(d, row);
    }
  }
  const daily: Array<{ date: string } & Record<string, number | null>> = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => Object.assign({ date }, v) as { date: string } & Record<string, number | null>);
  await c.query(
    `INSERT INTO shop_stats_latest (shop_tag, range_key, start_date, end_date, visits, orders, revenue, conversion_rate, aov,
       traffic, daily, top_listings, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,now())
     ON CONFLICT (shop_tag, range_key) DO UPDATE SET start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
       visits = EXCLUDED.visits, orders = EXCLUDED.orders, revenue = EXCLUDED.revenue, conversion_rate = EXCLUDED.conversion_rate,
       aov = EXCLUDED.aov, traffic = EXCLUDED.traffic, daily = EXCLUDED.daily, top_listings = EXCLUDED.top_listings,
       captured_at = EXCLUDED.captured_at`,
    [
      shopTag,
      r.rangeKey,
      r.startDate ?? null,
      r.endDate ?? null,
      int(m.visits?.total),
      int(m.orders?.total),
      m.revenue?.total != null ? String(m.revenue.total) : null,
      m.conversion_rate?.total != null ? String(m.conversion_rate.total) : null,
      m.average_order_value?.total != null ? String(m.average_order_value.total) : null,
      JSON.stringify(r.traffic ?? null),
      JSON.stringify(daily),
      JSON.stringify(r.topListings ?? null),
    ]
  );

  // Complete days → stats_daily (analytics). Today is partial; skip it.
  if (r.rangeKey === "last_30" || r.rangeKey === "last_7" || r.rangeKey === "this_month") {
    const shopId = await ensureShop(c, { shopTag });
    const today = new Date().toISOString().slice(0, 10);
    for (const d of daily) {
      if (d.date >= today) continue;
      await c.query(
        `INSERT INTO stats_daily (shop_id, stat_date, visits, orders, captured_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (shop_id, stat_date) DO UPDATE SET
           visits = COALESCE(EXCLUDED.visits, stats_daily.visits),
           orders = COALESCE(EXCLUDED.orders, stats_daily.orders),
           captured_at = EXCLUDED.captured_at`,
        [shopId, d.date, d.visits == null ? null : Math.round(d.visits as number), d.orders == null ? null : Math.round(d.orders as number)]
      );
    }
  }
}

async function applyWriteEffects(c: Queryable, job: JobRow, r: WriteJobResult): Promise<void> {
  for (const a of r.actions ?? []) {
    await logAction(c, {
      jobId: job.id,
      shopTag: job.shop_tag,
      action: a.action,
      target: a.target ?? null,
      before: a.before,
      after: a.after,
      verified: a.verified ?? null,
    });
    if (!a.verified) continue;
    // Keep the command center's view current without waiting for the next collection.
    if (a.action === "ads.set_promoted" && a.target && isObj(a.after) && typeof a.after.promoted === "boolean") {
      await c.query(`UPDATE ads_listing_latest SET is_promoted = $3 WHERE shop_tag = $1 AND listing_id = $2`, [
        job.shop_tag,
        Number(a.target),
        a.after.promoted,
      ]);
    }
    if (a.action === "ads.set_query_relevance" && a.target && isObj(a.after) && typeof a.after.isRelevant === "boolean") {
      const [lid, ...rest] = a.target.split(":");
      await c.query(`UPDATE ads_query_latest SET is_relevant = $4 WHERE shop_tag = $1 AND listing_id = $2 AND query = $3`, [
        job.shop_tag,
        Number(lid),
        rest.join(":"),
        a.after.isRelevant,
      ]);
    }
    if (a.action === "ads.set_budget" && isObj(a.after) && typeof a.after.budgetCents === "number") {
      await c.query(`UPDATE ads_campaign_latest SET budget_cents = $2 WHERE shop_tag = $1`, [job.shop_tag, a.after.budgetCents]);
    }
  }
}

/** Store a finished job's result. Returns a short summary for the job row. */
export async function processJobResult(pool: Pool, job: JobRow, result: unknown): Promise<Record<string, unknown>> {
  if (!isObj(result)) return {};
  const summary: Record<string, unknown> = {};
  await withTransaction(pool, async (c) => {
    if (job.kind === "collect.ads") {
      Object.assign(summary, await storeAds(c, job.shop_tag, result as unknown as AdsCollectResult));
    } else if (job.kind === "collect.shop_stats") {
      await storeShopStats(c, job.shop_tag, result as unknown as ShopStatsCollectResult);
      summary.stored = true;
    } else if (job.kind.startsWith("ads.")) {
      await applyWriteEffects(c, job, result as WriteJobResult);
      const acts = (result as WriteJobResult).actions ?? [];
      summary.actions = acts.length;
      summary.verified = acts.filter((a) => a.verified).length;
    }
  });

  // Raw Etsy responses → existing ingest/parse pipeline (ads_daily, interventions).
  const raws: Array<{ url: string; status?: number; body: unknown }> = [];
  if (job.kind === "collect.ads" && isObj((result as AdsCollectResult).shopStats)) {
    raws.push({ url: "agent:/prolist/stats", body: (result as AdsCollectResult).shopStats });
  }
  if (job.kind.startsWith("ads.")) raws.push(...((result as WriteJobResult).captures ?? []));
  if (raws.length) {
    await ingestApi(
      pool,
      job.shop_tag,
      raws.map((r) => ({
        captureType: "ads" as const,
        url: r.url,
        status: r.status ?? 200,
        body: r.body,
        entityId: `job${job.id}:${r.url}`,
        capturedAt: new Date().toISOString(),
        dedupKey: undefined,
      }))
    );
  }
  return summary;
}
