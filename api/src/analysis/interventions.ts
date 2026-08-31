// Intervention detector (spec §7 intervention_detector, taxonomy §4).
//
// An *intervention* is a first-class "what I did" record — the analysis unit an
// experiment attaches to. Snapshot diffing is the most reliable detector: it
// catches changes made anywhere (browser, app, bulk edit) by comparing a
// listing's previous snapshot with a new one. The derived `events` log answers
// "what changed" for the live dashboard; interventions are the same signal
// promoted to the taxonomy the causal engine reasons over, carrying a signed
// `magnitude` and a detector `confidence`.
import type { ListingSnapshotRow } from "../parsers/types.js";
import type { PriorSnapshot } from "../parse/diff.js";

export interface Intervention {
  interventionType: string;
  entityType: "listing" | "shop" | "ad" | "conversation";
  entityId: string | null;
  occurredAt: string;
  beforeValue: unknown;
  afterValue: unknown;
  magnitude: number | null;
  source: string;
  confidence: number | null;
}

const ACTIVE = (s: string | null) => (s ?? "").toLowerCase() === "active";

function sameSet(a: string[] | null, b: string[] | null): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Detect listing-level interventions from a snapshot diff. Only fields present
 * in BOTH snapshots are compared, so a newly-observed field never masquerades
 * as a change. Snapshot-diff confidence is high (0.9) for concrete field
 * changes — the state genuinely differs between two observations.
 */
export function detectListingInterventions(
  prev: PriorSnapshot,
  next: ListingSnapshotRow,
  occurredAt: string
): Intervention[] {
  const out: Intervention[] = [];
  const entityId = String(next.listingId);
  const push = (
    interventionType: string,
    beforeValue: unknown,
    afterValue: unknown,
    magnitude: number | null = null
  ) =>
    out.push({
      interventionType,
      entityType: "listing",
      entityId,
      occurredAt,
      beforeValue,
      afterValue,
      magnitude,
      source: "snapshot_diff",
      confidence: 0.9,
    });

  // Price — signed magnitude (delta) drives event-study aggregation later.
  if (next.price !== null && prev.price !== null && next.price !== prev.price) {
    push("price_changed", prev.price, next.price, next.price - prev.price);
  }

  // State: prefer the specific (de)activation signal, else a generic change.
  if (next.state !== null && prev.state !== null && next.state !== prev.state) {
    if (ACTIVE(prev.state) && !ACTIVE(next.state)) push("listing_deactivated", prev.state, next.state);
    else if (!ACTIVE(prev.state) && ACTIVE(next.state)) push("listing_reactivated", prev.state, next.state);
    else push("state_changed", prev.state, next.state);
  }

  // Photos: count changed, or the set of image hashes changed.
  const photosChanged =
    (next.numImages !== null && prev.numImages !== null && next.numImages !== prev.numImages) ||
    (next.imageHashes !== null && prev.imageHashes !== null && !sameSet(next.imageHashes, prev.imageHashes));
  if (photosChanged) {
    push(
      "photo_changed",
      { num: prev.numImages, hashes: prev.imageHashes },
      { num: next.numImages, hashes: next.imageHashes },
      next.numImages !== null && prev.numImages !== null ? next.numImages - prev.numImages : null
    );
  }

  // Title
  if (next.title !== null && prev.title !== null && next.title !== prev.title) {
    push("title_changed", prev.title, next.title);
  }

  // Tags
  if (next.tags !== null && prev.tags !== null && !sameSet(next.tags, prev.tags)) {
    push("tags_changed", prev.tags, next.tags);
  }

  // Quantity
  if (next.quantity !== null && prev.quantity !== null && next.quantity !== prev.quantity) {
    push("quantity_changed", prev.quantity, next.quantity, next.quantity - prev.quantity);
  }

  return out;
}
