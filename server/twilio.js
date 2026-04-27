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

const { insertCallLog, getCallLog, updateCallLog, getCallLogBySid, getCompany, insertMessage, listMessages, insertActivity } = require('./db');
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
        incomingAllow: false,
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

  // POST /api/twilio/voice — TwiML webhook Twilio hits when browser SDK connects
  app.post('/api/twilio/voice', express_urlencoded(), async (req, res) => {
    const to = req.body?.To || req.query.to || '';
    const callLogId = req.body?.callLogId || req.query.callLogId || '';
    const callSid = req.body?.CallSid || '';

    // Link this Twilio CallSid to our internal call_log row
    if (callLogId && callSid) {
      updateCallLog(callLogId, { call_sid: callSid, status: 'ringing' }).catch((err) => {
        console.error('[twilio/voice] Failed to store call_sid:', err.message);
      });
    }

    const publicUrl = process.env.PUBLIC_URL || '';
    const recordingCb = publicUrl ? `${publicUrl}/api/twilio/recording-status` : '/api/twilio/recording-status';
    const statusCb = publicUrl ? `${publicUrl}/api/twilio/call-status` : '/api/twilio/call-status';
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer"
        recordingStatusCallback="${recordingCb}"
        recordingStatusCallbackEvent="completed"
        action="${statusCb}">
    <Number statusCallback="${statusCb}" statusCallbackEvent="initiated ringing answered completed">${to}</Number>
  </Dial>
</Response>`;
    res.set('Content-Type', 'text/xml').send(twiml);
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
