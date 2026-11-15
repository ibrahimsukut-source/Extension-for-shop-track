// Suggestion engine. Reads the latest collected Etsy Ads state and proposes
// changes; it NEVER executes them — the owner accepts a suggestion in the
// command center, which turns it into a job. Thresholds are deliberately
// conservative and configurable (RULES_CONFIG env, JSON).
import type { Queryable } from "../repository.js";

export interface RuleConfig {
  /** Listing spent at least this ($) with zero orders → suggest ad off. */
  zeroSaleSpendUsd: number;
  /** Listing spend at least this ($) and ROAS below lowRoas → suggest ad off. */
  lowRoasMinSpendUsd: number;
  lowRoas: number;
  /** Search query cost ≥ this ($), ≥ minClicks clicks, 0 orders → suggest marking irrelevant. */
  wastedQueryCostUsd: number;
  wastedQueryMinClicks: number;
  /** Shop ROAS ≥ this and budget used ≥ budgetCappedShare on ≥ budgetCappedDays of last 7 days → raise budget. */
  budgetRaiseMinRoas: number;
  budgetCappedShare: number;
  budgetCappedDays: number;
  /** Shop ROAS below this with ≥ budgetCutMinSpendUsd spend → cut budget. */
  budgetCutMaxRoas: number;
  budgetCutMinSpendUsd: number;
  /** Proposed budget step (fraction). */
  budgetStep: number;
}

export const DEFAULT_RULES: RuleConfig = {
  zeroSaleSpendUsd: 10,
  lowRoasMinSpendUsd: 20,
  lowRoas: 1.0,
  wastedQueryCostUsd: 3,
  wastedQueryMinClicks: 5,
  budgetRaiseMinRoas: 3,
  budgetCappedShare: 0.9,
  budgetCappedDays: 5,
  budgetCutMaxRoas: 1.2,
  budgetCutMinSpendUsd: 50,
  budgetStep: 0.25,
};

export function parseRuleConfig(raw: string | undefined): RuleConfig {
  if (!raw || !raw.trim()) return { ...DEFAULT_RULES };
  try {
    return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<RuleConfig>) };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

interface Proposal {
  rule: string;
  targetKey: string;
  kind: string;
  params: Record<string, unknown>;
  reason: string;
  evidence: Record<string, unknown>;
}

const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
const usd = (cents: number | null | undefined) => `$${((cents ?? 0) / 100).toFixed(2)}`;

