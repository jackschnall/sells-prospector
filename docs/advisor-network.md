# Advisor Referral Network

The advisor network is a parallel pipeline to the business-owner prospecting engine. Instead of cold-calling owners, it builds referral relationships with trusted advisors (CPAs, wealth managers, attorneys, lenders, coaches, insurance brokers, fractional CFOs) who already know which business owners are considering a sale.

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `server/advisor-config.json` | Tunable scoring weights, tier thresholds, per-type filters |
| `server/advisor-prompts.js` | System/user prompt templates per advisor type |
| `server/advisor-research.js` | Research engine (identify + dossier generation via Claude API) |
| `server/advisor-scoring.js` | Fit score + relationship score computation |

### Database Tables

| Table | Purpose |
|-------|---------|
| `advisors` | Core advisor records with dossier, scores, stage |
| `advisor_credentials` | Certifications (CPA, CEPA, JD, etc.) with earned year |
| `advisor_contacts` | Interaction log (calls, emails, meetings) |
| `referrals` | Bidirectional referral tracking (advisor<->owner) |
| `advisor_owner_links` | Suspected/confirmed advisor-owner relationships |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/advisors` | List with filters (type, state, score range, stage, search) |
| GET | `/api/advisors/stats` | Aggregate stats |
| GET | `/api/advisors/queue` | Daily follow-up queue |
| GET | `/api/advisors/:id` | Full detail + credentials + contacts + referrals + links |
| POST | `/api/advisors/research` | Identify + research batch (async) |
| POST | `/api/advisors/:id/re-research` | Refresh a single advisor's dossier |
| POST | `/api/advisors/:id/contacts` | Log a contact interaction |
| POST | `/api/advisors/:id/referrals` | Log a referral |
| PUT | `/api/advisors/:id/stage` | Update relationship stage |
| GET/POST | `/api/advisors/:id/owner-links` | View/create advisor-owner links |
| GET | `/api/referrals/graph` | Full bidirectional referral graph data |
| GET | `/api/companies/:id/advisors` | Advisors linked to a company |

## Running Research Jobs

### Via the UI

1. Go to the **Advisors** tab
2. Click **+ Identify Advisors**
3. Select an advisor type and enter a geography (e.g. "Austin TX")
4. Click **Start Research**

The system will:
- Use Claude to search for 8-15 matching candidates
- Insert them into the `advisors` table at `identified` stage
- Research each candidate in sequence, generating a structured dossier
- Score each candidate and advance them to `researched` stage

### Via API

```bash
curl -X POST http://localhost:3000/api/advisors/research \
  -H 'Content-Type: application/json' \
  -d '{"type":"cpa","geo":"Charlotte NC"}'
```

### Re-research a single advisor

```bash
curl -X POST http://localhost:3000/api/advisors/<id>/re-research
```

## Scoring Model

### Fit Score (set at research time)

Six weighted categories, configurable in `server/advisor-config.json`:

| Category | Default Weight | What It Measures |
|----------|---------------|------------------|
| Profile Fit | 25% | Right credentials, practice focus, advisor type |
| Hunger Signals | 20% | Career stage, book-building incentive, content output |
| Client Overlap | 20% | Serves our ICP geography & verticals |
| Network Strength | 15% | Associations, LinkedIn density, referral partner signals |
| Reachability | 10% | Email/phone available, active on LinkedIn |
| Geographic Relevance | 10% | Proximity to our active owner pipeline |

### Hunger Signals Sub-Weights

The "young and hungry" profile is implemented via sub-weights inside the hunger category:

| Sub-Signal | Default Weight |
|------------|---------------|
| Newly Independent | 30% |
| Career Stage | 25% |
| Personal Book Incentive | 15% |
| Content Output | 15% |
| Recent Certifications | 10% |
| Growing Team | 5% |

### Tier Thresholds

- **Strong Fit**: score >= 7.5
- **Moderate Fit**: score 5.0-7.49
- **Low Fit**: score < 5.0

### Relationship Score (recomputed continuously)

| Category | Default Weight |
|----------|---------------|
| Referral Activity (both directions) | 50% |
| Engagement Recency (exponential decay) | 25% |
| Response Rate | 15% |
| Connection Density Growth | 10% |

The engagement recency component decays with a configurable half-life (default: 45 days).

## Tuning Weights

Edit `server/advisor-config.json` and restart the server. All weights are read from this file at runtime.

Key config sections:
- `fitScoreWeights` — the six top-level categories
- `hungerSubWeights` — sub-weights within the hunger signal
- `relationshipScoreWeights` — relationship score categories
- `relationshipDecay.halfLifeDays` — how fast engagement recency decays
- `tierThresholds` — cutoffs for strong/moderate/low fit
- `perTypeFilters` — required/preferred credentials per advisor type

## Advisor Types

| Type | Key | Priority |
|------|-----|----------|
| CPA / Accountant | `cpa` | v1 |
| Wealth Manager / RIA | `ria` | v1 |
| Estate / M&A Attorney | `attorney` | v1 |
| Community Bank Lender | `lender` | v1 |
| Business Coach | `coach` | v2 |
| Insurance Broker | `insurance` | v2 |
| Fractional CFO | `fractional_cfo` | v2 |

## Relationship Stages

`identified` -> `researched` -> `queued` -> `outreach_sent` -> `first_response` -> `intro_meeting_booked` -> `intro_meeting_done` -> `active_partner`

Terminal states: `dormant`, `declined`

## UI Views

- **List View**: Sortable table of all advisors with type badges, fit scores, stages
- **Pipeline View**: Kanban board organized by relationship stage
- **Daily Queue**: Advisors due for follow-up, sorted by score and overdue actions
- **Detail Panel**: Full dossier with score breakdown, outreach angles, contact log, referral log, linked owners
- **Identify Advisors Modal**: Form to kick off research jobs by type and geography
