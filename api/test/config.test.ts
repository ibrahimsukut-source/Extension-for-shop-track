import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTokens } from "../src/config.js";

test("parseTokens: builds reverse token->shop map", () => {
  const map = parseTokens('{"shop-a":"tok_aaaaaaaa","shop-b":"tok_bbbbbbbb"}');
  assert.equal(map.get("tok_aaaaaaaa"), "shop-a");
  assert.equal(map.get("tok_bbbbbbbb"), "shop-b");
  assert.equal(map.size, 2);
});

test("parseTokens: empty / undefined yields empty map", () => {
  assert.equal(parseTokens(undefined).size, 0);
  assert.equal(parseTokens("").size, 0);
});

test("parseTokens: rejects invalid JSON", () => {
  assert.throws(() => parseTokens("not json"), /valid JSON/);
});

test("parseTokens: rejects non-object", () => {
  assert.throws(() => parseTokens('["a","b"]'), /JSON object/);
});

test("parseTokens: rejects short tokens", () => {
  assert.throws(() => parseTokens('{"shop":"short"}'), />= 8 chars/);
});

test("parseTokens: rejects duplicate tokens across shops", () => {
  assert.throws(() => parseTokens('{"a":"tok_samesame","b":"tok_samesame"}'), /duplicate token/);
});
