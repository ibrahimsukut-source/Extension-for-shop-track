// Parse runner (Phase 3): drains unparsed raw_captures, dispatches each to its
// parser, upserts normalized rows, derives events from listing snapshot diffs,
// and marks the capture parsed. Idempotent and re-runnable (spec §3, §11).
import { makeDedupKey } from "../lib/dedup.js";
import { insertEvent, withTransaction, type Pool, type Queryable } from "../repository.js";
import { getParser, PARSERS } from "../parsers/index.js";
import type { ParseOutput } from "../parsers/types.js";
import { diffSnapshots } from "./diff.js";
import { detectListingInterventions, type Intervention } from "../analysis/interventions.js";
import { buildMetricTimeseries, countMetricPoints, upsertIntervention } from "../analysis/repository.js";
import {
  getLatestSnapshotBefore,
  getUnparsedCaptures,
  insertListingSnapshot,
  markParsed,
  upsertAdsDaily,
  upsertListingStatsDaily,
  upsertOrder,
  upsertReview,
  upsertMessageThread,
  upsertStatsDaily,
} from "../parsed_repository.js";

export interface ParseSummary {
  captures: number;
  snapshots: number;
  derivedEvents: number;
  interventions: number;
  metricPoints: number;
  statsDays: number;
  adsDays: number;
  orders: number;
  reviews: number;
  messageThreads: number;
}

const emptySummary = (): ParseSummary => ({
  captures: 0,
  snapshots: 0,
  derivedEvents: 0,
  interventions: 0,
  metricPoints: 0,
  statsDays: 0,
  adsDays: 0,
  orders: 0,
  reviews: 0,
  messageThreads: 0,
});

async function applyOutput(
  q: Queryable,
  shopId: number,
  capturedAt: string,
  out: ParseOutput,
  summary: ParseSummary
): Promise<void> {
  for (const r of out.statsDaily ?? []) {
    await upsertStatsDaily(q, shopId, capturedAt, r);
    summary.statsDays++;
  }
  for (const r of out.listingStatsDaily ?? []) await upsertListingStatsDaily(q, shopId, r);
  for (const r of out.adsDaily ?? []) {
    await upsertAdsDaily(q, shopId, r);
    summary.adsDays++;
  }
  // Ad on/off toggle -> intervention directly (no snapshot diff needed: the
  // mutation response itself names the new state). Ad-level taxonomy §4.
  for (const r of out.adToggles ?? []) {
    const iv: Intervention = {
      interventionType: r.isAdvertised ? "etsy_ads_on" : "etsy_ads_off",
      entityType: "listing",
      entityId: String(r.listingId),
      occurredAt: capturedAt,
      beforeValue: null,
      afterValue: r.isAdvertised,
      magnitude: null,
      source: "interception",
      confidence: 0.95,
    };
    if (await upsertIntervention(q, shopId, iv)) summary.interventions++;
  }
  for (const r of out.orders ?? []) {
    await upsertOrder(q, shopId, r);
    summary.orders++;
  }
  for (const r of out.reviews ?? []) {
    await upsertReview(q, shopId, r);
    summary.reviews++;
  }
  for (const t of out.messageThreads ?? []) {
    await upsertMessageThread(q, shopId, t);
    summary.messageThreads++;
  }

  // Listing snapshots + snapshot-diff derived events.
  for (const snap of out.listingSnapshots ?? []) {
    const prior = await getLatestSnapshotBefore(q, shopId, snap.listingId, capturedAt);
    const inserted = await insertListingSnapshot(q, shopId, capturedAt, snap);
    if (!inserted) continue; // duplicate instant -> don't re-diff
    summary.snapshots++;
    if (!prior) continue; // first snapshot -> nothing to diff against

    for (const ev of diffSnapshots(prior, snap, capturedAt)) {
      const dedupKey = makeDedupKey({
        shopId: String(shopId),
        captureType: `event:${ev.eventType}`,
        key: ev.entityId,
        body: JSON.stringify(ev.payload),
        capturedAtMs: Date.parse(ev.occurredAt),
      });
      const stored = await insertEvent(q, {
        shopId,
        eventType: ev.eventType,
        entityType: ev.entityType,
        entityId: ev.entityId,
        actor: null,
        origin: "snapshot_diff",
        occurredAt: ev.occurredAt,
        payload: ev.payload,
        dedupKey,
      });
      if (stored) summary.derivedEvents++;
    }

    // Promote the same diff to first-class interventions for the causal engine.
    for (const iv of detectListingInterventions(prior, snap, capturedAt)) {
      if (await upsertIntervention(q, shopId, iv)) summary.interventions++;
    }
  }
}

/** Process one batch of unparsed captures. Returns how many were handled. */
export async function parseBatch(pool: Pool, batchSize = 100): Promise<ParseSummary> {
  const summary = emptySummary();
  const captures = await getUnparsedCaptures(pool, Object.keys(PARSERS), batchSize);

  for (const cap of captures) {
    const parser = getParser(cap.captureType);
    if (!parser) continue;
    try {
      await withTransaction(pool, async (c) => {
        const out = parser(cap.body, { shopId: cap.shopId, capturedAt: cap.capturedAt });
        await applyOutput(c, cap.shopId, cap.capturedAt, out, summary);
        await markParsed(c, cap.id);
      });
      summary.captures++;
    } catch (err) {
      // Leave parsed=false so a fixed parser can retry; never abort the batch.
      console.error(`[parse] capture ${cap.id} (${cap.captureType}) failed:`, err);
    }
  }
  return summary;
}

/** Drain all pending captures in successive batches. */
export async function parseAll(pool: Pool, batchSize = 100): Promise<ParseSummary> {
  const total = emptySummary();
  for (;;) {
    const s = await parseBatch(pool, batchSize);
    total.captures += s.captures;
    total.snapshots += s.snapshots;
    total.derivedEvents += s.derivedEvents;
    total.interventions += s.interventions;
    total.statsDays += s.statsDays;
    total.adsDays += s.adsDays;
    total.orders += s.orders;
    total.reviews += s.reviews;
    total.messageThreads += s.messageThreads;
    if (s.captures === 0) break;
  }

  // Rebuild the analysis-ready long-format metric series from the freshly
  // upserted daily tables (idempotent; overwrites values in place).
  await buildMetricTimeseries(pool);
  total.metricPoints = await countMetricPoints(pool);
  return total;
}
