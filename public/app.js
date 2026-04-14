// Sells M&A Prospector — frontend

const state = {
  companies: [],
  filter: { tier: '', search: '', sort: 'score_desc', hideCrm: false, stateFilter: '' },
  view: 'grid',
  activeId: null,
  running: false,
  sse: null,
  marketIntel: [],
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 200); }, 2400);
}

function tierClass(tier) {
  // Tiers are stored as kebab-case: strong-buy | watchlist | pass
  if (!tier) return 'pending';
  return String(tier);
}

function tierLabel(tier) {
  if (tier === 'strong-buy') return 'Likely to Sell';
  if (tier === 'watchlist') return 'Possible';
  if (tier === 'pass') return 'Unlikely';
  return '—';
}

function fmtScore(s) {
  if (s == null || Number.isNaN(+s)) return '—';
  return Number(s).toFixed(1);
}

// ---------- data loading ----------
async function loadStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  $('#mock-banner').hidden = !data.mockMode;
  document.body.classList.toggle('mock-on', !!data.mockMode);
  updateStats(data.stats);
  $('#sf-count').textContent = `${data.crmKnownCount} names on file`;
  if (data.thesis) {
    if (data.thesis.geography) $('#t-geo').value = data.thesis.geography;
  }
  // Refresh market widget after thesis loads (geography may have been set)
  if (state.marketIntel.length) renderMarketWidget();
  if (data.run && data.run.running) setRunning(true, data.run);
}

function updateStats(stats) {
  if (!stats) return;
  $('#stat-total').textContent = stats.total ?? 0;
  $('#stat-done').textContent = stats.researched ?? 0;
  $('#stat-strong').textContent = stats.strongBuy ?? 0;
  $('#stat-crm').textContent = stats.inCrm ?? 0;
}

async function loadCompanies() {
  const params = new URLSearchParams();
  if (state.filter.tier) params.set('tier', state.filter.tier);
  if (state.filter.search) params.set('search', state.filter.search);
  if (state.filter.sort) params.set('sort', state.filter.sort);
  if (state.filter.hideCrm) params.set('crm_known', '0');
  if (state.filter.stateFilter) params.set('state', state.filter.stateFilter);
  const res = await fetch(`/api/companies?${params}`);
  const data = await res.json();
  state.companies = data.companies || [];
  updateStats(data.stats);
  renderCompanies();
  renderDashboard(data.stats);
  renderExport();
  populateStateFilter();
}

// ---------- rendering ----------
function renderCompanies() {
  const host = $('#companies');
  host.className = state.view === 'grid' ? 'companies-grid' : 'companies-list';
  if (state.companies.length === 0) {
    host.innerHTML = '';
    $('#empty-state').hidden = false;
    return;
  }
  $('#empty-state').hidden = true;
  host.innerHTML = state.companies.map(renderCard).join('');
  $$('.card', host).forEach((el) => {
    el.addEventListener('click', () => openDetail(el.dataset.id));
  });
}

