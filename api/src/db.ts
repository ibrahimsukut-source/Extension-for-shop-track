// Real PostgreSQL pool. Tests inject a pg-mem pool instead, so this module is
// only imported by the runtime entrypoints (index / migrate).
import pg from "pg";
import type { Pool } from "./repository.js";

export function createPool(databaseUrl: string): Pool & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return pool as unknown as Pool & { end(): Promise<void> };
}
