"use strict";
(() => {
  // src/lib/types.ts
  var TAG = "__ETSY_TRACKER__";

  // src/bridge.ts
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG) return;
    const message = data.kind === "http" ? { type: "CAPTURE", data } : data.kind === "dom_action" ? { type: "DOM_ACTION", data } : null;
    if (!message) return;
    chrome.runtime.sendMessage(message).catch(() => {
    });
  });
})();
