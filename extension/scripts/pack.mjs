// Packs the extension as a signed CRX for self-hosted distribution (no Chrome
// Web Store). Chrome on each VPS installs it from the command center via the
// ExtensionInstallForcelist policy and auto-updates it from updates.xml.
//
//   EXT_SIGNING_KEY=/secure/agent-ext.pem \
//   COMMAND_CENTER_URL=https://magaza-crm.fly.dev \
//   node scripts/pack.mjs
//
// The .pem is the extension's identity: keep it OUT of the repo and back it up.
// Losing it means a new extension id → every VPS has to be re-enrolled.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crx3 from "crx3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = process.env.EXT_SIGNING_KEY;
const center = (process.env.COMMAND_CENTER_URL ?? "").replace(/\/+$/, "");
if (!keyPath || !center) {
  console.error("Set EXT_SIGNING_KEY (path to .pem, created if missing) and COMMAND_CENTER_URL.");
  process.exit(1);
}

if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`[pack] new extension signing key → ${keyPath} (back it up!)`);
}
const spki = createPublicKey(createPrivateKey(readFileSync(keyPath))).export({ type: "spki", format: "der" });
const extId = [...createHash("sha256").update(spki).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join("");

const version = JSON.parse(readFileSync(path.join(root, "src/manifest.json"), "utf8")).version;
execFileSync("node", ["build.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, EXT_UPDATE_URL: `${center}/ext/updates.xml`, EXT_KEY: spki.toString("base64") },
});

const dist = path.join(root, "dist");
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dist);

const outDir = path.join(root, "release");
mkdirSync(outDir, { recursive: true });
const crxName = `agent-${version}.crx`;
await crx3(files, { keyPath, crxPath: path.join(outDir, crxName), zipPath: path.join(outDir, `agent-${version}.zip`) });
writeFileSync(path.join(outDir, "latest.json"), JSON.stringify({ id: extId, version, crx: crxName }, null, 2));
console.log(`[pack] ${crxName}  id=${extId}  version=${version}`);
console.log(`[pack] policy value: ${extId};${center}/ext/updates.xml`);
