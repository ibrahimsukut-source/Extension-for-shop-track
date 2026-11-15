import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTestPool } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { defaultAgentConfig, parseTokens, type Config } from "../src/config.js";
import { rangeDates, validateJob, DEFAULT_LIMITS } from "../src/agent/jobs.js";
import { fileModuleStore, signedPayload } from "../src/agent/modules.js";

const TOKEN = "tok_shop_a_123456";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ADMIN = { "x-admin-key": "admin-secret" };

function makeApp(agent: Partial<Config["agent"]> = {}) {
  const pool = makeTestPool();
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "unused",
    tokenToShop: parseTokens(`{"shop-a":"${TOKEN}"}`),
    maxBatch: 500,
    autoParse: false,
    dashboardKey: "",
    usingDefaultToken: false,
    anthropicApiKey: "",
    agent: { ...defaultAgentConfig(), adminKey: "admin-secret", ...agent },
  };
  return { app: buildServer({ pool, config }), pool };
}

const listing = (id: number, promoted: boolean, spend: number, orders: number, revenue: number) => ({
  listing: { listingId: id, title: `Listing ${id}`, isPromoted: promoted, priceInt: 69900, currencyCode: "TRY", quantity: 5, sectionName: "Birthday", listingStrategy: { strategy: 1 } },
  totalStats: { impressionCount: 2000, clickCount: 40, spentTotal: spend, conversions: orders, revenue, clickRate: 2, roas: spend ? revenue / spend : 0 },
});

const adsResult = {
  shop: { id: 23861781, name: "OldCityCherry", currency: "USD" },
  range: { start: "2026-10-16", end: "2026-11-15" },
  campaign: { totalDailyBudget: 5000, isActive: true, status: 1 },
  minBudgetCents: 100,
  maxBudgetCents: 20000,
  promotedCount: 2,
  shopStats: {
    startDate: "2026-10-16",
    endDate: "2026-11-15",
    granularity: "day",
    graphStats: [
      { impressionCount: 333, clickCount: 1, spentTotal: 108, conversions: 1, revenue: 1850, roas: 17.13, timestamp: 1792123200 },
      { impressionCount: 515, clickCount: 2, spentTotal: 583, conversions: 0, revenue: 0, roas: 0, timestamp: 1792209600 },
    ],
    totalStats: { impressionCount: 19899, clickCount: 230, spentTotal: 22640, conversions: 15, revenue: 54431, roas: 2.4 },
  },
  listings: [listing(111, true, 4810, 6, 19347), listing(222, true, 1500, 0, 0), listing(333, false, 0, 0, 0)],
  yesterday: { date: "2026-11-14", listings: [listing(111, true, 210, 1, 2149)] },
  queries: {
    "111": [
      { stemmed_query: "70th birthday shirt", impression_counts: 300, click_count: 9, order_count: 0, cost: 450, revenue: 0, roas: 0, click_rate: 3, is_relevant: true },
      { stemmed_query: "mens 70th birthday", impression_counts: 9, click_count: 1, order_count: 1, cost: 20, revenue: 2149, roas: 107, click_rate: 11.1, is_relevant: true },
    ],
  },
};

async function pollJob(app: ReturnType<typeof makeApp>["app"], body: Record<string, unknown> = { loggedIn: true }) {
  const res = await app.inject({ method: "POST", url: "/agent/v1/poll", headers: AUTH, payload: body });
  assert.equal(res.statusCode, 200);
  return res.json();
}

test("agent poll rejects unknown tokens", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/agent/v1/poll", headers: { authorization: "Bearer nope" }, payload: {} });
  assert.equal(res.statusCode, 401);
});

test("poll auto-schedules collection, leases one job at a time, write jobs first", async () => {
  const { app } = makeApp();
  // A manual write job created before the first poll must still run first.
  const created = await app.inject({
    method: "POST",
    url: "/admin/v1/jobs",
    headers: ADMIN,
    payload: { shopTag: "shop-a", kind: "ads.set_promoted", params: { listingIds: [111], promoted: false } },
  });
  assert.equal(created.statusCode, 201);
  const first = await pollJob(app);
  assert.equal(first.job.kind, "ads.set_promoted");
  // Same shop, job still leased → nothing else handed out.
  const second = await pollJob(app);
  assert.equal(second.job, null);
  const jobs = (await app.inject({ method: "GET", url: "/admin/v1/jobs?shop_tag=shop-a", headers: ADMIN })).json().jobs;
  assert.deepEqual(jobs.map((j: any) => j.kind).sort(), ["ads.set_promoted", "collect.ads", "collect.shop_stats"]);
});

