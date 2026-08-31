import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, type PriorSnapshot } from "../src/parse/diff.js";
import type { ListingSnapshotRow } from "../src/parsers/types.js";

const at = "2026-08-27T10:00:00.000Z";

function snap(over: Partial<ListingSnapshotRow>): ListingSnapshotRow {
  return {
    listingId: 7,
    title: "Mug",
    state: "active",
    price: 20,
    currency: "USD",
    quantity: 3,
    tags: ["a", "b"],
    numImages: 2,
    imageHashes: ["h1", "h2"],
    sectionId: null,
    views: null,
    favorites: null,
    raw: {},
    ...over,
  };
}

const prior: PriorSnapshot = {
  state: "active",
  price: 20,
  title: "Mug",
  tags: ["a", "b"],
  numImages: 2,
  imageHashes: ["h1", "h2"],
  quantity: 5,
};

test("no changes -> no events", () => {
  assert.deepEqual(diffSnapshots(prior, snap({}), at), []);
});

test("price change", () => {
  const evs = diffSnapshots(prior, snap({ price: 25 }), at);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].eventType, "price_change");
  assert.deepEqual(evs[0].payload, { old: 20, new: 25 });
});

test("deactivate vs activate vs generic state_change", () => {
  assert.equal(diffSnapshots(prior, snap({ state: "inactive" }), at)[0].eventType, "deactivated");
  assert.equal(diffSnapshots({ ...prior, state: "inactive" }, snap({ state: "active" }), at)[0].eventType, "activated");
  assert.equal(diffSnapshots({ ...prior, state: "draft" }, snap({ state: "expired" }), at)[0].eventType, "state_change");
});

test("photo change by count and by hash set", () => {
  assert.equal(diffSnapshots(prior, snap({ numImages: 3, imageHashes: ["h1", "h2", "h3"] }), at)[0].eventType, "photo_changed");
  assert.equal(diffSnapshots(prior, snap({ imageHashes: ["h1", "h9"] }), at)[0].eventType, "photo_changed");
});

test("tag change ignores order", () => {
  assert.deepEqual(diffSnapshots(prior, snap({ tags: ["b", "a"] }), at), []);
  assert.equal(diffSnapshots(prior, snap({ tags: ["a", "c"] }), at)[0].eventType, "tag_change");
});

test("title change", () => {
  assert.equal(diffSnapshots(prior, snap({ title: "Mug v2" }), at)[0].eventType, "title_change");
});

test("nulls on either side suppress a diff (missing != changed)", () => {
  assert.deepEqual(diffSnapshots({ ...prior, price: null }, snap({ price: 25 }), at), []);
  assert.deepEqual(diffSnapshots(prior, snap({ price: null }), at), []);
});
