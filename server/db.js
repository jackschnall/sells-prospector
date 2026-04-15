const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// ─── Connection ──────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
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

async function listCompanies({ tier, crmKnown, search, sort = 'score_desc', stateFilter, outreachStatus, pipelineStage } = {}) {
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
       last_researched_at = NOW(),
       updated_at = NOW()
     WHERE id = $15`,
    [
      data.status, data.score, data.tier,
      data.signals_json || null, data.flags_json || null,
      data.summary || null, data.outreach_angle || null,
      data.sources_json || null, data.raw_research || null,
      data.owner || null, data.phone || null, data.email || null,
      data.address || null, data.linkedin || null, id,
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

async function getContact(id) {
  return queryOne('SELECT * FROM contacts WHERE id = $1', [id]);
}

async function insertContact(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
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
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['name', 'title', 'phone', 'email', 'linkedin', 'is_primary', 'notes']) {
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
  clearInviteToken,
};
