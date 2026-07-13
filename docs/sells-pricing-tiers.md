# Sells Prospector — Tiered Pricing Options

> **STATUS UPDATE (2026-07-13):** Twilio and OpenAI subscriptions referenced below have been canceled — figures are historical/planning reference only, not current spend.

Cost breakdowns for the two AI-dependent pieces of Sells Prospector:

1. **CRM Phase 2 telephony** — per month at ~50 calls/day × 20 workdays × 3-min avg (~3,000 call-min/mo)
2. **Discovery research** — per 100 companies researched

Three tiers for each: **Lean / Balanced / Premium**. All prices are directional and should be verified at time of purchase — model APIs repricing has been frequent (usually downward) over the last 12 months.

Model list prices used below (as of April 2026):

| Model | Input $/M tok | Output $/M tok | Notes |
|---|---|---|---|
| Claude Sonnet 4.6 | $3.00 | $15.00 | Current default in cc-inject |
| Claude Haiku 4.5 | $1.00 | $5.00 | 3–5× cheaper, good for structured extraction |
| Claude Opus 4.6 | $15.00 | $75.00 | For highest-value targets only |
| GPT-4o-mini | $0.15 | $0.60 | Very cheap, weaker on nuance |
| GPT-4.1-mini | $0.40 | $1.60 | Middle tier, strong structured output |
| OpenAI o3-mini | $1.10 | $4.40 | Reasoning model; better for ambiguous signals |
| Gemini 2.5 Flash | $0.30 | $2.50 | Built-in Google Search grounding |
| Gemini 2.5 Pro | $1.25 | $10.00 | Strong reasoning + grounding |
| Groq Whisper Large v3 | — | — | ~$0.0002/min audio |
| OpenAI Whisper-1 | — | — | $0.006/min audio |
| Deepgram Nova-3 | — | — | $0.0043/min audio, better phone quality |

---

## Section 1 — CRM Phase 2 Telephony (monthly, ~3,000 call-minutes)

Assumes ~50 calls/day × 20 workdays × 3-min avg = ~3,000 call-minutes/month, ~1,000 calls/month.

### Tier A: Lean — ~$44 / month

Cheapest viable stack. Works but sacrifices the differentiated debrief experience.

| Line item | Choice | Monthly cost |
|---|---|---|
| Phone number | Twilio local US | $1.15 |
| Outbound voice | Twilio ($0.014/min × 3,000) | $42 |
| Recording storage | Self-host on Railway volume (download from Twilio, delete) | ~$0 |
| Transcription | Groq Whisper ($0.0002/min × 3,000) | $0.60 |
| AI analysis + debrief | **Skip** — use 3 generic debrief questions | $0 |
| **Total** | | **~$44** |

**What you lose vs. Balanced:**
- Debrief questions are generic ("How did it go?" / "Next step?" / "Objections?") instead of tailored to the actual transcript
- No auto-calendar entries from scheduling detection — you add callbacks manually
- No sentiment auto-labeling — you tag sentiment in the debrief manually

**Why keep Twilio even here:** deliverability. A cheaper carrier like Telnyx saves ~$20/mo but your calls get "Spam Likely" flagged more often. One missed connect per week costs more than $20.

---

### Tier B: Balanced — ~$49 / month ← **Recommended**

Real debrief experience, meaningful cost discipline. This is what I'd ship.

| Line item | Choice | Monthly cost |
|---|---|---|
| Phone number | Twilio local US | $1.15 |
| Outbound voice | Twilio ($0.014/min × 3,000) | $42 |
| Recording storage | Self-host on Railway volume | ~$0 |
| Transcription | Groq Whisper | $0.60 |
| AI analysis + debrief | **Claude Haiku 4.5** (~$0.005/call × 1,000) | $5 |
| **Total** | | **~$49** |

**Why Haiku is enough:** the analysis task is structured JSON extraction from a 3-minute transcript — sentiment label, scheduling detection, 3–5 tailored questions. Haiku nails this. You don't need Sonnet's long-context reasoning for a short call.

