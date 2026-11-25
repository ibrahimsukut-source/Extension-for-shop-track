/*! oc-runner 2026.11.26-1 */
"use strict";
(() => {
  // src/agent/statement.ts
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  function currencyFromAmount(text) {
    const t = text.replace(/[\d.,\s+-]/g, "");
    const map = { TL: "TRY", "\u20BA": "TRY", $: "USD", US$: "USD", "\u20AC": "EUR", "\xA3": "GBP", CA$: "CAD", AU$: "AUD", NZ$: "NZD", "\xA5": "JPY" };
    return map[t] ?? (/^[A-Z]{3}$/.test(t) ? t : null);
  }
  function readMonthlyStatement(doc, month, year) {
    const profitEl = doc.querySelector('[data-test-id="profit-amount"]');
    const headEl = doc.querySelector('[data-test-id="activity-summary-profit"]');
    const mods = Array.from(doc.querySelectorAll('[data-test-id="summary-module"]'));
    if (!profitEl || !headEl || !mods.length) return null;
    const heading = clean(headEl.textContent?.replace(/Your total Sales on Etsy.*?selected time period\./, ""));
    const want = `${MONTHS[month - 1]} ${year}`;
    if (!heading.includes(want)) {
      const err = new Error(`Sayfa ${want} yerine ba\u015Fka bir d\xF6nemi g\xF6steriyor: "${heading.slice(0, 120)}"`);
      err.code = "wrong_page";
      throw err;
    }
    const modules = mods.map((m) => {
      const title = clean(Array.from(m.querySelectorAll("h3")).find((h) => !h.hasAttribute("data-test-id"))?.textContent);
      const total = clean(m.querySelector('[data-test-id="accordion-total"]')?.textContent) || null;
      const rows = [];
      for (const sec of Array.from(m.querySelectorAll('[data-test-id$="-section"]'))) {
        const key = (sec.getAttribute("data-test-id") ?? "").replace(/-section$/, "");
        for (const cell of Array.from(sec.querySelectorAll('[data-clg-id="WtGridItem"].wt-text-right-xs'))) {
          const row = cell.closest('[data-clg-id="WtGrid"]');
          if (!row || !sec.contains(row)) continue;
          const main = row.querySelector('[data-test-id="child-label"]');
          const label = clean(main?.textContent ?? row.querySelector("button span")?.textContent ?? "Credits");
          rows.push({ key, label, value: clean(cell.textContent), credit: !main });
        }
      }
      return { title, total, rows };
    });
    const profit = clean(profitEl.textContent);
    return { month, year, heading, profit, currency: currencyFromAmount(profit), modules };
  }

  // src/agent/version.ts
  var RUNNER_VERSION = "2026.11.26-1";

  // src/agent/page-runner.ts
  var AgentError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  };
  var W = globalThis;
  function sliceObject(text, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }
  function parseEtsyContext(scripts) {
    const ctxObj = {};
    const re = /Etsy\.Context(?:\.(\w+))?\s*=\s*(?!Etsy\.Context\s*\|\|)/g;
    for (const text of scripts) {
      if (!text.includes("Etsy.Context")) continue;
      re.lastIndex = 0;
      let m;
      while (m = re.exec(text)) {
        let i = m.index + m[0].length;
        let found = -1;
        for (let guard = 0; guard < 400 && i < text.length; guard++) {
          const j = text.indexOf("{", i);
          if (j < 0 || j - (m.index + m[0].length) > 400) break;
          if (/^\{\s*"/.test(text.slice(j, j + 40))) {
            found = j;
            break;
          }
          i = j + 1;
        }
        if (found < 0) continue;
        const raw = sliceObject(text, found);
        if (!raw) continue;
        let obj;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue;
        }
        if (m[1]) ctxObj[m[1]] = Object.assign(ctxObj[m[1]] ?? {}, obj);
        else for (const [k, v] of Object.entries(obj)) ctxObj[k] = k === "data" && ctxObj.data ? Object.assign(ctxObj.data, v) : v;
        re.lastIndex = found + raw.length;
      }
    }
    return ctxObj;
  }
  var ctxCache = null;
  function ctx() {
    if (!ctxCache) {
      const scripts = Array.from(document.querySelectorAll("script:not([src])"), (s) => s.textContent ?? "");
      ctxCache = parseEtsyContext(scripts);
    }
    const d = ctxCache?.data;
    if (!d) {
      if (/\/signin/.test(location.pathname)) throw new AgentError("not_logged_in", "Etsy oturumu kapal\u0131");
      throw new AgentError("wrong_page", "Etsy.Context bulunamad\u0131");
    }
    if (!d.shop_id) throw new AgentError("not_logged_in", "Shop Manager oturumu yok (shop_id bo\u015F)");
    return d;
  }
  function locale(d) {
    const ls = d.locale_settings ?? {};
    const cur = ls.currency?.code ?? "USD";
    const lang = ls.language?.code ?? "en-US";
    const region = ls.region?.code ?? ls.region ?? "US";
    return `${cur}|${lang}|${typeof region === "string" ? region : "US"}`;
  }
  function csrf() {
    const m = document.querySelector('meta[name="csrf_nonce"]');
    if (!m?.content) throw new AgentError("not_logged_in", "csrf_nonce yok");
    return m.content;
  }
  function camelize(v) {
    if (Array.isArray(v)) return v.map(camelize);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const key = /^\d+$/.test(k) ? k : k.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
        out[key] = camelize(val);
      }
      return out;
    }
    return v;
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var TEMPO = 0.7 + Math.random() * 0.9;
  var jitter = (min, max) => sleep((min + Math.random() * (max - min)) * TEMPO);
  var pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  var PAGE_SIZE = pick([25, 30, 40, 50, 60, 75, 100]);
  function qs(q) {
    if (!q) return "";
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== void 0 && v !== null) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  }
  function caller(d) {
    const shopId = Number(d.shop_id);
    const base = (path) => path.startsWith("/api/") ? path : `/api/v3/ajax/shop/${shopId}${path}`;
    const c = {
      shopId,
      requests: 0,
      async get(path, q) {
        c.requests++;
        const res = await fetch(base(path) + qs(q), {
          credentials: "same-origin",
          headers: { accept: "application/json", "x-detected-locale": locale(d) }
        });
        return parse(res, path);
      },
      async getC(path, q) {
        return camelize(await c.get(path, q));
      },
      async write(method, path, body) {
        c.requests++;
        const res = await fetch(base(path), {
          method,
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrf(),
            "x-detected-locale": locale(d)
          },
          body: JSON.stringify(body)
        });
        return { status: res.status, body: await parse(res, path), url: base(path) };
      }
    };
    return c;
  }
  async function parse(res, path) {
    if (res.status === 401) throw new AgentError("not_logged_in", `${path}: 401`);
    if (res.status === 403 || res.status === 429) throw new AgentError("blocked", `${path}: HTTP ${res.status} \u2014 Etsy iste\u011Fi engelledi, i\u015F durduruldu`);
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new AgentError("blocked", `${path}: JSON olmayan yan\u0131t (captcha / engel sayfas\u0131 olabilir)`);
    }
    if (!res.ok) throw new AgentError("error", `${path}: HTTP ${res.status} ${typeof body?.error === "string" ? body.error : ""}`.trim());
    return body;
  }
  function etDay(offset = 0) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const [y, m, dd] = fmt.format(/* @__PURE__ */ new Date()).split("-").map(Number);
    return fmt.format(new Date(Date.UTC(y, m - 1, dd + offset, 12)));
  }
  function range(key) {
    const today = etDay(0);
    switch (key) {
      case "today":
        return { start: today, end: today };
      case "yesterday":
        return { start: etDay(-1), end: etDay(-1) };
      case "last_7":
        return { start: etDay(-6), end: today };
      case "this_month":
        return { start: `${today.slice(0, 8)}01`, end: today };
      case "this_year":
        return { start: `${today.slice(0, 4)}-01-01`, end: today };
      case "last_month": {
        const [y, m] = today.split("-").map(Number);
        const first = new Date(Date.UTC(y, m - 2, 1, 12)).toISOString().slice(0, 10);
        const last = new Date(Date.UTC(y, m - 1, 0, 12)).toISOString().slice(0, 10);
        return { start: first, end: last };
      }
      default:
        return { start: etDay(-30), end: today };
    }
  }
  function prevRange(r) {
    const s = Date.parse(`${r.start}T12:00:00Z`);
    const e = Date.parse(`${r.end}T12:00:00Z`);
    const days = Math.round((e - s) / 864e5);
    const pe = new Date(s);
    const ps = new Date(s - days * 864e5);
    return { start: ps.toISOString().slice(0, 10), end: pe.toISOString().slice(0, 10) };
  }
  var mdy = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  async function allListingStats(c, r, isPromoted, cap = 6e3) {
    const out = [];
    const limit = PAGE_SIZE;
    for (let offset = 0; offset < cap; ) {
      const page = await c.getC("/prolist/stats/listings", {
        start_date: r.start,
        end_date: r.end,
        sort_type: "impression_count",
        sort_order: "desc",
        offset,
        limit,
        is_promoted: isPromoted
      });
      const rows = Array.isArray(page?.listings) ? page.listings : [];
      out.push(...rows);
      const total = Number(page?.filteredListingCount ?? 0);
      offset += rows.length;
      if (!rows.length || total && offset >= total) break;
      await jitter(400, 1100);
    }
    return out;
  }
  async function collectAds(c, d, p) {
    const r = range(p.range ?? "last_30");
    const pr = prevRange(r);
    const init = d.initial_data?.etsyAds ?? {};
    const campaign = await c.getC("/prolist/campaign");
    await jitter(300, 800);
    const shopStats = await c.getC("/prolist/stats", {
      start_date: r.start,
      end_date: r.end,
      comparison_start_date: pr.start,
      comparison_end_date: pr.end
    });
    await jitter(300, 800);
    let promoted;
    let notPromoted;
    if (Math.random() < 0.5) {
      promoted = await allListingStats(c, r, true);
      await jitter(400, 1e3);
      notPromoted = await allListingStats(c, r, false);
    } else {
      notPromoted = await allListingStats(c, r, false);
      await jitter(400, 1e3);
      promoted = await allListingStats(c, r, true);
    }
    const seen = /* @__PURE__ */ new Set();
    const listings = [...promoted, ...notPromoted].filter((e) => {
      const id = Number(e?.listing?.listingId);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    let yesterday = null;
    if (p.yesterdayPerListing !== false) {
      const y = range("yesterday");
      await jitter(400, 1e3);
      yesterday = { date: y.start, listings: await allListingStats(c, y, true) };
    }
    const queries = {};
    const topN = Number(p.queryTopN ?? 60);
    if (p.queries !== false && topN > 0) {
      const top = listings.filter((e) => Number(e?.totalStats?.spentTotal ?? 0) > 0 || Number(e?.totalStats?.impressionCount ?? 0) > 0).sort((a, b) => Number(b.totalStats?.spentTotal ?? 0) - Number(a.totalStats?.spentTotal ?? 0)).slice(0, topN);
      for (const e of top) {
        await jitter(500, 1300);
        const id = Number(e.listing.listingId);
        const qsr = await c.get(`/prolist/listings/querystats/${id}`, {
          start_date: mdy(r.start),
          end_date: mdy(r.end),
          sort_type: "stemmed_query",
          sort_order: 1
        });
        queries[String(id)] = Array.isArray(qsr?.query_stats) ? qsr.query_stats : [];
      }
    }
    return {
      shop: { id: c.shopId, name: d.shop_name, currency: "USD" },
      range: r,
      campaign,
      minBudgetCents: init.campaignMinBudget?.budgetInCents ?? null,
      maxBudgetCents: init.campaignMaxBudget?.budgetInCents ?? null,
      promotedCount: init.promotedListingsCount ?? promoted.length,
      freshness: init.etsyadsMetricsFreshness ?? null,
      shopStats,
      listings,
      yesterday,
      queries,
      requests: c.requests
    };
  }
  function collectShopStats(d, p) {
    const I = d.initial_data ?? {};
    if (!I.metrics_summary) throw new AgentError("wrong_page", "Stats sayfas\u0131 verisi yok (metrics_summary)");
    const tb = I.traffic_breakdown ?? {};
    const sources = [...tb.etsy_traffic?.traffic_sources ?? [], ...tb.user_traffic?.traffic_sources ?? []].map((s) => ({
      key: s.short_key ?? s.source_key,
      name: s.display_name,
      visits: s.visits,
      yoy: s.year_over_year_metrics?.yoy_percentage_display_string ?? null,
      sub: (s.sub_traffic_sources ?? []).map((x) => ({ key: x.short_key ?? x.source_key, name: x.display_name, visits: x.visits }))
    }));
    return {
      rangeKey: I.selected_date_range?.key ?? p.range,
      startDate: I.start_date,
      endDate: I.end_date,
      metrics: I.metrics_summary,
      traffic: { etsyShare: tb.etsy_traffic?.subtitle ?? null, userShare: tb.user_traffic?.subtitle ?? null, sources },
      topListings: (I.listings?.listings ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        visits: l.visits,
        orders: l.orders,
        revenue: l.revenue,
        favorites: l.favorites
      })),
      listingCount: I.listings?.pagination?.total_count ?? null,
      offsiteAds: { status: I.offsite_ads_status ?? null, feeRate: I.offsite_fee_rate ?? null }
    };
  }
  async function setPromoted(c, p) {
    const ids = p.listingIds.map(Number);
    const want = Boolean(p.promoted);
    const actions = [];
    const captures = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const before = {};
      if (ids.length <= 50) {
        for (const id of chunk) {
          const s = await c.getC(`/prolist/stats/listings/${id}`, { start_date: range("today").start, end_date: range("today").end });
          before[id] = typeof s?.listing?.isPromoted === "boolean" ? s.listing.isPromoted : null;
          await jitter(250, 600);
        }
      }
      const res = await c.write("POST", "/prolist/listings", { listings: Object.fromEntries(chunk.map((id) => [String(id), want])) });
      captures.push({ url: res.url, status: res.status, body: res.body });
      const got = res.body?.listings ?? {};
      for (const id of chunk) {
        actions.push({
          action: "ads.set_promoted",
          target: String(id),
          before: { promoted: before[id] ?? null },
          after: { promoted: typeof got[String(id)] === "boolean" ? got[String(id)] : null },
          verified: got[String(id)] === want
        });
      }
      await jitter(800, 1600);
    }
    if (ids.length) {
      const s = await c.getC(`/prolist/stats/listings/${ids[0]}`, { start_date: range("today").start, end_date: range("today").end });
      const first = actions.find((a) => a.target === String(ids[0]));
      if (first && typeof s?.listing?.isPromoted === "boolean" && s.listing.isPromoted !== want) first.verified = false;
    }
    return { actions, captures };
  }
  async function setQueryRelevance(c, p) {
    const actions = [];
    const captures = [];
    const r = range("last_30");
    const fetchStats = async (id) => {
      const s = await c.get(`/prolist/listings/querystats/${id}`, { start_date: mdy(r.start), end_date: mdy(r.end), sort_type: "stemmed_query", sort_order: 1 });
      return Array.isArray(s?.query_stats) ? s.query_stats : [];
    };
    for (const it of p.items) {
      const id = Number(it.listingId);
      const before = (await fetchStats(id)).find((q) => q.stemmed_query === it.query);
      await jitter(300, 700);
      const res = await c.write("POST", "/prolist/listing-query", { listing_id: id, query: it.query, is_relevant: Boolean(it.isRelevant) });
      captures.push({ url: res.url, status: res.status, body: res.body });
      await jitter(600, 1200);
      const after = (await fetchStats(id)).find((q) => q.stemmed_query === it.query);
      actions.push({
        action: "ads.set_query_relevance",
        target: `${id}:${it.query}`,
        before: { isRelevant: before?.is_relevant ?? null },
        after: { isRelevant: after?.is_relevant ?? null },
        verified: after ? after.is_relevant === Boolean(it.isRelevant) : null
      });
      await jitter(500, 1200);
    }
    return { actions, captures };
  }
  async function setBudget(c, p) {
    const cents = Math.round(Number(p.dailyBudgetUsd) * 100);
    const before = await c.getC("/prolist/campaign");
    const res = await c.write("PUT", "/prolist/campaign-budget", { budget: cents });
    await jitter(800, 1500);
    const after = await c.getC("/prolist/campaign");
    return {
      actions: [
        {
          action: "ads.set_budget",
          target: "campaign",
          before: { budgetCents: before?.totalDailyBudget ?? null },
          after: { budgetCents: after?.totalDailyBudget ?? null },
          verified: after?.totalDailyBudget === cents
        }
      ],
      captures: [{ url: res.url, status: res.status, body: res.body }]
    };
  }
  async function collectMonthlyStatement(d, p) {
    const month = Number(p.month), year = Number(p.year);
    if (!(month >= 1 && month <= 12) || !(year >= 2015 && year <= 2100)) throw new AgentError("error", "ge\xE7ersiz ay/y\u0131l");
    const q = new URLSearchParams(location.search);
    if (!/\/your\/account\/payments\/monthly-statement/.test(location.pathname) || Number(q.get("month")) !== month || Number(q.get("year")) !== year) {
      throw new AgentError("wrong_page", `ayl\u0131k ekstre sayfas\u0131 a\xE7\u0131k de\u011Fil (${location.pathname})`);
    }
    const deadline = Date.now() + 4e4;
    for (; ; ) {
      let st;
      try {
        st = readMonthlyStatement(document, month, year);
      } catch (e) {
        throw new AgentError("wrong_page", e.message);
      }
      if (st) return { ...st, shop: { id: d.shop_id, name: d.shop_name } };
      if (Date.now() > deadline) throw new AgentError("wrong_page", "ayl\u0131k \xF6zet sayfada g\xF6r\xFCnmedi (40 sn)");
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 900));
    }
  }
  async function run(job) {
    try {
      const d = ctx();
      const c = caller(d);
      const e = job.expect;
      if (e && job.kind !== "probe") {
        const nameOk = !e.shopName || String(e.shopName).toLowerCase() === String(d.shop_name ?? "").toLowerCase();
        const idOk = !e.shopId || String(e.shopId) === String(c.shopId);
        if (!nameOk || !idOk) {
          return { ok: false, code: "wrong_shop", error: `Bu Chrome'da ${d.shop_name} a\xE7\u0131k, i\u015F ${e.shopName} i\xE7in \u2014 hi\xE7bir \u015Fey yap\u0131lmad\u0131` };
        }
      }
      switch (job.kind) {
        case "probe":
          return { ok: true, result: { shopId: c.shopId, shopName: d.shop_name, path: location.pathname } };
        case "collect.ads":
          return { ok: true, result: await collectAds(c, d, job.params) };
        case "collect.shop_stats":
          return { ok: true, result: collectShopStats(d, job.params) };
        case "ads.set_promoted":
          return { ok: true, result: await setPromoted(c, job.params) };
        case "ads.set_query_relevance":
          return { ok: true, result: await setQueryRelevance(c, job.params) };
        case "ads.set_budget":
          return { ok: true, result: await setBudget(c, job.params) };
        case "collect.monthly_statement":
          return { ok: true, result: await collectMonthlyStatement(d, job.params) };
        default:
          return { ok: false, code: "unsupported", error: `bilinmeyen i\u015F: ${job.kind}` };
      }
    } catch (e) {
      const err = e;
      return { ok: false, code: err.code ?? "error", error: String(err.message ?? e) };
    }
  }
  W.__ocAgent = { version: RUNNER_VERSION, run };
})();
