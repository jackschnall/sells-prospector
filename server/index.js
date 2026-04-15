require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  initSchema,
  pool,
  execute,
  listCompanies,
  getCompany,
  insertCompany,
  updateCompanyResearch,
  normalizeName,
  setConfig,
  getConfig,
  setCompanyOverride,
  markOutreach,
  setOutreachStatus,
  addNote,
  getNotes,
  rollupStats,
  markCrmKnown,
  // Pipeline
  PIPELINE_STAGES,
  CLOSED_LOST_REASONS,
  updatePipelineStage,
  formatStage,
  getPipelineBoard,
  // Contacts
  listContacts,
  getContact,
  insertContact,
  updateContact,
  deleteContact,
  // Activities
  listActivities,
  insertActivity,
  // Users
  getUserByToken,
  getUserById,
  getUserByEmail,
  createUser,
  listUsers,
  listUsersFull,
  updateUser,
  clearInviteToken,
  // Call logs (Phase 2)
  insertCallLog,
  updateCallLog,
  getCallLog,
  getCallLogBySid,
  listCallLogsByCompany,
  listPendingDebriefs,
  // Calendar (Phase 2)
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  listCalendarEventsForMonth,
  // Queue skips (Phase 2)
  insertQueueSkip,
  listQueueSkipsForToday,
  // User config (Phase 2)
  getUserConfig,
  setUserConfig,
  // User stats (Phase 2)
  getUserStats,
} = require('./db');
const { promoteToAdminIfFirstUser, requireUser, requireAdmin, isAdmin } = require('./auth');
const { registerRoutes: registerTwilioRoutes, isMockMode: isTwilioMockMode } = require('./twilio');
const { saveDraft: saveDebriefDraft, submitDebrief, MIN_ANSWER_LEN } = require('./debrief');
const { buildQueue } = require('./call-queue');
const { parseCsvBuffer, parseXlsxBuffer, companiesToCsv } = require('./csv');
const { startRun, stopRun, getRunState, addListener, removeListener, emit } = require('./agent');
const sf = require('./salesforce');
const { providerStatus } = require('./providers');
const markets = require('./markets');
const marketIntel = require('./market-intel');
const { buildWorkbook, workbookToBuffer, buildFilename } = require('./xlsx-export');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'sells-prospector-dev-secret'));
// Never cache the HTML shell so new script-tag versions are always fetched.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Optional user context ----------
app.use(async (req, res, next) => {
  const userId = req.signedCookies?.userId;
  if (userId) {
    req.currentUser = await getUserById(userId);
  }
  next();
});

// ---------- Utilities ----------
function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s; // JSONB already parsed by pg
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- Status ----------
app.get('/api/status', async (req, res) => {
  res.json({
    mockMode: process.env.MOCK_MODE === '1',
    apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
    stats: await rollupStats(),
    run: getRunState(),
    thesis: await getConfig('thesis', {}),
    crmKnownCount: (await sf.getPastedKnownNames() || []).length,
    providers: providerStatus(),
  });
});

// ---------- Upload CSV / XLSX ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const filename = (req.file.originalname || '').toLowerCase();
  const isXlsx = filename.endsWith('.xlsx') || filename.endsWith('.xls');
  let rows;
  try {
    rows = isXlsx ? parseXlsxBuffer(req.file.buffer) : parseCsvBuffer(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No valid company rows found in CSV.' });
  }

  let inserted = 0;
  for (const row of rows) {
    try {
      await insertCompany(row);
      inserted++;
    } catch (err) {
      console.error('Insert error for', row.name, err.message);
    }
  }

  const known = await sf.getPastedKnownNames();
  if (known.length) await markCrmKnown(known);

  res.json({
    ok: true,
    parsed: rows.length,
    inserted,
    stats: await rollupStats(),
  });
});

// ---------- Companies ----------
app.get('/api/companies', async (req, res) => {
  const { tier, crm_known: crmKnown, search, sort, state: stateFilter, outreach: outreachStatus, pipeline_stage: pipelineStage } = req.query;
  const rows = await listCompanies({ tier, crmKnown, search, sort, stateFilter, outreachStatus, pipelineStage });
  const slim = rows.map(({ raw_research, ...rest }) => rest);
  res.json({ companies: slim, stats: await rollupStats() });
});

