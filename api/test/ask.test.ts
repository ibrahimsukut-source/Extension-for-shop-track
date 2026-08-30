// P3 verification: NL question interface gating logic (no live network call —
// these only exercise the paths that return before touching the Anthropic API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { askEnabled, askQuestion } from "../src/analysis/ask.js";

test("askEnabled: empty/whitespace key -> false, real-looking key -> true", () => {
  assert.equal(askEnabled(""), false);
  assert.equal(askEnabled("   "), false);
  assert.equal(askEnabled("sk-ant-something"), true);
});

test("askQuestion: no API key -> disabled, no network call attempted", async () => {
  const pool = makeTestPool();
  const result = await askQuestion(pool, "", "fiyat değişikliği işe yaradı mı?");
  assert.equal(result.enabled, false);
  assert.ok(result.error);
});

test("askQuestion: blank question -> rejected before building any context", async () => {
  const pool = makeTestPool();
  const result = await askQuestion(pool, "sk-ant-fake-for-test", "   ");
  assert.equal(result.enabled, true);
  assert.ok(result.error);
});
