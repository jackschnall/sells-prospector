const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'prospector.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    city TEXT,
    state TEXT,
    phone TEXT,
    website TEXT,
    owner TEXT,
    email TEXT,
    address TEXT,
    linkedin TEXT,
    crm_known INTEGER DEFAULT 0,
    crm_override INTEGER DEFAULT 0,
    salesforce_id TEXT,
    status TEXT DEFAULT 'pending',
    score REAL,
    tier TEXT,
    signals_json TEXT,
    flags_json TEXT,
    summary TEXT,
    outreach_angle TEXT,
    sources_json TEXT,
    raw_research TEXT,
    marked_for_outreach INTEGER DEFAULT 0,
    last_researched_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_companies_tier ON companies(tier);
  CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
  CREATE INDEX IF NOT EXISTS idx_companies_score ON companies(score);

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    invite_token TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    phone TEXT,
    email TEXT,
    linkedin TEXT,
    is_primary INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    contact_id TEXT,
    user_id TEXT,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_activities_company ON activities(company_id);
  CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);

  CREATE TABLE IF NOT EXISTS markets (
    key TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    population INTEGER,
    msa_name TEXT,
    addressable INTEGER,
    loaded INTEGER,
    tier TEXT,
    score REAL,
    confidence TEXT,
    sources_json TEXT,
    analyzed_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_markets_tier ON markets(tier);
  CREATE INDEX IF NOT EXISTS idx_markets_score ON markets(score);
`);

// Migration: ensure outreach_angle column exists on pre-existing databases.
{
  const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  if (!cols.includes('outreach_angle')) {
    db.exec('ALTER TABLE companies ADD COLUMN outreach_angle TEXT');
  }
}

// Migration: add market intelligence columns to markets table.
{
  const cols = db.prepare('PRAGMA table_info(markets)').all().map((c) => c.name);
  const newCols = [
    ['population_growth', 'REAL'],
    ['median_home_value', 'INTEGER'],
    ['housing_permits', 'INTEGER'],
    ['housing_age_score', 'REAL'],
    ['plumbing_density', 'REAL'],
    ['ma_activity_score', 'REAL'],
    ['market_score', 'REAL'],
    ['saturation_status', 'TEXT'],
  ];
  for (const [name, type] of newCols) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE markets ADD COLUMN ${name} ${type}`);
    }
  }
}

// Migration: add home_sales_volume to markets table.
{
  const cols = db.prepare('PRAGMA table_info(markets)').all().map((c) => c.name);
  if (!cols.includes('home_sales_volume')) {
    db.exec('ALTER TABLE markets ADD COLUMN home_sales_volume INTEGER');
  }
}

// Migration: add outreach_status column.
{
  const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  if (!cols.includes('outreach_status')) {
    db.exec("ALTER TABLE companies ADD COLUMN outreach_status TEXT DEFAULT 'no_contact'");
    db.exec("UPDATE companies SET outreach_status = 'initial_contact' WHERE marked_for_outreach = 1");
  }
}

