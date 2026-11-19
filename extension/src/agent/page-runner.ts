// Page runner — executes one command-center job inside an Etsy Shop Manager tab,
// using the seller's own session.
//
// RULE #1 (never break): nothing Etsy's own JavaScript can observe may differ
// from a normal seller browser, and nothing may be identical across shops.
// So this runs in the extension's ISOLATED world (or the USER_SCRIPT world for
// remote modules): the page cannot see our globals, our fetch calls are not
// routed through the page's (possibly instrumented) window.fetch, and we never
// touch page objects. Etsy.Context is read by parsing the page's own inline
// <script> text, not via window.Etsy. Pacing, page sizes and order of calls are
// randomized per run so no two shops share a request rhythm.
//
// Self-contained on purpose (no imports): the same bundle is
//   1. shipped inside the extension (built-in fallback), and
//   2. served by the command center as a signed remote module, so collection
//      and action logic can be fixed/extended WITHOUT reinstalling the extension.
// It installs `globalThis.__ocAgent = { version, run(job) }`.
//
// Safety: only the job kinds below exist; every write is followed by a re-read
// to verify it really happened; anything that looks like a block page / captcha
// / rate limit stops the job immediately (no retries hammering Etsy).

import { RUNNER_VERSION } from "./version.js";

type Json = any;

interface Job {
  id: number;
  kind: string;
  params: Record<string, any>;
  /** The shop the command center means. The job does nothing in any other shop. */
  expect?: { shopName?: string | null; shopId?: number | string | null };
}

interface RunOutcome {
  ok: boolean;
  result?: Json;
  error?: string;
  /** Machine-readable failure class the background acts on. */
  code?: "not_logged_in" | "blocked" | "wrong_page" | "wrong_shop" | "unsupported" | "error";
}

class AgentError extends Error {
  constructor(public code: RunOutcome["code"], message: string) {
    super(message);
  }
}

const W = globalThis as any;

/** Extract the JSON object literal starting at `start` (string-aware brace matching). */
function sliceObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Rebuild Etsy.Context from the page's inline scripts. Etsy uses two forms:
 *   Etsy.Context = {...};                                  (whole object)
 *   Etsy.Context.data = assign(Etsy.Context.data ? … : {}, {...});   (merge)
 */
export function parseEtsyContext(scripts: string[]): Json {
  const ctxObj: Record<string, Json> = {};
  const re = /Etsy\.Context(?:\.(\w+))?\s*=\s*(?!Etsy\.Context\s*\|\|)/g;
  for (const text of scripts) {
    if (!text.includes("Etsy.Context")) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // The JSON payload is the first object literal whose first key is a string.
      let i = m.index + m[0].length;
      let found = -1;
      for (let guard = 0; guard < 400 && i < text.length; guard++) {
        const j = text.indexOf("{", i);
        if (j < 0 || j - (m.index + m[0].length) > 400) break;
        if (/^\{\s*"/.test(text.slice(j, j + 40))) {
          found = j;
          break;
        }
        i = j + 1;
      }
      if (found < 0) continue;
      const raw = sliceObject(text, found);
      if (!raw) continue;
      let obj: Json;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (m[1]) ctxObj[m[1]] = Object.assign(ctxObj[m[1]] ?? {}, obj);
      else for (const [k, v] of Object.entries(obj)) ctxObj[k] = k === "data" && ctxObj.data ? Object.assign(ctxObj.data, v) : v;
      re.lastIndex = found + raw.length;
    }
  }
  return ctxObj;
}

let ctxCache: Json = null;
function ctx() {
  if (!ctxCache) {
    const scripts = Array.from(document.querySelectorAll("script:not([src])"), (s) => s.textContent ?? "");
    ctxCache = parseEtsyContext(scripts);
  }
  const d = ctxCache?.data;
  if (!d) {
    if (/\/signin/.test(location.pathname)) throw new AgentError("not_logged_in", "Etsy oturumu kapalı");
    throw new AgentError("wrong_page", "Etsy.Context bulunamadı");
  }
  if (!d.shop_id) throw new AgentError("not_logged_in", "Shop Manager oturumu yok (shop_id boş)");
  return d;
}

