// End-to-end test of the command-center agent in real Chromium:
//   central API (real server, in-memory DB) ⇄ extension service worker ⇄ worker tab
//   on a FAKE www.etsy.com (served by Playwright routing, never the real site).
//
// Covers: poll + lease, worker-tab navigation, page-runner injection, snake→camel
// normalization, pagination, write call with CSRF header + verification, result
// storage, and the command center's view of it all.
//
//   npm run build && xvfb-run -a node e2e/agent.mjs
import { chromium } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const apiDir = path.resolve(here, "../../api");
const PORT = 8187;
const CENTER = `http://127.0.0.1:${PORT}`;
const TOKEN = "tok_e2e_shop_123456";
const ADMIN = { "x-admin-key": "e2e-admin" };

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  return execSync(`ls -d ${base}/chromium-*/chrome-linux*/chrome | head -1`).toString().trim();
}

// ── Fake Etsy ────────────────────────────────────────────────────────────
const SHOP = 777;
const promoted = new Map([[101, true], [102, true], [103, false]]);
const writes = [];
const listingRow = (id) => ({
  listing: { listing_id: id, title: `Fake listing ${id}`, is_promoted: promoted.get(id), price_int: 2500, currency_code: "USD", quantity: 3, section_name: "Tees", listing_strategy: { strategy: 1 } },
  total_stats: { impression_count: 1000 * id, click_count: 10, spent_total: id === 102 ? 1800 : 900, conversions: id === 102 ? 0 : 2, revenue: id === 102 ? 0 : 5000, click_rate: 1, roas: id === 102 ? 0 : 5.5 },
});
function page(initialData) {
  return `<!doctype html><html><head><meta name="csrf_nonce" content="csrf-xyz"></head><body>fake shop manager
  <script>window.Etsy={Context:{data:{shop_id:${SHOP},shop_name:"FakeShop",locale_settings:{currency:{code:"USD"},language:{code:"en-US"}},initial_data:${JSON.stringify(initialData)}}}};</script></body></html>`;
}
async function fakeEtsy(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  const p = url.pathname;
  if (p === "/your/shops/me/dashboard" || p === "/your/shops/me/advertising") {
    return route.fulfill({ contentType: "text/html", body: page({ etsyAds: { campaignMinBudget: { budgetInCents: 100 }, campaignMaxBudget: { budgetInCents: 20000 }, promotedListingsCount: 2 } }) });
  }
  if (p === "/your/shops/me/stats") {
    return route.fulfill({
      contentType: "text/html",
      body: page({
        selected_date_range: { key: url.searchParams.get("date_range") },
        start_date: "10/17/2026",
        end_date: "11/15/2026",
        metrics_summary: { visits: { total: "2,163", entries: [{ value: 73, timestamp: 1792195200 }] }, orders: { total: "15", entries: [{ value: 1, timestamp: 1792195200 }] } },
        traffic_breakdown: { etsy_traffic: { subtitle: "From Etsy (73%)", traffic_sources: [{ short_key: "etsy", display_name: "Etsy app & other", visits: 729 }] }, user_traffic: { traffic_sources: [] } },
        listings: { listings: [{ id: 101, title: "Fake listing 101", visits: "344", orders: "2", revenue: "$50", favorites: "2" }], pagination: { total_count: 3 } },
      }),
    });
  }
  const api = `/api/v3/ajax/shop/${SHOP}`;
  if (p === `${api}/prolist/campaign`) return json({ total_daily_budget: 5000, is_active: true, status: 1 });
  if (p === `${api}/prolist/stats`) {
    return json({ granularity: "day", graph_stats: [{ impression_count: 333, click_count: 1, spent_total: 108, conversions: 1, revenue: 1850, roas: 17.13, timestamp: 1792123200 }], total_stats: { impression_count: 3000, click_count: 30, spent_total: 3600, conversions: 4, revenue: 10000 } });
  }
  if (p === `${api}/prolist/stats/listings`) {
    const want = url.searchParams.get("is_promoted") === "true";
    const offset = Number(url.searchParams.get("offset"));
    const all = [...promoted.keys()].filter((id) => promoted.get(id) === want);
    // Page size 1 to exercise pagination.
    return json({ filtered_listing_count: all.length, listings: all.slice(offset, offset + 1).map(listingRow) });
  }
  if (p.startsWith(`${api}/prolist/stats/listings/`)) {
    const id = Number(p.split("/").pop());
    return json({ listing: listingRow(id).listing, total_stats: listingRow(id).total_stats });
  }
  if (p.startsWith(`${api}/prolist/listings/querystats/`)) {
    return json({ query_stats: [{ stemmed_query: "funny tee", impression_counts: 50, click_count: 6, order_count: 0, cost: 400, revenue: 0, roas: 0, click_rate: 12, is_relevant: true }] });
  }
  if (p === `${api}/prolist/listings` && req.method() === "POST") {
    assert.equal(req.headers()["x-csrf-token"], "csrf-xyz", "write must carry the CSRF token");
    const body = req.postDataJSON();
    writes.push(body);
    for (const [id, v] of Object.entries(body.listings)) promoted.set(Number(id), v);
    return json({ listings: body.listings, countOfAdvertisedListings: [...promoted.values()].filter(Boolean).length });
  }
  return route.fulfill({ status: 404, body: "fake etsy: unknown " + p });
}

