// Request validation (Zod). The /ingest/http contract matches the extension's
// ClassifiedRecord (see extension/src/lib/types.ts).
import { z } from "zod";

export const captureType = z.enum([
  "stats",
  "messages",
  "ads",
  "listing",
  "order",
  "review",
  "unknown",
]);

// A record forwarded by the extension (or CDP sweeper) from /ingest/http.
export const classifiedRecord = z.object({
  captureType,
  source: z.string().default("extension"),
  method: z.string().default("GET"),
  url: z.string(),
  status: z.number().int(),
  shopId: z.string().nullable().default(null),
  shopTag: z.string().nullable().default(null),
  vpsHost: z.string().nullable().default(null),
  chromeProfile: z.string().nullable().default(null),
  body: z.unknown(),
  capturedAt: z.string().datetime({ offset: true }),
  dedupKey: z.string().min(8),
});
export type ClassifiedRecord = z.infer<typeof classifiedRecord>;

export const ingestHttpBody = z.object({
  records: z.array(classifiedRecord).min(1),
});

// A DOM/derived action event for /ingest/event (spec events table).
export const eventInput = z.object({
  eventType: z.string(),
  entityType: z.string().nullable().default(null),
  entityId: z.string().nullable().default(null),
  actor: z.string().nullable().default(null),
  origin: z.string().nullable().default(null),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.unknown().optional(),
  dedupKey: z.string().min(8).optional(),
});
export type EventInput = z.infer<typeof eventInput>;

export const ingestEventBody = z.object({
  events: z.array(eventInput).min(1),
});

// Public API puller output for /ingest/api. Stored raw for later parsing.
export const apiRecord = z.object({
  captureType,
  url: z.string().default(""),
  status: z.number().int().default(200),
  body: z.unknown(),
  entityId: z.string().nullable().default(null),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  dedupKey: z.string().min(8).optional(),
});
export type ApiRecord = z.infer<typeof apiRecord>;

export const ingestApiBody = z.object({
  records: z.array(apiRecord).min(1),
});

// POST /analysis/ask body (spec §9 NL question interface).
export const askBody = z.object({
  question: z.string().min(1).max(2000),
});