function locale(d: Json): string {
  const ls = d.locale_settings ?? {};
  const cur = ls.currency?.code ?? "USD";
  const lang = ls.language?.code ?? "en-US";
  const region = ls.region?.code ?? ls.region ?? "US";
  return `${cur}|${lang}|${typeof region === "string" ? region : "US"}`;
}

function csrf(): string {
  const m = document.querySelector('meta[name="csrf_nonce"]') as HTMLMetaElement | null;
  if (!m?.content) throw new AgentError("not_logged_in", "csrf_nonce yok");
  return m.content;
}

/**
 * Etsy's own front end receives these responses camelCased (graphStats,
 * listingId…), but a plain fetch gets snake_case (graph_stats, listing_id…).
 * Normalize to camelCase so everything downstream sees one shape — the same
 * one the passive interceptor and the existing parsers already handle.
 */
export function camelize(v: Json): Json {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(v)) {
      // Numeric keys (listing-id maps) stay as they are.
      const key = /^\d+$/.test(k) ? k : k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
      out[key] = camelize(val);
    }
    return out;
  }
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Per-run tempo: each run (and so each shop) gets its own speed and rhythm.
const TEMPO = 0.7 + Math.random() * 0.9;
const jitter = (min: number, max: number) => sleep((min + Math.random() * (max - min)) * TEMPO);
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const PAGE_SIZE = pick([25, 30, 40, 50, 60, 75, 100]);

function qs(q?: Record<string, unknown>): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

interface Caller {
  shopId: number;
  get(path: string, q?: Record<string, unknown>): Promise<Json>;
  /** GET, normalized to camelCase (stats, listings, campaign). */
  getC(path: string, q?: Record<string, unknown>): Promise<Json>;
  write(method: "POST" | "PUT", path: string, body: Json): Promise<{ status: number; body: Json; url: string }>;
  requests: number;
}

function caller(d: Json): Caller {
  const shopId = Number(d.shop_id);
  const base = (path: string) => (path.startsWith("/api/") ? path : `/api/v3/ajax/shop/${shopId}${path}`);
  const c: Caller = {
    shopId,
    requests: 0,
    async get(path, q) {
      c.requests++;
      const res = await fetch(base(path) + qs(q), {
        credentials: "same-origin",
        headers: { accept: "application/json", "x-detected-locale": locale(d) },
      });
      return parse(res, path);
    },
    async getC(path, q) {
      return camelize(await c.get(path, q));
    },
    async write(method, path, body) {
      c.requests++;
      const res = await fetch(base(path), {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf(),
          "x-detected-locale": locale(d),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await parse(res, path), url: base(path) };
    },
  };
  return c;
}

async function parse(res: Response, path: string): Promise<Json> {
  if (res.status === 401) throw new AgentError("not_logged_in", `${path}: 401`);
  if (res.status === 403 || res.status === 429) throw new AgentError("blocked", `${path}: HTTP ${res.status} — Etsy isteği engelledi, iş durduruldu`);
  const text = await res.text();
  let body: Json;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new AgentError("blocked", `${path}: JSON olmayan yanıt (captcha / engel sayfası olabilir)`);
  }
  if (!res.ok) throw new AgentError("error", `${path}: HTTP ${res.status} ${typeof body?.error === "string" ? body.error : ""}`.trim());
  return body;
}