function renderCard(c) {
  const signals = c.signals_json ? safeParse(c.signals_json) : null;
  const barLabels = { revenue_proxy: 'Revenue', operational_quality: 'Quality', succession_signal: 'Succession', growth_trajectory: 'Growth' };
  const bars = signals
    ? ['revenue_proxy', 'operational_quality', 'succession_signal', 'growth_trajectory']
        .map((k) => {
          const v = signals[k] ?? 0;
          const score = typeof v === 'object' ? (v.score ?? 0) : v;
          return `<div class="bar" title="${barLabels[k]}: ${score}/10"><span class="bar-label">${barLabels[k]}</span><i style="width:${Math.max(0, Math.min(10, score)) * 10}%"></i></div>`;
        })
        .join('')
    : '';
  const loc = [c.city, c.state].filter(Boolean).join(', ');
  const crmBadge = c.crm_known
    ? '<span class="chip chip-crm">Already in CRM</span>'
    : '';
  const status =
    c.status === 'processing'
      ? '<span class="chip chip-processing">Researching&hellip;</span>'
      : c.status === 'error'
      ? '<span class="chip chip-error">Error</span>'
      : c.status === 'skipped'
      ? '<span class="chip chip-skip">Skipped</span>'
      : '';
  return `
    <article class="card ${c.crm_known ? 'card-dim' : ''}" data-id="${c.id}">
      <div class="card-top">
        <div class="score-badge ${tierClass(c.tier)}">${fmtScore(c.score)}</div>
        <div class="card-head">
          <div class="card-name">${escapeHtml(c.name)}</div>
          <div class="card-loc">${escapeHtml(loc || '—')}</div>
        </div>
        <div class="card-tier ${tierClass(c.tier)}">${escapeHtml(tierLabel(c.tier))}</div>
      </div>
      <div class="card-chips">${crmBadge}${status}</div>
      ${bars ? `<div class="signals">${bars}</div>` : ''}
      <div class="summary">${escapeHtml(c.summary || (c.status === 'pending' ? 'Not yet researched.' : ''))}</div>
      ${c.outreach_angle ? `<div class="outreach-angle">${escapeHtml(c.outreach_angle)}</div>` : ''}
      <div class="contact-preview">
        ${c.owner ? `<span>${escapeHtml(c.owner)}</span>` : ''}
        ${c.phone ? `<span>${escapeHtml(c.phone)}</span>` : ''}
      </div>
    </article>
  `;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

let _stateListPopulated = false;
async function populateStateFilter() {
  if (_stateListPopulated) return;
  const sel = $('#state-filter');
  if (!sel) return;
  const res = await fetch('/api/companies?sort=state_asc');
  const data = await res.json();
  const states = [...new Set((data.companies || []).map((c) => c.state).filter(Boolean))].sort();
  if (states.length === 0) return;
  _stateListPopulated = true;
  states.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

// ---------- dashboard tab ----------
function renderDashboard(stats) {
  const all = state.companies;
  const s = stats || {};
  const total = s.total ?? all.length;
  const researched = s.researched ?? all.filter((c) => c.status === 'done').length;
  const strong = s.strongBuy ?? all.filter((c) => c.tier === 'strong-buy').length;
  const watch = all.filter((c) => c.tier === 'watchlist').length;
  const pass = all.filter((c) => c.tier === 'pass').length;
  const crm = s.inCrm ?? all.filter((c) => c.crm_known).length;

  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setText('#dash-total', total);
  setText('#dash-done', researched);
  setText('#dash-strong', strong);
  setText('#dash-watch', watch);
  setText('#dash-pass', pass);
  setText('#dash-crm', crm);

  const pctEl = $('#dash-done-pct');
  if (pctEl) {
    pctEl.textContent = total > 0
      ? `${Math.round((researched / total) * 100)}% researched`
      : '—';
  }

  const subEl = $('#dash-sub');
  if (subEl) {
    subEl.textContent = total === 0
      ? 'No companies loaded yet.'
      : `${total} target${total === 1 ? '' : 's'} loaded · ${researched} researched · ${strong} high priority`;
  }

  const topHost = $('#dash-top');
  if (topHost) {
    const top = all
      .filter((c) => c.tier === 'strong-buy' && c.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5);
    if (top.length === 0) {
      topHost.innerHTML = '<div class="dash-empty">Run research to surface top candidates.</div>';
    } else {
      topHost.innerHTML = top.map((c) => {
        const loc = [c.city, c.state].filter(Boolean).join(', ');
        return `
          <div class="dash-top-row" data-id="${c.id}">
            <div class="dash-top-score ${tierClass(c.tier)}">${fmtScore(c.score)}</div>
            <div class="dash-top-main">
              <div class="dash-top-name">${escapeHtml(c.name)}</div>
              <div class="dash-top-sub">${escapeHtml(loc || '—')}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div>
            </div>
            <div class="dash-top-tier ${tierClass(c.tier)}">${escapeHtml(tierLabel(c.tier))}</div>
          </div>
        `;
      }).join('');
      $$('.dash-top-row', topHost).forEach((el) => {
        el.addEventListener('click', () => openDetail(el.dataset.id));
      });
    }
  }
}

// ---------- export tab ----------
function renderExport() {
  const host = $('#export-list');
  if (!host) return;
  const researched = state.companies
    .filter((c) => c.status === 'done' && c.tier)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (researched.length === 0) {
    host.innerHTML = '<div class="export-empty">No researched companies yet.</div>';
    return;
  }
  host.innerHTML = researched.map((c) => {
    const loc = [c.city, c.state].filter(Boolean).join(', ');
    return `
      <div class="export-row" data-id="${c.id}">
        <div class="export-score ${tierClass(c.tier)}">${fmtScore(c.score)}</div>
        <div class="export-main">
          <div class="export-name">${escapeHtml(c.name)}</div>
          <div class="export-sub">${escapeHtml(loc || '—')}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div>
        </div>
        <div class="export-tier ${tierClass(c.tier)}">${escapeHtml(tierLabel(c.tier))}</div>
        <a class="export-tearsheet" href="/tearsheet/${c.id}" target="_blank" rel="noopener">Tearsheet</a>
      </div>
    `;
  }).join('');
}

// ---------- tabs ----------
function bindTabs() {
  const tabs = $$('.tab', $('#main-tabs'));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `tab-${target}`);
      });
    });
  });
}

