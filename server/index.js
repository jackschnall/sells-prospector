require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  listCompanies,
  getCompany,
  insertCompany,
  setConfig,
  getConfig,
  setCompanyOverride,
  markOutreach,
  addNote,
  getNotes,
  rollupStats,
  markCrmKnown,
} = require('./db');
const { parseCsvBuffer, companiesToCsv } = require('./csv');
const { startRun, stopRun, getRunState, addListener, removeListener, emit } = require('./agent');
const sf = require('./salesforce');
const { providerStatus } = require('./providers');
const markets = require('./markets');
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

// ---------- Upload CSV ----------
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    rows = parseCsvBuffer(req.file.buffer);
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
  const { tier, crm_known: crmKnown, search, sort } = req.query;
  const rows = listCompanies({ tier, crmKnown, search, sort });
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
  const { marked } = req.body || {};
  markOutreach(req.params.id, !!marked);
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
