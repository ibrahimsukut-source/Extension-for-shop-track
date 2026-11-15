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
  /** Command-center agent: poll for jobs and run them (needs apiHost + apiToken). */
  agentEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiHost: "",
  apiToken: "",
  shopTag: "",
  vpsHost: "",
  chromeProfile: "",
  forwardEnabled: false,
  captureAll: false,
  agentEnabled: true,
};

const KEY = "settings";

/**
 * Values pushed by Chrome policy (chrome.storage.managed, see managed_schema.json)
 * win over local edits — that is how a VPS is configured without touching the
 * options page: the token/host/shop tag come from the Windows registry.
 */
async function getManaged(): Promise<Partial<Settings>> {
  try {
    const m = (await chrome.storage.managed.get(null)) as Partial<Settings>;
    const out: Partial<Settings> = {};
    for (const [k, v] of Object.entries(m ?? {})) {
      if (v !== undefined && v !== null && v !== "") (out as Record<string, unknown>)[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined), ...(await getManaged()) };
}

/** Keys currently locked by policy (shown read-only in the options page). */
export async function managedKeys(): Promise<string[]> {
  return Object.keys(await getManaged());
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** True when the API forwarding path is fully configured and enabled. */
export function canRunAgent(s: Settings): boolean {
  return s.agentEnabled && s.apiHost.trim() !== "" && s.apiToken.trim() !== "";
}

export function canForward(s: Settings): boolean {
  return s.forwardEnabled && s.apiHost.trim() !== "" && s.apiToken.trim() !== "";
}
