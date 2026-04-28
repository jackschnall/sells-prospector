// ─────────────────────────────────────────────────────────────────────────────
// Call Analyzer — runs Claude over a transcript to extract structured
// call intelligence: sentiment, scheduling, summary, next action, and
// debrief questions tailored to what actually happened.
//
// Auto-creates a calendar_events row if scheduling is detected.
// ─────────────────────────────────────────────────────────────────────────────

const { callJson, MODELS } = require('./claude');
const {
  getCallLog,
  updateCallLog,
  getCompany,
  insertCalendarEvent,
} = require('./db');
const { emit } = require('./agent');

const ALLOWED_SENTIMENTS = [
  'Receptive',
  'Neutral',
  'Not Interested',
  'No Answer',
  'Callback Requested',
];

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildAnalysisPrompt(company, transcript) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    system: [
      'You are an M&A origination analyst assistant for a middle-market investment bank.',
      'You read phone-call transcripts between an analyst and a plumbing-company owner,',
      'and extract structured JSON. Be concise and accurate. Resolve relative time phrases',
      `("next Tuesday", "after the holidays", "in two weeks") to absolute dates using today = ${today}.`,
      'Output ONLY valid JSON — no prose, no code fences.',
    ].join(' '),
    user:
      `Today's date: ${today}\n` +
      `Company: ${company?.name || 'Unknown'} (${company?.city || ''}, ${company?.state || ''})\n` +
      `Owner on file: ${company?.owner || 'Unknown'}\n\n` +
      `Transcript:\n"""\n${transcript}\n"""\n\n` +
      `Return a JSON object with EXACTLY these keys:\n` +
      `{\n` +
      `  "summary_bullets": [3 to 4 short bullet strings, each a concrete fact or dynamic from the call],\n` +
      `  "sentiment": one of ["Receptive","Neutral","Not Interested","No Answer","Callback Requested"],\n` +
      `  "scheduling_detected": true|false,\n` +
      `  "scheduled_callback_date": "YYYY-MM-DD" or null (ALWAYS suggest a date if scheduling_detected is true — resolve relative phrases like 'next week', 'after vacation', 'a couple weeks' to an absolute date; today is ${new Date().toISOString().slice(0, 10)}),\n` +
      `  "scheduling_quote": the exact short quote where scheduling was raised, or null,\n` +
      `  "next_action": one concise sentence about what the analyst should do next,\n` +
      `  "outreach_angle_refined": one concise sentence updating the cold-call angle for the next conversation based on what resonated or didn't\n` +
      `}\n` +
      `If the call was a voicemail, gatekeeper, or no conversation, use sentiment "No Answer".`,
  };
}

function buildDebriefQuestionsPrompt(company, transcript, aiSummary) {
  return {
    system:
      'You generate post-call debrief questions for an M&A analyst. The questions MUST be tailored to ' +
      'what actually happened in THIS call — not generic. Exactly 3 questions maximum, each a single sentence ' +
      'ending with a question mark, each focused on a specific event, name, topic, or signal from ' +
      'the transcript. Output ONLY valid JSON.',
    user:
      `Company: ${company?.name || 'Unknown'}\nOwner: ${company?.owner || 'Unknown'}\n\n` +
      `Call summary:\n${JSON.stringify(aiSummary, null, 2)}\n\n` +
      `Transcript:\n"""\n${transcript}\n"""\n\n` +
      `Return JSON: { "questions": ["Q1?", "Q2?", "Q3?"] } with exactly 3 items.\n` +
      `Rules:\n` +
      `- If scheduling was mentioned, ask about the callback (date, anything to prep).\n` +
      `- If a spouse/partner/co-owner was named, ask about their role in the decision.\n` +
      `- If interest or enthusiasm appeared, ask what resonated most.\n` +
      `- If an objection was raised, ask how hard the objection is and how to address it.\n` +
      `- If a recent life event (health, retirement, competitor offer) was mentioned, ask about timing implications.\n` +
      `- If the call was a voicemail/gatekeeper, ask the analyst's recommended next step.\n` +
      `- If revenue/valuation came up, ask if it changes the deal-size view.\n` +
      `- Questions must be specific, referencing real phrases or facts.`,
  };
}

