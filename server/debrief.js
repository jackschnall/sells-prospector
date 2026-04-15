// ─────────────────────────────────────────────────────────────────────────────
// Debrief — save drafts and final Q&A, auto-log an activity on completion.
// ─────────────────────────────────────────────────────────────────────────────

const { getCallLog, updateCallLog, getCompany, insertActivity } = require('./db');
const { emit } = require('./agent');

const MIN_ANSWER_LEN = 10;

function normalizeAnswers(questions, answersInput) {
  // answers: array of { question, answer } OR { answer } matched by index
  const questionList = Array.isArray(questions) ? questions : [];
  const incoming = Array.isArray(answersInput) ? answersInput : [];
  return questionList.map((q, i) => {
    const match = incoming.find((a) => a && a.question === q) || incoming[i] || {};
    return {
      question: q,
      answer: typeof match.answer === 'string' ? match.answer : '',
    };
  });
}

async function saveDraft(callLogId, userId, answersInput) {
  const call = await getCallLog(callLogId);
  if (!call) throw new Error('call_log not found');
  if (call.user_id && call.user_id !== userId) throw new Error('Not your call');
  const questions = Array.isArray(call.debrief_questions)
    ? call.debrief_questions
    : (typeof call.debrief_questions === 'string'
        ? (() => { try { return JSON.parse(call.debrief_questions); } catch { return []; } })()
        : []);
  const draft = normalizeAnswers(questions, answersInput);
  await updateCallLog(callLogId, {
    debrief_draft: draft,
    debrief_status: 'draft',
  });
  return { ok: true, saved_at: new Date().toISOString() };
}

async function submitDebrief(callLogId, userId, answersInput) {
  const call = await getCallLog(callLogId);
  if (!call) throw new Error('call_log not found');
  if (call.user_id && call.user_id !== userId) throw new Error('Not your call');
  const questions = Array.isArray(call.debrief_questions)
    ? call.debrief_questions
    : (typeof call.debrief_questions === 'string'
        ? (() => { try { return JSON.parse(call.debrief_questions); } catch { return []; } })()
        : []);
  if (!questions.length) throw new Error('No debrief questions — analysis may still be running.');

  const answers = normalizeAnswers(questions, answersInput);
  const bad = answers.filter((a) => !a.answer || a.answer.trim().length < MIN_ANSWER_LEN);
  if (bad.length) {
    const err = new Error(`Each answer must be at least ${MIN_ANSWER_LEN} characters.`);
    err.status = 400;
    err.details = { missing: bad.map((a) => a.question) };
    throw err;
  }

  await updateCallLog(callLogId, {
    debrief_qa: answers,
    debrief_draft: null,
    debrief_status: 'complete',
  });

  // Auto-log a timeline activity summarizing the call
  const company = await getCompany(call.company_id);
  const aiSummary = typeof call.ai_summary === 'string'
    ? (() => { try { return JSON.parse(call.ai_summary); } catch { return null; } })()
    : call.ai_summary;
  const bullets = (aiSummary?.bullets || []).slice(0, 3).map((b) => `• ${b}`).join('\n');
  const durationStr = call.duration_sec
    ? `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s`
    : '—';
  const summary = `Call (${durationStr}) — ${call.sentiment || 'Neutral'}`;
  const details = [
    bullets,
    call.next_action ? `Next: ${call.next_action}` : null,
  ].filter(Boolean).join('\n\n');

  await insertActivity({
    company_id: call.company_id,
    contact_id: call.contact_id || null,
    user_id: userId,
    type: 'call',
    summary,
    details: details || null,
  });

  emit({ type: 'debrief_complete', call_log_id: callLogId, company_id: call.company_id });
  emit({ type: 'activity_added', company_id: call.company_id });
  return { ok: true };
}

module.exports = { saveDraft, submitDebrief, MIN_ANSWER_LEN };
