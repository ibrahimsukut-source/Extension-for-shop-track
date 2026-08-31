import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDedupKey } from "../src/lib/dedup.js";

const base = {
  shopId: "123",
  captureType: "stats",
  key: "https://www.etsy.com/x/stats",
  body: '{"visits":10}',
  capturedAtMs: 1_700_000_100_000, // aligned to a 5-min (300000 ms) bucket boundary
};

test("makeDedupKey: deterministic for identical input", () => {
  assert.equal(makeDedupKey(base), makeDedupKey(base));
});

test("makeDedupKey: same 5-min bucket collapses", () => {
  const a = makeDedupKey(base);
  const b = makeDedupKey({ ...base, capturedAtMs: base.capturedAtMs + 4 * 60 * 1000 });
  assert.equal(a, b);
});

test("makeDedupKey: different body -> different key", () => {
  assert.notEqual(makeDedupKey(base), makeDedupKey({ ...base, body: '{"visits":11}' }));
});

test("makeDedupKey: different shop -> different key", () => {
  assert.notEqual(makeDedupKey(base), makeDedupKey({ ...base, shopId: "999" }));
});
