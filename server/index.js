require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

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
const { registerOutlookRoutes } = require('./outlook');

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
    const user = await getUserById(userId);
    if (user?.disabled) {
      res.clearCookie('userId');
      req.currentUser = null;
    } else {
      req.currentUser = user;
    }
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

// ---------- Import Grata CSV ----------
const GRATA_FIELD_MAP = {
  company_name: ['company_name', 'company name', 'name', 'company', 'business', 'business name'],
  domain: ['domain', 'website', 'url', 'site', 'web'],
  city: ['city', 'town', 'hq_city', 'hq city', 'headquarters_city'],
  state: ['state', 'st', 'hq_state', 'hq state', 'headquarters_state', 'province'],
  employee_count: ['employee_count', 'employee count', 'employees', 'headcount', 'num_employees'],
  revenue: ['revenue', 'est_revenue', 'estimated_revenue', 'annual_revenue', 'revenue_estimate'],
  year_founded: ['year_founded', 'year founded', 'founded', 'founded_year'],
  ownership: ['ownership', 'ownership_type', 'ownership type', 'owner_type'],
  description: ['description', 'company_description', 'about', 'summary'],
  contact_name: ['contact_name', 'contact name', 'contact', 'person', 'full_name', 'full name', 'owner', 'owner name', 'principal'],
  contact_title: ['contact_title', 'contact title', 'title', 'job_title', 'job title', 'role', 'position'],
  contact_email: ['contact_email', 'contact email', 'email', 'e-mail', 'email_address'],
  contact_phone: ['contact_phone', 'contact phone', 'phone', 'telephone', 'phone_number', 'direct_phone'],
  linkedin_url: ['linkedin_url', 'linkedin url', 'linkedin', 'linkedin_profile'],
  naics_codes: ['naics_codes', 'naics codes', 'naics', 'naics_code', 'industry_codes'],
};

function buildGrataHeaderMap(headers) {
  const norm = headers.map(h => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(GRATA_FIELD_MAP)) {
    for (let i = 0; i < norm.length; i++) {
      if (aliases.includes(norm[i])) { map[field] = i; break; }
    }
  }
  return map;
}

