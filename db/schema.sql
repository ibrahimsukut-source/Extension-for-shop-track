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
-- Etsy runs two separate ad programs that both report at shop-wide (listing_id
-- = 0) granularity: on-site Etsy Ads (spend/impressions/ROAS,
-- GET /prolist/stats) and Offsite Ads (clicks only, ad-traffic). `channel` is
-- part of the key so parsing one program never overwrites the other's row
-- for the same (shop, date, listing).
CREATE TABLE IF NOT EXISTS ads_daily (
  shop_id           BIGINT REFERENCES shops(id),
  stat_date         DATE,
  listing_id        BIGINT,       -- 0 = shop total (PK columns cannot be NULL)
  channel           TEXT NOT NULL DEFAULT 'unknown', -- onsite | offsite | unknown
  state             TEXT,         -- on | off
  spend             NUMERIC(12,2),
  impressions       INT,
  clicks            INT,
  orders_from_ads   INT,
  revenue_from_ads  NUMERIC(12,2),
  PRIMARY KEY (shop_id, stat_date, listing_id, channel)
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
  direction  TEXT,             -- in | out (NULL until the seller's user id is known)
  sender_id  BIGINT,           -- Etsy user id of the sender (for direction backfill)
  sent_at    TIMESTAMPTZ,
  has_text   BOOLEAN,
  PRIMARY KEY (shop_id, thread_id, message_id)
);

-- ============================================================================
-- ANALYSIS ENGINE (causal / effect analysis — product spec §6)
--
-- The collection layer above answers "what happened". These tables answer the
-- real question: "I made intervention X → what was the effect Z, net of what
-- would have happened anyway?" Never a bare "X caused Y": every effect carries
-- a control-adjusted estimate, a confidence label, and explicit caveats.
-- ============================================================================

-- First-class "what I did" ledger. Snapshot-diff and interception both feed it;
-- dedup_key collapses the same change seen from two sources. Distinct from the
-- events log: an intervention is the analysis unit an experiment attaches to.
CREATE TABLE IF NOT EXISTS interventions (
  id                BIGSERIAL PRIMARY KEY,
  shop_id           BIGINT NOT NULL REFERENCES shops(id),
  intervention_type TEXT NOT NULL,   -- price_changed | listing_deactivated | photo_changed ...
  entity_type       TEXT,            -- listing | ad | shop | conversation
  entity_id         TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  before_value      JSONB,
  after_value       JSONB,
  magnitude         NUMERIC,         -- signed change size when numeric (e.g. price delta)
  source            TEXT,            -- snapshot_diff | interception | dom_click
  is_clean_window   BOOLEAN,         -- no overlapping intervention in the effect window
  confidence        NUMERIC,         -- detector confidence the intervention really happened
  dedup_key         TEXT UNIQUE,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interventions_shop_time
  ON interventions (shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_interventions_shop_type_time
  ON interventions (shop_id, intervention_type, occurred_at);

-- Long-format metric time series (analysis-ready). One row per
-- (shop, scope, entity, metric, day). entity_id = '' for shop scope (a PK
-- column cannot be NULL), else the listing_id as text.
CREATE TABLE IF NOT EXISTS metric_timeseries (
  shop_id     BIGINT NOT NULL REFERENCES shops(id),
  scope       TEXT NOT NULL,              -- shop | listing
  entity_id   TEXT NOT NULL DEFAULT '',
  metric      TEXT NOT NULL,              -- views | visits | favorites | orders | revenue | conversion_rate
  metric_date DATE NOT NULL,
  value       NUMERIC,
  PRIMARY KEY (shop_id, scope, entity_id, metric, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_metric_ts_lookup
  ON metric_timeseries (shop_id, scope, entity_id, metric, metric_date);

-- One quasi-experiment per (intervention, metric, window). baseline_start/_end
-- replace the spec's DATERANGE for portability (pg-mem has no range types).
CREATE TABLE IF NOT EXISTS experiments (
  id               BIGSERIAL PRIMARY KEY,
  intervention_id  BIGINT REFERENCES interventions(id),
  shop_id          BIGINT REFERENCES shops(id),
  entity_id        TEXT,
  metric           TEXT,
  method           TEXT,            -- its | did | matched | synthetic | event_study
  baseline_start   DATE,
  baseline_end     DATE,
  effect_window    TEXT,            -- t+1..t+3 | t+4..t+14 | t+15..t+30
  control_group_id BIGINT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Which control entities stand in for the counterfactual of a treated entity.
CREATE TABLE IF NOT EXISTS control_assignments (
  id             BIGSERIAL PRIMARY KEY,
  treated_entity TEXT,
  control_entity TEXT,
  shop_id        BIGINT REFERENCES shops(id),
  match_score    NUMERIC,
  match_reason   JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- The estimated effect: point estimate + CI, control-adjusted flag, a cautious
-- confidence label, and caveats (freshness / seasonality / overlap).
CREATE TABLE IF NOT EXISTS effects (
  id                BIGSERIAL PRIMARY KEY,
  experiment_id     BIGINT REFERENCES experiments(id),
  shop_id           BIGINT REFERENCES shops(id),
  intervention_type TEXT,
  metric            TEXT,
  effect_window     TEXT,
  point_estimate    NUMERIC,
  ci_low            NUMERIC,
  ci_high           NUMERIC,
  control_adjusted  BOOLEAN,
  confidence_label  TEXT,            -- low | medium | high
  caveats           JSONB,
  computed_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_effects_shop_type
  ON effects (shop_id, intervention_type, metric);

-- ── Derived: first-response time per thread (spec §5.1) ─────────────────────
CREATE OR REPLACE VIEW response_metrics AS
WITH firsts AS (
  SELECT shop_id, thread_id,
         MIN(sent_at) FILTER (WHERE direction = 'in')  AS first_in,
         MIN(sent_at) FILTER (WHERE direction = 'out') AS first_out
  FROM messages
  GROUP BY shop_id, thread_id
)
SELECT
  shop_id,
  thread_id,
  first_in,
  first_out,
  EXTRACT(EPOCH FROM (first_out - first_in)) AS first_response_seconds
FROM firsts
WHERE first_in IS NOT NULL
  AND first_out IS NOT NULL
  AND first_out >= first_in;
