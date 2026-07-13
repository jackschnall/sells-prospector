# Switching to a New Claude Account — Continuity Guide

**Date:** 2026-07-13
**Why:** Jack is retiring his prior Cowork/Claude account. Work on sells-prospector continues via Claude Code on the same laptop, under a new Claude account.

## The short version

The sells-prospector app is a local git repo + a Railway deployment. Neither is tied to a Claude account in any way. Switching Claude accounts changes *who's driving Claude Code* — it does not touch the code, the database, git history, or the Railway deployment. Nothing needs to be moved, exported, or re-cloned.

## Steps

1. **Confirm the repo is safe on disk** (already verified 2026-07-13 — see below).
2. **Log out of Claude Code with the old account:**
   ```
   claude auth logout
   ```
   or type `/logout` inside an active Claude Code session.
3. **Log in with the new account:**
   ```
   claude auth login
   ```
   This opens a browser window for the new account's OAuth flow. Once approved, Claude Code is authenticated as the new account going forward.
4. **Re-open the project as normal:**
   ```
   cd ~/sells-prospector
   claude
   ```
   The first time you open this project folder under the new account, Claude Code may re-prompt for folder/tool trust approval (a one-time per-account confirmation) — that's expected and not a sign anything broke. It will also read `CLAUDE.md` in this repo automatically, which has all the operational context (commands, scoring rubric, file map).
5. **Env vars and secrets are untouched.** `.env` (local) and Railway's environment variables are unrelated to your Claude account — they don't need to be re-entered. This includes any remaining `ANTHROPIC_API_KEY`, `TWILIO_*`, and `OPENAI_API_KEY` values, though note Twilio and OpenAI billing were both canceled 2026-07-13 — those specific values are dead until re-subscribed (see `docs/` for the original setup walkthroughs, now flagged with status banners).
6. **Deploy path is unchanged:** `node server/cc-inject.js sync` still pushes to `https://sells-prospector-production-f51b.up.railway.app/` regardless of which Claude account ran it.

## Confirmed (2026-07-13)

- Repo location: `/Users/jackschnall/sells-prospector` (directly under home, not Desktop — this was double-checked after initial confusion).
- Git status: clean working tree, up to date with `origin/main`.
- Remote: `https://github.com/jackschnall/sells-prospector.git` — already backed up off-machine, no action needed for step 1.

## What's paused as of this transition

- Twilio account (calling/SMS) — being closed same day.
- OpenAI API billing (Whisper transcription) — card removed, usage limit set to $0.
- Railway hosting was intentionally kept active — the production app at `sells-prospector-production-f51b.up.railway.app` stays live and unaffected.
- The CRM Phase 2 telephony build (`crm-phase2-prompt.md`, `twilio-claude-code-prompt.md`, `twilio-setup-walkthrough.md`, `twilio-a2p-handoff.md` in `docs/`) is paused — don't run those prompts until Twilio/OpenAI are re-subscribed.