// ── Dates (Etsy Ads reports in US Eastern) ────────────────────────────────
function etDay(offset = 0): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, dd] = fmt.format(new Date()).split("-").map(Number);
  return fmt.format(new Date(Date.UTC(y, m - 1, dd + offset, 12)));
}
function range(key: string): { start: string; end: string } {
  const today = etDay(0);
  switch (key) {
    case "today": return { start: today, end: today };
    case "yesterday": return { start: etDay(-1), end: etDay(-1) };
    case "last_7": return { start: etDay(-6), end: today };
    case "this_month": return { start: `${today.slice(0, 8)}01`, end: today };
    case "this_year": return { start: `${today.slice(0, 4)}-01-01`, end: today };
    case "last_month": {
      const [y, m] = today.split("-").map(Number);
      const first = new Date(Date.UTC(y, m - 2, 1, 12)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(y, m - 1, 0, 12)).toISOString().slice(0, 10);
      return { start: first, end: last };
    }
    default: return { start: etDay(-30), end: today };
  }
}
function prevRange(r: { start: string; end: string }): { start: string; end: string } {
  const s = Date.parse(`${r.start}T12:00:00Z`);
  const e = Date.parse(`${r.end}T12:00:00Z`);
  const days = Math.round((e - s) / 864e5);
  const pe = new Date(s);
  const ps = new Date(s - days * 864e5);
  return { start: ps.toISOString().slice(0, 10), end: pe.toISOString().slice(0, 10) };
}
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

// ── Collection ────────────────────────────────────────────────────────────
async function allListingStats(c: Caller, r: { start: string; end: string }, isPromoted: boolean, cap = 6000): Promise<Json[]> {
  const out: Json[] = [];
  const limit = PAGE_SIZE;
  for (let offset = 0; offset < cap; ) {
    const page = await c.getC("/prolist/stats/listings", {
      start_date: r.start,
      end_date: r.end,
      sort_type: "impression_count",
      sort_order: "desc",
      offset,
      limit,
      is_promoted: isPromoted,
    });
    const rows: Json[] = Array.isArray(page?.listings) ? page.listings : [];
    out.push(...rows);
    const total = Number(page?.filteredListingCount ?? 0);
    offset += rows.length;
    if (!rows.length || (total && offset >= total)) break;
    await jitter(400, 1100);
  }
  return out;
}

