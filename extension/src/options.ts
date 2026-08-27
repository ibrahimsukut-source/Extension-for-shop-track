// Options page logic: edit per-VPS settings and inspect recent local captures.
import { getSettings, saveSettings, type Settings } from "./lib/settings.js";
import { clearRecent, getRecent } from "./lib/store.js";
import { queueSize } from "./lib/queue.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fields = {
  shopTag: $("shopTag") as HTMLInputElement,
  vpsHost: $("vpsHost") as HTMLInputElement,
  chromeProfile: $("chromeProfile") as HTMLInputElement,
  apiHost: $("apiHost") as HTMLInputElement,
  apiToken: $("apiToken") as HTMLInputElement,
  forwardEnabled: $("forwardEnabled") as HTMLInputElement,
};

async function load(): Promise<void> {
  const s = await getSettings();
  fields.shopTag.value = s.shopTag;
  fields.vpsHost.value = s.vpsHost;
  fields.chromeProfile.value = s.chromeProfile;
  fields.apiHost.value = s.apiHost;
  fields.apiToken.value = s.apiToken;
  fields.forwardEnabled.checked = s.forwardEnabled;
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

void load();
void refreshRecent();
