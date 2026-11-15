// Verifies remote runner modules: the command center signs each build with an
// ECDSA P-256 private key that only the server has; the extension embeds the
// public key. A module whose signature doesn't verify is never executed — so a
// compromised server URL or a man-in-the-middle can't push code into the shops.
import keyFile from "./module-key.json";

export const MODULE_PUBLIC_KEY: string | null = (keyFile as { spki: string | null }).spki;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The exact bytes that are signed: name, version and code, newline-separated. */
export function signedPayload(m: { name: string; version: string; code: string }): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(`${m.name}\n${m.version}\n${m.code}`);
  const out = new Uint8Array(new ArrayBuffer(enc.length));
  out.set(enc);
  return out;
}

export async function verifyModule(m: { name: string; version: string; code: string; sig: string }, spki = MODULE_PUBLIC_KEY): Promise<boolean> {
  if (!spki || !m?.sig || typeof m.code !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("spki", b64ToBytes(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64ToBytes(m.sig), signedPayload(m));
  } catch {
    return false;
  }
}
