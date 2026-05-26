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
       industry, crm_known, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, 'pending', NOW(), NOW()
     )
     ON CONFLICT(name_key) DO UPDATE SET
       city = COALESCE(EXCLUDED.city, companies.city),
       state = COALESCE(EXCLUDED.state, companies.state),
       phone = COALESCE(EXCLUDED.phone, companies.phone),
       website = COALESCE(EXCLUDED.website, companies.website),
       owner = COALESCE(EXCLUDED.owner, companies.owner),
       email = COALESCE(EXCLUDED.email, companies.email),
       address = COALESCE(EXCLUDED.address, companies.address),
       industry = COALESCE(EXCLUDED.industry, companies.industry),
       crm_known = EXCLUDED.crm_known,
       updated_at = NOW()`,
    [
      row.id, row.name, row.name_key, row.city || null, row.state || null,
      row.phone || null, row.website || null, row.owner || null,
      row.email || null, row.address || null, row.industry || null, row.crm_known || false,
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

async function listCompanies({ tier, crmKnown, search, sort = 'score_desc', stateFilter, outreachStatus, pipelineStage, industry, restrictToVerticals, restrictToTerritories } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  let idx = 1;
  // Per-user visibility restrictions
  // NOTE: COALESCE(industry, 'Plumbing') is a backward-compat fallback for legacy rows.
  // New companies should always have industry set explicitly on insert.
  if (restrictToVerticals && restrictToVerticals.length) {
    const ph = restrictToVerticals.map((_, i) => `$${idx + i}`).join(', ');
    where.push(`COALESCE(industry, 'Plumbing') IN (${ph})`);
    params.push(...restrictToVerticals);
    idx += restrictToVerticals.length;
  }
  if (restrictToTerritories && restrictToTerritories.length) {
    const ph = restrictToTerritories.map((_, i) => `$${idx + i}`).join(', ');
    where.push(`UPPER(state) IN (${ph})`);
    params.push(...restrictToTerritories.map(t => t.toUpperCase()));
    idx += restrictToTerritories.length;
  }
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
      // 'Plumbing' fallback = backward-compat for legacy rows without industry set
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

async function softDeleteCompany(id) {
  await execute('UPDATE companies SET deleted_at = NOW() WHERE id = $1', [id]);
  // Also soft-delete associated contacts
  await execute('UPDATE contacts SET deleted_at = NOW() WHERE company_id = $1 AND deleted_at IS NULL', [id]);
}

async function restoreCompany(id) {
  await execute('UPDATE companies SET deleted_at = NULL WHERE id = $1', [id]);
  // Restore contacts that were soft-deleted at the same time
  await execute('UPDATE contacts SET deleted_at = NULL WHERE company_id = $1 AND deleted_at IS NOT NULL', [id]);
}

async function hardDeleteCompany(id) {
  await execute('DELETE FROM companies WHERE id = $1', [id]);
}

async function listDeleted() {
  const companies = await query(
    `SELECT id, name, city, state, score, tier, owner, industry, deleted_at
     FROM companies WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`
  );
  const contacts = await query(
    `SELECT ct.id, ct.name, ct.title, ct.phone, ct.email, ct.company_id,
            c.name AS company_name, ct.deleted_at
     FROM contacts ct
     LEFT JOIN companies c ON c.id = ct.company_id
     WHERE ct.deleted_at IS NOT NULL AND (c.deleted_at IS NULL OR c.id IS NULL)
     ORDER BY ct.deleted_at DESC`
  );
  return { companies, contacts };
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

async function rollupStats({ restrictToVerticals, restrictToTerritories } = {}) {
  const conds = ['deleted_at IS NULL'];
  const params = [];
  let idx = 1;
  if (restrictToVerticals && restrictToVerticals.length) {
    const ph = restrictToVerticals.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`COALESCE(industry, 'Plumbing') IN (${ph})`);
    params.push(...restrictToVerticals);
    idx += restrictToVerticals.length;
  }
  if (restrictToTerritories && restrictToTerritories.length) {
    const ph = restrictToTerritories.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`UPPER(state) IN (${ph})`);
    params.push(...restrictToTerritories.map(t => t.toUpperCase()));
    idx += restrictToTerritories.length;
  }
  const w = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const row = await queryOne(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'done') AS researched,
      COUNT(*) FILTER (WHERE tier = 'strong-buy') AS strong_buy,
      COUNT(*) FILTER (WHERE tier = 'watchlist') AS watchlist,
      COUNT(*) FILTER (WHERE tier = 'pass') AS pass,
      COUNT(*) FILTER (WHERE crm_known = TRUE) AS in_crm,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE outreach_status = 'no_contact' AND status = 'done') AS outreach_no_contact,
      COUNT(*) FILTER (WHERE outreach_status = 'initial_contact') AS outreach_contacted,
      COUNT(*) FILTER (WHERE outreach_status = 'relationship') AS outreach_relationship
    FROM companies ${w}
  `, params);
  const indRows = await query(
    `SELECT COALESCE(industry, 'Other') AS industry, COUNT(*) AS cnt
     FROM companies WHERE deleted_at IS NULL
     GROUP BY COALESCE(industry, 'Other') ORDER BY cnt DESC`
  );
  const industryCounts = {};
  for (const r of indRows) industryCounts[r.industry] = Number(r.cnt);
  return {
    total: Number(row.total), researched: Number(row.researched),
    strongBuy: Number(row.strong_buy), watchlist: Number(row.watchlist), pass: Number(row.pass),
    inCrm: Number(row.in_crm), pending: Number(row.pending),
    outreachNoContact: Number(row.outreach_no_contact),
    outreachContacted: Number(row.outreach_contacted),
    outreachRelationship: Number(row.outreach_relationship),
    industryCounts,
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
  'outreach_started',
  'initial_contact',
  'relationship_established',
  'prep',
  'market',
  'loi',
  'close',
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
    outreach_started: 'Outreach Started',
    initial_contact: 'Initial Contact Made',
    relationship_established: 'Relationship Established (NDA Signed)',
    prep: 'Prep',
    market: 'Market',
    loi: 'LOI',
    close: 'Close',
    // Legacy stage mappings for existing data
    nurture: 'Outreach Started',
    lead_memo: 'Prep',
    pitch: 'Market',
    engagement_letter: 'Relationship Established (NDA Signed)',
    lois_collected: 'LOI',
    deal_closed: 'Close',
    closed_lost: 'Close',
  };
  return map[s] || s;
}

