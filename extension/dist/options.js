"use strict";
(() => {
  // src/lib/settings.ts
  var DEFAULT_SETTINGS = {
    apiHost: "",
    apiToken: "",
    shopTag: "",
    vpsHost: "",
    chromeProfile: "",
    forwardEnabled: false,
    captureAll: false
  };
  var KEY = "settings";
  async function getSettings() {
    const stored = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...stored[KEY] };
  }
  async function saveSettings(patch) {
    const next = { ...await getSettings(), ...patch };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  // src/lib/lock.ts
  var chain = Promise.resolve();

  // src/lib/store.ts
  var KEY2 = "recent_captures";
  async function getRecent() {
    const stored = await chrome.storage.local.get(KEY2);
    return stored[KEY2] ?? [];
  }
  async function clearRecent() {
    await chrome.storage.local.remove(KEY2);
  }
  var ALL_KEY = "all_captures";
  async function getAll() {
    const stored = await chrome.storage.local.get(ALL_KEY);
    return stored[ALL_KEY] ?? [];
  }
  async function clearAll() {
    await chrome.storage.local.remove(ALL_KEY);
  }

  // src/lib/queue.ts
  var KEY3 = "outbound_queue";
  async function read() {
    const stored = await chrome.storage.local.get(KEY3);
    return stored[KEY3] ?? [];
  }
  async function queueSize() {
    return (await read()).length;
  }

  // src/options.ts
  var $ = (id) => document.getElementById(id);
  var fields = {
    shopTag: $("shopTag"),
    vpsHost: $("vpsHost"),
    chromeProfile: $("chromeProfile"),
    apiHost: $("apiHost"),
    apiToken: $("apiToken"),
    forwardEnabled: $("forwardEnabled"),
    captureAll: $("captureAll")
  };
  async function load() {
    const s = await getSettings();
    fields.shopTag.value = s.shopTag;
    fields.vpsHost.value = s.vpsHost;
    fields.chromeProfile.value = s.chromeProfile;
    fields.apiHost.value = s.apiHost;
    fields.apiToken.value = s.apiToken;
    fields.forwardEnabled.checked = s.forwardEnabled;
    fields.captureAll.checked = s.captureAll;
  }
  var displayedRecent = [];
  async function refreshRecent() {
    const recent = await getRecent();
    const size = await queueSize();
    displayedRecent = recent.slice(-50).reverse();
    $("queueInfo").textContent = `queued for API: ${size}`;
    $("recent").value = displayedRecent.map((r) => `${r.capturedAt}  ${r.captureType.padEnd(8)} shop=${r.shopId ?? "?"}  ${r.url}`).join("\n");
  }
  function flashCopyStatus(msg) {
    const el = $("copyStatus");
    el.textContent = msg;
    setTimeout(() => el.textContent = "", 2e3);
  }
  async function copyBody(body, label) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(body, null, 2));
      flashCopyStatus(`copied ${label} \u2713`);
    } catch {
      flashCopyStatus("copy failed (select the text manually)");
    }
  }
  async function copyLatest(type) {
    const recent = await getRecent();
    const found = [...recent].reverse().find((r) => r.captureType === type);
    if (!found) return flashCopyStatus(`no ${type} capture yet`);
    await copyBody(found.body, `${type} (${found.url.slice(0, 40)}\u2026)`);
  }
  async function ensureApiPermission(apiHost) {
    if (!apiHost.trim()) return;
    try {
      const origin = new URL(apiHost).origin + "/*";
      await chrome.permissions.request({ origins: [origin] });
    } catch {
    }
  }
  $("save").addEventListener("click", async () => {
    const patch = {
      shopTag: fields.shopTag.value.trim(),
      vpsHost: fields.vpsHost.value.trim(),
      chromeProfile: fields.chromeProfile.value.trim(),
      apiHost: fields.apiHost.value.trim(),
      apiToken: fields.apiToken.value.trim(),
      forwardEnabled: fields.forwardEnabled.checked,
      captureAll: fields.captureAll.checked
    };
    if (patch.forwardEnabled && patch.apiHost) await ensureApiPermission(patch.apiHost);
    await saveSettings(patch);
    const status = $("status");
    status.textContent = "Saved \u2713";
    setTimeout(() => status.textContent = "", 1500);
  });
  $("refresh").addEventListener("click", () => void refreshRecent());
  $("clear").addEventListener("click", async () => {
    await clearRecent();
    await refreshRecent();
  });
  document.querySelectorAll("[data-copytype]").forEach((btn) => {
    btn.addEventListener("click", () => void copyLatest(btn.getAttribute("data-copytype") ?? ""));
  });
  $("recent").addEventListener("click", (e) => {
    const ta = e.currentTarget;
    const lineIndex = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    const rec = displayedRecent[lineIndex];
    if (rec) void copyBody(rec.body, `${rec.captureType} line`);
  });
  async function refreshAll() {
    const all = await getAll();
    const byKey = /* @__PURE__ */ new Map();
    for (const r of all) {
      const key = r.url.replace(/\d{3,}/g, "{id}").split("?")[0];
      const cur = byKey.get(key);
      if (cur) cur.count++;
      else byKey.set(key, { type: r.captureType, count: 1, sample: r.url });
    }
    const lines = [...byKey.entries()].sort((a, b) => b[1].count - a[1].count).map(([key, v]) => `${v.type.padEnd(10)} x${String(v.count).padStart(3)}  ${key}`);
    $("allInfo").textContent = `${all.length} responses \xB7 ${byKey.size} distinct endpoints`;
    $("allCaptures").value = lines.join("\n");
  }
  $("refreshAll").addEventListener("click", () => void refreshAll());
  $("clearAll").addEventListener("click", async () => {
    await clearAll();
    await refreshAll();
  });
  $("copyAll").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("allCaptures").value).catch(() => {
    });
  });
  void load();
  void refreshRecent();
  void refreshAll();
})();
