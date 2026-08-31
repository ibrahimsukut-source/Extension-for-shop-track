// MAIN-world script (spec 2.1). MV3's chrome.webRequest cannot read response
// bodies, so we monkey-patch fetch and XMLHttpRequest in the page's own world to
// observe JSON responses, then hand them to the ISOLATED bridge via postMessage.
//
// Runs at document_start. Must not depend on any extension API (there are none
// in MAIN world) and must be defensive: never break the host page's requests.
import { TAG, type CapturePayload } from "./lib/types.js";

(function installInterceptor() {
  const w = window as unknown as { __ETSY_TRACKER_INSTALLED__?: boolean };
  if (w.__ETSY_TRACKER_INSTALLED__) return; // idempotent guard
  w.__ETSY_TRACKER_INSTALLED__ = true;

  const post = (payload: Omit<CapturePayload, "source">) => {
    try {
      window.postMessage({ source: TAG, ...payload }, window.location.origin);
    } catch {
      /* never let telemetry break the page */
    }
  };

  const isJson = (contentType: string | null): boolean =>
    !!contentType && contentType.toLowerCase().includes("application/json");

  // ── fetch patch ──────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args as never);
    try {
      const input = args[0] as RequestInfo | URL;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const method =
        (args[1] as RequestInit | undefined)?.method ??
        (input instanceof Request ? input.method : "GET");
      if (isJson(res.headers.get("content-type"))) {
        const clone = res.clone();
        // Read the body off the critical path; ignore read failures.
        void clone.text().then((body) => {
          post({ kind: "http", method: method.toUpperCase(), url, status: res.status, body, ts: Date.now() });
        });
      }
    } catch {
      /* swallow */
    }
    return res;
  };

  // ── XHR patch ────────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  type TrackedXhr = XMLHttpRequest & { __etsyUrl?: string; __etsyMethod?: string };

  XMLHttpRequest.prototype.open = function (
    this: TrackedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__etsyMethod = method;
    this.__etsyUrl = typeof url === "string" ? url : url.href;
    // @ts-expect-error variadic passthrough to native open
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (this: TrackedXhr, ...args: unknown[]) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType !== "" && this.responseType !== "text") return;
        if (!isJson(this.getResponseHeader("content-type"))) return;
        post({
          kind: "http",
          method: (this.__etsyMethod ?? "GET").toUpperCase(),
          url: this.__etsyUrl ?? "",
          status: this.status,
          body: this.responseText,
          ts: Date.now(),
        });
      } catch {
        /* swallow */
      }
    });
    // @ts-expect-error variadic passthrough to native send
    return origSend.apply(this, args);
  };
})();
