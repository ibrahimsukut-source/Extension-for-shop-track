// Per-VPS runtime configuration, editable from the options page and stored in
// chrome.storage.local. Tokens are never committed to the repo (spec 9).
//
// In Phase 1 the only required field is shopTag (fallback shop identity). When
// apiHost + apiToken are set, matched captures are additionally forwarded to the
// central ingestion API (Phase 2); when they are absent, captures are only
// stored locally and logged to the console, exactly as Phase 1 requires.

export interface Settings {
  /** Central ingestion API base URL, e.g. https://api.example.com */
  apiHost: string;
  /** Bearer token for this VPS (unique per shop). */
  apiToken: string;
  /** Short internal shop tag; fallback shop identity for this VPS. */
  shopTag: string;
  /** Host name of the VPS this profile runs on (metadata for cross-check). */
  vpsHost: string;
  /** Chrome profile name (metadata for cross-check). */
  chromeProfile: string;
  /** Master switch for forwarding to the API. */
  forwardEnabled: boolean;
  /**
   * Discovery mode: record EVERY JSON response's URL (matched or not) into a
   * local diagnostic buffer, so real Etsy endpoints can be observed on the live
   * seller panel and folded into endpoints.config.json. Local-only; not forwarded.
   */
  captureAll: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiHost: "",
  apiToken: "",
  shopTag: "",
  vpsHost: "",
  chromeProfile: "",
  forwardEnabled: false,
  captureAll: false,
};

const KEY = "settings";

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** True when the API forwarding path is fully configured and enabled. */
export function canForward(s: Settings): boolean {
  return s.forwardEnabled && s.apiHost.trim() !== "" && s.apiToken.trim() !== "";
}