// ── Run ──────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: apiDir,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATABASE_URL: "memory", INGEST_TOKENS: JSON.stringify({ "fake-shop": TOKEN }), ADMIN_KEY: "e2e-admin", COLLECT_EVERY_HOURS: "0" },
  stdio: ["ignore", "ignore", "inherit"],
});
const until = async (fn, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) {
      await globalThis.__dump?.().catch((e) => console.log("dump failed", e.message));
      throw new Error("timeout");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
};
const center = async (p, opts = {}) =>
  (await fetch(CENTER + p, { ...opts, headers: { ...ADMIN, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } })).json();

let ctx;
try {
  await until(async () => (await fetch(`${CENTER}/health`)).ok, 30000);
  ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "agent-e2e-")), {
    executablePath: chromePath(),
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await ctx.route("https://www.etsy.com/**", fakeEtsy);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(
    ([host, token]) => chrome.storage.local.set({ settings: { apiHost: host, apiToken: token, shopTag: "fake-shop", agentEnabled: true } }),
    [CENTER, TOKEN]
  );
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  const tick = () => options.evaluate(() => chrome.runtime.sendMessage({ type: "AGENT_RUN_NOW" }));
  const dump = async () => {
    console.log("agent:", JSON.stringify(await options.evaluate(() => chrome.runtime.sendMessage({ type: "AGENT_STATUS" }))));
    console.log("jobs:", JSON.stringify((await center("/admin/v1/jobs")).jobs.map((j) => [j.id, j.kind, j.status, j.error])));
    console.log("pages:", ctx.pages().map((p) => p.url()));
  };
  globalThis.__dump = dump;
  console.log("ext", extId);

  // 1) Collection.
  await center("/admin/v1/jobs", { method: "POST", body: JSON.stringify({ shopTag: "fake-shop", kind: "collect.ads", params: { queryTopN: 2 } }) });
  await center("/admin/v1/jobs", { method: "POST", body: JSON.stringify({ shopTag: "fake-shop", kind: "collect.shop_stats", params: {} }) });
  console.log('tick1');
  await tick();
  console.log('tick1 done');
  const jobs = await until(async () => {
    const j = (await center("/admin/v1/jobs?shop_tag=fake-shop")).jobs;
    return j.every((x) => ["done", "failed"].includes(x.status)) && j.length >= 2 ? j : null;
  });
  for (const j of jobs) assert.equal(j.status, "done", `${j.kind} failed: ${j.error}`);
  const ads = await center("/admin/v1/shops/fake-shop/ads");
  assert.equal(ads.campaign.budget_cents, 5000);
  assert.equal(ads.listings.length, 3, "pagination must collect promoted + not promoted listings");
  assert.equal(ads.listings.find((l) => Number(l.listing_id) === 102).spend_cents, 1800);
  const stats = await center("/admin/v1/shops/fake-shop/stats");
  assert.equal(stats.stats[0].visits, 2163);
  const ov = await center("/admin/v1/overview");
  assert.equal(ov.shops[0].agent.shop_name, "FakeShop");
  assert.equal(ov.shops[0].agent.logged_in, true);

  // 2) A write: turn the ad off for listing 102 (the one spending with 0 orders).
  const sugg = (await center("/admin/v1/suggestions?shop_tag=fake-shop")).suggestions;
  const zero = sugg.find((s) => s.rule === "ads.zero_sale_spend" && s.target_key === "102");
  assert.ok(zero, "rule engine should flag listing 102");
  console.log("accept:", JSON.stringify(await center(`/admin/v1/suggestions/${zero.id}/accept`, { method: "POST" })));
  await tick();
  const acts = await until(async () => {
    const a = (await center("/admin/v1/actions?shop_tag=fake-shop")).actions;
    return a.length ? a : null;
  });
  assert.equal(acts[0].action, "ads.set_promoted");
  assert.equal(acts[0].verified, true);
  assert.deepEqual(writes, [{ listings: { 102: false } }]);
  assert.equal(promoted.get(102), false);
  const after = await center("/admin/v1/shops/fake-shop/ads");
  assert.equal(after.listings.find((l) => Number(l.listing_id) === 102).is_promoted, false);
  console.log("agent e2e: OK — collect.ads, collect.shop_stats, suggestion → verified ad-off write");
} finally {
  await ctx?.close().catch(() => {});
  server.kill();
}
