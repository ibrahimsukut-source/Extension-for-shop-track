// Agent / command-center tables. One DDL string, valid for both real Postgres
// (appended to db/schema.sql by migrate) and pg-mem (appended to MEMORY_SCHEMA).
// Keyed by shop_tag (the same identity the per-shop ingest token resolves to),
// so this layer can be mounted inside another app (magaza-crm) without
// depending on the analytics `shops` table.
export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  shop_tag        TEXT PRIMARY KEY,
  agent_id        TEXT,
  ext_version     TEXT,
  module_version  TEXT,
  etsy_shop_id    BIGINT,
  shop_name       TEXT,
  logged_in       BOOLEAN,
  paused          BOOLEAN DEFAULT false,
  last_seen       TIMESTAMPTZ,
  last_error      TEXT,
  state           JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id            SERIAL PRIMARY KEY,
  shop_tag      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  params        JSONB,
  status        TEXT NOT NULL DEFAULT 'queued',
  priority      INT DEFAULT 0,
  origin        TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  not_before    TIMESTAMPTZ,
  leased_at     TIMESTAMPTZ,
  lease_until   TIMESTAMPTZ,
  attempts      INT DEFAULT 0,
  max_attempts  INT DEFAULT 2,
  finished_at   TIMESTAMPTZ,
  result        JSONB,
  error         TEXT,
  suggestion_id INT
);
CREATE TABLE IF NOT EXISTS action_log (
  id            SERIAL PRIMARY KEY,
  job_id        INT,
  shop_tag      TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  before_state  JSONB,
  after_state   JSONB,
  verified      BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ads_campaign_latest (
  shop_tag          TEXT PRIMARY KEY,
  budget_cents      INT,
  is_active         BOOLEAN,
  status            INT,
  min_budget_cents  INT,
  max_budget_cents  INT,
  promoted_count    INT,
  currency          TEXT,
  range_start       DATE,
  range_end         DATE,
  totals            JSONB,
  daily             JSONB,
  captured_at       TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ads_listing_latest (
  shop_tag       TEXT NOT NULL,
  listing_id     BIGINT NOT NULL,
  range_start    DATE,
  range_end      DATE,
  title          TEXT,
  image_url      TEXT,
  is_promoted    BOOLEAN,
  strategy       INT,
  price_minor    INT,
  currency       TEXT,
  quantity       INT,
  section        TEXT,
  impressions    INT,
  clicks         INT,
  spend_cents    INT,
  orders         INT,
  revenue_cents  INT,
  roas           NUMERIC(10,2),
  click_rate     NUMERIC(8,2),
  captured_at    TIMESTAMPTZ,
  PRIMARY KEY (shop_tag, listing_id)
);
CREATE TABLE IF NOT EXISTS ads_query_latest (
  shop_tag       TEXT NOT NULL,
  listing_id     BIGINT NOT NULL,
  query          TEXT NOT NULL,
  range_start    DATE,
  impressions    INT,
  clicks         INT,
  orders         INT,
  cost_cents     INT,
  revenue_cents  INT,
  roas           NUMERIC(10,2),
  click_rate     NUMERIC(8,2),
  is_relevant    BOOLEAN,
  captured_at    TIMESTAMPTZ,
  PRIMARY KEY (shop_tag, listing_id, query)
);
CREATE TABLE IF NOT EXISTS shop_stats_latest (
  shop_tag        TEXT NOT NULL,
  range_key       TEXT NOT NULL,
  start_date      TEXT,
  end_date        TEXT,
  visits          INT,
  orders          INT,
  revenue         TEXT,
  conversion_rate TEXT,
  aov             TEXT,
  traffic         JSONB,
  daily           JSONB,
  top_listings    JSONB,
  captured_at     TIMESTAMPTZ,
  PRIMARY KEY (shop_tag, range_key)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id          SERIAL PRIMARY KEY,
  shop_tag    TEXT NOT NULL,
  rule        TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  params      JSONB,
  reason      TEXT,
  evidence    JSONB,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  job_id      INT
);
`;
