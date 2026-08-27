// ISOLATED-world content script (spec 2.1). Relays messages from the MAIN-world
// interceptor to the background service worker. This is the only path by which
// captured data crosses from the page into extension-privileged code.
import { TAG, type BridgePayload, type RuntimeMessage } from "./lib/types.js";

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages posted by this page's own interceptor.
  if (event.source !== window) return;
  const data = event.data as Partial<BridgePayload> | undefined;
  if (!data || data.source !== TAG) return;

  const message: RuntimeMessage | null =
    data.kind === "http"
      ? { type: "CAPTURE", data: data as BridgePayload }
      : data.kind === "dom_action"
        ? { type: "DOM_ACTION", data: data as BridgePayload }
        : null;
  if (!message) return;

  // The SW may be asleep; sendMessage wakes it. Ignore "no receiver" races.
  chrome.runtime.sendMessage(message).catch(() => {
    /* SW not ready / context invalidated — the capture is best-effort */
  });
});