app.get('/api/companies/:id', async (req, res) => {
  const row = await getCompany(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    company: row,
    signals: safeJson(row.signals_json),
    flags: safeJson(row.flags_json),
    sources: safeJson(row.sources_json) || [],
    notes: await getNotes(row.id),
    contacts: await listContacts(row.id),
    activities: await listActivities(row.id),
  });
});

app.post('/api/companies/:id/override', async (req, res) => {
  const { override } = req.body || {};
  await setCompanyOverride(req.params.id, !!override);
  res.json({ ok: true });
});

app.post('/api/companies/:id/outreach', async (req, res) => {
  const { outreach_status } = req.body || {};
  const valid = ['no_contact', 'initial_contact', 'relationship'];
  if (!valid.includes(outreach_status)) return res.status(400).json({ error: 'Invalid outreach_status' });
  await setOutreachStatus(req.params.id, outreach_status);
  res.json({ ok: true });
});

app.post('/api/companies/:id/notes', async (req, res) => {
  const { note } = req.body || {};
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Empty note' });
  const saved = await addNote(req.params.id, String(note).trim());
  res.json({ ok: true, note: saved });
});

app.post('/api/companies/:id/salesforce-push', async (req, res) => {
  const row = await getCompany(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(sf.pushStub(row));
});

// ---------- Thesis / settings ----------
app.post('/api/thesis', async (req, res) => {
  const body = req.body || {};
  const geography = String(body.geography || '').trim();
  const thesis = { geography };
  await setConfig('thesis', thesis);
  res.json({ ok: true, thesis });
});

// ---------- Salesforce (paste list) ----------
app.post('/api/salesforce/known-names', async (req, res) => {
  const { names } = req.body || {};
  const result = await sf.setPastedKnownNames(names);
  res.json({ ok: true, ...result, stats: await rollupStats() });
});

app.get('/api/salesforce/known-names', async (req, res) => {
  res.json({ names: await sf.getPastedKnownNames() });
});

// ---------- Markets ----------
app.get('/api/markets', async (req, res) => {
  res.json({ markets: await markets.listAll() });
});

// ---------- Market Intelligence ----------
app.get('/api/market-intel', async (req, res) => {
  const rankings = await marketIntel.getRankings();
  res.json({ markets: rankings });
});

app.post('/api/market-intel/seed', async (req, res) => {
  const results = await marketIntel.seedMarkets();
  res.json({ ok: true, count: results.length });
});

// ---------- Run control ----------
app.post('/api/run', (req, res) => {
  const result = startRun();
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

app.post('/api/run/stop', (req, res) => {
  const result = stopRun();
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// SSE progress stream
app.get('/api/run/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  addListener(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {}
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    removeListener(res);
  });
});

// ---------- Claude Code event bridge ----------
app.post('/api/_cc-event', (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'Missing event type' });
  emit(event);
  res.json({ ok: true });
});

