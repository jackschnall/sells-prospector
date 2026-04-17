const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// ─── Connection ──────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL || '';
// Railway internal connections (*.railway.internal) don't use SSL.
// Railway public proxy connections (*.proxy.rlwy.net) do.
const needsSsl = dbUrl.includes('proxy.rlwy.net') || (dbUrl.includes('railway') && !dbUrl.includes('railway.internal'));

const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function execute(text, params = []) {
  const res = await pool.query(text, params);
  return res;
}

async function queryOne(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function query(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

// ─── Schema bootstrap ────────────────────────────────────────────────────────

async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ─── Config ──────────────────────────────────────────────────────────────────

async function getConfig(key, fallback = null) {
  const row = await queryOne('SELECT value FROM config WHERE key = $1', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

async function setConfig(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  await execute(
    `INSERT INTO config (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, v]
  );
}

// ─── Companies ───────────────────────────────────────────────────────────────

async function insertCompany(row) {
  await execute(
    `INSERT INTO companies (
       id, name, name_key, city, state, phone, website, owner, email, address,
       crm_known, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, 'pending', NOW(), NOW()
     )
     ON CONFLICT(name_key) DO UPDATE SET
       city = COALESCE(EXCLUDED.city, companies.city),
       state = COALESCE(EXCLUDED.state, companies.state),
       phone = COALESCE(EXCLUDED.phone, companies.phone),
       website = COALESCE(EXCLUDED.website, companies.website),
       owner = COALESCE(EXCLUDED.owner, companies.owner),
       email = COALESCE(EXCLUDED.email, companies.email),
       address = COALESCE(EXCLUDED.address, companies.address),
       crm_known = EXCLUDED.crm_known,
       updated_at = NOW()`,
    [
      row.id, row.name, row.name_key, row.city || null, row.state || null,
      row.phone || null, row.website || null, row.owner || null,
      row.email || null, row.address || null, row.crm_known || false,
    ]
  );
}

async function markCrmKnown(knownNames) {
  const normalized = knownNames.map(normalizeName).filter(Boolean);
  await execute('UPDATE companies SET crm_known = FALSE');
  if (normalized.length === 0) return 0;
  const placeholders = normalized.map((_, i) => `$${i + 1}`).join(',');
  const res = await execute(
    `UPDATE companies SET crm_known = TRUE WHERE name_key IN (${placeholders})`,
    normalized
  );
  return res.rowCount;
}

async function listCompanies({ tier, crmKnown, search, sort = 'score_desc', stateFilter, outreachStatus, pipelineStage, industry } = {}) {
  const where = [];
  const params = [];
  let idx = 1;
  if (tier) {
    where.push(`tier = $${idx++}`);
    params.push(tier);
  }
  if (crmKnown === 'true') where.push('crm_known = TRUE');
  if (crmKnown === 'false') where.push('crm_known = FALSE');
  if (search) {
    where.push(`(LOWER(name) LIKE $${idx} OR LOWER(city) LIKE $${idx} OR LOWER(state) LIKE $${idx})`);
    params.push(`%${String(search).toLowerCase()}%`);
    idx++;
  }
  if (stateFilter) {
    where.push(`UPPER(state) = $${idx++}`);
    params.push(String(stateFilter).toUpperCase());
  }
  if (pipelineStage) {
    where.push(`pipeline_stage = $${idx++}`);
    params.push(pipelineStage);
  } else if (outreachStatus) {
    where.push(`outreach_status = $${idx++}`);
    params.push(outreachStatus);
  }
  if (industry) {
    const industries = String(industry).split(',').map((s) => s.trim()).filter(Boolean);
    if (industries.length) {
      const placeholders = industries.map((_, i) => `$${idx + i}`).join(', ');
      where.push(`COALESCE(industry, 'Plumbing') IN (${placeholders})`);
      params.push(...industries);
      idx += industries.length;
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderMap = {
    score_desc: 'score DESC NULLS LAST, name ASC',
    score_asc: 'score ASC NULLS LAST, name ASC',
    name_asc: 'name ASC',
    name_desc: 'name DESC',
    tier: "CASE tier WHEN 'strong-buy' THEN 1 WHEN 'watchlist' THEN 2 WHEN 'pass' THEN 3 ELSE 4 END, score DESC",
    revenue_desc: "COALESCE((signals_json->'revenue_proxy'->>'score')::NUMERIC, (signals_json->>'revenue_proxy')::NUMERIC) DESC NULLS LAST, score DESC",
    succession_desc: "COALESCE((signals_json->'succession_signal'->>'score')::NUMERIC, (signals_json->>'succession_signal')::NUMERIC) DESC NULLS LAST, score DESC",
    state_asc: 'state ASC NULLS LAST, city ASC, name ASC',
    city_asc: 'city ASC NULLS LAST, state ASC, name ASC',
    recent: 'last_researched_at DESC NULLS LAST, updated_at DESC',
    outreach: "CASE outreach_status WHEN 'relationship' THEN 1 WHEN 'initial_contact' THEN 2 ELSE 3 END, score DESC",
    pipeline: "CASE pipeline_stage WHEN 'deal_closed' THEN 1 WHEN 'lois_collected' THEN 2 WHEN 'engagement_letter' THEN 3 WHEN 'pitch' THEN 4 WHEN 'lead_memo' THEN 5 WHEN 'nurture' THEN 6 WHEN 'initial_contact' THEN 7 WHEN 'no_contact' THEN 8 WHEN 'closed_lost' THEN 9 ELSE 10 END, score DESC",
  };
  const orderBy = orderMap[sort] || orderMap.score_desc;

  return query(`SELECT * FROM companies ${whereSql} ORDER BY ${orderBy}`, params);
}

async function getCompany(id) {
  return queryOne('SELECT * FROM companies WHERE id = $1', [id]);
}

async function updateCompanyResearch(id, data) {
  await execute(
    `UPDATE companies SET
       status = $1,
       score = $2,
       tier = $3,
       signals_json = $4,
       flags_json = $5,
       summary = $6,
       outreach_angle = $7,
       sources_json = $8,
       raw_research = $9,
       owner = COALESCE($10, owner),
       phone = COALESCE($11, phone),
       email = COALESCE($12, email),
       address = COALESCE($13, address),
       linkedin = COALESCE($14, linkedin),
       contact_enrichment = COALESCE($15, contact_enrichment),
       last_researched_at = NOW(),
       updated_at = NOW()
     WHERE id = $16`,
    [
      data.status, data.score, data.tier,
      data.signals_json || null, data.flags_json || null,
      data.summary || null, data.outreach_angle || null,
      data.sources_json || null, data.raw_research || null,
      data.owner || null, data.phone || null, data.email || null,
      data.address || null, data.linkedin || null,
      data.contact_enrichment || null, id,
    ]
  );
}

async function setCompanyStatus(id, status, rawError = null) {
  await execute(
    `UPDATE companies SET status = $1, raw_research = COALESCE($2, raw_research), updated_at = NOW() WHERE id = $3`,
    [status, rawError, id]
  );
}

async function setCompanyOverride(id, override) {
  await execute('UPDATE companies SET crm_override = $1 WHERE id = $2', [!!override, id]);
}

async function markOutreach(id, marked) {
  await execute('UPDATE companies SET marked_for_outreach = $1 WHERE id = $2', [!!marked, id]);
}

async function setOutreachStatus(id, outreachStatus) {
  await execute(
    "UPDATE companies SET outreach_status = $1, updated_at = NOW() WHERE id = $2",
    [outreachStatus, id]
  );
}

// ─── Notes (legacy) ──────────────────────────────────────────────────────────

async function addNote(companyId, text) {
  const { nanoid } = require('nanoid');
  const id = nanoid();
  await execute(
    'INSERT INTO notes (id, company_id, note) VALUES ($1, $2, $3)',
    [id, companyId, text]
  );
  return { id, company_id: companyId, note: text };
}

async function getNotes(companyId) {
  return query(
    'SELECT * FROM notes WHERE company_id = $1 ORDER BY created_at DESC',
    [companyId]
  );
}

// ─── Stats ───────────────────────────────────────────────────────────────────

async function rollupStats() {
  const total = (await queryOne('SELECT COUNT(*) AS n FROM companies')).n;
  const researched = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE status = 'done'")).n;
  const strongBuy = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE tier = 'strong-buy'")).n;
  const watchlist = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE tier = 'watchlist'")).n;
  const pass = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE tier = 'pass'")).n;
  const inCrm = (await queryOne('SELECT COUNT(*) AS n FROM companies WHERE crm_known = TRUE')).n;
  const pending = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE status = 'pending'")).n;
  const outreachNoContact = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'no_contact' AND status = 'done'")).n;
  const outreachContacted = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'initial_contact'")).n;
  const outreachRelationship = (await queryOne("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'relationship'")).n;
  return {
    total: Number(total), researched: Number(researched),
    strongBuy: Number(strongBuy), watchlist: Number(watchlist), pass: Number(pass),
    inCrm: Number(inCrm), pending: Number(pending),
    outreachNoContact: Number(outreachNoContact),
    outreachContacted: Number(outreachContacted),
    outreachRelationship: Number(outreachRelationship),
  };
}

async function companiesToResearch() {
  return query(
    `SELECT * FROM companies
     WHERE status IN ('pending', 'error')
       AND (crm_known = FALSE OR crm_override = TRUE)
     ORDER BY created_at ASC`
  );
}

// ─── Markets ─────────────────────────────────────────────────────────────────

async function upsertMarket(row) {
  await execute(
    `INSERT INTO markets (
       key, city, state, population, msa_name, addressable, loaded,
       tier, score, confidence, sources_json, analyzed_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, NOW(), NOW()
     )
     ON CONFLICT(key) DO UPDATE SET
       city = EXCLUDED.city,
       state = EXCLUDED.state,
       population = EXCLUDED.population,
       msa_name = EXCLUDED.msa_name,
       addressable = EXCLUDED.addressable,
       loaded = EXCLUDED.loaded,
       tier = EXCLUDED.tier,
       score = EXCLUDED.score,
       confidence = EXCLUDED.confidence,
       sources_json = EXCLUDED.sources_json,
       updated_at = NOW()`,
    [
      row.key, row.city, row.state, row.population || null,
      row.msa_name || null, row.addressable || null, row.loaded || null,
      row.tier || null, row.score || null, row.confidence || null,
      row.sources_json || null,
    ]
  );
}

async function getMarket(key) {
  return queryOne('SELECT * FROM markets WHERE key = $1', [key]);
}

async function listMarkets() {
  return query(
    `SELECT * FROM markets
     ORDER BY
       CASE tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END,
       score DESC,
       population DESC`
  );
}

async function countCompaniesInMarket(city, state) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM companies
     WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))
       AND UPPER(TRIM(state)) = UPPER(TRIM($2))`,
    [city || '', state || '']
  );
  return row ? Number(row.n) : 0;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  'no_contact',
  'initial_contact',
  'nurture',
  'lead_memo',
  'pitch',
  'engagement_letter',
  'lois_collected',
  'deal_closed',
  'closed_lost',
];

const CLOSED_LOST_REASONS = ['no_interest', 'bad_timing', 'ineligible'];

async function updatePipelineStage(companyId, stage, closedLostReason = null, userId = null) {
  const { nanoid } = require('nanoid');
  const company = await getCompany(companyId);
  if (!company) return null;
  const oldStage = company.pipeline_stage || 'no_contact';
  await execute(
    `UPDATE companies SET
       pipeline_stage = $1,
       closed_lost_reason = $2,
       pipeline_stage_changed_at = NOW(),
       updated_at = NOW()
     WHERE id = $3`,
    [stage, stage === 'closed_lost' ? closedLostReason : null, companyId]
  );
  // Auto-log stage change activity
  const summary = stage === 'closed_lost'
    ? `Stage: ${formatStage(oldStage)} → ${formatStage(stage)} (${formatReason(closedLostReason)})`
    : `Stage: ${formatStage(oldStage)} → ${formatStage(stage)}`;
  await execute(
    `INSERT INTO activities (id, company_id, user_id, type, summary)
     VALUES ($1, $2, $3, 'stage_change', $4)`,
    [nanoid(), companyId, userId, summary]
  );
  return { ok: true };
}

function formatStage(s) {
  const map = {
    no_contact: 'No Contact',
    initial_contact: 'Initial Contact',
    nurture: 'Nurture',
    lead_memo: 'Lead Memo / Books & Records',
    pitch: 'Pitch',
    engagement_letter: 'Engagement Letter Signed',
    lois_collected: "LOI's Collected",
    deal_closed: 'Deal Closed',
    closed_lost: 'Closed/Lost',
  };
  return map[s] || s;
}

function formatReason(r) {
  const map = { no_interest: 'No Interest', bad_timing: 'Bad Timing', ineligible: 'Ineligible' };
  return map[r] || r || '';
}

async function getPipelineBoard() {
  const rows = await query(
    `SELECT id, name, score, tier, owner, pipeline_stage, closed_lost_reason,
            pipeline_stage_changed_at, city, state, assigned_to
     FROM companies
     WHERE status = 'done' OR pipeline_stage != 'no_contact'
     ORDER BY score DESC NULLS LAST, name ASC`
  );
  const board = {};
  for (const stage of PIPELINE_STAGES) board[stage] = [];
  for (const r of rows) {
    const stage = r.pipeline_stage || 'no_contact';
    if (board[stage]) board[stage].push(r);
    else board.no_contact.push(r);
  }
  return board;
}

// ─── Contacts ────────────────────────────────────────────────────────────────

async function listContacts(companyId) {
  return query(
    'SELECT * FROM contacts WHERE company_id = $1 ORDER BY is_primary DESC, created_at ASC',
    [companyId]
  );
}

/**
 * List ALL contacts with their company info joined in (for the global Contacts tab).
 * Supports a loose `search` term matched against name/title/email/phone/company name.
 */
async function listAllContacts({ search = '', limit = 500, offset = 0 } = {}) {
  const params = [];
  let where = '';
  const s = String(search || '').trim();
  if (s) {
    params.push(`%${s.toLowerCase()}%`);
    where = `WHERE LOWER(ct.name) LIKE $1
             OR LOWER(COALESCE(ct.title, '')) LIKE $1
             OR LOWER(COALESCE(ct.email, '')) LIKE $1
             OR LOWER(COALESCE(ct.phone, '')) LIKE $1
             OR LOWER(COALESCE(c.name, '')) LIKE $1`;
  }
  params.push(limit, offset);
  const limIdx = params.length - 1;
  const offIdx = params.length;
  return query(
    `SELECT
        ct.*,
        c.name   AS company_name,
        c.city   AS company_city,
        c.state  AS company_state,
        c.tier   AS company_tier,
        c.score  AS company_score
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     ${where}
     ORDER BY ct.updated_at DESC NULLS LAST, ct.created_at DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );
}

async function getContact(id) {
  return queryOne('SELECT * FROM contacts WHERE id = $1', [id]);
}

async function insertContact(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  // Enforce single primary per company
  if (data.is_primary && data.company_id) {
    await execute('UPDATE contacts SET is_primary = FALSE WHERE company_id = $1 AND is_primary = TRUE', [data.company_id]);
  }
  await execute(
    `INSERT INTO contacts (id, company_id, name, title, phone, email, linkedin, is_primary, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id, data.company_id, data.name,
      data.title || null, data.phone || null, data.email || null,
      data.linkedin || null, data.is_primary ? true : false,
      data.source || 'manual', data.notes || null,
    ]
  );
  return { id, ...data };
}

async function updateContact(id, data) {
  // Enforce single primary per company
  if (data.is_primary) {
    const existing = await queryOne('SELECT company_id FROM contacts WHERE id = $1', [id]);
    const companyId = data.company_id || existing?.company_id;
    if (companyId) {
      await execute('UPDATE contacts SET is_primary = FALSE WHERE company_id = $1 AND is_primary = TRUE AND id != $2', [companyId, id]);
    }
  }
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['company_id', 'name', 'title', 'phone', 'email', 'linkedin', 'is_primary', 'notes']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(key === 'is_primary' ? !!data[key] : data[key]);
    }
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = NOW()`);
  params.push(id);
  await execute(`UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function deleteContact(id) {
  await execute('DELETE FROM contacts WHERE id = $1', [id]);
}

// ─── Activities ──────────────────────────────────────────────────────────────

async function listActivities(companyId, { limit = 50, offset = 0 } = {}) {
  return query(
    `SELECT a.*, u.name AS user_name, c.name AS contact_name
     FROM activities a
     LEFT JOIN users u ON a.user_id = u.id
     LEFT JOIN contacts c ON a.contact_id = c.id
     WHERE a.company_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2 OFFSET $3`,
    [companyId, limit, offset]
  );
}

async function insertActivity(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO activities (id, company_id, contact_id, user_id, type, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id, data.company_id, data.contact_id || null,
      data.user_id || null, data.type, data.summary, data.details || null,
    ]
  );
  return { id, ...data };
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function getUserByToken(token) {
  return queryOne('SELECT * FROM users WHERE invite_token = $1', [token]);
}

async function getUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = $1', [id]);
}

async function getUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [email]);
}

async function createUser(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO users (id, name, email, invite_token)
     VALUES ($1, $2, $3, $4)`,
    [id, data.name, data.email, data.invite_token || null]
  );
  return { id, name: data.name, email: data.email };
}

async function listUsers() {
  return query('SELECT id, name, email, created_at FROM users ORDER BY created_at ASC');
}

async function clearInviteToken(userId) {
  await execute('UPDATE users SET invite_token = NULL WHERE id = $1', [userId]);
}

async function updateUser(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['name', 'role', 'assigned_verticals', 'assigned_territories']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (key === 'assigned_verticals' || key === 'assigned_territories') {
        params.push(JSON.stringify(data[key] || []));
      } else {
        params.push(data[key]);
      }
    }
  }
  if (fields.length === 0) return;
  params.push(id);
  await execute(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function listUsersFull() {
  return query(
    `SELECT id, name, email, role, assigned_verticals, assigned_territories,
            invite_token, created_at
     FROM users ORDER BY created_at ASC`
  );
}

// ─── Call Logs (Phase 2) ─────────────────────────────────────────────────────

async function insertCallLog(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO call_logs (
       id, company_id, contact_id, user_id, direction, status,
       call_sid, mock, called_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      id, data.company_id, data.contact_id || null, data.user_id || null,
      data.direction || 'outbound', data.status || 'initiated',
      data.call_sid || null, !!data.mock,
    ]
  );
  return id;
}

async function updateCallLog(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  const assignable = [
    'call_sid', 'recording_sid', 'recording_url', 'status',
    'duration_sec', 'disposition', 'notes',
    'transcript', 'ai_summary', 'sentiment',
    'scheduling_detected', 'scheduled_callback_date',
    'next_action', 'outreach_angle_refined',
    'debrief_status', 'debrief_qa', 'debrief_questions', 'debrief_draft',
  ];
  for (const key of assignable) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (['ai_summary', 'debrief_qa', 'debrief_questions', 'debrief_draft'].includes(key)) {
        params.push(data[key] === null ? null : JSON.stringify(data[key]));
      } else {
        params.push(data[key]);
      }
    }
  }
  if (fields.length === 0) return;
  params.push(id);
  await execute(`UPDATE call_logs SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function getCallLog(id) {
  return queryOne('SELECT * FROM call_logs WHERE id = $1', [id]);
}

async function getCallLogBySid(callSid) {
  return queryOne('SELECT * FROM call_logs WHERE call_sid = $1', [callSid]);
}

async function listCallLogsByCompany(companyId, { limit = 100 } = {}) {
  return query(
    `SELECT cl.*, u.name AS user_name, c.name AS contact_name
     FROM call_logs cl
     LEFT JOIN users u ON cl.user_id = u.id
     LEFT JOIN contacts c ON cl.contact_id = c.id
     WHERE cl.company_id = $1
     ORDER BY cl.called_at DESC
     LIMIT $2`,
    [companyId, limit]
  );
}

async function listPendingDebriefs(userId) {
  return query(
    `SELECT cl.id, cl.company_id, cl.called_at, cl.duration_sec,
            cl.debrief_status, c.name AS company_name, c.owner AS owner_name
     FROM call_logs cl
     LEFT JOIN companies c ON cl.company_id = c.id
     WHERE cl.user_id = $1
       AND cl.debrief_status IN ('pending', 'draft')
     ORDER BY cl.called_at ASC`,
    [userId]
  );
}

// ─── Calendar (Phase 2) ──────────────────────────────────────────────────────

async function insertCalendarEvent(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO calendar_events (
       id, company_id, contact_id, user_id, title, description,
       event_type, starts_at, ends_at, location,
       source, transcript_quote, completed, call_log_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id, data.company_id || null, data.contact_id || null, data.user_id || null,
      data.title, data.description || null,
      data.event_type || 'callback', data.starts_at, data.ends_at || null,
      data.location || null,
      data.source || 'manual', data.transcript_quote || null,
      !!data.completed, data.call_log_id || null,
    ]
  );
  return id;
}

async function updateCalendarEvent(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['title', 'description', 'starts_at', 'ends_at', 'company_id', 'contact_id', 'completed']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(key === 'completed' ? !!data[key] : data[key]);
    }
  }
  if (fields.length === 0) return;
  params.push(id);
  await execute(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function deleteCalendarEvent(id) {
  await execute('DELETE FROM calendar_events WHERE id = $1', [id]);
}

async function getCalendarEvent(id) {
  return queryOne(
    `SELECT ce.*, c.name AS company_name, c.owner AS company_owner
     FROM calendar_events ce
     LEFT JOIN companies c ON ce.company_id = c.id
     WHERE ce.id = $1`,
    [id]
  );
}

async function listCalendarEventsForMonth({ year, month, userId, isAdmin, territories }) {
  // Build date range: first day of month → first day of next month
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const params = [start, end];
  let where = `ce.starts_at >= $1 AND ce.starts_at < $2`;
  let idx = 3;
  if (!isAdmin) {
    // Analyst: sees own events + events for companies in their territory
    const terrs = Array.isArray(territories) ? territories : [];
    const terrUpper = terrs.map((t) => String(t).toUpperCase());
    where += ` AND (ce.user_id = $${idx++}`;
    params.push(userId);
    if (terrUpper.length) {
      where += ` OR UPPER(c.state) = ANY($${idx++}::text[])`;
      params.push(terrUpper);
    }
    where += `)`;
  }
  return query(
    `SELECT ce.*, c.name AS company_name, c.owner AS company_owner, c.state AS company_state
     FROM calendar_events ce
     LEFT JOIN companies c ON ce.company_id = c.id
     WHERE ${where}
     ORDER BY ce.starts_at ASC`,
    params
  );
}

// ─── Queue Skips (Phase 2) ───────────────────────────────────────────────────

async function insertQueueSkip(userId, companyId) {
  await execute(
    `INSERT INTO queue_skips (user_id, company_id, skipped_on)
     VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT DO NOTHING`,
    [userId, companyId]
  );
}

async function listQueueSkipsForToday(userId) {
  const rows = await query(
    `SELECT company_id FROM queue_skips
     WHERE user_id = $1 AND skipped_on = CURRENT_DATE`,
    [userId]
  );
  return rows.map((r) => r.company_id);
}

// ─── User-scoped config (namespaced into existing config table) ──────────────

async function getUserConfig(userId, key, fallback = null) {
  return getConfig(`user:${userId}:${key}`, fallback);
}

async function setUserConfig(userId, key, value) {
  return setConfig(`user:${userId}:${key}`, value);
}

// ─── User outreach stats (Phase 2) ───────────────────────────────────────────

/**
 * Aggregate outreach stats for a user within a time range.
 * @param {string} userId
 * @param {'today'|'week'|'all'} range
 */
async function getUserStats(userId, range = 'today') {
  let rangeClause = '';
  if (range === 'today') {
    rangeClause = `AND called_at >= date_trunc('day', NOW())`;
  } else if (range === 'week') {
    rangeClause = `AND called_at >= date_trunc('week', NOW())`;
  }

  const callRows = await query(
    `SELECT
       COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls,
       COUNT(*) FILTER (WHERE direction = 'inbound')::int  AS inbound_calls,
       COALESCE(SUM(COALESCE(duration_sec, 0)), 0)::int    AS total_talk_sec,
       COUNT(*) FILTER (WHERE sentiment = 'Receptive')::int AS receptive_count,
       COUNT(*) FILTER (WHERE scheduling_detected = TRUE)::int AS meetings_booked
     FROM call_logs
     WHERE user_id = $1 ${rangeClause}`,
    [userId]
  );

  let actRangeClause = '';
  if (range === 'today') {
    actRangeClause = `AND created_at >= date_trunc('day', NOW())`;
  } else if (range === 'week') {
    actRangeClause = `AND created_at >= date_trunc('week', NOW())`;
  }

  const actRows = await query(
    `SELECT
       COUNT(*) FILTER (WHERE type = 'email')::int   AS emails_sent,
       COUNT(*) FILTER (WHERE type IN ('sms','text'))::int AS texts_sent,
       COUNT(*) FILTER (WHERE type = 'meeting')::int AS meetings_logged
     FROM activities
     WHERE user_id = $1 ${actRangeClause}`,
    [userId]
  );

  const c = callRows[0] || {};
  const a = actRows[0] || {};
  return {
    range,
    outbound_calls: c.outbound_calls || 0,
    inbound_calls: c.inbound_calls || 0,
    total_talk_sec: c.total_talk_sec || 0,
    receptive_count: c.receptive_count || 0,
    meetings_booked: c.meetings_booked || 0,
    emails_sent: a.emails_sent || 0,
    texts_sent: a.texts_sent || 0,
    meetings_logged: a.meetings_logged || 0,
  };
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

async function listCampaigns() {
  return query(`
    SELECT c.*, u.name AS creator_name,
      (SELECT COUNT(*)::int FROM campaign_recipients cr WHERE cr.campaign_id = c.id) AS recipient_count,
      (SELECT COUNT(*)::int FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'sent') AS sent_count
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.created_at DESC
  `);
}

async function getCampaign(id) {
  return queryOne('SELECT * FROM campaigns WHERE id = $1', [id]);
}

async function insertCampaign(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO campaigns (id, name, subject_template, body_template, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, data.name, data.subject_template || '', data.body_template || '', data.created_by || null]
  );
  return id;
}

async function updateCampaign(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['name', 'subject_template', 'body_template', 'status', 'sent_at']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return;
  fields.push(`updated_at = NOW()`);
  params.push(id);
  await execute(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function deleteCampaign(id) {
  await execute('DELETE FROM campaigns WHERE id = $1', [id]);
}

async function listCampaignRecipients(campaignId) {
  return query(`
    SELECT cr.*, c.name AS company_name, c.owner, c.email AS company_email,
      c.city, c.state, c.phone, c.score, c.tier, c.summary, c.outreach_angle
    FROM campaign_recipients cr
    JOIN companies c ON c.id = cr.company_id
    WHERE cr.campaign_id = $1
    ORDER BY c.name
  `, [campaignId]);
}

async function addCampaignRecipients(campaignId, companyIds) {
  const { nanoid } = require('nanoid');
  let added = 0;
  for (const companyId of companyIds) {
    try {
      await execute(
        `INSERT INTO campaign_recipients (id, campaign_id, company_id, to_email)
         SELECT $1, $2, $3, COALESCE(
           (SELECT ct.email FROM contacts ct WHERE ct.company_id = $3 AND ct.is_primary = TRUE AND ct.email IS NOT NULL LIMIT 1),
           c.email
         )
         FROM companies c WHERE c.id = $3
         ON CONFLICT (campaign_id, company_id) DO NOTHING`,
        [nanoid(), campaignId, companyId]
      );
      added++;
    } catch {}
  }
  return added;
}

async function removeCampaignRecipient(campaignId, companyId) {
  await execute(
    'DELETE FROM campaign_recipients WHERE campaign_id = $1 AND company_id = $2',
    [campaignId, companyId]
  );
}

async function updateCampaignRecipient(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['to_email', 'merged_subject', 'merged_body', 'status', 'error_message', 'sent_at']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return;
  params.push(id);
  await execute(`UPDATE campaign_recipients SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  pool,
  initSchema,
  execute,
  queryOne,
  query,
  normalizeName,
  getConfig,
  setConfig,
  insertCompany,
  markCrmKnown,
  listCompanies,
  getCompany,
  updateCompanyResearch,
  setCompanyStatus,
  setCompanyOverride,
  markOutreach,
  setOutreachStatus,
  addNote,
  getNotes,
  rollupStats,
  companiesToResearch,
  upsertMarket,
  getMarket,
  listMarkets,
  countCompaniesInMarket,
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
  // User config
  getUserConfig,
  setUserConfig,
  // User stats (Phase 2)
  getUserStats,
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
};
