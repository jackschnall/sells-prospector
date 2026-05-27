# Advisor Referral Network

The advisor network is a parallel pipeline to the business-owner prospecting engine. Instead of cold-calling owners, it builds referral relationships with trusted advisors (CPAs, wealth managers, attorneys, lenders, coaches, insurance brokers, fractional CFOs) who already know which business owners are considering a sale.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `server/advisor-config.json` | Tunable scoring weights, tier thresholds, per-type filters |
| `server/advisor-prompts.js` | Reads markdown prompt templates, composes per-type prompts |
| `server/prompts/advisor_research_base.md` | Base research prompt (shared schema, hunger signals, graduation year tracking) |
| `server/prompts/advisor_research_{type}.md` | 7 type-specific overlays (CPA, RIA, attorney, lender, coach, insurance, fractional_cfo) |
| `server/advisor-research.js` | Research engine (identify + dossier generation via Claude API) |
| `server/advisor-scoring.js` | Fit score, hunger score, relationship score computation |

### Database Tables

| Table | Purpose |
|-------|---------|
| `advisors` | Core advisor records with dossier, scores, stage |
| `advisor_credentials` | Certifications (CPA, CEPA, JD, etc.) with earned year |
| `advisor_contacts` | Interaction log (calls, emails, meetings) with next action tracking |
| `referrals` | Bidirectional referral tracking (advisor<->owner) |
| `advisor_owner_links` | Suspected/confirmed advisor-owner relationships |
| `call_logs` (advisor_id col) | Phone calls with advisors (Twilio recording, transcription, AI summary) |
| `messages` (advisor_id col) | SMS messages with advisors |
| `notes` (advisor_id col) | Free-form notes per advisor |

## CRM UI

### Advisors Tab (3 subtabs)

**Network** — List view or pipeline kanban view of all advisors
- Filter by type, relationship stage, search
- Pipeline view uses drag-and-drop kanban cards (same style as main deal pipeline)
- "Auto-Link Owners" button cross-references advisors with company prospects by geography
- "+ Add Advisor" button for manual entry

**Call Queue** — Twilio-integrated call queue for advisor follow-ups
- Left panel: ranked list sorted by urgency (overdue actions first) then priority score (0.4 × relationship_score + 0.6 × fit_score)
- Right panel: full advisor detail with contact info, outreach angles, call history
- Call button with timer, mute, recording, Whisper transcription, Claude AI summary
- Debrief modal after each call (same flow as company call queue)
- SMS compose + thread view
- Notes with timestamp insertion
- Manual contact logging for non-call interactions (email, LinkedIn, in-person)
- Configurable cooldown (default 3 days between contacts)

**Referral Graph** — Visual force-directed network graph
- Diamond nodes = advisors (colored by type)
- Circle nodes = companies (gold)
- Edges: gray = suspected links, green = confirmed/inbound referrals, blue = outbound referrals
- Legend in top-left corner