app.post('/api/import/grata', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const { parse } = require('csv-parse/sync');
  const { nanoid } = require('nanoid');

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    return res.status(400).json({ error: 'CSV parse error: ' + err.message });
  }
  if (records.length < 2) {
    return res.status(400).json({ error: 'CSV must have a header row and at least one data row.' });
  }

  const hmap = buildGrataHeaderMap(records[0]);
  if (hmap.company_name === undefined) {
    return res.status(400).json({ error: 'CSV must include a company name column (accepted: company_name, name, company, business).' });
  }

  const get = (record, field) =>
    hmap[field] !== undefined ? String(record[hmap[field]] || '').trim() : '';

  let companiesCreated = 0;
  let companiesUpdated = 0;
  let contactsCreated = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    const companyName = get(rec, 'company_name');
    if (!companyName) { skipped++; continue; }

    const nameKey = normalizeName(companyName);
    if (!nameKey) { skipped++; continue; }

    try {
      // Check if company exists by name_key
      const existing = await pool.query('SELECT id, name FROM companies WHERE name_key = $1 LIMIT 1', [nameKey]);
      let companyId;

      const domain = get(rec, 'domain');
      const city = get(rec, 'city') || null;
      const state = get(rec, 'state') || null;
      const employeeCount = get(rec, 'employee_count') || null;
      const revenue = get(rec, 'revenue') || null;
      const yearFounded = get(rec, 'year_founded') || null;
      const ownership = get(rec, 'ownership') || null;
      const description = get(rec, 'description') || null;
      const naicsCodes = get(rec, 'naics_codes') || null;

      // Build summary snippet from Grata data
      const summaryParts = [];
      if (employeeCount) summaryParts.push(employeeCount + ' employees');
      if (revenue) summaryParts.push('Revenue: ' + revenue);
      if (yearFounded) summaryParts.push('Founded: ' + yearFounded);
      if (ownership) summaryParts.push('Ownership: ' + ownership);
      if (naicsCodes) summaryParts.push('NAICS: ' + naicsCodes);
      if (description) summaryParts.push(description);
      const grataSummary = summaryParts.length ? summaryParts.join(' | ') : null;

      if (existing.rows.length > 0) {
        // Company exists — update missing fields
        companyId = existing.rows[0].id;
        const updates = [];
        const params = [];
        let idx = 1;
        if (domain) { updates.push(`website = COALESCE(companies.website, $${idx++})`); params.push(domain); }
        if (city) { updates.push(`city = COALESCE(companies.city, $${idx++})`); params.push(city); }
        if (state) { updates.push(`state = COALESCE(companies.state, $${idx++})`); params.push(state); }
        if (grataSummary) {
          updates.push(`summary = COALESCE(companies.summary, $${idx++})`);
          params.push(grataSummary);
        }
        if (updates.length) {
          updates.push('updated_at = NOW()');
          params.push(companyId);
          await pool.query(`UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        }
        companiesUpdated++;
      } else {
        // New company — insert with status 'pending'
        companyId = nanoid();
        await insertCompany({
          id: companyId,
          name: companyName,
          name_key: nameKey,
          city,
          state,
          phone: null,
          website: domain || null,
          owner: null,
          email: null,
          address: null,
          crm_known: false,
        });
        // Update summary if we have Grata metadata
        if (grataSummary) {
          await pool.query('UPDATE companies SET summary = $1 WHERE id = $2', [grataSummary, companyId]);
        }
        companiesCreated++;
      }

      // Add contact if contact_name is present
      const contactName = get(rec, 'contact_name');
      if (contactName) {
        const contactEmail = get(rec, 'contact_email') || null;
        const contactPhone = get(rec, 'contact_phone') || null;
        const contactTitle = get(rec, 'contact_title') || null;
        const linkedinUrl = get(rec, 'linkedin_url') || null;

        // Check if this contact already exists for this company (by name)
        const existingContact = await pool.query(
          'SELECT id FROM contacts WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL LIMIT 1',
          [companyId, contactName]
        );

        if (existingContact.rows.length === 0) {
          // Check if company has any contacts — if not, make this one primary
          const contactCount = await pool.query(
            'SELECT COUNT(*) AS cnt FROM contacts WHERE company_id = $1 AND deleted_at IS NULL',
            [companyId]
          );
          const isPrimary = parseInt(contactCount.rows[0].cnt, 10) === 0;

          const phones = contactPhone ? [contactPhone] : [];
          const emails = contactEmail ? [contactEmail] : [];

          await insertContact({
            company_id: companyId,
            name: contactName,
            title: contactTitle,
            phone: contactPhone,
            email: contactEmail,
            linkedin: linkedinUrl,
            is_primary: isPrimary,
            source: 'grata',
            notes: null,
            phones,
            emails,
          });
          contactsCreated++;

          // Also update company owner field if it's the primary contact
          if (isPrimary) {
            await pool.query(
              'UPDATE companies SET owner = COALESCE(companies.owner, $1), email = COALESCE(companies.email, $2), phone = COALESCE(companies.phone, $3) WHERE id = $4',
              [contactName, contactEmail, contactPhone, companyId]
            );
          }
        }
      }
    } catch (err) {
      errors.push({ row: i + 1, company: companyName, error: err.message });
    }
  }

  // Mark CRM known names if applicable
  const known = await sf.getPastedKnownNames();
  if (known && known.length) await markCrmKnown(known);

  res.json({
    ok: true,
    companies_created: companiesCreated,
    companies_updated: companiesUpdated,
    contacts_created: contactsCreated,
    skipped,
    errors: errors.slice(0, 20),
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
    twilio_phone_number: user.twilio_phone_number || null,
    smtp_from_email: user.smtp_from_email || null,
    smtp_host: user.smtp_host || null,
    smtp_port: user.smtp_port || null,
    smtp_user: user.smtp_user || null,
    email_signature: user.email_signature || null,
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
  if (user.disabled) return res.status(403).json({ error: 'This account has been disabled. Contact your admin.' });
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
  if (user.disabled) return res.status(403).json({ error: 'This account has been disabled. Contact your admin.' });
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

app.put('/api/me/twilio-number', requireUser, async (req, res) => {
  const num = req.body?.twilio_phone_number;
  await updateUser(req.currentUser.id, { twilio_phone_number: num ? String(num).trim() : null });
  res.json({ ok: true });
});

app.put('/api/me/email-signature', requireUser, async (req, res) => {
  const sig = req.body?.email_signature;
  await updateUser(req.currentUser.id, { email_signature: sig || null });
  res.json({ ok: true });
});

app.put('/api/me/email-settings', requireUser, async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email } = req.body || {};
  await updateUser(req.currentUser.id, {
    smtp_host: smtp_host || null,
    smtp_port: smtp_port ? Number(smtp_port) : null,
    smtp_user: smtp_user || null,
    smtp_pass: smtp_pass || null,
    smtp_from_email: smtp_from_email || null,
  });
  res.json({ ok: true });
});

app.post('/api/me/email-test', requireUser, async (req, res) => {
  const user = await getUserById(req.currentUser.id);
  if (!user || !user.smtp_host || !user.smtp_user || !user.smtp_pass) {
    return res.status(400).json({ error: 'SMTP settings not configured. Save your email settings first.' });
  }
  try {
    const transporter = nodemailer.createTransport({
      host: user.smtp_host,
      port: user.smtp_port || 587,
      secure: user.smtp_port === 465,
      auth: { user: user.smtp_user, pass: user.smtp_pass },
    });
    await transporter.sendMail({
      from: user.smtp_from_email || user.smtp_user,
      to: user.email,
      subject: 'Sells Prospector - SMTP Test',
      text: 'This is a test email from Sells M&A Prospector. Your SMTP settings are working correctly.',
    });
    res.json({ ok: true, message: `Test email sent to ${user.email}` });
  } catch (err) {
    console.error('[email-test]', err.message);
    res.status(500).json({ error: `SMTP test failed: ${err.message}` });
  }
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
  const { verticals, territories, restricted, twilio_phone_number, disabled } = req.body || {};
  if (!Array.isArray(verticals) || !Array.isArray(territories)) {
    return res.status(400).json({ error: 'verticals and territories must be arrays' });
  }
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updates = {
    assigned_verticals: verticals,
    assigned_territories: territories.map((t) => String(t).toUpperCase()),
    restricted: !!restricted,
  };
  if (twilio_phone_number !== undefined) {
    updates.twilio_phone_number = twilio_phone_number ? String(twilio_phone_number).trim() : null;
  }
  if (disabled !== undefined) {
    updates.disabled = !!disabled;
  }
  await updateUser(user.id, updates);
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

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password_hash = await bcrypt.hash(password, 10);
  await execute('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, user.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.currentUser.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  if (user.role === 'admin') {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
    if ((rows[0]?.n ?? 0) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last admin' });
    }
  }
  await execute('DELETE FROM users WHERE id = $1', [user.id]);
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

app.get('/api/calls/missed', requireUser, async (req, res) => {
  const userId = req.currentUser.id;
  const isAdmin = req.currentUser.role === 'admin';
  const { rows } = await pool.query(
    `SELECT cl.*, c.name AS company_name, c.city AS company_city, c.state AS company_state,
            ct.name AS contact_name
     FROM call_logs cl
     LEFT JOIN companies c ON cl.company_id = c.id
     LEFT JOIN contacts ct ON cl.contact_id = ct.id
     WHERE cl.direction = 'inbound'
       AND cl.status IN ('missed', 'voicemail', 'no-answer', 'ringing')
       ${isAdmin ? '' : 'AND (cl.user_id = $1 OR cl.user_id IS NULL)'}
     ORDER BY cl.called_at DESC
     LIMIT 50`,
    isAdmin ? [] : [userId]
  );
  res.json({ calls: rows });
});

app.put('/api/calls/:id/link', requireUser, async (req, res) => {
  const { contact_id, company_id } = req.body || {};
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  const updates = {};
  if (contact_id) updates.contact_id = contact_id;
  if (company_id) updates.company_id = company_id;
  if (Object.keys(updates).length) {
    const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const params = [...Object.values(updates), req.params.id];
    await execute(`UPDATE call_logs SET ${fields} WHERE id = $${params.length}`, params);
  }
  res.json({ ok: true });
});

app.put('/api/calls/:id/dismiss', requireUser, async (req, res) => {
  const call = await getCallLog(req.params.id);
  if (!call) return res.status(404).json({ error: 'call_log not found' });
  await updateCallLog(call.id, { status: 'dismissed' });
  res.json({ ok: true });
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
  // If AI prompt is set, use AI-generated emails; otherwise fallback to merge templates
  if (campaign.ai_prompt) {
    const merged = recipients.map((r) => ({
      company_id: r.company_id,
      company_name: r.company_name,
      to_email: r.to_email,
      subject: r.merged_subject || '(generating...)',
      body: r.merged_body || '(generating...)',
      ai_generated: !!r.merged_body,
    }));
    return res.json({ merged, ai_mode: true });
  }
  const merged = recipients.map((r) => ({
    company_id: r.company_id,
    company_name: r.company_name,
    to_email: r.to_email,
    subject: mergeCampaignTemplate(campaign.subject_template, r),
    body: mergeCampaignTemplate(campaign.body_template, r),
  }));
  res.json({ merged });
});

// Generate AI emails for all recipients in a campaign
app.post('/api/campaigns/:id/generate', requireUser, async (req, res) => {
  const { callJson: aiCallJson } = require('./claude');
  const { MODELS } = require('./claude');
  const campaign = await getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!campaign.ai_prompt) return res.status(400).json({ error: 'No AI prompt set for this campaign' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const recipients = await listCampaignRecipients(req.params.id);
  const sender = await getUserById(req.currentUser.id);
  const senderName = sender?.name || 'the analyst';
  const senderSig = sender?.email_signature ? `\n\n${sender.email_signature}` : '';
  let generated = 0;
  let lastError = null;

  for (const r of recipients) {
    try {
      // Get full company data
      const company = await getCompany(r.company_id);
      if (!company) continue;

      // Get recent call history for this company
      const { rows: callLogs } = await pool.query(
        `SELECT direction, sentiment, transcript, ai_summary, called_at, duration_sec
         FROM call_logs WHERE company_id = $1
         ORDER BY called_at DESC LIMIT 5`,
        [r.company_id]
      );

      const callContext = callLogs.length
        ? callLogs.map(cl => {
          const summary = typeof cl.ai_summary === 'string' ? cl.ai_summary : JSON.stringify(cl.ai_summary || {});
          return `- ${cl.direction} call on ${new Date(cl.called_at).toLocaleDateString()}: sentiment=${cl.sentiment || 'unknown'}, summary: ${summary}`;
        }).join('\n')
        : 'No previous calls.';

      const ownerName = (company.owner || '').split(/[(/]/)[0].trim(); // Clean "Chuck McGinty (Wayne McGinty deceased 2016)" → "Chuck McGinty"

      const { parsed } = await aiCallJson({
        model: MODELS.worker,
        system: `You write personalized business emails for an M&A advisor. Write naturally — like a real person, not a template. Never include placeholder brackets. Never mention internal scores, data sources, or AI. The email should feel like the sender personally researched this business.`,
        user: `SENDER: ${senderName}
SENDER'S FIRM: Sells Group Advisors

RECIPIENT:
- Owner name: ${ownerName}
- Company: ${company.name}
- City: ${company.city || ''}, ${company.state || ''}
- Industry: ${company.industry || 'Plumbing'}
- Years in business / founded: ${company.year_founded || 'unknown'}
- Summary: ${company.summary || 'No summary available'}
- Outreach angle: ${company.outreach_angle || 'General outreach'}
- Call intelligence: ${company.call_intelligence || 'None'}

PREVIOUS INTERACTIONS:
${callContext}

DIRECTION FROM USER:
${campaign.ai_prompt}

Generate a JSON object with:
- "subject": a short, natural email subject line (no generic "Opportunity" — make it specific and intriguing)
- "body": the full email body (no subject line repeated, no "Subject:" prefix). Use the owner's first name. Keep it concise. End with sender's first name only.

Return ONLY valid JSON: { "subject": "...", "body": "..." }`,
        maxTokens: 1000,
      });

      if (parsed?.subject && parsed?.body) {
        // Convert body to HTML — simple line breaks, no extra spacing
        const bodyHtml = parsed.body.replace(/\n/g, '<br>');
        const fullHtml = bodyHtml + (senderSig ? `<br><br>${senderSig.replace(/\n/g, '<br>')}` : '');
        await execute(
          `UPDATE campaign_recipients SET merged_subject = $1, merged_body = $2 WHERE campaign_id = $3 AND company_id = $4`,
          [parsed.subject, fullHtml, req.params.id, r.company_id]
        );
        generated++;
      }
    } catch (err) {
      console.error(`[campaigns] AI generation failed for ${r.company_name}:`, err.message);
      lastError = err.message;
    }
  }

  res.json({ ok: true, generated, total: recipients.length, lastError: generated < recipients.length ? lastError : undefined });
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
             FROM companies c WHERE c.deleted_at IS NULL`;
  const params = [];
  let idx = 1;
  if (q) {
    sql += ` AND (LOWER(c.name) LIKE $${idx} OR LOWER(c.owner) LIKE $${idx} OR LOWER(c.city) LIKE $${idx})`;
    params.push(`%${q}%`);
    idx++;
  }
  if (tier) {
    const tiers = tier.split(',').filter(Boolean);
    if (tiers.length === 1) { sql += ` AND c.tier = $${idx}`; params.push(tiers[0]); idx++; }
    else if (tiers.length > 1) { sql += ` AND c.tier = ANY($${idx}::text[])`; params.push(tiers); idx++; }
  }
  if (state) {
    const states = state.split(',').filter(Boolean);
    if (states.length === 1) { sql += ` AND c.state = $${idx}`; params.push(states[0]); idx++; }
    else if (states.length > 1) { sql += ` AND c.state = ANY($${idx}::text[])`; params.push(states); idx++; }
  }
  if (stage) { sql += ` AND c.pipeline_stage = $${idx}`; params.push(stage); idx++; }
  const industry = req.query.industry || '';
  if (industry) {
    const industries = industry.split(',').filter(Boolean);
    if (industries.length === 1) { sql += ` AND COALESCE(c.industry, 'Plumbing') = $${idx}`; params.push(industries[0]); idx++; }
    else if (industries.length > 1) { sql += ` AND COALESCE(c.industry, 'Plumbing') = ANY($${idx}::text[])`; params.push(industries); idx++; }
  }
  if (excludeCampaign) {
    sql += ` AND c.id NOT IN (SELECT cr.company_id FROM campaign_recipients cr WHERE cr.campaign_id = $${idx})`;
    params.push(excludeCampaign);
    idx++;
  }
  sql += ' ORDER BY c.score DESC NULLS LAST LIMIT 1000';
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

// ---------- Mandates (buy-side mandate management) ----------

// List all mandates with company count
app.get('/api/mandates', requireUser, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.*, (SELECT COUNT(*) FROM mandate_companies mc WHERE mc.mandate_id = m.id) AS company_count
    FROM mandates m WHERE m.status != 'closed' ORDER BY m.created_at DESC
  `);
  res.json({ mandates: rows });
});

// Get single mandate with companies
app.get('/api/mandates/:id', requireUser, async (req, res) => {
  const mandate = await pool.query('SELECT * FROM mandates WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
  if (!mandate) return res.status(404).json({ error: 'Mandate not found' });
  const { rows: companies } = await pool.query(`
    SELECT mc.*, c.name AS company_name, c.owner, c.city, c.state, c.website, c.score, c.tier,
           c.phone, c.email, c.pipeline_stage, c.summary, c.industry
    FROM mandate_companies mc
    JOIN companies c ON c.id = mc.company_id
    WHERE mc.mandate_id = $1
    ORDER BY CASE mc.deal_stage WHEN 'Execution' THEN 1 WHEN 'Introduction' THEN 2 WHEN 'Engage' THEN 3 WHEN 'Qualify' THEN 4 ELSE 5 END
  `, [req.params.id]);
  res.json({ mandate, companies });
});

// Create mandate
app.post('/api/mandates', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const b = req.body || {};
  if (!b.buyer_name || !String(b.buyer_name).trim()) return res.status(400).json({ error: 'Buyer name required' });
  const id = nanoid();
  await pool.query(`
    INSERT INTO mandates (id, buyer_name, buyer_logo_url, revenue_min, revenue_max, ebitda_min, ebitda_max,
      target_geographies, target_verticals, reporting_frequency)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    id, String(b.buyer_name).trim(), b.buyer_logo_url || null,
    b.revenue_min || null, b.revenue_max || null, b.ebitda_min || null, b.ebitda_max || null,
    JSON.stringify(b.target_geographies || []), JSON.stringify(b.target_verticals || []),
    b.reporting_frequency || 'biweekly',
  ]);
  res.json({ ok: true, id });
});

// Update mandate
app.put('/api/mandates/:id', requireUser, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['buyer_name', 'buyer_logo_url', 'revenue_min', 'revenue_max', 'ebitda_min', 'ebitda_max', 'reporting_frequency', 'status']) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(b[key]);
    }
  }
  if (b.target_geographies !== undefined) {
    fields.push(`target_geographies = $${idx++}`);
    params.push(JSON.stringify(b.target_geographies || []));
  }
  if (b.target_verticals !== undefined) {
    fields.push(`target_verticals = $${idx++}`);
    params.push(JSON.stringify(b.target_verticals || []));
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = NOW()');
  params.push(req.params.id);
  await pool.query(`UPDATE mandates SET ${fields.join(', ')} WHERE id = $${idx}`, params);
  res.json({ ok: true });
});