// ---------- API key auth (for external write endpoints) ----------
function requireApiKey(req, res, next) {
  const key = process.env.API_KEY;
  if (!key) return next();
  if (req.headers['x-api-key'] === key) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ---------- External research injection ----------
app.post('/api/companies/:id/research', requireApiKey, async (req, res) => {
  const company = await getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const data = { ...req.body };

  // Auto-stringify JSON fields if they're objects
  for (const key of ['signals_json', 'flags_json', 'sources_json', 'raw_research']) {
    if (data[key] && typeof data[key] !== 'string') {
      data[key] = JSON.stringify(data[key]);
    }
  }

  data.status = data.status || 'done';
  data.owner = data.owner || null;
  data.phone = data.phone || null;
  data.email = data.email || null;
  data.address = data.address || null;
  data.linkedin = data.linkedin || null;
  data.score = data.score ?? null;
  data.tier = data.tier || null;
  data.signals_json = data.signals_json || null;
  data.flags_json = data.flags_json || null;
  data.summary = data.summary || null;
  data.outreach_angle = data.outreach_angle || null;
  data.sources_json = data.sources_json || null;
  data.raw_research = data.raw_research || null;

  await updateCompanyResearch(req.params.id, data);

  if (data.owner) {
    const existingContacts = await listContacts(req.params.id);
    if (existingContacts.length === 0) {
      await insertContact({
        company_id: req.params.id,
        name: data.owner,
        phone: data.phone || null,
        email: data.email || null,
        linkedin: data.linkedin || null,
        is_primary: 1,
        source: 'research',
      });
    }
  }

  const stats = await rollupStats();
  emit({ type: 'company_done', id: company.id, name: company.name, score: data.score, tier: data.tier });
  emit({ type: 'progress', done: stats.researched, total: stats.total });

  res.json({ ok: true, id: company.id, name: company.name, score: data.score, tier: data.tier });
});

// ---------- External company discovery ----------
app.post('/api/discover', requireApiKey, async (req, res) => {
  const { nanoid } = require('nanoid');
  let candidates = req.body.candidates || req.body;
  if (!Array.isArray(candidates)) candidates = [candidates];

  const results = [];
  for (const c of candidates) {
    if (!c.name) { results.push({ error: 'missing name' }); continue; }
    const id = nanoid();
    const name_key = normalizeName(c.name);
    if (!name_key) { results.push({ error: 'empty name_key', name: c.name }); continue; }
    try {
      await insertCompany({
        id,
        name: c.name,
        name_key,
        city: c.city || null,
        state: c.state || null,
        phone: c.phone || null,
        website: c.website || null,
        owner: c.owner || null,
        email: c.email || null,
        address: c.address || null,
        crm_known: false,
      });
      results.push({ ok: true, id, name: c.name, name_key });
    } catch (err) {
      const existing = await listCompanies({ search: c.name });
      const match = existing.find(r => r.name_key === name_key);
      results.push({ ok: true, id: match ? match.id : 'existing', name: c.name, note: 'already exists' });
    }
  }

  const stats = await rollupStats();
  emit({ type: 'queue', total: stats.total });
  res.json({ ok: true, results, stats });
});

// ---------- Auth (invite link; Phase 3 will swap to Microsoft SSO) ----------
function userPublic(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'analyst',
    assigned_verticals: safeJson(user.assigned_verticals) || [],
    assigned_territories: safeJson(user.assigned_territories) || [],
  };
}

app.get('/api/auth/me', (req, res) => {
  if (!req.currentUser) return res.json({ user: null });
  res.json({ user: userPublic(req.currentUser) });
});

