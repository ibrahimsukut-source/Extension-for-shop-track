// Shared types across the extension's worlds.

/** Message tag used on window.postMessage between MAIN and ISOLATED worlds. */
export const TAG = "__ETSY_TRACKER__" as const;

/** Raw capture emitted by the MAIN-world interceptor. */
export interface CapturePayload {
  source: typeof TAG;
  kind: "http";
  method: string;
  url: string;
  status: number;
  body: string;
  ts: number;
}

/** DOM action event emitted by the ISOLATED-world content script (secondary channel). */
export interface DomActionPayload {
  source: typeof TAG;
  kind: "dom_action";
  eventType: string;
  entityId?: string | null;
  url: string;
  ts: number;
}

export type BridgePayload = CapturePayload | DomActionPayload;

/** Runtime message from a content script to the background service worker. */
export interface RuntimeMessage {
  type: "CAPTURE" | "DOM_ACTION";
  data: BridgePayload;
}

/** A single endpoint classification rule from endpoints.config.json. */
export interface EndpointPattern {
  match: string;
  type: CaptureType;
}

export type CaptureType =
  | "stats"
  | "messages"
  | "ads"
  | "listing"
  | "order"
  | "review"
  | "unknown";

/** A normalized, classified record ready to store and/or forward to the API. */
export interface ClassifiedRecord {
  captureType: CaptureType;
  source: "extension";
  method: string;
  url: string;
  status: number;
  shopId: string | null;
  shopTag: string | null;
  vpsHost: string | null;
  chromeProfile: string | null;
  body: unknown; // parsed JSON when possible, else raw string
  capturedAt: string; // ISO-8601
  dedupKey: string;
}
