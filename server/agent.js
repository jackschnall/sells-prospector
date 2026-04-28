const { nanoid } = require('nanoid');
const {
  companiesToResearch,
  updateCompanyResearch,
  setCompanyStatus,
  getConfig,
  insertCompany,
  normalizeName,
  execute,
} = require('./db');
const { runResearch } = require('./research');
const { runScoring } = require('./scoring');
const { runFlags } = require('./flags');
const { runDiscovery } = require('./discovery');
const { runContactEnrichment } = require('./contact-enrichment');
const { analyzeMarket } = require('./markets');
const sf = require('./salesforce');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY_BETWEEN_COMPANIES_MS = 1000;

// Simple in-process run manager. Only one run may be active at a time.
const state = {
  running: false,
  cancelRequested: false,
  currentIndex: 0,
  total: 0,
  currentCompany: null,
  startedAt: null,
  listeners: new Set(),
};

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.listeners) {
    try {
      res.write(payload);
    } catch {
      /* client disconnected */
    }
  }
}

function addListener(res) {
  state.listeners.add(res);
  res.write(
    `data: ${JSON.stringify({
      type: 'hello',
      running: state.running,
      currentIndex: state.currentIndex,
      total: state.total,
      currentCompany: state.currentCompany,
    })}\n\n`
  );
}

function removeListener(res) {
  state.listeners.delete(res);
}

async function runStage(stage, company, fn) {
  emit({ type: 'stage', stage, status: 'running', id: company.id, name: company.name });
  try {
    const result = await fn();
    emit({ type: 'stage', stage, status: 'done', id: company.id, name: company.name });
    return result;
  } catch (err) {
    emit({
      type: 'stage',
      stage,
      status: 'error',
      id: company.id,
      name: company.name,
      error: String(err.message || err),
    });
    throw err;
  }
}

// Pre-run Discovery stage — reads geography from thesis config, uses CRM
// pasted-names as a blocklist, and inserts net-new candidates before the
// per-company research loop begins. Emits orchestrator-level 'stage' events.
async function runDiscoveryStage(thesis) {
  const geography = (thesis && thesis.geography) || '';
  const blocklist = await sf.getPastedKnownNames();

  emit({ type: 'stage', stage: 'discovery', status: 'running' });

  try {
    const { candidates, notes } = await runDiscovery(geography, blocklist);

    // Insert net-new rows. insertCompany's ON CONFLICT(name_key) upsert makes
    // this safe to re-run — previously-seen names won't be duplicated.
    let inserted = 0;
    for (const cand of candidates || []) {
      if (!cand || !cand.name) continue;
      const name_key = normalizeName(cand.name);
      if (!name_key) continue;
      try {
        await insertCompany({
          id: nanoid(),
          name: cand.name,
          name_key,
          city: cand.city || null,
          state: cand.state || null,
          phone: cand.phone || null,
          website: cand.website || null,
          owner: null,
          email: null,
          address: null,
          crm_known: false,
        });
        inserted++;
      } catch (err) {
        console.warn(`[agent] Failed to insert candidate ${cand.name}:`, err.message);
      }
    }

    emit({
      type: 'stage',
      stage: 'discovery',
      status: 'done',
      candidates: (candidates || []).length,
      inserted,
      geography,
      notes: notes || '',
    });

    return { candidates: candidates || [], inserted };
  } catch (err) {
    emit({
      type: 'stage',
      stage: 'discovery',
      status: 'error',
      error: String(err.message || err),
    });
    throw err;
  }
}

// Extract contact fields from the research JSON (the RESEARCH_SYSTEM_PROMPT
// schema requires a `contact` block). Falls back to top-level fields if the
// block is absent. This replaces the separate Contacts agent stage.
function extractContacts(research) {
  const c = (research && research.contact) || {};
  const o = (research && research.owner) || {};
  return {
    owner: c.owner_name || o.name || null,
    phone: c.phone || null,
    email: c.email || null,
    address: c.address || null,
    linkedin: c.linkedin || (o.profile_url || null),
  };
}

