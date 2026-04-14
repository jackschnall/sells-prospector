const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { nanoid } = require('nanoid');
const { normalizeName } = require('./db');

// Map flexible CSV headers → our canonical fields.
const FIELD_MAP = {
  name: ['name', 'company', 'company name', 'business', 'business name', 'dba'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  phone: ['phone', 'telephone', 'phone number', 'tel'],
  website: ['website', 'url', 'site', 'web'],
  owner: ['owner', 'owner name', 'principal', 'contact', 'contact name', 'president', 'ceo'],
  email: ['email', 'e-mail', 'email address'],
  address: ['address', 'street', 'street address', 'location'],
};

function buildHeaderMap(headers) {
  const normalizedHeaders = headers.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      if (aliases.includes(normalizedHeaders[i])) {
        map[field] = i;
        break;
      }
    }
  }
  return map;
}

function parseCsvBuffer(buffer) {
  const records = parse(buffer, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (records.length === 0) return [];
  const headerMap = buildHeaderMap(records[0]);
  if (headerMap.name === undefined) {
    throw new Error(
      'CSV must include a company name column (accepted headers: name, company, business, dba).'
    );
  }

  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    const get = (field) =>
      headerMap[field] !== undefined ? String(record[headerMap[field]] || '').trim() : '';
    const name = get('name');
    if (!name) continue;
    rows.push({
      id: nanoid(),
      name,
      name_key: normalizeName(name),
      city: get('city') || null,
      state: get('state') || null,
      phone: get('phone') || null,
      website: get('website') || null,
      owner: get('owner') || null,
      email: get('email') || null,
      address: get('address') || null,
      crm_known: 0,
    });
  }

  // Deduplicate on normalized name, keeping the first occurrence.
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    if (seen.has(row.name_key)) continue;
    seen.add(row.name_key);
    deduped.push(row);
  }
  return deduped;
}

function companiesToCsv(companies) {
  const rows = companies.map((c) => ({
    name: c.name,
    score: c.score ?? '',
    tier: c.tier ?? '',
    city: c.city ?? '',
    state: c.state ?? '',
    owner: c.owner ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    website: c.website ?? '',
    summary: c.summary ?? '',
    hard_stops: c.flags_json ? (safeJson(c.flags_json).hard_stops || []).map((f) => f.flag).join('; ') : '',
    yellow_flags: c.flags_json ? (safeJson(c.flags_json).yellow_flags || []).map((f) => f.flag).join('; ') : '',
    in_salesforce: c.crm_known ? 'yes' : 'no',
    status: c.status,
    last_researched_at: c.last_researched_at || '',
  }));
  return stringify(rows, { header: true });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

module.exports = { parseCsvBuffer, companiesToCsv };