// Migration: add pipeline columns to companies.
{
  const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  const pipelineCols = [
    ['pipeline_stage', "TEXT DEFAULT 'no_contact'"],
    ['closed_lost_reason', 'TEXT'],
    ['pipeline_stage_changed_at', 'TEXT'],
    ['assigned_to', 'TEXT'],
  ];
  let needsMigration = false;
  for (const [name, type] of pipelineCols) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE companies ADD COLUMN ${name} ${type}`);
      if (name === 'pipeline_stage') needsMigration = true;
    }
  }
  // Migrate outreach_status → pipeline_stage for existing data
  if (needsMigration) {
    db.exec(`
      UPDATE companies SET pipeline_stage = CASE
        WHEN outreach_status = 'initial_contact' THEN 'initial_contact'
        WHEN outreach_status = 'relationship' THEN 'nurture'
        ELSE 'no_contact'
      END
    `);
  }
}

// Migration: seed contacts from existing researched companies.
{
  const hasContacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  if (hasContacts === 0) {
    const rows = db.prepare("SELECT id, owner, phone, email, linkedin FROM companies WHERE status = 'done' AND owner IS NOT NULL AND owner != ''").all();
    const { nanoid } = require('nanoid');
    const insert = db.prepare(`
      INSERT INTO contacts (id, company_id, name, phone, email, linkedin, is_primary, source)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'research')
    `);
    for (const r of rows) {
      insert.run(nanoid(), r.id, r.owner, r.phone || null, r.email || null, r.linkedin || null);
    }
    if (rows.length) console.log(`Seeded ${rows.length} contacts from researched companies.`);
  }
}

// Migration: migrate existing notes → activities.
{
  const hasActivities = db.prepare('SELECT COUNT(*) AS n FROM activities').get().n;
  const hasNotes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
  if (hasActivities === 0 && hasNotes > 0) {
    const { nanoid } = require('nanoid');
    const notes = db.prepare('SELECT * FROM notes ORDER BY created_at ASC').all();
    const insert = db.prepare(`
      INSERT INTO activities (id, company_id, type, summary, created_at)
      VALUES (?, ?, 'note', ?, ?)
    `);
    for (const n of notes) {
      insert.run(nanoid(), n.company_id, n.note, n.created_at);
    }
    if (notes.length) console.log(`Migrated ${notes.length} notes to activities.`);
  }
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getConfig(key, fallback = null) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setConfig(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, v);
}

function insertCompany(row) {
  const stmt = db.prepare(`
    INSERT INTO companies (
      id, name, name_key, city, state, phone, website, owner, email, address,
      crm_known, status, created_at, updated_at
    ) VALUES (
      @id, @name, @name_key, @city, @state, @phone, @website, @owner, @email, @address,
      @crm_known, 'pending', datetime('now'), datetime('now')
    )
    ON CONFLICT(name_key) DO UPDATE SET
      city = COALESCE(excluded.city, companies.city),
      state = COALESCE(excluded.state, companies.state),
      phone = COALESCE(excluded.phone, companies.phone),
      website = COALESCE(excluded.website, companies.website),
      owner = COALESCE(excluded.owner, companies.owner),
      email = COALESCE(excluded.email, companies.email),
      address = COALESCE(excluded.address, companies.address),
      crm_known = excluded.crm_known,
      updated_at = datetime('now')
  `);
  stmt.run(row);
}

function markCrmKnown(knownNames) {
  const normalized = knownNames.map(normalizeName).filter(Boolean);
  db.prepare('UPDATE companies SET crm_known = 0').run();
  if (normalized.length === 0) return 0;
  const placeholders = normalized.map(() => '?').join(',');
  const result = db
    .prepare(`UPDATE companies SET crm_known = 1 WHERE name_key IN (${placeholders})`)
    .run(...normalized);
  return result.changes;
}

function listCompanies({ tier, crmKnown, search, sort = 'score_desc', stateFilter, outreachStatus, pipelineStage } = {}) {
  const where = [];
  const params = [];
  if (tier) {
    where.push('tier = ?');
    params.push(tier);
  }
  if (crmKnown === 'true') where.push('crm_known = 1');
  if (crmKnown === 'false') where.push('crm_known = 0');
  if (search) {
    where.push('(LOWER(name) LIKE ? OR LOWER(city) LIKE ? OR LOWER(state) LIKE ?)');
    const s = `%${String(search).toLowerCase()}%`;
    params.push(s, s, s);
  }
  if (stateFilter) {
    where.push('UPPER(state) = ?');
    params.push(String(stateFilter).toUpperCase());
  }
  if (pipelineStage) {
    where.push('pipeline_stage = ?');
    params.push(pipelineStage);
  } else if (outreachStatus) {
    where.push('outreach_status = ?');
    params.push(outreachStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderMap = {
    score_desc: 'score DESC NULLS LAST, name ASC',
    score_asc: 'score ASC NULLS LAST, name ASC',
    name_asc: 'name ASC',
    name_desc: 'name DESC',
    tier: "CASE tier WHEN 'strong-buy' THEN 1 WHEN 'watchlist' THEN 2 WHEN 'pass' THEN 3 ELSE 4 END, score DESC",
    revenue_desc: "COALESCE(CAST(json_extract(signals_json, '$.revenue_proxy.score') AS REAL), CAST(json_extract(signals_json, '$.revenue_proxy') AS REAL)) DESC NULLS LAST, score DESC",
    succession_desc: "COALESCE(CAST(json_extract(signals_json, '$.succession_signal.score') AS REAL), CAST(json_extract(signals_json, '$.succession_signal') AS REAL)) DESC NULLS LAST, score DESC",
    state_asc: 'state ASC NULLS LAST, city ASC, name ASC',
    city_asc: 'city ASC NULLS LAST, state ASC, name ASC',
    recent: 'last_researched_at DESC NULLS LAST, updated_at DESC',
    outreach: "CASE outreach_status WHEN 'relationship' THEN 1 WHEN 'initial_contact' THEN 2 ELSE 3 END, score DESC",
    pipeline: "CASE pipeline_stage WHEN 'deal_closed' THEN 1 WHEN 'lois_collected' THEN 2 WHEN 'engagement_letter' THEN 3 WHEN 'pitch' THEN 4 WHEN 'lead_memo' THEN 5 WHEN 'nurture' THEN 6 WHEN 'initial_contact' THEN 7 WHEN 'no_contact' THEN 8 WHEN 'closed_lost' THEN 9 ELSE 10 END, score DESC",
  };
  const orderBy = orderMap[sort] || orderMap.score_desc;

  return db
    .prepare(`SELECT * FROM companies ${whereSql} ORDER BY ${orderBy}`)
    .all(...params);
}

function getCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function updateCompanyResearch(id, data) {
  db.prepare(
    `UPDATE companies SET
       status = @status,
       score = @score,
       tier = @tier,
       signals_json = @signals_json,
       flags_json = @flags_json,
       summary = @summary,
       outreach_angle = @outreach_angle,
       sources_json = @sources_json,
       raw_research = @raw_research,
       owner = COALESCE(@owner, owner),
       phone = COALESCE(@phone, phone),
       email = COALESCE(@email, email),
       address = COALESCE(@address, address),
       linkedin = COALESCE(@linkedin, linkedin),
       last_researched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({ id, ...data });
}