**Upgrade path:** if you later find Haiku misses nuance on specific deals (e.g. an owner hinting at succession without saying it explicitly), upgrade to Sonnet for those companies only — gate by tier. Prime Window companies get Sonnet, others get Haiku.

---

### Tier C: Premium — ~$82 / month

Best-in-class analysis. Use when you're confident the revenue per call is high enough to justify it.

| Line item | Choice | Monthly cost |
|---|---|---|
| Phone number | Twilio local US | $1.15 |
| Outbound voice | Twilio | $42 |
| Recording storage | Twilio managed ($0.0005/min retained) | ~$4.70 |
| Transcription | **Deepgram Nova-3** (better on phone audio, speaker diarization) | ~$12.90 |
| AI analysis + debrief | **Claude Sonnet 4.6** (~$0.02/call × 1,000) | $20 |
| Post-call insight emailing to rep | Small Haiku pass to draft the followup email | ~$1.70 |
| **Total** | | **~$82** |

**What you gain:**
- Speaker diarization (you see "owner: … / rep: …" in transcript instead of blended text)
- Sharper sentiment + refined outreach angle from Sonnet
- Drafted followup emails auto-generated; rep edits and sends instead of writing from scratch

---

## Section 2 — Discovery Research (per 100 companies)

Current state: you run this manually in Claude Code (essentially free under your Claude subscription) and paste JSON via `cc-inject`. The costs below kick in when you move to **server-side automated research** (the thing that actually scales — research 500 companies overnight without a human in the loop).

Assumed work per company: 3–6 web searches, ~30–40k input tokens total (search results + synthesis prompt), ~1.5k output tokens (the structured JSON profile).

### Tier A: Lean — $4–$8 per 100

Cheapest way to get real research at volume.

| Line item | Choice | Per-100 cost |
|---|---|---|
| Web search | Serper or SerpAPI ($0.30 per 100 queries × ~5 queries/co) | $1.50 |
| Model | **GPT-4o-mini** OR **Gemini 2.5 Flash** | $2–$4 |
| Total | | **~$4–$6** |

**What you lose vs. Balanced:**
- Outreach angles get generic — they tend toward "You built this business for 20+ years; worth exploring your options" rather than picking up on a specific signal like "you just renewed your lease for 10 years, so you're planning for growth, not exit"
- Tier assignment edge cases are less reliable — a company with mixed signals might get bucketed wrong
- Fewer inferences drawn from soft signals (owner photos on Yelp, founding year vs. typical tenure, etc.)

**Best use case:** bulk-scoring the long tail — 600+ company Emerging Window dumps where you just need a rough tier label and a phone number. Upgrade tier when moving into Prime.

---

### Tier B: Balanced — $10–$18 per 100 ← **Recommended**

Matches the quality you're getting today from your manual Claude Code research, but automated and scalable.

| Line item | Choice | Per-100 cost |
|---|---|---|
| Web search | Anthropic server-side web search ($10 per 1,000 searches × ~5/co) | $5 |
| Model | **Claude Haiku 4.5** (~15k in × $1/M + ~1.5k out × $5/M ≈ $0.02/co) | $2 |
| Optional re-research pass on Prime tier only | Sonnet escalation for ~10% | $3 |
| **Total** | | **~$10–$14** |

**Why Haiku works here:** the bulk of the research value is the web search itself — pulling Yelp ratings, Google Reviews, BBB records, secretary of state filings. Synthesis into the tier/score/angle JSON is a structured task; Haiku does it well.

**When to bump individual companies to Sonnet:** when you hit a Prime Window score or when signals are conflicting (e.g. old business but active social media — is the owner gearing up to sell or reinvesting?).

---

### Tier C: Premium — $22–$35 per 100

Highest-quality profiles. Use for Prime Window companies where you'll spend an hour on call prep anyway.

| Line item | Choice | Per-100 cost |
|---|---|---|
| Web search | Anthropic server-side web search (7–10 queries per co) | $8 |
| Model | **Claude Sonnet 4.6** with extended thinking on | $15 |
| Two-pass synthesis (first pass facts, second pass angle + objections) | extra Sonnet call per co | $8 |
| Secondary validation pass | Gemini 2.5 Pro cross-check to catch hallucinated facts | $3 |
| **Total** | | **~$28–$34** |

