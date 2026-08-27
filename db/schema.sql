-- ============================================================================
-- Etsy Multi-Shop Tracker — PostgreSQL schema (spec section 5)
--
-- Two layers:
--   * append-only EVENT LOG      — "what I did" (interventions)
--   * SNAPSHOT time series        — "what the state was"
-- Analytic value lives in correlating the two (section 6).
--
-- All timestamps are TIMESTAMPTZ. Align stats days with Etsy's reporting TZ
-- so daily metrics don't drift (section 11).
--
-- This file is the reference DDL for Phase 2+. Apply via your migration tool
-- of choice (node-pg-migrate / Prisma migrate); it is written to be runnable
-- directly (idempotent-ish with IF NOT EXISTS where practical).
-- ============================================================================

-- ── Reference ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id             BIGSERIAL PRIMARY KEY,
  shop_tag       TEXT UNIQUE NOT NULL,        -- short internal name
  etsy_shop_id   BIGINT,
  shop_name      TEXT,
  vps_host       TEXT,
  gmail_account  TEXT,
  chrome_profile TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ── Raw captures (always retained so parsing can be re-run) ──────────────────
CREATE TABLE IF NOT EXISTS raw_captures (
  id           BIGSERIAL PRIMARY KEY,
  shop_id      BIGINT REFERENCES shops(id),
  source       TEXT,                          -- extension | cdp | api
  capture_type TEXT,                          -- stats | messages | ads | listing | order ...
  url          TEXT,
  status       INT,
  body         JSONB,
  dedup_key    TEXT UNIQUE,
  captured_at  TIMESTAMPTZ,
  parsed       BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_raw_captures_shop_time ON raw_captures (shop_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_raw_captures_unparsed ON raw_captures (parsed) WHERE parsed = false;

-- ── EVENT LOG (append-only): your interventions ─────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  shop_id     BIGINT REFERENCES shops(id),
  event_type  TEXT NOT NULL,   -- listing_edit | listing_delete | deactivate | activate |
                               -- photo_changed | price_change | tag_change | ad_on | ad_off | reply_sent
  entity_type TEXT,            -- listing | ad | conversation | order
  entity_id   TEXT,
  actor       TEXT,            -- who / automation
  origin      TEXT,            -- dom_click | interception | snapshot_diff
  occurred_at TIMESTAMPTZ NOT NULL,
  payload     JSONB,           -- {old:..., new:...} change detail
  dedup_key   TEXT UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_shop_time ON events (shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_shop_type_time ON events (shop_id, event_type, occurred_at);

-- ── LISTING SNAPSHOT (state time series + diff source) ──────────────────────
CREATE TABLE IF NOT EXISTS listing_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  shop_id      BIGINT REFERENCES shops(id),
  listing_id   BIGINT NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL,
  title        TEXT,
  state        TEXT,            -- active | inactive | draft | expired | sold_out
  price        NUMERIC(12,2),
  currency     TEXT,
  quantity     INT,
  tags         JSONB,
  num_images   INT,
  image_hashes JSONB,           -- for photo-change diffing
  section_id   BIGINT,
  views        INT,
  favorites    INT,
  raw          JSONB,
  UNIQUE (shop_id, listing_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_listing_snap_recent
  ON listing_snapshots (shop_id, listing_id, captured_at DESC);

-- ── STATS (daily shop metrics) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stats_daily (
  shop_id          BIGINT REFERENCES shops(id),
  stat_date        DATE NOT NULL,
  visits           INT,
  views            INT,
  orders           INT,
  revenue          NUMERIC(12,2),
  currency         TEXT,
  conversion_rate  NUMERIC(6,4),
  traffic_sources  JSONB,        -- {etsy_search:.., direct:.., ads:.., social:..}
  top_search_terms JSONB,
  captured_at      TIMESTAMPTZ,
  PRIMARY KEY (shop_id, stat_date)
);

-- optional: per-listing daily stats
CREATE TABLE IF NOT EXISTS listing_stats_daily (
  shop_id     BIGINT REFERENCES shops(id),
  listing_id  BIGINT,
  stat_date   DATE,
  views       INT,
  visits      INT,
  favorites   INT,
  orders      INT,
  revenue     NUMERIC(12,2),
  PRIMARY KEY (shop_id, listing_id, stat_date)
);

-- ── ETSY ADS (daily) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_daily (
  shop_id           BIGINT REFERENCES shops(id),
  stat_date         DATE,
  listing_id        BIGINT,       -- NULL = shop total
  state             TEXT,         -- on | off
  spend             NUMERIC(12,2),
  impressions       INT,
  clicks            INT,
  orders_from_ads   INT,
  revenue_from_ads  NUMERIC(12,2),
  PRIMARY KEY (shop_id, stat_date, listing_id)
);

-- ── ORDERS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  shop_id          BIGINT REFERENCES shops(id),
  receipt_id       BIGINT,
  ordered_at       TIMESTAMPTZ,
  buyer_hash       TEXT,             -- PII minimization; never store raw buyer info
  total            NUMERIC(12,2),
  currency         TEXT,
  status           TEXT,
  is_ad_attributed BOOLEAN,
  raw              JSONB,
  PRIMARY KEY (shop_id, receipt_id)
);
CREATE TABLE IF NOT EXISTS order_items (
  shop_id         BIGINT,
  receipt_id      BIGINT,
  listing_id      BIGINT,
  quantity        INT,
  price           NUMERIC(12,2),
  personalization TEXT,
  PRIMARY KEY (shop_id, receipt_id, listing_id)
);

-- ── REVIEWS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  shop_id      BIGINT REFERENCES shops(id),
  review_id    TEXT,
  listing_id   BIGINT,
  rating       INT,
  review_text  TEXT,
  reviewed_at  TIMESTAMPTZ,
  buyer_hash   TEXT,
  response     TEXT,
  responded_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, review_id)
);

-- ── MESSAGES (response-time derivation) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_threads (
  shop_id         BIGINT REFERENCES shops(id),
  thread_id       TEXT,
  buyer_hash      TEXT,
  last_message_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, thread_id)
);
CREATE TABLE IF NOT EXISTS messages (
  shop_id    BIGINT,
  thread_id  TEXT,
  message_id TEXT,
  direction  TEXT,             -- in | out
  sent_at    TIMESTAMPTZ,
  has_text   BOOLEAN,
  PRIMARY KEY (shop_id, thread_id, message_id)
);