// ---------- agent log ----------
function appendAgentLog(text, kind = 'info') {
  const host = $('#agent-log');
  if (!host) return;
  const empty = host.querySelector('.agent-log-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = `agent-log-row agent-log-${kind}`;
  const ts = new Date().toLocaleTimeString();
  row.innerHTML = `<span class="agent-log-time">${escapeHtml(ts)}</span><span class="agent-log-msg">${escapeHtml(text)}</span>`;
  host.appendChild(row);
  host.scrollTop = host.scrollHeight;
}

function clearAgentLog() {
  const host = $('#agent-log');
  if (!host) return;
  host.innerHTML = '<div class="agent-log-empty">Awaiting events&hellip;</div>';
}

// ---------- detail panel ----------
async function openDetail(id) {
  state.activeId = id;
  const res = await fetch(`/api/companies/${id}`);
  if (!res.ok) return toast('Company not found', 'error');
  const data = await res.json();
  renderDetail(data);
  $('#detail-panel').hidden = false;
  document.body.classList.add('detail-open');
}

function closeDetail() {
  $('#detail-panel').hidden = true;
  document.body.classList.remove('detail-open');
  state.activeId = null;
}

function renderDetail(data) {
  const c = data.company;
  const signals = data.signals || {};
  const flags = data.flags || { hard_stops: [], yellow_flags: [] };
  const sources = data.sources || [];
  const notes = data.notes || [];
  const loc = [c.city, c.state].filter(Boolean).join(', ');

  $('#d-score').textContent = fmtScore(c.score);
  $('#d-score').className = `detail-score ${tierClass(c.tier)}`;
  $('#d-name').textContent = c.name;
  $('#d-sub').textContent = loc || '—';
  $('#d-tier').textContent = tierLabel(c.tier);
  $('#d-tier').className = `detail-tier ${tierClass(c.tier)}`;
  $('#d-summary').textContent = c.summary || 'No summary yet.';

  // Signals
  const weights = {
    revenue_proxy: 0.22,
    operational_quality: 0.18,
    succession_signal: 0.18,
    growth_trajectory: 0.12,
    deal_complexity: 0.1,
    geographic_fit: 0.1,
    market_quality: 0.1,
  };
  const rows = Object.entries(weights)
    .map(([k, w]) => {
      const s = signals[k] || {};
      return `
        <tr>
          <td>${escapeHtml(k.replace(/_/g, ' '))}</td>
          <td>${Math.round(w * 100)}%</td>
          <td>${escapeHtml(s.raw ?? '—')}</td>
          <td>${escapeHtml(s.notes ?? '')}</td>
          <td class="num">${s.score != null ? Number(s.score).toFixed(1) : '—'}</td>
        </tr>
      `;
    })
    .join('');
  $('#d-signals tbody').innerHTML = rows;

  // Flags
  const hardHtml = flags.hard_stops?.length
    ? flags.hard_stops.map((f) => `<div class="flag flag-hard">■ ${escapeHtml(f.flag)} <em>${escapeHtml(f.detail || '')}</em></div>`).join('')
    : '';
  const yellowHtml = flags.yellow_flags?.length
    ? flags.yellow_flags.map((f) => `<div class="flag flag-yellow">◆ ${escapeHtml(f.flag)} <em>${escapeHtml(f.detail || '')}</em></div>`).join('')
    : '';
  $('#d-flags').innerHTML = hardHtml + yellowHtml || '<div class="flag-none">No flags identified.</div>';

  // Contact
  $('#d-contact').innerHTML = `
    <div><span class="k">Owner</span><span class="v">${escapeHtml(c.owner || '—')}</span></div>
    <div><span class="k">Phone</span><span class="v">${escapeHtml(c.phone || '—')}</span></div>
    <div><span class="k">Email</span><span class="v">${escapeHtml(c.email || '—')}</span></div>
    <div><span class="k">Address</span><span class="v">${escapeHtml(c.address || '—')}</span></div>
    <div><span class="k">Website</span><span class="v">${c.website ? `<a href="${escapeHtml(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>` : '—'}</span></div>
    <div><span class="k">LinkedIn</span><span class="v">${c.linkedin ? `<a href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener">profile</a>` : '—'}</span></div>
  `;

  // Sources
  $('#d-sources').innerHTML = sources.length
    ? sources.map((s) => `<a class="source-chip" href="${escapeHtml(s.url || '#')}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url || 'source')}</a>`).join('')
    : '<div class="sb-hint">No sources recorded.</div>';

  // Notes
  $('#d-notes').innerHTML = notes.length
    ? notes.map((n) => `<div class="note"><div class="note-date">${escapeHtml(new Date(n.created_at).toLocaleString())}</div><div class="note-body">${escapeHtml(n.body)}</div></div>`).join('')
    : '<div class="sb-hint">No notes yet.</div>';

  // Actions
  $('#d-outreach').textContent = c.marked_for_outreach ? 'Un-mark Outreach' : 'Mark for Outreach';
  $('#d-override').textContent = c.crm_override ? 'Crm Override: ON' : 'Research Anyway';
  $('#d-override').hidden = !c.crm_known;
  $('#d-tearsheet').href = `/tearsheet/${c.id}`;
}

// ---------- upload ----------
function bindUpload() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files?.[0]) uploadFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) uploadFile(input.files[0]);
  });
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  $('#upload-status').textContent = 'Uploading…';
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    $('#upload-status').textContent = `Inserted ${data.inserted}/${data.parsed} companies`;
    toast(`Uploaded ${data.inserted} companies`, 'ok');
    await loadCompanies();
  } catch (err) {
    $('#upload-status').textContent = err.message;
    toast(err.message, 'error');
  }
}

