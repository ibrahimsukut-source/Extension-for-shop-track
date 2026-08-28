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

test("stats: real shop-analytics-stats shape (metrics_summary + traffic + listings)", () => {
  const body = {
    start_date: "08/26/2026",
    end_date: "08/26/2026",
    currency_filter: "TRY",
    traffic_breakdown: {
      etsy_traffic: {
        traffic_sources: [
          { short_key: "etsy", visits: 3 },
          { short_key: "etsysearch", visits: 0 },
          { short_key: "external_search", visits: 1 },
        ],
      },
      user_traffic: {
        traffic_sources: [
          { short_key: "other", visits: 9 },
          { short_key: "social", visits: 0 },
          { short_key: "etsyads", visits: 0 },
        ],
      },
    },
    metrics_summary: {
      visits: { total: "15" },
      orders: { total: "0" },
      revenue: { total: "0 TL", long_total: "0.00 TL" },
      conversion_rate: { total: "0%" },
    },
    listings: {
      section_header: "Shoppers viewed your listings 11 times",
      listings: [
        { id: 4448562066, title: "Slate", visits: "2", orders: "0", revenue: "0 TL", favorites: "0", badge_text: "Active" },
        { id: 1823771082, title: "Ornament", visits: "1", orders: "0", revenue: "0 TL", favorites: "0", badge_text: "Active" },
      ],
    },
  };
  const out = parseStats(body, ctx);
  assert.equal(out.statsDaily?.length, 1);
  const s = out.statsDaily![0];
  assert.equal(s.statDate, "2026-08-26");
  assert.equal(s.visits, 15);
  assert.equal(s.views, 11);
  assert.equal(s.orders, 0);
  assert.equal(s.revenue, 0);
  assert.equal(s.currency, "TRY");
  assert.equal(s.conversionRate, 0);
  assert.deepEqual(s.trafficSources, { etsy: 3, etsysearch: 0, external_search: 1, other: 9, social: 0, etsyads: 0 });
  // per-listing daily stats
  assert.equal(out.listingStatsDaily?.length, 2);
  assert.equal(out.listingStatsDaily![0].listingId, 4448562066);
  assert.equal(out.listingStatsDaily![0].visits, 2);
});

test("stats: conversion percent like '2.5%' becomes 0.025", () => {
  const body = {
    start_date: "08/26/2026",
    metrics_summary: { visits: { total: "100" }, orders: { total: "2" }, conversion_rate: { total: "2.5%" }, revenue: { total: "0 TL" } },
  };
  const out = parseStats(body, ctx);
  assert.equal(out.statsDaily![0].conversionRate, 0.025);
});

test("stats: a lone day object (not array-wrapped) still parses", () => {
  const out = parseStats({ shop_id: 12345, date: "2026-08-26", visits: 10, views: 42, orders: 2 }, ctx);
  assert.equal(out.statsDaily?.length, 1);
  assert.equal(out.statsDaily![0].statDate, "2026-08-26");
  assert.equal(out.statsDaily![0].visits, 10);
});

test("stats: entries with listing_id go to listing_stats_daily", () => {
  const out = parseStats({ stats: [{ date: "2026-08-26", listing_id: 42, views: 9, orders: 1 }] }, ctx);
  assert.equal(out.statsDaily?.length, 0);
  assert.equal(out.listingStatsDaily?.length, 1);
  assert.equal(out.listingStatsDaily![0].listingId, 42);
});

test("listing: extracts snapshot fields, price, image hashes (money-object shape)", () => {
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

test("listing: real Etsy shape — numeric state, string price, image_id, flags", () => {
  const real = {
    listing_id: 4448561758,
    title: "Custom Mommy and Baby Photo Stone Plaque",
    state: 0, // numeric!
    is_activateable: false,
    is_deactivateable: true,
    shop_section_id: 56895006,
    price_int: 198200,
    price: "1982.00",
    quantity: 993,
    tags: ["mother's day gift", "boy mama photo"],
    listing_images: [{ image_id: 7698388571, url: "https://i.etsystatic.com/…/il_fullxfull.jpg" }],
    inventory_min_price_with_symbol: "1,982 TL",
  };
  const out = parseListing([real], ctx); // bare array, as Etsy returns
  const s = out.listingSnapshots![0];
  assert.equal(s.listingId, 4448561758);
  assert.equal(s.state, "active"); // mapped from flags, not "0"
  assert.equal(s.price, 1982); // string price parsed
  assert.equal(s.currency, "TRY"); // inferred from "1,982 TL"
  assert.equal(s.quantity, 993);
  assert.equal(s.sectionId, 56895006);
  assert.equal(s.numImages, 1);
  assert.equal(s.imageHashes?.length, 1);
  assert.deepEqual(s.tags, ["mother's day gift", "boy mama photo"]);
});

test("listing: inactive when is_activateable is true", () => {
  const out = parseListing([{ listing_id: 9, state: 1, is_activateable: true, is_deactivateable: false, price: "10.00" }], ctx);
  assert.equal(out.listingSnapshots![0].state, "inactive");
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

test("ads: hourly click stats aggregate to daily clicks (comparisonStats ignored)", () => {
  const body = {
    comparisonStats: [{ clickCount: 5, timestamp: 1787630400 }], // previous period -> ignored
    stats: [
      { clickCount: 2, timestamp: 1787716800 },
      { clickCount: 3, timestamp: 1787720400 }, // same UTC day -> summed
    ],
  };
  const out = parseAds(body, ctx);
  assert.equal(out.adsDaily?.length, 1);
  assert.equal(out.adsDaily![0].clicks, 5);
  assert.equal(out.adsDaily![0].listingId, 0);
  assert.equal(out.adsDaily![0].spend, null);
  assert.equal(out.adsDaily![0].impressions, null);
});

test("messages: real message-list-data shape (flat, sender_id, direction unknown)", () => {
  const out = parseMessages(
    {
      messages: [
        {
          conversation_id: 1663517645,
          conversation_message_id: 7299322386,
          create_date: 1779258673,
          sender_id: 545415690,
          is_system_message: false,
          message: "<a href='...'>Order #4037780491</a> Hello Sierra",
        },
      ],
      rollups: [],
    },
    ctx
  );
  const t = out.messageThreads![0];
  assert.equal(t.threadId, "1663517645");
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].messageId, "7299322386");
  assert.equal(t.messages[0].senderId, 545415690);
  assert.equal(t.messages[0].hasText, true);
  assert.equal(t.messages[0].direction, null); // not labeled by this endpoint
  assert.ok(t.lastMessageAt?.startsWith("2026-05-20"));
});

test("parsers never throw on garbage input", () => {
  for (const p of [parseStats, parseListing, parseAds, parseOrder, parseReview, parseMessages]) {
    assert.doesNotThrow(() => p(null, ctx));
    assert.doesNotThrow(() => p({ nonsense: true }, ctx));
    assert.doesNotThrow(() => p([1, 2, "x"], ctx));
  }
});
