// Opt-in end-to-end test of the extension's interception pipeline in real
// Chromium: interceptor.js (MAIN) -> bridge.js (ISOLATED) -> background.js (SW)
// capture, classify, resolve shop_id, and persist to chrome.storage.local.
//
// Requires a Chromium binary and playwright-core (a devDependency). Run with:
//   npm run build && npm run test:e2e
// Override the browser with CHROME_PATH=/path/to/chrome (defaults to the
// Playwright-managed Chromium when present). Extensions load reliably in headful
// mode, so on a headless box run under a virtual display: `xvfb-run -a npm run test:e2e`.
import { chromium } from "playwright-core";
import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../dist");

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  // pick the newest chromium-* build under the browsers path
  try {
    const dirs = execSync(`ls -d ${base}/chromium-*/chrome-linux/chrome 2>/dev/null`).toString().trim().split("\n");
    if (dirs[0]) return dirs[0];
  } catch {
    /* fall through */
  }
  throw new Error("No Chromium found. Set CHROME_PATH=/path/to/chrome.");
}

/** Copy dist to a temp dir and widen content-script matches to the test origin. */
function buildTestExtension() {
  if (!existsSync(distDir)) throw new Error("dist/ not found — run `npm run build` first.");
  const dir = mkdtempSync(path.join(tmpdir(), "etsy-ext-"));
  cpSync(distDir, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const local = "http://127.0.0.1:*/*";
  m.host_permissions.push(local);
  for (const cs of m.content_scripts) cs.matches.push(local);
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  return dir;
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  if (url.startsWith("/api/v3/ajax/bespoke/member/shops/12345/stats")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ shop_id: 12345, visits: 10, views: 42 }));
  }
  if (url.startsWith("/api/v3/listings/999")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ listing_id: 999, state: "active" }));
  }
  if (url.startsWith("/api/v3/unrelated")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ noise: true })); // no pattern -> must be dropped
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset=utf-8><title>test</title><script>
    (async () => {
      try { await fetch('/api/v3/ajax/bespoke/member/shops/12345/stats?period=day').then(r=>r.json()); } catch(e){}
      await new Promise((r) => { const x=new XMLHttpRequest(); x.open('GET','/api/v3/listings/999'); x.onloadend=()=>r(); x.send(); });
      try { await fetch('/api/v3/unrelated').then(r=>r.json()); } catch(e){}
      document.title = 'done';
    })();
  </script>`);
});

async function main() {
  const EXT = buildTestExtension();
  const CHROME = resolveChrome();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = mkdtempSync(path.join(tmpdir(), "pw-ext-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: false,
    args: ["--no-sandbox", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });

  const page = await ctx.newPage();
  await page.goto(base + "/page", { waitUntil: "load" });
  await page.waitForFunction(() => document.title === "done", { timeout: 15000 });
  await page.waitForTimeout(1500);

  const captures = await sw.evaluate(
    () => new Promise((res) => chrome.storage.local.get("recent_captures", (d) => res(d.recent_captures || [])))
  );
  await ctx.close();
  server.close();

  const stats = captures.find((c) => c.captureType === "stats");
  const listing = captures.find((c) => c.captureType === "listing");
  assert.ok(stats, "expected a stats capture from fetch()");
  assert.equal(stats.shopId, "12345", "shop_id resolved from body");
  assert.ok(listing, "expected a listing capture from XHR");
  assert.equal(listing.body.listing_id, 999, "XHR JSON body parsed");
  assert.ok(!captures.some((c) => c.url.includes("/unrelated")), "unmatched URL must be dropped as noise");

  console.log(`E2E PASS — captured ${captures.length} (stats+listing), dropped noise, shop_id resolved.`);
}

main().catch((err) => {
  server.close();
  console.error("E2E FAIL:", err);
  process.exit(1);
});