function setCompanyStatus(id, status, rawError = null) {
  db.prepare(
    'UPDATE companies SET status = ?, raw_research = COALESCE(?, raw_research), updated_at = datetime(\'now\') WHERE id = ?'
  ).run(status, rawError, id);
}

function setCompanyOverride(id, override) {
  db.prepare('UPDATE companies SET crm_override = ? WHERE id = ?').run(override ? 1 : 0, id);
}

function markOutreach(id, marked) {
  db.prepare('UPDATE companies SET marked_for_outreach = ? WHERE id = ?').run(marked ? 1 : 0, id);
}

function setOutreachStatus(id, outreachStatus) {
  db.prepare("UPDATE companies SET outreach_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(outreachStatus, id);
}

function addNote(companyId, text) {
  const { nanoid } = require('nanoid');
  const id = nanoid();
  db.prepare('INSERT INTO notes (id, company_id, note) VALUES (?, ?, ?)').run(id, companyId, text);
  return { id, company_id: companyId, note: text };
}

function getNotes(companyId) {
  return db
    .prepare('SELECT * FROM notes WHERE company_id = ? ORDER BY created_at DESC')
    .all(companyId);
}

function rollupStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  const researched = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE status = 'done'").get().n;
  const strongBuy = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE tier = 'strong-buy'").get().n;
  const watchlist = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE tier = 'watchlist'").get().n;
  const pass = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE tier = 'pass'").get().n;
  const inCrm = db
    .prepare('SELECT COUNT(*) AS n FROM companies WHERE crm_known = 1').get().n;
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE status = 'pending'").get().n;
  const outreachNoContact = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'no_contact' AND status = 'done'").get().n;
  const outreachContacted = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'initial_contact'").get().n;
  const outreachRelationship = db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE outreach_status = 'relationship'").get().n;
  return { total, researched, strongBuy, watchlist, pass, inCrm, pending, outreachNoContact, outreachContacted, outreachRelationship };
}

function companiesToResearch() {
  return db
    .prepare(
      `SELECT * FROM companies
       WHERE status IN ('pending', 'error')
         AND (crm_known = 0 OR crm_override = 1)
       ORDER BY created_at ASC`
    )
    .all();
}

function upsertMarket(row) {
  db.prepare(
    `INSERT INTO markets (
       key, city, state, population, msa_name, addressable, loaded,
       tier, score, confidence, sources_json, analyzed_at, updated_at
     ) VALUES (
       @key, @city, @state, @population, @msa_name, @addressable, @loaded,
       @tier, @score, @confidence, @sources_json, datetime('now'), datetime('now')
     )
     ON CONFLICT(key) DO UPDATE SET
       city = excluded.city,
       state = excluded.state,
       population = excluded.population,
       msa_name = excluded.msa_name,
       addressable = excluded.addressable,
       loaded = excluded.loaded,
       tier = excluded.tier,
       score = excluded.score,
       confidence = excluded.confidence,
       sources_json = excluded.sources_json,
       updated_at = datetime('now')`
  ).run(row);
}

function getMarket(key) {
  return db.prepare('SELECT * FROM markets WHERE key = ?').get(key);
}

function listMarkets() {
  return db
    .prepare(
      `SELECT * FROM markets
       ORDER BY
         CASE tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END,
         score DESC,
         population DESC`
    )
    .all();
}

