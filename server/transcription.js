// ─────────────────────────────────────────────────────────────────────────────
// Transcription — Whisper wrapper with mock-mode fallback.
//
// In mock mode: transcript is supplied directly (from mock-transcripts.js).
// In live mode: download recording_url from Twilio (basic-auth), POST to
// OpenAI Whisper, save transcript, then trigger call-analyzer.
// ─────────────────────────────────────────────────────────────────────────────

const { getCallLog, updateCallLog } = require('./db');
const { analyzeCall } = require('./call-analyzer');

/**
 * Save a pre-computed transcript (mock mode) and kick off analysis.
 * Used by the mock-complete route.
 */
async function attachMockTranscript(callLogId, transcript, durationSec) {
  await updateCallLog(callLogId, {
    transcript,
    duration_sec: Number.isFinite(durationSec) ? durationSec : null,
    status: 'completed',
  });
  return analyzeCall(callLogId);
}

/**
 * Live-Twilio path: download the recording, transcribe via Whisper, save.
 * Only called when we have a recording_url on the call_log.
 */
async function transcribeFromRecording(callLogId) {
  const call = await getCallLog(callLogId);
  if (!call) throw new Error(`call_log not found: ${callLogId}`);
  if (call.mock) return analyzeCall(callLogId); // mock path already stored a transcript

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[transcription] OPENAI_API_KEY missing — skipping Whisper, running analysis on empty transcript.');
    await updateCallLog(callLogId, { transcript: '', status: 'completed' });
    return analyzeCall(callLogId);
  }

  const recordingUrl = call.recording_url;
  if (!recordingUrl) {
    console.warn('[transcription] No recording_url on call_log', callLogId);
    return analyzeCall(callLogId);
  }

  // Download from Twilio (basic auth via ACCOUNT_SID:AUTH_TOKEN)
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  const audioRes = await fetch(`${recordingUrl}.mp3`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!audioRes.ok) throw new Error(`Twilio recording download failed: ${audioRes.status}`);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // Build multipart form-data manually (Node 18+ has global FormData / Blob).
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'recording.mp3');
  form.append('model', 'whisper-1');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!whisperRes.ok) {
    const errTxt = await whisperRes.text();
    throw new Error(`Whisper API failed: ${whisperRes.status} ${errTxt.slice(0, 200)}`);
  }
  const body = await whisperRes.json();
  const transcript = (body?.text || '').trim();

  await updateCallLog(callLogId, { transcript, status: 'completed' });
  return analyzeCall(callLogId);
}

module.exports = { attachMockTranscript, transcribeFromRecording };
