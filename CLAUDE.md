# Sells M&A Prospector — Claude Code Research Engine

## What This Is

A plumbing company M&A target research tool for Sells (middle-market investment bank).
The web app (Express + PostgreSQL + vanilla frontend) is deployed at:
**https://sells-prospector-production-f51b.up.railway.app/**

Claude Code acts as the research agent — no Anthropic API key needed. You use
WebSearch to research each company and `cc-inject.js` to write results into the database.

## Database

PostgreSQL via `pg` Pool. Set `DATABASE_URL` env var (e.g. `postgresql://user:pass@host:5432/dbname`).
Schema is in `server/schema.sql` and auto-applied on startup via `initSchema()`.
All DB calls are async — every server file uses `await` with the pool.

## CLI Commands

```bash
DATABASE_URL=... node server/cc-inject.js list-pending          # Companies needing research
DATABASE_URL=... node server/cc-inject.js list-all              # All companies (slim JSON)
DATABASE_URL=... node server/cc-inject.js get <id>              # Full company row
DATABASE_URL=... node server/cc-inject.js stats                 # Rollup stats
DATABASE_URL=... node server/cc-inject.js set-status <id> <s>   # Set status (researching|error|done)
DATABASE_URL=... node server/cc-inject.js add                   # Read JSON array from stdin, insert new companies
DATABASE_URL=... node server/cc-inject.js sync                  # No-op (Postgres data is already remote)
```

### Inject pattern (MUST be single-line to avoid permission prompts):
```bash
DATABASE_URL=... node -e "const data = JSON.stringify({ status: 'done', score: 7.5, tier: 'strong-buy', owner: 'Name', phone: '(555) 123-4567', email: null, address: 'City, ST', linkedin: null, signals_json: JSON.stringify({revenue_proxy:7,operational_quality:8,succession_signal:7,growth_trajectory:7,deal_complexity:7,geographic_fit:8,market_quality:8}), flags_json: JSON.stringify({hard_stops:[],yellow_flags:[]}), summary: '...', outreach_angle: '...', sources_json: JSON.stringify(['url1','url2']), raw_research: JSON.stringify({company:'Name',location:'City, ST'}) }); process.stdout.write(data);" | node server/cc-inject.js inject <id>
```

**CRITICAL**: The entire `node -e "..." | node server/cc-inject.js inject <id>` command MUST be on a single line with no newlines. Multi-line commands trigger "Command contains newlines" approval prompts, breaking the zero-touch workflow. The user expects discovery → research → inject → sync to run completely autonomously without any approval clicks.

## Scoring Rubric

7 weighted signals (1-10 scale each):

| Signal | Weight | What to look for |
|--------|--------|-----------------|
| revenue_proxy | 22% | Employee count, fleet size, PPP loans (old — weight less), ZoomInfo, project scale |
| operational_quality | 18% | Reviews, BBB rating, licensing, fleet, service range |
| succession_signal | 18% | Owner age, years in business, family involvement, no next-gen |
| growth_trajectory | 12% | Market growth, expansion, new services, hiring |
| deal_complexity | 10% | Clean ownership, single location, no litigation |
| geographic_fit | 10% | Southeast US preferred, top MSAs score higher |
| market_quality | 10% | MSA population growth, housing starts, competition density |

**Tier thresholds:** strong-buy >= 7.5 | watchlist 5.0–7.49 | pass < 5.0

**Weighted score formula:**
```
score = revenue_proxy*0.22 + operational_quality*0.18 + succession_signal*0.18 +
        growth_trajectory*0.12 + deal_complexity*0.10 + geographic_fit*0.10 +
        market_quality*0.10
```

## Research Workflow

When asked to research companies:

1. Run `node server/cc-inject.js list-pending` to see what needs research
2. For each company, use WebSearch with queries like:
   - `"<Company> <city> plumbing reviews"`
   - `"<Company> owner founder"`
   - `"<Company> revenue employees ZoomInfo"`
   - `"<Company> BBB"`
   - `"<Company> lawsuit litigation"`
3. Score using the rubric above, compute weighted average
4. Inject via `cc-inject.js inject <id>`
5. No sync needed — Postgres writes are immediately available

## Discovery Workflow

When asked to discover NEW companies:

1. **ALWAYS check exclusion lists first** before adding any company:
   - `data/p3-universe-names.json` — 1,443 companies from P3 Services Universe (client's existing CRM/deal universe)
   - Current DB companies — run `node server/cc-inject.js list-all` to get current list
2. Use WebSearch to find plumbing companies in target geographies
3. Cross-reference against both exclusion lists before adding
4. Add via: `echo '<json>' | node server/cc-inject.js add`

## Important Notes

- PPP loan data is from 2020-2021 (5-6 years old) — weight it less, prefer current indicators
- The app supports CSV and XLSX upload/export
- Railway deployment auto-deploys from GitHub pushes
- `DATABASE_URL` must be set (Railway provides this automatically)
- `better-sqlite3` is kept temporarily for the one-time migration script (`server/migrate-sqlite-to-pg.js`)

## File Map

- `server/cc-inject.js` — CLI bridge (this is what Claude Code uses)
- `server/db.js` — PostgreSQL schema, pool, and async query functions
- `server/schema.sql` — Full Postgres DDL (CREATE TABLE IF NOT EXISTS)
- `server/index.js` — Express routes (all async)
- `server/prompts.js` — System prompts and scoring rubric
- `server/csv.js` — CSV parse/export
- `server/xlsx-export.js` — Excel export (styled, two-sheet workbook)
- `server/market-intel.js` — Metro seed data and market intelligence
- `server/markets.js` — Market analysis (AI-powered)
- `server/salesforce.js` — CRM known-name matching
- `server/agent.js` — AI research agent (batch research + discovery)
- `server/filter-and-add.js` — Batch filter and add companies
- `server/migrate-sqlite-to-pg.js` — One-time SQLite → Postgres migration
- `public/` — Frontend (vanilla HTML/CSS/JS)
- `data/prospector.db` — Legacy SQLite database (kept for migration reference)
- `data/p3-universe-names.json` — P3 exclusion list (1,443 names)
- `server/twilio.js` — Telephony routes (mock-first, live Twilio when keys set)
- `server/transcription.js` — Whisper wrapper (mock transcript or live OpenAI)
- `server/call-analyzer.js` — Claude-powered call intelligence + debrief questions
- `server/call-queue.js` — Priority queue algorithm (5 ranked buckets)
- `server/debrief.js` — Debrief draft/submit helpers
- `server/mock-transcripts.js` — 10 canned call transcripts for dev/testing
- `server/auth.js` — Role enforcement + auto-promote first user to admin

## Phase 2 Telephony

**Mock vs Live:** controlled by `TWILIO_ACCOUNT_SID` env var (absent = mock) or `MOCK_CALLS=1`.
- Mock: frontend simulates call duration, backend uses canned transcript → analysis → debrief
- Live: browser Voice SDK connects via TwiML app, Twilio records, Whisper transcribes, Claude analyzes

**Live Twilio setup:** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_TWIML_APP_SID`, `TWILIO_PHONE_NUMBER`, `PUBLIC_URL` in env. TwiML app voice URL must point to `PUBLIC_URL/api/twilio/voice`.

**Live Whisper:** set `OPENAI_API_KEY` in env. Falls back to empty transcript if missing.
