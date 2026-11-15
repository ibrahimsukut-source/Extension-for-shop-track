// One-time: create the key pair that signs remote runner modules.
//   node scripts/module-keys.mjs
// Prints the PRIVATE key (set it as the MODULE_SIGNING_KEY secret on the
// server; never commit it) and writes the PUBLIC key into the extension source
// (extension/src/agent/module-key.json) — rebuild/re-pack the extension after.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension/src/agent/module-key.json");
const json = JSON.parse(readFileSync(file, "utf8"));
json.spki = spki;
writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
console.log(`public key written to ${file}\n`);
console.log("MODULE_SIGNING_KEY (keep secret):\n");
console.log(privateKey.export({ type: "pkcs8", format: "pem" }));
