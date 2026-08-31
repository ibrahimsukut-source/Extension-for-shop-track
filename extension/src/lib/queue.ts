// Durable, storage-backed outbound queue with batching + exponential-backoff
// retry (spec 2.1). When the network or central API is unavailable, records
// accumulate in chrome.storage.local and are flushed later. Forwarding is only
// attempted when the API is configured (see settings.canForward); otherwise the
// queue stays empty and Phase 1 remains local-only.
import type { ClassifiedRecord } from "./types.js";
import { canForward, getSettings, type Settings } from "./settings.js";
import { runExclusive } from "./lock.js";

const KEY = "outbound_queue";
const MAX_QUEUE = 5000; // hard cap so a long outage can't exhaust storage
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 6; // ~2s,4s,8s,16s,32s backoff handled by the alarm cadence

interface QueueItem {
  record: ClassifiedRecord;
  attempts: number;
}

async function read(): Promise<QueueItem[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as QueueItem[] | undefined) ?? [];
}

async function write(items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: items });
}

export async function enqueue(record: ClassifiedRecord): Promise<void> {
  await runExclusive(async () => {
    const items = await read();
    items.push({ record, attempts: 0 });
    if (items.length > MAX_QUEUE) items.splice(0, items.length - MAX_QUEUE);
    await write(items);
  });
}

export async function queueSize(): Promise<number> {
  return (await read()).length;
}

async function postBatch(settings: Settings, records: ClassifiedRecord[]): Promise<boolean> {
  const endpoint = `${settings.apiHost.replace(/\/$/, "")}/ingest/http`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiToken}`,
      },
      body: JSON.stringify({ records }),
    });
    // 2xx = accepted; 4xx (except 429) = permanent, drop to avoid poison-pill loops.
    if (res.ok) return true;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      console.warn(`[queue] batch rejected (${res.status}); dropping ${records.length} records`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[queue] network error, will retry", err);
    return false;
  }
}

let flushing = false;

/**
 * Attempt to flush one batch. Returns true if there may be more work queued.
 * Called from the background alarm and after each enqueue; failures increment
 * attempts and remain queued until MAX_ATTEMPTS (backoff via the alarm cadence).
 *
 * The network POST runs OUTSIDE the storage lock, and sent items are removed by
 * dedup_key (not index), so captures enqueued during the POST are never lost. A
 * re-entrancy guard prevents two overlapping flushes from double-posting.
 */
export async function flush(): Promise<boolean> {
  const settings = await getSettings();
  if (!canForward(settings)) return false;
  if (flushing) return false;
  flushing = true;
  try {
    const batch = await runExclusive(async () => (await read()).slice(0, BATCH_SIZE));
    if (batch.length === 0) return false;

    const ok = await postBatch(settings, batch.map((i) => i.record));
    const sentKeys = new Set(batch.map((i) => i.record.dedupKey));

    return await runExclusive(async () => {
      const items = await read();
      if (ok) {
        const remaining = items.filter((i) => !sentKeys.has(i.record.dedupKey));
        await write(remaining);
        return remaining.length > 0;
      }
      // Failed: bump attempts on the batch's items, drop those that exhausted retries.
      const updated = items.map((i) =>
        sentKeys.has(i.record.dedupKey) ? { ...i, attempts: i.attempts + 1 } : i
      );
      const kept = updated.filter((i) => i.attempts < MAX_ATTEMPTS);
      const dropped = updated.length - kept.length;
      if (dropped > 0) console.warn(`[queue] dropped ${dropped} records after ${MAX_ATTEMPTS} attempts`);
      await write(kept);
      return false; // back off; next alarm retries
    });
  } finally {
    flushing = false;
  }
}
