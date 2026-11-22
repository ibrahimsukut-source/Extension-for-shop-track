// Command-center agent (service worker side).
//
// Every POLL_ALARM tick: heartbeat → central returns at most one job → run it in
// a dedicated background "worker tab" on Etsy Shop Manager → post the result.
// The worker tab uses the shop's existing Etsy login; this code never sees or
// types a password. Job logic lives in page-runner.ts, injected either from the
// extension bundle or — when the central server has a newer, correctly SIGNED
// build — from a remote module (chrome.userScripts), so logic updates roll out
// without reinstalling the extension.
import { canRunAgent, getSettings, type Settings } from "../lib/settings.js";
import { RUNNER_VERSION } from "./version.js";
import { verifyModule, MODULE_PUBLIC_KEY } from "./modules.js";

export const POLL_ALARM = "agent-poll";
const STATE_KEY = "agentState";
const MODULE_KEY = "agentModule";
const MAX_JOBS_PER_TICK = 5;
const LOGIN_REPROBE_MS = 15 * 60_000;
// Which shop is open in this Chrome is re-checked periodically: the command
// center matches this Chrome to a shop by it (VPS keys) and refuses mismatches.
const SHOP_REPROBE_MS = 3 * 60 * 60_000;
const BLOCK_COOLDOWN_MS = 2 * 60 * 60_000;
// Command-center master switch: while halted, the agent touches nothing on Etsy
// and only asks the center (no Etsy page) every HALT_RECHECK_MS.
const HALT_RECHECK_MS = 10 * 60_000;

interface AgentState {
  agentId: string;
  workerTabId: number | null;
  loggedIn: boolean | null;
  lastProbeAt: number;
  etsyShopId: number | null;
  shopName: string | null;
  lastError: string | null;
  pausedUntil: number;
  running: boolean;
  runningSince: number;
  lastJob: { id: number; kind: string; ok: boolean; at: string; error?: string } | null;
  halted: boolean;
  haltCheckedAt: number;
}

interface StoredModule {
  name: string;
  version: string;
  code: string;
}

interface PollResponse {
  pollSeconds: number;
  paused: boolean;
  /** Master switch off: do not open or touch Etsy at all. */
  halt?: boolean;
  modules: { name: string; version: string } | null;
  job: { id: number; kind: string; params: Record<string, unknown>; attempt: number; expect?: { shopName?: string | null; shopId?: number | string | null } } | null;
  message?: string;
}

interface RunOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

