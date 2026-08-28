// Unit tests for the pure, browser-independent logic (classify + shop id).
// We bundle the TS sources to a temporary ESM module with esbuild (already a
// dependency), then exercise them with node:test — no extra test tooling.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

async function load() {
  const out = path.join(here, ".bundle.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        export { classify, compilePatterns, patternToRegex } from "../src/lib/classify.ts";
        export { resolveShopId } from "../src/lib/shop.ts";
      `,
      resolveDir: here,
      loader: "ts",
    },
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  await rm(out, { force: true });
  return mod;
}

const lib = await load();

const PATTERNS = [
  { match: "/api/v3/ajax/bespoke/member/shops/*/stats*", type: "stats" },
  { match: "*/conversations*", type: "messages" },
  { match: "*/advertising*", type: "ads" },
  { match: "*/listings*", type: "listing" },
  { match: "*/receipts*", type: "order" },
];

test("classify: matches stats endpoint with wildcards", () => {
  const compiled = lib.compilePatterns(PATTERNS);
  const url = "https://www.etsy.com/api/v3/ajax/bespoke/member/shops/12345/stats?period=day";
  assert.equal(lib.classify(url, compiled), "stats");
});

test("classify: substring match anywhere in URL", () => {
  const compiled = lib.compilePatterns(PATTERNS);
  assert.equal(lib.classify("https://www.etsy.com/x/conversations/list", compiled), "messages");
  assert.equal(lib.classify("https://www.etsy.com/your/advertising/summary", compiled), "ads");
});

test("classify: first matching pattern wins (order matters)", () => {
  const compiled = lib.compilePatterns([
    { match: "*/shops/*/stats*", type: "stats" },
    { match: "*/shops/*", type: "listing" },
  ]);
  assert.equal(lib.classify("https://www.etsy.com/shops/9/stats", compiled), "stats");
});

test("classify: unmatched URL returns null (dropped as noise)", () => {
  const compiled = lib.compilePatterns(PATTERNS);
  assert.equal(lib.classify("https://www.etsy.com/some/random/asset.js", compiled), null);
});

test("classify: regex metacharacters in URL are treated literally", () => {
  const compiled = lib.compilePatterns([{ match: "*/a.b/*", type: "stats" }]);
  // '.' in the pattern is escaped, so it should NOT match 'aXb'
  assert.equal(lib.classify("https://www.etsy.com/aXb/x", compiled), null);
  assert.equal(lib.classify("https://www.etsy.com/a.b/x", compiled), "stats");
});

test("resolveShopId: prefers shop_id from body", () => {
  const id = lib.resolveShopId("https://www.etsy.com/x?shop_id=999", { data: { shop_id: 123 } }, "tag");
  assert.equal(id, "123");
});

test("resolveShopId: falls back to URL shop id (singular and plural)", () => {
  assert.equal(lib.resolveShopId("https://www.etsy.com/shops/456/listings", {}, "tag"), "456");
  assert.equal(lib.resolveShopId("https://www.etsy.com/x?shop_id=789", {}, "tag"), "789");
  // Etsy's real internal path is singular: /api/v3/ajax/shop/{id}/...
  assert.equal(
    lib.resolveShopId("https://www.etsy.com/api/v3/ajax/shop/32467610/listings/v3/search?query=", {}, "tag"),
    "32467610"
  );
});

test("resolveShopId: falls back to shop tag when nothing else", () => {
  assert.equal(lib.resolveShopId("https://www.etsy.com/nothing", {}, "my-tag"), "my-tag");
  assert.equal(lib.resolveShopId("https://www.etsy.com/nothing", {}, null), null);
});

test("resolveShopId: finds nested shop_id and ignores non-numeric strings", () => {
  const body = { shop: { info: { shop_id: "555" } }, other: "shop_id-ish" };
  assert.equal(lib.resolveShopId("https://www.etsy.com/x", body, null), "555");
});

// Guards the shipped endpoints.config.json against real OrnamentsPoint endpoints,
// so the ads-before-listing ordering (promoted-listing URLs contain "listings")
// and the singular /shop/ paths keep classifying correctly.
test("classify: real Etsy endpoints via the shipped config", () => {
  const cfg = JSON.parse(readFileSync(path.join(here, "../src/config/endpoints.config.json"), "utf8"));
  const compiled = lib.compilePatterns(cfg.patterns);
  const c = (u) => lib.classify(u, compiled);
  const B = "https://www.etsy.com/api/v3/ajax/shop/32467610";

  assert.equal(c(`${B}/listings/v3/search?state=active`), "listing");
  assert.equal(c(`${B}/listings/elasticsearch/facets`), "listing");
  assert.equal(c(`${B}/listings/search/stats?listing_ids[]=1`), "listing");
  // Promoted-listing (ads) URLs must be ads, not listing, despite containing "listings".
  assert.equal(c(`${B}/prolist/stats/listings?start_date=2026-08-01`), "ads");
  assert.equal(c(`${B}/prolist/listings/strategy`), "ads");
  assert.equal(c(`${B}/prolist/stats`), "ads");
  assert.equal(c(`${B}/offsite-ads-data/ad-traffic`), "ads");
  assert.equal(c("https://www.etsy.com/api/v3/ajax/bespoke/shop/32467610/etsyads"), "ads");
  // Dashboard/summary -> stats.
  assert.equal(c(`${B}/dashboard`), "stats");
  assert.equal(c(`${B}/summary`), "stats");
  // Third-party trackers stay unmatched (dropped as noise).
  assert.equal(c("https://siteintercept.qualtrics.com/WRSiteInterceptEngine/Targeting.php"), null);
  assert.equal(c(`${B}/payments/monthly-statement`), null);
});