function countCompaniesInMarket(city, state) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM companies
       WHERE LOWER(TRIM(city)) = LOWER(TRIM(?))
         AND UPPER(TRIM(state)) = UPPER(TRIM(?))`
    )
    .get(city || '', state || '');
  return row ? row.n : 0;
}

// ---------- Pipeline ----------

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

function updatePipelineStage(companyId, stage, closedLostReason = null, userId = null) {
  const { nanoid } = require('nanoid');
  const company = getCompany(companyId);
  if (!company) return null;
  const oldStage = company.pipeline_stage || 'no_contact';
  db.prepare(`
    UPDATE companies SET
      pipeline_stage = ?,
      closed_lost_reason = ?,
      pipeline_stage_changed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(stage, stage === 'closed_lost' ? closedLostReason : null, companyId);
  // Auto-log stage change activity
  const summary = stage === 'closed_lost'
    ? `Stage: ${formatStage(oldStage)} → ${formatStage(stage)} (${formatReason(closedLostReason)})`
    : `Stage: ${formatStage(oldStage)} → ${formatStage(stage)}`;
  db.prepare(`
    INSERT INTO activities (id, company_id, user_id, type, summary)
    VALUES (?, ?, ?, 'stage_change', ?)
  `).run(nanoid(), companyId, userId, summary);
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

function getPipelineBoard() {
  const rows = db.prepare(`
    SELECT id, name, score, tier, owner, pipeline_stage, closed_lost_reason,
           pipeline_stage_changed_at, city, state, assigned_to
    FROM companies
    WHERE status = 'done' OR pipeline_stage != 'no_contact'
    ORDER BY score DESC NULLS LAST, name ASC
  `).all();
  const board = {};
  for (const stage of PIPELINE_STAGES) board[stage] = [];
  for (const r of rows) {
    const stage = r.pipeline_stage || 'no_contact';
    if (board[stage]) board[stage].push(r);
    else board.no_contact.push(r);
  }
  return board;
}

// ---------- Contacts ----------

function listContacts(companyId) {
  return db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC').all(companyId);
}

function getContact(id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function insertContact(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  db.prepare(`
    INSERT INTO contacts (id, company_id, name, title, phone, email, linkedin, is_primary, source, notes)
    VALUES (@id, @company_id, @name, @title, @phone, @email, @linkedin, @is_primary, @source, @notes)
  `).run({
    id,
    company_id: data.company_id,
    name: data.name,
    title: data.title || null,
    phone: data.phone || null,
    email: data.email || null,
    linkedin: data.linkedin || null,
    is_primary: data.is_primary ? 1 : 0,
    source: data.source || 'manual',
    notes: data.notes || null,
  });
  return { id, ...data };
}

function updateContact(id, data) {
  const fields = [];
  const params = { id };
  for (const key of ['name', 'title', 'phone', 'email', 'linkedin', 'is_primary', 'notes']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = @${key}`);
      params[key] = key === 'is_primary' ? (data[key] ? 1 : 0) : data[key];
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = @id`).run(params);
}

function deleteContact(id) {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
}

// ---------- Activities ----------

function listActivities(companyId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT a.*, u.name AS user_name, c.name AS contact_name
    FROM activities a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN contacts c ON a.contact_id = c.id
    WHERE a.company_id = ?
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(companyId, limit, offset);
}

function insertActivity(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  db.prepare(`
    INSERT INTO activities (id, company_id, contact_id, user_id, type, summary, details)
    VALUES (@id, @company_id, @contact_id, @user_id, @type, @summary, @details)
  `).run({
    id,
    company_id: data.company_id,
    contact_id: data.contact_id || null,
    user_id: data.user_id || null,
    type: data.type,
    summary: data.summary,
    details: data.details || null,
  });
  return { id, ...data };
}

// ---------- Users ----------

function getUserByToken(token) {
  return db.prepare('SELECT * FROM users WHERE invite_token = ?').get(token);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function createUser(data) {
  const { nanoid } = require('nanoid');
  const id = data.id || nanoid();
  db.prepare(`
    INSERT INTO users (id, name, email, invite_token)
    VALUES (?, ?, ?, ?)
  `).run(id, data.name, data.email, data.invite_token || null);
  return { id, name: data.name, email: data.email };
}

function listUsers() {
  return db.prepare('SELECT id, name, email, created_at FROM users ORDER BY created_at ASC').all();
}

function clearInviteToken(userId) {
  db.prepare('UPDATE users SET invite_token = NULL WHERE id = ?').run(userId);
}

module.exports = {
  db,
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
