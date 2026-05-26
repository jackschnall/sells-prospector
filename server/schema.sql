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

-- Key Info (structured facts from calls — revenue, employees, services, etc.)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS key_info JSONB DEFAULT '{}'::JSONB;

-- Phone type (office | direct_cell | home)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_type TEXT DEFAULT 'office';

-- Call intelligence (accumulated summary from all calls with this company)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS call_intelligence TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS restricted BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_pass TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_from_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phones JSONB DEFAULT '[]'::JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT '[]'::JSONB;

-- ────────────────────────────────────────────────────────────────────────────
-- SMS Messages
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL DEFAULT 'outbound',  -- outbound | inbound
  to_number     TEXT NOT NULL,
  from_number   TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT DEFAULT 'sent',  -- sent | delivered | failed | received
  twilio_sid    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_company ON messages(company_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to      ON messages(to_number);

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
  restricted            BOOLEAN DEFAULT TRUE,
  twilio_phone_number   TEXT,
  disabled              BOOLEAN DEFAULT FALSE,
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
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,
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
ALTER TABLE call_logs ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS from_number             TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS voicemail_url           TEXT;
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

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recip_campaign ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recip_company  ON campaign_recipients(company_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Mandates (buy-side mandate management)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  buyer_name TEXT NOT NULL,
  buyer_logo_url TEXT,
  revenue_min INTEGER,
  revenue_max INTEGER,
  ebitda_min INTEGER,
  ebitda_max INTEGER,
  target_geographies JSONB DEFAULT '[]'::JSONB,
  target_verticals JSONB DEFAULT '[]'::JSONB,
  reporting_frequency TEXT DEFAULT 'biweekly',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mandate_companies (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deal_stage TEXT DEFAULT 'Qualify',
  next_step TEXT,
  nda_sent BOOLEAN DEFAULT FALSE,
  nda_signed BOOLEAN DEFAULT FALSE,
  offer_sent BOOLEAN DEFAULT FALSE,
  offer_signed BOOLEAN DEFAULT FALSE,
  offer_tev INTEGER,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mandate_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_mandate_companies_mandate ON mandate_companies(mandate_id);
CREATE INDEX IF NOT EXISTS idx_mandate_companies_company ON mandate_companies(company_id);

CREATE TABLE IF NOT EXISTS progress_reports (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  calls_made INTEGER DEFAULT 0,
  talk_time_seconds INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  new_companies_contacted INTEGER DEFAULT 0,
  companies_advanced INTEGER DEFAULT 0,
  notes TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_progress_reports_mandate ON progress_reports(mandate_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Pipeline Enrichment columns on companies
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS valuation INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS probability INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS est_close_date DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deal_owner_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deal_priority TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_steps TEXT;

-- ────────────────────────────────────────────────────────────────────────────
-- Deal Milestones (12-dot milestone strip per deal)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_milestones (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  state TEXT DEFAULT 'not_started',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, milestone_key)
);

CREATE INDEX IF NOT EXISTS idx_deal_milestones_company ON deal_milestones(company_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Pre-Engagement Watchlist
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pre_engagement (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  primary_contact TEXT,
  website TEXT,
  priority TEXT DEFAULT 'Medium',
  status TEXT DEFAULT 'New',
  next_action TEXT,
  first_contact_date DATE,
  initial_docs_sent BOOLEAN DEFAULT FALSE,
  initial_data_received BOOLEAN DEFAULT FALSE,
  initial_model_created BOOLEAN DEFAULT FALSE,
  notes TEXT,
  promoted_company_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pre_engagement_priority ON pre_engagement(priority);
CREATE INDEX IF NOT EXISTS idx_pre_engagement_status ON pre_engagement(status);

-- ────────────────────────────────────────────────────────────────────────────
-- Deal Contacts (linked contacts with role per deal)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_company ON deal_contacts(company_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Calendar Invites (Feature 2: Invite Tab)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_invites (
  id TEXT PRIMARY KEY,
  title TEXT,
  platform TEXT,
  meeting_date DATE,
  time_ct TEXT,
  attendees_json JSONB,
  invite_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Email Tracking (open-pixel tracking for campaigns)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_tracking (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  campaign_id TEXT,
  recipient_email TEXT,
  event_type TEXT DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_tracking_company ON email_tracking(company_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_opened ON email_tracking(opened_at);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS warm_until TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS warm_until TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────────────────────
-- Call Targets (named filter sets for the call queue)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  filter_industries JSONB DEFAULT '[]'::JSONB,
  filter_states JSONB DEFAULT '[]'::JSONB,
  filter_tiers JSONB DEFAULT '[]'::JSONB,
  filter_min_score NUMERIC,
  filter_max_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Advisor Network (referral partner pipeline)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advisors (
  id TEXT PRIMARY KEY,
  type TEXT CHECK(type IN ('cpa','ria','attorney','lender','coach','insurance','fractional_cfo')),
  name TEXT NOT NULL,
  firm TEXT,
  title TEXT,
  city TEXT,
  state TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  website TEXT,
  dossier_json JSONB,
  fit_score NUMERIC,
  fit_score_breakdown_json JSONB,
  relationship_score NUMERIC DEFAULT 0,
  relationship_stage TEXT DEFAULT 'identified',
  last_contact_date TIMESTAMPTZ,
  last_contact_channel TEXT,
  notes TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_researched_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_advisors_type ON advisors(type);
CREATE INDEX IF NOT EXISTS idx_advisors_state ON advisors(state);
CREATE INDEX IF NOT EXISTS idx_advisors_fit_score ON advisors(fit_score);
CREATE INDEX IF NOT EXISTS idx_advisors_relationship_stage ON advisors(relationship_stage);
CREATE INDEX IF NOT EXISTS idx_advisors_deleted ON advisors(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS advisor_credentials (
  id TEXT PRIMARY KEY,
  advisor_id TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  credential TEXT NOT NULL,
  earned_year INTEGER
);

CREATE INDEX IF NOT EXISTS idx_advisor_credentials_advisor ON advisor_credentials(advisor_id);

CREATE TABLE IF NOT EXISTS advisor_contacts (
  id TEXT PRIMARY KEY,
  advisor_id TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  contact_date TIMESTAMPTZ DEFAULT NOW(),
  channel TEXT,
  direction TEXT DEFAULT 'outbound',
  summary TEXT,
  next_action TEXT,
  next_action_date TIMESTAMPTZ,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advisor_contacts_advisor ON advisor_contacts(advisor_id);
CREATE INDEX IF NOT EXISTS idx_advisor_contacts_date ON advisor_contacts(contact_date DESC);
CREATE INDEX IF NOT EXISTS idx_advisor_contacts_next_action ON advisor_contacts(next_action_date) WHERE next_action_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  advisor_id TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  prospect_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  scope TEXT,
  status TEXT DEFAULT 'new',
  estimated_value NUMERIC,
  realized_value NUMERIC,
  fee_owed NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_advisor ON referrals(advisor_id);
CREATE INDEX IF NOT EXISTS idx_referrals_prospect ON referrals(prospect_id);
CREATE INDEX IF NOT EXISTS idx_referrals_direction ON referrals(direction);

CREATE TABLE IF NOT EXISTS advisor_owner_links (
  id TEXT PRIMARY KEY,
  advisor_id TEXT NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  link_type TEXT DEFAULT 'suspected',
  evidence TEXT,
  confidence NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(advisor_id, prospect_id)
);

CREATE INDEX IF NOT EXISTS idx_advisor_owner_links_advisor ON advisor_owner_links(advisor_id);
CREATE INDEX IF NOT EXISTS idx_advisor_owner_links_prospect ON advisor_owner_links(prospect_id);

-- Link call_logs and messages to advisors (nullable — a call is either to a company OR an advisor)
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS advisor_id TEXT REFERENCES advisors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_call_logs_advisor ON call_logs(advisor_id) WHERE advisor_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS advisor_id TEXT REFERENCES advisors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_advisor ON messages(advisor_id) WHERE advisor_id IS NOT NULL;

-- Notes for advisors (reuse existing notes table with nullable advisor_id)
ALTER TABLE notes ADD COLUMN IF NOT EXISTS advisor_id TEXT REFERENCES advisors(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notes_advisor ON notes(advisor_id) WHERE advisor_id IS NOT NULL;

-- Activities for advisors
ALTER TABLE activities ADD COLUMN IF NOT EXISTS advisor_id TEXT REFERENCES advisors(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_activities_advisor ON activities(advisor_id) WHERE advisor_id IS NOT NULL;
