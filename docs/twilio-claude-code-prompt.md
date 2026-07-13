# Claude Code Prompt — Wire Twilio Live (CRM Phase 2)

> **STATUS UPDATE (2026-07-13):** Twilio account is being closed and OpenAI API billing has been shut off (card removed, usage limit set to $0). Do not run this prompt until both are re-subscribed and new credentials are set in Railway.

Paste this prompt into Claude Code after the Twilio console setup is done and all env vars are set in Railway. This supersedes the Twilio sections of `crm-phase2-prompt.md` — it corrects the env var list to use Access Tokens + TwiML Apps (the original spec referenced deprecated capability tokens).

---

Build full Twilio telephony + call intelligence for sells-prospector. All work is additive — do NOT touch or break the existing tabs (Dashboard, Pipeline, Companies, Markets, Agent, Export). Keep the Sells brand system intact (navy `#0D1B2A`, gold `#C9A84C`, cream `#F5F0E8`, Playfair Display headings, Source Sans 3 body, DM Mono data). Deploy target is Railway at `https://sells-prospector-production-f51b.up.railway.app`.

## Env vars (already set in Railway — read from `process.env`)

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
TWILIO_TWIML_APP_SID=AP...
TWILIO_PHONE_NUMBER=+1...
OPENAI_API_KEY=sk-...
PUBLIC_BASE_URL=https://sells-prospector-production-f51b.up.railway.app
```

For local dev, read the same vars from `.env`. Add `.env.example` with placeholder names committed to the repo.

## Graceful degradation

On boot, if `TWILIO_ACCOUNT_SID` or `TWILIO_API_KEY_SID` or `TWILIO_API_KEY_SECRET` or `TWILIO_TWIML_APP_SID` is missing, do two things:
1. Log a single-line warning: `[twilio] credentials missing — telephony disabled`.
2. Hide the **Call Queue** tab in the frontend. The server still boots and all existing tabs work unchanged.

If credentials are present but invalid (the Voice client throws on init), show an amber banner at the top of the Call Queue tab: `Twilio connection failed — check credentials in Railway variables.` Do not crash the app.

## Install

```
npm install twilio @twilio/voice-sdk
```

Server uses `twilio` (Node SDK). Browser uses `@twilio/voice-sdk` bundled into the existing frontend.

## Server — `server/twilio.js`

Build a new module exporting an Express router. Mount it in `server/index.js` (or wherever the main app is) under `/api/twilio`.

### Routes

**`POST /api/twilio/token`** — issue a short-lived Access Token for the browser Device.
- Auth: requires a logged-in user (reuse whatever session/JWT middleware is already in place).
- Body: `{ identity?: string }`. If omitted, derive identity from session user id, e.g. `user_${req.user.id}`.
- Response: `{ token: "<jwt>", identity: "user_42", ttl: 3600 }`.
- Implementation: use `twilio.jwt.AccessToken` with a `VoiceGrant`:
  - `outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID`
  - `incomingAllow: false` (we're outbound-only for now)
  - TTL: 3600 seconds. Browser refreshes before expiry.
  - Sign with `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` + `TWILIO_ACCOUNT_SID`.

**`POST /api/twilio/voice`** — the TwiML App webhook. Twilio POSTs here when a browser Device places an outbound call.
- Request params from Twilio: `To` (the E.164 target number the browser asked to dial), `From` (the client identity like `client:user_42`), plus a `callLogId` we pass as a custom param when the browser calls `device.connect({ params: { To, callLogId } })`.
- Response: TwiML XML. Use `twilio.twiml.VoiceResponse`:
  ```xml
  <Response>
    <Dial
      callerId="<TWILIO_PHONE_NUMBER>"
      record="record-from-answer"
      recordingStatusCallback="<PUBLIC_BASE_URL>/api/twilio/recording-status"
      recordingStatusCallbackEvent="completed"
      action="<PUBLIC_BASE_URL>/api/twilio/call-status"
      method="POST">
      <Number>{To}</Number>
    </Dial>
  </Response>
  ```
- Pass `callLogId` through to the recording/status webhooks by appending it as a query string on the callback URLs (e.g. `/api/twilio/recording-status?callLogId=123`). Twilio preserves query string on callbacks.

**`POST /api/twilio/recording-status`** — fires when recording is ready.
- Params: `RecordingSid`, `RecordingUrl`, `RecordingDuration`, `CallSid`, plus `callLogId` from query string.
- Action: update the matching `call_logs` row with `recording_url`, `recording_sid`, `recording_duration`, then enqueue a transcription job (fire-and-forget via `setImmediate` or a simple in-memory queue; no need for Redis/BullMQ yet).

**`POST /api/twilio/call-status`** — fires on call completion.
- Params: `CallSid`, `CallStatus` (completed | no-answer | busy | failed | canceled), `CallDuration`, `DialCallStatus`, plus `callLogId` from query string.
- Action: update `call_logs.status` and `call_logs.duration_seconds`. If `CallStatus` is `no-answer`/`busy`/`failed`, set `sentiment = 'No Answer'` and skip transcription.

**`POST /api/twilio/call`** — REST-initiated outbound (optional, useful for server-side redial or retries). Takes `{ to, callLogId }` and calls `client.calls.create(...)` with the same webhook URLs. Lower priority than browser SDK — include only if trivial.

### Security on webhooks

Use `twilio.webhook()` middleware to validate the `X-Twilio-Signature` header on `/api/twilio/voice`, `/api/twilio/recording-status`, and `/api/twilio/call-status`. Require `TWILIO_AUTH_TOKEN` for validation. Reject unsigned requests with 403. This prevents spoofing.

## Server — `server/transcription.js`

- Export `transcribeCall(callLogId, recordingUrl)`.
- Download the recording: `GET ${recordingUrl}.mp3` with Basic Auth using `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`. Save to a temp file.
- POST to `https://api.openai.com/v1/audio/transcriptions` with:
  - `Authorization: Bearer ${OPENAI_API_KEY}`
  - `Content-Type: multipart/form-data`
  - Fields: `file` (the audio), `model: whisper-1`, `response_format: verbose_json`, `language: en`.
