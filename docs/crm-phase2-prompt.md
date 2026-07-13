# Claude Code Prompt: CRM Phase 2 — Telephony, Call Intelligence, and Outreach Management

> **STATUS UPDATE (2026-07-13):** Twilio and OpenAI (Whisper) subscriptions have been canceled. This telephony build is paused — do not run this prompt until both accounts are re-established and env vars re-populated. Railway hosting remains active.

Paste this into Claude Code after the Postgres migration is complete and verified working.

---

The Postgres migration is done. The app now has a real hosted database, multi-user auth, and the CRM foundation (pipeline Kanban, contacts, activity timeline). Now build the outbound calling and call intelligence system. This is what turns the research tool into a full origination CRM.

All work is additive — do NOT break or remove any existing tabs or functionality (Dashboard, Pipeline, Companies, Markets, Agent, Export). Keep the existing Sells brand system intact (navy #0D1B2A, gold #C9A84C, cream #F5F0E8, Playfair Display headings, Source Sans 3 body, DM Mono data).

## 1. TWILIO TELEPHONY — EMBEDDED DIALPAD

Install `@twilio/voice-sdk` (browser SDK) and `twilio` (server SDK).

Add to `.env`:
```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+1...
```

### Server side:
- Create `server/twilio.js` with:
  - `POST /api/twilio/token` — generate a Twilio capability token for the browser SDK (scoped to the logged-in user)
  - `POST /api/twilio/call` — initiate an outbound call via Twilio REST API, passing the target phone number and caller ID (TWILIO_PHONE_NUMBER)
  - `POST /api/twilio/webhook` — TwiML webhook that Twilio hits when the call connects. Return TwiML that dials the target number and enables recording (`<Record>` or `recordingStatusCallback`)
  - `POST /api/twilio/recording-status` — webhook Twilio hits when recording is ready. Receive the recording URL and SID, look up which call_log this belongs to, update the record with `recording_url`
  - `POST /api/twilio/call-status` — webhook for call status events (completed, no-answer, busy, failed). Update call_log with final status and duration

### Browser side:
- Initialize Twilio Device on page load using the capability token from `/api/twilio/token`
- When user clicks "Call" on a company, the browser SDK places the outbound call
- Audio plays through the browser — no external phone needed
- Record every call automatically (server-side via TwiML `<Record>`)

### Graceful degradation:
- If `TWILIO_ACCOUNT_SID` is missing from env, hide the Call Queue tab entirely and show no errors
- If Twilio keys are present but invalid, show a clear error banner on the Call Queue tab: "Twilio connection failed — check your credentials in Settings"

## 2. POST-CALL TRANSCRIPTION — OPENAI WHISPER

Add to `.env`:
```
OPENAI_API_KEY=
```

After a call ends and the recording URL is available:
1. Download the recording from Twilio (it's a WAV/MP3 URL)
2. Send it to `POST https://api.openai.com/v1/audio/transcriptions` with `model: "whisper-1"`
3. Store the full transcript in `call_logs.transcript`

Create `server/transcription.js` to handle this. It should:
- Accept a recording URL and call_log ID
- Download the audio file from Twilio
- POST to Whisper API with the audio as form data
- Update the call_log record with the transcript
- Then trigger AI analysis (step 3)

If `OPENAI_API_KEY` is missing, skip transcription silently — the call still gets logged with duration and sentiment but no transcript.

## 3. AI CALL ANALYSIS

After transcription completes, pass the transcript through Claude to extract structured intelligence. Use the existing cc-inject pattern (call the Anthropic API via the server, not Claude Code).

Send the transcript to `POST https://api.anthropic.com/v1/messages` with a system prompt that extracts:

- **Key points summary**: 3–5 bullet points of what was discussed
- **Owner sentiment**: One of: `Receptive` | `Neutral` | `Not Interested` | `No Answer` | `Callback Requested`
- **Scheduling detection**: Scan for phrases like "call me back", "try again in X months", "after the holidays", "next Tuesday", any specific dates. If detected, extract the date or relative timeframe and convert to an actual calendar date
- **Recommended next action**: One sentence — what should the caller do next
- **Outreach angle refinement**: Based on what resonated or didn't in the call, suggest an updated outreach angle for the next conversation

Store all of this in the call_logs record:
- `ai_summary` — the bullet points as JSON
- `sentiment` — the sentiment label
- `scheduling_detected` — boolean
- `scheduled_callback_date` — actual date if detected
- `next_action` — the recommendation

If scheduling was detected, auto-create a calendar event (see Calendar section below).

## 4. FORCED POST-CALL DEBRIEF MODAL

This is critical. Immediately after a call ends — before the user can do ANYTHING else — show a full-screen modal that CANNOT be dismissed, minimized, or clicked away from. No X button. No clicking outside to close. No escape key. The only way out is answering every question.

### How it works:
1. Call ends → transcription + AI analysis run (show a "Processing call..." spinner)
2. Once AI analysis is complete, Claude generates 3–5 questions SPECIFIC to THIS call's transcript
3. Modal appears with the questions. User must answer ALL of them before the modal closes
4. Answers are stored in `call_logs.debrief_qa` as JSON array of `{question, answer}` objects
5. Only after submission does the modal close and the next contact load

### Question generation logic:
The questions are NOT generic. Claude should read the transcript and AI summary, then generate questions tailored to what happened:

- If scheduling was mentioned → "You discussed calling back around [date]. Should I add this to your calendar for [date]? Any notes for that callback?"
- If the owner mentioned a spouse, partner, or co-owner → "The owner mentioned [name] being involved in decisions. How does this affect the timeline? Should we add them as a contact?"
- If the owner showed interest or asked questions → "What was the moment where they seemed most receptive? What specifically resonated?"
- If an objection was raised → "The owner raised concerns about [X]. How would you characterize their objection — is it a hard no or something we can address?"
- If the owner mentioned a recent event (health issue, retirement, competitor offer, family change) → "They mentioned [event]. How significant is this for our timing?"
- If the call was short or went to voicemail → "No conversation — was this a voicemail, wrong number, or gatekeeper? What's your recommended next step?"
- If revenue, valuation, or financial topics came up → "They discussed [financial topic]. Does this change your view of the deal size or timeline?"

### Debrief UI:
- Full-screen overlay, dark semi-transparent backdrop
- Sells brand styling (navy header bar, cream card, gold accent on submit button)
- Company name and call duration at the top
- Each question in its own card with a text area for the answer
- "Submit Debrief" button at the bottom — disabled until all questions have answers (minimum 10 characters each)
- After submission, show brief confirmation ("Debrief saved ✓") then auto-load the next company in the call queue

## 5. SMART CALL QUEUE

Add a new tab: **Call Queue**

This is the user's daily work surface. It shows a prioritized list of companies to call, and the embedded dialpad for making calls.

### Queue priority order (top to bottom):
1. **Scheduled callbacks due today** — companies where `call_logs.scheduled_callback_date = today`
2. **Prime Window companies — never contacted** — tier = 'Prime Window' (or 'Likely to Sell' based on current tier labels) AND no entries in call_logs
3. **Prime Window companies — contacted but no answer** — tier is Prime AND has call_logs but sentiment = 'No Answer'
4. **Emerging Window companies — never contacted** — tier = 'Emerging Window' (or 'Possible') AND no call_logs
5. **Companies with incomplete contact info** — no phone number on file, need a discovery call to find it

### Queue rules:
- Never show the same company twice in one session/day
- Never show companies called in the last 7 days (configurable in settings)
- Scope the queue to the logged-in user's assigned verticals and territories (from `users.assigned_verticals` and `users.assigned_territories`)
- Companies outside the user's territory are hidden from their queue (but visible to admin users)
- Show today's queue as a numbered list — user works top to bottom

### Call Queue UI layout:
**Left side (60%):** The queue list
- Numbered list of companies
- Each row shows: rank number, company name, city/state, score badge, tier label, owner name, phone number, last call summary (if any), and the reason it's in the queue (e.g., "Scheduled callback", "Prime — never contacted", "No answer — retry")
- Clicking a company highlights it and loads its info into the right panel

**Right side (40%):** The call panel
- Company name, score, tier, owner name prominently displayed
- Outreach angle from the research (the suggested cold call opener)
- Last call summary if this is a retry/callback
- Phone number with a large "Call" button
- During call: live timer, mute button, end call button
- After call: transitions to debrief modal

### Before each call, show a pre-call briefing card:
- Company name, owner name, score, tier
- Outreach angle (the one-line cold call opener from research)
- If previous calls exist: last call date, sentiment, summary, and any debrief notes
- Key research highlights: revenue estimate, years in business, Google rating, red flags

## 6. CALENDAR

Add a new tab: **Calendar**

Monthly grid view showing scheduled callbacks and manual events.

### Two ways to create entries:

**Manual:** Click any day on the calendar → modal opens with fields: Title, Note, optional Company (searchable dropdown of all companies). Save creates a `calendar_events` record with `source = 'manual'`.

**Automatic (from transcript):** When AI call analysis detects scheduling language, auto-create a calendar event with:
- `event_date` = the detected date
- `title` = "Callback: [Company Name] — [Owner Name]"
- `note` = "Review before calling"
- `company_id` = linked to the company
- `source` = 'auto-transcript'
- `transcript_quote` = the exact quote from the transcript where scheduling was mentioned

### Calendar UI:
- Monthly grid — days of the week across the top, weeks as rows
- Navigate between months with arrows
- Color coding for events:
  - **Blue (#3498db)** = manual entries
  - **Gold (#C9A84C)** = auto-detected from transcript
  - **Red (#e74c3c)** = overdue (event_date is in the past and `completed = false`)
- Click an event to see details. If it's linked to a company, show a link to open that company's detail panel
- Click the company link → navigates to Companies tab with that company's detail panel open
- Today's date highlighted with a subtle border or background
- Show count badges on days with multiple events

## 7. VERTICAL AND TERRITORY ASSIGNMENT

Add a **Settings** panel (accessible from user menu or a gear icon in the nav).

### User management (admin only):
- List all users
- For each user, assign:
  - **Verticals**: checkboxes for each industry — Plumbing, HVAC, Pest Control, Restoration, Painting, Electrical, Septic, Cleaning
  - **Territories**: multi-select for states or metros
- Save updates to `users.assigned_verticals` and `users.assigned_territories` (JSONB arrays)

### How assignments affect the app:
- **Call Queue**: only shows companies matching the user's verticals and territories
- **Discovery mode**: when a user runs discovery, it's scoped to their assigned territories
- **Pipeline**: user sees all companies (for visibility) but their queue only includes their assignments
- **Admin users** (`role = 'admin'`): see everything, no filtering

### Settings UI:
- Keep it simple — a panel or page with user cards
- Each card shows the user's name, email, assigned verticals (as tags), assigned territories (as tags)
- Admin can click to edit assignments
- Non-admin users can see their own assignments but not edit them

## 8. CALL HISTORY ON COMPANY RECORD

On the existing company detail panel (the slide-in panel on the Companies tab), add a **Call History** section between the Activity Timeline and the "Open Tearsheet" link.

For each call, show:
- Date and time
- Duration (formatted as mm:ss)
- Sentiment badge (color-coded: green for Receptive, yellow for Neutral, orange for Callback Requested, red for Not Interested, gray for No Answer)
- AI summary (the 3–5 bullet points, expandable)
- Debrief Q&A (expandable — show each question and answer)
- Next action recommendation
- If a callback was scheduled, show the date with a link to the calendar event
- Link to play the recording (audio player inline or in a modal)

Sort calls newest first. If no calls exist yet, show "No calls recorded" with a "Add to Call Queue" button that moves the company to the top of the user's queue.

## 9. NEW TABS AND NAVIGATION

Add these tabs to the existing tab bar (after Export):
- **Call Queue** — the dialpad + prioritized contact list
- **Calendar** — monthly view with manual + auto entries

The tab bar should now be: Dashboard | Pipeline | Companies | Markets | Agent | Export | Call Queue | Calendar

If Twilio credentials aren't configured, hide the Call Queue tab. Calendar should always be visible.

## 10. DATABASE CONSIDERATIONS

The Postgres schema from the migration already includes `call_logs`, `calendar_events`, and `users` tables with all the columns needed. Verify these tables exist and match what's needed. If any columns are missing (like `completed` on calendar_events), add them with ALTER TABLE.

If the auth system from the previous build created its own users table with a different structure, merge the schemas — make sure `assigned_verticals`, `assigned_territories`, and `role` columns exist.

## ORDER OF OPERATIONS

Build in this order to minimize integration pain:

1. **Twilio server routes + browser SDK setup** — get a call connecting through the browser first
2. **Call logging** — store every call in call_logs with duration and basic info
3. **Call Queue tab UI** — the queue list and call panel, using the priority algorithm. Test with manual calls (click to call, log the result)
4. **Whisper transcription** — wire up post-call transcription
5. **AI call analysis** — wire up Claude API to extract sentiment, scheduling, summary
6. **Forced debrief modal** — build the modal, wire it to appear after every call
7. **Calendar tab** — monthly grid, manual creation, auto-creation from transcript scheduling
8. **Call History on company detail** — add the section to the existing panel
9. **Settings / territory assignment** — user management panel
10. **End-to-end testing** — make a real call through the system, verify the full flow: call → record → transcribe → analyze → debrief → log → calendar → queue advances

Test each step before moving to the next. If Twilio keys aren't available yet, build the UI and queue logic first with a mock call flow, then wire in Twilio when keys are ready.
