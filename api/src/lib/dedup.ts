// Server-side dedup key, mirroring the extension's formula (spec §4) so the
// same payload captured by extension and sweeper collapses to one row. Used as
// a fallback when a client omits dedupKey (e.g. the public API puller).
import { createHash } from "node:crypto";

const BUCKET_MS = 5 * 60 * 1000; // 5-minute capture bucket

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function makeDedupKey(parts: {
  shopId: string | null;
  captureType: string;
  key: string; // url or entity id — whatever identifies the payload
  body: string;
  capturedAtMs: number;
}): string {
  const bucket = Math.floor(parts.capturedAtMs / BUCKET_MS);
  const contentHash = sha256Hex(parts.body);
  return sha256Hex(
    [parts.shopId ?? "?", parts.captureType, parts.key, bucket, contentHash].join("|")
  );
}
