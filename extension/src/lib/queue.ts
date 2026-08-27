// Durable, storage-backed outbound queue with batching + exponential-backoff
// retry (spec 2.1). When the network or central API is unavailable, records
// accumulate in chrome.storage.local and are flushed later. Forwarding is only
// attempted when the API is configured (see settings.canForward); otherwise the
// queue stays empty and Phase 1 remains local-only.
import type { ClassifiedRecord } from "./types.js";
import { canForward, getSettings, type Settings } from "./settings.js";

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
  const items = await read();
  items.push({ record, attempts: 0 });
  if (items.length > MAX_QUEUE) items.splice(0, items.length - MAX_QUEUE);
  await write(items);
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

/**
 * Attempt to flush one batch. Returns true if there may be more work queued.
 * Called from the background alarm; failures increment attempts and remain
 * queued until MAX_ATTEMPTS, giving exponential-ish backoff via alarm cadence.
 */
export async function flush(): Promise<boolean> {
  const settings = await getSettings();
  if (!canForward(settings)) return false;

  const items = await read();
  if (items.length === 0) return false;

  const batch = items.slice(0, BATCH_SIZE);
  const ok = await postBatch(settings, batch.map((i) => i.record));

  if (ok) {
    await write(items.slice(batch.length));
    return items.length > batch.length;
  }

  // Failed: bump attempts, drop items that exhausted their retries.
  const remaining = items.map((item, idx) =>
    idx < batch.length ? { ...item, attempts: item.attempts + 1 } : item
  );
  const kept = remaining.filter((i) => i.attempts < MAX_ATTEMPTS);
  const dropped = remaining.length - kept.length;
  if (dropped > 0) console.warn(`[queue] dropped ${dropped} records after ${MAX_ATTEMPTS} attempts`);
  await write(kept);
  return false; // back off; next alarm retries
}