// ─── Fallbacks (used when ANTHROPIC_API_KEY missing or Claude fails) ─────────

function fallbackAnalysis(transcript) {
  const t = (transcript || '').toLowerCase();
  let sentiment = 'Neutral';
  if (t.includes('voicemail') || t.includes("you've reached") || t.includes('please leave a message')) sentiment = 'No Answer';
  else if (t.includes('not interested') || t.includes('take me off')) sentiment = 'Not Interested';
  else if (t.includes('call me back') || t.includes('after the holidays') || t.includes('try me next')) sentiment = 'Callback Requested';
  else if (t.includes('would be helpful') || t.includes('open to') || t.includes('send me')) sentiment = 'Receptive';
  return {
    summary_bullets: [
      'Call transcript captured.',
      `Heuristic sentiment: ${sentiment}.`,
      'Full AI analysis unavailable — configure ANTHROPIC_API_KEY for deeper insight.',
    ],
    sentiment,
    scheduling_detected: false,
    scheduled_callback_date: null,
    scheduling_quote: null,
    next_action: 'Review transcript manually and decide follow-up.',
    outreach_angle_refined: 'No refinement available without AI analysis.',
  };
}

function fallbackDebriefQuestions(analysis) {
  const qs = [];
  const s = analysis?.sentiment || 'Neutral';
  if (s === 'No Answer') {
    qs.push('Was this a voicemail, gatekeeper, or wrong number?');
    qs.push('What is your recommended next step — retry, switch channel, or drop?');
  } else if (s === 'Callback Requested') {
    qs.push('Does the callback timing work for your schedule — anything to prep before then?');
    qs.push('What tone did the owner strike — genuine interest or polite deferral?');
  } else if (s === 'Not Interested') {
    qs.push('How hard is this "no" — permanent or something we revisit in 12 months?');
    qs.push('Is there a specific objection worth documenting for future outreach?');
  } else if (s === 'Receptive') {
    qs.push('What specifically resonated with the owner during the call?');
    qs.push('Who else (spouse, partner, co-owner) needs to be brought into the next conversation?');
  } else {
    qs.push('What is your read on the owner\'s openness to a future conversation?');
    qs.push('What is the strongest signal you got from this call?');
  }
  qs.push('Any facts about the business or owner that should be added to the record?');
  return qs.slice(0, 4);
}

// ─── Normalization helpers ──────────────────────────────────────────────────

function validateSentiment(v) {
  return ALLOWED_SENTIMENTS.includes(v) ? v : 'Neutral';
}

