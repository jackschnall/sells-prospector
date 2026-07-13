# Twilio Live Setup — Sells Prospector CRM Phase 2

> **STATUS UPDATE (2026-07-13):** Twilio account closed and OpenAI API billing shut off. This walkthrough will need to be re-run from Step 1 (new Twilio account, new phone number) whenever telephony is resumed.

End-to-end guide to get real Twilio telephony running in the deployed app at `https://sells-prospector-production-f51b.up.railway.app`. Do the Twilio console steps yourself (accounts can't be created on your behalf), then paste the Claude Code prompt when you're ready to wire code.

Estimated time: 20–30 minutes for the Twilio + Railway side. Claude Code build is separate.

---

## The 6 env vars you need (correction to the original spec)

The original `crm-phase2-prompt.md` lists only 3 Twilio env vars. That's not enough for modern browser-based calling. The Voice JavaScript SDK has used **Access Tokens + a TwiML App** since the capability-token API was deprecated. Use these six:

```
TWILIO_ACCOUNT_SID=AC...             # identifies your account
TWILIO_AUTH_TOKEN=...                # for server-side REST API calls
TWILIO_API_KEY_SID=SK...             # signs browser Access Tokens
TWILIO_API_KEY_SECRET=...            # signs browser Access Tokens (shown ONCE)
TWILIO_TWIML_APP_SID=AP...           # outbound voice routing for the browser SDK
TWILIO_PHONE_NUMBER=+1...            # caller ID shown on outbound calls
```

Plus:
```
OPENAI_API_KEY=sk-...                # for Whisper transcription
PUBLIC_BASE_URL=https://sells-prospector-production-f51b.up.railway.app
```

`PUBLIC_BASE_URL` is what the server uses when it tells Twilio where to send webhooks (status callbacks, recording callbacks).

---

## Step 1 — Create the Twilio account

1. Go to `twilio.com/try-twilio` and sign up with your TrueDigital email.
2. Verify your email and cell phone number.
3. On the onboarding questions: pick "Voice" as the product, "Node.js" as the language, "With code" as the build path. These choices don't lock anything in, they just tailor console tips.
4. You land in the Twilio Console. Your trial account comes with about $15 credit, which is plenty for testing.

**Trial account constraint to know now:** Outbound calls on a trial account can only dial **verified** numbers. You verify numbers at Console → Phone Numbers → Manage → Verified Caller IDs. For full cold calling, you must upgrade the account (add a credit card) — Twilio gives a small bonus credit for upgrading. Do this once you've confirmed the flow works with one or two verified test numbers.

---

## Step 2 — Buy a phone number

1. Console → Phone Numbers → Manage → **Buy a number**.
2. Filter: Country = United States, Capabilities check **Voice** and **SMS**.
3. Pick any area code that makes sense for your territory focus (if you eventually want Atlanta-area caller ID, filter by 404/470/678/770; if you don't care yet, pick any). Local US numbers are $1.15/mo.
4. Click **Buy**.
5. Copy the E.164-formatted number (e.g. `+14045551234`) — this is `TWILIO_PHONE_NUMBER`.

Leave the number's webhook config alone for now. Outbound from the browser SDK is routed by the TwiML App (next step), not the number itself. You'll only configure this number's webhooks later if you want to handle inbound calls.

---

## Step 3 — Create the API Key (for browser Access Tokens)

Access Tokens for the browser SDK are signed with an API Key, **not** your Auth Token. This is a security boundary — API Keys can be revoked without rotating your main account credentials.

1. Console → Account → **API keys & tokens** (under "Keys & Credentials").
2. Click **Create API key**.
3. Name it `sells-prospector-voice-sdk`.
4. Key type: **Standard**.
5. Click **Create**.
6. A one-time modal shows the SID (`SK…`) and Secret. **The secret is shown exactly once.** Copy both now into a password manager or straight into your Railway env var editor.
   - `TWILIO_API_KEY_SID` = the `SK…` value
   - `TWILIO_API_KEY_SECRET` = the long secret string
7. Close the modal. If you close it without copying the secret, you must delete the key and make a new one.

While you're on the Account page, also grab:
- `TWILIO_ACCOUNT_SID` (starts with `AC…`) — shown on the main account dashboard
- `TWILIO_AUTH_TOKEN` — click the "show" toggle next to it

---

## Step 4 — Create the TwiML App

The TwiML App is what tells Twilio "when a browser Device places an outbound call, hit this URL to get routing instructions." Without it, browser-initiated calls don't know where to dial.

1. Console → **Voice** → Manage → **TwiML Apps**.
2. Click **Create new TwiML App**.
3. Friendly name: `Sells Prospector Outbound`.
4. **Voice Configuration → Request URL:**
   ```
   https://sells-prospector-production-f51b.up.railway.app/api/twilio/voice
   ```
   Method: `HTTP POST`.
5. **Voice Configuration → Status Callback URL:** (optional but useful)
   ```
   https://sells-prospector-production-f51b.up.railway.app/api/twilio/call-status
   ```
   Method: `HTTP POST`.
6. Leave messaging blank (we're not doing inbound SMS yet).
7. Click **Create**.
8. On the next screen, copy the **Application SID** (starts with `AP…`) — this is `TWILIO_TWIML_APP_SID`.

When the code is deployed, Twilio will POST to `/api/twilio/voice` with the target number in the `To` parameter, and the server responds with TwiML that dials that number using your caller ID and starts recording.

---

## Step 5 — Set env vars in Railway

Do this **before** redeploying, so the app boots with everything it needs.

1. Open your Railway project (the one hosting `sells-prospector-production-f51b.up.railway.app`).
2. Click the service → **Variables** tab.
3. Click **New Variable** and add each of these one at a time (or use **Raw Editor** and paste):

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

4. Railway auto-restarts the service after variable changes. Wait for the new deploy to go green.
5. Check the Railway logs — on boot, the Twilio client should initialize without errors.

---

## Step 6 — Verify a test caller ID (trial accounts only)

Skip this step if you upgrade the account in Step 1. Otherwise:

1. Console → Phone Numbers → Manage → **Verified Caller IDs**.
2. Click **Add a new Caller ID**.
3. Enter your own cell number (or a colleague's with their consent).
4. Twilio calls you with a 6-digit code. Enter it in the modal.
5. Repeat for any number you want to test-dial. Trial accounts can ONLY call verified numbers.

---

## Step 7 — Hand Claude Code the build prompt

After Railway is populated and deployed:

1. Open Claude Code in the `~/sells-prospector` repo.
2. Paste the contents of `twilio-claude-code-prompt.md` (the companion file I generated alongside this one).
3. Claude Code will write `server/twilio.js`, wire the browser SDK, add the call log / calendar / user tables, build the Call Queue + Calendar + Debrief modal UIs, and commit.
4. When Claude Code finishes, run `node server/cc-inject.js sync` to push to Railway.
5. Open the deployed URL, click a company in Call Queue, hit **Call** — your Twilio number should ring out to the prospect.

---

## Test checklist after deploy

Do these in order. Each confirms one layer works.

1. **Browser token fetch**: Open DevTools → Network tab. Load the Call Queue tab. A POST to `/api/twilio/token` should return 200 with a JWT-looking token. If 500, check Railway logs for "API Key Secret" errors.
2. **Device registers**: Console log should show `Twilio Device ready`. If it shows `error 31204` or `31403`, the Access Token is malformed — usually a missing `TWILIO_TWIML_APP_SID`.
3. **Outbound dial**: Click Call on a verified test number. Phone should ring. If Twilio logs show `11200 HTTP retrieval failure`, the TwiML App's Request URL is wrong — re-check Step 4.
4. **Recording**: Answer the call, say a few words, hang up. In Console → Monitor → Logs → Recordings, a new recording should appear within 30–60 seconds. If not, the `<Dial record="record-from-answer">` attribute is missing in the TwiML response.
5. **Transcription**: Check `call_logs.transcript` in Postgres a minute after the call. Should contain the Whisper-generated text. If null, check for Whisper API errors in Railway logs.
6. **Debrief modal**: Modal should pop up and block the UI until answered. Confirm it can't be escaped with ESC or clicking outside.
7. **Calendar auto-entry**: Say "call me back in two weeks" on the test call. Confirm a gold-colored event appears on the Calendar tab two weeks from today.

---

## Cost estimate for the first 90 days

Assumptions: 50 calls/day × 3-min avg duration × 60 workdays = ~150 hours of calling.

- **Phone number**: $1.15/mo
- **Outbound calls (US)**: $0.014/min × 9,000 min ≈ $126
- **Call recording storage**: $0.0005/min × 9,000 min ≈ $4.50
- **Whisper transcription**: $0.006/min × 9,000 min ≈ $54
- **Claude API (AI analysis + debrief questions)**: roughly $0.02 per call × 3,000 calls ≈ $60

Total: **~$250 for 3 months of heavy dialing.** Very reasonable.

---

## Security hygiene

- Never commit any of these env values to git. They should exist only in Railway Variables and (optionally) a local `.env` that's in `.gitignore`.
- The `TWILIO_AUTH_TOKEN` is the big one — it can do anything on your account. If it ever leaks, rotate it in Console → Account → API keys & tokens.
- The API Key Secret can be rotated independently by deleting the key and creating a new one.
- If you want to be extra careful, create API Keys with type "Main" only if you need them for account-level admin; "Standard" is sufficient for Access Token signing and doesn't have admin privileges.
