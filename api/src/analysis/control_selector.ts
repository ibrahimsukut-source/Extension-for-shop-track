// Matched-control selection (spec §7 control_selector). For a treated listing,
// finds sibling listings in the same shop section with a similar price that
// had NO intervention of their own in the comparison window — a rough but
// honest counterfactual: "what happened to comparable products I didn't touch".
//
// v1 simplification: "same section" is matched against ANY snapshot's
// section_id (not necessarily the one as-of occurredAt) — a listing that moved
// sections at some point can still surface as a sibling. Good enough for a
// single-shop tool with a handful of sections; worth tightening once sections
// get their own change history.
import type { Queryable } from "../repository.js";
import { addDays } from "./dates.js";

export interface ControlCandidate {
  controlEntity: string;
  matchScore: number;
  matchReason: Record<string, unknown>;
}

async function latestSnapshotAsOf(
  q: Queryable,
  shopId: number,
  listingId: number,
  asOf: string
): Promise<{ price: number | null; sectionId: number | null } | null> {
  const res = await q.query(
    `SELECT price, section_id FROM listing_snapshots
      WHERE shop_id=$1 AND listing_id=$2 AND captured_at <= $3
      ORDER BY captured_at DESC LIMIT 1`,
    [shopId, listingId, asOf]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    sectionId: r.section_id === null || r.section_id === undefined ? null : Number(r.section_id),
  };
}

/**
 * Find (and persist) up to `maxControls` control listings for `treatedListingId`.
 * Idempotent per treated listing: if control_assignments already has rows for
 * it, those are returned as-is rather than recomputed — keeps this cheap to
 * call on every parse pass and keeps one stable control set per listing
 * rather than a different one per intervention.
 */
export async function selectControls(
  q: Queryable,
  shopId: number,
  treatedListingId: number,
  occurredAt: string,
  opts: { windowDays?: number; maxControls?: number } = {}
): Promise<ControlCandidate[]> {
  const windowDays = opts.windowDays ?? 14;
  const maxControls = opts.maxControls ?? 3;
  const treatedKey = String(treatedListingId);

  const existing = await q.query(
    `SELECT control_entity, match_score, match_reason FROM control_assignments
      WHERE shop_id=$1 AND treated_entity=$2`,
    [shopId, treatedKey]
  );
  if (existing.rows.length > 0) {
    return existing.rows.map((r) => ({
      controlEntity: String(r.control_entity),
      matchScore: Number(r.match_score),
      matchReason: r.match_reason ?? {},
    }));
  }

  const treated = await latestSnapshotAsOf(q, shopId, treatedListingId, occurredAt);
  if (!treated || treated.sectionId === null || treated.price === null) return [];

  const cand = await q.query(
    `SELECT DISTINCT listing_id FROM listing_snapshots WHERE shop_id=$1 AND listing_id<>$2 AND section_id=$3`,
    [shopId, treatedListingId, treated.sectionId]
  );

  const day0 = occurredAt.slice(0, 10);
  const from = addDays(day0, -windowDays);
  const to = addDays(day0, windowDays);

  const scored: ControlCandidate[] = [];
  for (const row of cand.rows) {
    const candidateId = Number(row.listing_id);
    const snap = await latestSnapshotAsOf(q, shopId, candidateId, occurredAt);
    if (!snap || snap.price === null) continue;

    // Exclude candidates that had their own intervention in the comparison
    // window — a moving counterfactual is not a control.
    const ivCount = await q.query(
      `SELECT count(*)::int AS n FROM interventions
        WHERE shop_id=$1 AND entity_type='listing' AND entity_id=$2
          AND occurred_at >= $3 AND occurred_at <= $4`,
      [shopId, String(candidateId), from, to]
    );
    if ((ivCount.rows[0]?.n ?? 0) > 0) continue;

    const priceDiff = Math.abs(snap.price - treated.price);
    const matchScore = 1 / (1 + priceDiff / Math.max(treated.price, 1));
    scored.push({
      controlEntity: String(candidateId),
      matchScore,
      matchReason: { sectionId: treated.sectionId, treatedPrice: treated.price, controlPrice: snap.price },
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  const top = scored.slice(0, maxControls);
  for (const c of top) {
    await q.query(
      `INSERT INTO control_assignments (treated_entity, control_entity, shop_id, match_score, match_reason)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [treatedKey, c.controlEntity, shopId, c.matchScore, JSON.stringify(c.matchReason)]
    );
  }
  return top;
}