app.post('/api/auth/accept', async (req, res) => {
  const { token, name, email } = req.body || {};
  if (!token || !name || !email) return res.status(400).json({ error: 'Missing token, name, or email' });
  const invite = await getUserByToken(token);
  if (!invite) {
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const user = await createUser({ name, email, invite_token: null });
    await promoteToAdminIfFirstUser(user.id);
    res.cookie('userId', user.id, { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    return res.json({ ok: true, user: userPublic(await getUserById(user.id)) });
  }
  const existing = await getUserByEmail(email);
  if (existing) {
    res.cookie('userId', existing.id, { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    await clearInviteToken(existing.id);
    await promoteToAdminIfFirstUser(existing.id);
    return res.json({ ok: true, user: userPublic(await getUserById(existing.id)) });
  }
  const user = await createUser({ name, email });
  await clearInviteToken(invite.id);
  await promoteToAdminIfFirstUser(user.id);
  res.cookie('userId', user.id, { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, user: userPublic(await getUserById(user.id)) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const user = await getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await promoteToAdminIfFirstUser(user.id);
  res.cookie('userId', user.id, { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, user: userPublic(await getUserById(user.id)) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('userId');
  res.json({ ok: true });
});

app.post('/api/auth/invite', async (req, res) => {
  const { nanoid } = require('nanoid');
  const token = nanoid(32);
  const id = nanoid();
  await execute(
    'INSERT INTO users (id, name, email, invite_token) VALUES ($1, $2, $3, $4)',
    [id, 'Invited', `pending-${token}@invite`, token]
  );
  const url = `${req.protocol}://${req.get('host')}/?invite=${token}`;
  res.json({ ok: true, token, url });
});

app.get('/api/auth/users', async (req, res) => {
  res.json({ users: await listUsers() });
});

// ---------- /api/me (current user — Phase 2) ----------
app.get('/api/me/assignments', requireUser, async (req, res) => {
  const u = req.currentUser;
  const cooldown = await getUserConfig(u.id, 'queue_cooldown_days', 7);
  res.json({
    user: userPublic(u),
    queue_cooldown_days: Number(cooldown) || 7,
  });
});

app.put('/api/me/queue-settings', requireUser, async (req, res) => {
  const days = Number(req.body?.cooldown_days);
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return res.status(400).json({ error: 'cooldown_days must be a number between 1 and 30' });
  }
  await setUserConfig(req.currentUser.id, 'queue_cooldown_days', days);
  res.json({ ok: true, cooldown_days: days });
});

app.get('/api/me/stats', requireUser, async (req, res) => {
  const range = ['today', 'week', 'all'].includes(req.query.range) ? req.query.range : 'today';
  try {
    const stats = await getUserStats(req.currentUser.id, range);
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[me/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin (Phase 2) ----------
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await listUsersFull();
  res.json({
    users: users.map((u) => ({
      ...userPublic(u),
      invite_pending: !!u.invite_token,
      created_at: u.created_at,
    })),
  });
});

app.put('/api/admin/users/:id/assignments', requireAdmin, async (req, res) => {
  const { verticals, territories } = req.body || {};
  if (!Array.isArray(verticals) || !Array.isArray(territories)) {
    return res.status(400).json({ error: 'verticals and territories must be arrays' });
  }
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await updateUser(user.id, {
    assigned_verticals: verticals,
    assigned_territories: territories.map((t) => String(t).toUpperCase()),
  });
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'analyst'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'analyst'" });
  }
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Prevent demoting the last admin
  if (user.role === 'admin' && role === 'analyst') {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
    if ((rows[0]?.n ?? 0) <= 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin' });
    }
  }
  await updateUser(user.id, { role });
  res.json({ ok: true });
});

// ---------- Telephony (Twilio, mock-first) ----------
registerTwilioRoutes(app);

// ---------- Calls (history, debrief) ----------
function callPublic(call) {
  if (!call) return null;
  return {
    ...call,
    ai_summary: safeJson(call.ai_summary),
    debrief_questions: safeJson(call.debrief_questions) || [],
    debrief_qa: safeJson(call.debrief_qa) || [],
    debrief_draft: safeJson(call.debrief_draft) || null,
  };
}

app.get('/api/companies/:id/calls', requireUser, async (req, res) => {
  const rows = await listCallLogsByCompany(req.params.id);
  res.json({ calls: rows.map(callPublic) });
});

app.get('/api/calls/pending-debrief', requireUser, async (req, res) => {
  const rows = await listPendingDebriefs(req.currentUser.id);
  res.json({ calls: rows.map(callPublic) });
});

app.get('/api/calls/:id', requireUser, async (req, res) => {
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  if (call.user_id && call.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  res.json({ call: callPublic(call) });
});

app.get('/api/calls/:id/debrief-questions', requireUser, async (req, res) => {
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  if (call.user_id && call.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  const questions = safeJson(call.debrief_questions) || [];
  const draft = safeJson(call.debrief_draft) || null;
  const ready = Array.isArray(questions) && questions.length >= 3;
  res.json({
    ready,
    questions,
    draft,
    status: call.debrief_status || 'pending',
    sentiment: call.sentiment || null,
    ai_summary: safeJson(call.ai_summary) || null,
    next_action: call.next_action || null,
    scheduled_callback_date: call.scheduled_callback_date || null,
    min_answer_len: MIN_ANSWER_LEN,
  });
});

app.post('/api/calls/:id/debrief-draft', requireUser, async (req, res) => {
  try {
    const answers = req.body?.answers;
    const result = await saveDebriefDraft(req.params.id, req.currentUser.id, answers);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message, details: err.details });
  }
});

app.post('/api/calls/:id/debrief', requireUser, async (req, res) => {
  try {
    const answers = req.body?.answers;
    const result = await submitDebrief(req.params.id, req.currentUser.id, answers);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message, details: err.details });
  }
});

// ---------- Call Queue ----------
app.get('/api/queue', requireUser, async (req, res) => {
  try {
    const pins = req.query.pins ? String(req.query.pins).split(',').filter(Boolean) : [];
    const limit = Number(req.query.limit) || 50;
    const result = await buildQueue(req.currentUser, { pins, limit });
    res.json(result);
  } catch (err) {
    console.error('[queue] build failed:', err);
    res.status(500).json({ error: 'Failed to build queue', details: err.message });
  }
});

app.post('/api/queue/skip', requireUser, async (req, res) => {
  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  await insertQueueSkip(req.currentUser.id, company_id);
  emit({ type: 'queue_changed', user_id: req.currentUser.id });
  res.json({ ok: true });
});

// ---------- Calendar ----------
app.get('/api/calendar', requireUser, async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year and month query params required (month 1-12)' });
  }
  const territories = safeJson(req.currentUser.assigned_territories) || [];
  const events = await listCalendarEventsForMonth({
    year,
    month,
    userId: req.currentUser.id,
    isAdmin: req.currentUser.role === 'admin',
    territories,
  });
  res.json({ events });
});

app.post('/api/calendar', requireUser, async (req, res) => {
  const { title, description, company_id, contact_id, starts_at, event_type } = req.body || {};
  if (!title || !starts_at) return res.status(400).json({ error: 'title and starts_at required' });
  const id = await insertCalendarEvent({
    company_id: company_id || null,
    contact_id: contact_id || null,
    user_id: req.currentUser.id,
    title,
    description: description || null,
    event_type: event_type || 'meeting',
    starts_at,
    source: 'manual',
  });
  emit({ type: 'calendar_event_created', event_id: id, company_id: company_id || null });
  res.json({ ok: true, id });
});

app.put('/api/calendar/:id', requireUser, async (req, res) => {
  const ev = await getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.user_id && ev.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not yours to edit' });
  }
  const { title, description, starts_at, company_id, contact_id } = req.body || {};
  await updateCalendarEvent(req.params.id, {
    title: title ?? ev.title,
    description: description ?? ev.description,
    starts_at: starts_at ?? ev.starts_at,
    company_id: company_id ?? ev.company_id,
    contact_id: contact_id ?? ev.contact_id,
  });
  res.json({ ok: true });
});

app.delete('/api/calendar/:id', requireUser, async (req, res) => {
  const ev = await getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.user_id && ev.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not yours to delete' });
  }
  await deleteCalendarEvent(req.params.id);
  res.json({ ok: true });
});

app.post('/api/calendar/:id/complete', requireUser, async (req, res) => {
  const ev = await getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.user_id && ev.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not yours to update' });
  }
  await updateCalendarEvent(req.params.id, { completed: true });
  res.json({ ok: true });
});

// ---------- Pipeline ----------
app.get('/api/pipeline/board', async (req, res) => {
  res.json({ board: await getPipelineBoard(), stages: PIPELINE_STAGES });
});

app.get('/api/pipeline/stages', (req, res) => {
  res.json({
    stages: PIPELINE_STAGES.map(s => ({ key: s, label: formatStage(s) })),
    closedLostReasons: CLOSED_LOST_REASONS,
  });
});

app.post('/api/companies/:id/pipeline', async (req, res) => {
  const { stage, closed_lost_reason } = req.body || {};
  if (!stage || !PIPELINE_STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Invalid pipeline stage' });
  }
  if (stage === 'closed_lost' && (!closed_lost_reason || !CLOSED_LOST_REASONS.includes(closed_lost_reason))) {
    return res.status(400).json({ error: 'Closed/Lost requires a valid reason: ' + CLOSED_LOST_REASONS.join(', ') });
  }
  const userId = req.currentUser?.id || null;
  await updatePipelineStage(req.params.id, stage, closed_lost_reason || null, userId);
  emit({ type: 'pipeline_change', id: req.params.id, stage });
  res.json({ ok: true });
});

// ---------- Contacts ----------
app.get('/api/companies/:id/contacts', async (req, res) => {
  res.json({ contacts: await listContacts(req.params.id) });
});

app.post('/api/companies/:id/contacts', async (req, res) => {
  const { name, title, phone, email, linkedin, is_primary, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Contact name required' });
  const contact = await insertContact({
    company_id: req.params.id, name, title, phone, email, linkedin, is_primary, notes,
  });
  emit({ type: 'contact_added', company_id: req.params.id });
  res.json({ ok: true, contact });
});

app.put('/api/contacts/:id', async (req, res) => {
  const existing = await getContact(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  await updateContact(req.params.id, req.body || {});
  emit({ type: 'contact_updated', company_id: existing.company_id });
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', async (req, res) => {
  const existing = await getContact(req.params.id);
  await deleteContact(req.params.id);
  emit({ type: 'contact_deleted', company_id: existing?.company_id });
  res.json({ ok: true });
});

// ---------- Activities ----------
app.get('/api/companies/:id/activities', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json({ activities: await listActivities(req.params.id, { limit, offset }) });
});

app.post('/api/companies/:id/activities', async (req, res) => {
  const { type, summary, details, contact_id } = req.body || {};
  const validTypes = ['note', 'call', 'email', 'meeting', 'stage_change', 'research'];
  if (!type || !validTypes.includes(type)) return res.status(400).json({ error: 'Invalid activity type' });
  if (!summary) return res.status(400).json({ error: 'Summary required' });
  const activity = await insertActivity({
    company_id: req.params.id,
    contact_id: contact_id || null,
    user_id: req.currentUser?.id || null,
    type, summary, details,
  });
  emit({ type: 'activity_added', company_id: req.params.id });
  res.json({ ok: true, activity });
});

// ---------- Export ----------
app.get('/api/export.csv', async (req, res) => {
  const rows = await listCompanies({ sort: 'score_desc' });
  const csv = companiesToCsv(rows);
  res.set({
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="sells-prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(csv);
});

app.get('/api/export.xlsx', async (req, res) => {
  const rows = await listCompanies({ sort: 'score_desc' });
  const geography = (await getConfig('thesis', {}) || {}).geography || '';
  try {
    const wb = buildWorkbook(rows, geography);
    const buf = workbookToBuffer(wb);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${buildFilename(geography)}"`,
    });
    res.send(buf);
  } catch (err) {
    console.error('[export.xlsx] Failed to build workbook:', err);
    res.status(500).json({ error: 'Failed to build workbook.' });
  }
});

// ---------- Tearsheet ----------
app.get('/tearsheet/:id', async (req, res) => {
  const row = await getCompany(req.params.id);
  if (!row) return res.status(404).send('Not found');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'public', 'tearsheet.html'), 'utf8');
  const data = {
    company: row,
    signals: safeJson(row.signals_json) || {},
    flags: safeJson(row.flags_json) || { hard_stops: [], yellow_flags: [] },
    sources: safeJson(row.sources_json) || [],
    mockMode: process.env.MOCK_MODE === '1',
  };
  const filled = tpl.replace(
    '/*__DATA__*/',
    `window.__TEARSHEET_DATA__ = ${JSON.stringify(data)};`
  );
  res.set('Content-Type', 'text/html');
  res.send(filled);
});

