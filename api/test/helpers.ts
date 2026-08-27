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
CREATE TABLE stats_daily (
  shop_id BIGINT, stat_date DATE, visits INT, views INT, orders INT,
  revenue NUMERIC(12,2), currency TEXT, conversion_rate NUMERIC(6,4),
  traffic_sources JSONB, top_search_terms JSONB, captured_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, stat_date)
);
CREATE TABLE listing_stats_daily (
  shop_id BIGINT, listing_id BIGINT, stat_date DATE, views INT, visits INT,
  favorites INT, orders INT, revenue NUMERIC(12,2),
  PRIMARY KEY (shop_id, listing_id, stat_date)
);
CREATE TABLE listing_snapshots (
  id SERIAL PRIMARY KEY, shop_id BIGINT, listing_id BIGINT, captured_at TIMESTAMPTZ,
  title TEXT, state TEXT, price NUMERIC(12,2), currency TEXT, quantity INT,
  tags JSONB, num_images INT, image_hashes JSONB, section_id BIGINT,
  views INT, favorites INT, raw JSONB,
  UNIQUE (shop_id, listing_id, captured_at)
);
CREATE TABLE ads_daily (
  shop_id BIGINT, stat_date DATE, listing_id BIGINT, state TEXT,
  spend NUMERIC(12,2), impressions INT, clicks INT, orders_from_ads INT,
  revenue_from_ads NUMERIC(12,2),
  PRIMARY KEY (shop_id, stat_date, listing_id)
);
CREATE TABLE orders (
  shop_id BIGINT, receipt_id BIGINT, ordered_at TIMESTAMPTZ, buyer_hash TEXT,
  total NUMERIC(12,2), currency TEXT, status TEXT, is_ad_attributed BOOLEAN, raw JSONB,
  PRIMARY KEY (shop_id, receipt_id)
);
CREATE TABLE order_items (
  shop_id BIGINT, receipt_id BIGINT, listing_id BIGINT, quantity INT,
  price NUMERIC(12,2), personalization TEXT,
  PRIMARY KEY (shop_id, receipt_id, listing_id)
);
CREATE TABLE reviews (
  shop_id BIGINT, review_id TEXT, listing_id BIGINT, rating INT, review_text TEXT,
  reviewed_at TIMESTAMPTZ, buyer_hash TEXT, response TEXT, responded_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, review_id)
);
CREATE TABLE message_threads (
  shop_id BIGINT, thread_id TEXT, buyer_hash TEXT, last_message_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, thread_id)
);
CREATE TABLE messages (
  shop_id BIGINT, thread_id TEXT, message_id TEXT, direction TEXT,
  sent_at TIMESTAMPTZ, has_text BOOLEAN,
  PRIMARY KEY (shop_id, thread_id, message_id)
);
`;

export function makeTestPool(): Pool {
  const db = newDb();
  db.public.none(TEST_SCHEMA);
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
