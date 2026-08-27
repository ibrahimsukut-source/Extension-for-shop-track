// Ingestion service: turns validated request payloads into deduplicated rows.
// Pure of HTTP concerns so it can be unit-tested against pg-mem.
import { makeDedupKey } from "./lib/dedup.js";
import {
  ensureShop,
  insertEvent,
  insertRawCapture,
  withTransaction,
  type Pool,
} from "./repository.js";
import type { ApiRecord, ClassifiedRecord, EventInput } from "./schemas.js";

export interface IngestResult {
  accepted: number;
  duplicates: number;
  total: number;
}

function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const v of values) if (v !== null && v !== undefined && v !== "") return v;
  return null;
}

/** /ingest/http — raw captured internal responses from extension / sweeper. */
export async function ingestHttp(
  pool: Pool,
  shopTag: string,
  records: ClassifiedRecord[]
): Promise<IngestResult> {
  return withTransaction(pool, async (c) => {
    const shopId = await ensureShop(c, {
      shopTag,
      etsyShopId: firstNonNull(records.map((r) => r.shopId)),
      vpsHost: firstNonNull(records.map((r) => r.vpsHost)),
      chromeProfile: firstNonNull(records.map((r) => r.chromeProfile)),
    });
    let accepted = 0;
    for (const r of records) {
      const stored = await insertRawCapture(c, {
        shopId,
        source: r.source || "extension",
        captureType: r.captureType,
        url: r.url,
        status: r.status,
        body: r.body,
        dedupKey: r.dedupKey,
        capturedAt: r.capturedAt,
      });
      if (stored) accepted++;
    }
    return { accepted, duplicates: records.length - accepted, total: records.length };
  });
}

/** /ingest/event — DOM / derived action events. */
export async function ingestEvents(
  pool: Pool,
  shopTag: string,
  events: EventInput[]
): Promise<IngestResult> {
  return withTransaction(pool, async (c) => {
    const shopId = await ensureShop(c, { shopTag });
    let accepted = 0;
    for (const e of events) {
      const dedupKey =
        e.dedupKey ??
        makeDedupKey({
          shopId: shopTag,
          captureType: `event:${e.eventType}`,
          key: e.entityId ?? e.eventType,
          body: JSON.stringify(e.payload ?? null),
          capturedAtMs: Date.parse(e.occurredAt),
        });
      const stored = await insertEvent(c, {
        shopId,
        eventType: e.eventType,
        entityType: e.entityType,
        entityId: e.entityId,
        actor: e.actor,
        origin: e.origin,
        occurredAt: e.occurredAt,
        payload: e.payload ?? null,
        dedupKey,
      });
      if (stored) accepted++;
    }
    return { accepted, duplicates: events.length - accepted, total: events.length };
  });
}

/** /ingest/api — public API puller output, stored raw for later parsing. */
export async function ingestApi(
  pool: Pool,
  shopTag: string,
  records: ApiRecord[]
): Promise<IngestResult> {
  return withTransaction(pool, async (c) => {
    const shopId = await ensureShop(c, { shopTag });
    let accepted = 0;
    for (const r of records) {
      const capturedAt = r.capturedAt ?? new Date().toISOString();
      const dedupKey =
        r.dedupKey ??
        makeDedupKey({
          shopId: shopTag,
          captureType: r.captureType,
          key: r.entityId ?? r.url,
          body: JSON.stringify(r.body ?? null),
          capturedAtMs: Date.parse(capturedAt),
        });
      const stored = await insertRawCapture(c, {
        shopId,
        source: "api",
        captureType: r.captureType,
        url: r.url,
        status: r.status,
        body: r.body,
        dedupKey,
        capturedAt,
      });
      if (stored) accepted++;
    }
    return { accepted, duplicates: records.length - accepted, total: records.length };
  });
}
