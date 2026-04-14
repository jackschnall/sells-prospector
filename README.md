# Sells M&A Prospector

A local web app for triaging M&A target companies. Upload a CSV, dedupe against your Salesforce list, and run a Claude agent loop that researches each company (Opus 4.6 orchestrator + Sonnet 4.6 workers with web search), scores it on a six-signal rubric, assigns a tier (Strong Buy / Watchlist / Pass), flags red lines, and surfaces contacts on branded tearsheets.

## Quick start

```bash
cd ~/sells-prospector
npm install
cp .env.example .env
# Demo run (no API key needed):
npm run mock
# Live run:
#   1. Set ANTHROPIC_API_KEY in .env
#   2. npm start
```

Open http://localhost:3000

## Modes

- **Mock mode** (`MOCK_MODE=1`) — uses canned research so you can exercise the full UI without API calls. An amber banner makes this obvious.
- **Live mode** — requires `ANTHROPIC_API_KEY`. Uses `claude-opus-4-6` as the orchestrator and `claude-sonnet-4-6` with the server-side `web_search` tool for research.

## Workflow

1. (Optional) Paste company names already in Salesforce into the sidebar. Matching rows are marked "In Salesforce" and skipped by the agent.
2. Drop a CSV of targets into the dropzone. Accepted headers: `name` (required), plus `city`, `state`, `phone`, `website`, `owner`, `email`, `address`. Duplicates on normalized name are ignored.
3. (Optional) Set thesis parameters (min revenue, geography, min years, min rating).
4. Click **Run Research**, or enable **Auto-run on upload** in the sidebar.
5. Watch the progress bar; cards populate as each company is scored.
6. Click any card for a full detail panel. Click **Open Tearsheet** to get a print-ready page (triggers the print dialog automatically — choose "Save as PDF").
7. **Export CSV** downloads the ranked list.

## Scoring rubric

| Signal | Weight |
|---|---|
| Revenue proxy | 25% |
| Operational quality | 20% |
| Succession signal | 20% |
| Growth trajectory | 15% |
| Deal complexity | 10% |
| Geographic fit | 10% |

Tiers: **Strong Buy** ≥ 7.5, **Watchlist** 5.0–7.4, **Pass** < 5.0.

The weighted final score is computed server-side from the per-signal 0–10 values the model returns, so scoring stays deterministic to the rubric.

## Project layout

```
server/
  index.js       # Express app + routes + SSE
  agent.js       # Sequential run manager
  research.js    # Sonnet + web_search worker
  scoring.js     # Opus scorer + weighted math
  flags.js       # Flag agent
  contacts.js    # Contact finder
  claude.js      # SDK wrapper + JSON extraction + tool loop
  prompts.js     # All system prompts + scoring rubric text
  mock.js        # MOCK_MODE fixtures
  db.js          # better-sqlite3 schema + queries
  csv.js         # Flexible CSV parse + export
  salesforce.js  # Paste-list fallback (jsforce-ready shape)
public/
  index.html     # Dashboard shell
  tearsheet.html # Print-optimized single-company page
  styles.css     # Sells design system (navy + gold)
  app.js         # Frontend: upload, run, cards, detail panel, SSE
data/
  prospector.db  # Created on first run
```

## Salesforce

v1 uses a manual paste list. `server/salesforce.js` is shaped for a later `jsforce` OAuth integration — drop in a real `fetchKnownAccountNames()` and the rest of the pipeline is unchanged. `POST /api/companies/:id/salesforce-push` currently returns a stubbed 200 payload so you can wire it up later.

## Notes

- Sequential, 1s delay between companies — keeps rate limits comfortable and matches the spec.
- Errors per company mark `status='error'` and stash the trace in `raw_research`; the loop continues.
- SSE stream (`/api/run/stream`) drives the live progress bar and card updates.
- Everything runs locally — no auth, no multi-user.