**What you gain:**
- Cross-referenced facts (hallucinations get caught by the Gemini cross-check)
- Richer angles — Sonnet will notice things like "the owner's son opened a competing business in 2023, so the succession question is probably painful"
- Pre-built objection bank per company ("Here are the 3 things this owner is most likely to push back on and how to respond")

**Best use case:** the top 15–20 Prime Window companies each month — the ones you're going to actually pitch. Not for long-tail scoring.

---

## Recommended blend — not a single tier

In practice you probably want to **blend tiers by company segment** rather than picking one tier for everything:

| Segment | Volume / month | Research tier | Notes |
|---|---|---|---|
| Emerging Window bulk scoring | ~670 | Lean | Just need a tier label and phone number |
| Prime Window — never contacted | ~100 | Balanced | Real outreach angle matters |
| Prime Window — actively working | ~17 | Premium | Second-pass synthesis + objection bank |

Monthly blended research cost: ~$33 (Lean × 670 at $5 avg) + ~$12 (Balanced × 100 at $12 avg) + ~$5 (Premium × 17 at $30 avg) = **~$50 / month**.

For telephony, you probably don't blend — pick one tier per team. I'd ship **Balanced** for the first 90 days, then decide whether to jump to Premium once you know what moments in a call really need Sonnet's help.

---

## Combined monthly totals

Assuming ~785 companies researched per month and ~1,000 calls per month. Research-only-everywhere columns multiply the mid-range per-100 price by 7.85.

| Stack | Telephony / mo | Research / mo | **Total / month** |
|---|---|---|---|
| **Lean everywhere** | $44 | ~$39 (7.85 × $5) | **~$83** |
| **Balanced everywhere** | $49 | ~$94 (7.85 × $12) | **~$143** |
| **Premium everywhere** | $82 | ~$236 (7.85 × $30) | **~$318** |
| **Blended (recommended)** | Balanced ($49) | Blended ($50) | **~$99** ← recommended |

The **Blended** row is the one to plan around: Balanced telephony for everyone, and research tiers scaled by company segment (Lean for bulk Emerging Window, Balanced for Prime never-contacted, Premium for the ~17 active Prime deals per month). That's **~$99/month** all-in AI stack spend — for a sell-side M&A tool where a single closed mandate pays seven figures, this is rounding error.

---

## What to verify before committing

1. **Re-check OpenAI and Anthropic pricing the day you flip the switch** — these change quarterly.
2. **Confirm Groq Whisper supports the audio format Twilio returns** — it does today (WAV/MP3) but check the Groq API docs before hard-coding.
3. **Anthropic server-side web search pricing** — currently $10 per 1,000 searches but has been trending down.
4. **Trial-account cap on outbound call minutes** — Twilio trial is ~$15 credit, about 1,000 minutes of calling. Upgrade before you try volume testing.
5. **Deepgram vs Groq Whisper accuracy on YOUR audio** — before paying Deepgram's premium, run 20 of your recordings through both and compare. Phone-call accuracy depends on background noise, accent, and line quality; sometimes Whisper is actually better despite the pedigree of Deepgram on clean audio.

## Decision points I'd flag for you

- **Do you want to keep research manual (via Claude Code) or move to server-side automation?** Manual is free-ish under your existing subscription but caps at whatever you can personally sit through. Server-side is what makes "research 500 companies overnight" possible. The $4–$18 per 100 numbers above are all server-side.
- **Do you want a single user stack or territory-specific?** Per-user Twilio numbers cost $1.15/mo each. For 5 reps that's $70/year — irrelevant vs. the deliverability boost of local caller ID.
- **Will you record every call or only matched states?** Some states require two-party consent (CA, FL, IL, MD, MA, MT, NV, NH, PA, WA, CT, DE, OR). TwiML supports gating recording by state if you prefer not to add "this call is being recorded" to the opener.
