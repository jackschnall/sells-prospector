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

function listCompanies({ tier, crmKnown, search, sort = 'score_desc' } = {}) {
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
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderMap = {
    score_desc: 'score DESC NULLS LAST, name ASC',
    score_asc: 'score ASC NULLS LAST, name ASC',
    name_asc: 'name ASC',
    name_desc: 'name DESC',
    tier: "CASE tier WHEN 'strong-buy' THEN 1 WHEN 'watchlist' THEN 2 WHEN 'pass' THEN 3 ELSE 4 END, score DESC",
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
  return { total, researched, strongBuy, watchlist, pass, inCrm, pending };
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
  addNote,
  getNotes,
  rollupStats,
  companiesToResearch,
  upsertMarket,
  getMarket,
  listMarkets,
  countCompaniesInMarket,
};