// ---------- thesis / SF ----------
async function saveThesis() {
  const thesis = {
    geography: $('#t-geo').value.trim(),
  };
  await fetch('/api/thesis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(thesis),
  });
  toast('Thesis saved', 'ok');
}

async function saveSfNames() {
  const text = $('#sf-textarea').value;
  const res = await fetch('/api/salesforce/known-names', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names: text }),
  });
  const data = await res.json();
  $('#sf-count').textContent = `${data.count} names on file`;
  toast(`Matched ${data.marked} companies`, 'ok');
  await loadCompanies();
}

async function loadSfNames() {
  const res = await fetch('/api/salesforce/known-names');
  const data = await res.json();
  $('#sf-textarea').value = (data.names || []).join('\n');
}

// ---------- markets ----------
async function loadMarkets() {
  try {
    const res = await fetch('/api/market-intel');
    const data = await res.json();
    state.marketIntel = data.markets || [];
    renderMarketsTab(state.marketIntel);
    renderMarketWidget();
  } catch (err) {
    console.warn('Failed to load markets:', err);
  }
}

function renderMarketsTab(markets) {
  // Market Ranker table
  const rankerBody = $('#markets-ranker tbody');
  if (rankerBody) {
    if (!markets.length) {
      rankerBody.innerHTML = '<tr><td colspan="8" class="markets-empty">No market data yet. Click Refresh Data.</td></tr>';
    } else {
      rankerBody.innerHTML = markets
        .sort((a, b) => (b.market_score || 0) - (a.market_score || 0))
        .map((m, i) => {
          const scoreClass = (m.market_score || 0) >= 7 ? 'score-high' : (m.market_score || 0) >= 5 ? 'score-mid' : 'score-low';
          return `
            <tr class="${scoreClass}">
              <td class="rank-col">${i + 1}</td>
              <td><strong>${escapeHtml(m.city)}, ${escapeHtml(m.state)}</strong><div class="msa-sub">${escapeHtml(m.msa_name || '')}</div></td>
              <td>${fmtPop(m.population)}</td>
              <td>${m.population_growth != null ? m.population_growth.toFixed(1) + '%' : '—'}</td>
              <td>${m.median_home_value ? '$' + fmtNum(m.median_home_value) : '—'}</td>
              <td>${m.housing_permits ? fmtNum(m.housing_permits) : '—'}</td>
              <td>${m.ma_activity_score != null ? renderMiniBar(m.ma_activity_score) : '—'}</td>
              <td class="score-cell"><span class="market-score-badge ${scoreClass}">${(m.market_score || 0).toFixed(1)}</span></td>
            </tr>
          `;
        })
        .join('');
    }
  }

  // Saturation Tracker table
  const satBody = $('#markets-saturation tbody');
  if (satBody) {
    const withCompanies = markets.filter((m) => m.loaded > 0);
    if (!withCompanies.length) {
      satBody.innerHTML = '<tr><td colspan="5" class="markets-empty">No companies discovered yet. Run discovery to see saturation data.</td></tr>';
    } else {
      satBody.innerHTML = withCompanies
        .sort((a, b) => (b.coverage_pct || 0) - (a.coverage_pct || 0))
        .map((m) => {
          const satClass = m.saturation_status === 'Saturated' ? 'sat-full' :
                           m.saturation_status === 'Active' ? 'sat-active' : 'sat-fresh';
          return `
            <tr>
              <td><strong>${escapeHtml(m.city)}, ${escapeHtml(m.state)}</strong></td>
              <td>${m.loaded}</td>
              <td>${m.addressable}</td>
              <td>
                <div class="sat-bar-wrap">
                  <div class="sat-bar ${satClass}" style="width:${Math.min(100, m.coverage_pct || 0)}%"></div>
                  <span class="sat-pct">${m.coverage_pct || 0}%</span>
                </div>
              </td>
              <td><span class="sat-chip ${satClass}">${escapeHtml(m.saturation_status || 'Fresh')}</span></td>
            </tr>
          `;
        })
        .join('');
    }
  }
}

