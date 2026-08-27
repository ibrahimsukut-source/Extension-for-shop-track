// Deterministic dedup key (spec 4). The same response can be captured by both
// the extension and the CDP sweeper, so records must be deduplicated centrally.
// The key is content-addressed and bucketed to a coarse time window so genuine
// re-captures of the same payload collapse, while real changes produce new keys.

const BUCKET_MS = 5 * 60 * 1000; // 5-minute capture bucket

/** SHA-256 hex via SubtleCrypto (available in SW, content scripts, and pages). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeDedupKey(parts: {
  shopId: string | null;
  captureType: string;
  url: string;
  body: string;
  capturedAtMs: number;
}): Promise<string> {
  const bucket = Math.floor(parts.capturedAtMs / BUCKET_MS);
  const contentHash = await sha256Hex(parts.body);
  return sha256Hex(
    [parts.shopId ?? "?", parts.captureType, parts.url, bucket, contentHash].join("|")
  );
}
