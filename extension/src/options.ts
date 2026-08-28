// Options page logic: edit per-VPS settings and inspect recent local captures.
import { getSettings, saveSettings, type Settings } from "./lib/settings.js";
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
}

async function refreshRecent(): Promise<void> {
  const recent = await getRecent();
  const size = await queueSize();
  ($("queueInfo") as HTMLElement).textContent = `queued for API: ${size}`;
  ($("recent") as HTMLTextAreaElement).value = recent
    .slice(-50)
    .reverse()
    .map((r) => `${r.capturedAt}  ${r.captureType.padEnd(8)} shop=${r.shopId ?? "?"}  ${r.url}`)
    .join("\n");
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
  };
  if (patch.forwardEnabled && patch.apiHost) await ensureApiPermission(patch.apiHost);
  await saveSettings(patch);
  const status = $("status");
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 1500);
});

$("refresh").addEventListener("click", () => void refreshRecent());
$("clear").addEventListener("click", async () => {
  await clearRecent();
  await refreshRecent();
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