test("logged-out agents get no jobs and nothing is scheduled", async () => {
  const { app } = makeApp();
  const r = await pollJob(app, { loggedIn: false });
  assert.equal(r.job, null);
  const jobs = (await app.inject({ method: "GET", url: "/admin/v1/jobs", headers: ADMIN })).json().jobs;
  assert.equal(jobs.length, 0);
});

test("collect.ads result fills latest tables, ads_daily and suggestions", async () => {
  const { app, pool } = makeApp({ collectEveryHours: 0 });
  await app.inject({ method: "POST", url: "/admin/v1/jobs", headers: ADMIN, payload: { shopTag: "shop-a", kind: "collect.ads", params: {} } });
  const { job } = await pollJob(app);
  assert.equal(job.kind, "collect.ads");
  assert.equal(job.params.range, "last_30"); // defaults applied server-side
  const res = await app.inject({ method: "POST", url: `/agent/v1/jobs/${job.id}/result`, headers: AUTH, payload: { ok: true, result: adsResult } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().summary.listings, 3);
  assert.equal(res.json().summary.queries, 2);

  const ads = (await app.inject({ method: "GET", url: "/admin/v1/shops/shop-a/ads", headers: ADMIN })).json();
  assert.equal(ads.campaign.budget_cents, 5000);
  assert.equal(Number(ads.listings[0].listing_id), 111); // sorted by spend
  assert.equal(ads.queryCounts["111"], 2);

  const daily = (await pool.query(`SELECT * FROM ads_daily WHERE listing_id = 111`)).rows;
  assert.equal(daily.length, 1);
  assert.equal(Number(daily[0].spend), 2.1);

  const sugg = (await app.inject({ method: "GET", url: "/admin/v1/suggestions", headers: ADMIN })).json().suggestions;
  const rules = sugg.map((s: any) => `${s.rule}:${s.target_key}`).sort();
  assert.deepEqual(rules, ["ads.wasted_query:111:70th birthday shirt", "ads.zero_sale_spend:222"]);

  // Re-running the rules with the same data must not duplicate suggestions.
  await app.inject({ method: "POST", url: "/admin/v1/rules/run", headers: ADMIN });
  const again = (await app.inject({ method: "GET", url: "/admin/v1/suggestions", headers: ADMIN })).json().suggestions;
  assert.equal(again.length, 2);
});

test("accepting a suggestion queues the job; the verified result updates state + action log", async () => {
  const { app } = makeApp({ collectEveryHours: 0 });
  await app.inject({ method: "POST", url: "/admin/v1/jobs", headers: ADMIN, payload: { shopTag: "shop-a", kind: "collect.ads", params: {} } });
  const { job } = await pollJob(app);
  await app.inject({ method: "POST", url: `/agent/v1/jobs/${job.id}/result`, headers: AUTH, payload: { ok: true, result: adsResult } });
  const sugg = (await app.inject({ method: "GET", url: "/admin/v1/suggestions", headers: ADMIN })).json().suggestions;
  const off = sugg.find((s: any) => s.rule === "ads.zero_sale_spend");
  const acc = await app.inject({ method: "POST", url: `/admin/v1/suggestions/${off.id}/accept`, headers: ADMIN });
  assert.equal(acc.statusCode, 200);

  const next = await pollJob(app);
  assert.equal(next.job.kind, "ads.set_promoted");
  assert.deepEqual(next.job.params, { listingIds: [222], promoted: false });
  const write = await app.inject({
    method: "POST",
    url: `/agent/v1/jobs/${next.job.id}/result`,
    headers: AUTH,
    payload: {
      ok: true,
      result: {
        actions: [{ action: "ads.set_promoted", target: "222", before: { promoted: true }, after: { promoted: false }, verified: true }],
        captures: [{ url: "/api/v3/ajax/shop/23861781/prolist/listings", status: 200, body: { listings: { "222": false }, countOfAdvertisedListings: 167 } }],
      },
    },
  });
  assert.equal(write.statusCode, 200);
  const ads = (await app.inject({ method: "GET", url: "/admin/v1/shops/shop-a/ads", headers: ADMIN })).json();
  assert.equal(ads.listings.find((l: any) => Number(l.listing_id) === 222).is_promoted, false);
  const actions = (await app.inject({ method: "GET", url: "/admin/v1/actions", headers: ADMIN })).json().actions;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].verified, true);
  const s2 = (await app.inject({ method: "GET", url: "/admin/v1/suggestions", headers: ADMIN })).json().suggestions;
  assert.ok(!s2.some((s: any) => s.id === off.id)); // no longer open
});

