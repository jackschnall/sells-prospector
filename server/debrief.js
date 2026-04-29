// ─────────────────────────────────────────────────────────────────────────────
// Debrief — save drafts and final Q&A, auto-log an activity on completion.
// ─────────────────────────────────────────────────────────────────────────────

const { getCallLog, updateCallLog, getCompany, insertActivity, insertCalendarEvent, addNote } = require('./db');
const { emit } = require('./agent');

const MIN_ANSWER_LEN = 10;

function normalizeAnswers(questions, answersInput) {
  // answers: array of { question, answer } OR { answer } matched by index
  const questionList = Array.isArray(questions) ? questions : [];
  const incoming = Array.isArray(answersInput) ? answersInput : [];
  // Match by index first (most reliable), fall back to question text match
  return questionList.map((q, i) => {
    const byIndex = incoming[i];
    const byText = incoming.find((a) => a && a.question === q);
    const match = byIndex || byText || {};
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

async function submitDebrief(callLogId, userId, answersInput, disposition, callbackDecision) {
  const call = await getCallLog(callLogId);
  if (!call) throw new Error('call_log not found');
  if (call.user_id && call.user_id !== userId) throw new Error('Not your call');

  const isNoAnswer = disposition === 'no_answer_no_vm' || disposition === 'no_answer_left_vm';
  let answers;

  if (isNoAnswer) {
    // No-answer debriefs skip normal Q&A — accept the incoming answers directly
    answers = Array.isArray(answersInput) ? answersInput : [];
    // For left-VM, validate the VM note is at least MIN_ANSWER_LEN
    if (disposition === 'no_answer_left_vm') {
      const vmAnswer = answers.find((a) => a.question === 'Voicemail summary');
      if (!vmAnswer || !vmAnswer.answer || vmAnswer.answer.trim().length < MIN_ANSWER_LEN) {
        const err = new Error(`Voicemail summary must be at least ${MIN_ANSWER_LEN} characters.`);
        err.status = 400;
        throw err;
      }
    }
  } else {
    // Normal answered call — match against generated questions
    const questions = Array.isArray(call.debrief_questions)
      ? call.debrief_questions
      : (typeof call.debrief_questions === 'string'
          ? (() => { try { return JSON.parse(call.debrief_questions); } catch { return []; } })()
          : []);
    if (!questions.length) throw new Error('No debrief questions — analysis may still be running.');

    answers = normalizeAnswers(questions, answersInput);
    const bad = answers.filter((a) => !a.answer || a.answer.trim().length < MIN_ANSWER_LEN);
    if (bad.length) {
      // If incoming answers have enough text but normalization lost them, just use incoming directly
      const incomingValid = Array.isArray(answersInput) && answersInput.length >= questions.length
        && answersInput.every((a) => a?.answer && a.answer.trim().length >= MIN_ANSWER_LEN);
      if (incomingValid) {
        answers = answersInput.map((a, i) => ({
          question: questions[i] || a.question || `Question ${i + 1}`,
          answer: a.answer,
        }));
      } else {
        const err = new Error(`Each answer must be at least ${MIN_ANSWER_LEN} characters. Missing: ${bad.map((a) => a.question).join(', ')}`);
        err.status = 400;
        err.details = { missing: bad.map((a) => a.question) };
        throw err;
      }
    }
  }

  // Override sentiment for no-answer dispositions
  const sentimentOverride = isNoAnswer ? 'No Answer' : undefined;
  const updateData = {
    debrief_qa: answers,
    debrief_draft: null,
    debrief_status: 'complete',
  };
  if (disposition) updateData.disposition = disposition;
  if (sentimentOverride) updateData.sentiment = sentimentOverride;

  // Handle callback scheduling based on user decision
  if (callbackDecision && callbackDecision.action === 'approve' && callbackDecision.date) {
    // User approved (possibly changed) the suggested callback date
    updateData.scheduled_callback_date = callbackDecision.date;
    updateData.scheduling_detected = true;
  } else if (callbackDecision && callbackDecision.action === 'decline') {
    // User explicitly declined — clear any auto-detected date
    updateData.scheduled_callback_date = null;
    updateData.scheduling_detected = false;
  } else if (isNoAnswer) {
    // No-answer with no explicit decision: auto-schedule for next day
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    updateData.scheduled_callback_date = tomorrow.toISOString().slice(0, 10);
    updateData.scheduling_detected = true;
  }
  await updateCallLog(callLogId, updateData);

  // Create calendar event if callback was approved
  const company = await getCompany(call.company_id);
  if (updateData.scheduled_callback_date) {
    try {
      const title = `Callback: ${company?.name || 'Company'}${company?.owner ? ' — ' + company.owner : ''}`;
      await insertCalendarEvent({
        company_id: call.company_id,
        contact_id: call.contact_id || null,
        user_id: userId,
        title,
        description: callbackDecision?.action === 'approve' ? 'User-approved callback from debrief' : 'Auto-scheduled (no answer)',
        event_type: 'callback',
        starts_at: `${updateData.scheduled_callback_date}T10:00:00`,
        source: 'auto-transcript',
        call_log_id: callLogId,
      });
    } catch (err) {
      console.warn('[debrief] Failed to create callback calendar event:', err.message);
    }
  }

  // Auto-log a timeline activity summarizing the call
  const aiSummary = typeof call.ai_summary === 'string'
    ? (() => { try { return JSON.parse(call.ai_summary); } catch { return null; } })()
    : call.ai_summary;
  const bullets = (aiSummary?.bullets || []).slice(0, 3).map((b) => `• ${b}`).join('\n');
  const durationStr = call.duration_sec
    ? `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s`
    : '—';
  let summary;
  if (disposition === 'no_answer_no_vm') {
    summary = `Call (${durationStr}) — No Answer`;
  } else if (disposition === 'no_answer_left_vm') {
    const vmNote = answers.find((a) => a.question === 'Voicemail summary')?.answer || '';
    summary = `Call (${durationStr}) — No Answer, left VM: ${vmNote.slice(0, 80)}`;
  } else {
    summary = `Call (${durationStr}) — ${sentimentOverride || call.sentiment || 'Neutral'}`;
  }
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

  // Auto-save AI notes to company notes
  if (aiSummary && call.company_id) {
    const allBullets = (aiSummary.bullets || []).map((b) => `• ${b}`).join('\n');
    const noteParts = [
      `📞 Call Notes — ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      `Sentiment: ${call.sentiment || 'Neutral'}`,
      allBullets,
      call.next_action ? `Next: ${call.next_action}` : null,
      call.outreach_angle_refined ? `Outreach angle: ${call.outreach_angle_refined}` : null,
    ].filter(Boolean).join('\n');
    try {
      await addNote(call.company_id, noteParts);
    } catch (err) {
      console.warn('[debrief] Failed to save AI notes:', err.message);
    }
  }

  // Rebuild call intelligence — merged bullet points from all answered calls
  if (call.company_id) {
    try {
      const { pool } = require('./db');
      // Get all completed calls for this company that had real conversations
      const { rows: allCalls } = await pool.query(
        `SELECT ai_summary, sentiment FROM call_logs
         WHERE company_id = $1 AND debrief_status = 'complete'
           AND sentiment NOT IN ('No Answer')
           AND ai_summary IS NOT NULL
         ORDER BY called_at ASC`,
        [call.company_id]
      );
      // Collect all unique bullets across all calls
      const seen = new Set();
      const allBullets = [];
      for (const cl of allCalls) {
        const bullets = cl.ai_summary?.bullets || [];
        for (const b of bullets) {
          const key = b.toLowerCase().trim();
          if (!seen.has(key)) {
            seen.add(key);
            allBullets.push(b);
          }
        }
      }
      if (allBullets.length) {
        const intel = allBullets.map((b) => `• ${b}`).join('\n');
        await pool.query('UPDATE companies SET call_intelligence = $1, updated_at = NOW() WHERE id = $2', [intel, call.company_id]);
      }
    } catch (err) {
      console.warn('[debrief] Failed to update call_intelligence:', err.message);
    }
  }

  emit({ type: 'debrief_complete', call_log_id: callLogId, company_id: call.company_id });
  emit({ type: 'activity_added', company_id: call.company_id });
  return { ok: true };
}

module.exports = { saveDraft, submitDebrief, MIN_ANSWER_LEN };