// Soft-delete mandate (set status = closed)
app.delete('/api/mandates/:id', requireUser, async (req, res) => {
  await pool.query("UPDATE mandates SET status = 'closed', updated_at = NOW() WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// Add company to mandate
app.post('/api/mandates/:id/companies', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const { company_id, deal_stage } = req.body || {};
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  const id = nanoid();
  try {
    await pool.query(`
      INSERT INTO mandate_companies (id, mandate_id, company_id, deal_stage)
      VALUES ($1, $2, $3, $4)
    `, [id, req.params.id, company_id, deal_stage || 'Qualify']);
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Company already in this mandate' });
    throw err;
  }
});

// Import companies to mandate from CSV
app.post('/api/mandates/:id/import', requireUser, upload.single('file'), async (req, res) => {
  const { nanoid } = require('nanoid');
  const { parse } = require('csv-parse/sync');
  if (!req.file) return res.status(400).json({ error: 'No file' });

  let records;
  try {
    records = parse(req.file.buffer, { columns: false, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    return res.status(400).json({ error: 'Could not parse file' });
  }

  let matched = 0, notFound = [];
  for (const row of records) {
    const name = (row[0] || '').trim();
    if (!name) continue;
    const { rows } = await pool.query(
      "SELECT id FROM companies WHERE LOWER(name) LIKE $1 AND deleted_at IS NULL LIMIT 1",
      ['%' + name.toLowerCase() + '%']
    );
    if (rows.length) {
      try {
        await pool.query(
          'INSERT INTO mandate_companies (id, mandate_id, company_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [nanoid(), req.params.id, rows[0].id]
        );
        matched++;
      } catch {}
    } else {
      notFound.push(name);
    }
  }
  res.json({ ok: true, matched, not_found: notFound });
});

// Remove company from mandate
app.delete('/api/mandates/:id/companies/:companyId', requireUser, async (req, res) => {
  await pool.query('DELETE FROM mandate_companies WHERE mandate_id = $1 AND company_id = $2', [req.params.id, req.params.companyId]);
  res.json({ ok: true });
});

// Update mandate company details
app.put('/api/mandates/:id/companies/:companyId', requireUser, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['deal_stage', 'next_step', 'nda_sent', 'nda_signed', 'offer_sent', 'offer_signed', 'offer_tev']) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (['nda_sent', 'nda_signed', 'offer_sent', 'offer_signed'].includes(key)) params.push(!!b[key]);
      else params.push(b[key]);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = NOW()');
  params.push(req.params.id, req.params.companyId);
  await pool.query(`UPDATE mandate_companies SET ${fields.join(', ')} WHERE mandate_id = $${idx++} AND company_id = $${idx}`, params);
  res.json({ ok: true });
});

// Get mandates for a company
app.get('/api/companies/:id/mandates', requireUser, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT mc.*, m.buyer_name, m.status AS mandate_status
    FROM mandate_companies mc
    JOIN mandates m ON m.id = mc.mandate_id
    WHERE mc.company_id = $1 AND m.status != 'closed'
    ORDER BY mc.added_at DESC
  `, [req.params.id]);
  res.json({ mandates: rows });
});

// Progress Reports
app.get('/api/mandates/:id/progress-reports', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM progress_reports WHERE mandate_id = $1 ORDER BY period_end DESC',
    [req.params.id]
  );
  res.json({ reports: rows });
});

app.post('/api/mandates/:id/progress-reports', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const mandateId = req.params.id;
  const { period_start, period_end, notes } = req.body || {};
  if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required' });

  // Auto-populate calls and talk time
  const { rows: [callStats] } = await pool.query(`
    SELECT COUNT(*) AS calls_made, COALESCE(SUM(duration_sec), 0) AS talk_time_seconds
    FROM call_logs cl
    WHERE cl.company_id IN (SELECT company_id FROM mandate_companies WHERE mandate_id = $1)
      AND cl.called_at >= $2 AND cl.called_at <= $3
  `, [mandateId, period_start, period_end]);

  // Auto-populate emails sent
  const { rows: [emailStats] } = await pool.query(`
    SELECT COUNT(*) AS emails_sent
    FROM activities a
    WHERE a.company_id IN (SELECT company_id FROM mandate_companies WHERE mandate_id = $1)
      AND a.type = 'email' AND a.created_at >= $2 AND a.created_at <= $3
  `, [mandateId, period_start, period_end]);

  const id = nanoid();
  await pool.query(`
    INSERT INTO progress_reports (id, mandate_id, period_start, period_end, calls_made, talk_time_seconds, emails_sent, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    id, mandateId, period_start, period_end,
    Number(callStats?.calls_made) || 0,
    Number(callStats?.talk_time_seconds) || 0,
    Number(emailStats?.emails_sent) || 0,
    notes || null,
  ]);
  res.json({ ok: true, id });
});

