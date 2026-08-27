// Local capture store for Phase 1: a bounded ring buffer in chrome.storage.local
// so recent captures are inspectable from the options page / devtools without a
// central server. Not a durable archive — the ingestion API is the source of
// truth once Phase 2 is wired up.
import type { ClassifiedRecord } from "./types.js";

const KEY = "recent_captures";
const MAX = 200;

export async function pushRecent(record: ClassifiedRecord): Promise<void> {
  const stored = await chrome.storage.local.get(KEY);
  const list = (stored[KEY] as ClassifiedRecord[] | undefined) ?? [];
  list.push(record);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function getRecent(): Promise<ClassifiedRecord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ClassifiedRecord[] | undefined) ?? [];
}

export async function clearRecent(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
