// Job catalog: every job the command center can send to a shop's agent, with
// its parameter schema and safety rules. The agent implements the same kinds
// (extension/src/agent/jobs.ts). Anything not listed here is rejected — the
// agent never runs free-form instructions.
import { z } from "zod";

export const RANGE_KEYS = ["today", "yesterday", "last_7", "last_30", "this_month", "last_month", "this_year"] as const;
const rangeKey = z.enum(RANGE_KEYS);

const listingId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((v) => Number(v));

export const JOB_PARAMS = {
  /** Etsy Ads: campaign + shop-level daily stats + every listing's ad stats
   *  for the range, optionally keyword (search query) stats for top listings. */
  "collect.ads": z.object({
    range: rangeKey.default("last_30"),
    queries: z.boolean().default(true),
    /** Keyword stats for the N listings with the most spend in the range. */
    queryTopN: z.number().int().min(0).max(300).default(60),
    /** Also pull yesterday's per-listing totals (feeds the daily analytics). */
    yesterdayPerListing: z.boolean().default(true),
  }),
  /** Shop Stats page: visits/orders/revenue/conversion, traffic sources, top listings. */
  "collect.shop_stats": z.object({
    range: rangeKey.default("last_30"),
  }),
  /** Turn Etsy Ads on/off for listings. */
  "ads.set_promoted": z.object({
    listingIds: z.array(listingId).min(1).max(500),
    promoted: z.boolean(),
  }),
  /** Mark a search query relevant / irrelevant (stop showing the ad for it). */
  "ads.set_query_relevance": z.object({
    items: z
      .array(z.object({ listingId, query: z.string().min(1).max(200), isRelevant: z.boolean() }))
      .min(1)
      .max(200),
  }),
  /** Daily Etsy Ads budget, in US dollars. */
  "ads.set_budget": z.object({
    dailyBudgetUsd: z.number().positive().max(10000),
  }),
} as const;

export type JobKind = keyof typeof JOB_PARAMS;
export const JOB_KINDS = Object.keys(JOB_PARAMS) as JobKind[];

export function isJobKind(k: string): k is JobKind {
  return Object.prototype.hasOwnProperty.call(JOB_PARAMS, k);
}

/** Jobs that change something on Etsy (vs. read-only collection). */
export function isWriteJob(kind: string): boolean {
  return kind.startsWith("ads.");
}

export interface SafetyLimits {
  maxDailyBudgetUsd: number;
  /** Budget writes stay blocked until the request format is confirmed live. */
  budgetWriteEnabled: boolean;
  maxListingsPerToggle: number;
}

export const DEFAULT_LIMITS: SafetyLimits = {
  maxDailyBudgetUsd: 100,
  budgetWriteEnabled: false,
  maxListingsPerToggle: 200,
};

export type ValidationResult =
  | { ok: true; kind: JobKind; params: Record<string, unknown> }
  | { ok: false; error: string };

export function validateJob(kind: string, rawParams: unknown, limits: SafetyLimits): ValidationResult {
  if (!isJobKind(kind)) return { ok: false, error: `unknown job kind: ${kind}` };
  const parsed = JOB_PARAMS[kind].safeParse(rawParams ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const params = parsed.data as Record<string, unknown>;
  if (kind === "ads.set_budget") {
    if (!limits.budgetWriteEnabled) {
      return { ok: false, error: "budget changes are disabled until the Etsy request format is verified (BUDGET_WRITE_ENABLED)" };
    }
    if ((params.dailyBudgetUsd as number) > limits.maxDailyBudgetUsd) {
      return { ok: false, error: `daily budget above safety cap ($${limits.maxDailyBudgetUsd})` };
    }
  }
  if (kind === "ads.set_promoted" && (params.listingIds as number[]).length > limits.maxListingsPerToggle) {
    return { ok: false, error: `too many listings in one toggle (max ${limits.maxListingsPerToggle})` };
  }
  return { ok: true, kind, params };
}

/** Date range for a range key, as YYYY-MM-DD strings, in the given IANA timezone. */
export function rangeDates(key: string, now = new Date(), tz = "America/New_York"): { start: string; end: string } {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = fmt(now);
  const [y, m, d] = today.split("-").map(Number);
  const day = (offset: number) => fmt(new Date(Date.UTC(y, m - 1, d + offset, 12)));
  switch (key) {
    case "today": return { start: today, end: today };
    case "yesterday": return { start: day(-1), end: day(-1) };
    case "last_7": return { start: day(-6), end: today };
    case "this_month": return { start: `${today.slice(0, 8)}01`, end: today };
    case "last_month": {
      const first = new Date(Date.UTC(y, m - 2, 1, 12));
      const last = new Date(Date.UTC(y, m - 1, 0, 12));
      return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
    }
    case "this_year": return { start: `${y}-01-01`, end: today };
    case "last_30":
    // Matches Etsy Ads' own "Last 30 days" (e.g. Oct 16 – Nov 15 on Nov 15 ET).
    default: return { start: day(-30), end: today };
  }
}
