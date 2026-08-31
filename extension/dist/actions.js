"use strict";
(() => {
  // src/lib/types.ts
  var TAG = "__ETSY_TRACKER__";

  // src/content/actions.ts
  var RULES = [
    { eventType: "listing_deactivate_click", selector: "[data-deactivate],[aria-label*='Deactivate' i]", entityIdAttr: "data-listing-id" },
    { eventType: "listing_activate_click", selector: "[data-activate],[aria-label*='Activate' i]", entityIdAttr: "data-listing-id" },
    { eventType: "listing_delete_click", selector: "[data-delete],[aria-label*='Delete' i]", entityIdAttr: "data-listing-id" },
    { eventType: "listing_edit_click", selector: "[data-edit-listing],a[href*='/listings/'][href*='/edit']", entityIdAttr: "data-listing-id" }
  ];
  function findEntityId(start, attr) {
    if (!attr) return null;
    let el = start;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const v = el.getAttribute(attr);
      if (v) return v;
    }
    return null;
  }
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      for (const rule of RULES) {
        const match = target.closest(rule.selector);
        if (!match) continue;
        const payload = {
          source: TAG,
          kind: "dom_action",
          eventType: rule.eventType,
          entityId: findEntityId(match, rule.entityIdAttr),
          url: window.location.href,
          ts: Date.now()
        };
        try {
          window.postMessage(payload, window.location.origin);
        } catch {
        }
        break;
      }
    },
    true
    // capture phase: observe even if the app stops propagation
  );
})();
