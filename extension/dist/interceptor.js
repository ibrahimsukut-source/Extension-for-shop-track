"use strict";
(() => {
  // src/lib/types.ts
  var TAG = "__ETSY_TRACKER__";

  // src/interceptor.ts
  (function installInterceptor() {
    const w = window;
    if (w.__ETSY_TRACKER_INSTALLED__) return;
    w.__ETSY_TRACKER_INSTALLED__ = true;
    const post = (payload) => {
      try {
        window.postMessage({ source: TAG, ...payload }, window.location.origin);
      } catch {
      }
    };
    const isJson = (contentType) => !!contentType && contentType.toLowerCase().includes("application/json");
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
        if (isJson(res.headers.get("content-type"))) {
          const clone = res.clone();
          void clone.text().then((body) => {
            post({ kind: "http", method: method.toUpperCase(), url, status: res.status, body, ts: Date.now() });
          });
        }
      } catch {
      }
      return res;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__etsyMethod = method;
      this.__etsyUrl = typeof url === "string" ? url : url.href;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
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
            ts: Date.now()
          });
        } catch {
        }
      });
      return origSend.apply(this, args);
    };
  })();
})();
