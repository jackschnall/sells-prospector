// Canned mock transcripts used in place of Whisper output while Twilio keys
// aren't configured. Each entry covers a specific sentiment/scheduling pattern
// so the downstream call-analyzer produces interesting variety during dev.

const MOCK_TRANSCRIPTS = [
  {
    id: 'receptive-scheduling',
    sentiment_hint: 'Receptive',
    duration_sec: 278,
    transcript:
      `[Agent] Hi, is this {owner}?\n` +
      `[Owner] Yeah, speaking.\n` +
      `[Agent] This is Jack from Sells — we work with plumbing company owners on succession planning. Got a minute?\n` +
      `[Owner] Sure, quick one though, I've got a meeting at three.\n` +
      `[Agent] Understood. I'll be brief. We've been looking at {company} and your footprint in the {state} market — really strong reputation on reviews and a good commercial mix. Have you given any thought to succession? Next five, ten years?\n` +
      `[Owner] Honestly, yeah. My wife and I were just talking about it last weekend. I'm 62. Kids aren't interested in taking it over.\n` +
      `[Agent] That's a really common story. Would you be open to a longer conversation where I can walk you through what ownership transitions typically look like in this market?\n` +
      `[Owner] Yeah, that'd be helpful. Call me back in about two weeks? Things are crazy right now with a big commercial install we're finishing up.\n` +
      `[Agent] Absolutely. Two weeks from today — I'll put it on the calendar and send you a quick note with some reading material in the meantime.\n` +
      `[Owner] Sounds good. Appreciate you.`,
  },
  {
    id: 'receptive-no-scheduling',
    sentiment_hint: 'Receptive',
    duration_sec: 340,
    transcript:
      `[Agent] {owner}, hi — Jack from Sells. You have a second?\n` +
      `[Owner] A second, yeah.\n` +
      `[Agent] We focus on M&A for plumbing companies in the Southeast. Your name came up as one of the strongest operators in {state}. I'd love to learn more about your business and what your plans look like.\n` +
      `[Owner] What kind of plans?\n` +
      `[Agent] Any thoughts on succession, a transaction, bringing in outside capital — that sort of thing.\n` +
      `[Owner] Well, we're doing about $8M this year. Growing maybe 15%. My business partner is looking to retire in a few years, so we've thought about it, but nothing concrete.\n` +
      `[Agent] That's incredibly helpful context. The partner angle is a really common catalyst. Would it be worth sitting down and walking through a few benchmarks? No commitment — just useful context for when you're ready.\n` +
      `[Owner] I'd be open to that. Send me an email with some background on your firm first.\n` +
      `[Agent] Done. I'll also include a couple of recent transactions we've closed in a similar size range.\n` +
      `[Owner] Good. Talk soon.`,
  },
  {
    id: 'neutral-info-gather',
    sentiment_hint: 'Neutral',
    duration_sec: 145,
    transcript:
      `[Agent] Hi, is this the owner of {company}?\n` +
      `[Owner] This is {owner}, yeah.\n` +
      `[Agent] Jack from Sells — we're an M&A advisory firm focused on plumbing contractors. Do you mind if I ask a couple of quick questions?\n` +
      `[Owner] Go ahead.\n` +
      `[Agent] What's your rough annual revenue and employee count?\n` +
      `[Owner] I'm not sharing that over the phone, sorry.\n` +
      `[Agent] Completely fair. Are you open to receiving information about what we do and staying in touch?\n` +
      `[Owner] Sure, email me. I'm not in a hurry though. Things are stable here.\n` +
      `[Agent] Understood. I'll send over a brief overview and we can connect again if and when the timing is better for you.\n` +
      `[Owner] Alright.`,
  },
  {
    id: 'callback-requested-specific-date',
    sentiment_hint: 'Callback Requested',
    duration_sec: 62,
    transcript:
      `[Agent] Hi, this is Jack with Sells — is {owner} available?\n` +
      `[Owner] Speaking. Listen, I'm walking into a meeting. Can you try me next Tuesday around 10 AM?\n` +
      `[Agent] Absolutely. Next Tuesday at 10. I'll call then — anything specific you'd like to think about in the meantime?\n` +
      `[Owner] You said you're in M&A? Yeah, send me some info on the kind of deals you do. I'll take a look.\n` +
      `[Agent] Will do. Talk next Tuesday.\n` +
      `[Owner] Thanks, bye.`,
  },
  {
    id: 'callback-after-holidays',
    sentiment_hint: 'Callback Requested',
    duration_sec: 84,
    transcript:
      `[Agent] {owner}? Jack from Sells.\n` +
      `[Owner] Yeah?\n` +
      `[Agent] We advise plumbing company owners on succession and sale. Wanted to see if you'd be open to a quick chat.\n` +
      `[Owner] Not a good time. Look, call me back after the holidays. Things will settle down then.\n` +
      `[Agent] Got it. I'll plan to reach out in early January. Anything I should send your way in the meantime?\n` +
      `[Owner] Nah, just call me after the holidays. Thanks.`,
  },
  {
    id: 'not-interested',
    sentiment_hint: 'Not Interested',
    duration_sec: 41,
    transcript:
      `[Agent] Hi, looking for {owner} — this is Jack with Sells.\n` +
      `[Owner] Yeah, I'm {owner}. What's this about?\n` +
      `[Agent] We work with plumbing company owners on M&A and succession. Wanted to introduce ourselves.\n` +
      `[Owner] I'm not selling. Built this thing from nothing. Not interested. Please take me off your list.\n` +
      `[Agent] Understood. I'll note that. Thanks for your time.`,
  },
  {
    id: 'no-answer-voicemail',
    sentiment_hint: 'No Answer',
    duration_sec: 22,
    transcript:
      `[Voicemail] You've reached {company}. We're not able to take your call right now. Please leave a message after the tone and we'll get back to you as soon as we can.\n` +
      `[Agent] Hi, this is Jack from Sells calling for {owner}. We work with plumbing business owners in {state} on succession planning and M&A. I'd love to connect when you have a few minutes — I'll try you again in a couple of days. Thanks.`,
  },
  {
    id: 'gatekeeper',
    sentiment_hint: 'No Answer',
    duration_sec: 38,
    transcript:
      `[Receptionist] {company}, how can I help you?\n` +
      `[Agent] Hi, is {owner} available?\n` +
      `[Receptionist] He's out in the field all day. Can I take a message?\n` +
      `[Agent] Sure — this is Jack with Sells, it's about a business-related inquiry, not a sales call. My number is on your caller ID. What's the best time to reach him?\n` +
      `[Receptionist] Try first thing in the morning, around 7 AM, before he heads out.\n` +
      `[Agent] Perfect. I'll try tomorrow at 7. Thank you.`,
  },
  {
    id: 'receptive-spouse-mentioned',
    sentiment_hint: 'Receptive',
    duration_sec: 215,
    transcript:
      `[Agent] {owner}, hi — Jack from Sells. Do you have a quick minute?\n` +
      `[Owner] Yeah, I've got a minute.\n` +
      `[Agent] Wanted to briefly introduce the firm — we do M&A for plumbing contractors. Have you thought at all about what a transition might look like for {company}?\n` +
      `[Owner] We've actually been thinking about it a lot. My wife Linda runs the office and she's been pushing me to slow down. She's 60, I'm 64. The business is doing well — about $6M — but we're both tired.\n` +
      `[Agent] That's a really honest answer and I appreciate it. Transitions where the spouse is involved operationally actually go smoother when both people are aligned. Would it make sense to set up a call with both of you?\n` +
      `[Owner] Yeah. Linda would definitely want to be on it. Let me check her calendar and get back to you. Give me a few weeks.\n` +
      `[Agent] Of course. I'll follow up in about three weeks. And I'll send over some case studies that might be useful to look at together.\n` +
      `[Owner] Great. Thanks, Jack.`,
  },
  {
    id: 'objection-competitor',
    sentiment_hint: 'Not Interested',
    duration_sec: 103,
    transcript:
      `[Agent] {owner}? Jack from Sells, plumbing M&A.\n` +
      `[Owner] Yeah, I got your message. Listen, I just had another firm pitch me last month. They were offering what felt like a lowball number. Frankly it left a bad taste.\n` +
      `[Agent] I'm sorry to hear that. Every firm works a little differently. Can I ask — was it a valuation conversation or an actual offer on paper?\n` +
      `[Owner] Verbal number. Seven times EBITDA, but they were using our trailing twelve months which was our worst year. Ridiculous.\n` +
      `[Agent] That is frustrating. Our process typically involves normalizing a few years of financials before we even start talking about multiples. Would it be worth letting me walk you through how we'd approach it — no obligation, just a different perspective?\n` +
      `[Owner] Not right now. I'm done with sell-side conversations for a while. Maybe next year.\n` +
      `[Agent] Completely fair. I'll check back in with you in about 12 months.\n` +
      `[Owner] Fine. Thanks.`,
  },
];

function fill(template, context) {
  const { company = 'the company', owner = 'the owner', state = 'the region' } = context || {};
  return template
    .replace(/\{company\}/g, company)
    .replace(/\{owner\}/g, owner)
    .replace(/\{state\}/g, state);
}

function pickMockTranscript(context = {}) {
  // Deterministic enough to be testable but varied: seed by current minute
  const idx = Math.floor(Math.random() * MOCK_TRANSCRIPTS.length);
  const pick = MOCK_TRANSCRIPTS[idx];
  return {
    id: pick.id,
    sentiment_hint: pick.sentiment_hint,
    duration_sec: pick.duration_sec,
    transcript: fill(pick.transcript, context),
  };
}

function mockTranscriptById(id, context = {}) {
  const pick = MOCK_TRANSCRIPTS.find((t) => t.id === id) || MOCK_TRANSCRIPTS[0];
  return {
    id: pick.id,
    sentiment_hint: pick.sentiment_hint,
    duration_sec: pick.duration_sec,
    transcript: fill(pick.transcript, context),
  };
}

module.exports = { pickMockTranscript, mockTranscriptById, MOCK_TRANSCRIPTS };
