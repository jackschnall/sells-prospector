require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
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
} = require('./db');
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
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Status ----------
app.get('/api/status', (req, res) => {
  res.json({
    mockMode: process.env.MOCK_MODE === '1',
    apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
    stats: rollupStats(),
    run: getRunState(),
    thesis: getConfig('thesis', {}),
    crmKnownCount: (sf.getPastedKnownNames() || []).length,
    providers: providerStatus(),
  });
});

// ---------- Upload CSV / XLSX ----------
app.post('/api/upload', upload.single('file'), (req, res) => {
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
      insertCompany(row);
      inserted++;
    } catch (err) {
      console.error('Insert error for', row.name, err.message);
    }
  }

  // Re-apply CRM known list so newly uploaded rows are flagged too.
  const known = sf.getPastedKnownNames();
  if (known.length) markCrmKnown(known);

  res.json({
    ok: true,
    parsed: rows.length,
    inserted,
    stats: rollupStats(),
  });
});

// ---------- Companies ----------
app.get('/api/companies', (req, res) => {
  const { tier, crm_known: crmKnown, search, sort, state: stateFilter, outreach: outreachStatus } = req.query;
  const rows = listCompanies({ tier, crmKnown, search, sort, stateFilter, outreachStatus });
  // Keep payload light: omit raw_research from list view
  const slim = rows.map(({ raw_research, ...rest }) => rest);
  res.json({ companies: slim, stats: rollupStats() });
});

app.get('/api/companies/:id', (req, res) => {
  const row = getCompany(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    company: row,
    signals: safeJson(row.signals_json),
    flags: safeJson(row.flags_json),
    sources: safeJson(row.sources_json) || [],
    notes: getNotes(row.id),
  });
});

app.post('/api/companies/:id/override', (req, res) => {
  const { override } = req.body || {};
  setCompanyOverride(req.params.id, !!override);
  res.json({ ok: true });
});

app.post('/api/companies/:id/outreach', (req, res) => {
  const { outreach_status } = req.body || {};
  const valid = ['no_contact', 'initial_contact', 'relationship'];
  if (!valid.includes(outreach_status)) return res.status(400).json({ error: 'Invalid outreach_status' });
  setOutreachStatus(req.params.id, outreach_status);
  res.json({ ok: true });
});

app.post('/api/companies/:id/notes', (req, res) => {
  const { note } = req.body || {};
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Empty note' });
  const saved = addNote(req.params.id, String(note).trim());
  res.json({ ok: true, note: saved });
});

app.post('/api/companies/:id/salesforce-push', (req, res) => {
  const row = getCompany(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(sf.pushStub(row));
});

// ---------- Thesis / settings ----------
// v2 sell-side reframe: thesis is just the geography for the Discovery
// worker. Everything else (tier thresholds, weights, etc.) is hard-coded
// in scoring so the deal team isn't fiddling with a rubric on each run.
app.post('/api/thesis', (req, res) => {
  const body = req.body || {};
  const geography = String(body.geography || '').trim();
  const thesis = { geography };
  setConfig('thesis', thesis);
  res.json({ ok: true, thesis });
});

// ---------- Salesforce (paste list) ----------
app.post('/api/salesforce/known-names', (req, res) => {
  const { names } = req.body || {};
  const result = sf.setPastedKnownNames(names);
  res.json({ ok: true, ...result, stats: rollupStats() });
});

app.get('/api/salesforce/known-names', (req, res) => {
  res.json({ names: sf.getPastedKnownNames() });
});

// ---------- Markets ----------
app.get('/api/markets', (req, res) => {
  res.json({ markets: markets.listAll() });
});

// ---------- Market Intelligence ----------
app.get('/api/market-intel', (req, res) => {
  const rankings = marketIntel.getRankings();
  res.json({ markets: rankings });
});

app.post('/api/market-intel/seed', (req, res) => {
  const results = marketIntel.seedMarkets();
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
// cc-inject.js POSTs here to broadcast SSE events to the frontend.
app.post('/api/_cc-event', (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'Missing event type' });
  emit(event);
  res.json({ ok: true });
});

// ---------- API key auth (for external write endpoints) ----------
function requireApiKey(req, res, next) {
  const key = process.env.API_KEY;
  if (!key) return next(); // No key configured = open (dev mode)
  if (req.headers['x-api-key'] === key) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ---------- External research injection ----------
// Mirrors cc-inject.js inject — lets Claude.ai (or any HTTP client) push research.
app.post('/api/companies/:id/research', requireApiKey, (req, res) => {
  const company = getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const data = { ...req.body };

  // Auto-stringify JSON fields if they're objects
  for (const key of ['signals_json', 'flags_json', 'sources_json', 'raw_research']) {
    if (data[key] && typeof data[key] !== 'string') {
      data[key] = JSON.stringify(data[key]);
    }
  }

  // Defaults — updateCompanyResearch expects all named params
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

  updateCompanyResearch(req.params.id, data);

  // Emit SSE so frontend updates live
  const stats = rollupStats();
  emit({ type: 'company_done', id: company.id, name: company.name, score: data.score, tier: data.tier });
  emit({ type: 'progress', done: stats.researched, total: stats.total });

  res.json({ ok: true, id: company.id, name: company.name, score: data.score, tier: data.tier });
});

// ---------- External company discovery ----------
// Mirrors cc-inject.js add — lets Claude.ai add new companies over HTTP.
app.post('/api/discover', requireApiKey, (req, res) => {
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
      insertCompany({
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
        crm_known: 0,
      });
      results.push({ ok: true, id, name: c.name, name_key });
    } catch (err) {
      const existing = listCompanies({ search: c.name });
      const match = existing.find(r => r.name_key === name_key);
      results.push({ ok: true, id: match ? match.id : 'existing', name: c.name, note: 'already exists' });
    }
  }

  emit({ type: 'queue', total: rollupStats().total });
  res.json({ ok: true, results, stats: rollupStats() });
});

// ---------- Export ----------
app.get('/api/export.csv', (req, res) => {
  const rows = listCompanies({ sort: 'score_desc' });
  const csv = companiesToCsv(rows);
  res.set({
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="sells-prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(csv);
});

app.get('/api/export.xlsx', (req, res) => {
  const rows = listCompanies({ sort: 'score_desc' });
  const geography = (getConfig('thesis', {}) || {}).geography || '';
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
app.get('/tearsheet/:id', (req, res) => {
  const row = getCompany(req.params.id);
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

// ---------- WAL Checkpoint (used by cc-inject sync) ----------
app.post('/api/_checkpoint', (req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Utilities ----------
function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- Auto-seed market intelligence if empty ----------
{
  const { db } = require('./db');
  const count = db.prepare('SELECT COUNT(*) AS n FROM markets').get().n;
  if (count === 0) {
    console.log('Seeding market intelligence data…');
    marketIntel.seedMarkets();
  }
}

// ---------- Start ----------
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
