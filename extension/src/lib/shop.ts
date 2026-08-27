// Shop identity resolution (spec 2.3). Multi-account isolation depends on
// attributing every capture to exactly one shop. Resolution order:
//   1. shop_id inside the captured response body
//   2. shop id embedded in the request URL
//   3. fallback SHOP_TAG configured per-VPS at build/deploy time

const URL_SHOP_PATTERNS: RegExp[] = [
  /\/shops\/(\d+)(?:[/?]|$)/i, // /shops/12345678/...
  /[?&]shop_id=(\d+)/i, // ...?shop_id=12345678
];

/** Recursively search a parsed body for the first plausible shop id. */
function shopIdFromBody(body: unknown, depth = 0): string | null {
  if (depth > 4 || body === null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const key of ["shop_id", "shopId", "etsy_shop_id"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = shopIdFromBody(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function shopIdFromUrl(url: string): string | null {
  for (const re of URL_SHOP_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

export function resolveShopId(
  url: string,
  body: unknown,
  fallbackTag: string | null
): string | null {
  return shopIdFromBody(body) ?? shopIdFromUrl(url) ?? fallbackTag;
}