function formatReason(r) {
  const map = { no_interest: 'No Interest', bad_timing: 'Bad Timing', ineligible: 'Ineligible' };
  return map[r] || r || '';
}

async function getPipelineBoard({ restrictToVerticals, restrictToTerritories } = {}) {
  const conds = ["deleted_at IS NULL"];
  const params = [];
  let idx = 1;
  if (restrictToVerticals && restrictToVerticals.length) {
    const ph = restrictToVerticals.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`COALESCE(industry, 'Plumbing') IN (${ph})`);
    params.push(...restrictToVerticals);
    idx += restrictToVerticals.length;
  }
  if (restrictToTerritories && restrictToTerritories.length) {
    const ph = restrictToTerritories.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`UPPER(state) IN (${ph})`);
    params.push(...restrictToTerritories.map(t => t.toUpperCase()));
    idx += restrictToTerritories.length;
  }
  const rows = await query(
    `SELECT id, name, score, tier, owner, pipeline_stage, closed_lost_reason,
            pipeline_stage_changed_at, city, state, assigned_to,
            valuation, probability, est_close_date, deal_owner_id, last_reviewed_at, updated_at,
            warm_until
     FROM companies
     WHERE ${conds.join(' AND ')}
     ORDER BY score DESC NULLS LAST, name ASC`,
    params
  );
  const board = {};
  // Map legacy stages to new ones
  const LEGACY_MAP = {
    nurture: 'outreach_started',
    lead_memo: 'prep',
    pitch: 'market',
    engagement_letter: 'relationship_established',
    lois_collected: 'loi',
    deal_closed: 'close',
    closed_lost: 'close',
  };
  for (const stage of PIPELINE_STAGES) board[stage] = [];
  for (const r of rows) {
    let stage = r.pipeline_stage || 'no_contact';
    if (LEGACY_MAP[stage]) stage = LEGACY_MAP[stage];
    if (board[stage]) board[stage].push(r);
    else board.no_contact.push(r);
  }
  return board;
}

