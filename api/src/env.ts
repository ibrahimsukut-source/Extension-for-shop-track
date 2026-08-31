// Minimal .env loader (no dependency). Reads KEY=VALUE lines from a .env file in
// the current directory and populates process.env for any key not already set.
// Called first thing by the runtime entrypoints so `cp .env.example .env` +
// `npm run dev` just works, without pulling in dotenv.
import { existsSync, readFileSync } from "node:fs";

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