async function getState(): Promise<AgentState> {
  const s = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as Partial<AgentState> | undefined;
  return {
    agentId: s?.agentId ?? crypto.randomUUID(),
    workerTabId: s?.workerTabId ?? null,
    loggedIn: s?.loggedIn ?? null,
    lastProbeAt: s?.lastProbeAt ?? 0,
    etsyShopId: s?.etsyShopId ?? null,
    shopName: s?.shopName ?? null,
    lastError: s?.lastError ?? null,
    pausedUntil: s?.pausedUntil ?? 0,
    running: s?.running ?? false,
    runningSince: s?.runningSince ?? 0,
    lastJob: s?.lastJob ?? null,
    halted: s?.halted ?? false,
    haltCheckedAt: s?.haltCheckedAt ?? 0,
  };
}
async function patchState(p: Partial<AgentState>): Promise<AgentState> {
  const next = { ...(await getState()), ...p };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

export async function agentStatus(): Promise<AgentState & { module: string; remoteModules: boolean }> {
  const st = await getState();
  const mod = (await chrome.storage.local.get(MODULE_KEY))[MODULE_KEY] as StoredModule | undefined;
  return { ...st, module: mod?.version ?? `builtin ${RUNNER_VERSION}`, remoteModules: Boolean(MODULE_PUBLIC_KEY) && userScriptsAvailable() };
}

function apiUrl(s: Settings, path: string): string {
  return s.apiHost.replace(/\/+$/, "") + path;
}

async function api<T>(s: Settings, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(s, path), {
    ...init,
    headers: { authorization: `Bearer ${s.apiToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`central ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ── Worker tab ─────────────────────────────────────────────────────────────
const PAGE_FOR: Record<string, (p: Record<string, unknown>) => string> = {
  probe: () => "https://www.etsy.com/your/shops/me/dashboard",
  "collect.ads": () => "https://www.etsy.com/your/shops/me/advertising",
  "collect.shop_stats": (p) => `https://www.etsy.com/your/shops/me/stats?date_range=${encodeURIComponent(String(p.range ?? "last_30"))}`,
  "ads.set_promoted": () => "https://www.etsy.com/your/shops/me/advertising",
  "ads.set_query_relevance": () => "https://www.etsy.com/your/shops/me/advertising",
  "ads.set_budget": () => "https://www.etsy.com/your/shops/me/advertising",
};

function waitForComplete(tabId: number, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(new Error("Etsy sayfası zamanında yüklenmedi"));
    }, timeoutMs);
    const onUpd = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function openWorkerTab(url: string): Promise<number> {
  const st = await getState();
  let tabId = st.workerTabId;
  if (tabId !== null) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabId = null;
    }
  }
  if (tabId === null) {
    const tab = await chrome.tabs.create({ url, active: false, pinned: true });
    tabId = tab.id!;
    await patchState({ workerTabId: tabId });
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  await waitForComplete(tabId);
  // Let Etsy's app shell settle (Etsy.Context, csrf meta).
  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
  return tabId;
}

// ── Runner injection ─────────────────────────────────────────────────────
function userScriptsAvailable(): boolean {
  try {
    return typeof (chrome.userScripts as any)?.execute === "function";
  } catch {
    // Accessing chrome.userScripts throws when the user hasn't allowed user scripts.
    return false;
  }
}

/**
 * Runs the job in the worker tab. Never in the page's MAIN world (rule #1):
 *  - remote module → chrome.userScripts in the USER_SCRIPT world (isolated from the page),
 *    loaded and invoked in a single injection;
 *  - built-in runner → the extension's ISOLATED content-script world.
 */
async function executeJob(tabId: number, job: { id: number; kind: string; params: Record<string, unknown> }): Promise<RunOutcome & { runner: string }> {
  const mod = (await chrome.storage.local.get(MODULE_KEY))[MODULE_KEY] as StoredModule | undefined;
  if (mod && userScriptsAvailable()) {
    try {
      const code = `${mod.code}\n;globalThis.__ocAgent.run(${JSON.stringify(job)});`;
      const [res] = await (chrome.userScripts as any).execute({ target: { tabId }, js: [{ code }], world: "USER_SCRIPT", injectImmediately: true });
      const out = res?.result as RunOutcome | undefined;
      if (out && typeof out.ok === "boolean") return { ...out, runner: mod.version };
      console.warn("[agent] remote module returned no outcome, using built-in runner");
    } catch (e) {
      console.warn("[agent] remote module failed, using built-in runner", e);
    }
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page-runner.js"], world: "ISOLATED" });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (j: unknown) => (globalThis as any).__ocAgent.run(j),
    args: [job],
  });
  return { ...((res?.result as RunOutcome) ?? { ok: false, error: "boş sonuç" }), runner: `builtin ${RUNNER_VERSION}` };
}

async function runInTab(job: { id: number; kind: string; params: Record<string, unknown> }): Promise<RunOutcome & { runner: string }> {
  const page = PAGE_FOR[job.kind];
  if (!page) return { ok: false, code: "unsupported", error: `bilinmeyen iş: ${job.kind}`, runner: "-" };
  const tabId = await openWorkerTab(page(job.params));
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && /\/signin/.test(tab.url)) {
    return { ok: false, code: "not_logged_in", error: "Etsy oturumu kapalı (giriş sayfasına yönlendirildi)", runner: "-" };
  }
  // Keep the service worker alive while a long collection runs in the page.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await executeJob(tabId, job);
  } finally {
    clearInterval(keepAlive);
  }
}

// ── Remote module update ─────────────────────────────────────────────────
async function maybeUpdateModule(s: Settings, offered: PollResponse["modules"]): Promise<void> {
  if (!offered || !MODULE_PUBLIC_KEY || !userScriptsAvailable()) return;
  const current = (await chrome.storage.local.get(MODULE_KEY))[MODULE_KEY] as StoredModule | undefined;
  if (current?.version === offered.version) return;
  if (!current && offered.version === RUNNER_VERSION) return;
  const mod = await api<{ name: string; version: string; code: string; sig: string }>(s, `/agent/v1/modules/${encodeURIComponent(offered.name)}`);
  if (!(await verifyModule(mod))) {
    await patchState({ lastError: `modül imzası geçersiz (${mod.version}) — yüklenmedi` });
    return;
  }
  await chrome.storage.local.set({ [MODULE_KEY]: { name: mod.name, version: mod.version, code: mod.code } });
  console.log(`[agent] runner module updated → ${mod.version}`);
}

// ── Master switch ────────────────────────────────────────────────────────
async function closeWorkerTab(): Promise<void> {
  const st = await getState();
  if (st.workerTabId !== null) {
    await chrome.tabs.remove(st.workerTabId).catch(() => undefined);
    await patchState({ workerTabId: null });
  }
}

async function halt(): Promise<void> {
  await patchState({ halted: true, haltCheckedAt: Date.now(), lastError: "merkez: ana şalter kapalı — Etsy'ye dokunulmuyor" });
  await closeWorkerTab();
}