export async function computeProposals(q: Queryable, shopTag: string, cfg: RuleConfig): Promise<Proposal[]> {
  const out: Proposal[] = [];
  const listings = (
    await q.query(`SELECT * FROM ads_listing_latest WHERE shop_tag = $1 AND is_promoted = true`, [shopTag])
  ).rows;
  for (const l of listings) {
    const spend = Number(l.spend_cents ?? 0);
    const orders = Number(l.orders ?? 0);
    const roas = l.roas == null ? null : Number(l.roas);
    const ev = {
      title: l.title,
      range: `${day(l.range_start)} – ${day(l.range_end)}`,
      spend: usd(spend),
      orders,
      roas,
      clicks: l.clicks,
      impressions: l.impressions,
    };
    if (orders === 0 && spend >= cfg.zeroSaleSpendUsd * 100) {
      out.push({
        rule: "ads.zero_sale_spend",
        targetKey: String(l.listing_id),
        kind: "ads.set_promoted",
        params: { listingIds: [Number(l.listing_id)], promoted: false },
        reason: `${usd(spend)} harcadı, 0 sipariş — reklamı kapat`,
        evidence: ev,
      });
    } else if (orders > 0 && roas !== null && roas < cfg.lowRoas && spend >= cfg.lowRoasMinSpendUsd * 100) {
      out.push({
        rule: "ads.low_roas",
        targetKey: String(l.listing_id),
        kind: "ads.set_promoted",
        params: { listingIds: [Number(l.listing_id)], promoted: false },
        reason: `ROAS ${roas.toFixed(2)} (${usd(spend)} harcama) — reklam zarar ettiriyor, kapat`,
        evidence: ev,
      });
    }
  }

  const queries = (
    await q.query(
      `SELECT q.*, l.title FROM ads_query_latest q LEFT JOIN ads_listing_latest l
         ON l.shop_tag = q.shop_tag AND l.listing_id = q.listing_id
       WHERE q.shop_tag = $1 AND q.is_relevant = true`,
      [shopTag]
    )
  ).rows;
  for (const qr of queries) {
    const cost = Number(qr.cost_cents ?? 0);
    if (Number(qr.orders ?? 0) === 0 && cost >= cfg.wastedQueryCostUsd * 100 && Number(qr.clicks ?? 0) >= cfg.wastedQueryMinClicks) {
      out.push({
        rule: "ads.wasted_query",
        targetKey: `${qr.listing_id}:${qr.query}`,
        kind: "ads.set_query_relevance",
        params: { items: [{ listingId: Number(qr.listing_id), query: qr.query, isRelevant: false }] },
        reason: `"${qr.query}" araması ${usd(cost)} harcadı, ${qr.clicks} tık, 0 sipariş — bu aramayı kapat`,
        evidence: { title: qr.title, query: qr.query, cost: usd(cost), clicks: qr.clicks, impressions: qr.impressions },
      });
    }
  }

  const camp = (await q.query(`SELECT * FROM ads_campaign_latest WHERE shop_tag = $1`, [shopTag])).rows[0];
  if (camp && camp.budget_cents && camp.is_active !== false) {
    const totals = camp.totals ?? {};
    const spend = Number(totals.spentTotal ?? 0);
    const revenue = Number(totals.revenue ?? 0);
    const roas = spend > 0 ? revenue / spend : null;
    const daily: Array<{ spendCents: number | null }> = Array.isArray(camp.daily) ? camp.daily : [];
    const last7 = daily.slice(-8, -1); // complete days only
    const cappedDays = last7.filter((d) => (d.spendCents ?? 0) >= camp.budget_cents * cfg.budgetCappedShare).length;
    const budgetUsd = camp.budget_cents / 100;
    if (roas !== null && roas >= cfg.budgetRaiseMinRoas && cappedDays >= cfg.budgetCappedDays) {
      const next = Math.round(budgetUsd * (1 + cfg.budgetStep));
      out.push({
        rule: "ads.budget_capped",
        targetKey: "campaign",
        kind: "ads.set_budget",
        params: { dailyBudgetUsd: next },
        reason: `ROAS ${roas.toFixed(2)} ve bütçe son 7 günün ${cappedDays}'inde doldu — bütçeyi $${budgetUsd} → $${next} yap`,
        evidence: { roas, cappedDays, budget: budgetUsd, spend: usd(spend), revenue: usd(revenue) },
      });
    } else if (roas !== null && roas < cfg.budgetCutMaxRoas && spend >= cfg.budgetCutMinSpendUsd * 100) {
      const next = Math.max(1, Math.round(budgetUsd * (1 - cfg.budgetStep)));
      out.push({
        rule: "ads.budget_cut",
        targetKey: "campaign",
        kind: "ads.set_budget",
        params: { dailyBudgetUsd: next },
        reason: `Mağaza ROAS ${roas.toFixed(2)} (${usd(spend)} harcama) — bütçeyi $${budgetUsd} → $${next} düşür`,
        evidence: { roas, budget: budgetUsd, spend: usd(spend), revenue: usd(revenue) },
      });
    }
  }
  return out;
}

/** Recompute suggestions for a shop: upsert open ones, expire those no longer true. */
export async function refreshSuggestions(q: Queryable, shopTag: string, cfg: RuleConfig): Promise<{ open: number; added: number; expired: number }> {
  const proposals = await computeProposals(q, shopTag, cfg);
  const open = (await q.query(`SELECT id, rule, target_key FROM suggestions WHERE shop_tag = $1 AND status = 'open'`, [shopTag])).rows;
  const openKey = new Map(open.map((s: any) => [`${s.rule}|${s.target_key}`, s.id as number]));
  const keep = new Set<string>();
  let added = 0;
  for (const p of proposals) {
    const k = `${p.rule}|${p.targetKey}`;
    keep.add(k);
    const id = openKey.get(k);
    if (id) {
      await q.query(`UPDATE suggestions SET params = $2::jsonb, reason = $3, evidence = $4::jsonb WHERE id = $1`, [
        id,
        JSON.stringify(p.params),
        p.reason,
        JSON.stringify(p.evidence),
      ]);
    } else {
      // Don't re-suggest something the owner dismissed in the last 14 days.
      const dismissed = await q.query(
        `SELECT 1 FROM suggestions WHERE shop_tag = $1 AND rule = $2 AND target_key = $3 AND status = 'dismissed'
           AND decided_at > now() - interval '14 days' LIMIT 1`,
        [shopTag, p.rule, p.targetKey]
      );
      if (dismissed.rows.length) continue;
      await q.query(
        `INSERT INTO suggestions (shop_tag, rule, target_key, kind, params, reason, evidence)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [shopTag, p.rule, p.targetKey, p.kind, JSON.stringify(p.params), p.reason, JSON.stringify(p.evidence)]
      );
      added++;
    }
  }
  let expired = 0;
  for (const [k, id] of openKey) {
    if (keep.has(k)) continue;
    await q.query(`UPDATE suggestions SET status = 'expired', decided_at = now() WHERE id = $1`, [id]);
    expired++;
  }
  return { open: keep.size, added, expired };
}
