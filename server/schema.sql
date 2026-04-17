-- Sells M&A Prospector — Postgres schema
-- Run once: psql $DATABASE_URL -f server/schema.sql

-- ────────────────────────────────────────────────────────────────────────────
-- Companies
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL UNIQUE,
  city            TEXT,
  state           TEXT,
  phone           TEXT,
  website         TEXT,
  owner           TEXT,
  email           TEXT,
  address         TEXT,
  linkedin        TEXT,
  crm_known       BOOLEAN DEFAULT FALSE,
  crm_override    BOOLEAN DEFAULT FALSE,
  salesforce_id   TEXT,
  status          TEXT DEFAULT 'pending',
  score           NUMERIC,
  tier            TEXT,
  signals_json    JSONB,
  flags_json      JSONB,
  summary         TEXT,
  outreach_angle  TEXT,
  sources_json    JSONB,
  raw_research    TEXT,
  marked_for_outreach BOOLEAN DEFAULT FALSE,
  outreach_status TEXT DEFAULT 'no_contact',
  last_researched_at TIMESTAMPTZ,
  -- Pipeline columns
  pipeline_stage          TEXT DEFAULT 'no_contact',
  closed_lost_reason      TEXT,
  pipeline_stage_changed_at TIMESTAMPTZ,
  assigned_to             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_tier   ON companies(tier);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_score  ON companies(score);
CREATE INDEX IF NOT EXISTS idx_companies_pipeline ON companies(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_companies_name_key ON companies(name_key);

-- Contact enrichment (Phase 1 identity + Phase 2 people-search)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_enrichment JSONB;

-- Industry vertical
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry TEXT DEFAULT 'Plumbing';

-- Soft-delete
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_companies_deleted ON companies(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_deleted  ON contacts(deleted_at) WHERE deleted_at IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Notes (legacy — new notes go to activities, kept for backward compat)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Config (key-value store)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ────────────────────────────────────────────────────────────────────────────
-- Users
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT,
  role                  TEXT DEFAULT 'analyst',
  invite_token          TEXT UNIQUE,
  assigned_verticals    JSONB DEFAULT '[]'::JSONB,
  assigned_territories  JSONB DEFAULT '[]'::JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Contacts (people at companies)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  title       TEXT,
  phone       TEXT,
  email       TEXT,
  linkedin    TEXT,
  is_primary  BOOLEAN DEFAULT FALSE,
  source      TEXT DEFAULT 'manual',
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Activities (timeline per company)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  details     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_company ON activities(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Markets (market intelligence)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markets (
  key                TEXT PRIMARY KEY,
  city               TEXT NOT NULL,
  state              TEXT NOT NULL,
  population         INTEGER,
  msa_name           TEXT,
  addressable        INTEGER,
  loaded             INTEGER,
  tier               TEXT,
  score              NUMERIC,
  confidence         TEXT,
  sources_json       JSONB,
  population_growth  NUMERIC,
  median_home_value  INTEGER,
  housing_permits    INTEGER,
  housing_age_score  NUMERIC,
  plumbing_density   NUMERIC,
  ma_activity_score  NUMERIC,
  market_score       NUMERIC,
  saturation_status  TEXT,
  home_sales_volume  INTEGER,
  analyzed_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_markets_tier  ON markets(tier);
CREATE INDEX IF NOT EXISTS idx_markets_score ON markets(score);

-- ────────────────────────────────────────────────────────────────────────────
-- Call Logs (future: Twilio integration)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  direction     TEXT DEFAULT 'outbound',
  duration_sec  INTEGER,
  disposition   TEXT,
  notes         TEXT,
  recording_url TEXT,
  called_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_company ON call_logs(company_id);

-- Phase 2 CRM additions — call intelligence
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_sid                TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_sid           TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS status                  TEXT DEFAULT 'initiated';
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcript              TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_summary              JSONB;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sentiment               TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS scheduling_detected     BOOLEAN DEFAULT FALSE;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS scheduled_callback_date DATE;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS next_action             TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS outreach_angle_refined  TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS debrief_status          TEXT DEFAULT 'pending';
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS debrief_qa              JSONB;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS debrief_questions       JSONB;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS debrief_draft           JSONB;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS mock                    BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_call_logs_user           ON call_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_called_at      ON call_logs(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_debrief_status ON call_logs(debrief_status);
CREATE INDEX IF NOT EXISTS idx_call_logs_scheduled_date ON call_logs(scheduled_callback_date) WHERE scheduled_callback_date IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Calendar Events (future: scheduling integration)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  event_type   TEXT DEFAULT 'meeting',
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ,
  location     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_company ON calendar_events(company_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_starts  ON calendar_events(starts_at);

-- Phase 2 CRM additions — auto-scheduling from transcripts
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source           TEXT DEFAULT 'manual';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS transcript_quote TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS completed        BOOLEAN DEFAULT FALSE;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS call_log_id      TEXT REFERENCES call_logs(id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Queue skips — prevents the same company appearing twice in one user's day
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_skips (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skipped_on DATE NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (user_id, company_id, skipped_on)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Email Campaigns
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  subject_template TEXT NOT NULL DEFAULT '',
  body_template    TEXT NOT NULL DEFAULT '',
  status           TEXT DEFAULT 'draft',  -- draft | ready | sending | sent
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  sent_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_email      TEXT,
  merged_subject TEXT,
  merged_body   TEXT,
  status        TEXT DEFAULT 'pending',  -- pending | sent | failed | skipped
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  UNIQUE (campaign_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recip_campaign ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recip_company  ON campaign_recipients(company_id);