async function collectAds(c: Caller, d: Json, p: Json): Promise<Json> {
  const r = range(p.range ?? "last_30");
  const pr = prevRange(r);
  const init = d.initial_data?.etsyAds ?? {};
  const campaign = await c.getC("/prolist/campaign");
  await jitter(300, 800);
  const shopStats = await c.getC("/prolist/stats", {
    start_date: r.start,
    end_date: r.end,
    comparison_start_date: pr.start,
    comparison_end_date: pr.end,
  });
  await jitter(300, 800);
  // Order varies run to run.
  let promoted: Json[];
  let notPromoted: Json[];
  if (Math.random() < 0.5) {
    promoted = await allListingStats(c, r, true);
    await jitter(400, 1000);
    notPromoted = await allListingStats(c, r, false);
  } else {
    notPromoted = await allListingStats(c, r, false);
    await jitter(400, 1000);
    promoted = await allListingStats(c, r, true);
  }
  const seen = new Set<number>();
  const listings = [...promoted, ...notPromoted].filter((e) => {
    const id = Number(e?.listing?.listingId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  let yesterday: Json = null;
  if (p.yesterdayPerListing !== false) {
    const y = range("yesterday");
    await jitter(400, 1000);
    yesterday = { date: y.start, listings: await allListingStats(c, y, true) };
  }

  const queries: Record<string, Json[]> = {};
  const topN = Number(p.queryTopN ?? 60);
  if (p.queries !== false && topN > 0) {
    const top = listings
      .filter((e) => Number(e?.totalStats?.spentTotal ?? 0) > 0 || Number(e?.totalStats?.impressionCount ?? 0) > 0)
      .sort((a, b) => Number(b.totalStats?.spentTotal ?? 0) - Number(a.totalStats?.spentTotal ?? 0))
      .slice(0, topN);
    for (const e of top) {
      await jitter(500, 1300);
      const id = Number(e.listing.listingId);
      const qsr = await c.get(`/prolist/listings/querystats/${id}`, {
        start_date: mdy(r.start),
        end_date: mdy(r.end),
        sort_type: "stemmed_query",
        sort_order: 1,
      });
      queries[String(id)] = Array.isArray(qsr?.query_stats) ? qsr.query_stats : [];
    }
  }

  return {
    shop: { id: c.shopId, name: d.shop_name, currency: "USD" },
    range: r,
    campaign,
    minBudgetCents: init.campaignMinBudget?.budgetInCents ?? null,
    maxBudgetCents: init.campaignMaxBudget?.budgetInCents ?? null,
    promotedCount: init.promotedListingsCount ?? promoted.length,
    freshness: init.etsyadsMetricsFreshness ?? null,
    shopStats,
    listings,
    yesterday,
    queries,
    requests: c.requests,
  };
}

function collectShopStats(d: Json, p: Json): Json {
  const I = d.initial_data ?? {};
  if (!I.metrics_summary) throw new AgentError("wrong_page", "Stats sayfası verisi yok (metrics_summary)");
  const tb = I.traffic_breakdown ?? {};
  const sources = [...(tb.etsy_traffic?.traffic_sources ?? []), ...(tb.user_traffic?.traffic_sources ?? [])].map((s: Json) => ({
    key: s.short_key ?? s.source_key,
    name: s.display_name,
    visits: s.visits,
    yoy: s.year_over_year_metrics?.yoy_percentage_display_string ?? null,
    sub: (s.sub_traffic_sources ?? []).map((x: Json) => ({ key: x.short_key ?? x.source_key, name: x.display_name, visits: x.visits })),
  }));
  return {
    rangeKey: I.selected_date_range?.key ?? p.range,
    startDate: I.start_date,
    endDate: I.end_date,
    metrics: I.metrics_summary,
    traffic: { etsyShare: tb.etsy_traffic?.subtitle ?? null, userShare: tb.user_traffic?.subtitle ?? null, sources },
    topListings: (I.listings?.listings ?? []).map((l: Json) => ({
      id: l.id,
      title: l.title,
      visits: l.visits,
      orders: l.orders,
      revenue: l.revenue,
      favorites: l.favorites,
    })),
    listingCount: I.listings?.pagination?.total_count ?? null,
    offsiteAds: { status: I.offsite_ads_status ?? null, feeRate: I.offsite_fee_rate ?? null },
  };
}

// ── Actions (each verified by re-reading) ─────────────────────────────────
async function setPromoted(c: Caller, p: Json): Promise<Json> {
  const ids: number[] = p.listingIds.map(Number);
  const want = Boolean(p.promoted);
  const actions: Json[] = [];
  const captures: Json[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const before: Record<string, boolean | null> = {};
    if (ids.length <= 50) {
      for (const id of chunk) {
        const s = await c.getC(`/prolist/stats/listings/${id}`, { start_date: range("today").start, end_date: range("today").end });
        before[id] = typeof s?.listing?.isPromoted === "boolean" ? s.listing.isPromoted : null;
        await jitter(250, 600);
      }
    }
    const res = await c.write("POST", "/prolist/listings", { listings: Object.fromEntries(chunk.map((id) => [String(id), want])) });
    captures.push({ url: res.url, status: res.status, body: res.body });
    const got = res.body?.listings ?? {};
    for (const id of chunk) {
      actions.push({
        action: "ads.set_promoted",
        target: String(id),
        before: { promoted: before[id] ?? null },
        after: { promoted: typeof got[String(id)] === "boolean" ? got[String(id)] : null },
        verified: got[String(id)] === want,
      });
    }
    await jitter(800, 1600);
  }
  // Independent re-read of one listing (guards against a response that lies).
  if (ids.length) {
    const s = await c.getC(`/prolist/stats/listings/${ids[0]}`, { start_date: range("today").start, end_date: range("today").end });
    const first = actions.find((a) => a.target === String(ids[0]));
    if (first && typeof s?.listing?.isPromoted === "boolean" && s.listing.isPromoted !== want) first.verified = false;
  }
  return { actions, captures };
}

async function setQueryRelevance(c: Caller, p: Json): Promise<Json> {
  const actions: Json[] = [];
  const captures: Json[] = [];
  const r = range("last_30");
  const fetchStats = async (id: number) => {
    const s = await c.get(`/prolist/listings/querystats/${id}`, { start_date: mdy(r.start), end_date: mdy(r.end), sort_type: "stemmed_query", sort_order: 1 });
    return (Array.isArray(s?.query_stats) ? s.query_stats : []) as Json[];
  };
  for (const it of p.items as Json[]) {
    const id = Number(it.listingId);
    const before = (await fetchStats(id)).find((q) => q.stemmed_query === it.query);
    await jitter(300, 700);
    const res = await c.write("POST", "/prolist/listing-query", { listing_id: id, query: it.query, is_relevant: Boolean(it.isRelevant) });
    captures.push({ url: res.url, status: res.status, body: res.body });
    await jitter(600, 1200);
    const after = (await fetchStats(id)).find((q) => q.stemmed_query === it.query);
    actions.push({
      action: "ads.set_query_relevance",
      target: `${id}:${it.query}`,
      before: { isRelevant: before?.is_relevant ?? null },
      after: { isRelevant: after?.is_relevant ?? null },
      verified: after ? after.is_relevant === Boolean(it.isRelevant) : null,
    });
    await jitter(500, 1200);
  }
  return { actions, captures };
}

/** Request format of the budget call is not verified live yet: the command
 *  center blocks this job until it is (BUDGET_WRITE_ENABLED). The value is
 *  sent in cents, matching every amount Etsy returns, and the result is
 *  re-read; a mismatch is reported as unverified. */
async function setBudget(c: Caller, p: Json): Promise<Json> {
  const cents = Math.round(Number(p.dailyBudgetUsd) * 100);
  const before = await c.getC("/prolist/campaign");
  const res = await c.write("PUT", "/prolist/campaign-budget", { budget: cents });
  await jitter(800, 1500);
  const after = await c.getC("/prolist/campaign");
  return {
    actions: [
      {
        action: "ads.set_budget",
        target: "campaign",
        before: { budgetCents: before?.totalDailyBudget ?? null },
        after: { budgetCents: after?.totalDailyBudget ?? null },
        verified: after?.totalDailyBudget === cents,
      },
    ],
    captures: [{ url: res.url, status: res.status, body: res.body }],
  };
}

export async function run(job: Job): Promise<RunOutcome> {
  try {
    const d = ctx();
    const c = caller(d);
    // Safety: never collect or change anything in a shop other than the one meant.
    const e = job.expect;
    if (e && job.kind !== "probe") {
      const nameOk = !e.shopName || String(e.shopName).toLowerCase() === String(d.shop_name ?? "").toLowerCase();
      const idOk = !e.shopId || String(e.shopId) === String(c.shopId);
      if (!nameOk || !idOk) {
        return { ok: false, code: "wrong_shop", error: `Bu Chrome'da ${d.shop_name} açık, iş ${e.shopName} için — hiçbir şey yapılmadı` };
      }
    }
    switch (job.kind) {
      case "probe":
        return { ok: true, result: { shopId: c.shopId, shopName: d.shop_name, path: location.pathname } };
      case "collect.ads":
        return { ok: true, result: await collectAds(c, d, job.params) };
      case "collect.shop_stats":
        return { ok: true, result: collectShopStats(d, job.params) };
      case "ads.set_promoted":
        return { ok: true, result: await setPromoted(c, job.params) };
      case "ads.set_query_relevance":
        return { ok: true, result: await setQueryRelevance(c, job.params) };
      case "ads.set_budget":
        return { ok: true, result: await setBudget(c, job.params) };
      default:
        return { ok: false, code: "unsupported", error: `bilinmeyen iş: ${job.kind}` };
    }
  } catch (e) {
    const err = e as AgentError;
    return { ok: false, code: err.code ?? "error", error: String(err.message ?? e) };
  }
}

// Lives only in the extension's isolated world — invisible to Etsy's scripts.
W.__ocAgent = { version: RUNNER_VERSION, run };
