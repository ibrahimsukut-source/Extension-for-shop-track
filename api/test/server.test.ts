import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestPool } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { parseTokens, type Config } from "../src/config.js";

function makeApp(over: Partial<Config> = {}) {
  const pool = makeTestPool();
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "unused",
    tokenToShop: parseTokens('{"shop-a":"tok_secret_123456"}'),
    maxBatch: 3,
    autoParse: false,
    dashboardKey: "",
    ...over,
  };
  return { app: buildServer({ pool, config }), pool };
}

const validRecord = {
  captureType: "stats",
  url: "https://www.etsy.com/x/stats",
  status: 200,
  body: { visits: 1 },
  capturedAt: "2026-08-27T10:00:00.000Z",
  dedupKey: "dk_valid_0001",
};

test("GET /health is open", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("GET / serves the dashboard HTML", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] ?? "", /text\/html/);
  assert.match(res.body, /Etsy Shop Tracker/);
});

test("GET /dashboard/data is gated when DASHBOARD_KEY is set", async () => {
  const { app } = makeApp({ dashboardKey: "s3cret" });
  assert.equal((await app.inject({ method: "GET", url: "/dashboard/data" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/dashboard/data?key=wrong" })).statusCode, 401);
});

test("POST /ingest/http rejects missing token with 401", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    payload: { records: [validRecord] },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /ingest/http rejects wrong token with 401", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    headers: { authorization: "Bearer nope" },
    payload: { records: [validRecord] },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /ingest/http accepts a valid batch with 202", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    headers: { authorization: "Bearer tok_secret_123456" },
    payload: { records: [validRecord] },
  });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { accepted: 1, duplicates: 0, total: 1 });
});

test("POST /ingest/http rejects invalid payload with 400", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    headers: { authorization: "Bearer tok_secret_123456" },
    payload: { records: [{ captureType: "stats" }] }, // missing required fields
  });
  assert.equal(res.statusCode, 400);
});

test("POST /ingest/http rejects an oversized batch with 413", async () => {
  const { app } = makeApp();
  const records = Array.from({ length: 4 }, (_, i) => ({
    ...validRecord,
    dedupKey: `dk_oversize_${i}`,
  }));
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    headers: { authorization: "Bearer tok_secret_123456" },
    payload: { records },
  });
  assert.equal(res.statusCode, 413);
});