function renderMarketWidget() {
  const host = $('#market-widget');
  if (!host) return;
  const geo = ($('#t-geo')?.value || '').trim();
  if (!geo || !state.marketIntel?.length) {
    host.innerHTML = '<div class="sb-hint">Set a geography in Thesis to see market data.</div>';
    return;
  }
  // Try to match the geography to a market
  const geoLower = geo.toLowerCase();
  const match = state.marketIntel.find((m) =>
    geoLower.includes(m.city.toLowerCase()) ||
    geoLower.includes(m.msa_name?.toLowerCase() || '') ||
    (m.state && geoLower.includes(m.state.toLowerCase()))
  );
  if (!match) {
    host.innerHTML = `<div class="sb-hint">No market data for "${escapeHtml(geo)}".</div>`;
    return;
  }
  const scoreClass = (match.market_score || 0) >= 7 ? 'score-high' : (match.market_score || 0) >= 5 ? 'score-mid' : 'score-low';
  const satClass = match.saturation_status === 'Saturated' ? 'sat-full' :
                   match.saturation_status === 'Active' ? 'sat-active' : 'sat-fresh';
  host.innerHTML = `
    <div class="mw-score ${scoreClass}">
      <div class="mw-score-val">${(match.market_score || 0).toFixed(1)}</div>
      <div class="mw-score-label">Market Score</div>
    </div>
    <div class="mw-details">
      <div class="mw-name">${escapeHtml(match.city)}, ${escapeHtml(match.state)}</div>
      <div class="mw-pop">${fmtPop(match.population)} pop · ${match.population_growth?.toFixed(1) || '?'}% growth</div>
      <div class="mw-sat">
        <div class="sat-bar-wrap small">
          <div class="sat-bar ${satClass}" style="width:${Math.min(100, match.coverage_pct || 0)}%"></div>
          <span class="sat-pct">${match.coverage_pct || 0}%</span>
        </div>
        <span class="sat-chip ${satClass}">${escapeHtml(match.saturation_status || 'Fresh')}</span>
      </div>
    </div>
  `;
}

