import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStats } from "../src/parsers/stats.js";
import { parseListing } from "../src/parsers/listing.js";
import { parseAds } from "../src/parsers/ads.js";
import { parseOrder } from "../src/parsers/order.js";
import { parseReview } from "../src/parsers/review.js";
import { parseMessages } from "../src/parsers/messages.js";

const ctx = { shopId: 1, capturedAt: "2026-08-27T10:00:00.000Z" };

test("stats: extracts daily rows and computes conversion", () => {
  const out = parseStats(
    { results: [{ date: "2026-08-26", visits: 100, views: 250, orders: 5, revenue: { amount: 12345, divisor: 100, currency_code: "USD" }, traffic_sources: { etsy_search: 60 } }] },
    ctx
  );
  assert.equal(out.statsDaily?.length, 1);
  const r = out.statsDaily![0];
  assert.equal(r.statDate, "2026-08-26");
  assert.equal(r.visits, 100);
  assert.equal(r.revenue, 123.45);
  assert.equal(r.currency, "USD");
  assert.equal(r.conversionRate, 0.05); // 5/100
  assert.deepEqual(r.trafficSources, { etsy_search: 60 });
});

test("stats: entries with listing_id go to listing_stats_daily", () => {
  const out = parseStats({ stats: [{ date: "2026-08-26", listing_id: 42, views: 9, orders: 1 }] }, ctx);
  assert.equal(out.statsDaily?.length, 0);
  assert.equal(out.listingStatsDaily?.length, 1);
  assert.equal(out.listingStatsDaily![0].listingId, 42);
});

test("listing: extracts snapshot fields, price, image hashes", () => {
  const out = parseListing(
    { listings: [{ listing_id: 7, title: "Mug", state: "active", price: { amount: 2000, divisor: 100 }, quantity: 3, tags: ["a", "b"], images: [{ url: "u1" }, { url: "u2" }], num_favorers: 12 }] },
    ctx
  );
  const s = out.listingSnapshots![0];
  assert.equal(s.listingId, 7);
  assert.equal(s.price, 20);
  assert.equal(s.state, "active");
  assert.equal(s.numImages, 2);
  assert.equal(s.imageHashes?.length, 2);
  assert.deepEqual(s.tags, ["a", "b"]);
  assert.equal(s.favorites, 12);
});

test("listing: entry without id is skipped", () => {
  const out = parseListing({ listings: [{ title: "no id" }] }, ctx);
  assert.equal(out.listingSnapshots?.length, 0);
});

test("ads: shop-total row uses sentinel listing_id 0", () => {
  const out = parseAds({ ads: [{ date: "2026-08-26", spend: { amount: 500, divisor: 100 }, impressions: 1000, clicks: 30 }] }, ctx);
  const a = out.adsDaily![0];
  assert.equal(a.listingId, 0);
  assert.equal(a.spend, 5);
  assert.equal(a.impressions, 1000);
});

test("order: extracts order + items and hashes buyer PII", () => {
  const out = parseOrder(
    { receipts: [{ receipt_id: 555, created_timestamp: 1756288800, grandtotal: { amount: 3000, divisor: 100, currency_code: "USD" }, buyer_user_id: 99, buyer_email: "a@b.com", status: "paid", transactions: [{ listing_id: 7, quantity: 2, price: { amount: 1500, divisor: 100 } }] }] },
    ctx
  );
  const o = out.orders![0];
  assert.equal(o.receiptId, 555);
  assert.equal(o.total, 30);
  assert.equal(o.currency, "USD");
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].listingId, 7);
  assert.match(o.buyerHash!, /^[0-9a-f]{32}$/); // hashed, not raw
  assert.ok(!JSON.stringify(o.buyerHash).includes("a@b.com"));
});

test("review: falls back to composite id when none present", () => {
  const out = parseReview({ reviews: [{ listing_id: 7, rating: 5, review: "great", create_timestamp: 1756288800 }] }, ctx);
  const r = out.reviews![0];
  assert.equal(r.rating, 5);
  assert.equal(r.listingId, 7);
  assert.ok(r.reviewId.includes("7:"));
});

test("messages: direction, has_text, last_message_at", () => {
  const out = parseMessages(
    { conversations: [{ conversation_id: "t1", buyer_user_id: 99, messages: [
      { message_id: "m1", is_from_seller: false, created_timestamp: 1756288800, message: "hi" },
      { message_id: "m2", is_from_seller: true, created_timestamp: 1756292400, message: "hello" },
    ] }] },
    ctx
  );
  const t = out.messageThreads![0];
  assert.equal(t.threadId, "t1");
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].direction, "in");
  assert.equal(t.messages[1].direction, "out");
  assert.equal(t.messages[0].hasText, true);
  assert.equal(t.buyerHash?.length, 32);
});

test("parsers never throw on garbage input", () => {
  for (const p of [parseStats, parseListing, parseAds, parseOrder, parseReview, parseMessages]) {
    assert.doesNotThrow(() => p(null, ctx));
    assert.doesNotThrow(() => p({ nonsense: true }, ctx));
    assert.doesNotThrow(() => p([1, 2, "x"], ctx));
  }
});
