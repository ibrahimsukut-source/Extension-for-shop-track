// In-memory Postgres (pg-mem) so the repository/service and HTTP routes can be
// tested without a live database. The schema is the single source of truth from
// src/memory_schema.ts (the same DDL the app applies in memory mode), so new
// tables are covered by tests automatically — no second copy to keep in sync.
import { newDb } from "pg-mem";
import type { Pool } from "../src/repository.js";
import { MEMORY_SCHEMA } from "../src/memory_schema.js";

export function makeTestPool(): Pool {
  const db = newDb();
  db.public.none(MEMORY_SCHEMA);
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as Pool;
}

let seq = 0;

/** Insert an unparsed raw_capture directly (bypasses the HTTP/ingest layer). */
export async function seedCapture(
  pool: Pool,
  input: { shopId: number; captureType: string; body: unknown; capturedAt: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO raw_captures (shop_id, source, capture_type, url, status, body, dedup_key, captured_at, parsed)
     VALUES ($1,'extension',$2,'',200,$3::jsonb,$4,$5,false)`,
    [input.shopId, input.captureType, JSON.stringify(input.body), `seed_${++seq}`, input.capturedAt]
  );
}