// ---------- Health check (replaces WAL checkpoint) ----------
app.post('/api/_checkpoint', (req, res) => {
  // No-op for Postgres (was SQLite WAL checkpoint)
  res.json({ ok: true });
});

// ---------- Start ----------
async function startServer() {
  // Initialize schema
  await initSchema();

  // Auto-seed market intelligence if empty
  const { rows: [{ n: marketCount }] } = await pool.query('SELECT COUNT(*) AS n FROM markets');
  if (Number(marketCount) === 0) {
    console.log('Seeding market intelligence data…');
    await marketIntel.seedMarkets();
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    const mock = process.env.MOCK_MODE === '1';
    const line = `Sells M&A Prospector listening on http://localhost:${PORT}`;
    console.log('\x1b[36m%s\x1b[0m', line);
    if (mock) {
      console.log('\x1b[33m%s\x1b[0m', '  MOCK_MODE enabled — no real API calls will be made.');
    } else if (!process.env.ANTHROPIC_API_KEY) {
      console.log(
        '\x1b[33m%s\x1b[0m',
        '  ANTHROPIC_API_KEY not set. Set it in .env, or run with MOCK_MODE=1 for demo mode.'
      );
    } else {
      console.log('\x1b[32m%s\x1b[0m', '  Live research mode — using Claude Opus 4.6 + Sonnet 4.6.');
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
