// Snapshot diffing (spec §2.5): the most reliable action detection. Comparing a
// listing's previous snapshot with a new one yields derived events — and catches
// changes made outside the browser too. Interception events say "who/when
// clicked"; diff events say "what actually changed".
import type { ListingSnapshotRow } from "../parsers/types.js";

export interface PriorSnapshot {
  state: string | null;
  price: number | null;
  title: string | null;
  tags: string[] | null;
  numImages: number | null;
  imageHashes: string[] | null;
  quantity: number | null;
}

export interface DerivedEvent {
  eventType: string;
  entityType: "listing";
  entityId: string;
  occurredAt: string;
  payload: { old: unknown; new: unknown };
}

const ACTIVE = (s: string | null) => (s ?? "").toLowerCase() === "active";

function sameSet(a: string[] | null, b: string[] | null): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Compare a listing's prior snapshot to a new one and emit derived events. */
export function diffSnapshots(
  prev: PriorSnapshot,
  next: ListingSnapshotRow,
  occurredAt: string
): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  const entityId = String(next.listingId);
  const push = (eventType: string, oldV: unknown, newV: unknown) =>
    events.push({ eventType, entityType: "listing", entityId, occurredAt, payload: { old: oldV, new: newV } });

  // Price
  if (next.price !== null && prev.price !== null && next.price !== prev.price) {
    push("price_change", prev.price, next.price);
  }

  // State: prefer the specific activate/deactivate signal, else a generic change.
  if (next.state !== null && prev.state !== null && next.state !== prev.state) {
    if (ACTIVE(prev.state) && !ACTIVE(next.state)) push("deactivated", prev.state, next.state);
    else if (!ACTIVE(prev.state) && ACTIVE(next.state)) push("activated", prev.state, next.state);
    else push("state_change", prev.state, next.state);
  }

  // Photos: number changed, or the set of image hashes changed.
  const photosChanged =
    (next.numImages !== null && prev.numImages !== null && next.numImages !== prev.numImages) ||
    (next.imageHashes !== null && prev.imageHashes !== null && !sameSet(next.imageHashes, prev.imageHashes));
  if (photosChanged) {
    push("photo_changed", { num: prev.numImages, hashes: prev.imageHashes }, { num: next.numImages, hashes: next.imageHashes });
  }

  // Title
  if (next.title !== null && prev.title !== null && next.title !== prev.title) {
    push("title_change", prev.title, next.title);
  }

  // Tags
  if (next.tags !== null && prev.tags !== null && !sameSet(next.tags, prev.tags)) {
    push("tag_change", prev.tags, next.tags);
  }

  return events;
}
