// ─────────────────────────────────────────────────────────────────────────────
// Twilio telephony routes (mock-first).
//
// When TWILIO_ACCOUNT_SID is missing OR MOCK_CALLS=1, we run a simulated call
// flow: POST /api/twilio/call returns a fake call_sid, and the frontend later
// POSTs /api/twilio/mock-complete to supply a canned transcript → analysis.
//
// When real Twilio keys are present, POST /api/twilio/call places a real
// outbound call, /api/twilio/voice is the TwiML webhook, and the recording
// + status callbacks complete the loop.
// ─────────────────────────────────────────────────────────────────────────────

const { insertCallLog, getCallLog, updateCallLog, getCallLogBySid, getCompany, insertMessage, listMessages, insertActivity, pool, listUsers } = require('./db');
const { requireUser } = require('./auth');
const { pickMockTranscript, mockTranscriptById } = require('./mock-transcripts');
const { attachMockTranscript, transcribeFromRecording } = require('./transcription');
const { emit } = require('./agent');

function isMockMode() {
  return !process.env.TWILIO_ACCOUNT_SID || process.env.MOCK_CALLS === '1';
}

// Lazy Twilio SDK client (not required in mock mode).
let _twilio = null;
function twilioClient() {
  if (isMockMode()) return null;
  if (!_twilio) {
    // eslint-disable-next-line global-require
    const Twilio = require('twilio');
    _twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _twilio;
}

function mockSid(prefix) {
  const rand = Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  return `${prefix}${rand}mock`;
}

// ─── Route registration ─────────────────────────────────────────────────────

function registerRoutes(app) {
  // GET /api/twilio/status — lightweight status for frontend to know mock vs live
  app.get('/api/twilio/status', (req, res) => {
    res.json({
      mock: isMockMode(),
      has_credentials: !!process.env.TWILIO_ACCOUNT_SID,
      from_number: process.env.TWILIO_PHONE_NUMBER || null,
    });
  });

  // POST /api/twilio/token — Voice SDK access token (mock returns {mock:true})
  app.post('/api/twilio/token', requireUser, (req, res) => {
    if (isMockMode()) return res.json({ mock: true, token: null });
    try {
      // eslint-disable-next-line global-require
      const Twilio = require('twilio');
      const AccessToken = Twilio.jwt.AccessToken;
      const VoiceGrant = AccessToken.VoiceGrant;
      const token = new AccessToken(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_API_KEY,
        process.env.TWILIO_API_SECRET,
        { identity: req.currentUser.id, ttl: 3600 }
      );
      token.addGrant(new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      }));
      res.json({ mock: false, token: token.toJwt() });
    } catch (err) {
      res.status(500).json({ error: 'Token generation failed', details: err.message });
    }
  });

  // POST /api/twilio/call — create call_log and (live) place outbound call
  app.post('/api/twilio/call', requireUser, async (req, res) => {
    const { company_id, contact_id, to } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    const company = await getCompany(company_id);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const mock = isMockMode();
    const callLogId = await insertCallLog({
      company_id,
      contact_id: contact_id || null,
      user_id: req.currentUser.id,
      direction: 'outbound',
      status: mock ? 'mock-in-progress' : 'initiated',
      mock,
    });

    if (mock) {
      emit({ type: 'call_started', call_log_id: callLogId, company_id, mock: true });
      return res.json({ ok: true, call_log_id: callLogId, mock: true, call_sid: mockSid('CA') });
    }

    // Live Twilio — browser Voice SDK places the call via device.connect().
    // We just create the call_log; the TwiML webhook bridges to the target number.
    emit({ type: 'call_started', call_log_id: callLogId, company_id, mock: false });
    res.json({ ok: true, call_log_id: callLogId, to: to || company.phone, mock: false });
  });

  // POST /api/twilio/voice — TwiML webhook for BOTH inbound and outbound calls.
  // Inbound: To matches our Twilio number → ring all browser clients.
  // Outbound: To is an external number → dial out.
  app.post('/api/twilio/voice', express_urlencoded(), async (req, res) => {
    const rawTo = req.body?.To || req.query.to || '';
    const rawFrom = req.body?.From || '';
    const callSid = req.body?.CallSid || '';
    const direction = req.body?.Direction || '';
    const twilioNumber = (process.env.TWILIO_PHONE_NUMBER || '').replace(/\D/g, '');
    const toDigits = rawTo.replace(/\D/g, '');

    const publicUrl = process.env.PUBLIC_URL || '';
    const recordingCb = publicUrl ? `${publicUrl}/api/twilio/recording-status` : '/api/twilio/recording-status';

    // Detect inbound: Direction is 'inbound' OR the To number matches our Twilio number
    const isInbound = direction === 'inbound' ||
      (twilioNumber && toDigits.endsWith(twilioNumber.slice(-10)));

    if (isInbound) {
      console.log(`[twilio/voice] Inbound call from ${rawFrom}, CallSid ${callSid}`);

      // Route to the user whose Twilio number matches the called number
      const users = await listUsers();
      const calledDigits = (req.body?.To || '').replace(/\D/g, '').slice(-10);
      const targetUsers = calledDigits
        ? users.filter(u => u.twilio_phone_number && u.twilio_phone_number.replace(/\D/g, '').slice(-10) === calledDigits)
        : [];

      // Look up caller by phone number to link to company/contact
      const fromDigits = rawFrom.replace(/\D/g, '').slice(-10);
      let matchedCompanyId = null;
      let matchedContactId = null;
      if (fromDigits.length >= 7) {
        try {
          const { rows: companies } = await pool.query(
            `SELECT id FROM companies WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE $1 AND deleted_at IS NULL LIMIT 1`,
            [`%${fromDigits}`]
          );
          if (companies[0]) matchedCompanyId = companies[0].id;
          const { rows: contacts } = await pool.query(
            `SELECT id, company_id FROM contacts WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE $1 AND deleted_at IS NULL LIMIT 1`,
            [`%${fromDigits}`]
          );
          if (contacts[0]) {
            matchedContactId = contacts[0].id;
            if (!matchedCompanyId) matchedCompanyId = contacts[0].company_id;
          }
        } catch (err) { console.error('[twilio] caller lookup error:', err.message); }
      }

      // Create a call log for the inbound call
      const targetUserId = targetUsers.length === 1 ? targetUsers[0].id : null;
      insertCallLog({
        company_id: matchedCompanyId,
        contact_id: matchedContactId,
        user_id: targetUserId,
        direction: 'inbound',
        status: 'ringing',
        call_sid: callSid,
        from_number: rawFrom,
        mock: false,
      }).catch((err) => console.error('[twilio] Failed to create inbound call_log:', err.message));

      const vmCallback = publicUrl ? `${publicUrl}/api/twilio/voicemail-status` : '/api/twilio/voicemail-status';

      if (!targetUsers.length) {
        // No user assigned to this number — send straight to voicemail
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, no one is available to take your call. Please leave a message after the beep.</Say>
  <Record maxLength="120" recordingStatusCallback="${vmCallback}" recordingStatusCallbackEvent="completed" />
</Response>`;
        return res.set('Content-Type', 'text/xml').send(twiml);
      }
      const clientTags = targetUsers.map(u => `    <Client><Identity>${u.id}</Identity></Client>`).join('\n');
      // action URL handles what happens when Dial ends (no answer → voicemail)
      const dialAction = publicUrl ? `${publicUrl}/api/twilio/dial-complete` : '/api/twilio/dial-complete';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer"
        recordingStatusCallback="${recordingCb}"
        recordingStatusCallbackEvent="completed"
        action="${dialAction}"
        callerId="${rawFrom}"
        timeout="25">
${clientTags}
  </Dial>
</Response>`;
      return res.set('Content-Type', 'text/xml').send(twiml);
    }

    // Outbound call — dial the external number
    const to = toDigits.length === 10 ? '+1' + toDigits : toDigits.length === 11 && toDigits[0] === '1' ? '+' + toDigits : rawTo;
    const callLogId = req.body?.callLogId || req.query.callLogId || '';

    if (callLogId && callSid) {
      updateCallLog(callLogId, { call_sid: callSid, status: 'ringing' }).catch((err) => {
        console.error('[twilio/voice] Failed to store call_sid:', err.message);
      });
    }

    // Use the caller's per-user Twilio number if set, otherwise global
    const fromIdentity = rawFrom.startsWith('client:') ? rawFrom.replace('client:', '') : '';
    let outboundCallerId = process.env.TWILIO_PHONE_NUMBER || '';
    if (fromIdentity) {
      const callingUser = users || await listUsers();
      const u = (Array.isArray(callingUser) ? callingUser : []).find(x => x.id === fromIdentity);
      if (u?.twilio_phone_number) outboundCallerId = u.twilio_phone_number;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer"
        recordingStatusCallback="${recordingCb}"
        recordingStatusCallbackEvent="completed"
        callerId="${outboundCallerId}">
    <Number>${to}</Number>
  </Dial>
</Response>`;
    res.set('Content-Type', 'text/xml').send(twiml);
  });

  // POST /api/twilio/dial-complete — called when inbound Dial ends (no answer, busy, etc.)
  // If nobody answered, offer voicemail
  app.post('/api/twilio/dial-complete', express_urlencoded(), async (req, res) => {
    const dialStatus = req.body?.DialCallStatus || req.body?.DialStatus || '';
    const callSid = req.body?.CallSid || '';
    const publicUrl = process.env.PUBLIC_URL || '';
    const vmCallback = publicUrl ? `${publicUrl}/api/twilio/voicemail-status` : '/api/twilio/voicemail-status';

    // Update call log status
    if (callSid) {
      const call = await getCallLogBySid(callSid);
      if (call && ['no-answer', 'busy', 'failed', 'canceled'].includes(dialStatus)) {
        await updateCallLog(call.id, { status: 'missed' });
      }
    }

    if (['completed', 'answered'].includes(dialStatus)) {
      // Call was answered — just hang up cleanly
      return res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    // Nobody answered — offer voicemail
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, no one is available right now. Please leave a message after the beep.</Say>
  <Record maxLength="120" recordingStatusCallback="${vmCallback}" recordingStatusCallbackEvent="completed" />
</Response>`;
    res.set('Content-Type', 'text/xml').send(twiml);
  });

  // POST /api/twilio/voicemail-status — voicemail recording is ready
  app.post('/api/twilio/voicemail-status', express_urlencoded(), async (req, res) => {
    const callSid = req.body?.CallSid || '';
    const recordingUrl = req.body?.RecordingUrl || '';
    if (!callSid || !recordingUrl) return res.status(200).end();
    const call = await getCallLogBySid(callSid);
    if (call) {
      await updateCallLog(call.id, {
        voicemail_url: recordingUrl,
        recording_url: recordingUrl,
        status: 'voicemail',
      });
      // Transcribe the voicemail async
      transcribeFromRecording(call.id).catch((err) => {
        console.error('[twilio] Voicemail transcription failed:', err.message);
      });
    }
    res.status(200).end();
  });

  // POST /api/twilio/recording-status — recording is ready
  app.post('/api/twilio/recording-status', express_urlencoded(), async (req, res) => {
    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl;
    const recordingSid = req.body.RecordingSid;
    if (!callSid || !recordingUrl) return res.status(200).end();
    const call = await getCallLogBySid(callSid);
    if (!call) return res.status(200).end();
    await updateCallLog(call.id, { recording_url: recordingUrl, recording_sid: recordingSid });
    // Transcribe async — don't block the webhook response
    transcribeFromRecording(call.id).catch((err) => {
      console.error('[twilio] Transcription failed:', err.message);
    });
    res.status(200).end();
  });

  // POST /api/twilio/call-status — status transitions from Twilio
  app.post('/api/twilio/call-status', express_urlencoded(), async (req, res) => {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    const duration = Number(req.body.CallDuration);
    if (!callSid) return res.status(200).end();
    const call = await getCallLogBySid(callSid);
    if (!call) return res.status(200).end();
    await updateCallLog(call.id, {
      status: status || call.status,
      duration_sec: Number.isFinite(duration) ? duration : call.duration_sec,
    });
    // On 'no-answer' / 'busy' / 'failed' with no recording, still run analysis
    // so debrief questions exist (will be No Answer).
    if (['no-answer', 'busy', 'failed'].includes(status) && !call.recording_url) {
      transcribeFromRecording(call.id).catch((err) => {
        console.error('[twilio] Analysis failed:', err.message);
      });
    }
    res.status(200).end();
  });

  // GET /api/twilio/caller-lookup — match a phone number to a company/contact
  app.get('/api/twilio/caller-lookup', requireUser, async (req, res) => {
    const from = (req.query.from || '').replace(/\D/g, '');
    if (from.length < 7) return res.json({ company: null, contact: null });
    // Normalize: try last 10 digits for matching
    const last10 = from.slice(-10);
    const patterns = [`%${last10}%`];
    try {
      // Check companies first
      const { rows: companies } = await pool.query(
        `SELECT id, name, city, state, phone, owner, score, tier, pipeline_stage
         FROM companies WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE $1 AND deleted_at IS NULL LIMIT 1`,
        patterns
      );
      // Check contacts
      const { rows: contacts } = await pool.query(
        `SELECT ct.id, ct.name, ct.title, ct.phone, ct.company_id,
                c.name AS company_name, c.city AS company_city, c.state AS company_state
         FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id
         WHERE REGEXP_REPLACE(ct.phone, '\\D', '', 'g') LIKE $1 AND ct.deleted_at IS NULL LIMIT 1`,
        patterns
      );
      res.json({
        company: companies[0] || null,
        contact: contacts[0] || null,
      });
    } catch (err) {
      console.error('[twilio] caller-lookup error:', err.message);
      res.json({ company: null, contact: null });
    }
  });

  // POST /api/twilio/mock-complete — called by frontend when the mock "call" ends
  app.post('/api/twilio/mock-complete', requireUser, async (req, res) => {
    if (!isMockMode()) return res.status(400).json({ error: 'Not in mock mode' });
    const { call_log_id, duration_sec, transcript_id } = req.body || {};
    if (!call_log_id) return res.status(400).json({ error: 'call_log_id required' });
    const call = await getCallLog(call_log_id);
    if (!call) return res.status(404).json({ error: 'call_log not found' });
    if (call.user_id && call.user_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'Not your call' });
    }
    const company = await getCompany(call.company_id);
    const ctx = {
      company: company?.name || 'the company',
      owner: company?.owner || 'the owner',
      state: company?.state || 'the region',
    };
    const pick = transcript_id
      ? mockTranscriptById(transcript_id, ctx)
      : pickMockTranscript(ctx);
    const dur = Number(duration_sec) || pick.duration_sec;

    // Kick off async so the frontend can show a "Processing…" spinner + poll.
    attachMockTranscript(call_log_id, pick.transcript, dur).catch((err) => {
      console.error('[twilio/mock] analysis failed:', err.message);
    });

    res.json({ ok: true, call_log_id, duration_sec: dur, transcript_id: pick.id });
  });

  // ─── SMS ────────────────────────────────────────────────────────────────────

  // Send a text message
  app.post('/api/sms/send', requireUser, async (req, res) => {
    const { company_id, contact_id, to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });
    if (!body.trim()) return res.status(400).json({ error: 'Message body cannot be empty' });

    const from = process.env.TWILIO_PHONE_NUMBER;
    const mock = isMockMode();

    let twilioSid = null;
    if (!mock) {
      if (!from) return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER not configured' });
      try {
        const msg = await twilioClient().messages.create({
          to,
          from,
          body: body.trim(),
        });
        twilioSid = msg.sid;
      } catch (err) {
        return res.status(500).json({ error: 'SMS send failed', details: err.message });
      }
    } else {
      twilioSid = mockSid('SM');
    }

    const msgId = await insertMessage({
      company_id: company_id || null,
      contact_id: contact_id || null,
      user_id: req.currentUser.id,
      direction: 'outbound',
      to_number: to,
      from_number: from || '+10000000000',
      body: body.trim(),
      status: mock ? 'mock' : 'sent',
      twilio_sid: twilioSid,
    });

    // Log activity
    if (company_id) {
      insertActivity({
        company_id,
        contact_id: contact_id || null,
        user_id: req.currentUser.id,
        type: 'sms',
        summary: `Sent SMS: "${body.trim().slice(0, 80)}${body.trim().length > 80 ? '...' : ''}"`,
      }).catch(() => {});
    }

    emit({ type: 'sms_sent', message_id: msgId, company_id });
    res.json({ ok: true, id: msgId, mock, twilio_sid: twilioSid });
  });

  // Get message thread for a company
  app.get('/api/companies/:id/messages', requireUser, async (req, res) => {
    const messages = await listMessages(req.params.id, Number(req.query.limit) || 50);
    res.json({ messages });
  });

  // Inbound SMS webhook (Twilio sends incoming texts here)
  app.post('/api/twilio/sms-inbound', express_urlencoded(), async (req, res) => {
    const from = req.body.From || '';
    const to = req.body.To || '';
    const body = req.body.Body || '';
    const sid = req.body.MessageSid || '';

    // Try to match incoming number to a company by phone
    const { pool } = require('./db');
    const cleaned = from.replace(/\D/g, '').slice(-10);
    const { rows } = await pool.query(
      `SELECT id, name FROM companies WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $1 LIMIT 1`,
      [cleaned]
    );
    const company = rows[0] || null;

    await insertMessage({
      company_id: company?.id || null,
      direction: 'inbound',
      to_number: to,
      from_number: from,
      body,
      status: 'received',
      twilio_sid: sid,
    });

    if (company) {
      emit({ type: 'sms_received', company_id: company.id, from, body: body.slice(0, 100) });
    }

    // Respond with empty TwiML (acknowledge receipt, don't auto-reply)
    res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
}

// Twilio webhooks send urlencoded bodies; express.json won't parse them.
// Use a per-route urlencoded parser instead of installing app-wide.
function express_urlencoded() {
  // eslint-disable-next-line global-require
  const express = require('express');
  return express.urlencoded({ extended: false });
}

module.exports = { registerRoutes, isMockMode };