function fmtPop(n) {
  if (!n) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

function fmtNum(n) {
  if (!n) return '0';
  return Number(n).toLocaleString();
}

function renderMiniBar(val) {
  const pct = Math.max(0, Math.min(100, (val / 10) * 100));
  return `<div class="mini-bar"><div class="mini-fill" style="width:${pct}%"></div><span>${val.toFixed(1)}</span></div>`;
}

// ---------- run controls ----------
async function startRun() {
  const res = await fetch('/api/run', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    toast(data.reason || 'Could not start run', 'error');
    return;
  }
  // Auto-switch to Agent tab
  $$('.tab', $('#main-tabs')).forEach((t) => t.classList.toggle('active', t.dataset.tab === 'agent'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-agent'));
  setRunning(true);
}

async function stopRun() {
  await fetch('/api/run/stop', { method: 'POST' });
  toast('Stopping…', 'info');
}

function setRunning(running, initial = null) {
  state.running = running;
  $('#run-btn').hidden = running;
  $('#stop-btn').hidden = !running;
  $('#run-progress').hidden = !running;
  showPipeline(running);
  if (running) {
    setPipelineOrchestrator('running');
    resetPipelineStages('pending');
    if (!initial) {
      clearAgentLog();
      appendAgentLog('Research run started', 'start');
    }
    if (initial) {
      updateProgress(initial.currentIndex, initial.total, initial.currentCompany?.name);
      setPipelineCompany(initial.currentCompany?.name || '');
    }
    connectSse();
  } else {
    updateProgress(0, 0, '');
    setPipelineOrchestrator('idle');
    resetPipelineStages('idle');
    setPipelineCompany('');
  }
}

function updateProgress(idx, total, label) {
  const pct = total > 0 ? Math.round((idx / total) * 100) : 0;
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-label').textContent = total
    ? `${idx}/${total}${label ? ' — ' + label : ''}`
    : '';
}

function connectSse() {
  if (state.sse) state.sse.close();
  const sse = new EventSource('/api/run/stream');
  state.sse = sse;
  sse.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      handleSseEvent(ev);
    } catch {}
  };
  sse.onerror = () => {
    sse.close();
    state.sse = null;
  };
}

function handleSseEvent(ev) {
  switch (ev.type) {
    case 'hello':
      if (!ev.running) setRunning(false);
      break;
    case 'start':
      updateProgress(0, ev.total, '');
      setPipelineCompany('');
      setPipelineOrchestrator('running');
      resetPipelineStages('idle');
      appendAgentLog(`Run started — ${ev.total} compan${ev.total === 1 ? 'y' : 'ies'} queued`, 'start');
      break;
    case 'progress':
      updateProgress(ev.index, ev.total, ev.company?.name);
      setPipelineCompany(ev.company?.name || '');
      resetPipelineStages('pending');
      if (ev.company?.name) {
        appendAgentLog(`[${ev.index}/${ev.total}] Processing ${ev.company.name}`, 'progress');
      }
      break;
    case 'stage':
      setPipelineStage(ev.stage, ev.status);
      if (ev.status === 'running') {
        appendAgentLog(`  → ${ev.stage}`, 'stage');
      } else if (ev.status === 'error') {
        appendAgentLog(`  ✗ ${ev.stage} failed`, 'error');
      }
      break;
    case 'markets_start':
      setPipelineCompany(ev.total ? `Analyzing ${ev.total} market${ev.total === 1 ? '' : 's'}…` : '');
      if (ev.total) appendAgentLog(`Analyzing ${ev.total} market${ev.total === 1 ? '' : 's'}`, 'progress');
      break;
    case 'market':
      loadMarkets();
      break;
    case 'markets_done':
      loadMarkets();
      setPipelineCompany('');
      appendAgentLog('Market analysis complete', 'ok');
      break;
    case 'company_done':
      loadCompanies();
      if (ev.name) {
        const tierTxt = ev.tier ? ` — ${tierLabel(ev.tier)}` : '';
        const scoreTxt = ev.score != null ? ` (${fmtScore(ev.score)})` : '';
        appendAgentLog(`  ✓ ${ev.name}${tierTxt}${scoreTxt}`, 'ok');
      }
      if (state.activeId === ev.id) openDetail(ev.id);
      break;
    case 'company_error':
      toast(`Error on ${ev.name}: ${ev.error}`, 'error');
      appendAgentLog(`  ✗ ${ev.name}: ${ev.error}`, 'error');
      loadCompanies();
      break;
    case 'stopped':
      toast('Run stopped', 'info');
      appendAgentLog('Run stopped by user', 'stopped');
      setRunning(false);
      loadCompanies();
      break;
    case 'done':
      toast('Research run complete', 'ok');
      setPipelineOrchestrator('done');
      appendAgentLog('Run complete', 'done');
      setRunning(false);
      loadCompanies();
      break;
    case 'error':
      toast(`Run failed: ${ev.error}`, 'error');
      appendAgentLog(`Run failed: ${ev.error}`, 'error');
      setPipelineOrchestrator('error');
      setRunning(false);
      break;
  }
}

// ---------- pipeline visualization ----------
const PIPELINE_STAGES = ['discovery', 'research', 'scoring', 'flags'];

function setPipelineOrchestrator(status) {
  const node = $('#pipeline-orchestrator');
  if (!node) return;
  node.dataset.status = status;
}

function resetPipelineStages(status) {
  PIPELINE_STAGES.forEach((s) => setPipelineStage(s, status));
}

function setPipelineStage(stage, status) {
  const node = document.querySelector(`.pipeline-node[data-stage="${stage}"]`);
  if (!node) return;
  node.dataset.status = status;
}

function setPipelineCompany(name) {
  const el = $('#pipeline-current');
  if (!el) return;
  el.textContent = name ? `Processing: ${name}` : 'Idle';
}

function showPipeline(show) {
  // Pipeline + activity log replace the idle state during a run.
  const idle = $('#agent-idle');
  const pipe = $('#pipeline');
  if (idle) idle.hidden = !!show;
  if (pipe) {
    pipe.hidden = !show;
    pipe.classList.toggle('is-active', !!show);
  }
}

// ---------- toolbar ----------
function bindToolbar() {
  let searchT;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchT);
    state.filter.search = e.target.value;
    searchT = setTimeout(loadCompanies, 200);
  });
  $('#sort').addEventListener('change', (e) => {
    state.filter.sort = e.target.value;
    loadCompanies();
  });
  $('#state-filter').addEventListener('change', (e) => {
    state.filter.stateFilter = e.target.value;
    loadCompanies();
  });
  $('#view-grid').addEventListener('click', () => {
    state.view = 'grid';
    $('#view-grid').classList.add('active');
    $('#view-list').classList.remove('active');
    renderCompanies();
  });
  $('#view-list').addEventListener('click', () => {
    state.view = 'list';
    $('#view-list').classList.add('active');
    $('#view-grid').classList.remove('active');
    renderCompanies();
  });
  $$('.tier-chip', $('#tier-filters')).forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.tier-chip', $('#tier-filters')).forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter.tier = chip.dataset.tier;
      loadCompanies();
    });
  });
  $('#hide-crm').addEventListener('change', (e) => {
    state.filter.hideCrm = e.target.checked;
    loadCompanies();
  });
}

