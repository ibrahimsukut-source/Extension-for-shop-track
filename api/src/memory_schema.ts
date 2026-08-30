// Schema applied to the zero-install in-memory database (pg-mem). It mirrors the
// columns the app uses from db/schema.sql, but omits Postgres-only features
// pg-mem doesn't implement (the response_metrics view, partial indexes). Used
// only when DATABASE_URL is "memory"/empty — a real Postgres uses db/schema.sql.
export const MEMORY_SCHEMA = `
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
  shop_id BIGINT, stat_date DATE, listing_id BIGINT,
  channel TEXT NOT NULL DEFAULT 'unknown', state TEXT,
  spend NUMERIC(12,2), impressions INT, clicks INT, orders_from_ads INT,
  revenue_from_ads NUMERIC(12,2),
  PRIMARY KEY (shop_id, stat_date, listing_id, channel)
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
  shop_id BIGINT, thread_id TEXT, message_id TEXT, direction TEXT, sender_id BIGINT,
  sent_at TIMESTAMPTZ, has_text BOOLEAN,
  PRIMARY KEY (shop_id, thread_id, message_id)
);

-- ── ANALYSIS ENGINE (causal / effect analysis, product spec §6) ────────────
-- First-class "what I did" ledger. Snapshot-diff and interception both feed it;
-- dedup_key collapses the same change seen from two sources.
CREATE TABLE interventions (
  id SERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  intervention_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  before_value JSONB,
  after_value JSONB,
  magnitude NUMERIC,
  source TEXT,
  is_clean_window BOOLEAN,
  confidence NUMERIC,
  dedup_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- Long-format metric time series (analysis-ready). entity_id = '' for shop scope
-- (a PK column cannot be NULL), else the listing_id as text.
CREATE TABLE metric_timeseries (
  shop_id BIGINT NOT NULL,
  scope TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  metric_date DATE NOT NULL,
  value NUMERIC,
  PRIMARY KEY (shop_id, scope, entity_id, metric, metric_date)
);
-- One quasi-experiment per (intervention, metric, window). baseline_start/_end
-- replace the spec's DATERANGE for portability (pg-mem has no range types).
CREATE TABLE experiments (
  id SERIAL PRIMARY KEY,
  intervention_id BIGINT,
  shop_id BIGINT,
  entity_id TEXT,
  metric TEXT,
  method TEXT,
  baseline_start DATE,
  baseline_end DATE,
  effect_window TEXT,
  control_group_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE control_assignments (
  id SERIAL PRIMARY KEY,
  treated_entity TEXT,
  control_entity TEXT,
  shop_id BIGINT,
  match_score NUMERIC,
  match_reason JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE effects (
  id SERIAL PRIMARY KEY,
  experiment_id BIGINT,
  shop_id BIGINT,
  intervention_type TEXT,
  metric TEXT,
  effect_window TEXT,
  point_estimate NUMERIC,
  ci_low NUMERIC,
  ci_high NUMERIC,
  control_adjusted BOOLEAN,
  confidence_label TEXT,
  caveats JSONB,
  computed_at TIMESTAMPTZ DEFAULT now()
);
`;
