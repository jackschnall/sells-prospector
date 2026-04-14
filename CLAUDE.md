# Sells M&A Prospector — Claude Code Research Engine

## What This Is

A plumbing company M&A target research tool for Sells (middle-market investment bank).
The web app (Express + SQLite + vanilla frontend) is deployed at:
**https://sells-prospector-production-f51b.up.railway.app/**

Claude Code acts as the research agent — no Anthropic API key needed. You use
WebSearch to research each company and `cc-inject.js` to write results into SQLite.

## CLI Commands

```bash
node server/cc-inject.js list-pending          # Companies needing research
node server/cc-inject.js list-all              # All companies (slim JSON)
node server/cc-inject.js get <id>              # Full company row
node server/cc-inject.js stats                 # Rollup stats
node server/cc-inject.js set-status <id> <s>   # Set status (researching|error|done)
node server/cc-inject.js add                   # Read JSON array from stdin, insert new companies
node server/cc-inject.js sync                  # Checkpoint WAL, git commit+push DB to Railway
```

### Inject pattern (avoids heredoc permission issues):
```bash
node -e "
const data = JSON.stringify({
  status: 'done', score: 7.5, tier: 'strong-buy',
  owner: 'Name', phone: '(555) 123-4567', email: null,
  address: 'City, ST', linkedin: null,
  signals_json: JSON.stringify({...}),
  flags_json: JSON.stringify({ hard_stops: [], yellow_flags: [] }),
  summary: '...', outreach_angle: '...',
  sources_json: JSON.stringify([...]),
  raw_research: JSON.stringify({...})
});
process.stdout.write(data);
" | node server/cc-inject.js inject <id>
```

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
5. After all done, run `node server/cc-inject.js sync` to push to Railway

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
- The app already has xlsx dependency for export; upload only supports CSV currently
- Railway deployment auto-deploys from GitHub pushes
- SQLite runs in WAL mode; `sync` command handles checkpoint + git push

## File Map

- `server/cc-inject.js` — CLI bridge (this is what Claude Code uses)
- `server/db.js` — SQLite schema and queries
- `server/index.js` — Express routes
- `server/prompts.js` — System prompts and scoring rubric
- `server/csv.js` — CSV parse/export
- `server/xlsx-export.js` — Excel export
- `public/` — Frontend (vanilla HTML/CSS/JS)
- `data/prospector.db` — SQLite database
- `data/p3-universe-names.json` — P3 exclusion list (1,443 names)