async function processOne(company, thesis) {
  const started = Date.now();

  // 1. Research (contacts are extracted from the research JSON — no separate stage)
  const { research, sources, raw } = await runStage('research', company, () =>
    runResearch(company, thesis)
  );

  // 2. Scoring
  const scored = await runStage('scoring', company, () =>
    runScoring(company, research, thesis)
  );

  // 3. Flags
  const flags = await runStage('flags', company, () => runFlags(company, research));

  // 4. Contact Enrichment — two-phase identity resolution + people-search
  let enrichedContact = null;
  let contactEnrichmentJson = null;
  try {
    const enrichResult = await runStage('contact_enrichment', company, () =>
      runContactEnrichment(company, research)
    );
    enrichedContact = enrichResult.contact;
    contactEnrichmentJson = JSON.stringify({
      identity: enrichResult.identity,
      enrichment: enrichResult.enrichment,
      contact: enrichResult.contact,
    });
  } catch (err) {
    console.warn(`[agent] Contact enrichment failed for ${company.name}:`, err.message);
    // Fall back to basic contact extraction from research
  }

  // Contacts — prefer enriched data, fall back to research extraction
  const basicContacts = extractContacts(research);
  const contacts = enrichedContact
    ? {
        owner: enrichedContact.owner_name || basicContacts.owner,
        phone: enrichedContact.direct_cell || enrichedContact.business_phone || basicContacts.phone,
        phone_type: enrichedContact.direct_cell ? 'direct_cell' : 'office',
        email: enrichedContact.direct_email || basicContacts.email,
        address: enrichedContact.business_address || basicContacts.address,
        linkedin: enrichedContact.linkedin_url || basicContacts.linkedin,
      }
    : { ...basicContacts, phone_type: 'office' };

  // Persist
  const persistData = {
    status: 'done',
    score: scored.final_score,
    tier: scored.tier,
    signals_json: JSON.stringify(scored.signals),
    flags_json: JSON.stringify(flags),
    summary: scored.summary,
    outreach_angle: scored.outreach_angle || null,
    sources_json: JSON.stringify(sources),
    raw_research: typeof raw === 'string' ? raw : JSON.stringify(research),
    owner: contacts.owner,
    phone: contacts.phone,
    email: contacts.email,
    address: contacts.address,
    linkedin: contacts.linkedin,
  };
  // Set phone_type separately (not in updateCompanyResearch)
  if (contacts.phone_type) {
    execute('UPDATE companies SET phone_type = $1 WHERE id = $2', [contacts.phone_type, company.id]).catch(() => {});
  }
  if (contactEnrichmentJson) {
    persistData.contact_enrichment = contactEnrichmentJson;
  }
  await updateCompanyResearch(company.id, persistData);

  const elapsedMs = Date.now() - started;
  return { scored, flags, contacts, enrichedContact, elapsedMs };
}

async function runAll() {
  if (state.running) throw new Error('A run is already in progress.');

  state.running = true;
  state.cancelRequested = false;
  state.startedAt = Date.now();

  const thesis = (await getConfig('thesis', {})) || {};

  emit({ type: 'start', mock: process.env.MOCK_MODE === '1' });

  // 0. Discovery — find net-new candidates and insert them before research.
  try {
    await runDiscoveryStage(thesis);
  } catch (err) {
    console.error('[agent] Discovery failed:', err.message);
    // Continue with any already-pending companies; don't abort the whole run.
  }

  if (state.cancelRequested) {
    state.running = false;
    emit({ type: 'stopped', processed: 0, total: 0 });
    return;
  }

  const queue = await companiesToResearch();
  state.total = queue.length;
  state.currentIndex = 0;

  emit({ type: 'queue', total: queue.length });

  // Analyze unique markets (city, state) before per-company research.
  const seen = new Set();
  const marketPairs = [];
  for (const c of queue) {
    const city = (c.city || '').trim();
    const st = (c.state || '').trim();
    if (!city || !st) continue;
    const key = `${city.toLowerCase()}|${st.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marketPairs.push({ city, state: st });
  }

  emit({ type: 'markets_start', total: marketPairs.length });
  for (let m = 0; m < marketPairs.length; m++) {
    if (state.cancelRequested) break;
    const { city, state: st } = marketPairs[m];
    try {
      const row = await analyzeMarket(city, st);
      if (row) {
        emit({
          type: 'market',
          index: m + 1,
          total: marketPairs.length,
          city: row.city,
          state: row.state,
          tier: row.tier,
          score: row.score,
          loaded: row.loaded,
          addressable: row.addressable,
          population: row.population,
        });
      }
    } catch (err) {
      console.warn(`[agent] Market analysis failed for ${city}, ${st}:`, err.message);
    }
  }
  emit({ type: 'markets_done', total: marketPairs.length });

  for (let i = 0; i < queue.length; i++) {
    if (state.cancelRequested) {
      emit({ type: 'stopped', processed: i, total: queue.length });
      break;
    }

    const company = queue[i];
    state.currentIndex = i + 1;
    state.currentCompany = { id: company.id, name: company.name };

    emit({
      type: 'progress',
      index: i + 1,
      total: queue.length,
      company: { id: company.id, name: company.name, city: company.city, state: company.state },
    });

    await setCompanyStatus(company.id, 'processing');

    try {
      const result = await processOne(company, thesis);
      emit({
        type: 'company_done',
        id: company.id,
        name: company.name,
        score: result.scored.final_score,
        tier: result.scored.tier,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      console.error(`[agent] Error processing ${company.name}:`, err.message);
      await setCompanyStatus(company.id, 'error', String(err.stack || err.message || err));
      emit({ type: 'company_error', id: company.id, name: company.name, error: String(err.message || err) });
    }

    if (i < queue.length - 1 && !state.cancelRequested) {
      await sleep(DELAY_BETWEEN_COMPANIES_MS);
    }
  }

  state.running = false;
  state.currentCompany = null;
  emit({ type: 'done', total: queue.length, elapsedMs: Date.now() - state.startedAt });
}

function startRun() {
  if (state.running) return { ok: false, reason: 'already-running' };
  runAll().catch((err) => {
    console.error('[agent] Run failed:', err);
    state.running = false;
    emit({ type: 'error', error: String(err.message || err) });
  });
  return { ok: true };
}

function stopRun() {
  if (!state.running) return { ok: false, reason: 'not-running' };
  state.cancelRequested = true;
  return { ok: true };
}

function getRunState() {
  return {
    running: state.running,
    currentIndex: state.currentIndex,
    total: state.total,
    currentCompany: state.currentCompany,
  };
}

module.exports = { startRun, stopRun, getRunState, addListener, removeListener, emit };