test("job validation: budget writes gated, caps enforced, unknown shop/kind rejected", async () => {
  const { app } = makeApp();
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/admin/v1/jobs", headers: ADMIN, payload });
  assert.equal((await post({ shopTag: "shop-a", kind: "ads.set_budget", params: { dailyBudgetUsd: 40 } })).statusCode, 400);
  assert.equal((await post({ shopTag: "shop-x", kind: "collect.ads" })).statusCode, 400);
  assert.equal((await post({ shopTag: "shop-a", kind: "shell.exec" })).statusCode, 400);
  assert.equal((await post({ shopTag: "shop-a", kind: "ads.set_promoted", params: { listingIds: [], promoted: true } })).statusCode, 400);
  const v = validateJob("ads.set_budget", { dailyBudgetUsd: 500 }, { ...DEFAULT_LIMITS, budgetWriteEnabled: true });
  assert.equal(v.ok, false);
  const ok = validateJob("ads.set_budget", { dailyBudgetUsd: 60 }, { ...DEFAULT_LIMITS, budgetWriteEnabled: true });
  assert.equal(ok.ok, true);
});

test("admin endpoints need the admin key", async () => {
  const { app } = makeApp();
  assert.equal((await app.inject({ method: "GET", url: "/admin/v1/overview" })).statusCode, 401);
  const ov = await app.inject({ method: "GET", url: "/admin/v1/overview", headers: ADMIN });
  assert.equal(ov.statusCode, 200);
  assert.equal(ov.json().shops[0].shopTag, "shop-a");
});

test("paused agents get no jobs", async () => {
  const { app } = makeApp();
  await app.inject({ method: "POST", url: "/admin/v1/agents/shop-a/pause", headers: ADMIN, payload: { paused: true } });
  const r = await pollJob(app);
  assert.equal(r.paused, true);
  assert.equal(r.job, null);
});

test("remote runner modules are signed so the extension's WebCrypto check accepts them", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dir = mkdtempSync(path.join(tmpdir(), "mod-"));
  const file = path.join(dir, "page-runner.js");
  writeFileSync(file, "/*! oc-runner 2026.11.20-3 */\nglobalThis.__ocAgent={};");
  const store = fileModuleStore(file, privateKey.export({ type: "pkcs8", format: "pem" }) as string)!;
  assert.deepEqual(await store.manifest(), { name: "page-runner", version: "2026.11.20-3" });
  const mod = (await store.get("page-runner"))!;
  const key = await webcrypto.subtle.importKey("spki", publicKey.export({ type: "spki", format: "der" }), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sig = Buffer.from(mod.sig, "base64");
  assert.equal(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signedPayload(mod.name, mod.version, mod.code)), true);
  // Tampered code must not verify.
  assert.equal(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signedPayload(mod.name, mod.version, mod.code + "x")), false);
});

test("rangeDates matches Etsy Ads' own date windows (US Eastern)", () => {
  const now = new Date("2026-11-15T22:00:00Z"); // 17:00 ET, Nov 15
  assert.deepEqual(rangeDates("last_30", now), { start: "2026-10-16", end: "2026-11-15" });
  assert.deepEqual(rangeDates("yesterday", now), { start: "2026-11-14", end: "2026-11-14" });
  assert.deepEqual(rangeDates("last_month", now), { start: "2026-10-01", end: "2026-10-31" });
});
