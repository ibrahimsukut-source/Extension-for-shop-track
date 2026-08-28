// Local capture store for Phase 1: a bounded ring buffer in chrome.storage.local
// so recent captures are inspectable from the options page / devtools without a
// central server. Not a durable archive — the ingestion API is the source of
// truth once Phase 2 is wired up.
import type { ClassifiedRecord } from "./types.js";
import { runExclusive } from "./lock.js";

const KEY = "recent_captures";
const MAX = 200;

export async function pushRecent(record: ClassifiedRecord): Promise<void> {
  await runExclusive(async () => {
    const stored = await chrome.storage.local.get(KEY);
    const list = (stored[KEY] as ClassifiedRecord[] | undefined) ?? [];
    list.push(record);
    if (list.length > MAX) list.splice(0, list.length - MAX);
    await chrome.storage.local.set({ [KEY]: list });
  });
}

export async function getRecent(): Promise<ClassifiedRecord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ClassifiedRecord[] | undefined) ?? [];
}

export async function clearRecent(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

// ── Discovery buffer (captureAll mode): compact records of EVERY JSON response,
//    matched or not, so real Etsy endpoints can be observed on the live panel.
const ALL_KEY = "all_captures";
const ALL_MAX = 1000;

export interface DiagnosticRecord {
  url: string;
  method: string;
  status: number;
  captureType: string; // matched type, or "unmatched"
  preview: string; // first ~200 chars of the body, for identification
  ts: number;
}

export async function pushAll(record: DiagnosticRecord): Promise<void> {
  await runExclusive(async () => {
    const stored = await chrome.storage.local.get(ALL_KEY);
    const list = (stored[ALL_KEY] as DiagnosticRecord[] | undefined) ?? [];
    list.push(record);
    if (list.length > ALL_MAX) list.splice(0, list.length - ALL_MAX);
    await chrome.storage.local.set({ [ALL_KEY]: list });
  });
}

export async function getAll(): Promise<DiagnosticRecord[]> {
  const stored = await chrome.storage.local.get(ALL_KEY);
  return (stored[ALL_KEY] as DiagnosticRecord[] | undefined) ?? [];
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove(ALL_KEY);
}
