// ISOLATED-world content script (spec 2.4). Secondary channel: captures seller
// actions that may not produce a clean JSON call (e.g. deactivate toggles,
// photo drag-drop). This is best-effort and DELIBERATELY coarse — the primary,
// authoritative signals are network interception (2.1) and central snapshot
// diffing (2.5). Selector fragility is expected; failures are silent.
import { TAG, type DomActionPayload } from "../lib/types.js";

interface ActionRule {
  eventType: string;
  /** CSS selector; a click on a matching element (or its descendant) fires the rule. */
  selector: string;
  /** Optional attribute to read as the entity id from the matched element or an ancestor. */
  entityIdAttr?: string;
}

// Kept intentionally small and generic. Extend as real DOM is observed; do not
// treat this as a source of truth.
const RULES: ActionRule[] = [
  { eventType: "listing_deactivate_click", selector: "[data-deactivate],[aria-label*='Deactivate' i]", entityIdAttr: "data-listing-id" },
  { eventType: "listing_activate_click", selector: "[data-activate],[aria-label*='Activate' i]", entityIdAttr: "data-listing-id" },
  { eventType: "listing_delete_click", selector: "[data-delete],[aria-label*='Delete' i]", entityIdAttr: "data-listing-id" },
  { eventType: "listing_edit_click", selector: "[data-edit-listing],a[href*='/listings/'][href*='/edit']", entityIdAttr: "data-listing-id" },
];

function findEntityId(start: Element, attr?: string): string | null {
  if (!attr) return null;
  let el: Element | null = start;
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
      const payload: DomActionPayload = {
        source: TAG,
        kind: "dom_action",
        eventType: rule.eventType,
        entityId: findEntityId(match, rule.entityIdAttr),
        url: window.location.href,
        ts: Date.now(),
      };
      // Route through the same window bridge as interceptor captures.
      try {
        window.postMessage(payload, window.location.origin);
      } catch {
        /* swallow */
      }
      break;
    }
  },
  true // capture phase: observe even if the app stops propagation
);
