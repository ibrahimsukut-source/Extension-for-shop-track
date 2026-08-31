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
    usingDefaultToken: false,
    anthropicApiKey: "",
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

test("CORS: OPTIONS preflight to /ingest/http returns 204 without auth", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "OPTIONS",
    url: "/ingest/http",
    headers: { origin: "chrome-extension://abc", "access-control-request-method": "POST" },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "chrome-extension://abc");
  assert.match(String(res.headers["access-control-allow-headers"]), /authorization/i);
});

test("CORS: a real POST carries the allow-origin header", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/ingest/http",
    headers: { authorization: "Bearer tok_secret_123456", origin: "https://www.etsy.com" },
    payload: { records: [validRecord] },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers["access-control-allow-origin"], "https://www.etsy.com");
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

test("GET /analysis/summary is gated when DASHBOARD_KEY is set, works as JSON and Markdown when open", async () => {
  const { app: gated } = makeApp({ dashboardKey: "s3cret" });
  assert.equal((await gated.inject({ method: "GET", url: "/analysis/summary" })).statusCode, 401);

  const { app } = makeApp();
  const json = await app.inject({ method: "GET", url: "/analysis/summary" });
  assert.equal(json.statusCode, 200);
  assert.ok(Array.isArray(json.json().shops));

  const md = await app.inject({ method: "GET", url: "/analysis/summary?format=md" });
  assert.equal(md.statusCode, 200);
  assert.match(md.headers["content-type"] ?? "", /text\/markdown/);
  assert.match(md.body, /Etsy Mağaza Analiz Özeti/);
});

test("GET /analysis/ask/status reports disabled without ANTHROPIC_API_KEY, enabled with one", async () => {
  const { app: off } = makeApp();
  assert.deepEqual((await off.inject({ method: "GET", url: "/analysis/ask/status" })).json(), { enabled: false });

  const { app: on } = makeApp({ anthropicApiKey: "sk-ant-fake-for-test" });
  assert.deepEqual((await on.inject({ method: "GET", url: "/analysis/ask/status" })).json(), { enabled: true });
});

test("POST /analysis/ask returns enabled:false without a network call when no API key is configured", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/analysis/ask", payload: { question: "test?" } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, false);
  assert.ok(body.error);
});

test("POST /analysis/ask rejects an empty question with a validation error", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/analysis/ask", payload: { question: "" } });
  assert.equal(res.statusCode, 400);
});

test("POST /analysis/ask is gated when DASHBOARD_KEY is set", async () => {
  const { app } = makeApp({ dashboardKey: "s3cret" });
  const res = await app.inject({ method: "POST", url: "/analysis/ask", payload: { question: "test?" } });
  assert.equal(res.statusCode, 401);
});