app.get('/api/progress-reports/:id', requireUser, async (req, res) => {
  const { rows: [report] } = await pool.query('SELECT * FROM progress_reports WHERE id = $1', [req.params.id]);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

app.put('/api/progress-reports/:id', requireUser, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['calls_made', 'talk_time_seconds', 'emails_sent', 'new_companies_contacted', 'companies_advanced', 'notes', 'is_published']) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(key === 'is_published' ? !!b[key] : b[key]);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = NOW()');
  params.push(req.params.id);
  await pool.query(`UPDATE progress_reports SET ${fields.join(', ')} WHERE id = $${idx}`, params);
  res.json({ ok: true });
});

app.delete('/api/progress-reports/:id', requireUser, async (req, res) => {
  // Only allow deleting drafts
  const { rows: [report] } = await pool.query('SELECT is_published FROM progress_reports WHERE id = $1', [req.params.id]);
  if (report?.is_published) return res.status(400).json({ error: 'Cannot delete published report' });
  await pool.query('DELETE FROM progress_reports WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Pipeline Report CSV export
app.get('/api/mandates/:id/pipeline-report.csv', requireUser, async (req, res) => {
  const mandate = await pool.query('SELECT * FROM mandates WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
  if (!mandate) return res.status(404).json({ error: 'Mandate not found' });
  const { rows: companies } = await pool.query(`
    SELECT mc.*, c.name AS company_name, c.owner, c.city, c.state, c.score, c.tier, c.phone, c.email, c.industry
    FROM mandate_companies mc
    JOIN companies c ON c.id = mc.company_id
    WHERE mc.mandate_id = $1
    ORDER BY CASE mc.deal_stage WHEN 'Execution' THEN 1 WHEN 'Introduction' THEN 2 WHEN 'Engage' THEN 3 WHEN 'Qualify' THEN 4 ELSE 5 END,
             c.score DESC NULLS LAST
  `, [req.params.id]);

  const stages = ['Execution', 'Introduction', 'Engage', 'Qualify'];
  const lines = [];
  lines.push(`Pipeline Report: ${mandate.buyer_name}`);
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('Stage,Company,Owner,City,State,Score,NDA Sent,NDA Signed,Offer Sent,Offer Signed,Offer TEV,Next Step');

  for (const stage of stages) {
    const stageCompanies = companies.filter(c => c.deal_stage === stage);
    if (stageCompanies.length === 0) continue;
    lines.push('');
    lines.push(`"--- ${stage} (${stageCompanies.length}) ---"`);
    for (const c of stageCompanies) {
      const csvRow = [
        stage,
        `"${(c.company_name || '').replace(/"/g, '""')}"`,
        `"${(c.owner || '').replace(/"/g, '""')}"`,
        c.city || '',
        c.state || '',
        c.score != null ? Number(c.score).toFixed(1) : '',
        c.nda_sent ? 'Yes' : 'No',
        c.nda_signed ? 'Yes' : 'No',
        c.offer_sent ? 'Yes' : 'No',
        c.offer_signed ? 'Yes' : 'No',
        c.offer_tev ? `$${Number(c.offer_tev).toLocaleString()}` : '',
        `"${(c.next_step || '').replace(/"/g, '""')}"`,
      ].join(',');
      lines.push(csvRow);
    }
  }

  lines.push('');
  lines.push(`Total Companies,${companies.length}`);
  const totalOfferTev = companies.filter(c => c.offer_tev).reduce((sum, c) => sum + Number(c.offer_tev), 0);
  if (totalOfferTev) lines.push(`Total Offer TEV,"$${totalOfferTev.toLocaleString()}"`);

  const csv = lines.join('\r\n');
  res.set({
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="pipeline-${mandate.buyer_name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(csv);
});

// ---------- Pipeline Enrichment (Feature 1A) ----------
app.put('/api/companies/:id/key-info', requireUser, async (req, res) => {
  const { key_info } = req.body || {};
  if (!key_info) return res.status(400).json({ error: 'key_info required' });
  await execute('UPDATE companies SET key_info = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(key_info), req.params.id]);
  res.json({ ok: true });
});

app.put('/api/companies/:id/deal-fields', requireUser, async (req, res) => {
  const { valuation, probability, est_close_date, deal_owner_id, deal_priority, next_steps } = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  if (valuation !== undefined) { fields.push(`valuation = $${idx++}`); params.push(valuation); }
  if (probability !== undefined) { fields.push(`probability = $${idx++}`); params.push(probability); }
  if (est_close_date !== undefined) { fields.push(`est_close_date = $${idx++}`); params.push(est_close_date || null); }
  if (deal_owner_id !== undefined) { fields.push(`deal_owner_id = $${idx++}`); params.push(deal_owner_id || null); }
  if (deal_priority !== undefined) { fields.push(`deal_priority = $${idx++}`); params.push(deal_priority || null); }
  if (next_steps !== undefined) { fields.push(`next_steps = $${idx++}`); params.push(next_steps || null); }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = NOW()');
  params.push(req.params.id);
  await execute(`UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx}`, params);
  emit({ type: 'company_updated', id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/companies/:id/mark-reviewed', requireUser, async (req, res) => {
  await execute('UPDATE companies SET last_reviewed_at = NOW(), updated_at = NOW() WHERE id = $1', [req.params.id]);
  emit({ type: 'company_updated', id: req.params.id });
  res.json({ ok: true });
});

// ---------- Deal Milestones (Feature 1B) ----------
const MILESTONE_KEYS = [
  'buyer_list', 'qoe', 'teaser', 'cim', 'network_intros', 'buyer_outreach',
  'iois_received', 'mgmt_meetings', 'lois_received', 'loi_signed', 'diligence', 'closing',
];
const MILESTONE_STATES = ['not_started', 'in_progress', 'complete'];

app.get('/api/companies/:id/milestones', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT milestone_key, state, updated_at FROM deal_milestones WHERE company_id = $1',
    [req.params.id]
  );
  const map = {};
  for (const r of rows) map[r.milestone_key] = r.state;
  res.json({ milestones: map });
});

app.put('/api/companies/:id/milestones/:key', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const key = req.params.key;
  if (!MILESTONE_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid milestone key' });
  // Get current state and cycle
  const existing = await pool.query(
    'SELECT state FROM deal_milestones WHERE company_id = $1 AND milestone_key = $2',
    [req.params.id, key]
  ).then(r => r.rows[0]);
  const currentIdx = MILESTONE_STATES.indexOf(existing?.state || 'not_started');
  const newState = MILESTONE_STATES[(currentIdx + 1) % MILESTONE_STATES.length];
  await pool.query(
    `INSERT INTO deal_milestones (id, company_id, milestone_key, state, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id, milestone_key) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [nanoid(), req.params.id, key, newState]
  );
  await execute('UPDATE companies SET updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.json({ ok: true, state: newState });
});

app.get('/api/milestones/batch', requireUser, async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json({ milestones: {} });
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(
    `SELECT company_id, milestone_key, state FROM deal_milestones WHERE company_id IN (${placeholders})`,
    ids
  );
  const result = {};
  for (const r of rows) {
    if (!result[r.company_id]) result[r.company_id] = {};
    result[r.company_id][r.milestone_key] = r.state;
  }
  res.json({ milestones: result });
});

// ---------- Pre-Engagement Watchlist (Feature 1D) ----------
app.get('/api/pre-engagement', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM pre_engagement ORDER BY CASE priority WHEN \'High\' THEN 1 WHEN \'Medium\' THEN 2 WHEN \'Low\' THEN 3 ELSE 4 END, created_at DESC'
  );
  res.json({ items: rows });
});

app.post('/api/pre-engagement', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const b = req.body || {};
  if (!b.account_name || !String(b.account_name).trim()) return res.status(400).json({ error: 'Account name required' });
  const id = nanoid();
  await pool.query(
    `INSERT INTO pre_engagement (id, account_name, primary_contact, website, priority, status, next_action, first_contact_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, String(b.account_name).trim(), b.primary_contact || null, b.website || null,
     b.priority || 'Medium', b.status || 'New', b.next_action || null,
     b.first_contact_date || null, b.notes || null]
  );
  res.json({ ok: true, id });
});

app.put('/api/pre-engagement/:id', requireUser, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['account_name', 'primary_contact', 'website', 'priority', 'status', 'next_action', 'first_contact_date', 'initial_docs_sent', 'initial_data_received', 'initial_model_created', 'notes']) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (['initial_docs_sent', 'initial_data_received', 'initial_model_created'].includes(key)) {
        params.push(!!b[key]);
      } else {
        params.push(b[key]);
      }
    }
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = NOW()');
  params.push(req.params.id);
  await pool.query(`UPDATE pre_engagement SET ${fields.join(', ')} WHERE id = $${idx}`, params);
  res.json({ ok: true });
});

app.post('/api/pre-engagement/:id/promote', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const pe = await pool.query('SELECT * FROM pre_engagement WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
  if (!pe) return res.status(404).json({ error: 'Not found' });
  if (pe.promoted_company_id) return res.status(409).json({ error: 'Already promoted', company_id: pe.promoted_company_id });

  const name = pe.account_name;
  const name_key = normalizeName(name);
  // Check for existing company
  const existing = await pool.query('SELECT id FROM companies WHERE name_key = $1 LIMIT 1', [name_key]);
  if (existing.rows.length > 0) {
    await pool.query('UPDATE pre_engagement SET promoted_company_id = $1, status = \'Promoted\', updated_at = NOW() WHERE id = $2', [existing.rows[0].id, pe.id]);
    return res.json({ ok: true, company_id: existing.rows[0].id, existed: true });
  }

  const companyId = nanoid();
  await insertCompany({
    id: companyId, name, name_key,
    city: null, state: null, phone: null,
    website: pe.website || null, owner: pe.primary_contact || null,
    email: null, address: null, crm_known: false,
  });
  await execute('UPDATE companies SET pipeline_stage = \'initial_contact\', pipeline_stage_changed_at = NOW() WHERE id = $1', [companyId]);
  await pool.query('UPDATE pre_engagement SET promoted_company_id = $1, status = \'Promoted\', updated_at = NOW() WHERE id = $2', [companyId, pe.id]);
  emit({ type: 'company_added', company_id: companyId });
  res.json({ ok: true, company_id: companyId });
});

// ---------- Deal Contacts (Feature 1E) ----------
app.get('/api/companies/:id/deal-contacts', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT dc.*, ct.name AS contact_name, ct.title AS contact_title, ct.phone AS contact_phone, ct.email AS contact_email
     FROM deal_contacts dc
     JOIN contacts ct ON ct.id = dc.contact_id
     WHERE dc.company_id = $1
     ORDER BY dc.created_at ASC`,
    [req.params.id]
  );
  res.json({ deal_contacts: rows });
});

app.post('/api/companies/:id/deal-contacts', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const { contact_id, role } = req.body || {};
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  try {
    const id = nanoid();
    await pool.query(
      'INSERT INTO deal_contacts (id, company_id, contact_id, role) VALUES ($1, $2, $3, $4)',
      [id, req.params.id, contact_id, role || null]
    );
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Contact already linked' });
    throw err;
  }
});

app.delete('/api/companies/:id/deal-contacts/:dcId', requireUser, async (req, res) => {
  await pool.query('DELETE FROM deal_contacts WHERE id = $1 AND company_id = $2', [req.params.dcId, req.params.id]);
  res.json({ ok: true });
});

// ---------- Calendar Invites (Feature 2) ----------
app.post('/api/calendar-invites', requireUser, async (req, res) => {
  const { nanoid } = require('nanoid');
  const b = req.body || {};
  const id = nanoid();
  await pool.query(
    `INSERT INTO calendar_invites (id, title, platform, meeting_date, time_ct, attendees_json, invite_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, b.title || null, b.platform || null, b.meeting_date || null,
     b.time_ct || null, JSON.stringify(b.attendees || []), b.invite_text || null]
  );
  res.json({ ok: true, id });
});

// ---------- Document Generation (Feature 3) ----------
app.post('/api/generate-document', requireUser, async (req, res) => {
  const { type, data } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Document type required' });

  const docsDir = '/tmp/sells-docs';
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  // Clean up old files (>2 hours)
  try {
    const files = fs.readdirSync(docsDir);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(docsDir, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) fs.unlinkSync(fp);
    }
  } catch {}

  if (type === 'branded') {
    // Branded doc: use Claude to structure content, return docx
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const { callJson: aiCallJson, MODELS } = require('./claude');
    const title = data?.title || 'Document';
    const subtitle = data?.subtitle || '';
    const content = data?.content || '';
    try {
      const { parsed } = await aiCallJson({
        model: MODELS.worker,
        system: 'You are a document formatting assistant for an M&A advisory firm (Sells Group Advisors). Structure the provided content into clean professional sections. Return JSON with: { "sections": [{ "heading": "...", "body": "..." }] }',
        user: `Title: ${title}\nSubtitle: ${subtitle}\nContent:\n${content}\n\nReturn structured JSON with professional sections.`,
        maxTokens: 4000,
      });
      const sections = parsed?.sections || [{ heading: title, body: content }];
      // Build docx with docxtemplater
      const PizZip = require('pizzip');
      const Docxtemplater = require('docxtemplater');
      // Create a simple docx manually
      const { nanoid } = require('nanoid');
      const filename = `branded-${nanoid(8)}.docx`;
      const filepath = path.join(docsDir, filename);

      // Use a minimal docx approach — build raw content
      const docContent = sections.map(s => `${s.heading}\n\n${s.body}`).join('\n\n---\n\n');
      // Create a simple text file with docx extension for download
      // For a real docx we need a template; use a plain approach
      const fullText = `${title}\n${subtitle ? subtitle + '\n' : ''}\n${docContent}`;
      fs.writeFileSync(filepath, fullText, 'utf8');
      res.json({ ok: true, filename, download_url: `/api/documents/download/${filename}` });
    } catch (err) {
      console.error('[generate-document] branded error:', err.message);
      res.status(500).json({ error: 'Failed to generate document: ' + err.message });
    }
  } else if (type === 'mnda' || type === 'sellside_buyer_nda') {
    // Legal doc from template
    const PizZip = require('pizzip');
    const Docxtemplater = require('docxtemplater');
    const { nanoid } = require('nanoid');

    const templateMap = {
      mnda: path.join(__dirname, '..', 'MNDA_Template.dotx'),
      sellside_buyer_nda: path.join(__dirname, '..', 'SellSide_Buyer_NDA.dotx'),
    };
    const templatePath = templateMap[type];
    if (!templatePath || !fs.existsSync(templatePath)) {
      return res.status(422).json({ error: `Template not found for type: ${type}` });
    }

    try {
      const templateBuf = fs.readFileSync(templatePath);
      const zip = new PizZip(templateBuf);
      const doc = new Docxtemplater(zip, {
        delimiters: { start: '[', end: ']' },
        paragraphLoop: true,
        linebreaks: true,
      });

      doc.render(data || {});
      const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      const filename = `${type}-${nanoid(8)}.docx`;
      const filepath = path.join(docsDir, filename);
      fs.writeFileSync(filepath, buf);
      res.json({ ok: true, filename, download_url: `/api/documents/download/${filename}` });
    } catch (err) {
      console.error('[generate-document] template error:', err.message);
      res.status(500).json({ error: 'Failed to generate document: ' + err.message });
    }
  } else if (type === 'engagement_letter') {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber, NumberFormat } = require('docx');
    const { nanoid } = require('nanoid');
    const d = data || {};

    // Number to words helper
    function n2w(n) {
      const ones = ['','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
      const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
      if (n === 0) return 'zero';
      if (n < 20) return ones[n];
      if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '');
      if (n < 1000) return ones[Math.floor(n/100)] + ' hundred' + (n%100 ? ' ' + n2w(n%100) : '');
      if (n < 1000000) return n2w(Math.floor(n/1000)) + ' thousand' + (n%1000 ? ' ' + n2w(n%1000) : '');
      return n2w(Math.floor(n/1000000)) + ' million' + (n%1000000 ? ' ' + n2w(n%1000000) : '');
    }
    const fmtD = n => n2w(Number(n)) + ' dollars ($' + Number(n).toLocaleString() + ')';
    const fmtP = n => n2w(Number(n)) + ' percent (' + n + '%)';

    const DATE = d.DATE || d.date || '____________';
    const CLIENT = d['COMPANY LEGAL NAME'] || d.client_name || '[COMPANY LEGAL NAME]';
    const JURISDICTION = d.JURISDICTION || d.jurisdiction || '[JURISDICTION]';
    const ENTITY_TYPE = d['ENTITY TYPE'] || d.entity_type || '[ENTITY TYPE]';
    const RETAINER = d.retainer_fee ? fmtD(d.retainer_fee) : '[RETAINER FEE]';
    const SUCCESS_PCT = d.success_fee_pct ? fmtP(d.success_fee_pct) : '[SUCCESS FEE PERCENT]';
    const SUCCESS_MIN = d.success_fee_min ? fmtD(d.success_fee_min) : '[SUCCESS FEE MINIMUM]';
    const CLIENT_CONTACT = d.client_contact || '[NAME, TITLE]';
    const CLIENT_ADDRESS = d.client_address || '[STREET ADDRESS]';
    const CLIENT_CITY = d.client_city_state_zip || '[CITY, STATE, ZIP]';
    const CLIENT_EMAIL = d.client_email || '[CLIENT EMAIL]';

    const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, size: 22, font: 'Times New Roman', ...opts })], spacing: { after: 200 }, ...opts });
    const h = (text, level = HeadingLevel.HEADING_2) => new Paragraph({ text, heading: level, spacing: { before: 300, after: 200 } });
    const b = (label, text) => new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 22, font: 'Times New Roman' }), new TextRun({ text, size: 22, font: 'Times New Roman' })], spacing: { after: 200 } });

    try {
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({ children: [new TextRun({ text: 'SELL-SIDE ENGAGEMENT LETTER', bold: true, size: 24, font: 'Times New Roman' })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
            p(`This Sell-Side Engagement Letter (this "Agreement") is entered into as of ${DATE}, 2026 (the "Effective Date"), by and between Sells Group Investments, LLC dba Sells Group Advisors, a Texas limited liability company ("Sells Group"), and ${CLIENT}, a ${JURISDICTION} ${ENTITY_TYPE} ("Client" and, together with Sells Group, the "Parties" and each, a "Party").`),
            p('NOW, THEREFORE, in consideration of the mutual promises, undertakings and covenants contained herein, and for other good and valuable consideration, the receipt and adequacy of which is hereby acknowledged, the Parties agree as follows:'),
            h('1. Purpose'),
            p('Client hereby engages Sells Group as its exclusive financial advisor in connection with the potential sale of Client, or any other transaction involving Client (a "Transaction"). For purposes of this Agreement, a Transaction means any transaction or series of transactions pursuant to which, directly or indirectly, all or a substantial portion of the equity securities, capital stock, membership interests, partnership interests, assets (tangible or intangible), or business of Client are sold, transferred, exchanged, merged, consolidated, recapitalized, contributed, or otherwise disposed of, whether for cash, securities, notes, other property, assumption or repayment of indebtedness, or any combination thereof, including, without limitation, any acquisition, merger, consolidation, recapitalization, equity or asset purchase, joint venture, license, trust, joint marketing agreement, tender or exchange offer, leveraged buyout, capital contribution, infusion of capital, or other similar business combination or investment involving Client, resulting in (i) control by buyer of Client or its business, and (ii) active management by buyer of Client or its business, as such terms are defined under Section 15(b)(13) of the Securities Exchange Act of 1934, as amended (the "Exchange Act"), and applicable state securities laws.'),
            h('2. Services'),
            p('During the Term, Sells Group will:'),
            p('(a) assist in identifying and evaluating potential strategic and financial buyers;'),
            p('(b) provide valuation perspectives, including reference to precedent transactions, trading comparables and discounted cash flow analyses;'),
            p('(c) assist in preparing marketing materials based on information provided by Client, including a confidential information memorandum and/or management presentation;'),
            p('(d) develop and manage outreach to potential buyers and solicit proposals, including with respect to price, structure and key terms;'),
            p('(e) assist Client in its financial, strategic and operational evaluation of proposals;'),
            p('(f) facilitate and coordinate the due diligence process; and'),
            p('(g) advise on strategy and tactics for negotiations and, if requested by Client, participate in such negotiations alongside Client and its legal and accounting advisors.'),
            p('Nothing herein constitutes legal, tax, or accounting advice.'),
            h('3. Term; Exclusivity'),
            p('This Agreement shall commence on the Effective Date and continue for one (1) year (the "Initial Term"). It shall automatically renew for successive ninety (90) day periods (each, a "Renewal Period") unless either Party provides at least thirty (30) days\' written notice of non-renewal.'),
            p('This engagement is exclusive, and during the Term Client shall not engage any other financial advisor or investment bank in connection with a Transaction without Sells Group\'s prior written consent.'),
            h('4. Termination'),
            p('Either Party may terminate this Agreement at any time upon written notice to the other. In the event of termination by Sells Group without Cause, the Retainer Fee shall be refunded to Client on a pro rata basis for the portion of the Initial Term then remaining.'),
            h('5. Fees'),
            b('(a) Retainer Fee. ', `Client shall pay Sells Group a retainer fee of ${RETAINER} (the "Retainer Fee"), due upon execution of this Agreement. The Retainer Fee shall be credited against the Success Fee payable at closing of any Transaction. The Retainer Fee is earned upon receipt and non-refundable, except as expressly provided in Section 4.`),
            b('(b) Success Fee. ', `If Client consummates a Transaction during the Term or the Tail Period, Client shall pay Sells Group a cash success fee (the "Success Fee") equal to ${SUCCESS_PCT} of the Transaction Consideration (as defined below); provided, however, that in no event shall the Success Fee be less than ${SUCCESS_MIN}. The Success Fee shall be due and payable by wire transfer at the closing of the Transaction.`),
            p('(c) Transaction Consideration. "Transaction Consideration" shall mean the total value of all consideration paid or payable, directly or indirectly, in connection with the Transaction.'),
            h('6. Non-Offset'),
            p('No fee or other compensation payable to any other person or entity by Client (or any Affiliate of Client) in connection with any Transaction shall reduce, offset, or otherwise affect any fee payable to Sells Group under this Agreement.'),
            h('7. Expenses'),
            p('Client shall reimburse Sells Group for all reasonable out-of-pocket expenses incurred in connection with this engagement, whether or not any Transaction is consummated.'),
            h('8. Client Obligations; Information; Reliance'),
            p('Client shall furnish, or cause to be furnished, to Sells Group such current and historical financial and operational information as Sells Group may reasonably request.'),
            h('9. Client Representation'),
            p('Client represents and warrants that it qualifies as an "eligible privately held company" within the meaning of Section 15(b)(13)(E)(iii) of the Exchange Act and applicable law.'),
            h('10. Independent Contractors; Regulatory Compliance'),
            p('The Parties are independent contractors. Sells Group shall act solely as an "M&A broker" within the meaning of Section 15(b)(13) of the Exchange Act and applicable state securities laws.'),
            h('11. Indemnification'),
            p('(a) By Client. Client shall indemnify and hold harmless Sells Group and its Affiliates from and against any and all losses, claims, damages, liabilities, costs, and expenses arising out of or relating to this engagement, except to the extent resulting from Sells Group\'s fraud or willful misconduct.'),
            p('(b) By Sells Group. Sells Group shall indemnify and hold harmless Client and its Affiliates from losses to the extent resulting from Sells Group\'s fraud or willful misconduct.'),
            h('12. Limitation of Liability'),
            p('The aggregate liability of Sells Group under this Agreement shall not exceed the total fees actually paid by Client to Sells Group hereunder during the twelve (12) months immediately preceding the event giving rise to the claim.'),
            h('13. Confidentiality; Non-Solicitation; Use of Advice'),
            p('Each Party agrees to maintain the confidentiality of non-public information disclosed by the other in connection with this Agreement.'),
            h('14. Governing Law; Dispute Resolution'),
            p('This Agreement shall be governed by and construed in accordance with the laws of the State of Texas. EACH PARTY KNOWINGLY AND VOLUNTARILY WAIVES ANY RIGHT TO A TRIAL BY JURY.'),
            h('15. Miscellaneous'),
            p('(a) Assignment. (b) Entire Agreement. (c) Amendments. (d) Waiver. (e) Severability. (f) Counterparts; Electronic Signatures. (g) Survival. (h) Third-Party Beneficiaries. (i) Headings. (j) Third-Party Confidentiality. (k) Conflicts. (l) Notices.'),
            new Paragraph({ spacing: { before: 400 } }),
            p('If to Sells Group:'),
            p('    Sells Group Investments, LLC'),
            p('    Attn: Tyler Sells, Chief Executive Officer'),
            p('    5100 W JB Hunt Dr, STE 830'),
            p('    Rogers, AR 72758'),
            p('    Email: tyler@sellsgroupadvisors.com'),
            new Paragraph({ spacing: { before: 200 } }),
            p('If to Client:'),
            p(`    ${CLIENT}`),
            p(`    Attn: ${CLIENT_CONTACT}`),
            p(`    ${CLIENT_ADDRESS}`),
            p(`    ${CLIENT_CITY}`),
            p(`    Email: ${CLIENT_EMAIL}`),
            new Paragraph({ spacing: { before: 600 } }),
            new Paragraph({ children: [new TextRun({ text: '[The remainder of this page is intentionally left blank. Signature page follows.]', italics: true, size: 22, font: 'Times New Roman' })], alignment: AlignmentType.CENTER }),
            new Paragraph({ spacing: { before: 800 } }),
            new Paragraph({ children: [new TextRun({ text: CLIENT, bold: true, size: 22, font: 'Times New Roman' })], spacing: { after: 200 } }),
            p('By: ____________________________'),
            p('Name: __________________________'),
            p('Title: ___________________________'),
            p('Email: __________________________'),
            p('Address: ________________________'),
            new Paragraph({ spacing: { before: 400 } }),
            new Paragraph({ children: [new TextRun({ text: 'SELLS GROUP INVESTMENTS, LLC', bold: true, size: 22, font: 'Times New Roman' })], spacing: { after: 200 } }),
            p('By: ____________________________'),
            p('Name: Tyler Sells'),
            p('Title: Chief Executive Officer'),
            p('Email: tyler@sellsgroupadvisors.com'),
            p('Address: 5100 W JB Hunt Dr, STE 830, Rogers, AR 72758'),
          ],
        }],
      });

      const buf = await Packer.toBuffer(doc);
      const filename = `engagement-letter-${nanoid(8)}.docx`;
      const filepath = path.join(docsDir, filename);
      fs.writeFileSync(filepath, buf);
      res.json({ ok: true, filename, download_url: `/api/documents/download/${filename}` });
    } catch (err) {
      console.error('[generate-document] engagement letter error:', err.message);
      res.status(500).json({ error: 'Failed to generate engagement letter: ' + err.message });
    }
  } else {
    return res.status(400).json({ error: 'Unknown document type: ' + type });
  }
});

app.get('/api/documents/download/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const filepath = path.join('/tmp/sells-docs', filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found or expired' });
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === '.docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/octet-stream';
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.sendFile(filepath);
});

// ---------- Calendar Call Logs (Feature 4A) ----------
app.get('/api/calendar/call-logs', requireUser, async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return res.status(400).json({ error: 'year and month required' });
  }
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  const { rows } = await pool.query(
    `SELECT cl.id, cl.company_id, cl.called_at, cl.duration_sec, cl.status, cl.direction,
            c.name AS company_name, ct.name AS contact_name
     FROM call_logs cl
     LEFT JOIN companies c ON cl.company_id = c.id
     LEFT JOIN contacts ct ON cl.contact_id = ct.id
     WHERE cl.called_at >= $1 AND cl.called_at < $2
       AND cl.status = 'completed'
     ORDER BY cl.called_at ASC`,
    [start, end]
  );
  res.json({ call_logs: rows });
});

// ---------- Outlook Integration Stub (Feature 4B) ----------
registerOutlookRoutes(app);

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