### Contacts Tab — Advisor Contacts subtab
- Separate subtab showing all advisors as contacts
- Type badge, fit score, stage pill, phone/email/LinkedIn
- Click firm name to navigate to advisor detail
- Search and type filter

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/advisors` | List with filters (type, state, score range, stage, search) |
| GET | `/api/advisors/stats` | Aggregate stats |
| GET | `/api/advisors/queue?cooldown=3` | Daily follow-up queue (configurable cooldown in days) |
| GET | `/api/advisors/:id` | Full dossier + credentials + contacts + referrals + links |
| POST | `/api/advisors` | Manually add an advisor |
| POST | `/api/advisors/research` | Identify + research batch (type + geo) — used by Claude Code |
| POST | `/api/advisors/:id/re-research` | Refresh a single advisor's dossier — used by Claude Code |
| PUT | `/api/advisors/:id/stage` | Update relationship stage |
| DELETE | `/api/advisors/:id` | Soft-delete |
| POST | `/api/advisors/:id/contacts` | Log a contact interaction |
| POST | `/api/advisors/:id/referrals` | Log a referral |
| PUT | `/api/referrals/:id` | Update referral status/value |
| GET/POST | `/api/advisors/:id/owner-links` | View/create advisor-owner links |
| GET | `/api/referrals/graph` | Full bidirectional referral graph data |
| GET | `/api/companies/:id/advisors` | Advisors linked to a company |
| POST | `/api/advisors/auto-link` | Cross-reference all advisors with company prospects by geography |
| POST | `/api/advisors/recompute-scores` | Manually trigger relationship score recompute |
| POST | `/api/advisors/:id/call` | Initiate a Twilio call to an advisor |
| GET | `/api/advisors/:id/calls` | Call history with an advisor |
| GET/POST | `/api/advisors/:id/messages` | SMS thread with an advisor |
| POST | `/api/advisors/:id/sms` | Send SMS to an advisor |
| GET/POST | `/api/advisors/:id/notes` | Notes for an advisor |

## Research (via Claude Code)

Research is done from Claude Code, NOT from the web UI. The workflow:

1. Claude Code searches for candidates (WebSearch)
2. Inserts them via `POST /api/advisors` or direct DB insert
3. Researches each one (WebSearch for dossier data)
4. Scores using `computeFitScore()` from `advisor-scoring.js`
5. Updates via `updateAdvisorResearch()` in `db.js`
6. Stores credentials via `insertAdvisorCredential()`

The research prompts specifically target **early-career advisors** (30-40% of candidates should have graduated within ~8 years) and always look up graduation year as a key hunger signal.

## Scoring

### Fit Score (6 categories, configurable in advisor-config.json)

| Category | Weight | What It Measures |
|----------|--------|------------------|
| Profile Fit | 25% | Right credentials, practice focus |
| Hunger Signals | 20% | Career stage, book-building incentive, content output |
| Client Overlap | 20% | Serves our ICP geography & verticals |
| Network Strength | 15% | Associations, LinkedIn density, referral signals |
| Reachability | 10% | Email/phone available, LinkedIn activity |
| Geographic Relevance | 10% | Proximity to active owner pipeline |

### Hunger Signals Sub-Weights

| Sub-Signal | Weight |
|------------|--------|
| Newly Independent | 30% |
| Career Stage (early-career/associate/junior get bonus) | 25% |
| Personal Book Incentive | 15% |
| Content Output | 15% |
| Recent Certifications | 10% |
| Growing Team | 5% |

### Tier Thresholds
- **Strong Fit**: >= 7.5
- **Moderate Fit**: 5.0 - 7.49
- **Low Fit**: < 5.0

### Relationship Score (recomputed every 6 hours + on server startup)

| Category | Weight |
|----------|--------|
| Referral Activity (both directions) | 50% |
| Engagement Recency (exponential decay, 45-day half-life) | 25% |
| Response Rate | 15% |
| Connection Density Growth | 10% |

### Daily Queue Priority
```
urgency_bucket:
  0 = overdue action (next_action_date <= now)
  1 = action due tomorrow
  2 = never contacted
  3 = everything else

priority_score = relationship_score * 0.4 + fit_score * 0.6

Sort: urgency_bucket ASC, priority_score DESC
Cooldown: skip advisors contacted within last N days (default 3)
```

## Twilio Integration

The advisor call queue uses the same Twilio infrastructure as the company call queue:

- **Mock mode**: works without Twilio credentials (simulated calls with mock transcripts)
- **Live mode**: browser Voice SDK places calls, Twilio records, Whisper transcribes
- **AI analysis**: advisor-specific prompt extracts `relationship_signals` (interested in partnership, compliance concerns, referral potential) instead of company `key_info`
- **Debrief**: same modal as company calls — sentiment, callback scheduling, structured Q&A
- **Auto-logging**: calls are automatically logged as advisor contacts after debrief

## Advisor-Owner Links

The `advisor_owner_links` table bridges the advisor network with the existing owner pipeline:

- **Auto-population**: `POST /api/advisors/auto-link` cross-references all advisors against company prospects by city/state
- **Confidence scores**: same-city matches get 0.7 confidence, same-state gets 0.4
- **Link types**: `suspected` → `confirmed_serves` → `jointly_engaged`
- **Visible in**: advisor detail panel (linked owners section) and company detail panel (linked advisors)
