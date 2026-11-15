// Options page logic: edit per-VPS settings and inspect recent local captures.
import { getSettings, managedKeys, saveSettings, type Settings } from "./lib/settings.js";
import { clearAll, clearRecent, getAll, getRecent } from "./lib/store.js";
import { queueSize } from "./lib/queue.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fields = {
  shopTag: $("shopTag") as HTMLInputElement,
  vpsHost: $("vpsHost") as HTMLInputElement,
  chromeProfile: $("chromeProfile") as HTMLInputElement,
  apiHost: $("apiHost") as HTMLInputElement,
  apiToken: $("apiToken") as HTMLInputElement,
  forwardEnabled: $("forwardEnabled") as HTMLInputElement,
  captureAll: $("captureAll") as HTMLInputElement,
  agentEnabled: $("agentEnabled") as HTMLInputElement,
};

async function load(): Promise<void> {
  const s = await getSettings();
  fields.shopTag.value = s.shopTag;
  fields.vpsHost.value = s.vpsHost;
  fields.chromeProfile.value = s.chromeProfile;
  fields.apiHost.value = s.apiHost;
  fields.apiToken.value = s.apiToken;
  fields.forwardEnabled.checked = s.forwardEnabled;
  fields.captureAll.checked = s.captureAll;
  fields.agentEnabled.checked = s.agentEnabled;
  const locked = await managedKeys();
  for (const k of locked) {
    const el = (fields as Record<string, HTMLInputElement>)[k];
    if (el) el.disabled = true;
  }
  $("managedHint").textContent = locked.length ? `Politika ile yönetilen alanlar: ${locked.join(", ")}` : "";
  await refreshAgent();
}

async function refreshAgent(): Promise<void> {
  const st = (await chrome.runtime.sendMessage({ type: "AGENT_STATUS" })) as Record<string, any> | undefined;
  if (!st) return;
  $("agentStatus").textContent = [
    `Etsy oturumu: ${st.loggedIn === true ? "açık" : st.loggedIn === false ? "KAPALI" : "bilinmiyor"}${st.shopName ? " · " + st.shopName : ""}`,
    `Çalıştırıcı: ${st.module}${st.remoteModules ? " (uzaktan güncelleme açık)" : " (uzaktan güncelleme kapalı)"}`,
    `Son iş: ${st.lastJob ? `#${st.lastJob.id} ${st.lastJob.kind} ${st.lastJob.ok ? "✓" : "✗"} ${st.lastJob.at}` : "yok"}`,
    st.pausedUntil > Date.now() ? `Etsy engeli sonrası bekleme: ${new Date(st.pausedUntil).toLocaleTimeString()} kadar` : "",
    st.lastError ? `Son hata: ${st.lastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// The list currently shown in the #recent textarea (newest first), so a click
// on a line can be mapped back to that capture and its full body copied.
let displayedRecent: Awaited<ReturnType<typeof getRecent>> = [];

async function refreshRecent(): Promise<void> {
  const recent = await getRecent();
  const size = await queueSize();
  displayedRecent = recent.slice(-50).reverse();
  ($("queueInfo") as HTMLElement).textContent = `queued for API: ${size}`;
  ($("recent") as HTMLTextAreaElement).value = displayedRecent
    .map((r) => `${r.capturedAt}  ${r.captureType.padEnd(8)} shop=${r.shopId ?? "?"}  ${r.url}`)
    .join("\n");
}

function flashCopyStatus(msg: string): void {
  const el = $("copyStatus");
  el.textContent = msg;
  setTimeout(() => (el.textContent = ""), 2000);
}

async function copyBody(body: unknown, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(body, null, 2));
    flashCopyStatus(`copied ${label} ✓`);
  } catch {
    flashCopyStatus("copy failed (select the text manually)");
  }
}

/** Copy the full JSON body of the most recent capture of a given type. */
async function copyLatest(type: string): Promise<void> {
  const recent = await getRecent();
  const found = [...recent].reverse().find((r) => r.captureType === type);
  if (!found) return flashCopyStatus(`no ${type} capture yet`);
  await copyBody(found.body, `${type} (${found.url.slice(0, 40)}…)`);
}

/** Cross-origin fetch from the SW needs host permission for the API host. */
async function ensureApiPermission(apiHost: string): Promise<void> {
  if (!apiHost.trim()) return;
  try {
    const origin = new URL(apiHost).origin + "/*";
    await chrome.permissions.request({ origins: [origin] });
  } catch {
    /* invalid URL or user declined; forwarding will fail loudly at flush time */
  }
}

$("save").addEventListener("click", async () => {
  const patch: Partial<Settings> = {
    shopTag: fields.shopTag.value.trim(),
    vpsHost: fields.vpsHost.value.trim(),
    chromeProfile: fields.chromeProfile.value.trim(),
    apiHost: fields.apiHost.value.trim(),
    apiToken: fields.apiToken.value.trim(),
    forwardEnabled: fields.forwardEnabled.checked,
    captureAll: fields.captureAll.checked,
    agentEnabled: fields.agentEnabled.checked,
  };
  if (patch.forwardEnabled && patch.apiHost) await ensureApiPermission(patch.apiHost);
  await saveSettings(patch);
  const status = $("status");
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 1500);
});

$("refresh").addEventListener("click", () => void refreshRecent());
$("agentRun").addEventListener("click", async () => {
  $("agentStatus").textContent = "çalışıyor…";
  await chrome.runtime.sendMessage({ type: "AGENT_RUN_NOW" });
  await refreshAgent();
});
$("clear").addEventListener("click", async () => {
  await clearRecent();
  await refreshRecent();
});

// "Copy latest <type>" buttons.
document.querySelectorAll<HTMLButtonElement>("[data-copytype]").forEach((btn) => {
  btn.addEventListener("click", () => void copyLatest(btn.getAttribute("data-copytype") ?? ""));
});

// Click a line in the recent list to copy that specific capture's full body.
($("recent") as HTMLTextAreaElement).addEventListener("click", (e) => {
  const ta = e.currentTarget as HTMLTextAreaElement;
  const lineIndex = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
  const rec = displayedRecent[lineIndex];
  if (rec) void copyBody(rec.body, `${rec.captureType} line`);
});

/** Build a de-duplicated, sorted summary of observed endpoints for the config. */
async function refreshAll(): Promise<void> {
  const all = await getAll();
  const byKey = new Map<string, { type: string; count: number; sample: string }>();
  for (const r of all) {
    // collapse numeric ids so patterns are obvious: /shops/123/ -> /shops/{id}/
    const key = r.url.replace(/\d{3,}/g, "{id}").split("?")[0];
    const cur = byKey.get(key);
    if (cur) cur.count++;
    else byKey.set(key, { type: r.captureType, count: 1, sample: r.url });
  }
  const lines = [...byKey.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => `${v.type.padEnd(10)} x${String(v.count).padStart(3)}  ${key}`);
  ($("allInfo") as HTMLElement).textContent = `${all.length} responses · ${byKey.size} distinct endpoints`;
  ($("allCaptures") as HTMLTextAreaElement).value = lines.join("\n");
}

$("refreshAll").addEventListener("click", () => void refreshAll());
$("clearAll").addEventListener("click", async () => {
  await clearAll();
  await refreshAll();
});
$("copyAll").addEventListener("click", async () => {
  await navigator.clipboard.writeText(($("allCaptures") as HTMLTextAreaElement).value).catch(() => {});
});

void load();
void refreshRecent();
void refreshAll();
