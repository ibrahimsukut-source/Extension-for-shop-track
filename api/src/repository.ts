// Data access (parameterized SQL, spec §4/§8). Kept ORM-free and pool-agnostic
// so it can run against a real pg Pool or an in-memory pg-mem Pool in tests.

/** Minimal surface we need from a pg Pool / client. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
}
export interface PoolClient extends Queryable {
  release(): void;
}

/** Digits-only ids are real Etsy shop ids; anything else is a shop-tag fallback. */
function numericOrNull(v: string | null): string | null {
  return v && /^\d+$/.test(v) ? v : null;
}

/** Upsert a shop by tag, backfilling etsy_shop_id / metadata when learned. */
export async function ensureShop(
  q: Queryable,
  input: { shopTag: string; etsyShopId?: string | null; vpsHost?: string | null; chromeProfile?: string | null }
): Promise<number> {
  const res = await q.query(
    `INSERT INTO shops (shop_tag, etsy_shop_id, vps_host, chrome_profile)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shop_tag) DO UPDATE SET
       etsy_shop_id   = COALESCE(shops.etsy_shop_id, EXCLUDED.etsy_shop_id),
       vps_host       = COALESCE(EXCLUDED.vps_host, shops.vps_host),
       chrome_profile = COALESCE(EXCLUDED.chrome_profile, shops.chrome_profile)
     RETURNING id`,
    [
      input.shopTag,
      numericOrNull(input.etsyShopId ?? null),
      input.vpsHost ?? null,
      input.chromeProfile ?? null,
    ]
  );
  return res.rows[0].id as number;
}

export interface RawCaptureRow {
  shopId: number;
  source: string;
  captureType: string;
  url: string;
  status: number;
  body: unknown;
  dedupKey: string;
  capturedAt: string;
}

/** Idempotent insert; returns true if a new row was stored, false if duplicate. */
export async function insertRawCapture(q: Queryable, r: RawCaptureRow): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO raw_captures
       (shop_id, source, capture_type, url, status, body, dedup_key, captured_at, parsed)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, false)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [r.shopId, r.source, r.captureType, r.url, r.status, JSON.stringify(r.body ?? null), r.dedupKey, r.capturedAt]
  );
  return (res.rowCount ?? 0) > 0;
}

export interface EventRow {
  shopId: number;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  actor: string | null;
  origin: string | null;
  occurredAt: string;
  payload: unknown;
  dedupKey: string;
}

export async function insertEvent(q: Queryable, e: EventRow): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO events
       (shop_id, event_type, entity_type, entity_id, actor, origin, occurred_at, payload, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      e.shopId,
      e.eventType,
      e.entityType,
      e.entityId,
      e.actor,
      e.origin,
      e.occurredAt,
      JSON.stringify(e.payload ?? null),
      e.dedupKey,
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Run fn inside a transaction on a dedicated client. */
export async function withTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