// ─── Contacts ────────────────────────────────────────────────────────────────

async function listContacts(companyId) {
  return query(
    'SELECT * FROM contacts WHERE company_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at ASC',
    [companyId]
  );
}

/**
 * List ALL contacts with their company info joined in (for the global Contacts tab).
 * Supports a loose `search` term matched against name/title/email/phone/company name.
 */
async function listAllContacts({ search = '', limit = 500, offset = 0, restrictToVerticals, restrictToTerritories } = {}) {
  const params = [];
  const conds = ['ct.deleted_at IS NULL'];
  let idx = 1;
  const s = String(search || '').trim();
  if (s) {
    params.push(`%${s.toLowerCase()}%`);
    conds.push(`(LOWER(ct.name) LIKE $${idx}
             OR LOWER(COALESCE(ct.title, '')) LIKE $${idx}
             OR LOWER(COALESCE(ct.email, '')) LIKE $${idx}
             OR LOWER(COALESCE(ct.phone, '')) LIKE $${idx}
             OR LOWER(COALESCE(c.name, '')) LIKE $${idx})`);
    idx++;
  }
  if (restrictToVerticals && restrictToVerticals.length) {
    const ph = restrictToVerticals.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`COALESCE(c.industry, 'Plumbing') IN (${ph})`);
    params.push(...restrictToVerticals);
    idx += restrictToVerticals.length;
  }
  if (restrictToTerritories && restrictToTerritories.length) {
    const ph = restrictToTerritories.map((_, i) => `$${idx + i}`).join(', ');
    conds.push(`UPPER(c.state) IN (${ph})`);
    params.push(...restrictToTerritories.map(t => t.toUpperCase()));
    idx += restrictToTerritories.length;
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  params.push(limit, offset);
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
     LIMIT $${idx++} OFFSET $${idx}`,
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
    `INSERT INTO contacts (id, company_id, name, title, phone, email, linkedin, is_primary, source, notes, phones, emails)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, data.company_id, data.name,
      data.title || null, data.phone || null, data.email || null,
      data.linkedin || null, data.is_primary ? true : false,
      data.source || 'manual', data.notes || null,
      JSON.stringify(data.phones || []), JSON.stringify(data.emails || []),
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
  for (const key of ['company_id', 'name', 'title', 'phone', 'email', 'linkedin', 'is_primary', 'notes', 'phones', 'emails']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (key === 'is_primary') params.push(!!data[key]);
      else if (key === 'phones' || key === 'emails') params.push(JSON.stringify(data[key] || []));
      else params.push(data[key]);
    }
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = NOW()`);
  params.push(id);
  await execute(`UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function deleteContact(id) {
  await execute('UPDATE contacts SET deleted_at = NOW() WHERE id = $1', [id]);
}

async function restoreContact(id) {
  await execute('UPDATE contacts SET deleted_at = NULL WHERE id = $1', [id]);
}

async function hardDeleteContact(id) {
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

async function listGlobalActivities({ limit = 100, offset = 0, userId } = {}) {
  const where = [];
  const params = [];
  let idx = 1;
  if (userId) { where.push(`a.user_id = $${idx++}`); params.push(userId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  return query(`
    SELECT a.*, c.name AS company_name, c.city AS company_city, c.state AS company_state,
           u.name AS user_name, ct.name AS contact_name
    FROM activities a
    LEFT JOIN companies c ON c.id = a.company_id
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN contacts ct ON ct.id = a.contact_id
    ${whereSql}
    ORDER BY a.created_at DESC
    LIMIT $${idx++} OFFSET $${idx}
  `, params);
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
    `INSERT INTO users (id, name, email, password_hash, invite_token)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, data.name, data.email, data.password_hash || null, data.invite_token || null]
  );
  return { id, name: data.name, email: data.email };
}

async function listUsers() {
  return query('SELECT id, name, email, twilio_phone_number, created_at FROM users ORDER BY created_at ASC');
}

async function clearInviteToken(userId) {
  await execute('UPDATE users SET invite_token = NULL WHERE id = $1', [userId]);
}

async function updateUser(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['name', 'role', 'assigned_verticals', 'assigned_territories', 'restricted', 'twilio_phone_number', 'disabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_email', 'email_signature']) {
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
            restricted, twilio_phone_number, disabled, invite_token,
            smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, created_at
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
       call_sid, mock, from_number, called_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [
      id, data.company_id || null, data.contact_id || null, data.user_id || null,
      data.direction || 'outbound', data.status || 'initiated',
      data.call_sid || null, !!data.mock, data.from_number || null,
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
    'from_number', 'voicemail_url',
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

// ─── Messages (SMS) ─────────────────────────────────────────────────────────

async function insertMessage(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO messages (id, company_id, contact_id, user_id, direction, to_number, from_number, body, status, twilio_sid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, data.company_id || null, data.contact_id || null, data.user_id || null,
     data.direction || 'outbound', data.to_number, data.from_number, data.body,
     data.status || 'sent', data.twilio_sid || null]
  );
  return id;
}

async function listMessages(companyId, limit = 50) {
  return query(
    `SELECT m.*, u.name AS user_name, ct.name AS contact_name
     FROM messages m
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN contacts ct ON ct.id = m.contact_id
     WHERE m.company_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [companyId, limit]
  );
}

async function listMessagesByPhone(phone, limit = 50) {
  const cleaned = phone.replace(/\D/g, '').slice(-10);
  return query(
    `SELECT m.*, c.name AS company_name, u.name AS user_name
     FROM messages m
     LEFT JOIN companies c ON c.id = m.company_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE RIGHT(REGEXP_REPLACE(m.to_number, '[^0-9]', '', 'g'), 10) = $1
        OR RIGHT(REGEXP_REPLACE(m.from_number, '[^0-9]', '', 'g'), 10) = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [cleaned, limit]
  );
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
  for (const key of ['name', 'subject_template', 'body_template', 'status', 'sent_at', 'ai_prompt']) {
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

// ─── Advisors ───────────────────────────────────────────────────────────────

async function insertAdvisor(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  await execute(
    `INSERT INTO advisors (
       id, type, name, firm, title, city, state, email, phone,
       linkedin_url, website, dossier_json, fit_score, fit_score_breakdown_json,
       relationship_stage, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO NOTHING`,
    [
      id, data.type, data.name, data.firm || null, data.title || null,
      data.city || null, data.state || null, data.email || null, data.phone || null,
      data.linkedin_url || null, data.website || null,
      data.dossier_json ? JSON.stringify(data.dossier_json) : null,
      data.fit_score || null,
      data.fit_score_breakdown_json ? JSON.stringify(data.fit_score_breakdown_json) : null,
      data.relationship_stage || 'identified',
      data.status || 'pending',
    ]
  );
  return id;
}

async function updateAdvisorResearch(id, data) {
  await execute(
    `UPDATE advisors SET
       dossier_json = $1,
       fit_score = $2,
       fit_score_breakdown_json = $3,
       status = $4,
       email = COALESCE($5, email),
       phone = COALESCE($6, phone),
       linkedin_url = COALESCE($7, linkedin_url),
       website = COALESCE($8, website),
       firm = COALESCE($9, firm),
       title = COALESCE($10, title),
       relationship_stage = CASE WHEN relationship_stage = 'identified' THEN 'researched' ELSE relationship_stage END,
       last_researched_at = NOW(),
       updated_at = NOW()
     WHERE id = $11`,
    [
      data.dossier_json ? JSON.stringify(data.dossier_json) : null,
      data.fit_score, data.fit_score_breakdown_json ? JSON.stringify(data.fit_score_breakdown_json) : null,
      data.status || 'done',
      data.email || null, data.phone || null, data.linkedin_url || null,
      data.website || null, data.firm || null, data.title || null, id,
    ]
  );
}

async function getAdvisor(id) {
  return queryOne('SELECT * FROM advisors WHERE id = $1 AND deleted_at IS NULL', [id]);
}

async function listAdvisors({ type, state: stateFilter, minFitScore, maxFitScore, relationshipStage, search, sort = 'fit_score_desc' } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  let idx = 1;

  if (type) { where.push(`type = $${idx++}`); params.push(type); }
  if (stateFilter) { where.push(`UPPER(state) = $${idx++}`); params.push(stateFilter.toUpperCase()); }
  if (minFitScore != null) { where.push(`fit_score >= $${idx++}`); params.push(minFitScore); }
  if (maxFitScore != null) { where.push(`fit_score <= $${idx++}`); params.push(maxFitScore); }
  if (relationshipStage) { where.push(`relationship_stage = $${idx++}`); params.push(relationshipStage); }
  if (search) {
    where.push(`(LOWER(name) LIKE $${idx} OR LOWER(firm) LIKE $${idx} OR LOWER(city) LIKE $${idx})`);
    params.push(`%${String(search).toLowerCase()}%`);
    idx++;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderMap = {
    fit_score_desc: 'fit_score DESC NULLS LAST, name ASC',
    fit_score_asc: 'fit_score ASC NULLS LAST, name ASC',
    name_asc: 'name ASC',
    relationship: `CASE relationship_stage
      WHEN 'active_partner' THEN 1 WHEN 'intro_meeting_done' THEN 2
      WHEN 'intro_meeting_booked' THEN 3 WHEN 'first_response' THEN 4
      WHEN 'outreach_sent' THEN 5 WHEN 'queued' THEN 6
      WHEN 'researched' THEN 7 WHEN 'identified' THEN 8
      WHEN 'dormant' THEN 9 WHEN 'declined' THEN 10 ELSE 11 END, fit_score DESC`,
    recent: 'updated_at DESC NULLS LAST',
  };
  const orderBy = orderMap[sort] || orderMap.fit_score_desc;

  return query(`SELECT * FROM advisors ${whereSql} ORDER BY ${orderBy}`, params);
}

async function updateAdvisorStage(id, stage) {
  await execute(
    `UPDATE advisors SET relationship_stage = $1, updated_at = NOW() WHERE id = $2`,
    [stage, id]
  );
}

async function updateAdvisorRelationshipScore(id, score) {
  await execute(
    `UPDATE advisors SET relationship_score = $1, updated_at = NOW() WHERE id = $2`,
    [score, id]
  );
}

async function softDeleteAdvisor(id) {
  await execute('UPDATE advisors SET deleted_at = NOW() WHERE id = $1', [id]);
}

async function advisorsToResearch() {
  return query(
    `SELECT * FROM advisors WHERE status IN ('pending', 'error') AND deleted_at IS NULL ORDER BY created_at ASC`
  );
}

async function setAdvisorStatus(id, status) {
  await execute('UPDATE advisors SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
}

async function advisorStats() {
  const row = await queryOne(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'done') AS researched,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE fit_score >= 7.5) AS strong_fit,
      COUNT(*) FILTER (WHERE fit_score >= 5.0 AND fit_score < 7.5) AS moderate_fit,
      COUNT(*) FILTER (WHERE fit_score < 5.0 AND fit_score IS NOT NULL) AS low_fit,
      COUNT(*) FILTER (WHERE relationship_stage = 'active_partner') AS active_partners,
      COUNT(*) FILTER (WHERE relationship_stage IN ('outreach_sent','first_response','intro_meeting_booked','intro_meeting_done')) AS in_outreach
    FROM advisors WHERE deleted_at IS NULL
  `);
  const typeRows = await query(
    `SELECT type, COUNT(*)::int AS cnt FROM advisors WHERE deleted_at IS NULL GROUP BY type ORDER BY cnt DESC`
  );
  const typeCounts = {};
  for (const r of typeRows) typeCounts[r.type] = r.cnt;

  return {
    total: Number(row.total), researched: Number(row.researched), pending: Number(row.pending),
    strongFit: Number(row.strong_fit), moderateFit: Number(row.moderate_fit), lowFit: Number(row.low_fit),
    activePartners: Number(row.active_partners), inOutreach: Number(row.in_outreach),
    typeCounts,
  };
}

// ─── Advisor Credentials ────────────────────────────────────────────────────

async function insertAdvisorCredential(advisorId, credential, earnedYear) {
  const { nanoid } = require('nanoid');
  await execute(
    `INSERT INTO advisor_credentials (id, advisor_id, credential, earned_year) VALUES ($1,$2,$3,$4)`,
    [nanoid(), advisorId, credential, earnedYear || null]
  );
}

async function listAdvisorCredentials(advisorId) {
  return query('SELECT * FROM advisor_credentials WHERE advisor_id = $1 ORDER BY earned_year DESC NULLS LAST', [advisorId]);
}

// ─── Advisor Contacts (interaction log) ─────────────────────────────────────

async function insertAdvisorContact(data) {
  const { nanoid } = require('nanoid');
  const id = nanoid();
  await execute(
    `INSERT INTO advisor_contacts (id, advisor_id, contact_date, channel, direction, summary, next_action, next_action_date, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, data.advisor_id, data.contact_date || new Date().toISOString(),
     data.channel || 'email', data.direction || 'outbound',
     data.summary || null, data.next_action || null,
     data.next_action_date || null, data.user_id || null]
  );
  await execute(
    `UPDATE advisors SET last_contact_date = $1, last_contact_channel = $2, updated_at = NOW() WHERE id = $3`,
    [data.contact_date || new Date().toISOString(), data.channel || 'email', data.advisor_id]
  );
  return id;
}

async function listAdvisorContacts(advisorId) {
  return query(
    `SELECT ac.*, u.name AS user_name FROM advisor_contacts ac
     LEFT JOIN users u ON ac.user_id = u.id
     WHERE ac.advisor_id = $1 ORDER BY ac.contact_date DESC`,
    [advisorId]
  );
}

// ─── Referrals ──────────────────────────────────────────────────────────────

async function insertReferral(data) {
  const { nanoid } = require('nanoid');
  const id = nanoid();
  await execute(
    `INSERT INTO referrals (id, advisor_id, direction, prospect_id, scope, status, estimated_value, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, data.advisor_id, data.direction, data.prospect_id || null,
     data.scope || null, data.status || 'new',
     data.estimated_value || null, data.notes || null]
  );
  return id;
}

async function listReferrals(advisorId) {
  return query(
    `SELECT r.*, c.name AS prospect_name, c.city AS prospect_city, c.state AS prospect_state
     FROM referrals r
     LEFT JOIN companies c ON r.prospect_id = c.id
     WHERE r.advisor_id = $1 ORDER BY r.created_at DESC`,
    [advisorId]
  );
}

async function updateReferral(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const key of ['status', 'estimated_value', 'realized_value', 'fee_owed', 'notes', 'scope']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = NOW()');
  params.push(id);
  await execute(`UPDATE referrals SET ${fields.join(', ')} WHERE id = $${idx}`, params);
}

async function getReferralGraph() {
  return query(
    `SELECT r.*, a.name AS advisor_name, a.type AS advisor_type, a.firm AS advisor_firm,
            c.name AS prospect_name, c.city AS prospect_city, c.state AS prospect_state
     FROM referrals r
     JOIN advisors a ON r.advisor_id = a.id
     LEFT JOIN companies c ON r.prospect_id = c.id
     WHERE a.deleted_at IS NULL
     ORDER BY r.created_at DESC`
  );
}

// ─── Advisor-Owner Links ────────────────────────────────────────────────────

async function insertAdvisorOwnerLink(data) {
  const { nanoid } = require('nanoid');
  const id = nanoid();
  await execute(
    `INSERT INTO advisor_owner_links (id, advisor_id, prospect_id, link_type, evidence, confidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (advisor_id, prospect_id) DO UPDATE SET
       link_type = EXCLUDED.link_type,
       evidence = COALESCE(EXCLUDED.evidence, advisor_owner_links.evidence),
       confidence = COALESCE(EXCLUDED.confidence, advisor_owner_links.confidence)`,
    [id, data.advisor_id, data.prospect_id, data.link_type || 'suspected',
     data.evidence || null, data.confidence || null]
  );
  return id;
}

async function listAdvisorOwnerLinks(advisorId) {
  return query(
    `SELECT aol.*, c.name AS prospect_name, c.city AS prospect_city, c.state AS prospect_state,
            c.owner AS prospect_owner, c.score AS prospect_score, c.tier AS prospect_tier
     FROM advisor_owner_links aol
     JOIN companies c ON aol.prospect_id = c.id
     WHERE aol.advisor_id = $1 AND c.deleted_at IS NULL
     ORDER BY aol.confidence DESC NULLS LAST`,
    [advisorId]
  );
}

async function listOwnerAdvisorLinks(prospectId) {
  return query(
    `SELECT aol.*, a.name AS advisor_name, a.type AS advisor_type, a.firm AS advisor_firm,
            a.fit_score, a.relationship_stage
     FROM advisor_owner_links aol
     JOIN advisors a ON aol.advisor_id = a.id
     WHERE aol.prospect_id = $1 AND a.deleted_at IS NULL
     ORDER BY a.fit_score DESC NULLS LAST`,
    [prospectId]
  );
}

// ─── Advisor Queue (daily follow-up) ────────────────────────────────────────

async function getAdvisorQueue() {
  return query(
    `SELECT a.*, ac.next_action, ac.next_action_date
     FROM advisors a
     LEFT JOIN LATERAL (
       SELECT next_action, next_action_date
       FROM advisor_contacts
       WHERE advisor_id = a.id AND next_action IS NOT NULL
       ORDER BY created_at DESC LIMIT 1
     ) ac ON TRUE
     WHERE a.deleted_at IS NULL
       AND a.relationship_stage NOT IN ('declined', 'dormant')
       AND a.status = 'done'
       AND (ac.next_action_date IS NULL OR ac.next_action_date <= NOW() + INTERVAL '1 day')
     ORDER BY
       CASE WHEN ac.next_action_date IS NOT NULL AND ac.next_action_date <= NOW() THEN 0 ELSE 1 END,
       a.relationship_score DESC NULLS LAST,
       a.fit_score DESC NULLS LAST
     LIMIT 50`
  );
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
  // Global activity log
  listGlobalActivities,
  // Soft-delete / restore
  softDeleteCompany,
  restoreCompany,
  hardDeleteCompany,
  restoreContact,
  hardDeleteContact,
  listDeleted,
  // Messages (SMS)
  insertMessage,
  listMessages,
  listMessagesByPhone,
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
  // Advisors
  insertAdvisor,
  updateAdvisorResearch,
  getAdvisor,
  listAdvisors,
  updateAdvisorStage,
  updateAdvisorRelationshipScore,
  softDeleteAdvisor,
  advisorsToResearch,
  setAdvisorStatus,
  advisorStats,
  insertAdvisorCredential,
  listAdvisorCredentials,
  insertAdvisorContact,
  listAdvisorContacts,
  insertReferral,
  listReferrals,
  updateReferral,
  getReferralGraph,
  insertAdvisorOwnerLink,
  listAdvisorOwnerLinks,
  listOwnerAdvisorLinks,
  getAdvisorQueue,
};