/** Asks the center (never Etsy) whether the agent may run. Invalid key = halt too. */
async function centerAllows(s: Settings, st: AgentState, moduleVersion: string): Promise<boolean> {
  try {
    const ctl = await api<PollResponse>(s, "/agent/v1/poll", {
      method: "POST",
      body: JSON.stringify({ ...(await heartbeatBody(st, moduleVersion)), control: true }),
    });
    if (ctl.halt) {
      await halt();
      return false;
    }
    if (st.halted) await patchState({ halted: false, haltCheckedAt: Date.now(), lastError: null });
    return true;
  } catch (e) {
    if (/HTTP 401/.test((e as Error).message)) await halt();
    else await patchState({ lastError: `merkez: ${(e as Error).message}` });
    return false;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function heartbeatBody(st: AgentState, moduleVersion: string) {
  return {
    agentId: st.agentId,
    extVersion: chrome.runtime.getManifest().version,
    moduleVersion,
    etsyShopId: st.etsyShopId,
    shopName: st.shopName,
    loggedIn: st.loggedIn,
    lastError: st.lastError,
    state: { lastJob: st.lastJob, pausedUntil: st.pausedUntil || null, remoteModules: userScriptsAvailable() },
  };
}

async function reportResult(s: Settings, jobId: number, out: RunOutcome): Promise<void> {
  await api(s, `/agent/v1/jobs/${jobId}/result`, {
    method: "POST",
    body: JSON.stringify({ ok: out.ok, result: out.result, error: out.error ? `${out.code ?? "error"}: ${out.error}` : null }),
  });
}

async function probeLogin(): Promise<void> {
  const out = await runInTab({ id: 0, kind: "probe", params: {} });
  const r = (out.result ?? {}) as { shopId?: number; shopName?: string };
  await patchState({
    lastProbeAt: Date.now(),
    loggedIn: out.ok,
    etsyShopId: out.ok ? r.shopId ?? null : (await getState()).etsyShopId,
    shopName: out.ok ? r.shopName ?? null : (await getState()).shopName,
    lastError: out.ok ? null : out.error ?? null,
  });
}

export async function agentTick(): Promise<void> {
  const s = await getSettings();
  if (!canRunAgent(s)) return;
  let st = await getState();
  if (st.halted && Date.now() - st.haltCheckedAt < HALT_RECHECK_MS) return;
  // A crashed run (SW killed mid-job) must not wedge the agent forever.
  if (st.running && Date.now() - st.runningSince < 20 * 60_000) return;
  st = await patchState({ running: true, runningSince: Date.now() });
  try {
    // Ask the center first: nothing below may open Etsy unless the switch is on.
    const modVersion = ((await chrome.storage.local.get(MODULE_KEY))[MODULE_KEY] as StoredModule | undefined)?.version ?? `builtin ${RUNNER_VERSION}`;
    if (!(await centerAllows(s, st, modVersion))) return;
    st = await getState();
    const sinceProbe = Date.now() - st.lastProbeAt;
    if ((st.loggedIn !== true && sinceProbe > LOGIN_REPROBE_MS) || sinceProbe > SHOP_REPROBE_MS || !st.shopName) {
      await probeLogin();
      st = await getState();
    }
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const mod = (await chrome.storage.local.get(MODULE_KEY))[MODULE_KEY] as StoredModule | undefined;
      const blocked = st.pausedUntil > Date.now();
      const poll = await api<PollResponse>(s, "/agent/v1/poll", {
        method: "POST",
        body: JSON.stringify({ ...(await heartbeatBody(st, mod?.version ?? `builtin ${RUNNER_VERSION}`)), loggedIn: blocked ? false : st.loggedIn }),
      });
      if (poll.halt) {
        await halt();
        break;
      }
      await maybeUpdateModule(s, poll.modules).catch((e) => console.warn("[agent] module update failed", e));
      if (poll.message) {
        st = await patchState({ lastError: `merkez: ${poll.message}` });
        // Center couldn't match this Chrome to a shop: look again (shop may have changed).
        if (!poll.job && Date.now() - st.lastProbeAt > LOGIN_REPROBE_MS) await probeLogin();
      }
      if (!poll.job || blocked) break;

      const job = poll.job;
      let out: RunOutcome;
      try {
        out = await runInTab(job);
      } catch (e) {
        out = { ok: false, code: "error", error: (e as Error).message };
      }
      const patch: Partial<AgentState> = {
        lastJob: { id: job.id, kind: job.kind, ok: out.ok, at: new Date().toISOString(), error: out.error },
        lastError: out.ok ? null : out.error ?? null,
      };
      if (out.code === "not_logged_in") Object.assign(patch, { loggedIn: false, lastProbeAt: Date.now() });
      if (out.code === "wrong_shop") patch.lastProbeAt = 0; // re-identify on the next tick
      if (out.ok) patch.loggedIn = true;
      if (out.code === "blocked") patch.pausedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      if (out.ok && job.kind === "collect.ads") {
        const shop = (out.result as { shop?: { id?: number; name?: string } })?.shop;
        if (shop?.id) Object.assign(patch, { etsyShopId: shop.id, shopName: shop.name ?? null });
      }
      st = await patchState(patch);
      await reportResult(s, job.id, out);
      if (out.code === "blocked" || out.code === "not_logged_in" || out.code === "wrong_shop") break;
    }
  } catch (e) {
    await patchState({ lastError: `merkez: ${(e as Error).message}` });
  } finally {
    await patchState({ running: false });
  }
}

export function scheduleAgent(): void {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
}