function validateDate(v) {
  if (!v || typeof v !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return v;
}

function normalizeAnalysis(parsed) {
  const summary = Array.isArray(parsed?.summary_bullets)
    ? parsed.summary_bullets.filter((s) => typeof s === 'string' && s.trim()).slice(0, 5)
    : [];
  const sentiment = validateSentiment(parsed?.sentiment);
  const date = validateDate(parsed?.scheduled_callback_date);
  const scheduling_detected = !!parsed?.scheduling_detected && !!date;
  return {
    summary_bullets: summary.length ? summary : ['Call transcript analyzed.'],
    sentiment,
    scheduling_detected,
    scheduled_callback_date: scheduling_detected ? date : null,
    scheduling_quote: typeof parsed?.scheduling_quote === 'string' ? parsed.scheduling_quote : null,
    next_action: typeof parsed?.next_action === 'string' ? parsed.next_action : 'Decide follow-up.',
    outreach_angle_refined: typeof parsed?.outreach_angle_refined === 'string'
      ? parsed.outreach_angle_refined
      : '',
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function analyzeCall(callLogId) {
  const call = await getCallLog(callLogId);
  if (!call) throw new Error(`call_log not found: ${callLogId}`);
  const transcript = call.transcript || '';
  if (!transcript.trim()) {
    // Nothing to analyze — mark as complete with a minimal summary.
    const fallback = fallbackAnalysis('');
    await updateCallLog(callLogId, {
      ai_summary: { bullets: fallback.summary_bullets },
      sentiment: fallback.sentiment,
      scheduling_detected: false,
      scheduled_callback_date: null,
      next_action: fallback.next_action,
      outreach_angle_refined: fallback.outreach_angle_refined,
    });
    await generateDebriefQuestions(callLogId);
    return fallback;
  }

  const company = await getCompany(call.company_id);
  let analysis;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { system, user } = buildAnalysisPrompt(company, transcript);
      const { parsed } = await callJson({
        model: MODELS.worker,
        system,
        user,
        maxTokens: 1400,
      });
      analysis = normalizeAnalysis(parsed);
    } catch (err) {
      console.warn('[call-analyzer] Claude analysis failed, using fallback:', err.message);
      analysis = fallbackAnalysis(transcript);
    }
  } else {
    analysis = fallbackAnalysis(transcript);
  }

  await updateCallLog(callLogId, {
    ai_summary: {
      bullets: analysis.summary_bullets,
      scheduling_quote: analysis.scheduling_quote,
    },
    sentiment: analysis.sentiment,
    scheduling_detected: !!analysis.scheduling_detected,
    scheduled_callback_date: analysis.scheduled_callback_date || null,
    next_action: analysis.next_action,
    outreach_angle_refined: analysis.outreach_angle_refined,
  });

  // Calendar event is NO LONGER auto-created here.
  // Instead, the suggested callback date is stored on call_logs and surfaced
  // in the debrief modal where the user can Approve / Change / Decline.
  // The approved date is then used to create the calendar event in debrief.js.
  if (false) { // Disabled — user approval flow handles this
    try {
      const title = `Callback: ${company?.name || 'Company'}${company?.owner ? ' — ' + company.owner : ''}`;
      const startsAt = `${analysis.scheduled_callback_date}T10:00:00`;
      const eventId = await insertCalendarEvent({
        company_id: call.company_id,
        contact_id: call.contact_id || null,
        user_id: call.user_id || null,
        title,
        description: 'Review before calling',
        event_type: 'callback',
        starts_at: startsAt,
        source: 'auto-transcript',
        transcript_quote: analysis.scheduling_quote || null,
        call_log_id: callLogId,
      });
      emit({
        type: 'calendar_event_created',
        event_id: eventId,
        company_id: call.company_id,
        date: analysis.scheduled_callback_date,
      });
    } catch (err) {
      console.warn('[call-analyzer] Failed to create calendar event:', err.message);
    }
  }

  await generateDebriefQuestions(callLogId);
  return analysis;
}

async function generateDebriefQuestions(callLogId) {
  const call = await getCallLog(callLogId);
  if (!call) return [];
  const transcript = call.transcript || '';
  const aiSummary = typeof call.ai_summary === 'string'
    ? (() => { try { return JSON.parse(call.ai_summary); } catch { return {}; } })()
    : (call.ai_summary || {});
  const company = await getCompany(call.company_id);

  let questions;
  if (process.env.ANTHROPIC_API_KEY && transcript.trim()) {
    try {
      const { system, user } = buildDebriefQuestionsPrompt(company, transcript, aiSummary);
      const { parsed } = await callJson({
        model: MODELS.worker,
        system,
        user,
        maxTokens: 800,
      });
      if (Array.isArray(parsed?.questions)) {
        questions = parsed.questions
          .filter((q) => typeof q === 'string' && q.trim().length > 0)
          .slice(0, 5);
      }
    } catch (err) {
      console.warn('[call-analyzer] Claude debrief-questions failed, using fallback:', err.message);
    }
  }
  if (!questions || questions.length < 3) {
    questions = fallbackDebriefQuestions({ sentiment: call.sentiment });
  }

  await updateCallLog(callLogId, { debrief_questions: questions });
  emit({
    type: 'call_ready_for_debrief',
    call_log_id: callLogId,
    company_id: call.company_id,
    user_id: call.user_id,
  });
  return questions;
}

module.exports = { analyzeCall, generateDebriefQuestions };
