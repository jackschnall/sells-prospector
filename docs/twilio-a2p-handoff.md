# Twilio A2P 10DLC Campaign — Handoff

> **STATUS UPDATE (2026-07-13):** This Twilio account is being closed today. The A2P campaign below is moot until a new Twilio account and phone number are set up from scratch.

**Date of last action:** 2026-05-20
**Status as of handoff:** Campaign resubmitted, under TCR/carrier review ("In progress")

---

## Context

Sells Group Advisors (middle-market M&A advisory firm targeting service-industry business owners — plumbing, HVAC, electrical, etc.) had its Twilio A2P 10DLC campaign rejected because the opt-in consent description sounded like cold outreach to scraped numbers. Carriers reject anything that reads like contacts came from public listings/registrations without prior interaction.

We edited the rejected campaign via the Twilio console and resubmitted with prior-direct-interaction language. Campaign is now awaiting re-review.

## Campaign identifiers

- **Twilio account:** "My first Twilio account"
- **Brand SID:** BN3ccee4d4bab8dbb76df93680b36952d1
- **Campaign SID:** CMc7ebb11ceee1f9848c3c642933298ffb
- **Messaging Service SID:** MGede0bef5bb0cbfff78aa072703a4c4f0
- **Use case:** Low Volume Mixed
- **Direct link:** https://console.twilio.com/us1/develop/sms/regulatory-compliance/campaigns/BN3ccee4d4bab8dbb76df93680b36952d1/CMc7ebb11ceee1f9848c3c642933298ffb

## What was changed

### 1. Opt-in consent ("How do end-users consent to receive messages?")
**Before** (rejected):
> "End users provide their phone number as part of their business listing, website, or public business registration. Our team initiates contact for business-to-business communications regarding potential acquisition opportunities. Recipients can opt out at any time by replying STOP."

**After:**
> "End users consent to receive messages through direct business-to-business communication. Recipients provide their phone number during in-person meetings, phone conversations, email exchanges, or through their company website contact forms. Our team only messages contacts who have had prior direct interaction with our firm. Recipients can opt out at any time by replying STOP."

### 2. Campaign description
**Before:** "Business outreach and follow-up communications with service industry company owners regarding potential acquisition and partnership opportunities. Messages include initial introductions, meeting scheduling, and follow-up after phone calls."

**After:** "Sells Group Advisors is a middle-market M&A advisory firm. We send SMS to service-industry business owners we have already engaged with directly — via in-person meetings, phone conversations, email exchanges, or our company website's contact form. Texts are limited to scheduling follow-up meetings, confirming next steps after a call, and continuing prior conversations regarding acquisition or partnership opportunities."

### 3. Sample message #1
**Before:** "Hi, this is Jack with Sells Group Advisors. I tried reaching you earlier regarding your business – would love to connect briefly. What's a good time to chat?"

**After:** "Hi, it's Jack from Sells Group Advisors — thanks for connecting earlier. Following up to find a time for a quick call to continue our conversation. Reply STOP to opt out."

### 4. URLs re-entered (had been cleared when edit modal opened)
- Privacy Policy URL: https://sellsadvisors.com/privacy
- Terms and Conditions URL: https://sellsadvisors.com/privacy *(same — flagged as risk below)*

### Unchanged (already fine)
- Sample message #2: "Hi, following up on our conversation earlier. I'd like to schedule a time to discuss further. Let me know what works for you."
- Sample message #3: "Thank you for speaking with me today. As discussed, I'll send over some additional information. Feel free to reach out if you have any questions."
- Sample messages #4 and #5: empty
- Embedded links: No
- Embedded phone numbers: Yes
- Age-gated content: No
- Direct lending/loan content: No
- Opt-out keywords (OPTOUT, CANCEL, END, QUIT, UNSUBSCRIBE, REVOKE, STOP, STOPALL): default
- Help keywords (HELP, INFO): default

## Open follow-ups / known risks

### Risk 1 — Terms URL = Privacy URL
Both fields point to /privacy. Some carrier vetters accept this; some reject it as a second pass. **If this fails again citing Terms,** stand up a real /terms page on sellsadvisors.com containing: program name, message/data rates disclaimer, message frequency, support contact, HELP/STOP language in bold. Twilio support article: https://help.twilio.com/articles/223134847-Industry-standards-for-US-Short-Code-Terms-of-Service

### Risk 2 — Privacy Policy content mismatch with B2B use case
The current /privacy page mentions "appointment reminders, marketing promotions" and "point-of-sale locations" in the SMS sections. These don't match a B2B M&A advisory use case. Not blocking the campaign right now, but if a manual reviewer reads both the campaign and the policy, they'll see inconsistency. Worth tightening the SMS section of the privacy policy to match the actual use case.

### Risk 3 — TCR timing
TCR/carrier review typically takes a few business days to ~2 weeks. Twilio will email on resolution. No A2P traffic can flow until approved.

## How to verify status

1. Navigate to https://console.twilio.com/us1/develop/sms/regulatory-compliance/campaigns
2. Look at the campaign with SID starting `CMc7ebb11ce...`
3. Status will be one of: In progress (under review), Approved, or Failed (rejected again — read the rejection reason)

## How to re-edit if needed

From the campaign detail page, click "Edit Campaign" (not "Fix Campaign" — that only appears when failed). Note: opening edit mode clears the Privacy/Terms URL fields, so they must be re-entered each time alongside any other change.
