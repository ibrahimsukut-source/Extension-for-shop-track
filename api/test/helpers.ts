// In-memory Postgres (pg-mem) so the repository/service and HTTP routes can be
// tested without a live database. The schema here mirrors the columns used by
// the queries (a subset of db/schema.sql, avoiding features pg-mem lacks).
import { newDb } from "pg-mem";
import type { Pool } from "../src/repository.js";

const TEST_SCHEMA = `
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  shop_tag TEXT UNIQUE NOT NULL,
  etsy_shop_id BIGINT,
  shop_name TEXT,
  vps_host TEXT,
  gmail_account TEXT,
  chrome_profile TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE raw_captures (
  id SERIAL PRIMARY KEY,
  shop_id BIGINT,
  source TEXT,
  capture_type TEXT,
  url TEXT,
  status INT,
  body JSONB,
  dedup_key TEXT UNIQUE,
  captured_at TIMESTAMPTZ,
  parsed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  shop_id BIGINT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  actor TEXT,
  origin TEXT,
  occurred_at TIMESTAMPTZ,
  payload JSONB,
  dedup_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

export function makeTestPool(): Pool {
  const db = newDb();
  db.public.none(TEST_SCHEMA);
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as Pool;
}
