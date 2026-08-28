// Runtime configuration, loaded from environment. Secrets (DB URL, per-VPS
// ingestion tokens) never live in the repo — see .env.example (spec §9).

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  /** token -> shop_tag. One unique token per VPS/shop (spec §9). */
  tokenToShop: Map<string, string>;
  /** Max records accepted in a single ingest batch. */
  maxBatch: number;
  /** Run the parse job automatically after each ingest (local/live demo). */
  autoParse: boolean;
  /** Optional key gating the read-only dashboard; empty = open (local dev). */
  dashboardKey: string;
}

/**
 * Parse INGEST_TOKENS. Accepts a JSON object mapping shop_tag -> token, e.g.
 *   INGEST_TOKENS='{"my-shop-01":"tok_abc","shop-02":"tok_def"}'
 * Returns the reverse map (token -> shop_tag) used for auth.
 */
export function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || raw.trim() === "") return map;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("INGEST_TOKENS must be valid JSON: { shop_tag: token, ... }");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("INGEST_TOKENS must be a JSON object of shop_tag -> token");
  }
  for (const [shopTag, token] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length < 8) {
      throw new Error(`INGEST_TOKENS: token for "${shopTag}" must be a string of >= 8 chars`);
    }
    if (map.has(token)) {
      throw new Error("INGEST_TOKENS: duplicate token across shops");
    }
    map.set(token, shopTag);
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required. Copy api/.env.example to api/.env and set it, " +
        "then start Postgres (e.g. `docker compose up -d`) and run `npm run migrate`."
    );
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    tokenToShop: parseTokens(env.INGEST_TOKENS),
    maxBatch: Number(env.MAX_BATCH ?? 500),
    autoParse: /^(1|true|yes|on)$/i.test(env.AUTO_PARSE ?? ""),
    dashboardKey: env.DASHBOARD_KEY ?? "",
  };
}