// ---------- detail actions ----------
function bindDetailActions() {
  $('#detail-close').addEventListener('click', closeDetail);
  $('#d-note-save').addEventListener('click', async () => {
    if (!state.activeId) return;
    const body = $('#d-note-input').value.trim();
    if (!body) return;
    const res = await fetch(`/api/companies/${state.activeId}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: body }),
    });
    if (res.ok) {
      $('#d-note-input').value = '';
      openDetail(state.activeId);
      toast('Note saved', 'ok');
    }
  });
  $('#d-outreach').addEventListener('click', async () => {
    if (!state.activeId) return;
    const row = state.companies.find((c) => c.id === state.activeId);
    const marked = !(row?.marked_for_outreach);
    await fetch(`/api/companies/${state.activeId}/outreach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marked }),
    });
    await loadCompanies();
    openDetail(state.activeId);
  });
  $('#d-override').addEventListener('click', async () => {
    if (!state.activeId) return;
    const row = state.companies.find((c) => c.id === state.activeId);
    const override = !(row?.crm_override);
    await fetch(`/api/companies/${state.activeId}/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ override }),
    });
    await loadCompanies();
    openDetail(state.activeId);
    toast(override ? 'Will research despite CRM match' : 'CRM override removed', 'ok');
  });
  $('#d-sf-push').addEventListener('click', async () => {
    if (!state.activeId) return;
    const res = await fetch(`/api/companies/${state.activeId}/salesforce-push`, { method: 'POST' });
    const data = await res.json();
    if (data.stubbed) {
      toast('Salesforce push stubbed (see server logs)', 'info');
      console.log('[SF push stub]', data);
    } else {
      toast('Pushed to Salesforce', 'ok');
    }
  });
}

// ---------- init ----------
function init() {
  bindUpload();
  bindToolbar();
  bindDetailActions();
  bindTabs();
  $('#thesis-save').addEventListener('click', async () => {
    await saveThesis();
    renderMarketWidget();
  });
  $('#sf-save').addEventListener('click', saveSfNames);
  $('#run-btn').addEventListener('click', startRun);
  $('#stop-btn').addEventListener('click', stopRun);
  $('#markets-refresh')?.addEventListener('click', async () => {
    const res = await fetch('/api/market-intel/seed', { method: 'POST' });
    const data = await res.json();
    if (data.ok) toast(`Refreshed ${data.count} markets`, 'ok');
    await loadMarkets();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#detail-panel').hidden) closeDetail();
  });

  loadStatus();
  loadSfNames();
  loadCompanies();
  loadMarkets();
}

document.addEventListener('DOMContentLoaded', init);
