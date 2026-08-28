// Background service worker (spec 2.1). Receives captures from content scripts,
// classifies them against the config-driven endpoint patterns, resolves shop
// identity, deduplicates, and:
//   - Phase 1: stores matched records in chrome.storage.local + logs to console.
//   - Phase 2: additionally forwards them to the central ingestion API when the
//     API is configured (see settings/queue).
import endpointsConfig from "./config/endpoints.config.json";
import { classify, compilePatterns } from "./lib/classify.js";
import { makeDedupKey } from "./lib/dedup.js";
import { resolveShopId } from "./lib/shop.js";
import { pushAll, pushRecent } from "./lib/store.js";
import { enqueue, flush, queueSize } from "./lib/queue.js";
import { canForward, getSettings } from "./lib/settings.js";
import type {
  CapturePayload,
  ClassifiedRecord,
  DomActionPayload,
  EndpointPattern,
  RuntimeMessage,
} from "./lib/types.js";

const compiled = compilePatterns((endpointsConfig as { patterns: EndpointPattern[] }).patterns);

const FLUSH_ALARM = "flush-queue";
const FLUSH_PERIOD_MIN = 1; // alarm cadence; queue applies its own backoff

/** Parse a JSON body, returning the raw string when it isn't valid JSON. */
function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function handleCapture(cap: CapturePayload): Promise<void> {
  const captureType = classify(cap.url, compiled);
  const settings = await getSettings();

  // Discovery mode: record every JSON response (matched or not) so real Etsy
  // endpoints can be observed on the live panel and folded into the config.
  if (settings.captureAll) {
    await pushAll({
      url: cap.url,
      method: cap.method,
      status: cap.status,
      captureType: captureType ?? "unmatched",
      preview: cap.body.slice(0, 200),
      ts: cap.ts,
    });
  }

  if (!captureType) return; // config miss → drop as noise (spec 2.1)

  const parsed = tryParse(cap.body);
  const shopId = resolveShopId(cap.url, parsed, settings.shopTag || null);
  const capturedAt = new Date(cap.ts).toISOString();
  const dedupKey = await makeDedupKey({
    shopId,
    captureType,
    url: cap.url,
    body: cap.body,
    capturedAtMs: cap.ts,
  });

  const record: ClassifiedRecord = {
    captureType,
    source: "extension",
    method: cap.method,
    url: cap.url,
    status: cap.status,
    shopId,
    shopTag: settings.shopTag || null,
    vpsHost: settings.vpsHost || null,
    chromeProfile: settings.chromeProfile || null,
    body: parsed,
    capturedAt,
    dedupKey,
  };

  await pushRecent(record);
  console.log(
    `[tracker] captured ${captureType} shop=${shopId ?? "?"} status=${cap.status} ${cap.url}`,
    record
  );

  if (canForward(settings)) {
    await enqueue(record);
    void flush();
  }
}

function handleDomAction(action: DomActionPayload): void {
  // Secondary channel — logged for visibility; central event ingestion is Phase 2.
  console.log(
    `[tracker] dom_action ${action.eventType} entity=${action.entityId ?? "?"} ${action.url}`
  );
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.type === "CAPTURE") {
    void handleCapture(message.data as CapturePayload).finally(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (message?.type === "DOM_ACTION") {
    handleDomAction(message.data as DomActionPayload);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Periodic queue flush (survives SW sleep/wake).
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FLUSH_ALARM) return;
  void (async () => {
    if ((await queueSize()) > 0) await flush();
  })();
});
