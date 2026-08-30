// Read-only aggregate queries powering the local dashboard (/dashboard/data).
import type { Queryable } from "./repository.js";
import { getInterventionLedger } from "./analysis/repository.js";

export interface DashboardData {
  generatedAt: string;
  shops: any[];
  captureTypes: any[];
  totals: {
    rawCaptures: number;
    parsed: number;
    unparsed: number;
    events: number;
    snapshots: number;
    interventions: number;
    metricPoints: number;
  };
  statsDaily: any[];
  adsDaily: any[];
  topListings: any[];
  recentEvents: any[];
  recentSnapshots: any[];
  interventions: any[];
  messages: { threads: number; messages: number };
}

const rows = async (q: Queryable, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows;

export async function getDashboardData(q: Queryable): Promise<DashboardData> {
  const [shops, captureTypes, totalsRaw, totalsEv, totalsSnap, totalsIv, totalsMt, statsDaily, adsDaily, topListings, recentEvents, recentSnapshots, interventions, msgThreads, msgMsgs] =
    await Promise.all([
      rows(q, `SELECT id, shop_tag, etsy_shop_id, vps_host FROM shops ORDER BY id`),
      rows(q, `SELECT capture_type, count(*)::int AS n,
                      sum(CASE WHEN parsed THEN 1 ELSE 0 END)::int AS parsed
               FROM raw_captures GROUP BY capture_type ORDER BY n DESC`),
      rows(q, `SELECT count(*)::int AS n,
                      sum(CASE WHEN parsed THEN 1 ELSE 0 END)::int AS parsed FROM raw_captures`),
      rows(q, `SELECT count(*)::int AS n FROM events`),
      rows(q, `SELECT count(*)::int AS n FROM listing_snapshots`),
      rows(q, `SELECT count(*)::int AS n FROM interventions`),
      rows(q, `SELECT count(*)::int AS n FROM metric_timeseries`),
      rows(q, `SELECT stat_date, visits, views, orders, revenue, currency, conversion_rate, traffic_sources
               FROM stats_daily ORDER BY stat_date DESC LIMIT 30`),
      rows(q, `SELECT stat_date, listing_id, clicks, impressions, spend, orders_from_ads, revenue_from_ads
               FROM ads_daily ORDER BY stat_date DESC, listing_id LIMIT 30`),
      rows(q, `SELECT listing_id, sum(revenue)::numeric AS revenue, sum(orders)::int AS orders, sum(visits)::int AS visits
               FROM listing_stats_daily GROUP BY listing_id ORDER BY sum(revenue) DESC LIMIT 15`),
      rows(q, `SELECT event_type, entity_id, occurred_at, origin, payload
               FROM events ORDER BY occurred_at DESC LIMIT 25`),
      rows(q, `SELECT listing_id, captured_at, state, price, num_images, title
               FROM listing_snapshots ORDER BY captured_at DESC LIMIT 20`),
      getInterventionLedger(q, 40),
      rows(q, `SELECT count(*)::int AS n FROM message_threads`),
      rows(q, `SELECT count(*)::int AS n FROM messages`),
    ]);

  const raw = totalsRaw[0] ?? { n: 0, parsed: 0 };
  return {
    generatedAt: new Date().toISOString(),
    shops,
    captureTypes,
    totals: {
      rawCaptures: raw.n,
      parsed: raw.parsed,
      unparsed: raw.n - raw.parsed,
      events: totalsEv[0]?.n ?? 0,
      snapshots: totalsSnap[0]?.n ?? 0,
      interventions: totalsIv[0]?.n ?? 0,
      metricPoints: totalsMt[0]?.n ?? 0,
    },
    statsDaily,
    adsDaily,
    topListings,
    recentEvents,
    recentSnapshots,
    interventions,
    messages: { threads: msgThreads[0]?.n ?? 0, messages: msgMsgs[0]?.n ?? 0 },
  };
}
