require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
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
  listAllContacts,
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
  // Activity log
  listGlobalActivities,
  // Soft-delete / restore
  softDeleteCompany,
  restoreCompany,
  hardDeleteCompany,
  restoreContact,
  hardDeleteContact,
  listDeleted,
  // Campaigns
  listCampaigns,
  getCampaign,
  insertCampaign,
  updateCampaign,
  deleteCampaign,
  listCampaignRecipients,
  addCampaignRecipients,
  removeCampaignRecipient,
  updateCampaignRecipient,
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
  const restrictions = getUserRestrictions(req.currentUser);
  res.json({
    mockMode: process.env.MOCK_MODE === '1',
    apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
    stats: await rollupStats(restrictions),
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

// ---------- User visibility restrictions ----------
function getUserRestrictions(user) {
  if (!user || !user.restricted) return {};
  const v = safeJson(user.assigned_verticals) || [];
  const t = safeJson(user.assigned_territories) || [];
  const out = {};
  if (v.length) out.restrictToVerticals = v;
  if (t.length) out.restrictToTerritories = t;
  return out;
}

// ---------- Companies ----------
app.get('/api/companies', async (req, res) => {
  const { tier, crm_known: crmKnown, search, sort, state: stateFilter, outreach: outreachStatus, pipeline_stage: pipelineStage, industry } = req.query;
  const restrictions = getUserRestrictions(req.currentUser);
  const rows = await listCompanies({ tier, crmKnown, search, sort, stateFilter, outreachStatus, pipelineStage, industry, ...restrictions });
  const slim = rows.map(({ raw_research, ...rest }) => rest);
  res.json({ companies: slim, stats: await rollupStats(restrictions) });
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

// Manual company creation
app.post('/api/companies', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  const name_key = normalizeName(name);
  if (!name_key) return res.status(400).json({ error: 'Invalid company name' });
  // Check for existing company with same name_key
  const existing = await pool.query('SELECT id, name FROM companies WHERE name_key = $1 LIMIT 1', [name_key]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Company already exists', company_id: existing.rows[0].id, company_name: existing.rows[0].name });
  }
  const id = nanoid();
  await insertCompany({
    id, name, name_key,
    city: b.city || null,
    state: b.state ? String(b.state).toUpperCase() : null,
    phone: b.phone || null,
    website: b.website || null,
    owner: b.owner || null,
    email: b.email || null,
    address: b.address || null,
    crm_known: false,
  });
  // Optionally set linkedin via direct query since insertCompany doesn't handle it
  if (b.linkedin) {
    await execute('UPDATE companies SET linkedin = $1 WHERE id = $2', [b.linkedin, id]);
  }
  const created = await getCompany(id);
  emit({ type: 'company_added', company_id: id });
  logAction(id, req.currentUser?.id, `Added company "${b.name}"`);
  res.json({ ok: true, company: created });
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

app.get('/api/companies/:id/notes', async (req, res) => {
  const notes = await getNotes(req.params.id);
  res.json({ notes });
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
    restricted: !!user.restricted,
  };
}

app.get('/api/auth/me', (req, res) => {
  if (!req.currentUser) return res.json({ user: null });
  res.json({ user: userPublic(req.currentUser) });
});

app.post('/api/auth/accept', async (req, res) => {
  const { token, name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const password_hash = await bcrypt.hash(password, 10);
  const user = await createUser({ name, email, password_hash, invite_token: null });
  await promoteToAdminIfFirstUser(user.id);
  const setCookie = { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' };
  res.cookie('userId', user.id, setCookie);
  res.json({ ok: true, user: userPublic(await getUserById(user.id)) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = await getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.password_hash) return res.status(449).json({ error: 'needs_password', message: 'This account needs a password. Please set one now.' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  await promoteToAdminIfFirstUser(user.id);
  res.cookie('userId', user.id, { signed: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, user: userPublic(await getUserById(user.id)) });
});

app.post('/api/auth/set-password', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = await getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.password_hash) return res.status(409).json({ error: 'Password already set. Use sign in.' });
  const password_hash = await bcrypt.hash(password, 10);
  await execute('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, user.id]);
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
  const { verticals, territories, restricted } = req.body || {};
  if (!Array.isArray(verticals) || !Array.isArray(territories)) {
    return res.status(400).json({ error: 'verticals and territories must be arrays' });
  }
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await updateUser(user.id, {
    assigned_verticals: verticals,
    assigned_territories: territories.map((t) => String(t).toUpperCase()),
    restricted: !!restricted,
  });
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'analyst', 'researcher', 'associate'].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
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

const STOCK_DEBRIEF_QUESTIONS = [
  'Who did you speak with and what was their reaction?',
  'What did they say about the current state of the business?',
  'Are there any signals about succession, growth, or acquisition interest?',
  'What is the next step and when should we follow up?',
];

app.get('/api/calls/:id/debrief-questions', requireUser, async (req, res) => {
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  if (call.user_id && call.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  let questions = safeJson(call.debrief_questions) || [];
  const draft = safeJson(call.debrief_draft) || null;
  const hasAiQuestions = Array.isArray(questions) && questions.length >= 3;
  const hasAiSummary = call.ai_summary != null;

  // Wait for AI analysis to complete before returning ready
  // Only fall back to stock questions for old calls (>5 min) or already-debriefed calls
  const callAge = Date.now() - new Date(call.called_at).getTime();
  const isStale = callAge > 5 * 60 * 1000; // 5 minutes
  const alreadyDebriefed = call.debrief_status === 'complete' || call.debrief_status === 'draft';
  if (!hasAiQuestions && !isStale && !alreadyDebriefed) {
    return res.json({ ready: false });
  }
  if (!hasAiQuestions) {
    questions = STOCK_DEBRIEF_QUESTIONS.slice();
  }
  const company = call.company_id ? await getCompany(call.company_id) : null;
  res.json({
    ready: true,
    questions,
    draft,
    status: call.debrief_status || 'pending',
    sentiment: call.sentiment || null,
    ai_summary: safeJson(call.ai_summary) || null,
    next_action: call.next_action || null,
    scheduled_callback_date: call.scheduled_callback_date || null,
    min_answer_len: MIN_ANSWER_LEN,
    company_name: company?.name || null,
    owner_name: company?.owner || null,
  });
});

// Dismiss a pending/draft debrief without filling it out.
// Intended for cleaning stale test calls; also usable for no-answer/voicemail cases.
app.post('/api/calls/:id/dismiss', requireUser, async (req, res) => {
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  if (call.user_id && call.user_id !== req.currentUser.id && req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  if (call.debrief_status === 'complete') {
    return res.json({ ok: true, already: true });
  }
  const reason = (req.body?.reason || 'dismissed').toString().slice(0, 200);
  await updateCallLog(call.id, {
    debrief_status: 'complete',
    debrief_qa: { dismissed: true, reason, dismissed_by: req.currentUser.id, dismissed_at: new Date().toISOString() },
  });
  emit({ type: 'debrief_complete', call_log_id: call.id, company_id: call.company_id, dismissed: true });
  res.json({ ok: true });
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
    const disposition = req.body?.disposition;
    const callbackDecision = req.body?.callback_decision || null;
    const result = await submitDebrief(req.params.id, req.currentUser.id, answers, disposition, callbackDecision);
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
    // Today's call count for this user
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM call_logs WHERE user_id = $1 AND called_at >= date_trunc('day', NOW()) AND COALESCE(duration_sec, 0) > 5`,
      [req.currentUser.id]
    );
    result.calls_today = countRow?.n || 0;
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
  const restrictions = getUserRestrictions(req.currentUser);
  res.json({ board: await getPipelineBoard(restrictions), stages: PIPELINE_STAGES });
});

app.get('/api/pipeline/stages', (req, res) => {
  res.json({
    stages: PIPELINE_STAGES.map(s => ({ key: s, label: formatStage(s) })),
    closedLostReasons: CLOSED_LOST_REASONS,
  });
});

app.put('/api/companies/:id/score', async (req, res) => {
  const { score, tier } = req.body || {};
  if (score == null || isNaN(Number(score)) || Number(score) < 0 || Number(score) > 10) {
    return res.status(400).json({ error: 'Score must be 0-10' });
  }
  const validTier = tier === 'strong-buy' || tier === 'watchlist' || tier === 'pass' ? tier : (Number(score) >= 7.5 ? 'strong-buy' : Number(score) >= 5 ? 'watchlist' : 'pass');
  await pool.query('UPDATE companies SET score = $1, tier = $2, updated_at = NOW() WHERE id = $3', [Number(score), validTier, req.params.id]);
  emit({ type: 'company_updated', id: req.params.id });
  res.json({ ok: true });
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

// Cross-company contact list (for Contacts tab)
app.get('/api/contacts', requireUser, async (req, res) => {
  const search = String(req.query.q || req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const offset = parseInt(req.query.offset) || 0;
  const restrictions = getUserRestrictions(req.currentUser);
  const contacts = await listAllContacts({ search, limit, offset, ...restrictions });
  res.json({ contacts });
});

// Create a contact (company_id in body — used by Contacts tab "+ Add")
app.post('/api/contacts', requireUser, async (req, res) => {
  const { company_id, name, title, phone, email, linkedin, is_primary, notes } = req.body || {};
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Contact name required' });
  const company = await getCompany(company_id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  const contact = await insertContact({
    company_id, name: String(name).trim(), title, phone, email, linkedin, is_primary, notes,
  });
  emit({ type: 'contact_added', company_id });
  logAction(company_id, req.currentUser?.id, `Added contact "${String(name).trim()}" to "${company.name}"${is_primary ? ' (primary)' : ''}`);
  res.json({ ok: true, contact });
});

app.post('/api/companies/:id/contacts', async (req, res) => {
  const { name, title, phone, email, linkedin, is_primary, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Contact name required' });
  const contact = await insertContact({
    company_id: req.params.id, name, title, phone, email, linkedin, is_primary, notes,
  });
  emit({ type: 'contact_added', company_id: req.params.id });
  logAction(req.params.id, req.currentUser?.id, `Added contact "${name}"${is_primary ? ' (primary)' : ''}`);
  res.json({ ok: true, contact });
});

app.put('/api/contacts/:id', async (req, res) => {
  const existing = await getContact(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  await updateContact(req.params.id, req.body || {});
  emit({ type: 'contact_updated', company_id: existing.company_id });
  const changes = [];
  if (req.body.is_primary) changes.push('set as primary');
  if (req.body.name && req.body.name !== existing.name) changes.push(`renamed to "${req.body.name}"`);
  if (req.body.company_id && req.body.company_id !== existing.company_id) changes.push('linked to different company');
  logAction(existing.company_id, req.currentUser?.id, `Updated contact "${existing.name}"${changes.length ? ': ' + changes.join(', ') : ''}`);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', async (req, res) => {
  const existing = await getContact(req.params.id);
  await deleteContact(req.params.id);
  emit({ type: 'contact_deleted', company_id: existing?.company_id });
  logAction(existing?.company_id, req.currentUser?.id, `Deleted contact "${existing?.name || 'unknown'}"`);
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
  const validTypes = ['note', 'call', 'email', 'meeting', 'stage_change', 'research', 'crm_action', 'sms'];
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
  const contacts = await listContacts(row.id);
  const primaryContact = contacts.find((c) => c.is_primary) || contacts[0] || null;
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'public', 'tearsheet.html'), 'utf8');
  const data = {
    company: row,
    signals: safeJson(row.signals_json) || {},
    flags: safeJson(row.flags_json) || { hard_stops: [], yellow_flags: [] },
    sources: safeJson(row.sources_json) || [],
    primaryContact,
    mockMode: process.env.MOCK_MODE === '1',
  };
  const filled = tpl.replace(
    '/*__DATA__*/',
    `window.__TEARSHEET_DATA__ = ${JSON.stringify(data)};`
  );
  res.set('Content-Type', 'text/html');
  res.send(filled);
});

// ---------- Batch Contact Enrichment (runs on server where API key lives) ----------
const { runContactEnrichment } = require('./contact-enrichment');

let _enrichRunning = false;
let _enrichProgress = { running: false, current: 0, total: 0, success: 0, failed: 0, currentCompany: '' };

app.get('/api/enrich/status', requireUser, (req, res) => {
  res.json(_enrichProgress);
});

app.post('/api/enrich/start', requireAdmin, async (req, res) => {
  if (_enrichRunning) return res.status(409).json({ error: 'Enrichment already running' });
  const limit = Math.min(Number(req.body?.limit) || 999, 999);
  const offset = Number(req.body?.offset) || 0;
  _enrichRunning = true;
  _enrichProgress = { running: true, current: 0, total: 0, success: 0, failed: 0, currentCompany: '' };
  res.json({ ok: true, message: 'Enrichment started' });

  // Run in background
  (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, city, state, owner, phone, email, website, score, tier
         FROM companies WHERE status = 'done' AND deleted_at IS NULL
         ORDER BY score DESC NULLS LAST LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      _enrichProgress.total = rows.length;
      emit({ type: 'enrich_started', total: rows.length });

      for (let i = 0; i < rows.length; i++) {
        const c = rows[i];
        _enrichProgress.current = i + 1;
        _enrichProgress.currentCompany = c.name;

        let existingResearch = null;
        try {
          const full = await getCompany(c.id);
          if (full?.raw_research) {
            existingResearch = typeof full.raw_research === 'string'
              ? JSON.parse(full.raw_research) : full.raw_research;
          }
        } catch {}

        try {
          const result = await runContactEnrichment(c, existingResearch);
          const contact = result.contact || {};
          const enrichJson = JSON.stringify({
            identity: result.identity,
            enrichment: result.enrichment,
            contact: result.contact,
          });

          const sets = ['contact_enrichment = $1'];
          const params = [enrichJson];
          let idx = 2;
          if (contact.owner_name && (!c.owner || contact.identity_confidence === 'high')) {
            sets.push(`owner = $${idx++}`);
            params.push(contact.owner_name);
          }
          if (contact.direct_cell || contact.business_phone) {
            const best = contact.direct_cell || contact.business_phone;
            if (best && best !== c.phone) { sets.push(`phone = $${idx++}`); params.push(best); }
          }
          if (contact.direct_email && !c.email) {
            sets.push(`email = $${idx++}`);
            params.push(contact.direct_email);
          }
          params.push(c.id);
          await execute(`UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`, params);
          _enrichProgress.success++;
          emit({ type: 'enrich_progress', current: i + 1, total: rows.length, company: c.name, status: 'ok' });
        } catch (err) {
          _enrichProgress.failed++;
          emit({ type: 'enrich_progress', current: i + 1, total: rows.length, company: c.name, status: 'error', error: err.message });
          console.error(`[enrich] ${c.name}: ${err.message}`);
        }

        // Rate limit
        if (i < rows.length - 1) await new Promise((r) => setTimeout(r, 2000));
      }

      emit({ type: 'enrich_done', success: _enrichProgress.success, failed: _enrichProgress.failed, total: rows.length });
    } catch (err) {
      console.error('[enrich] Fatal:', err.message);
      emit({ type: 'enrich_error', error: err.message });
    } finally {
      _enrichProgress.running = false;
      _enrichRunning = false;
    }
  })();
});

app.post('/api/enrich/stop', requireAdmin, (req, res) => {
  // Simple stop — sets a flag but current company will finish
  _enrichRunning = false;
  _enrichProgress.running = false;
  res.json({ ok: true });
});

// ---------- Global Activity Log ----------
app.get('/api/activity-log', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const userId = req.query.user_id || '';
  const activities = await listGlobalActivities({ limit, offset, userId: userId || undefined });
  res.json({ activities });
});

// Helper: log a CRM action as an activity
function logAction(companyId, userId, summary, details) {
  insertActivity({
    company_id: companyId,
    user_id: userId || null,
    type: 'crm_action',
    summary,
    details: details || null,
  }).catch((err) => console.warn('[activity-log]', err.message));
}

// ---------- Recently Deleted ----------
app.get('/api/deleted', requireUser, async (req, res) => {
  const data = await listDeleted();
  res.json(data);
});

app.delete('/api/companies/:id', requireUser, async (req, res) => {
  const company = await getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  await softDeleteCompany(req.params.id);
  emit({ type: 'company_deleted', id: req.params.id });
  logAction(req.params.id, req.currentUser?.id, `Deleted company "${company.name}"`);
  res.json({ ok: true });
});

app.post('/api/companies/:id/restore', requireUser, async (req, res) => {
  const company = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
  await restoreCompany(req.params.id);
  emit({ type: 'company_restored', id: req.params.id });
  logAction(req.params.id, req.currentUser?.id, `Restored company "${company?.name || 'unknown'}"`);
  res.json({ ok: true });
});

app.post('/api/contacts/:id/restore', requireUser, async (req, res) => {
  await restoreContact(req.params.id);
  emit({ type: 'contact_restored' });
  res.json({ ok: true });
});

app.delete('/api/deleted/companies/:id/permanent', requireAdmin, async (req, res) => {
  await hardDeleteCompany(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/deleted/contacts/:id/permanent', requireAdmin, async (req, res) => {
  await hardDeleteContact(req.params.id);
  res.json({ ok: true });
});

// ---------- Campaigns ----------
app.get('/api/campaigns', requireUser, async (req, res) => {
  const campaigns = await listCampaigns();
  res.json({ campaigns });
});

app.post('/api/campaigns', requireUser, async (req, res) => {
  const { name, subject_template, body_template } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Campaign name required' });
  const id = await insertCampaign({
    name: String(name).trim(),
    subject_template: subject_template || '',
    body_template: body_template || '',
    created_by: req.currentUser.id,
  });
  res.json({ ok: true, id });
});

app.get('/api/campaigns/:id', requireUser, async (req, res) => {
  const campaign = await getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const recipients = await listCampaignRecipients(req.params.id);
  res.json({ campaign, recipients });
});

app.put('/api/campaigns/:id', requireUser, async (req, res) => {
  const campaign = await getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  await updateCampaign(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/campaigns/:id', requireUser, async (req, res) => {
  await deleteCampaign(req.params.id);
  res.json({ ok: true });
});

// Add companies to a campaign
app.post('/api/campaigns/:id/recipients', requireUser, async (req, res) => {
  const { company_ids } = req.body || {};
  if (!Array.isArray(company_ids) || !company_ids.length) {
    return res.status(400).json({ error: 'company_ids array required' });
  }
  const added = await addCampaignRecipients(req.params.id, company_ids);
  res.json({ ok: true, added });
});

app.delete('/api/campaigns/:id/recipients/:companyId', requireUser, async (req, res) => {
  await removeCampaignRecipient(req.params.id, req.params.companyId);
  res.json({ ok: true });
});

// Merge preview — returns merged subject + body for each recipient
app.get('/api/campaigns/:id/preview', requireUser, async (req, res) => {
  const campaign = await getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const recipients = await listCampaignRecipients(req.params.id);
  const merged = recipients.map((r) => ({
    company_id: r.company_id,
    company_name: r.company_name,
    to_email: r.to_email,
    subject: mergeCampaignTemplate(campaign.subject_template, r),
    body: mergeCampaignTemplate(campaign.body_template, r),
  }));
  res.json({ merged });
});

// Search companies for campaign add (lightweight endpoint)
app.get('/api/campaigns/search/companies', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const tier = req.query.tier || '';
  const state = req.query.state || '';
  const stage = req.query.stage || '';
  const excludeCampaign = req.query.exclude_campaign || '';
  let sql = `SELECT c.id, c.name, c.owner, c.city, c.state, c.email, c.score, c.tier, c.pipeline_stage,
              c.outreach_angle, c.phone
             FROM companies c WHERE c.status = 'done'`;
  const params = [];
  let idx = 1;
  if (q) {
    sql += ` AND (LOWER(c.name) LIKE $${idx} OR LOWER(c.owner) LIKE $${idx} OR LOWER(c.city) LIKE $${idx})`;
    params.push(`%${q}%`);
    idx++;
  }
  if (tier) { sql += ` AND c.tier = $${idx}`; params.push(tier); idx++; }
  if (state) { sql += ` AND c.state = $${idx}`; params.push(state); idx++; }
  if (stage) { sql += ` AND c.pipeline_stage = $${idx}`; params.push(stage); idx++; }
  if (excludeCampaign) {
    sql += ` AND c.id NOT IN (SELECT cr.company_id FROM campaign_recipients cr WHERE cr.campaign_id = $${idx})`;
    params.push(excludeCampaign);
    idx++;
  }
  sql += ' ORDER BY c.score DESC NULLS LAST LIMIT 200';
  const rows = await pool.query(sql, params).then((r) => r.rows);
  res.json({ companies: rows });
});

function mergeCampaignTemplate(template, recipient) {
  if (!template) return '';
  return template
    .replace(/\{\{owner\}\}/gi, recipient.owner || '')
    .replace(/\{\{company\}\}/gi, recipient.company_name || '')
    .replace(/\{\{city\}\}/gi, recipient.city || '')
    .replace(/\{\{state\}\}/gi, recipient.state || '')
    .replace(/\{\{phone\}\}/gi, recipient.phone || '')
    .replace(/\{\{email\}\}/gi, recipient.to_email || recipient.company_email || '')
    .replace(/\{\{score\}\}/gi, recipient.score != null ? Number(recipient.score).toFixed(1) : '')
    .replace(/\{\{tier\}\}/gi, recipient.tier || '')
    .replace(/\{\{outreach_angle\}\}/gi, recipient.outreach_angle || '')
    .replace(/\{\{summary\}\}/gi, recipient.summary || '');
}

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
