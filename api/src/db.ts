// Database pool factory. Two modes:
//   * real PostgreSQL (DATABASE_URL=postgres://…) — persistent.
//   * zero-install in-memory (DATABASE_URL empty or "memory") — pg-mem, no
//     Docker/Postgres needed; data is NOT persisted (great for a local live demo).
import pg from "pg";
import type { Pool } from "./repository.js";
import { MEMORY_SCHEMA } from "./memory_schema.js";

type EndablePool = Pool & { end(): Promise<void> };

export function isMemory(databaseUrl: string): boolean {
  const v = databaseUrl.trim().toLowerCase();
  return v === "" || v === "memory" || v === ":memory:";
}

export async function createMemoryPool(): Promise<EndablePool> {
  // Dynamic import so pg-mem is only loaded when actually running in-memory.
  const { newDb } = await import("pg-mem");
  const db = newDb();
  db.public.none(MEMORY_SCHEMA);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return Object.assign(pool as unknown as Pool, { async end() {} });
}

export async function createPool(databaseUrl: string): Promise<EndablePool> {
  if (isMemory(databaseUrl)) return createMemoryPool();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return pool as unknown as EndablePool;
}