- Parse the response. Store `transcript` (the `text` field) and `transcript_segments` (the `segments` array as JSON) on `call_logs`.
- On success, call `analyzeCall(callLogId)` from `server/callAnalysis.js`.
- Delete the temp file.
- On any error: log it, do NOT throw (the user already hung up, we can't block them). Leave the debrief modal functional even without transcript — it falls back to generic questions.

If `OPENAI_API_KEY` is missing, skip transcription silently.

## Server — `server/callAnalysis.js`

- Export `analyzeCall(callLogId)`.
- Read `call_logs.transcript`. If null, skip.
- POST to `https://api.anthropic.com/v1/messages`:
  - Model: `claude-sonnet-4-6` (match what the existing cc-inject pattern uses)
  - Max tokens: 1500
  - System prompt: "You are analyzing a cold outreach call for a sell-side M&A advisory firm. Extract structured intelligence strictly as JSON matching the schema below."
  - User content: the transcript
  - Schema (documented in the prompt): `{ summary: string[3-5 bullets], sentiment: "Receptive"|"Neutral"|"Not Interested"|"No Answer"|"Callback Requested", scheduling_detected: boolean, scheduled_callback_date: "YYYY-MM-DD"|null, next_action: string, refined_angle: string, debrief_questions: [{id, question}] (3-5 items tailored to what happened on THIS call) }`
- Parse the JSON. Validate the shape. Store on call_logs:
  - `ai_summary` (JSON array)
  - `sentiment` (string)
  - `scheduling_detected` (boolean)
  - `scheduled_callback_date` (date)
  - `next_action` (string)
  - `refined_angle` (string)
  - `debrief_questions` (JSON array)
- If `scheduling_detected && scheduled_callback_date`, insert a `calendar_events` row:
  ```
  event_date = scheduled_callback_date
  title = `Callback: ${company.name} — ${company.owner_name}`
  note = 'Review before calling'
  company_id = call_log.company_id
  source = 'auto-transcript'
  transcript_quote = (pull the segment from transcript_segments that contains scheduling language — Claude can identify this in the same analysis call)
  ```

## Database migrations

The Postgres migration doc (`postgres-migration.md`) already describes `call_logs`, `calendar_events`, `users`. Verify these tables exist. Add any missing columns with idempotent `ALTER TABLE IF NOT EXISTS` migrations at boot:

`call_logs` needs:
```
id, company_id, user_id, call_sid, recording_sid, recording_url, recording_duration,
status, duration_seconds, started_at, ended_at,
transcript, transcript_segments,
ai_summary, sentiment, scheduling_detected, scheduled_callback_date,
next_action, refined_angle,
debrief_questions, debrief_qa, debrief_completed_at,
created_at
```

`calendar_events` needs:
```
id, company_id, user_id, event_date, title, note,
source ('manual' | 'auto-transcript'), transcript_quote,
completed, completed_at, created_at
```

`users` needs:
```
id, email, name, role ('user' | 'admin'),
assigned_verticals (JSONB array),
assigned_territories (JSONB array),
created_at
```

Indexes: `call_logs(company_id, created_at DESC)`, `call_logs(user_id, created_at DESC)`, `calendar_events(event_date)`, `calendar_events(company_id)`.

## Frontend — Call Queue tab

Follow exactly the layout in section 5 of `crm-phase2-prompt.md` (left 60% queue list, right 40% call panel). Add these implementation specifics:

### Device initialization

On tab mount:
```js
import { Device } from '@twilio/voice-sdk';
const { token } = await fetch('/api/twilio/token', { method: 'POST' }).then(r => r.json());
const device = new Device(token, { logLevel: 'warn', codecPreferences: ['opus', 'pcmu'] });
await device.register();
```

Auto-refresh the token 5 minutes before expiry. Re-register the Device with the new token.

### Placing a call

When user clicks **Call**:
1. POST to `/api/calls` with `{ company_id, phone_number }`. Server creates a `call_logs` row in `status='initiating'` and returns `{ call_log_id }`.
2. `const call = await device.connect({ params: { To: phoneNumber, callLogId: call_log_id } });`
3. Show live call UI: company name, timer starts, Mute/Unmute toggle, End Call button.
4. Handle events: `call.on('accept', ...)`, `call.on('disconnect', ...)`, `call.on('error', ...)`.
5. On disconnect: show "Processing call…" spinner. Poll `GET /api/calls/:id` every 2 seconds until `ai_summary` is populated (means AI analysis completed), max 60 seconds.
6. Once analysis is ready, show the debrief modal with `debrief_questions` from the API response.

### Debrief modal

- Full-screen overlay, `position: fixed; inset: 0; z-index: 9999`.
- Dark backdrop (`rgba(13, 27, 42, 0.85)`, which is navy at 85% opacity).
- No close button. `keydown` handler on document blocks ESC. Click-outside does nothing.
- Renders the 3–5 questions from `call_logs.debrief_questions`, each with a textarea (`min-height: 120px`, minimum 10 chars to count as answered).
- Submit button disabled until all answered; when submitted, POST to `/api/calls/:id/debrief` with the `qa` array. Server stores to `call_logs.debrief_qa` and sets `debrief_completed_at = now()`.
- On 200: show "Debrief saved ✓" for 1 second, close modal, auto-advance queue to next company.

### Smart queue

Implement the priority order from section 5 of `crm-phase2-prompt.md`. Materialize it in a single SQL view or a `/api/queue` endpoint. Scope to logged-in user's `assigned_verticals` + `assigned_territories`. Admins see everything.

Refresh the queue when:
- A debrief is submitted
- The user refreshes
- A calendar event's date passes

## Frontend — Calendar tab

Monthly grid, follow section 6 of `crm-phase2-prompt.md`. Two API endpoints:
- `GET /api/calendar?month=YYYY-MM` → array of events
- `POST /api/calendar` → create manual event (body: `{ event_date, title, note, company_id? }`)

Color coding uses the brand palette: manual events blue `#3498db`, auto events gold `#C9A84C`, overdue red `#e74c3c`.

## Frontend — Company detail panel

Add the Call History section as spec'd in section 8 of `crm-phase2-prompt.md`. Use:
- `GET /api/companies/:id/calls` returns all `call_logs` for the company, newest first.
- Sentiment badges: Receptive `#27ae60`, Neutral `#95a5a6`, Callback Requested `#f39c12`, Not Interested `#c0392b`, No Answer `#7f8c8d`.
- Audio player: `<audio controls src={recording_url}>`. Twilio recordings need Basic Auth — proxy through the server via `GET /api/calls/:id/recording` to avoid exposing `TWILIO_AUTH_TOKEN` to the browser.

## Frontend — Settings

User management panel per section 7 of `crm-phase2-prompt.md`. Admin-only edits. Users see their own assignments read-only.

## Order of build

Do these in order, verify each before moving on:

1. Install packages, scaffold `server/twilio.js`, `/api/twilio/token` route only. Boot the app, open the Call Queue tab (build a minimal version first), confirm the token endpoint returns 200 with a JWT.
2. Build `POST /api/twilio/voice` TwiML webhook. Test with `curl` to confirm valid TwiML XML. Check webhook signature validation is enforced (should reject unsigned).
3. Frontend Device init + click-to-call to a test number. Confirm you hear ringing in the browser. Confirm the prospect's phone rings.
4. Add `call_logs` write on `/api/calls`. Confirm a row is inserted with `status='initiating'` when the call starts.
5. Wire recording + status callbacks. Make a test call, hang up. Confirm `recording_url` is populated within 60 seconds.
6. Wire Whisper transcription. Confirm `transcript` populates. Try with a 30-second test call.
7. Wire Claude call analysis. Confirm `ai_summary`, `sentiment`, `debrief_questions` populate.
8. Build the debrief modal. Confirm it can't be dismissed without answering all questions.
9. Build smart queue priority logic. Confirm the queue re-orders as expected after a debrief.
10. Build Calendar tab (both manual entries and auto-from-transcript).
11. Build Call History section on company detail panel.
12. Build Settings / territory assignment.
13. End-to-end test: real outbound call to a verified trial caller ID → recording → transcription → analysis → debrief → calendar event auto-created → queue advances.

After each step: `node server/cc-inject.js sync` to push to Railway, verify live.

## Tests

Add Jest tests for the non-UI pieces:
- `test/twilio.token.test.js` — token endpoint returns valid JWT with VoiceGrant
- `test/twilio.voice-twiml.test.js` — TwiML XML output validates against expected structure
- `test/webhookSignature.test.js` — invalid signature rejected with 403
- `test/callAnalysis.test.js` — given a sample transcript, verify the JSON output matches schema (mock Anthropic call)

Run `npm test` before committing.

## Commit strategy

One commit per order-of-build step above. Commit messages prefixed `crm2:` (e.g. `crm2: twilio access token endpoint`). No WIP commits to main — rebase locally if needed. After step 13 is green end-to-end, tag `v2.0.0-crm-phase2` and push.
