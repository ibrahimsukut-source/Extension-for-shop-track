// Serves the page-runner as a SIGNED remote module. The extension only runs a
// module whose ECDSA P-256 signature verifies against the public key compiled
// into it (extension/src/agent/module-key.json), so whoever controls this
// server's key — and nobody else — can ship logic updates to every shop.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface ModuleStore {
  manifest(): Promise<{ name: string; version: string } | null>;
  get(name: string): Promise<{ name: string; version: string; code: string; sig: string; sha256: string } | null>;
}

export function signedPayload(name: string, version: string, code: string): Buffer {
  return Buffer.from(`${name}\n${version}\n${code}`, "utf8");
}

/**
 * @param runnerPath built extension/dist/page-runner.js (has an `oc-runner <version>` banner)
 * @param privateKeyPem PKCS#8 PEM of the signing key (MODULE_SIGNING_KEY). Empty = disabled.
 */
export function fileModuleStore(runnerPath: string, privateKeyPem: string): ModuleStore | undefined {
  if (!privateKeyPem.trim()) return undefined;
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  let cache: { mtime: string; mod: { name: string; version: string; code: string; sig: string; sha256: string } } | null = null;

  async function load() {
    const code = await readFile(runnerPath, "utf8");
    const hash = createHash("sha256").update(code).digest("hex");
    if (cache && cache.mtime === hash) return cache.mod;
    const version = /oc-runner ([\w.\-]+)/.exec(code)?.[1];
    if (!version) throw new Error(`no oc-runner version banner in ${runnerPath}`);
    const name = "page-runner";
    const sig = sign("sha256", signedPayload(name, version, code), { key, dsaEncoding: "ieee-p1363" }).toString("base64");
    cache = { mtime: hash, mod: { name, version, code, sig, sha256: hash } };
    return cache.mod;
  }

  return {
    async manifest() {
      try {
        const m = await load();
        return { name: m.name, version: m.version };
      } catch {
        return null;
      }
    },
    async get(name) {
      if (name !== "page-runner") return null;
      try {
        return await load();
      } catch {
        return null;
      }
    },
  };
}
