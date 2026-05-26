// Sells M&A Prospector — frontend

const ROLE_LABELS = { analyst: 'Analyst', researcher: 'Researcher', associate: 'M&A Associate', admin: 'Admin' };

const state = {
  companies: [],
  filter: { tier: '', search: '', sort: 'score_desc', hideCrm: false, stateFilter: '', pipelineStage: '', industries: [] },
  view: 'grid',
  activeId: null,
  running: false,
  sse: null,
  marketIntel: [],
  pipelineStages: [],
  pipelineBoard: {},
  // Phase 2
  user: null,
  twilioStatus: null,
  twilioDevice: null,
  twilioActiveCall: null,
  queue: [],
  queuePins: [],
  queueActiveId: null,
  queueCallLogId: null,
  queueCallTimer: null,
  queueCallStart: 0,
  queuePollTimer: null,
  detailCallLogId: null,
  detailCallTimer: null,
  detailCallStart: 0,
  detailActiveCall: null,
  debriefCall: null,
  debriefDraftTimer: null,
  callTargets: [],
  activeTargetFilter: null,
  editingTargetId: null,
  calendarCursor: null, // {year, month}
  calendarEvents: [],
  calendarEditing: null,
  calendarCompanyMatches: [],
  settingsUsers: [],
  settingsEditingUser: null,
  pendingDebriefs: [],
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
  if (tier === 'strong-buy') return 'Prime';
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
  if (state.marketIntel.length) renderMarketWidget();
}

function updateStats(stats) {
  if (!stats) return;
  $('#stat-total').textContent = stats.total ?? 0;
  $('#stat-done').textContent = stats.researched ?? 0;
  $('#stat-strong').textContent = stats.strongBuy ?? 0;
  const mt = $('#method-total');
  if (mt) mt.textContent = stats.researched ?? 0;
  // Update industry dropdown labels with counts
  if (stats.industryCounts) {
    const drop = $('#industry-filter-dropdown');
    if (drop) {
      $$('input[type="checkbox"]', drop).forEach(cb => {
        if (cb.id === 'industry-select-all') return;
        const label = cb.parentElement;
        const val = cb.value;
        const cnt = stats.industryCounts[val] || 0;
        const textNode = label.childNodes[label.childNodes.length - 1];
        if (textNode && textNode.nodeType === 3) {
          textNode.textContent = ` ${val} (${cnt})`;
        }
      });
    }
  }
}

async function loadCompanies() {
  const params = new URLSearchParams();
  if (state.filter.tier) params.set('tier', state.filter.tier);
  if (state.filter.search) params.set('search', state.filter.search);
  if (state.filter.sort) params.set('sort', state.filter.sort);
  if (state.filter.hideCrm) params.set('crm_known', '0');
  if (state.filter.stateFilter) params.set('state', state.filter.stateFilter);
  if (state.filter.pipelineStage) params.set('pipeline_stage', state.filter.pipelineStage);
  const allIndustryCount = $$('input[type="checkbox"]', $('#industry-filter-dropdown')).length || 6;
  if (state.filter.industries.length && state.filter.industries.length < allIndustryCount) {
    params.set('industry', state.filter.industries.join(','));
  }
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

// Derive rough signal scores from key_info for manually added companies
function deriveSignalsFromKeyInfo(c) {
  const ki = c.key_info ? (typeof c.key_info === 'object' ? c.key_info : safeParse(c.key_info)) : null;
  const intel = c.call_intelligence || '';
  if (!ki && !intel) return null;
  const derived = {};
  // Revenue: map dollar amount to score
  if (ki?.revenue) {
    const m = String(ki.revenue).match(/(\d+)/);
    if (m) {
      const rev = Number(m[1]);
      derived.revenue_proxy = rev >= 50 ? 9 : rev >= 20 ? 7 : rev >= 10 ? 6 : rev >= 5 ? 5 : 4;
    }
  }
  // Succession: check for age, retirement, family mentions
  if (ki?.owner_age || intel.match(/retire|succession|exit|sell/i)) {
    const age = Number(ki?.owner_age) || 0;
    derived.succession_signal = age >= 65 ? 8 : age >= 55 ? 6 : intel.match(/retire|exit|sell/i) ? 7 : null;
  }
  // Growth: check for growth mentions
  if (intel.match(/growth|growing|200%|expanded|expansion/i)) {
    derived.growth_trajectory = 7;
  }
  // Only return if we have at least one signal
  const keys = Object.keys(derived).filter((k) => derived[k] != null);
  return keys.length > 0 ? derived : null;
}

function renderCard(c) {
  let signals = c.signals_json ? safeParse(c.signals_json) : null;
  // Fall back to derived signals from call data for manually added companies
  if (!signals) signals = deriveSignalsFromKeyInfo(c);
  const barLabels = { revenue_proxy: 'Revenue', operational_quality: 'Quality', succession_signal: 'Succession', growth_trajectory: 'Growth' };
  const bars = signals
    ? ['revenue_proxy', 'operational_quality', 'succession_signal', 'growth_trajectory']
        .filter((k) => signals[k] != null)
        .map((k) => {
          const v = signals[k] ?? 0;
          const score = typeof v === 'object' ? (v.score ?? 0) : v;
          return `<div class="signal-col" title="${barLabels[k]}: ${score}/10"><span class="bar-label">${barLabels[k]}</span><div class="bar-track"><i style="width:${Math.max(0, Math.min(10, score)) * 10}%"></i></div></div>`;
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
  const stageInfo = state.pipelineStages.find((s) => s.key === c.pipeline_stage);
  const stageChip = stageInfo && c.pipeline_stage !== 'no_contact'
    ? `<span class="chip chip-stage">${escapeHtml(stageInfo.label)}</span>`
    : '';
  const isWarm = c.warm_until && new Date(c.warm_until) > new Date();
  return `
    <article class="card ${c.crm_known ? 'card-dim' : ''}" data-id="${c.id}">
      <div class="card-top">
        <div class="score-badge ${tierClass(c.tier)}">${fmtScore(c.score)}</div>
        <div class="card-head">
          <div class="card-name">${escapeHtml(c.name)}${isWarm ? '<span class="warm-badge" title="Engaged — opened email or had positive call">🔥</span>' : ''}</div>
          <div class="card-loc">${escapeHtml(loc || '—')}</div>
        </div>
        <div class="card-tier ${tierClass(c.tier)}">${escapeHtml(tierLabel(c.tier))}</div>
      </div>
      <div class="card-chips">${crmBadge}${status}${stageChip}</div>
      ${bars ? `<div class="signals">${bars}</div>` : ''}
      <div class="summary">${escapeHtml(c.summary || (c.call_intelligence ? c.call_intelligence.replace(/\*\*/g, '').replace(/^• /gm, '').split('\n').slice(0, 3).join('. ') : (c.status === 'pending' ? 'Not yet researched.' : '')))}</div>
      ${c.outreach_angle ? `<div class="outreach-angle">${escapeHtml(c.outreach_angle)}</div>` : ''}
      <div class="contact-preview">
        ${c.owner ? `<span>${escapeHtml(c.owner)}</span>` : ''}
        ${c.phone ? `<span>${escapeHtml(c.phone)} <small style="color:var(--text-muted)">${c.phone_type === 'direct_cell' ? '(Direct)' : '(Office)'}</small></span>` : ''}
      </div>
    </article>
  `;
}

function safeParse(s) {
  if (s && typeof s === 'object') return s;
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

  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setText('#dash-total', total);
  setText('#dash-done', researched);
  setText('#dash-strong', strong);
  setText('#dash-watch', watch);
  setText('#dash-pass', pass);
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

  // Pipeline summary bar
  const pipHost = $('#dash-pipeline');
  if (pipHost && state.pipelineBoard && state.pipelineStages.length) {
    const board = state.pipelineBoard;
    const stageColors = { no_contact: '#8B8FA3', outreach_started: '#6366F1', initial_contact: '#3B82F6', relationship_established: '#10B981', prep: '#F59E0B', market: '#EC4899', loi: '#06B6D4', close: '#22C55E', nurture: '#8B5CF6', lead_memo: '#F59E0B', pitch: '#EC4899', engagement_letter: '#10B981', lois_collected: '#06B6D4', deal_closed: '#22C55E', closed_lost: '#EF4444' };
    const totalInPipeline = Object.values(board).reduce((s, arr) => s + arr.length, 0) || 1;
    pipHost.innerHTML = '<div class="pip-bar">' + state.pipelineStages.map((s) => {
      const count = (board[s.key] || []).length;
      if (!count) return '';
      const pct = Math.max(2, (count / totalInPipeline) * 100);
      return `<div class="pip-seg" style="width:${pct}%;background:${stageColors[s.key] || '#888'}" title="${s.label}: ${count}"></div>`;
    }).join('') + '</div><div class="pip-legend">' + state.pipelineStages.map((s) => {
      const count = (board[s.key] || []).length;
      return `<span class="pip-leg-item"><span class="pip-dot" style="background:${stageColors[s.key] || '#888'}"></span>${s.label} <strong>${count}</strong></span>`;
    }).join('') + '</div>';
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

  // Activity feed
  loadDashActivity();
  // Top Metros
  loadDashMetros();
}

async function loadDashActivity() {
  const host = $('#dash-activity');
  if (!host) return;
  try {
    const res = await fetch('/api/activity-log?limit=5');
    if (!res.ok) return;
    const { activities } = await res.json();
    if (!activities || !activities.length) {
      host.innerHTML = '<div class="dash-empty">No recent activity.</div>';
      return;
    }
    host.innerHTML = activities.map(a => {
      const ago = timeAgo(a.created_at);
      const user = a.user_name ? `<strong>${escapeHtml(a.user_name.split(' ').map(n => n[0] + '.').join(' '))}</strong>` : '<strong>Agent</strong>';
      const company = a.company_name ? `<a href="#" onclick="openDetail('${a.company_id}');return false;">${escapeHtml(a.company_name)}</a>` : '';
      const actionLabels = {
        sms: 'texted', call: 'called', email: 'emailed', note: 'added a note to',
        stage_change: 'moved', crm_action: 'updated', research: 'researched',
        meeting: 'met with', voicemail: 'left voicemail for',
      };
      const action = actionLabels[a.type] || a.description || a.type || '';
      return `<div class="dash-activity-item"><span class="dash-activity-time">${ago}</span><span class="dash-activity-text">${user} ${action} ${company}</span></div>`;
    }).join('');
  } catch {}
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  return days + 'd';
}

async function loadDashMetros() {
  const host = $('#dash-metros');
  if (!host) return;
  try {
    const res = await fetch('/api/market-intel');
    if (!res.ok) return;
    const { markets } = await res.json();
    if (!markets || !markets.length) {
      host.innerHTML = '<div class="dash-empty">No market data yet.</div>';
      return;
    }
    const sorted = markets.sort((a, b) => (b.market_score || 0) - (a.market_score || 0)).slice(0, 5);
    host.innerHTML = sorted.map((m, i) => {
      const name = [m.city, m.state].filter(Boolean).join(', ') || m.metro || '—';
      const pg = Number(m.population_growth || 0);
      const growth = pg ? `+${pg.toFixed(1)}%` : '';
      const score = Number(m.market_score || 0).toFixed(1);
      return `<div class="dash-metro-item"><span class="dash-metro-rank">0${i + 1}</span><span class="dash-metro-name">${escapeHtml(name)}</span><span class="dash-metro-growth">${growth}</span><span class="dash-metro-score">${score}</span></div>`;
    }).join('');
  } catch {}
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

// ---------- pipeline / kanban ----------
async function loadPipelineStages() {
  const res = await fetch('/api/pipeline/stages');
  const data = await res.json();
  state.pipelineStages = data.stages || [];
  // Populate pipeline filter dropdown in companies toolbar
  const sel = $('#pipeline-filter');
  if (sel && state.pipelineStages.length) {
    sel.innerHTML = '<option value="">All Stages</option>' +
      state.pipelineStages.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
  }
}

async function loadPipelineBoard() {
  const res = await fetch('/api/pipeline/board');
  const data = await res.json();
  state.pipelineBoard = data.board || {};

  // Enriched: batch-fetch milestones + users
  const allIds = [];
  for (const stage of Object.keys(state.pipelineBoard)) {
    for (const c of state.pipelineBoard[stage]) allIds.push(c.id);
  }
  const [msRes, usersRes] = await Promise.all([
    allIds.length ? fetch(`/api/milestones/batch?ids=${allIds.join(',')}`).then(r => r.json()).catch(() => ({ milestones: {} })) : { milestones: {} },
    fetch('/api/auth/users').then(r => r.json()).catch(() => ({ users: [] })),
  ]);
  window._pipelineMilestones = msRes.milestones || {};
  window._pipelineUsersMap = {};
  for (const u of (usersRes.users || [])) window._pipelineUsersMap[u.id] = u;

  renderPipelineBoard();
}

function renderPipelineBoard() {
  const host = $('#kanban-board');
  if (!host) return;
  const stages = state.pipelineStages;
  if (!stages.length) { host.innerHTML = '<div class="dash-empty">Loading pipeline stages...</div>'; return; }

  const tierFilter = state.filter.tier || '';
  const staleOnly = !!($('#stale-filter-toggle') && $('#stale-filter-toggle').checked);
  const pipelineSearch = ($('#pipeline-search')?.value || '').toLowerCase().trim();
  let totalCount = 0;
  host.innerHTML = stages.map((s) => {
    const all = state.pipelineBoard[s.key] || [];
    let companies = tierFilter ? all.filter((c) => c.tier === tierFilter) : all;
    if (staleOnly) {
      companies = companies.filter(c => {
        const d = c.updated_at ? Math.floor((Date.now() - new Date(c.updated_at).getTime()) / 86400000) : null;
        return d != null && d > 7;
      });
    }
    if (pipelineSearch) {
      companies = companies.filter(c =>
        (c.name || '').toLowerCase().includes(pipelineSearch) ||
        (c.owner || '').toLowerCase().includes(pipelineSearch) ||
        (c.city || '').toLowerCase().includes(pipelineSearch) ||
        (c.state || '').toLowerCase().includes(pipelineSearch)
      );
    }
    totalCount += companies.length;
    const dividerAfter = s.key === 'relationship_established' ? '<div class="kanban-divider"><div class="kanban-divider-label">Engagement Letter Signed</div><div class="kanban-divider-line"></div></div>' : '';
    return `
      <div class="kanban-col" data-stage="${s.key}">
        <div class="kanban-col-header">
          <span class="kanban-col-title">${escapeHtml(s.label)}</span>
          <span class="kanban-col-count">${companies.length}</span>
        </div>
        <div class="kanban-col-body" data-stage="${s.key}">
          ${companies.length === 0
            ? '<div class="kanban-empty">No companies</div>'
            : companies.map(renderKanbanCard).join('')}
        </div>
      </div>
      ${dividerAfter}
    `;
  }).join('');

  const countEl = $('#pipeline-total-count');
  if (countEl) countEl.textContent = `${totalCount} companies total`;

  // Click handlers on kanban cards — open deal popup instead of detail panel
  $$('.kanban-card', host).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('kc-dot')) return;
      openDealPopup(el.dataset.id);
    });
  });

  // Milestone dot click handlers
  $$('.kc-dot', host).forEach(dot => {
    dot.addEventListener('click', async (e) => {
      e.stopPropagation();
      const companyId = dot.dataset.company;
      const key = dot.dataset.key;
      const res = await fetch(`/api/companies/${companyId}/milestones/${key}`, { method: 'PUT' });
      if (res.ok) {
        const data = await res.json();
        const color = data.state === 'complete' ? 'var(--green)' : data.state === 'in_progress' ? 'var(--gold)' : '#ccc';
        dot.style.background = color;
        dot.dataset.state = data.state;
        dot.title = `${key.replace(/_/g, ' ')} (${data.state})`;
        if (window._pipelineMilestones) {
          if (!window._pipelineMilestones[companyId]) window._pipelineMilestones[companyId] = {};
          window._pipelineMilestones[companyId][key] = data.state;
        }
      }
    });
  });

  // Drag and drop
  $$('.kanban-card', host).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  $$('.kanban-col-body', host).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const companyId = e.dataTransfer.getData('text/plain');
      const newStage = col.dataset.stage;
      if (!companyId || !newStage) return;

      if (newStage === 'closed_lost') {
        const reason = prompt('Closed/Lost reason:\n1) No Interest\n2) Bad Timing\n3) Ineligible\n\nEnter 1, 2, or 3:');
        const reasons = { '1': 'no_interest', '2': 'bad_timing', '3': 'ineligible' };
        const mapped = reasons[reason];
        if (!mapped) { toast('Stage change cancelled', 'info'); return; }
        await changePipelineStage(companyId, newStage, mapped);
      } else {
        await changePipelineStage(companyId, newStage);
      }
    });
  });
}

function renderKanbanCard(c) {
  const daysInStage = c.pipeline_stage_changed_at
    ? Math.max(0, Math.floor((Date.now() - new Date(c.pipeline_stage_changed_at).getTime()) / 86400000))
    : null;
  const daysStale = c.updated_at
    ? Math.floor((Date.now() - new Date(c.updated_at).getTime()) / 86400000)
    : null;
  const isStale = daysStale != null && daysStale > 7;

  // Enrichment: valuation, probability, est_close_date, deal_owner
  const valStr = c.valuation ? `$${(c.valuation / 1000000).toFixed(1)}M` : '';
  const prob = c.probability;
  const probBar = prob != null ? `<div class="kc-prob"><div class="kc-prob-bar" style="width:${Math.min(100, prob)}%;background:${prob >= 70 ? 'var(--green)' : prob >= 40 ? 'var(--gold)' : 'var(--red)'}"></div><span class="kc-prob-label">${prob}%</span></div>` : '';
  let closeBadge = '';
  if (c.est_close_date) {
    const daysToClose = Math.floor((new Date(c.est_close_date) - Date.now()) / 86400000);
    const cls = daysToClose < 0 ? 'kc-close-overdue' : daysToClose <= 30 ? 'kc-close-soon' : 'kc-close-ok';
    closeBadge = `<span class="kc-close-badge ${cls}">${new Date(c.est_close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
  }
  const ownerUser = c.deal_owner_id && window._pipelineUsersMap && window._pipelineUsersMap[c.deal_owner_id];
  const ownerCircle = ownerUser ? `<span class="kc-owner-circle" title="${escapeHtml(ownerUser.name)}">${userInitials(ownerUser.name)}</span>` : '';

  // Milestone dots
  const MS_KEYS = ['buyer_list','qoe','teaser','cim','network_intros','buyer_outreach','iois_received','mgmt_meetings','lois_received','loi_signed','diligence','closing'];
  const ms = (window._pipelineMilestones && window._pipelineMilestones[c.id]) || {};
  const dots = MS_KEYS.map(k => {
    const s = ms[k] || 'not_started';
    const color = s === 'complete' ? 'var(--green)' : s === 'in_progress' ? 'var(--gold)' : '#ccc';
    return `<span class="kc-dot" data-company="${c.id}" data-key="${k}" data-state="${s}" style="background:${color}" title="${k.replace(/_/g, ' ')} (${s})"></span>`;
  }).join('');

  return `
    <div class="kanban-card ${tierClass(c.tier)} ${isStale ? 'kc-stale' : ''}" data-id="${c.id}" draggable="true" data-stale="${isStale ? '1' : '0'}">
      ${isStale ? '<span class="kc-stale-dot" title="Stale - not updated in 7+ days"></span>' : ''}
      <div class="kc-top">
        <span class="kc-score ${tierClass(c.tier)}">${fmtScore(c.score)}</span>
        <span class="kc-name">${escapeHtml(c.name)}${c.warm_until && new Date(c.warm_until) > new Date() ? '<span class="warm-badge" title="Engaged — opened email or had positive call">🔥</span>' : ''}</span>
        ${ownerCircle}
      </div>
      <div class="kc-meta">
        ${c.owner ? escapeHtml(c.owner) : ''}
        ${c.city ? ' · ' + escapeHtml(c.city) + (c.state ? ', ' + escapeHtml(c.state) : '') : ''}
      </div>
      ${valStr || prob != null || c.est_close_date ? `<div class="kc-deal-info">
        ${valStr ? `<div class="kc-deal-row"><span class="kc-deal-label">Valuation</span><span class="kc-deal-value">${valStr}</span></div>` : ''}
        ${prob != null ? `<div class="kc-deal-row"><span class="kc-deal-label">Probability</span><span class="kc-deal-value">${prob}%</span></div>` : ''}
        ${c.est_close_date ? `<div class="kc-deal-row"><span class="kc-deal-label">Close</span><span class="kc-deal-value">${new Date(c.est_close_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} ${closeBadge}</span></div>` : ''}
        ${probBar}
      </div>` : ''}
      <div class="kc-milestones">${dots}</div>
      ${daysInStage != null ? `<div class="kc-days">${daysInStage}d in stage</div>` : ''}
      ${c.closed_lost_reason ? `<span class="kc-reason">${escapeHtml(formatClosedReason(c.closed_lost_reason))}</span>` : ''}
    </div>
  `;
}

function formatClosedReason(r) {
  const map = { no_interest: 'No Interest', bad_timing: 'Bad Timing', ineligible: 'Ineligible' };
  return map[r] || r;
}

async function changePipelineStage(companyId, stage, closedLostReason) {
  const body = { stage };
  if (closedLostReason) body.closed_lost_reason = closedLostReason;
  const res = await fetch(`/api/companies/${companyId}/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Failed to change stage', 'error');
    return;
  }
  const stageLabel = state.pipelineStages.find((s) => s.key === stage)?.label || stage;
  toast(`Moved to ${stageLabel}`, 'ok');
  loadPipelineBoard();
  if (state.activeId === companyId) openDetail(companyId);
}

// ---------- contacts in detail ----------
function renderContacts(contacts) {
  const host = $('#d-contacts');
  const countEl = $('#d-contacts-count');
  if (countEl) countEl.textContent = contacts.length;
  if (!contacts.length) {
    host.innerHTML = '<div class="sb-hint">No contacts yet.</div>';
    return;
  }
  host.innerHTML = contacts.map((ct) => `
    <div class="ct-card" data-contact-id="${ct.id}">
      <div class="ct-top">
        <strong>${escapeHtml(ct.name)}</strong>
        ${ct.is_primary ? '<span class="ct-badge">Primary</span>' : ''}
        ${ct.source === 'research' ? '<span class="ct-badge ct-badge-ai">AI</span>' : ''}
      </div>
      ${ct.title ? `<div class="ct-detail">${escapeHtml(ct.title)}</div>` : ''}
      <div class="ct-contact-info">
        ${ct.phone ? `<div class="ct-info-row"><span class="ct-info-label">Phone:</span> ${escapeHtml(ct.phone)}</div>` : ''}
        ${(() => { const extra = ct.phones ? (typeof ct.phones === 'string' ? JSON.parse(ct.phones || '[]') : ct.phones) : []; return extra.map(p => `<div class="ct-info-row ct-extra"><span class="ct-info-label">Phone:</span> ${escapeHtml(p)}</div>`).join(''); })()}
        ${ct.email ? `<div class="ct-info-row"><span class="ct-info-label">Email:</span> ${escapeHtml(ct.email)}${ct.is_primary ? ' <span class="ct-badge ct-badge-email">Campaign Email</span>' : ''}</div>` : ct.is_primary ? '<div class="ct-info-row"><span class="ct-no-email">No email set — needed for campaigns</span></div>' : ''}
        ${(() => { const extra = ct.emails ? (typeof ct.emails === 'string' ? JSON.parse(ct.emails || '[]') : ct.emails) : []; return extra.map(e => `<div class="ct-info-row ct-extra"><span class="ct-info-label">Email:</span> ${escapeHtml(e)}</div>`).join(''); })()}
        ${ct.linkedin ? `<div class="ct-info-row"><span class="ct-info-label">LinkedIn:</span> <a href="${escapeHtml(ct.linkedin)}" target="_blank" rel="noopener">${escapeHtml(ct.linkedin)}</a></div>` : ''}
      </div>
      <div class="ct-actions">
        <button type="button" class="btn-ghost btn-xs ct-edit" data-id="${ct.id}">Edit</button>
        <button type="button" class="btn-ghost btn-xs ct-del" data-id="${ct.id}">Delete</button>
      </div>
    </div>
  `).join('');

  // Bind edit buttons
  $$('.ct-edit', host).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ctId = btn.dataset.id;
      const ct = contacts.find((c) => c.id === ctId);
      if (!ct) return;
      $('#cf-name').value = ct.name || '';
      $('#cf-title').value = ct.title || '';
      $('#cf-phone').value = ct.phone || '';
      $('#cf-email').value = ct.email || '';
      $('#cf-linkedin').value = ct.linkedin || '';
      $('#cf-save').dataset.editId = ctId;
      $('#d-contact-form').hidden = false;
      $('#cf-name').focus();
    });
  });
  // Bind delete buttons
  $$('.ct-del', host).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this contact?')) return;
      const res = await fetch(`/api/contacts/${btn.dataset.id}`, { method: 'DELETE' });
      if (res.ok) { toast('Contact deleted', 'ok'); openDetail(state.activeId); }
    });
  });
}

// ---------- activities in detail ----------
const ACTIVITY_ICONS = { note: '&#9998;', call: '&#9743;', email: '&#9993;', meeting: '&#9632;', stage_change: '&#9654;', research: '&#9670;', sms: '&#128172;', crm_action: '&#9881;' };

function renderActivities(activities) {
  const host = $('#d-activities');
  if (!activities.length) {
    host.innerHTML = '<div class="sb-hint">No activity yet.</div>';
    return;
  }
  host.innerHTML = activities.map((a) => `
    <div class="act-item act-${a.type}">
      <span class="act-icon">${ACTIVITY_ICONS[a.type] || '&#9679;'}</span>
      <div class="act-body">
        <div class="act-summary">${escapeHtml(a.summary)}</div>
        ${a.details ? `<div class="act-details">${escapeHtml(a.details)}</div>` : ''}
        <div class="act-meta">${escapeHtml(new Date(a.created_at).toLocaleString())}${a.user_name ? ' · ' + escapeHtml(a.user_name) : ''}</div>
      </div>
    </div>
  `).join('');
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
      if (target === 'pipeline') loadPipelineBoard();
      if (target === 'queue') loadQueue();
      if (target === 'calendar') loadCalendar();
      if (target === 'settings') loadSettings();
      if (target === 'contacts') loadAllContacts();
      if (target === 'campaigns') { loadCampaignsList(); populateCampStateDropdown(); }
      if (target === 'reports') loadMandates();
      if (target === 'deleted') loadDeletedItems();
      if (target === 'actlog') loadActivityLog();
      if (target === 'inbox') loadInbox();
      if (target === 'advisors') loadAdvisors();
      // Disable tier filter sidebar on tabs where it doesn't apply
      const tierApplies = ['companies', 'dashboard', 'pipeline'].includes(target);
      const sidebar = $('#tier-filters');
      if (sidebar) sidebar.classList.toggle('tier-disabled', !tierApplies);
    });
  });
}

function applyTabVisibility() {
  const user = state.user;
  const tabs = $$('.tab', $('#main-tabs'));
  tabs.forEach((tab) => {
    const needsUser = tab.dataset.requiresUser === '1';
    const needsAdmin = tab.dataset.requiresAdmin === '1';
    let show = true;
    if (needsUser && !user) show = false;
    if (needsAdmin && (!user || user.role !== 'admin')) show = false;
    tab.hidden = !show;
  });
}

// ---------- detail panel ----------
async function openDetail(id) {
  state.activeId = id;
  const res = await fetch(`/api/companies/${id}`);
  if (!res.ok) return toast('Company not found', 'error');
  const data = await res.json();
  renderDetail(data);
  renderCallHistory(id);
  loadCompanyMandates(id);
  loadDealContacts(id);
  $('#detail-panel').hidden = false;
  document.body.classList.add('detail-open');
}

function closeDetail() {
  const panel = $('#detail-panel');
  panel.hidden = true;
  panel.classList.remove('fullscreen');
  document.body.classList.remove('detail-open');
  document.body.classList.remove('detail-fullscreen');
  const btn = $('#detail-expand');
  if (btn) { btn.innerHTML = '\u2197'; btn.title = 'Expand to full screen'; }
  state.activeId = null;
}

function toggleDetailFullscreen() {
  const panel = $('#detail-panel');
  if (!panel) return;
  const on = !panel.classList.contains('fullscreen');
  panel.classList.toggle('fullscreen', on);
  document.body.classList.toggle('detail-fullscreen', on);
  const btn = $('#detail-expand');
  if (btn) {
    btn.innerHTML = on ? '\u2198' : '\u2197';
    btn.title = on ? 'Exit full screen' : 'Expand to full screen';
  }
}

function renderDetail(data) {
  const c = data.company;
  const signals = data.signals || {};
  const flags = data.flags || { hard_stops: [], yellow_flags: [] };
  const sources = data.sources || [];
  const contacts = data.contacts || [];
  const activities = data.activities || [];
  const loc = [c.city, c.state].filter(Boolean).join(', ');

  $('#d-score').textContent = fmtScore(c.score);
  $('#d-score').className = `detail-score ${tierClass(c.tier)}`;
  $('#d-score-edit').hidden = true;
  $('#d-score').hidden = false;
  const dNameEl = $('#d-name');
  dNameEl.textContent = c.name;
  // Append warm badge if company has recent engagement
  const existingWarm = dNameEl.querySelector('.warm-badge');
  if (existingWarm) existingWarm.remove();
  if (c.warm_until && new Date(c.warm_until) > new Date()) {
    const wb = document.createElement('span');
    wb.className = 'warm-badge';
    wb.title = 'Engaged — opened email or had positive call';
    wb.textContent = '🔥';
    dNameEl.appendChild(wb);
  }
  $('#d-sub').textContent = loc || '—';
  $('#d-tier').textContent = tierLabel(c.tier);
  $('#d-tier').className = `detail-tier ${tierClass(c.tier)}`;
  $('#d-summary').textContent = c.summary || 'No research summary yet.';

  // Outreach Angle
  const oaSection = $('#d-outreach-angle-section');
  const oaBody = $('#d-outreach-angle');
  if (oaSection && oaBody) {
    if (c.outreach_angle) {
      oaSection.hidden = false;
      oaBody.textContent = c.outreach_angle;
    } else {
      oaSection.hidden = true;
    }
  }

  // Call Intelligence summary
  const callIntelSection = $('#d-call-intel-section');
  const callIntelBody = $('#d-call-intel');
  if (callIntelSection && callIntelBody) {
    if (c.call_intelligence) {
      callIntelSection.hidden = false;
      callIntelBody.innerHTML = escapeHtml(c.call_intelligence).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    } else {
      callIntelSection.hidden = true;
    }
  }

  // Pipeline stage selector
  const stageSel = $('#d-pipeline-stage');
  stageSel.innerHTML = state.pipelineStages.map((s) =>
    `<option value="${s.key}">${escapeHtml(s.label)}</option>`
  ).join('');
  stageSel.value = c.pipeline_stage || 'no_contact';
  const reasonSel = $('#d-closed-reason');
  reasonSel.hidden = c.pipeline_stage !== 'closed_lost';
  if (c.closed_lost_reason) reasonSel.value = c.closed_lost_reason;

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
  // Check if any signal has raw or notes data
  const hasDetail = Object.values(signals).some((v) => {
    const s = typeof v === 'object' && v !== null ? v : {};
    return (s.raw && s.raw !== '—') || (s.notes && s.notes !== '—');
  });
  // Update table header to match
  const thead = $('#d-signals thead tr');
  if (thead) thead.innerHTML = hasDetail
    ? '<th>Signal</th><th>Weight</th><th>Raw</th><th>Notes</th><th>Score</th>'
    : '<th>Signal</th><th>Weight</th><th>Score</th>';
  const rows = Object.entries(weights)
    .map(([k, w]) => {
      const v = signals[k];
      const s = typeof v === 'object' && v !== null ? v : { score: v };
      const score = s.score != null ? Number(s.score) : null;
      const scoreColor = score != null
        ? (score >= 7.5 ? 'var(--green, #4FA974)' : score >= 5 ? 'var(--gold)' : 'var(--red, #E74C3C)')
        : '';
      const detailCols = hasDetail
        ? `<td>${escapeHtml(s.raw ?? '—')}</td><td class="signal-notes-cell">${escapeHtml(s.notes ?? '—')}</td>`
        : '';
      return `
        <tr>
          <td>${escapeHtml(k.replace(/_/g, ' '))}</td>
          <td>${Math.round(w * 100)}%</td>
          ${detailCols}
          <td class="num" style="${scoreColor ? 'color:' + scoreColor + ';font-weight:700' : ''}">${score != null ? score.toFixed(1) : '—'}</td>
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

  // Contacts
  renderContacts(contacts);

  // Sources
  $('#d-sources').innerHTML = sources.length
    ? sources.map((s) => {
        // Sources may be { url, title }, { label, url }, or plain strings
        const src = typeof s === 'string' ? { url: s, title: s } : s;
        const url = src.url || '';
        const label = src.title || src.label || (url ? new URL(url, 'https://x').hostname.replace('www.', '') : 'source');
        return url && url !== '#'
          ? `<a class="source-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
          : `<span class="source-chip">${escapeHtml(label)}</span>`;
      }).join('')
    : '<div class="sb-hint">No sources recorded.</div>';

  // Activities
  renderActivities(activities);

  // Notes
  renderNotes(data.notes || []);

  // Key Info
  renderKeyInfo(c.key_info, '#d-keyinfo', '#d-keyinfo-section', c.id);

  // Messages
  loadCompanyMessages(c.id);

  // Call section — reset and populate number picker
  $('#d-call-btn')?.parentElement && ($('#d-call-btn').parentElement.hidden = false);
  $('#d-call-active').hidden = true;
  $('#d-call-processing').hidden = true;
  $('#d-call-mute').hidden = true;
  loadDetailPhoneOptions(c);
  const smsTo = $('#d-sms-to');
  if (smsTo) smsTo.textContent = c.phone ? `To: ${c.phone}` : 'No phone number';

  // Actions
  $('#d-override').textContent = c.crm_override ? 'Crm Override: ON' : 'Research Anyway';
  $('#d-override').hidden = !c.crm_known;
  $('#d-tearsheet').href = `/tearsheet/${c.id}`;

  // Reset contact form
  $('#d-contact-form').hidden = true;
}

function renderNotes(notes) {
  const host = $('#d-notes-list');
  const count = $('#d-notes-count');
  if (!host || !count) return;
  count.textContent = String(notes.length);
  if (!notes.length) {
    host.innerHTML = '<div class="d-notes-empty">No notes yet.</div>';
    return;
  }
  host.innerHTML = notes.map((n) => {
    const ts = n.created_at ? new Date(n.created_at).toLocaleString() : '';
    return `
      <div class="d-note-item">
        <div class="d-note-body">${escapeHtml(n.note || '')}</div>
        ${ts ? `<div class="d-note-meta">${escapeHtml(ts)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function formatStampPrefix() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yr = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const initials = state.user ? userInitials(state.user.name || state.user.email || '?') : '??';
  return `${m}/${day}/${yr} ${h}:${min} ${ampm} ${initials}: `;
}

function insertTimestampIntoNote() {
  const ta = $('#d-notes-input');
  if (!ta) return;
  const prefix = formatStampPrefix();
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(ta.selectionEnd ?? pos);
  // Add a newline before if the cursor isn't at start of line / textarea is non-empty
  const needsNewline = before.length > 0 && !before.endsWith('\n');
  const insert = (needsNewline ? '\n' : '') + prefix;
  ta.value = before + insert + after;
  const newPos = before.length + insert.length;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
}

async function saveCompanyNote() {
  if (!state.activeId) return;
  const ta = $('#d-notes-input');
  if (!ta) return;
  const note = ta.value.trim();
  if (!note) { toast('Write a note first', 'error'); return; }
  try {
    const res = await fetch(`/api/companies/${state.activeId}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (res.ok) {
      ta.value = '';
      toast('Note saved', 'ok');
      openDetail(state.activeId);
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Failed to save note', 'error');
    }
  } catch {
    toast('Failed to save note', 'error');
  }
}

// ---------- upload ----------
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
      rankerBody.innerHTML = '<tr><td colspan="9" class="markets-empty">No market data yet. Click Refresh Data.</td></tr>';
    } else {
      rankerBody.innerHTML = markets
        .sort((a, b) => (Number(b.market_score) || 0) - (Number(a.market_score) || 0))
        .map((m, i) => {
          const ms = Number(m.market_score) || 0;
          const scoreClass = ms >= 7 ? 'score-high' : ms >= 5 ? 'score-mid' : 'score-low';
          return `
            <tr class="${scoreClass}">
              <td class="rank-col">${i + 1}</td>
              <td><strong>${escapeHtml(m.city)}, ${escapeHtml(m.state)}</strong><div class="msa-sub">${escapeHtml(m.msa_name || '')}</div></td>
              <td>${fmtPop(m.population)}</td>
              <td>${m.population_growth != null ? Number(m.population_growth).toFixed(1) + '%' : '—'}</td>
              <td>${m.home_sales_volume ? fmtNum(m.home_sales_volume) : '—'}</td>
              <td>${m.median_home_value ? '$' + fmtNum(m.median_home_value) : '—'}</td>
              <td>${m.housing_permits ? fmtNum(m.housing_permits) : '—'}</td>
              <td>${m.ma_activity_score != null ? renderMiniBar(Number(m.ma_activity_score)) : '—'}</td>
              <td class="score-cell"><span class="market-score-badge ${scoreClass}">${ms.toFixed(1)}</span></td>
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
  // No-op — market widget removed from sidebar
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

// ---------- run controls (legacy — research is done via Claude Code CLI) ----------


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
  // Industry multi-select dropdown
  const indBtn = $('#industry-filter-btn');
  const indDrop = $('#industry-filter-dropdown');
  if (indBtn && indDrop) {
    indBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      indDrop.hidden = !indDrop.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!$('#industry-filter-wrap')?.contains(e.target)) indDrop.hidden = true;
    });
    const selectAllCb = $('#industry-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', () => {
        $$('input[type="checkbox"]', indDrop).forEach(cb => {
          if (cb !== selectAllCb) cb.checked = selectAllCb.checked;
        });
        const checked = $$('input[type="checkbox"]:checked', indDrop).filter(c => c !== selectAllCb).map(c => c.value);
        state.filter.industries = checked;
        indBtn.textContent = selectAllCb.checked ? 'All Industries \u25BE' : 'None \u25BE';
        loadCompanies();
      });
    }
    $$('input[type="checkbox"]', indDrop).forEach((cb) => {
      if (cb === selectAllCb) return;
      cb.addEventListener('change', () => {
        const checked = $$('input[type="checkbox"]:checked', indDrop).filter(c => c !== selectAllCb).map((c) => c.value);
        const total = $$('input[type="checkbox"]', indDrop).length - 1;
        state.filter.industries = checked;
        if (selectAllCb) selectAllCb.checked = checked.length === total;
        indBtn.textContent = checked.length === total || checked.length === 0
          ? 'All Industries \u25BE'
          : checked.length <= 3 ? checked.join(', ') + ' \u25BE' : checked.length + ' selected \u25BE';
        loadCompanies();
      });
    });
  }
  $('#pipeline-filter').addEventListener('change', (e) => {
    state.filter.pipelineStage = e.target.value;
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
      renderPipelineBoard();
    });
  });
}

// ---------- detail actions ----------
function bindDetailActions() {
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-expand')?.addEventListener('click', toggleDetailFullscreen);

  // Pipeline stage change
  $('#d-pipeline-stage').addEventListener('change', async (e) => {
    if (!state.activeId) return;
    const stage = e.target.value;
    const reasonSel = $('#d-closed-reason');
    if (stage === 'closed_lost') {
      reasonSel.hidden = false;
      return; // Wait for reason selection
    }
    reasonSel.hidden = true;
    await changePipelineStage(state.activeId, stage);
  });

  $('#d-closed-reason').addEventListener('change', async (e) => {
    if (!state.activeId) return;
    const reason = e.target.value;
    if (!reason) return;
    await changePipelineStage(state.activeId, 'closed_lost', reason);
  });

  // Activity logging
  $('#d-activity-save').addEventListener('click', async () => {
    if (!state.activeId) return;
    const type = $('#d-activity-type').value;
    const summary = $('#d-activity-summary').value.trim();
    if (!summary) return;
    const res = await fetch(`/api/companies/${state.activeId}/activities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, summary }),
    });
    if (res.ok) {
      $('#d-activity-summary').value = '';
      openDetail(state.activeId);
      toast('Activity logged', 'ok');
    }
  });

  // Contact add form toggle
  $('#d-contact-add-btn').addEventListener('click', () => {
    const form = $('#d-contact-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#cf-name').focus();
  });
  $('#cf-cancel').addEventListener('click', () => {
    $('#d-contact-form').hidden = true;
    clearContactForm();
  });
  $('#cf-save').addEventListener('click', async () => {
    if (!state.activeId) return;
    const name = $('#cf-name').value.trim();
    if (!name) { toast('Name is required', 'error'); return; }
    const body = {
      name,
      title: $('#cf-title').value.trim() || null,
      phone: $('#cf-phone').value.trim() || null,
      email: $('#cf-email').value.trim() || null,
      linkedin: $('#cf-linkedin').value.trim() || null,
    };
    const editId = $('#cf-save').dataset.editId;
    let res;
    if (editId) {
      res = await fetch(`/api/contacts/${editId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch(`/api/companies/${state.activeId}/contacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (res.ok) {
      clearContactForm();
      $('#d-contact-form').hidden = true;
      openDetail(state.activeId);
      toast(editId ? 'Contact updated' : 'Contact added', 'ok');
    }
  });

  // Contacts toggle
  $('#d-contacts-toggle')?.addEventListener('click', () => {
    const body = $('#d-contacts');
    const addRow = $('#d-contact-add-row');
    body.hidden = !body.hidden;
    addRow.hidden = body.hidden;
    $('#d-contacts-toggle .d-section-arrow').textContent = body.hidden ? '\u25B8' : '\u25BE';
  });

  // Notes toggle + stamp + save
  $('#d-notes-toggle')?.addEventListener('click', () => {
    const body = $('#d-notes-body');
    if (!body) return;
    body.hidden = !body.hidden;
    const arrow = $('#d-notes-toggle .d-section-arrow');
    if (arrow) arrow.textContent = body.hidden ? '\u25B8' : '\u25BE';
  });
  $('#d-notes-stamp')?.addEventListener('click', insertTimestampIntoNote);
  $('#d-notes-save')?.addEventListener('click', saveCompanyNote);
  $('#d-messages-toggle')?.addEventListener('click', () => {
    const body = $('#d-messages-body');
    if (!body) return;
    body.hidden = !body.hidden;
    const arrow = $('#d-messages-toggle .d-section-arrow');
    if (arrow) arrow.textContent = body.hidden ? '\u25B8' : '\u25BE';
  });
  $('#d-sms-send')?.addEventListener('click', () => { if (state.activeId) sendCompanySms(state.activeId); });
  $('#qp-sms-send')?.addEventListener('click', sendQueueSms);

  // Override / tearsheet
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

  $('#d-delete-company')?.addEventListener('click', async () => {
    if (!state.activeId) return;
    const row = state.companies.find((c) => c.id === state.activeId);
    const name = row?.name || 'this company';
    if (!confirm(`Are you sure you want to delete "${name}"? It can be restored from the Deleted tab.`)) return;
    try {
      const res = await fetch(`/api/companies/${state.activeId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(`"${name}" moved to Recently Deleted`, 'ok');
        closeDetail();
        await loadCompanies();
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.error || 'Delete failed', 'error');
      }
    } catch { toast('Delete failed', 'error'); }
  });

  // Manual score editing
  $('#d-score')?.addEventListener('click', () => {
    if (!state.activeId) return;
    const c = state.companies.find((x) => x.id === state.activeId);
    $('#d-score-input').value = c?.score != null ? Number(c.score).toFixed(1) : '';
    $('#d-score').hidden = true;
    $('#d-score-edit').hidden = false;
    $('#d-score-input').focus();
  });
  $('#d-score-save')?.addEventListener('click', async () => {
    if (!state.activeId) return;
    const val = parseFloat($('#d-score-input').value);
    if (isNaN(val) || val < 0 || val > 10) { toast('Score must be 0-10', 'error'); return; }
    const tier = val >= 7.5 ? 'strong-buy' : val >= 5 ? 'watchlist' : 'pass';
    try {
      await fetch(`/api/companies/${state.activeId}/score`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ score: val, tier }),
      });
      toast('Score saved', 'ok');
      await loadCompanies();
      openDetail(state.activeId);
    } catch { toast('Failed to save score', 'error'); }
  });
  $('#d-score-cancel')?.addEventListener('click', () => {
    $('#d-score-edit').hidden = true;
    $('#d-score').hidden = false;
  });

  // Detail panel call controls
  $('#d-call-btn')?.addEventListener('click', startDetailCall);
  $('#d-call-end')?.addEventListener('click', endDetailCall);
  $('#d-call-mute')?.addEventListener('click', () => {
    const call = state.detailActiveCall;
    if (!call) return;
    call.mute(!call.isMuted());
    $('#d-call-mute').textContent = call.isMuted() ? 'Unmute' : 'Mute';
  });
}

async function loadDetailPhoneOptions(company) {
  const sel = $('#d-call-number');
  if (!sel) return;
  const numbers = [];
  try {
    const res = await fetch(`/api/companies/${company.id}/contacts`);
    if (res.ok) {
      const { contacts } = await res.json();
      const primaryMatch = (contacts || []).find((c) => c.phone === company.phone);
      if (company.phone) {
        const label = primaryMatch
          ? `${primaryMatch.name}${primaryMatch.title ? ' (' + primaryMatch.title + ')' : ''}: ${company.phone}`
          : 'Office: ' + company.phone;
        numbers.push({ label, value: company.phone });
      }
      (contacts || []).forEach((c) => {
        if (c.phone && c.phone !== company.phone) {
          numbers.push({ label: `${c.name}${c.title ? ' (' + c.title + ')' : ''}: ${c.phone}`, value: c.phone });
        }
      });
    }
  } catch {
    if (company.phone) numbers.push({ label: 'Office: ' + company.phone, value: company.phone });
  }
  if (!numbers.length) {
    sel.innerHTML = '<option value="">No phone numbers available</option>';
    $('#d-call-btn').disabled = true;
    return;
  }
  sel.innerHTML = numbers.map((n) => `<option value="${escapeHtml(n.value)}">${escapeHtml(n.label)}</option>`).join('');
  $('#d-call-btn').disabled = false;
}

async function startDetailCall() {
  if (!state.activeId) return;
  const phone = $('#d-call-number')?.value;
  if (!phone) { toast('Select a number', 'error'); return; }
  $('#d-call-btn').parentElement.hidden = true;
  $('#d-call-active').hidden = false;
  $('#d-call-status').textContent = 'Ringing…';
  try {
    const res = await fetch('/api/twilio/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: state.activeId, to: phone }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Call failed', 'error');
      $('#d-call-btn').parentElement.hidden = false;
      $('#d-call-active').hidden = true;
      return;
    }
    const data = await res.json();
    state.detailCallLogId = data.call_log_id;
    state.detailCallStart = Date.now();
    clearInterval(state.detailCallTimer);
    state.detailCallTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - state.detailCallStart) / 1000);
      $('#d-call-timer').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      if (data.mock && secs > 2) $('#d-call-status').textContent = 'Connected';
    }, 500);

    // Live Twilio
    if (!data.mock && state.twilioDevice) {
      const digits = phone.replace(/\D/g, '');
      const e164 = digits.length === 10 ? '+1' + digits : digits.length === 11 && digits[0] === '1' ? '+' + digits : '+' + digits;
      const call = await state.twilioDevice.connect({ params: { To: e164, callLogId: data.call_log_id } });
      state.detailActiveCall = call;
      call.on('accept', () => { $('#d-call-status').textContent = 'Connected'; $('#d-call-mute').hidden = false; });
      call.on('disconnect', () => onDetailCallEnded());
      call.on('cancel', () => onDetailCallEnded());
      call.on('error', (err) => { toast('Call error: ' + err.message, 'error'); onDetailCallEnded(); });
    }
  } catch (err) {
    toast('Call failed: ' + err.message, 'error');
    $('#d-call-btn').parentElement.hidden = false;
    $('#d-call-active').hidden = true;
  }
}

function onDetailCallEnded() {
  clearInterval(state.detailCallTimer);
  state.detailActiveCall = null;
  $('#d-call-mute').hidden = true;
  $('#d-call-active').hidden = true;
  $('#d-call-processing').hidden = false;
  if (state.detailCallLogId) pollForDebrief(state.detailCallLogId);
}

async function endDetailCall() {
  clearInterval(state.detailCallTimer);
  const durationSec = Math.max(5, Math.floor((Date.now() - state.detailCallStart) / 1000));
  if (state.detailActiveCall) {
    state.detailActiveCall.disconnect();
    return;
  }
  // Mock mode
  $('#d-call-active').hidden = true;
  $('#d-call-processing').hidden = false;
  if (state.twilioStatus?.mock && state.detailCallLogId) {
    try {
      await fetch('/api/twilio/mock-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ call_log_id: state.detailCallLogId, duration_sec: durationSec }),
      });
    } catch {}
  }
  if (state.detailCallLogId) pollForDebrief(state.detailCallLogId);
}

function clearContactForm() {
  $('#cf-name').value = '';
  $('#cf-title').value = '';
  $('#cf-phone').value = '';
  $('#cf-email').value = '';
  $('#cf-linkedin').value = '';
  delete $('#cf-save').dataset.editId;
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — Auth, Call Queue, Debrief, Calendar, Settings, Call History
// ═══════════════════════════════════════════════════════════════════════

// ---------- auth / user bootstrap ----------
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const data = await res.json();
    state.user = data.user || null;
  } catch {}
  applyTabVisibility();
  applyAuthUI();
}

function applyAuthUI() {
  const overlay = $('#login-overlay');
  const profileBtn = $('#profile-btn');
  if (!overlay || !profileBtn) return;
  if (state.user) {
    overlay.hidden = true;
    document.body.classList.remove('logged-out');
    profileBtn.hidden = false;
    const initials = userInitials(state.user.name || state.user.email || '?');
    $('#profile-avatar').textContent = initials;
    $('#profile-name').textContent = state.user.name || state.user.email || 'User';
    $('#profile-role').textContent = ROLE_LABELS[state.user.role] || state.user.role || 'Analyst';
  } else {
    overlay.hidden = false;
    document.body.classList.add('logged-out');
    profileBtn.hidden = true;
  }
}

function userInitials(s) {
  const parts = String(s).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------- Login form ----------
function bindLogin() {
  const form = $('#login-form');
  if (!form) return;
  $('#login-forgot')?.addEventListener('click', () => {
    const err = $('#login-error');
    err.textContent = 'Contact your admin to reset your password.';
    err.hidden = false;
  });
  const tabs = $$('.login-tab');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      const mode = t.dataset.loginMode;
      const nameField = $('#login-name-field');
      const pwField = $('#login-password');
      if (mode === 'signup') {
        nameField.hidden = false;
        if (pwField) pwField.autocomplete = 'new-password';
        $('#login-submit').textContent = 'Create account';
        $('#login-title').textContent = 'Create your account';
        $('#login-sub').textContent = 'New analysts: enter your name, email, and password.';
      } else {
        nameField.hidden = true;
        if (pwField) pwField.autocomplete = 'current-password';
        $('#login-submit').textContent = 'Sign in';
        $('#login-title').textContent = 'Sign in to continue';
        $('#login-sub').textContent = 'Enter your email and password to access the prospector.';
      }
      $('#login-error').hidden = true;
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('.login-tab.active')?.dataset.loginMode || 'signin';
    const email = $('#login-email').value.trim();
    const name = $('#login-name').value.trim();
    const password = $('#login-password')?.value || '';
    const err = $('#login-error');
    err.hidden = true;
    if (!email) {
      err.textContent = 'Email is required.';
      err.hidden = false;
      return;
    }
    if (!password) {
      err.textContent = 'Password is required.';
      err.hidden = false;
      return;
    }
    if (mode === 'signup' && password.length < 6) {
      err.textContent = 'Password must be at least 6 characters.';
      err.hidden = false;
      return;
    }
    const submit = $('#login-submit');
    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
    try {
      let res;
      if (mode === 'signup') {
        if (!name) {
          err.textContent = 'Name is required to create an account.';
          err.hidden = false;
          return;
        }
        res = await fetch('/api/auth/accept', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        });
      } else {
        res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'needs_password') {
          showSetPasswordMode(email);
          return;
        }
        err.textContent = data.message || data.error || 'Sign in failed. Try again.';
        err.hidden = false;
        return;
      }
      state.user = data.user || null;
      applyTabVisibility();
      applyAuthUI();
      $('#login-email').value = '';
      $('#login-name').value = '';
      if ($('#login-password')) $('#login-password').value = '';
      toast(`Welcome, ${state.user?.name || 'friend'} ✓`, 'ok');
      refreshPendingDebriefs();
      loadTwilioStatus();
    } catch (e2) {
      err.textContent = 'Network error. Check your connection.';
      err.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  });
}

// ---------- Set password mode (for existing accounts without password) ----------
function showSetPasswordMode(email) {
  const tabs = $$('.login-tab');
  tabs.forEach(t => t.style.display = 'none');
  $('#login-name-field').hidden = true;
  $('#login-email').value = email;
  $('#login-email').readOnly = true;
  $('#login-password').value = '';
  $('#login-password').autocomplete = 'new-password';
  $('#login-password').focus();
  $('#login-title').textContent = 'Set your password';
  $('#login-sub').textContent = 'Your account exists but needs a password. Choose one now.';
  $('#login-submit').textContent = 'Set password & sign in';
  $('#login-error').hidden = true;

  const form = $('#login-form');
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);
  const btn = newForm.querySelector('#login-submit');
  btn.disabled = false;
  btn.textContent = 'Set password & sign in';

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = newForm.querySelector('#login-password').value;
    const err = newForm.querySelector('#login-error');
    err.hidden = true;
    if (!pw || pw.length < 6) {
      err.textContent = 'Password must be at least 6 characters.';
      err.hidden = false;
      return;
    }
    const btn = newForm.querySelector('#login-submit');
    btn.disabled = true;
    btn.textContent = 'Setting password…';
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: pw }),
      });
      const data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || 'Failed to set password.';
        err.hidden = false;
        return;
      }
      state.user = data.user || null;
      applyTabVisibility();
      applyAuthUI();
      toast(`Welcome back, ${state.user?.name || 'friend'} — password set! ✓`, 'ok');
      refreshPendingDebriefs();
      loadTwilioStatus();
      // restore form to normal state
      resetLoginForm();
    } catch {
      err.textContent = 'Network error. Check your connection.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Set password & sign in';
    }
  });
}

function resetLoginForm() {
  const tabs = $$('.login-tab');
  tabs.forEach(t => t.style.display = '');
  $('#login-email').readOnly = false;
  $('#login-email').value = '';
  if ($('#login-password')) $('#login-password').value = '';
  $('#login-name').value = '';
  // re-bind the normal login form
  bindLogin();
}

// ---------- Profile modal ----------
function bindProfile() {
  $('#profile-btn')?.addEventListener('click', openProfileModal);
  $$('[data-close-profile]').forEach((el) => el.addEventListener('click', closeProfileModal));
  $$('.profile-stats-tab').forEach((t) => {
    t.addEventListener('click', () => {
      $$('.profile-stats-tab').forEach((x) => x.classList.toggle('active', x === t));
      loadProfileStats(t.dataset.statsRange || 'today');
    });
  });
  $('#profile-signout')?.addEventListener('click', handleSignOut);
  $('#profile-twilio-save')?.addEventListener('click', async () => {
    const num = $('#profile-twilio-number')?.value?.trim() || null;
    try {
      const res = await fetch('/api/me/twilio-number', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ twilio_phone_number: num }),
      });
      if (res.ok) {
        state.user.twilio_phone_number = num;
        toast('Twilio number saved', 'ok');
      } else {
        toast('Failed to save', 'error');
      }
    } catch { toast('Network error', 'error'); }
  });
  $('#profile-email-save')?.addEventListener('click', async () => {
    const smtp_from_email = $('#profile-smtp-from')?.value?.trim() || null;
    const smtp_pass = $('#profile-smtp-pass')?.value || null;
    if (!smtp_from_email) { toast('Email is required', 'error'); return; }
    if (!smtp_pass) { toast('Password is required', 'error'); return; }
    try {
      const res = await fetch('/api/me/email-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          smtp_host: 'smtp.office365.com',
          smtp_port: 587,
          smtp_user: smtp_from_email,
          smtp_pass,
          smtp_from_email,
        }),
      });
      if (res.ok) {
        state.user.smtp_from_email = smtp_from_email;
        toast('Email settings saved', 'ok');
      } else {
        const d = await res.json().catch(() => ({}));
        toast(d.error || 'Failed to save', 'error');
      }
    } catch { toast('Network error', 'error'); }
  });
  $('#profile-email-test')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/me/email-test', { method: 'POST' });
      const d = await res.json();
      if (res.ok) {
        toast(d.message || 'Test email sent!', 'ok');
      } else {
        toast(d.error || 'Test failed', 'error');
      }
    } catch { toast('Network error', 'error'); }
  });
  $('#profile-sig-save')?.addEventListener('click', async () => {
    const sig = $('#profile-email-sig')?.value || '';
    try {
      const res = await fetch('/api/me/email-signature', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email_signature: sig }),
      });
      if (res.ok) {
        state.user.email_signature = sig;
        toast('Signature saved', 'ok');
      } else { toast('Failed to save', 'error'); }
    } catch { toast('Network error', 'error'); }
  });
}

function openProfileModal() {
  if (!state.user) return;
  const modal = $('#profile-modal');
  if (!modal) return;
  $('#profile-modal-avatar').textContent = userInitials(state.user.name || state.user.email || '?');
  $('#profile-modal-name').textContent = state.user.name || '—';
  $('#profile-modal-email').textContent = state.user.email || '—';
  $('#profile-modal-role').textContent = ROLE_LABELS[state.user.role] || state.user.role || 'Analyst';

  const verticals = state.user.assigned_verticals || [];
  const territories = state.user.assigned_territories || [];
  const vEl = $('#profile-verticals');
  const tEl = $('#profile-territories');
  vEl.innerHTML = verticals.length === 0
    ? '<span class="profile-row-value" style="color:#999">None assigned</span>'
    : verticals.map((v) => `<span class="profile-tag">${escapeHtml(v)}</span>`).join('');
  tEl.innerHTML = territories.length === 0
    ? '<span class="profile-row-value" style="color:#999">None assigned</span>'
    : territories.map((t) => `<span class="profile-tag">${escapeHtml(String(t).toUpperCase())}</span>`).join('');

  const twilioEl = $('#profile-twilio-number');
  if (twilioEl) twilioEl.value = state.user.twilio_phone_number || '';

  // Email settings
  const smtpFrom = $('#profile-smtp-from');
  const smtpPass = $('#profile-smtp-pass');
  if (smtpFrom) smtpFrom.value = state.user.smtp_from_email || '';
  if (smtpPass) smtpPass.value = '';  // Never prefill password
  const sigEl = $('#profile-email-sig');
  if (sigEl) sigEl.value = state.user.email_signature || '';

  $$('.profile-stats-tab').forEach((x, i) => x.classList.toggle('active', i === 0));
  modal.hidden = false;
  loadProfileStats('today');
}

function closeProfileModal() {
  const modal = $('#profile-modal');
  if (modal) modal.hidden = true;
}

async function loadProfileStats(range) {
  const grid = $('#profile-stats-grid');
  if (!grid) return;
  try {
    const res = await fetch(`/api/me/stats?range=${encodeURIComponent(range)}`);
    if (!res.ok) return;
    const { stats } = await res.json();
    $('#stat-outbound').textContent = stats.outbound_calls ?? 0;
    $('#stat-inbound').textContent = stats.inbound_calls ?? 0;
    $('#stat-talk').textContent = formatTalkTime(stats.total_talk_sec || 0);
    $('#stat-texts').textContent = stats.texts_sent ?? 0;
    $('#stat-emails').textContent = stats.emails_sent ?? 0;
    $('#stat-meetings').textContent = stats.meetings_booked ?? 0;
  } catch {}
}

function formatTalkTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

async function handleSignOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  state.user = null;
  closeProfileModal();
  applyTabVisibility();
  applyAuthUI();
  toast('Signed out', 'info');
}

async function loadTwilioStatus() {
  try {
    const res = await fetch('/api/twilio/status');
    if (!res.ok) return;
    state.twilioStatus = await res.json();
    const badge = $('#queue-mock-badge');
    if (badge) badge.hidden = !state.twilioStatus.mock;
    // Initialize Twilio Voice Device for live mode
    if (!state.twilioStatus.mock && typeof Twilio !== 'undefined') {
      initTwilioDevice();
    }
  } catch {}
}

async function initTwilioDevice() {
  if (state.twilioDevice) return; // already initialized
  try {
    const res = await fetch('/api/twilio/token', { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.mock || !data.token) return;
    const device = new Twilio.Device(data.token, {
      codecPreferences: ['opus', 'pcmu'],
      closeProtection: true,
    });
    device.on('registered', () => console.log('[twilio] Device registered'));
    device.on('error', (err) => {
      console.error('[twilio] Device error:', err.message);
      toast('Phone connection error: ' + err.message, 'error');
    });
    device.on('tokenWillExpire', async () => {
      try {
        const r = await fetch('/api/twilio/token', { method: 'POST' });
        if (r.ok) {
          const d = await r.json();
          if (d.token) device.updateToken(d.token);
        }
      } catch {}
    });
    device.on('incoming', handleIncomingCall);
    device.register();
    state.twilioDevice = device;
  } catch (err) {
    console.error('[twilio] Device init failed:', err.message);
  }
}

// Ringtone using Web Audio API
let _ringtoneInterval = null;
function startRingtone() {
  stopRingtone();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  function ring() {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.frequency.value = 440;
    osc2.frequency.value = 480;
    gain.gain.value = 0.15;
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 1);
    osc2.stop(ctx.currentTime + 1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1);
  }
  ring();
  _ringtoneInterval = setInterval(ring, 3000);
  state._ringtoneCtx = ctx;
}
function stopRingtone() {
  if (_ringtoneInterval) { clearInterval(_ringtoneInterval); _ringtoneInterval = null; }
  if (state._ringtoneCtx) { state._ringtoneCtx.close().catch(() => {}); state._ringtoneCtx = null; }
}

async function handleIncomingCall(call) {
  // Validate this is a real incoming call with accept/reject methods
  if (!call || typeof call.accept !== 'function' || typeof call.reject !== 'function') {
    console.warn('[twilio] Ignoring invalid incoming call event:', call);
    return;
  }
  state.incomingCall = call;
  const from = call.parameters?.From || call.parameters?.from || '';
  if (!from || from === 'client:anonymous') {
    console.warn('[twilio] Ignoring incoming call with no caller ID');
    call.reject();
    return;
  }
  const popup = $('#incoming-call');
  const fromEl = $('#incoming-call-from');
  const detailEl = $('#incoming-call-detail');
  fromEl.textContent = from;
  detailEl.textContent = 'Looking up caller...';
  popup.style.display = 'flex';
  startRingtone();

  // Look up caller in DB
  try {
    const res = await fetch(`/api/twilio/caller-lookup?from=${encodeURIComponent(from)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.contact) {
        fromEl.textContent = data.contact.name || from;
        detailEl.textContent = `${data.contact.title || ''} — ${data.contact.company_name || ''}${data.contact.company_city ? `, ${data.contact.company_city}` : ''}`.replace(/^ — /, '');
      } else if (data.company) {
        fromEl.textContent = data.company.owner || data.company.name || from;
        detailEl.textContent = `${data.company.name}${data.company.city ? `, ${data.company.city}` : ''}${data.company.state ? ` ${data.company.state}` : ''}`;
      } else {
        detailEl.textContent = from;
      }
    }
  } catch {}

  // Auto-hide if caller hangs up before answering
  call.on('cancel', () => {
    stopRingtone();
    popup.hidden = true;
    state.incomingCall = null;
    toast('Missed call from ' + fromEl.textContent, 'error');
  });
  call.on('disconnect', () => {
    stopRingtone();
    popup.hidden = true;
    state.incomingCall = null;
  });
}

function acceptIncomingCall() {
  stopRingtone();
  const callerName = $('#incoming-call-from')?.textContent || 'Unknown';
  if (state.incomingCall) {
    try {
      state.incomingCall.accept();
      showActiveCallBar(callerName, state.incomingCall);
    } catch (e) { console.error('[twilio] accept error:', e); }
  }
  $('#incoming-call').style.display = 'none';
}

// ---------- Active call floating bar ----------
let _callTimer = null;
let _callSeconds = 0;

function showActiveCallBar(name, call) {
  _callSeconds = 0;
  $('#active-call-name').textContent = name;
  $('#active-call-timer').textContent = '0:00';
  $('#active-call-status').textContent = 'On Call';
  $('#active-call-bar').style.display = 'flex';
  state.activeCall = call;
  _callTimer = setInterval(() => {
    _callSeconds++;
    const m = Math.floor(_callSeconds / 60);
    const s = String(_callSeconds % 60).padStart(2, '0');
    $('#active-call-timer').textContent = `${m}:${s}`;
  }, 1000);
  if (call) {
    call.on('disconnect', hideActiveCallBar);
    call.on('cancel', hideActiveCallBar);
  }
}

function hideActiveCallBar() {
  if (_callTimer) { clearInterval(_callTimer); _callTimer = null; }
  $('#active-call-bar').style.display = 'none';
  state.activeCall = null;
}

function hangupActiveCall() {
  if (state.activeCall) {
    try { state.activeCall.disconnect(); } catch {}
  }
  hideActiveCallBar();
}

function declineIncomingCall() {
  stopRingtone();
  if (state.incomingCall) {
    try { state.incomingCall.reject(); } catch (e) { console.error('[twilio] reject error:', e); }
  }
  $('#incoming-call').style.display = 'none';
  state.incomingCall = null;
}

function dismissIncomingCall() {
  stopRingtone();
  if (state.incomingCall) {
    try { state.incomingCall.reject(); } catch {}
  }
  $('#incoming-call').style.display = 'none';
  state.incomingCall = null;
}

// ---------- Pending debrief banner ----------
async function refreshPendingDebriefs() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/calls/pending-debrief');
    if (!res.ok) return;
    const { calls } = await res.json();
    state.pendingDebriefs = calls || [];
    const banner = $('#debrief-banner');
    if (!banner) return;
    if (state.pendingDebriefs.length === 0) {
      banner.hidden = true;
    } else {
      const textEl = $('#debrief-banner-text');
      if (state.pendingDebriefs.length === 1) {
        const c = state.pendingDebriefs[0];
        textEl.textContent = `Pending debrief: ${c.company_name || 'Unknown company'}`;
      } else {
        // Show each pending debrief as a clickable link
        textEl.innerHTML = `${state.pendingDebriefs.length} pending debriefs: ` +
          state.pendingDebriefs.map((c) =>
            `<button type="button" class="debrief-banner-pick" data-call-id="${c.id}">${escapeHtml(c.company_name || 'Unknown')}</button>`
          ).join(' ');
        $$('.debrief-banner-pick', textEl).forEach((btn) => {
          btn.addEventListener('click', () => openDebriefModal(btn.dataset.callId));
        });
      }
      banner.hidden = false;
    }
  } catch {}
}

function resumeOldestDebrief() {
  const pending = state.pendingDebriefs || [];
  if (!pending.length) return;
  if (pending.length === 1) {
    openDebriefModal(pending[0].id);
  } else {
    // Open the oldest (last in ASC list = first chronologically)
    openDebriefModal(pending[0].id);
  }
}

async function dismissOldestDebrief() {
  const pending = state.pendingDebriefs || [];
  if (!pending.length) return;
  const oldest = pending[pending.length - 1];
  const n = pending.length;
  const msg = n === 1
    ? 'Dismiss this pending debrief without filling it out? (Use for stale or no-answer calls.)'
    : `Dismiss all ${n} pending debriefs without filling them out? (Use for stale or no-answer calls.)`;
  if (!confirm(msg)) return;
  try {
    for (const d of pending) {
      await fetch(`/api/calls/${d.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'manually dismissed' }),
      });
    }
    toast(n === 1 ? 'Debrief dismissed' : `${n} debriefs dismissed`, 'ok');
    await refreshPendingDebriefs();
    await loadQueue();
  } catch {
    toast('Failed to dismiss debrief', 'error');
  }
}

// ---------- Call Queue ----------
async function loadQueue() {
  const list = $('#queue-list');
  if (!list) return;
  list.innerHTML = '<div class="queue-empty">Loading queue…</div>';
  try {
    const pins = state.queuePins.join(',');
    const qs = pins ? `?pins=${encodeURIComponent(pins)}` : '';
    const res = await fetch(`/api/queue${qs}`);
    if (!res.ok) {
      list.innerHTML = '<div class="queue-empty">Unable to load queue. Are you signed in?</div>';
      return;
    }
    const data = await res.json();
    state.queue = data.queue || [];
    const countEl = $('#queue-today-count');
    if (countEl) countEl.textContent = `${data.calls_today || 0} call${(data.calls_today || 0) === 1 ? '' : 's'} today`;
    renderQueue(data);
    loadQueueMandateFilter();
    loadCallTargets();
    setTimeout(renderQueueWithMandateFilter, 100);
  } catch (err) {
    list.innerHTML = `<div class="queue-empty">Error loading queue: ${escapeHtml(err.message)}</div>`;
  }
}

function renderQueue(data) {
  const list = $('#queue-list');
  if (!list) return;
  const rows = getFilteredQueue();
  if (!rows.length) {
    if (data.empty_reason === 'no_assignments') {
      list.innerHTML = `
        <div class="queue-empty">
          <div style="font-weight:600;margin-bottom:6px;">No territories assigned yet.</div>
          <div>Ask your admin to assign industries/territories in Settings.</div>
        </div>`;
    } else {
      list.innerHTML = `<div class="queue-empty">You're all caught up. Come back tomorrow — or adjust cooldown in Settings.</div>`;
    }
    return;
  }
  list.innerHTML = rows
    .map((r) => {
      const selected = state.queueActiveId === r.id ? 'selected' : '';
      const meta = [r.city && r.state ? `${r.city}, ${r.state}` : r.state, r.phone || 'no phone', r.owner || '—']
        .filter(Boolean)
        .join(' · ');
      const score = r.score != null ? Number(r.score).toFixed(1) : '—';
      return `
        <div class="queue-row ${selected}" data-id="${escapeHtml(r.id)}" data-company-id="${escapeHtml(r.id)}">
          <div class="queue-rank">${r.rank}</div>
          <div class="queue-row-score">${score}</div>
          <div class="queue-row-main">
            <div class="queue-row-name">${escapeHtml(r.name)}${r.warm_until && new Date(r.warm_until) > new Date() ? '<span class="warm-badge" title="Engaged — opened email or had positive call">🔥</span>' : ''}</div>
            <div class="queue-row-meta">${escapeHtml(meta)}</div>
            <div class="queue-row-reason">${escapeHtml(r.reason || '')}</div>
          </div>
          <div class="queue-row-actions">
            <button type="button" class="queue-skip-btn" data-skip="${escapeHtml(r.id)}">Skip</button>
            <button type="button" class="queue-done-btn" data-done="${escapeHtml(r.id)}">Done</button>
          </div>
        </div>`;
    })
    .join('');
  // Bind clicks
  $$('.queue-row', list).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.matches('.queue-skip-btn') || e.target.matches('.queue-done-btn')) return;
      selectQueueRow(el.dataset.id);
    });
  });
  $$('.queue-skip-btn', list).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skip;
      await fetch('/api/queue/skip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: id }),
      });
      toast('Skipped for today', 'info');
      if (state.queueActiveId === id) state.queueActiveId = null;
      await loadQueue();
    });
  });
  $$('.queue-done-btn', list).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.done;
      await fetch('/api/queue/skip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: id }),
      });
      toast('Marked done for today', 'ok');
      if (state.queueActiveId === id) state.queueActiveId = null;
      await loadQueue();
    });
  });
}

function selectQueueRow(id) {
  state.queueActiveId = id;
  const row = state.queue.find((r) => r.id === id);
  if (!row) return;
  $$('.queue-row', $('#queue-list')).forEach((el) =>
    el.classList.toggle('selected', el.dataset.id === id)
  );
  $('#queue-panel-empty').hidden = true;
  $('#queue-panel-active').hidden = false;
  $('#qp-score').textContent = row.score != null ? Number(row.score).toFixed(1) : '—';
  $('#qp-name').textContent = row.name;
  $('#qp-sub').textContent = [row.city, row.state].filter(Boolean).join(', ') || '—';
  const tierEl = $('#qp-tier');
  tierEl.textContent = tierLabel(row.tier) || '—';
  tierEl.className = 'qp-tier ' + (row.tier || '');
  const phoneLabel = row.phone
    ? row.phone + (row.phone_type === 'direct_cell' ? ' (Direct)' : ' (Office)')
    : 'Missing — add in research';
  $('#qp-phone').textContent = phoneLabel;
  $('#qp-owner').textContent = row.owner || '—';

  // Est. Revenue — priority: key_info from calls > signal data > summary text
  const revenueRow = $('#qp-revenue-row');
  if (revenueRow) {
    const company = state.companies.find((c) => c.id === id);
    const keyInfo = company?.key_info ? (typeof company.key_info === 'object' ? company.key_info : safeParse(company.key_info)) : null;
    // 1. Key info from calls (owner-stated revenue is most accurate)
    let revText = keyInfo?.revenue || null;
    // 2. Structured signal data from research
    if (!revText) {
      const sigs = company?.signals_json ? safeParse(company.signals_json) : null;
      const revSig = sigs?.revenue_proxy;
      revText = typeof revSig === 'object' ? (revSig?.raw || revSig?.rationale || revSig?.notes) : null;
    }
    // 3. Extract from summary or outreach angle text
    if (!revText && company) {
      const haystack = (company.summary || '') + ' ' + (company.outreach_angle || '');
      const m = haystack.match(/\$[\d,.]+[MBK]?\s*(?:-\s*\$?[\d,.]+[MBK]?)?\s*(?:in\s+)?(?:revenue|rev\b|annual|run[- ]?rate)/i)
             || haystack.match(/(?:revenue|rev\b|annual|run[- ]?rate)\s*(?:of\s+)?~?\$[\d,.]+[MBK]?\s*(?:-\s*\$?[\d,.]+[MBK]?)?/i)
             || haystack.match(/~?\$[\d,.]+[MBK]?\s*(?:-\s*\$?[\d,.]+[MBK]?)?\s*revenue/i)
             || haystack.match(/(?:estimated|implied|~)\s*\$[\d,.]+[MBK]?\s*(?:-\s*\$?[\d,.]+[MBK]?)?/i)
             || haystack.match(/~?[\d,.]+[MBK]\s+revenue/i);
      if (m) revText = m[0].trim();
    }
    if (revText) {
      revenueRow.hidden = false;
      $('#qp-revenue').textContent = revText + (keyInfo?.revenue ? ' (owner-stated)' : '');
    } else {
      revenueRow.hidden = true;
    }
  }

  // Key Info
  const qpCompany = state.companies.find((c) => c.id === id);
  renderKeyInfo(qpCompany?.key_info, '#qp-keyinfo', '#qp-keyinfo-section', id);

  // Call Intelligence in queue
  const qpCallIntelSection = $('#qp-call-intel-section');
  const qpCallIntelBody = $('#qp-call-intel');
  if (qpCallIntelSection && qpCallIntelBody) {
    if (qpCompany?.call_intelligence) {
      qpCallIntelSection.hidden = false;
      qpCallIntelBody.innerHTML = escapeHtml(qpCompany.call_intelligence).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    } else {
      qpCallIntelSection.hidden = true;
    }
  }

  // Load contacts for this company
  loadQueueContacts(id);

  // Load message history
  loadQueueMessages(id);

  // Scheduled task / calendar event (pinned to top of queue for today)
  const eventSec = $('#qp-event-section');
  if (eventSec) {
    if (row.event) {
      eventSec.hidden = false;
      const when = new Date(row.event.starts_at);
      const whenStr = when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const title = row.event.title || 'Scheduled task';
      const desc = row.event.description || '';
      $('#qp-event').innerHTML = `
        <div style="font-weight:600; color: var(--gold); margin-bottom:2px;">${escapeHtml(whenStr)} — ${escapeHtml(title)}</div>
        ${desc ? `<div style="color: rgba(13,27,42,0.75); white-space: pre-wrap;">${escapeHtml(desc)}</div>` : ''}
      `;
    } else {
      eventSec.hidden = true;
    }
  }

  // Outreach Angle — prefer call-refined over research-based
  const angleSec = $('#qp-angle-section');
  loadLatestOutreachAngle(id, row.outreach_angle).then((angle) => {
    if (angle) {
      angleSec.hidden = false;
      $('#qp-angle').textContent = angle;
    } else {
      angleSec.hidden = true;
    }
  });

  const lastSec = $('#qp-last-section');
  if (row.last_call) {
    lastSec.hidden = false;
    const when = row.last_call.called_at
      ? new Date(row.last_call.called_at).toLocaleDateString()
      : '—';
    $('#qp-last').innerHTML = `
      ${escapeHtml(when)} — <span class="sentiment-badge sentiment-${(row.last_call.sentiment || 'Neutral').replace(/\s+/g, '-')}">${escapeHtml(row.last_call.sentiment || 'Neutral')}</span>
    `;
  } else {
    lastSec.hidden = true;
  }

  // Reset call UI state
  $('#qp-call-btn').hidden = false;
  // Populate number picker from contacts + company phone
  const numberPicker = $('#qp-call-number');
  loadQueuePhoneOptions(id, row.phone).then((hasMultiple) => {
    numberPicker.hidden = !hasMultiple;
    $('#qp-call-btn').disabled = !row.phone && !hasMultiple;
  });
  $('#qp-call-active').hidden = true;
  $('#qp-processing').hidden = true;

  // Load notes for this company
  loadQueueNotes(id);
}

// ---------- Key Info renderer ----------
const KEY_INFO_LABELS = {
  revenue: 'Revenue', net_income: 'Net Income', ebitda: 'EBITDA',
  employees: 'Employees', trucks: 'Trucks', locations: 'Locations',
  years_in_business: 'Years in Business', service_type: 'Service Type',
  services_offered: 'Services', software_tools: 'Software/Tools',
  owner_age: 'Owner Age', spouse_name: 'Spouse', family_involved: 'Family',
  other: 'Other',
};

function renderKeyInfo(keyInfo, hostSel, sectionSel, companyId) {
  const host = $(hostSel);
  const section = $(sectionSel);
  if (!host || !section) return;
  const info = (keyInfo && typeof keyInfo === 'object') ? keyInfo : safeParse(keyInfo);
  if (!info || !Object.keys(info).length) { section.hidden = true; return; }
  const entries = Object.entries(info).filter(([k, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;
  host.innerHTML = entries.map(([k, v]) => {
    const label = KEY_INFO_LABELS[k] || k.replace(/_/g, ' ');
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    return `<div class="keyinfo-row"><span class="keyinfo-label">${escapeHtml(label)}</span><span class="keyinfo-value keyinfo-editable" data-key="${escapeHtml(k)}" title="Click to edit">${escapeHtml(val)}</span></div>`;
  }).join('');
  if (companyId) {
    $$('.keyinfo-editable', host).forEach(el => {
      el.addEventListener('click', () => {
        if (el.querySelector('input')) return;
        const currentVal = el.textContent;
        const key = el.dataset.key;
        el.innerHTML = `<input type="text" class="cf-input keyinfo-edit-input" value="${escapeHtml(currentVal)}" />`;
        const input = el.querySelector('input');
        input.focus();
        input.select();
        const save = async () => {
          const newVal = input.value.trim();
          el.textContent = newVal || currentVal;
          if (newVal !== currentVal) {
            const updated = { ...(info || {}) };
            updated[key] = newVal;
            try {
              await fetch(`/api/companies/${companyId}/key-info`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key_info: updated }),
              });
            } catch {}
          }
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      });
    });
  }
}

// ---------- Queue outreach angle (prefer call-refined) ----------
async function loadLatestOutreachAngle(companyId, fallback) {
  try {
    const res = await fetch(`/api/companies/${companyId}/calls`);
    if (!res.ok) return fallback;
    const { calls } = await res.json();
    // Find most recent call with a refined angle
    const withAngle = (calls || []).find((c) => c.outreach_angle_refined);
    return withAngle?.outreach_angle_refined || fallback;
  } catch { return fallback; }
}

// ---------- Queue phone number picker ----------
async function loadQueuePhoneOptions(companyId, companyPhone) {
  const sel = $('#qp-call-number');
  if (!sel) return false;
  const numbers = [];
  try {
    const res = await fetch(`/api/companies/${companyId}/contacts`);
    if (res.ok) {
      const { contacts } = await res.json();
      // Add company phone with primary contact name if available
      const primaryMatch = (contacts || []).find((c) => c.phone === companyPhone);
      if (companyPhone) {
        const label = primaryMatch
          ? `${primaryMatch.name}${primaryMatch.title ? ' (' + primaryMatch.title + ')' : ''}: ${companyPhone}`
          : 'Office: ' + companyPhone;
        numbers.push({ label, value: companyPhone });
      }
      (contacts || []).forEach((c) => {
        if (c.phone && c.phone !== companyPhone) {
          numbers.push({ label: `${c.name}${c.title ? ' (' + c.title + ')' : ''}: ${c.phone}`, value: c.phone });
        }
      });
    }
  } catch {
    // If contacts fetch failed, still add the company phone
    if (companyPhone && !numbers.length) numbers.push({ label: 'Office: ' + companyPhone, value: companyPhone });
  }
  if (numbers.length <= 1) {
    sel.innerHTML = '';
    return false;
  }
  sel.innerHTML = numbers.map((n) => `<option value="${escapeHtml(n.value)}">${escapeHtml(n.label)}</option>`).join('');
  return true;
}

// ---------- SMS messaging ----------
async function loadCompanyMessages(companyId) {
  const thread = $('#d-messages-thread');
  const count = $('#d-messages-count');
  if (!thread) return;
  try {
    const res = await fetch(`/api/companies/${companyId}/messages`);
    if (!res.ok) { thread.innerHTML = ''; if (count) count.textContent = '0'; return; }
    const { messages } = await res.json();
    if (count) count.textContent = String(messages.length);
    if (!messages.length) {
      thread.innerHTML = '<div class="d-notes-empty">No messages yet.</div>';
      return;
    }
    thread.innerHTML = messages.reverse().map((m) => {
      const isOut = m.direction === 'outbound';
      const time = m.created_at ? new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `
      <div class="sms-bubble ${isOut ? 'sms-out' : 'sms-in'}">
        <div class="sms-body">${escapeHtml(m.body)}</div>
        <div class="sms-meta">${isOut ? (m.user_name || 'You') : m.from_number} · ${time}</div>
      </div>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
  } catch { thread.innerHTML = ''; }
}

async function sendCompanySms(companyId) {
  const ta = $('#d-sms-input');
  if (!ta) return;
  const body = ta.value.trim();
  if (!body) { toast('Type a message', 'error'); return; }
  const company = state.companies.find((c) => c.id === companyId);
  const phone = company?.phone;
  if (!phone) { toast('No phone number for this company', 'error'); return; }
  try {
    const res = await fetch('/api/sms/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, to: phone, body }),
    });
    if (res.ok) {
      ta.value = '';
      toast('Message sent', 'ok');
      loadCompanyMessages(companyId);
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Send failed', 'error');
    }
  } catch { toast('Send failed', 'error'); }
}

async function loadQueueMessages(companyId) {
  const thread = $('#qp-messages-thread');
  const count = $('#qp-messages-count');
  if (!thread) return;
  try {
    const res = await fetch(`/api/companies/${companyId}/messages`);
    if (!res.ok) { thread.innerHTML = ''; if (count) count.textContent = '0'; return; }
    const { messages } = await res.json();
    if (count) count.textContent = String(messages.length);
    if (!messages.length) {
      thread.innerHTML = '<div class="d-notes-empty">No messages yet.</div>';
      return;
    }
    thread.innerHTML = messages.reverse().map((m) => {
      const isOut = m.direction === 'outbound';
      const time = m.created_at ? new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `
      <div class="sms-bubble ${isOut ? 'sms-out' : 'sms-in'}">
        <div class="sms-body">${escapeHtml(m.body)}</div>
        <div class="sms-meta">${isOut ? (m.user_name || 'You') : m.from_number} · ${time}</div>
      </div>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
  } catch { thread.innerHTML = ''; }
}

async function sendQueueSms() {
  const companyId = state.queueActiveId;
  if (!companyId) return;
  const ta = $('#qp-sms-input');
  if (!ta) return;
  const body = ta.value.trim();
  if (!body) { toast('Type a message', 'error'); return; }
  const row = state.queue.find((r) => r.id === companyId);
  const phone = row?.phone;
  if (!phone) { toast('No phone number', 'error'); return; }
  try {
    const res = await fetch('/api/sms/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, to: phone, body }),
    });
    if (res.ok) {
      ta.value = '';
      toast('Message sent', 'ok');
      loadQueueMessages(companyId);
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Send failed', 'error');
    }
  } catch { toast('Send failed', 'error'); }
}

// ---------- Queue panel — contacts ----------
async function loadQueueContacts(companyId) {
  const section = $('#qp-contacts-section');
  const host = $('#qp-contacts-list');
  if (!section || !host) return;
  try {
    const res = await fetch(`/api/companies/${companyId}/contacts`);
    if (!res.ok) { section.hidden = true; return; }
    const { contacts } = await res.json();
    if (!contacts || !contacts.length) { section.hidden = true; return; }
    section.hidden = false;
    host.innerHTML = contacts.map((c) => {
      const primary = c.is_primary ? '<span style="color:var(--gold);font-weight:600"> (Primary)</span>' : '';
      const parts = [c.phone, c.email].filter(Boolean).map(escapeHtml);
      return `<div class="qp-contact-row">
        <div class="qp-contact-name">${escapeHtml(c.name)}${c.title ? ' — ' + escapeHtml(c.title) : ''}${primary}</div>
        ${parts.length ? `<div class="qp-contact-info">${parts.join(' · ')}</div>` : ''}
      </div>`;
    }).join('');
  } catch { section.hidden = true; }
}

// ---------- Queue panel — inline notes ----------
async function loadQueueNotes(companyId) {
  const host = $('#qp-notes-list');
  const count = $('#qp-notes-count');
  const ta = $('#qp-notes-input');
  if (ta) ta.value = '';
  if (!host) return;
  try {
    const res = await fetch(`/api/companies/${companyId}/notes`);
    if (!res.ok) { host.innerHTML = ''; if (count) count.textContent = '0'; return; }
    const { notes } = await res.json();
    if (count) count.textContent = String(notes.length);
    if (!notes.length) {
      host.innerHTML = '<div class="d-notes-empty">No notes yet.</div>';
      return;
    }
    host.innerHTML = notes.map((n) => {
      const ts = n.created_at ? new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `
      <div class="d-note-item">
        <div class="d-note-body">${escapeHtml(n.note || '')}</div>
        ${ts ? `<div class="d-note-meta">${escapeHtml(ts)}</div>` : ''}
      </div>`;
    }).join('');
  } catch {
    host.innerHTML = '';
  }
}

function insertQueueNoteTimestamp() {
  const ta = $('#qp-notes-input');
  if (!ta) return;
  const prefix = formatStampPrefix();
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(ta.selectionEnd ?? pos);
  const needsNewline = before.length > 0 && !before.endsWith('\n');
  const insert = (needsNewline ? '\n' : '') + prefix;
  ta.value = before + insert + after;
  const newPos = before.length + insert.length;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
}

async function saveQueueNote() {
  const companyId = state.queueActiveId;
  if (!companyId) return;
  const ta = $('#qp-notes-input');
  if (!ta) return;
  const note = ta.value.trim();
  if (!note) { toast('Write a note first', 'error'); return; }
  try {
    const res = await fetch(`/api/companies/${companyId}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (res.ok) {
      ta.value = '';
      toast('Note saved', 'ok');
      loadQueueNotes(companyId);
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Failed to save note', 'error');
    }
  } catch {
    toast('Failed to save note', 'error');
  }
}

async function startQueueCall() {
  const row = state.queue.find((r) => r.id === state.queueActiveId);
  if (!row) return;
  $('#qp-call-btn').hidden = true;
  $('#qp-call-active').hidden = false;
  $('#qp-call-status').textContent = 'Ringing…';
  try {
    const res = await fetch('/api/twilio/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: row.id, to: $('#qp-call-number')?.value || row.phone || '' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Failed to start call', 'error');
      $('#qp-call-btn').hidden = false;
      $('#qp-call-active').hidden = true;
      return;
    }
    const data = await res.json();
    state.queueCallLogId = data.call_log_id;
    state.queueCallStart = Date.now();

    // Live Twilio — place call via browser Voice SDK
    if (!data.mock && state.twilioDevice) {
      try {
        // Normalize phone to E.164 format for Twilio
        const rawPhone = data.to || row.phone || '';
        const digits = rawPhone.replace(/\D/g, '');
        const e164 = digits.length === 10 ? '+1' + digits : digits.length === 11 && digits[0] === '1' ? '+' + digits : '+' + digits;
        const call = await state.twilioDevice.connect({
          params: {
            To: e164,
            callLogId: data.call_log_id,
          },
        });
        state.twilioActiveCall = call;
        call.on('ringing', () => {
          $('#qp-call-status').textContent = 'Ringing…';
        });
        call.on('accept', () => {
          $('#qp-call-status').textContent = 'Connected';
          $('#qp-mute-btn').hidden = false;
        });
        call.on('disconnect', () => {
          onCallEnded();
        });
        call.on('cancel', () => {
          onCallEnded();
        });
        call.on('error', (err) => {
          console.error('[twilio] Call error:', err.message);
          toast('Call error: ' + err.message, 'error');
          onCallEnded();
        });
      } catch (err) {
        toast('Voice SDK connect failed: ' + err.message, 'error');
        $('#qp-call-btn').hidden = false;
        $('#qp-call-active').hidden = true;
        return;
      }
    }

    clearInterval(state.queueCallTimer);
    state.queueCallTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - state.queueCallStart) / 1000);
      $('#qp-timer').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      if (data.mock && secs > 2) $('#qp-call-status').textContent = 'Connected';
    }, 500);
  } catch (err) {
    toast('Call failed: ' + err.message, 'error');
    $('#qp-call-btn').hidden = false;
    $('#qp-call-active').hidden = true;
  }
}

function onCallEnded() {
  clearInterval(state.queueCallTimer);
  state.twilioActiveCall = null;
  $('#qp-mute-btn').hidden = true;
  $('#qp-call-active').hidden = true;
  $('#qp-processing').hidden = false;
  if (state.queueCallLogId) pollForDebrief(state.queueCallLogId);
}

function toggleMute() {
  const call = state.twilioActiveCall;
  if (!call) return;
  const muted = call.isMuted();
  call.mute(!muted);
  const btn = $('#qp-mute-btn');
  btn.textContent = muted ? 'Mute' : 'Unmute';
  btn.classList.toggle('active', !muted);
}

async function endQueueCall() {
  clearInterval(state.queueCallTimer);
  const durationSec = Math.max(5, Math.floor((Date.now() - state.queueCallStart) / 1000));

  if (!state.queueCallLogId) {
    $('#qp-processing').hidden = true;
    $('#qp-call-btn').hidden = false;
    return;
  }

  // Live Twilio — disconnect the Voice SDK call (triggers onCallEnded via 'disconnect' event)
  if (state.twilioActiveCall) {
    state.twilioActiveCall.disconnect();
    return; // onCallEnded handles the rest
  }

  // Mock mode — manual flow
  $('#qp-call-active').hidden = true;
  $('#qp-processing').hidden = false;
  if (state.twilioStatus?.mock) {
    try {
      await fetch('/api/twilio/mock-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ call_log_id: state.queueCallLogId, duration_sec: durationSec }),
      });
    } catch (err) {
      toast('Mock-complete failed: ' + err.message, 'error');
    }
  }
  pollForDebrief(state.queueCallLogId);
}

function pollForDebrief(callLogId) {
  clearInterval(state.queuePollTimer);
  let attempts = 0;
  state.queuePollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const res = await fetch(`/api/calls/${callLogId}/debrief-questions`);
      if (res.ok) {
        const data = await res.json();
        if (data.ready) {
          clearInterval(state.queuePollTimer);
          $('#qp-processing').hidden = true;
          $('#qp-call-btn').hidden = false;
          openDebriefModal(callLogId, data);
          return;
        }
      }
    } catch {}
    if (attempts > 60) {
      clearInterval(state.queuePollTimer);
      $('#qp-processing').hidden = true;
      $('#qp-call-btn').hidden = false;
      toast('Analysis timed out. Debrief will appear in the banner.', 'error');
      refreshPendingDebriefs();
    }
  }, 1500);
}

// ---------- Debrief modal ----------
async function openDebriefModal(callLogId, preloaded = null) {
  let data = preloaded;
  if (!data) {
    const res = await fetch(`/api/calls/${callLogId}/debrief-questions`);
    if (!res.ok) { toast('Unable to load debrief', 'error'); return; }
    data = await res.json();
    if (!data.ready) {
      toast('Analysis still running — try again in a moment', 'info');
      return;
    }
  }
  state.debriefCall = { id: callLogId, ...data };
  renderDebriefModal();
  $('#debrief-modal').hidden = false;
}

function renderDebriefModal() {
  const d = state.debriefCall;
  if (!d) return;

  // Show company/contact in subtitle
  const subParts = [];
  if (d.company_name) subParts.push(d.company_name);
  if (d.owner_name) subParts.push(d.owner_name);
  const sub = $('#debrief-sub');
  if (sub) sub.textContent = subParts.length
    ? `${subParts.join(' — ')} · Minimum 10 characters per answer.`
    : 'Answer each question below before continuing. Each answer must be at least 10 characters.';

  // Disposition dropdown — auto-detect No Answer from AI sentiment
  const disp = $('#debrief-disposition');
  if (disp) {
    if (d.sentiment === 'No Answer') {
      disp.value = 'no_answer_no_vm';
    } else {
      disp.value = 'answered';
    }
    updateDebriefDisposition();
  }

  // Summary block
  const summary = d.ai_summary || {};
  const bullets = Array.isArray(summary.bullets) ? summary.bullets : [];
  const sentiment = d.sentiment || 'Neutral';
  $('#debrief-summary').innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <strong>AI Summary</strong>
      <span class="sentiment-badge sentiment-${sentiment.replace(/\s+/g, '-')}">${escapeHtml(sentiment)}</span>
    </div>
    ${bullets.length ? `<ul class="debrief-summary-bullets">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
    ${d.next_action ? `<div style="margin-top:6px;"><strong>Next:</strong> ${escapeHtml(d.next_action)}</div>` : ''}
  `;

  // Callback suggestion
  const cbSection = $('#debrief-callback-section');
  const cbStatus = $('#debrief-callback-status');
  if (cbSection) {
    const aiSummary = d.ai_summary || {};
    const cbDate = d.scheduled_callback_date;
    const cbQuote = aiSummary.scheduling_quote || null;
    const showCallback = cbDate || d.sentiment === 'Callback Requested' || aiSummary.scheduling_detected;
    if (showCallback) {
      cbSection.hidden = false;
      cbStatus.hidden = true;
      const dateInput = $('#debrief-callback-date');
      // Pre-fill: use Claude's date, or default to 2 weeks from today
      const twoWeeksOut = localDateStr(new Date(Date.now() + 14 * 86400000));
      const normalizedDate = cbDate ? (typeof cbDate === 'string' ? cbDate.slice(0, 10) : localDateStr(new Date(cbDate))) : null;
      dateInput.value = normalizedDate || twoWeeksOut;
      const displayDate = normalizedDate || twoWeeksOut;
      const quoteEl = $('#debrief-callback-quote');
      quoteEl.textContent = cbQuote
        ? `Based on: "${cbQuote}"`
        : normalizedDate
          ? `Claude suggests ${new Date(displayDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`
          : 'Callback intent detected — suggested 2 weeks out (adjust as needed)';
      state.debriefCallbackDecision = null;
    } else {
      cbSection.hidden = true;
    }
  }

  // Pre-fill drafted answers if present
  const draft = Array.isArray(d.draft) ? d.draft : [];
  const questions = d.questions || [];
  $('#debrief-questions').innerHTML = questions
    .map((q, i) => {
      const drafted = draft.find((da) => da && da.question === q)?.answer
        || draft[i]?.answer
        || '';
      return `
        <div class="debrief-q">
          <div class="debrief-q-text">${i + 1}. ${escapeHtml(q)}</div>
          <textarea class="debrief-q-textarea" data-idx="${i}" data-question="${escapeHtml(q)}" placeholder="Optional">${escapeHtml(drafted)}</textarea>
        </div>`;
    })
    .join('');

  // Wire textareas
  $$('.debrief-q-textarea').forEach((ta) => {
    ta.addEventListener('input', () => {
      scheduleDebriefDraftSave();
    });
  });

  validateDebriefForm();
}

function updateDebriefDisposition() {
  const disp = $('#debrief-disposition')?.value || 'answered';
  const vmSection = $('#debrief-vm-section');
  const answeredSection = $('#debrief-answered-section');
  if (disp === 'answered') {
    if (vmSection) vmSection.hidden = true;
    if (answeredSection) answeredSection.hidden = false;
  } else if (disp === 'no_answer_left_vm') {
    if (vmSection) vmSection.hidden = false;
    if (answeredSection) answeredSection.hidden = true;
  } else {
    // no_answer_no_vm
    if (vmSection) vmSection.hidden = true;
    if (answeredSection) answeredSection.hidden = true;
  }
  validateDebriefForm();
}

function validateDebriefForm() {
  // All answers are optional — submit is always enabled
  $('#debrief-submit').disabled = false;
}

function collectDebriefAnswers() {
  return $$('.debrief-q-textarea').map((ta) => ({
    question: ta.dataset.question,
    answer: ta.value,
  }));
}

function scheduleDebriefDraftSave() {
  clearTimeout(state.debriefDraftTimer);
  state.debriefDraftTimer = setTimeout(saveDebriefDraftNow, 2000);
}

async function saveDebriefDraftNow() {
  const d = state.debriefCall;
  if (!d) return;
  try {
    await fetch(`/api/calls/${d.id}/debrief-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: collectDebriefAnswers() }),
    });
  } catch {}
}

async function submitDebrief() {
  const d = state.debriefCall;
  if (!d) return;
  const disp = $('#debrief-disposition')?.value || 'answered';
  const payload = { disposition: disp };
  if (disp === 'no_answer_no_vm') {
    payload.answers = [{ question: 'Call outcome', answer: 'No answer — did not leave a voicemail' }];
  } else if (disp === 'no_answer_left_vm') {
    const vmNote = ($('#debrief-vm-note')?.value || '').trim();
    payload.answers = [
      { question: 'Call outcome', answer: 'No answer — left a voicemail' },
      { question: 'Voicemail summary', answer: vmNote },
    ];
  } else {
    payload.answers = collectDebriefAnswers();
  }
  // Callback decision
  if (state.debriefCallbackDecision) {
    payload.callback_decision = state.debriefCallbackDecision;
  }
  try {
    const res = await fetch(`/api/calls/${d.id}/debrief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Submit failed', 'error');
      return;
    }
    toast('Debrief saved ✓', 'ok');
    closeDebriefModal();
    await refreshPendingDebriefs();
    // Auto-skip this company from queue for today
    if (state.queueActiveId) {
      fetch('/api/queue/skip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: state.queueActiveId }),
      }).catch(() => {});
      const doneId = state.queueActiveId;
      await loadQueue();
      const nextIdx = state.queue.findIndex((r) => r.id !== doneId);
      if (nextIdx >= 0) selectQueueRow(state.queue[nextIdx].id);
    }
    if (state.activeId) openDetail(state.activeId);
  } catch (err) {
    toast('Submit failed: ' + err.message, 'error');
  }
}

async function saveDebriefAndClose() {
  await saveDebriefDraftNow();
  toast('Draft saved', 'ok');
  closeDebriefModal();
  refreshPendingDebriefs();
}

function closeDebriefModal() {
  $('#debrief-modal').hidden = true;
  state.debriefCall = null;
  clearTimeout(state.debriefDraftTimer);
}

// ---------- Call History on company detail ----------
async function renderCallHistory(companyId) {
  const box = $('#d-call-history');
  const countEl = $('#d-calls-count');
  if (!box) return;
  try {
    const res = await fetch(`/api/companies/${companyId}/calls`);
    if (!res.ok) { box.innerHTML = '<div class="d-empty">Unable to load call history.</div>'; return; }
    const { calls } = await res.json();
    if (countEl) countEl.textContent = calls.length;
    if (!calls.length) {
      box.innerHTML = '<div class="d-empty">No calls recorded.</div>';
      return;
    }
    box.innerHTML = calls
      .map((c) => {
        const when = c.called_at ? new Date(c.called_at).toLocaleString() : '—';
        const dur = c.duration_sec
          ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s`
          : '—';
        const sentiment = c.sentiment || 'Neutral';
        const sentKey = sentiment.replace(/\s+/g, '-');
        const bullets = (c.ai_summary?.bullets || []);
        const qa = c.debrief_qa || [];
        return `
          <div class="d-call sentiment-${sentKey}">
            <div class="d-call-head">
              <div class="d-call-when">${escapeHtml(when)}</div>
              <span class="sentiment-badge sentiment-${sentKey}">${escapeHtml(sentiment)}</span>
              <div class="d-call-duration">${escapeHtml(dur)}</div>
            </div>
            ${c.next_action ? `<div class="d-call-next"><strong>Next:</strong> ${escapeHtml(c.next_action)}</div>` : ''}
            ${bullets.length ? `<details class="d-call-details"><summary>AI Summary (${bullets.length})</summary><ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul></details>` : ''}
            ${qa.length ? `<details class="d-call-details"><summary>Debrief Q&amp;A</summary><dl>${qa.map((a) => `<dt>${escapeHtml(a.question)}</dt><dd>${escapeHtml(a.answer)}</dd>`).join('')}</dl></details>` : ''}
            ${c.debrief_status === 'pending' || c.debrief_status === 'draft' ? `<div style="margin-top:6px;"><button type="button" class="btn-ghost btn-xs" data-resume-debrief="${escapeHtml(c.id)}">Resume debrief</button></div>` : ''}
          </div>`;
      })
      .join('');
    $$('[data-resume-debrief]', box).forEach((btn) => {
      btn.addEventListener('click', () => openDebriefModal(btn.dataset.resumeDebrief));
    });
  } catch (err) {
    box.innerHTML = `<div class="d-empty">Error loading call history.</div>`;
  }
}

// ---------- Calendar ----------
function ensureCalendarCursor() {
  if (state.calendarCursor) return;
  const now = new Date();
  state.calendarCursor = { year: now.getFullYear(), month: now.getMonth() + 1 };
}

async function loadCalendar() {
  ensureCalendarCursor();
  const { year, month } = state.calendarCursor;
  $('#cal-title').textContent = new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  try {
    const res = await fetch(`/api/calendar?year=${year}&month=${String(month).padStart(2, '0')}`);
    if (!res.ok) {
      state.calendarEvents = [];
    } else {
      const data = await res.json();
      state.calendarEvents = data.events || [];
    }
  } catch {
    state.calendarEvents = [];
  }
  // Also fetch call logs for this month
  await loadCalendarCallLogs();
  renderCalendar();
  // Inject call log chips after render
  renderCalendarWithCalls();
  loadOutlookStatus();
}

function renderCalendar() {
  const { year, month } = state.calendarCursor;
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  // Leading blanks from previous month
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    const day = prevMonthDays - i;
    const d = new Date(year, month - 2, day);
    cells.push({ date: d, otherMonth: true });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: new Date(year, month - 1, day), otherMonth: false });
  }
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cells.push({ date: d, otherMonth: true });
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const grid = $('#cal-grid');
  grid.innerHTML = cells
    .map((cell) => {
      const dkey = cell.date.toISOString().slice(0, 10);
      const events = state.calendarEvents.filter((e) =>
        (e.starts_at || '').slice(0, 10) === dkey
      );
      const isToday = cell.date.getTime() === today.getTime();
      const classes = [
        'cal-cell',
        cell.otherMonth ? 'other-month' : '',
        isToday ? 'today' : '',
      ].filter(Boolean).join(' ');
      const shown = events.slice(0, 3);
      const extra = events.length - shown.length;
      const chips = shown
        .map((e) => {
          const overdue =
            !e.completed && new Date(e.starts_at) < new Date(today.getTime());
          const cls =
            (e.completed ? 'completed ' : '') +
            (overdue ? 'overdue' : e.source === 'auto-transcript' ? 'auto' : '');
          return `<div class="cal-event-chip ${cls}" data-event="${escapeHtml(e.id)}" title="${escapeHtml(e.title || '')}">${escapeHtml(e.title || '(untitled)')}</div>`;
        })
        .join('');
      return `
        <div class="${classes}" data-date="${dkey}">
          <div class="cal-cell-date">${cell.date.getDate()}</div>
          <div class="cal-cell-events">
            ${chips}
            ${extra > 0 ? `<div class="cal-event-more">+${extra} more</div>` : ''}
          </div>
        </div>`;
    })
    .join('');

  // Bind cells
  $$('.cal-cell', grid).forEach((cell) => {
    cell.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-event]');
      if (chip) {
        openCalendarEventModal(chip.dataset.event);
      } else {
        openCalendarEventModal(null, cell.dataset.date);
      }
    });
  });
}

// Format date as YYYY-MM-DD in local time (avoids UTC shift from toISOString)
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function openCalendarEventModal(eventId, dateHint) {
  state.calendarEditing = null;
  $('#cal-ev-title').value = '';
  $('#cal-ev-desc').value = '';
  $('#cal-ev-date').value = dateHint || localDateStr(new Date());
  $('#cal-ev-time').value = '10:00';
  $('#cal-ev-company').value = '';
  $('#cal-ev-company-matches').innerHTML = '';
  $('#cal-ev-quote-row').hidden = true;
  $('#cal-ev-quote').textContent = '';
  $('#cal-ev-delete').hidden = true;
  $('#cal-ev-complete').hidden = true;
  $('#cal-modal-title').textContent = 'New Event';
  resetCalContactDropdown();
  updateCalTimezoneLabel();

  if (eventId) {
    const ev = state.calendarEvents.find((e) => e.id === eventId);
    if (ev) {
      state.calendarEditing = ev;
      $('#cal-modal-title').textContent = 'Event Details';
      $('#cal-ev-title').value = ev.title || '';
      $('#cal-ev-desc').value = ev.description || '';
      const dt = new Date(ev.starts_at);
      $('#cal-ev-date').value = localDateStr(dt);
      $('#cal-ev-time').value = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      if (ev.transcript_quote) {
        $('#cal-ev-quote-row').hidden = false;
        $('#cal-ev-quote').textContent = ev.transcript_quote;
      }
      $('#cal-ev-delete').hidden = false;
      $('#cal-ev-complete').hidden = ev.completed;
      if (ev.company_id) {
        const match = state.companies.find((c) => c.id === ev.company_id);
        if (match) {
          $('#cal-ev-company').value = match.name;
          loadCalContactsForCompany(ev.company_id, ev.contact_id);
        }
      }
    }
  }
  $('#cal-modal').hidden = false;
}

function updateCalTimezoneLabel() {
  const tz = $('#cal-ev-tz');
  if (tz) tz.textContent = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

function resetCalContactDropdown() {
  const sel = $('#cal-ev-contact');
  if (sel) {
    sel.innerHTML = '<option value="">Contact (optional)</option>';
    sel.hidden = true;
  }
}

async function loadCalContactsForCompany(companyId, preselect) {
  const sel = $('#cal-ev-contact');
  if (!sel || !companyId) { resetCalContactDropdown(); return; }
  try {
    const res = await fetch(`/api/companies/${companyId}/contacts`);
    if (!res.ok) { resetCalContactDropdown(); return; }
    const { contacts } = await res.json();
    if (!contacts || !contacts.length) { resetCalContactDropdown(); return; }
    sel.innerHTML = '<option value="">Contact (optional)</option>' +
      contacts.map((c) => `<option value="${c.id}"${c.id === preselect ? ' selected' : ''}>${escapeHtml(c.name)}${c.title ? ' — ' + escapeHtml(c.title) : ''}${c.is_primary ? ' (Primary)' : ''}</option>`).join('');
    sel.hidden = false;
  } catch { resetCalContactDropdown(); }
}

function closeCalendarModal() {
  $('#cal-modal').hidden = true;
  state.calendarEditing = null;
}

async function saveCalendarEvent() {
  const title = $('#cal-ev-title').value.trim();
  if (!title) { toast('Title required', 'error'); return; }
  const date = $('#cal-ev-date').value;
  const time = $('#cal-ev-time').value || '10:00';
  if (!date) { toast('Date required', 'error'); return; }
  const starts_at = `${date}T${time}:00`;

  // Match company by typed name (case-insensitive first match)
  const typed = $('#cal-ev-company').value.trim().toLowerCase();
  const company = typed
    ? state.companies.find((c) => c.name.toLowerCase() === typed)
      || state.calendarCompanyMatches[0]
    : null;

  const contactId = $('#cal-ev-contact')?.value || null;
  const body = {
    title,
    description: $('#cal-ev-desc').value.trim() || null,
    starts_at,
    company_id: company?.id || null,
    contact_id: contactId || null,
  };

  let res;
  if (state.calendarEditing) {
    res = await fetch(`/api/calendar/${state.calendarEditing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    res = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Save failed', 'error');
    return;
  }
  toast('Saved', 'ok');
  closeCalendarModal();
  loadCalendar();
}

async function deleteCalendarEvent() {
  if (!state.calendarEditing) return;
  if (!confirm('Delete this event?')) return;
  const res = await fetch(`/api/calendar/${state.calendarEditing.id}`, { method: 'DELETE' });
  if (!res.ok) { toast('Delete failed', 'error'); return; }
  toast('Deleted', 'ok');
  closeCalendarModal();
  loadCalendar();
}

async function completeCalendarEvent() {
  if (!state.calendarEditing) return;
  const res = await fetch(`/api/calendar/${state.calendarEditing.id}/complete`, { method: 'POST' });
  if (!res.ok) { toast('Update failed', 'error'); return; }
  toast('Marked complete', 'ok');
  closeCalendarModal();
  loadCalendar();
}

function updateCalendarCompanyMatches() {
  const q = $('#cal-ev-company').value.trim().toLowerCase();
  const box = $('#cal-ev-company-matches');
  if (!q) { box.innerHTML = ''; state.calendarCompanyMatches = []; return; }
  const matches = state.companies
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 6);
  state.calendarCompanyMatches = matches;
  box.innerHTML = matches
    .map((c) => `<div class="cal-ev-match" data-id="${escapeHtml(c.id)}">${escapeHtml(c.name)} — ${escapeHtml(c.city || '')}${c.state ? ', ' + escapeHtml(c.state) : ''}</div>`)
    .join('');
  $$('.cal-ev-match', box).forEach((el) => {
    el.addEventListener('click', () => {
      const match = state.companies.find((c) => c.id === el.dataset.id);
      if (match) {
        $('#cal-ev-company').value = match.name;
        loadCalContactsForCompany(match.id);
      }
      box.innerHTML = '';
    });
  });
}

// ---------- Settings ----------
async function loadSettings() {
  // Load my preferences
  try {
    const res = await fetch('/api/me/assignments');
    if (res.ok) {
      const data = await res.json();
      $('#settings-cooldown').value = data.queue_cooldown_days || 7;
    }
  } catch {}

  // Admin section
  if (state.user?.role === 'admin') {
    $('#settings-admin-section').hidden = false;
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) {
        const data = await res.json();
        state.settingsUsers = data.users || [];
        renderSettingsUsers();
      }
    } catch {}
  } else {
    $('#settings-admin-section').hidden = true;
  }
}

function renderSettingsUsers() {
  const box = $('#settings-users');
  box.innerHTML = state.settingsUsers
    .map((u) => {
      const roleLabel = ROLE_LABELS[u.role] || u.role;
      const restrictedBadge = u.restricted ? ' <span class="settings-user-tag restricted">restricted</span>' : '';
      const disabledBadge = u.disabled ? ' <span class="settings-user-tag restricted">disabled</span>' : '';
      const verts = (u.assigned_verticals || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      const terrs = (u.assigned_territories || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      return `
        <div class="settings-user-row" data-user="${escapeHtml(u.id)}">
          <div>
            <div class="settings-user-name">${escapeHtml(u.name || '—')} <span class="settings-user-role ${u.role}">${escapeHtml(roleLabel)}</span>${restrictedBadge}${disabledBadge}</div>
            <div class="settings-user-email">${escapeHtml(u.email || '')}${u.twilio_phone_number ? ` · <span style="color:var(--gold)">${escapeHtml(u.twilio_phone_number)}</span>` : ''}</div>
            <div class="settings-user-tags">
              ${verts || '<span class="settings-user-tag dim">no industries</span>'}
              ${terrs || '<span class="settings-user-tag dim">no territories</span>'}
            </div>
          </div>
          <button type="button" class="btn-ghost btn-xs" data-edit-user="${escapeHtml(u.id)}">Edit</button>
        </div>`;
    })
    .join('');
  $$('[data-edit-user]', box).forEach((btn) => {
    btn.addEventListener('click', () => openSettingsUserModal(btn.dataset.editUser));
  });
}

const SETTINGS_VERTICALS = [
  'Plumbing', 'HVAC', 'Electrical', 'Pest Control', 'Roofing', 'Siding',
  'Janitorial', 'Painting', 'Cleaning', 'Restoration', 'Landscaping',
  'Septic', 'Excavation', 'Fire Protection', 'Pool Service',
  'Garage Door', 'Insulation', 'Other',
];

const SETTINGS_TERRITORIES = [
  'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA',
  'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD',
  'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH',
  'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
];

function openSettingsUserModal(userId) {
  const u = state.settingsUsers.find((x) => x.id === userId);
  if (!u) return;
  state.settingsEditingUser = u;
  $('#settings-user-title').textContent = `Edit: ${u.name || u.email}`;
  $('#settings-user-role').value = u.role || 'analyst';
  // Render industry chips — include presets + any custom ones the user already has
  const vBox = $('#settings-user-verticals');
  const userVerts = u.assigned_verticals || [];
  const customVerts = userVerts.filter(v => !SETTINGS_VERTICALS.includes(v));
  const allVerts = [...SETTINGS_VERTICALS, ...customVerts];
  vBox.innerHTML = allVerts
    .map((v) => {
      const active = userVerts.includes(v) ? 'active' : '';
      return `<span class="settings-chip ${active}" data-vert="${escapeHtml(v)}">${escapeHtml(v)}</span>`;
    })
    .join('') +
    `<span class="settings-chip-add" id="settings-add-vertical" title="Add custom industry">+</span>`;
  $$('.settings-chip[data-vert]', vBox).forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });
  $('#settings-add-vertical')?.addEventListener('click', () => {
    const name = prompt('Enter custom industry name:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if ($$('.settings-chip[data-vert]', vBox).some(c => c.dataset.vert.toLowerCase() === trimmed.toLowerCase())) {
      toast('Industry already exists', 'error');
      return;
    }
    const chip = document.createElement('span');
    chip.className = 'settings-chip active';
    chip.dataset.vert = trimmed;
    chip.textContent = trimmed;
    chip.addEventListener('click', () => chip.classList.toggle('active'));
    vBox.insertBefore(chip, $('#settings-add-vertical'));
  });
  // Render territory chips
  const tBox = $('#settings-user-territories');
  const userTerrs = (u.assigned_territories || []).map(t => t.toUpperCase());
  tBox.innerHTML = SETTINGS_TERRITORIES
    .map((t) => {
      const active = userTerrs.includes(t) ? 'active' : '';
      return `<span class="settings-chip ${active}" data-terr="${escapeHtml(t)}">${escapeHtml(t)}</span>`;
    })
    .join('');
  $$('.settings-chip[data-terr]', tBox).forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });
  // Twilio number
  const twilioInput = $('#settings-user-twilio');
  if (twilioInput) twilioInput.value = u.twilio_phone_number || '';
  // Access toggle
  const fullRadio = $('#settings-access-full');
  const restrictedRadio = $('#settings-access-restricted');
  if (fullRadio && restrictedRadio) {
    if (u.restricted) { restrictedRadio.checked = true; } else { fullRadio.checked = true; }
  }
  // Disabled toggle — hidden for your own account
  const disabledRow = $('#settings-disabled-row');
  const disabledCb = $('#settings-user-disabled');
  if (disabledRow) disabledRow.hidden = (u.id === state.user?.id);
  if (disabledCb) disabledCb.checked = !!u.disabled;
  // Delete + Reset password buttons — hide for your own account
  const delBtn = $('#settings-user-delete');
  if (delBtn) delBtn.hidden = (u.id === state.user?.id);
  const resetPwBtn = $('#settings-user-reset-pw');
  if (resetPwBtn) resetPwBtn.hidden = (u.id === state.user?.id);
  $('#settings-user-modal').hidden = false;
}

function closeSettingsUserModal() {
  $('#settings-user-modal').hidden = true;
  state.settingsEditingUser = null;
}

async function resetSettingsUserPassword() {
  const u = state.settingsEditingUser;
  if (!u) return;
  const password = prompt(`Set a new password for ${u.name || u.email}:\n(min 6 characters)`);
  if (!password) return;
  if (password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
  try {
    const res = await fetch(`/api/admin/users/${u.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Reset failed', 'error'); return; }
    toast(`Password reset for ${u.name || u.email}`, 'ok');
  } catch (err) {
    toast('Reset failed: ' + err.message, 'error');
  }
}

async function deleteSettingsUser() {
  const u = state.settingsEditingUser;
  if (!u) return;
  if (!confirm(`Delete account "${u.name || u.email}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Delete failed', 'error');
      return;
    }
    toast('Account deleted', 'ok');
    closeSettingsUserModal();
    loadSettings();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

async function saveSettingsUser() {
  const u = state.settingsEditingUser;
  if (!u) return;
  const role = $('#settings-user-role').value;
  const verticals = $$('.settings-chip.active[data-vert]').map((c) => c.dataset.vert);
  const territories = $$('.settings-chip.active[data-terr]').map((c) => c.dataset.terr);
  const restricted = !!$('#settings-access-restricted')?.checked;
  const twilio_phone_number = $('#settings-user-twilio')?.value?.trim() || null;
  const disabled = !!$('#settings-user-disabled')?.checked;
  try {
    if (role !== u.role) {
      const res = await fetch(`/api/admin/users/${u.id}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Role update failed', 'error');
        return;
      }
    }
    const res2 = await fetch(`/api/admin/users/${u.id}/assignments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verticals, territories, restricted, twilio_phone_number, disabled }),
    });
    if (!res2.ok) {
      const err = await res2.json().catch(() => ({}));
      toast(err.error || 'Save failed', 'error');
      return;
    }
    toast('Saved', 'ok');
    closeSettingsUserModal();
    loadSettings();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

async function saveCooldown() {
  const days = Number($('#settings-cooldown').value);
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    toast('Cooldown must be 1–30 days', 'error');
    return;
  }
  const res = await fetch('/api/me/queue-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cooldown_days: days }),
  });
  if (!res.ok) { toast('Save failed', 'error'); return; }
  toast('Saved', 'ok');
}

// ---------- Phase 2 wiring ----------
function bindPhase2() {
  bindLogin();
  bindProfile();
  $('#queue-refresh')?.addEventListener('click', loadQueue);
  $('#queue-target-select')?.addEventListener('change', applyTargetFilter);
  $('#queue-target-create')?.addEventListener('click', () => openTargetModal());
  $('#queue-target-edit')?.addEventListener('click', () => {
    const targetId = $('#queue-target-select')?.value;
    const target = (state.callTargets || []).find(t => t.id === targetId);
    if (target) openTargetModal(target);
  });
  $('#queue-target-delete')?.addEventListener('click', deleteTarget);
  $('#target-save')?.addEventListener('click', saveTarget);
  $('#target-cancel')?.addEventListener('click', () => { $('#target-modal').hidden = true; });
  $('#target-modal-close')?.addEventListener('click', () => { $('#target-modal').hidden = true; });
  $('#qp-call-btn')?.addEventListener('click', startQueueCall);
  $('#qp-end-btn')?.addEventListener('click', endQueueCall);
  $('#qp-mute-btn')?.addEventListener('click', toggleMute);
  $('#qp-notes-stamp')?.addEventListener('click', insertQueueNoteTimestamp);
  $('#qp-notes-save')?.addEventListener('click', saveQueueNote);

  $('#debrief-submit')?.addEventListener('click', submitDebrief);
  $('#debrief-draft-btn')?.addEventListener('click', saveDebriefAndClose);
  $('#debrief-close')?.addEventListener('click', closeDebriefModal);
  $('#debrief-disposition')?.addEventListener('change', updateDebriefDisposition);
  $('#debrief-vm-note')?.addEventListener('input', validateDebriefForm);
  $('#debrief-callback-approve')?.addEventListener('click', () => {
    const date = $('#debrief-callback-date').value;
    if (!date) { toast('Pick a date', 'error'); return; }
    state.debriefCallbackDecision = { action: 'approve', date };
    const status = $('#debrief-callback-status');
    status.textContent = `Callback scheduled for ${new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
    status.className = 'debrief-callback-status approved';
    status.hidden = false;
    $('#debrief-callback-approve').textContent = 'Updated';
  });
  $('#debrief-callback-decline')?.addEventListener('click', () => {
    state.debriefCallbackDecision = { action: 'decline' };
    const status = $('#debrief-callback-status');
    status.textContent = 'No callback — normal queue cooldown will apply';
    status.className = 'debrief-callback-status declined';
    status.hidden = false;
  });
  $('#debrief-banner-resume')?.addEventListener('click', resumeOldestDebrief);
  $('#debrief-banner-dismiss')?.addEventListener('click', dismissOldestDebrief);

  $('#cal-prev')?.addEventListener('click', () => {
    ensureCalendarCursor();
    const c = state.calendarCursor;
    c.month -= 1;
    if (c.month < 1) { c.month = 12; c.year -= 1; }
    loadCalendar();
  });
  $('#cal-next')?.addEventListener('click', () => {
    ensureCalendarCursor();
    const c = state.calendarCursor;
    c.month += 1;
    if (c.month > 12) { c.month = 1; c.year += 1; }
    loadCalendar();
  });
  $('#cal-today')?.addEventListener('click', () => {
    const now = new Date();
    state.calendarCursor = { year: now.getFullYear(), month: now.getMonth() + 1 };
    loadCalendar();
  });
  $('#cal-modal-close')?.addEventListener('click', closeCalendarModal);
  $('#cal-ev-save')?.addEventListener('click', saveCalendarEvent);
  $('#cal-ev-delete')?.addEventListener('click', deleteCalendarEvent);
  $('#cal-ev-complete')?.addEventListener('click', completeCalendarEvent);
  $('#cal-ev-company')?.addEventListener('input', updateCalendarCompanyMatches);
  $('#cal-new-event')?.addEventListener('click', () => openCalendarEventModal());

  $('#settings-cooldown-save')?.addEventListener('click', saveCooldown);
  $('#settings-user-close')?.addEventListener('click', closeSettingsUserModal);
  $('#settings-user-save')?.addEventListener('click', saveSettingsUser);
  $('#settings-user-delete')?.addEventListener('click', deleteSettingsUser);
  $('#settings-user-reset-pw')?.addEventListener('click', resetSettingsUserPassword);

  // Contacts tab + Add Company / Add Contact
  $('#btn-add-company')?.addEventListener('click', () => openCompanyModal());
  $('#company-modal-close')?.addEventListener('click', closeCompanyModal);
  $('#cm-cancel')?.addEventListener('click', closeCompanyModal);
  $('#cm-save')?.addEventListener('click', saveCompanyModal);

  $('#btn-add-contact')?.addEventListener('click', () => openContactModal());
  $('#contact-modal-close')?.addEventListener('click', closeContactModal);
  $('#ctm-cancel')?.addEventListener('click', closeContactModal);
  $('#ctm-add-phone')?.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'ctm-multi-row';
    row.innerHTML = '<input type="text" class="cf-input ctm-phone-input" placeholder="Phone" /><button type="button" class="ctm-remove-btn" onclick="this.parentElement.remove()">&times;</button>';
    $('#ctm-phones').appendChild(row);
  });
  $('#ctm-add-email')?.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'ctm-multi-row';
    row.innerHTML = '<input type="email" class="cf-input ctm-email-input" placeholder="Email" /><button type="button" class="ctm-remove-btn" onclick="this.parentElement.remove()">&times;</button>';
    $('#ctm-emails').appendChild(row);
  });
  $('#ctm-save')?.addEventListener('click', saveContactModal);
  $('#ctm-new-company')?.addEventListener('click', createCompanyFromContactModal);
  $('#ctm-company')?.addEventListener('input', updateContactCompanyMatches);

  $('#contacts-search')?.addEventListener('input', debounce(() => loadAllContacts(), 250));
}

// ---------- init ----------
function init() {
  bindToolbar();
  bindDetailActions();
  bindTabs();
  $('#markets-refresh')?.addEventListener('click', async () => {
    const res = await fetch('/api/market-intel/seed', { method: 'POST' });
    const data = await res.json();
    if (data.ok) toast(`Refreshed ${data.count} markets`, 'ok');
    await loadMarkets();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#detail-panel').hidden) {
      // If fullscreen, exit fullscreen first; else close
      if ($('#detail-panel').classList.contains('fullscreen')) toggleDetailFullscreen();
      else closeDetail();
    }
  });

  loadStatus();
  loadCompanies();
  loadMarkets();
  loadPipelineStages().then(() => loadPipelineBoard());

  // Phase 2 bootstrap
  bindPhase2();
  initCampaignBindings();
  $('#enrich-start-btn')?.addEventListener('click', startEnrichment);
  $('#enrich-stop-btn')?.addEventListener('click', stopEnrichment);
  // Check if enrichment is already running on load
  fetch('/api/enrich/status').then((r) => r.json()).then((d) => {
    if (d.running) {
      $('#enrich-start-btn').hidden = true;
      $('#enrich-stop-btn').hidden = false;
      $('#enrich-status').hidden = false;
      pollEnrichStatus();
    }
  }).catch(() => {});
  $('#actlog-load-more')?.addEventListener('click', () => loadActivityLog(true));
  // Inbox filter buttons
  $$('.inbox-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.inbox-filter').forEach(b => b.classList.toggle('active', b === btn));
      inboxFilter = btn.dataset.inboxFilter || 'all';
      renderInbox();
    });
  });
  // Incoming call buttons use inline onclick handlers
  loadCurrentUser()
    .then(() => { if (state.user) return refreshPendingDebriefs(); })
    .then(() => loadTwilioStatus());

  // SSE for real-time updates
  const sse = new EventSource('/api/run/stream');
  sse.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'pipeline_change') {
        loadPipelineBoard();
        loadCompanies();
        if (state.activeId === ev.id) openDetail(state.activeId);
      } else if (ev.type === 'contact_added' || ev.type === 'contact_updated' || ev.type === 'contact_deleted') {
        if (state.activeId === ev.company_id) openDetail(state.activeId);
        if ($('#tab-contacts')?.classList.contains('active')) loadAllContacts();
      } else if (ev.type === 'company_added') {
        loadCompanies();
      } else if (ev.type === 'activity_added') {
        if (state.activeId === ev.company_id) openDetail(state.activeId);
      } else if (ev.type === 'sms_received' || ev.type === 'sms_sent') {
        if (state.activeId === ev.company_id) loadCompanyMessages(ev.company_id);
        toast(ev.type === 'sms_received' ? `New text from ${ev.from || 'unknown'}` : 'Message sent', ev.type === 'sms_received' ? 'info' : 'ok');
      } else if (ev.type === 'company_done') {
        loadCompanies();
        loadPipelineBoard();
      }
      // ─── Phase 2 SSE ───
      else if (ev.type === 'call_started') {
        if ($('#tab-queue').classList.contains('active')) loadQueue();
      } else if (ev.type === 'call_ready_for_debrief') {
        refreshPendingDebriefs();
        // Auto-open if owned by current user and no modal already open
        if (state.user && (!ev.user_id || ev.user_id === state.user.id) && $('#debrief-modal').hidden) {
          if (state.queueCallLogId === ev.call_log_id) {
            openDebriefModal(ev.call_log_id);
          }
        }
      } else if (ev.type === 'calendar_event_created') {
        if ($('#tab-calendar').classList.contains('active')) loadCalendar();
        if ($('#tab-queue').classList.contains('active')) loadQueue();
      } else if (ev.type === 'queue_changed') {
        if ($('#tab-queue').classList.contains('active')) loadQueue();
      } else if (ev.type === 'debrief_complete') {
        refreshPendingDebriefs();
        if (state.activeId === ev.company_id) openDetail(state.activeId);
      }
    } catch {}
  };
  state.sse = sse;
}

// ═══════════════════════════════════════════════════════════════════
// Contacts tab + manual Add Company / Add Contact
// ═══════════════════════════════════════════════════════════════════

function debounce(fn, ms = 250) {
  let t = null;
  return function(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

async function loadAllContacts() {
  const q = ($('#contacts-search')?.value || '').trim();
  const host = $('#contacts-list');
  const empty = $('#contacts-empty');
  if (!host) return;
  try {
    const url = q ? `/api/contacts?q=${encodeURIComponent(q)}` : '/api/contacts';
    const res = await fetch(url);
    if (!res.ok) {
      host.innerHTML = '';
      empty.hidden = false;
      $('#contacts-count').textContent = '0 contacts';
      return;
    }
    const data = await res.json();
    const contacts = data.contacts || [];
    state.allContacts = contacts;
    renderContactsTab(contacts);
  } catch (err) {
    console.error('[contacts] load failed', err);
    host.innerHTML = '';
    empty.hidden = false;
  }
}

function renderContactsTab(contacts) {
  const host = $('#contacts-list');
  const empty = $('#contacts-empty');
  const count = $('#contacts-count');
  count.textContent = `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`;
  if (contacts.length === 0) {
    host.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  host.innerHTML = contacts.map(renderContactRow).join('');
  // Wire row actions
  $$('.contact-row-company-link', host).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const cid = el.dataset.companyId;
      if (!cid) return;
      // Switch to Companies tab and open detail panel
      const companiesTab = document.querySelector('.tab[data-tab="companies"]');
      if (companiesTab) companiesTab.click();
      setTimeout(() => openDetail(cid), 50);
    });
  });
  $$('.contact-row-edit', host).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.contactId;
      const contact = (state.allContacts || []).find((c) => c.id === id);
      if (contact) openContactModal(contact);
    });
  });
  $$('.contact-row-delete', host).forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.contactId;
      const name = el.dataset.name || 'this contact';
      if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
      try {
        const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
        if (res.ok) {
          toast('Contact deleted', 'ok');
          loadAllContacts();
        } else {
          toast('Failed to delete', 'error');
        }
      } catch { toast('Failed to delete', 'error'); }
    });
  });
}

function renderContactRow(c) {
  const name = escapeHtml(c.name || 'Unnamed');
  const warmBadge = c.warm_until && new Date(c.warm_until) > new Date() ? '<span class="warm-badge" title="Engaged — opened email or had positive call">🔥</span>' : '';
  const title = c.title ? escapeHtml(c.title) : '';
  const primary = c.is_primary ? '<span class="contact-row-primary-pill">Primary</span>' : '';
  const allPhones = [c.phone, ...((c.phones ? (typeof c.phones === 'string' ? JSON.parse(c.phones || '[]') : c.phones) : []))].filter(Boolean);
  const allEmails = [c.email, ...((c.emails ? (typeof c.emails === 'string' ? JSON.parse(c.emails || '[]') : c.emails) : []))].filter(Boolean);
  const phoneLines = allPhones.map(p => `<span>${escapeHtml(p)}</span>`).join('');
  const emailLines = allEmails.map(e => `<span>${escapeHtml(e)}</span>`).join('');
  const linkedinLink = c.linkedin ? `<span><a href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a></span>` : '';
  const contactInfo = [phoneLines, emailLines, linkedinLink].filter(Boolean).join('') ||
    '<span style="color: rgba(13,27,42,0.35)">No contact info</span>';
  const companyName = escapeHtml(c.company_name || 'No company linked');
  const companyMeta = [c.company_city, c.company_state].filter(Boolean).map(escapeHtml).join(', ');
  const companyLink = c.company_id
    ? `<button type="button" class="contact-row-company-link" data-company-id="${escapeHtml(c.company_id)}" title="Open company">${companyName}</button>`
    : `<span style="color: rgba(13,27,42,0.4)">${companyName}</span>`;
  return `
    <div class="contact-row">
      <div class="contact-row-main">
        <div class="contact-row-name">${name}${warmBadge}${primary}</div>
        ${title ? `<div class="contact-row-title">${title}</div>` : ''}
      </div>
      <div class="contact-row-contactinfo">${contactInfo}</div>
      <div class="contact-row-company">
        ${companyLink}
        ${companyMeta ? `<div class="contact-row-company-meta">${companyMeta}</div>` : ''}
      </div>
      <div class="contact-row-actions">
        <button type="button" class="contact-row-btn contact-row-edit" data-contact-id="${escapeHtml(c.id)}">Edit</button>
        <button type="button" class="contact-row-btn danger contact-row-delete" data-contact-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || '')}">Delete</button>
      </div>
    </div>
  `;
}

// ─── Add Company modal ────────────────────────────────────────────
function openCompanyModal() {
  const modal = $('#company-modal');
  if (!modal) return;
  ['cm-name','cm-city','cm-state','cm-phone','cm-website','cm-owner','cm-email','cm-address','cm-linkedin','cm-notes'].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.value = '';
  });
  modal.hidden = false;
  setTimeout(() => $('#cm-name')?.focus(), 50);
}

function closeCompanyModal() {
  const modal = $('#company-modal');
  if (modal) modal.hidden = true;
  // If returning from "create company for contact" flow without saving, reopen contact modal
  if (_contactModalStash) {
    const stash = { ..._contactModalStash };
    _contactModalStash = null;
    openContactModal(null, stash);
  }
}

async function saveCompanyModal() {
  const name = $('#cm-name').value.trim();
  if (!name) { toast('Company name is required', 'error'); $('#cm-name')?.focus(); return; }
  const body = {
    name,
    city: $('#cm-city').value.trim() || null,
    state: $('#cm-state').value.trim().toUpperCase() || null,
    phone: $('#cm-phone').value.trim() || null,
    website: $('#cm-website').value.trim() || null,
    owner: $('#cm-owner').value.trim() || null,
    email: $('#cm-email').value.trim() || null,
    address: $('#cm-address').value.trim() || null,
    linkedin: $('#cm-linkedin').value.trim() || null,
  };
  try {
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.status === 409) {
      if (confirm(`A company named "${data.company_name}" already exists. Open it?`)) {
        closeCompanyModal();
        const companiesTab = document.querySelector('.tab[data-tab="companies"]');
        if (companiesTab) companiesTab.click();
        setTimeout(() => openDetail(data.company_id), 50);
      }
      return;
    }
    if (!res.ok) { toast(data.error || 'Failed to add company', 'error'); return; }
    // If a note was entered, save it against the new company
    const note = $('#cm-notes').value.trim();
    if (note && data.company?.id) {
      try {
        await fetch(`/api/companies/${data.company.id}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        });
      } catch {}
    }
    toast('Company added', 'ok');
    closeCompanyModal();
    await loadCompanies();
    // If we came from the Add Contact flow, return there with the new company pre-selected
    if (_contactModalStash) {
      const stash = { ..._contactModalStash, company_id: data.company.id, company_name: name };
      _contactModalStash = null;
      openContactModal(null, stash);
      return;
    }
    // Open new company's detail panel
    const companiesTab = document.querySelector('.tab[data-tab="companies"]');
    if (companiesTab) companiesTab.click();
    setTimeout(() => openDetail(data.company.id), 50);
  } catch (err) {
    console.error(err);
    toast('Failed to add company', 'error');
  }
}

// ─── Add / Edit Contact modal ─────────────────────────────────────
// Stash for "create company → return to contact" flow
let _contactModalStash = null;

function openContactModal(contact = null, stash = null) {
  const modal = $('#contact-modal');
  if (!modal) return;
  state.editingContactId = contact?.id || null;
  $('#contact-modal-title').textContent = contact ? 'Edit Contact' : 'Add Contact';
  // Restore stashed fields if returning from Create Company flow
  const s = stash || {};
  $('#ctm-name').value = s.name ?? contact?.name ?? '';
  $('#ctm-title').value = s.title ?? contact?.title ?? '';
  // Populate phone fields
  const phonesContainer = $('#ctm-phones');
  if (phonesContainer) {
    const mainPhone = s.phone ?? contact?.phone ?? '';
    const extraPhones = contact?.phones ? (typeof contact.phones === 'string' ? JSON.parse(contact.phones || '[]') : contact.phones) : [];
    phonesContainer.innerHTML = `<input type="text" class="cf-input ctm-phone-input" placeholder="Phone" value="${escapeHtml(mainPhone)}" />`;
    extraPhones.forEach(p => {
      phonesContainer.innerHTML += `<div class="ctm-multi-row"><input type="text" class="cf-input ctm-phone-input" placeholder="Phone" value="${escapeHtml(p)}" /><button type="button" class="ctm-remove-btn" onclick="this.parentElement.remove()">&times;</button></div>`;
    });
  }
  // Populate email fields
  const emailsContainer = $('#ctm-emails');
  if (emailsContainer) {
    const mainEmail = s.email ?? contact?.email ?? '';
    const extraEmails = contact?.emails ? (typeof contact.emails === 'string' ? JSON.parse(contact.emails || '[]') : contact.emails) : [];
    emailsContainer.innerHTML = `<input type="email" class="cf-input ctm-email-input" placeholder="Email" value="${escapeHtml(mainEmail)}" />`;
    extraEmails.forEach(e => {
      emailsContainer.innerHTML += `<div class="ctm-multi-row"><input type="email" class="cf-input ctm-email-input" placeholder="Email" value="${escapeHtml(e)}" /><button type="button" class="ctm-remove-btn" onclick="this.parentElement.remove()">&times;</button></div>`;
    });
  }
  $('#ctm-linkedin').value = s.linkedin ?? contact?.linkedin ?? '';
  $('#ctm-notes').value = s.notes ?? contact?.notes ?? '';
  $('#ctm-primary').checked = s.is_primary ?? !!contact?.is_primary;
  $('#ctm-company-matches').innerHTML = '';
  $('#ctm-company').value = '';
  $('#ctm-company-id').value = '';
  if (s.company_id) {
    setContactModalCompany(s.company_id, s.company_name || '(company)');
  } else if (contact?.company_id) {
    setContactModalCompany(contact.company_id, contact.company_name || '(company)');
  } else {
    clearContactModalCompany();
  }
  modal.hidden = false;
  setTimeout(() => {
    if (contact || s.name) $('#ctm-name')?.focus();
    else $('#ctm-company')?.focus();
  }, 50);
}

function stashContactModalFields() {
  return {
    name: $('#ctm-name')?.value || '',
    title: $('#ctm-title')?.value || '',
    phone: $('#ctm-phone')?.value || '',
    email: $('#ctm-email')?.value || '',
    linkedin: $('#ctm-linkedin')?.value || '',
    notes: $('#ctm-notes')?.value || '',
    is_primary: $('#ctm-primary')?.checked || false,
    company_id: $('#ctm-company-id')?.value || '',
  };
}

function createCompanyFromContactModal() {
  // Stash current contact form state
  _contactModalStash = stashContactModalFields();
  closeContactModal();
  openCompanyModal();
}

function closeContactModal() {
  const modal = $('#contact-modal');
  if (modal) modal.hidden = true;
  state.editingContactId = null;
}

function setContactModalCompany(id, name) {
  $('#ctm-company-id').value = id;
  $('#ctm-company').hidden = true;
  $('#ctm-company-matches').innerHTML = '';
  const picked = $('#ctm-company-picked');
  picked.hidden = false;
  picked.innerHTML = `<span>${escapeHtml(name)}</span><button type="button" class="ctm-company-picked-clear" title="Change company">&times;</button>`;
  picked.querySelector('.ctm-company-picked-clear').addEventListener('click', clearContactModalCompany);
}

function clearContactModalCompany() {
  $('#ctm-company-id').value = '';
  $('#ctm-company').hidden = false;
  $('#ctm-company').value = '';
  $('#ctm-company-picked').hidden = true;
  $('#ctm-company-picked').innerHTML = '';
  $('#ctm-company-matches').innerHTML = '';
}

function updateContactCompanyMatches() {
  const q = $('#ctm-company').value.trim().toLowerCase();
  const box = $('#ctm-company-matches');
  if (!q || !state.companies) { box.innerHTML = ''; return; }
  const matches = state.companies
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 8);
  box.innerHTML = matches
    .map((c) => `<div class="cal-ev-match" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.city ? ' — ' + escapeHtml(c.city) : ''}${c.state ? ', ' + escapeHtml(c.state) : ''}</div>`)
    .join('');
  $$('.cal-ev-match', box).forEach((el) => {
    el.addEventListener('click', () => {
      setContactModalCompany(el.dataset.id, el.dataset.name);
    });
  });
}

async function saveContactModal() {
  const company_id = $('#ctm-company-id').value.trim();
  const name = $('#ctm-name').value.trim();
  if (!company_id) { toast('Please select a company', 'error'); $('#ctm-company')?.focus(); return; }
  if (!name) { toast('Contact name is required', 'error'); $('#ctm-name')?.focus(); return; }
  const isPrimary = $('#ctm-primary').checked;
  // Confirm primary change if setting as primary on an existing company
  if (isPrimary) {
    const companyName = $('#ctm-company-picked span')?.textContent || 'this company';
    if (!confirm(`Are you sure you want to make this the primary contact for ${companyName}? Any existing primary contact will be replaced.`)) {
      return;
    }
  }
  const allPhones = $$('.ctm-phone-input').map(el => el.value.trim()).filter(Boolean);
  const allEmails = $$('.ctm-email-input').map(el => el.value.trim()).filter(Boolean);
  const body = {
    company_id,
    name,
    title: $('#ctm-title').value.trim() || null,
    phone: allPhones[0] || null,
    email: allEmails[0] || null,
    phones: allPhones.slice(1),
    emails: allEmails.slice(1),
    linkedin: $('#ctm-linkedin').value.trim() || null,
    is_primary: isPrimary,
    notes: $('#ctm-notes').value.trim() || null,
  };
  try {
    let res;
    if (state.editingContactId) {
      res = await fetch(`/api/contacts/${state.editingContactId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Failed to save contact', 'error'); return; }
    toast(state.editingContactId ? 'Contact updated' : 'Contact added', 'ok');
    closeContactModal();
    loadAllContacts();
    // Refresh open detail panel if it matches
    if (state.activeId === company_id) openDetail(state.activeId);
  } catch (err) {
    console.error(err);
    toast('Failed to save contact', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact Enrichment Runner
// ─────────────────────────────────────────────────────────────────────────────
async function startEnrichment() {
  if (!confirm('Run contact enrichment on all 282 companies? This will take a while (2-3 hours).')) return;
  try {
    const res = await fetch('/api/enrich/start', { method: 'POST', headers: { 'content-type': 'application/json' } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Failed to start', 'error');
      return;
    }
    toast('Contact enrichment started', 'ok');
    $('#enrich-start-btn').hidden = true;
    $('#enrich-stop-btn').hidden = false;
    $('#enrich-status').hidden = false;
    pollEnrichStatus();
  } catch { toast('Failed to start enrichment', 'error'); }
}

async function stopEnrichment() {
  await fetch('/api/enrich/stop', { method: 'POST' });
  toast('Stopping after current company', 'info');
}

let _enrichPoll = null;
function pollEnrichStatus() {
  clearInterval(_enrichPoll);
  _enrichPoll = setInterval(async () => {
    try {
      const res = await fetch('/api/enrich/status');
      if (!res.ok) return;
      const d = await res.json();
      const pct = d.total ? Math.round((d.current / d.total) * 100) : 0;
      $('#enrich-fill').style.width = `${pct}%`;
      $('#enrich-text').textContent = d.running
        ? `${d.current} / ${d.total} — ${d.currentCompany} (${d.success} ok, ${d.failed} failed)`
        : `Done. ${d.success} enriched, ${d.failed} failed out of ${d.total}.`;
      if (!d.running) {
        clearInterval(_enrichPoll);
        $('#enrich-start-btn').hidden = false;
        $('#enrich-stop-btn').hidden = true;
      }
    } catch {}
  }, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Log
// ─────────────────────────────────────────────────────────────────────────────
const ACTLOG_ICONS = {
  note: '&#9998;', call: '&#9743;', email: '&#9993;', meeting: '&#9632;',
  stage_change: '&#9654;', research: '&#9670;', crm_action: '&#9881;', sms: '&#128172;',
};

let actlogOffset = 0;

// ---------- Inbox (missed calls & voicemails) ----------
let inboxCalls = [];
let inboxFilter = 'all';

async function loadInbox() {
  try {
    const res = await fetch('/api/calls/missed');
    if (!res.ok) return;
    const data = await res.json();
    inboxCalls = data.calls || [];
    renderInbox();
  } catch {}
}

function renderInbox() {
  const list = $('#inbox-list');
  if (!list) return;
  const filtered = inboxFilter === 'all' ? inboxCalls
    : inboxFilter === 'voicemail' ? inboxCalls.filter(c => c.voicemail_url)
    : inboxCalls.filter(c => !c.voicemail_url);
  if (!filtered.length) {
    list.innerHTML = '<div class="inbox-empty">No missed calls or voicemails.</div>';
    return;
  }
  list.innerHTML = filtered.map(c => {
    const name = c.contact_name || c.company_name || c.from_number || 'Unknown';
    const detail = c.company_name && c.contact_name ? c.company_name : '';
    const location = [c.company_city, c.company_state].filter(Boolean).join(', ');
    const time = c.called_at ? new Date(c.called_at).toLocaleString() : '';
    const hasVm = !!c.voicemail_url;
    const badge = hasVm
      ? '<span class="inbox-badge vm">Voicemail</span>'
      : '<span class="inbox-badge missed">Missed</span>';
    const vmTranscript = hasVm && c.transcript
      ? `<div class="inbox-transcript">${escapeHtml(c.transcript)}</div>`
      : hasVm ? `<div class="inbox-transcript dim">Transcribing...</div>` : '';
    const vmPlayer = hasVm
      ? `<audio controls preload="none" class="inbox-audio" src="${escapeHtml(c.voicemail_url)}.mp3"></audio>`
      : '';
    const callbackBtn = c.from_number
      ? `<button type="button" class="btn-ghost btn-xs inbox-callback" data-number="${escapeHtml(c.from_number)}" data-company="${escapeHtml(c.company_id || '')}">Call back</button>`
      : '';
    const isUnmatched = !c.company_id && !c.contact_name;
    const unmatchedActions = isUnmatched ? `
      <button type="button" class="btn-ghost btn-xs inbox-add-contact" data-call-id="${escapeHtml(c.id)}" data-number="${escapeHtml(c.from_number || '')}">Add contact</button>
      <button type="button" class="btn-ghost btn-xs inbox-dismiss" data-call-id="${escapeHtml(c.id)}">Dismiss</button>
    ` : '';
    return `
      <div class="inbox-item" id="inbox-item-${escapeHtml(c.id)}">
        <div class="inbox-item-left">
          <div class="inbox-item-name">${escapeHtml(name)} ${badge}</div>
          <div class="inbox-item-detail">${escapeHtml([detail, location].filter(Boolean).join(' · '))}</div>
          <div class="inbox-item-time">${escapeHtml(time)}</div>
          ${vmTranscript}
          ${vmPlayer}
        </div>
        <div class="inbox-item-actions">
          ${callbackBtn}
          ${unmatchedActions}
        </div>
      </div>`;
  }).join('');
  // Bind add contact buttons
  $$('.inbox-add-contact', list).forEach(btn => {
    btn.addEventListener('click', () => inboxAddContact(btn.dataset.callId, btn.dataset.number));
  });
  // Bind dismiss buttons
  $$('.inbox-dismiss', list).forEach(btn => {
    btn.addEventListener('click', () => inboxDismiss(btn.dataset.callId));
  });
}

async function inboxAddContact(callId, phoneNumber) {
  const companyName = prompt('Link to company — type company name to search:');
  if (!companyName || !companyName.trim()) return;
  try {
    // Search for matching company
    const res = await fetch(`/api/companies?search=${encodeURIComponent(companyName.trim())}`);
    if (!res.ok) { toast('Search failed', 'error'); return; }
    const data = await res.json();
    const matches = (data.companies || []).slice(0, 5);
    if (!matches.length) {
      toast('No companies found matching "' + companyName.trim() + '"', 'error');
      return;
    }
    // Let user pick from matches
    const options = matches.map((c, i) => `${i + 1}. ${c.name} (${c.city || ''}, ${c.state || ''})`).join('\n');
    const pick = prompt(`Found ${matches.length} match(es):\n\n${options}\n\nEnter number to select (or cancel):`);
    if (!pick) return;
    const idx = parseInt(pick) - 1;
    if (idx < 0 || idx >= matches.length) { toast('Invalid selection', 'error'); return; }
    const company = matches[idx];

    // Ask for contact name
    const contactName = prompt(`Contact name for ${company.name}:`);
    if (!contactName || !contactName.trim()) return;

    // Create contact on that company
    const cRes = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: company.id, name: contactName.trim(), phone: phoneNumber }),
    });
    if (!cRes.ok) { toast('Failed to create contact', 'error'); return; }
    const cData = await cRes.json();

    // Link the call log to this company + contact
    await fetch(`/api/calls/${callId}/link`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_id: company.id, contact_id: cData.contact?.id }),
    });
    toast(`Linked to ${company.name} — contact "${contactName.trim()}" added`, 'ok');
    loadInbox();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function inboxDismiss(callId) {
  try {
    await fetch(`/api/calls/${callId}/dismiss`, { method: 'PUT' });
    const el = $(`#inbox-item-${callId}`);
    if (el) el.remove();
    inboxCalls = inboxCalls.filter(c => c.id !== callId);
    if (!inboxCalls.length) {
      $('#inbox-list').innerHTML = '<div class="inbox-empty">No missed calls or voicemails.</div>';
    }
  } catch {}
}

// ---------- Activity Log ----------
async function loadActivityLog(append = false) {
  if (!append) actlogOffset = 0;
  try {
    const res = await fetch(`/api/activity-log?limit=50&offset=${actlogOffset}`);
    if (!res.ok) return;
    const { activities } = await res.json();
    const host = $('#actlog-list');
    if (!host) return;
    if (!append) host.innerHTML = '';
    if (!activities.length && !append) {
      host.innerHTML = '<div class="empty-msg">No activity yet.</div>';
      $('#actlog-load-more').hidden = true;
      return;
    }
    host.innerHTML += activities.map((a) => {
      const icon = ACTLOG_ICONS[a.type] || '&#9679;';
      const when = a.created_at ? new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const user = a.user_name || '';
      const company = a.company_name || '';
      return `
      <div class="actlog-row">
        <span class="actlog-icon">${icon}</span>
        <div class="actlog-body">
          <div class="actlog-summary">${escapeHtml(a.summary)}</div>
          <div class="actlog-meta">
            ${company ? `<span class="actlog-company">${escapeHtml(company)}</span>` : ''}
            ${user ? `<span class="actlog-user">${escapeHtml(user)}</span>` : ''}
            <span class="actlog-when">${when}</span>
          </div>
          ${a.details ? `<div class="actlog-details">${escapeHtml(a.details)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    actlogOffset += activities.length;
    const btn = $('#actlog-load-more');
    if (btn) btn.hidden = activities.length < 50;
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Recently Deleted
// ─────────────────────────────────────────────────────────────────────────────
async function loadDeletedItems() {
  try {
    const res = await fetch('/api/deleted');
    if (!res.ok) return;
    const { companies, contacts } = await res.json();
    renderDeletedCompanies(companies || []);
    renderDeletedContacts(contacts || []);
  } catch {}
}

function renderDeletedCompanies(companies) {
  const host = $('#deleted-companies-list');
  if (!host) return;
  if (!companies.length) {
    host.innerHTML = '<div class="empty-msg">No deleted companies.</div>';
    return;
  }
  host.innerHTML = companies.map((c) => {
    const when = c.deleted_at ? new Date(c.deleted_at).toLocaleDateString() : '';
    const loc = [c.city, c.state].filter(Boolean).join(', ');
    return `
    <div class="del-row">
      <div class="del-info">
        <div class="del-name">${escapeHtml(c.name)}</div>
        <div class="del-meta">${escapeHtml(loc)}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}${c.score ? ' · ' + Number(c.score).toFixed(1) : ''} · Deleted ${when}</div>
      </div>
      <button type="button" class="btn-primary btn-xs del-restore" data-type="company" data-id="${c.id}">Restore</button>
    </div>`;
  }).join('');
  bindDeletedRestoreButtons(host);
}

function renderDeletedContacts(contacts) {
  const host = $('#deleted-contacts-list');
  if (!host) return;
  if (!contacts.length) {
    host.innerHTML = '<div class="empty-msg">No deleted contacts.</div>';
    return;
  }
  host.innerHTML = contacts.map((c) => {
    const when = c.deleted_at ? new Date(c.deleted_at).toLocaleDateString() : '';
    return `
    <div class="del-row">
      <div class="del-info">
        <div class="del-name">${escapeHtml(c.name)}${c.title ? ' — ' + escapeHtml(c.title) : ''}</div>
        <div class="del-meta">${escapeHtml(c.company_name || 'No company')}${c.phone ? ' · ' + escapeHtml(c.phone) : ''} · Deleted ${when}</div>
      </div>
      <button type="button" class="btn-primary btn-xs del-restore" data-type="contact" data-id="${c.id}">Restore</button>
    </div>`;
  }).join('');
  bindDeletedRestoreButtons(host);
}

function bindDeletedRestoreButtons(host) {
  $$('.del-restore', host).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      try {
        const res = await fetch(`/api/${type === 'company' ? 'companies' : 'contacts'}/${id}/restore`, { method: 'POST' });
        if (res.ok) {
          toast(`${type === 'company' ? 'Company' : 'Contact'} restored`, 'ok');
          loadDeletedItems();
          loadCompanies();
          if ($('#tab-contacts')?.classList.contains('active')) loadAllContacts();
        } else {
          toast('Restore failed', 'error');
        }
      } catch { toast('Restore failed', 'error'); }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns
// ─────────────────────────────────────────────────────────────────────────────
const campState = {
  campaigns: [],
  activeCampaignId: null,
  campaign: null,
  recipients: [],
  searchResults: [],
  previewData: [],
  previewIdx: 0,
  searchDebounce: null,
};

async function loadCampaignsList() {
  try {
    const res = await fetch('/api/campaigns');
    if (!res.ok) return;
    const { campaigns } = await res.json();
    campState.campaigns = campaigns;
    renderCampaignsList();
  } catch {}
}

function renderCampaignsList() {
  const host = $('#camp-list');
  if (!host) return;
  if (!campState.campaigns.length) {
    host.innerHTML = '<div class="empty-msg">No campaigns yet. Create one to get started.</div>';
    return;
  }
  host.innerHTML = campState.campaigns.map((c) => {
    const date = c.created_at ? new Date(c.created_at).toLocaleDateString() : '';
    return `
    <div class="camp-card" data-id="${c.id}">
      <div class="camp-card-name">${escapeHtml(c.name)}</div>
      <div class="camp-card-meta">${c.recipient_count || 0} recipients${date ? ' &middot; ' + date : ''}</div>
      <span class="camp-card-status ${c.status || 'draft'}">${c.status || 'draft'}</span>
    </div>`;
  }).join('');
  $$('.camp-card', host).forEach((el) => {
    el.addEventListener('click', () => openCampaignEditor(el.dataset.id));
  });
}

async function createNewCampaign() {
  try {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled Campaign' }),
    });
    if (!res.ok) { toast('Failed to create campaign', 'error'); return; }
    const { id } = await res.json();
    await loadCampaignsList();
    openCampaignEditor(id);
  } catch { toast('Failed to create campaign', 'error'); }
}

async function openCampaignEditor(id) {
  campState.activeCampaignId = id;
  try {
    const res = await fetch(`/api/campaigns/${id}`);
    if (!res.ok) { toast('Campaign not found', 'error'); return; }
    const data = await res.json();
    campState.campaign = data.campaign;
    campState.recipients = data.recipients;
  } catch { toast('Failed to load campaign', 'error'); return; }

  $('#camp-list-view').hidden = true;
  $('#camp-editor-view').hidden = false;
  $('#camp-name').value = campState.campaign.name || '';
  $('#camp-subject').value = campState.campaign.subject_template || '';
  if ($('#camp-ai-prompt')) $('#camp-ai-prompt').value = campState.campaign.ai_prompt || '';
  const pill = $('#camp-status-pill');
  pill.textContent = campState.campaign.status || 'draft';
  pill.className = 'camp-status-pill ' + (campState.campaign.status || 'draft');

  renderCampaignRecipients();
  populateCampStateFilter();
  campSearchCompanies();
}

function closeCampaignEditor() {
  $('#camp-list-view').hidden = false;
  $('#camp-editor-view').hidden = true;
  campState.activeCampaignId = null;
  campState.campaign = null;
  campState.recipients = [];
  loadCampaignsList();
}

async function generateCampaignEmails() {
  if (!campState.activeCampaignId) return;
  const prompt = $('#camp-ai-prompt')?.value?.trim();
  if (!prompt) { toast('Enter an AI direction first', 'error'); return; }
  if (!campState.recipients.length) { toast('Add recipients first', 'error'); return; }

  // Save draft first so ai_prompt is persisted
  await saveCampaignDraft();

  const btn = $('#camp-generate-btn');
  const status = $('#camp-generate-status');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  status.hidden = false;
  status.textContent = `Generating ${campState.recipients.length} personalized emails — this may take a minute...`;

  try {
    const res = await fetch(`/api/campaigns/${campState.activeCampaignId}/generate`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Generation failed', 'error'); return; }
    toast(`Generated ${data.generated}/${data.total} emails`, data.generated > 0 ? 'ok' : 'error');
    status.textContent = `Done — ${data.generated}/${data.total} emails generated.${data.lastError ? ' Error: ' + data.lastError : ' Click Preview to review.'}`;
  } catch (e) {
    toast('Generation failed: ' + e.message, 'error');
    status.textContent = 'Generation failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Emails';
  }
}

async function saveCampaignDraft() {
  if (!campState.activeCampaignId) return;
  const name = $('#camp-name').value.trim();
  if (!name) { toast('Name required', 'error'); return; }
  try {
    await fetch(`/api/campaigns/${campState.activeCampaignId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        subject_template: $('#camp-subject').value,
        ai_prompt: $('#camp-ai-prompt')?.value || '',
      }),
    });
    toast('Campaign saved', 'ok');
  } catch { toast('Save failed', 'error'); }
}

async function deleteCampaignAction() {
  if (!campState.activeCampaignId) return;
  if (!confirm('Delete this campaign?')) return;
  try {
    await fetch(`/api/campaigns/${campState.activeCampaignId}`, { method: 'DELETE' });
    toast('Campaign deleted', 'ok');
    closeCampaignEditor();
  } catch { toast('Delete failed', 'error'); }
}

function renderCampaignRecipients() {
  const list = $('#camp-selected-list');
  const count = $('#camp-selected-count');
  const rcount = $('#camp-recip-count');
  if (count) count.textContent = campState.recipients.length;
  if (rcount) rcount.textContent = campState.recipients.length;
  if (!list) return;
  if (!campState.recipients.length) {
    list.innerHTML = '<div class="empty-msg" style="font-size:0.82rem">No companies selected yet.</div>';
    return;
  }
  list.innerHTML = campState.recipients.map((r) => `
    <span class="camp-selected-chip" data-company-id="${r.company_id}">
      ${escapeHtml(r.company_name)}
      <span class="camp-chip-x" title="Remove">&times;</span>
    </span>
  `).join('');
  $$('.camp-chip-x', list).forEach((x) => {
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      const companyId = x.closest('.camp-selected-chip').dataset.companyId;
      await removeCampaignRecipientAction(companyId);
    });
  });
  // Also refresh checkboxes in search results
  refreshCampCheckboxes();
}

async function removeCampaignRecipientAction(companyId) {
  if (!campState.activeCampaignId) return;
  try {
    await fetch(`/api/campaigns/${campState.activeCampaignId}/recipients/${companyId}`, { method: 'DELETE' });
    campState.recipients = campState.recipients.filter((r) => r.company_id !== companyId);
    renderCampaignRecipients();
  } catch {}
}

async function populateCampStateDropdown() {
  const container = $('#camp-state-options');
  if (!container) return;
  let states = [...new Set((state.companies || []).map(c => c.state).filter(Boolean))].sort();
  if (!states.length) {
    try {
      const res = await fetch('/api/companies?sort=state_asc');
      if (res.ok) {
        const data = await res.json();
        states = [...new Set((data.companies || []).map(c => c.state).filter(Boolean))].sort();
      }
    } catch {}
  }
  container.innerHTML = states.map(s =>
    `<label class="camp-dropdown-item"><input type="checkbox" value="${escapeHtml(s)}" data-group="state" /> ${escapeHtml(s)}</label>`
  ).join('');
}

function getCampDropdownValues(group) {
  return $$(`input[data-group="${group}"]:checked:not(.camp-select-all)`).map(cb => cb.value);
}

function updateCampDropdownLabel(group) {
  const selected = getCampDropdownValues(group);
  const btn = group === 'state' ? $('#camp-state-btn') : $('#camp-industry-btn');
  if (!btn) return;
  const allLabel = group === 'state' ? 'All States' : 'All Industries';
  if (selected.length === 0) btn.textContent = allLabel;
  else if (selected.length <= 3) btn.textContent = selected.join(', ');
  else btn.textContent = `${selected.length} selected`;
}

async function campSearchCompanies() {
  const q = $('#camp-search')?.value || '';
  const states = getCampDropdownValues('state');
  const industries = getCampDropdownValues('industry');
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (states.length) params.set('state', states.join(','));
  if (industries.length) params.set('industry', industries.join(','));
  if (campState.activeCampaignId) params.set('exclude_campaign', campState.activeCampaignId);
  try {
    const res = await fetch(`/api/campaigns/search/companies?${params}`);
    if (!res.ok) return;
    const { companies } = await res.json();
    campState.searchResults = companies;
    renderCampSearchResults();
  } catch {}
}

function renderCampSearchResults() {
  const host = $('#camp-company-list');
  if (!host) return;
  const recipIds = new Set(campState.recipients.map((r) => r.company_id));
  if (!campState.searchResults.length) {
    host.innerHTML = '<div class="empty-msg" style="padding:12px">No companies found.</div>';
    return;
  }
  host.innerHTML = campState.searchResults.map((c) => {
    const checked = recipIds.has(c.id);
    const meta = [c.city, c.state].filter(Boolean).join(', ');
    return `
    <label class="camp-company-row${checked ? ' checked' : ''}" data-id="${c.id}">
      <input type="checkbox" ${checked ? 'checked' : ''} />
      <div class="camp-company-name">${escapeHtml(c.name)}</div>
      ${c.owner ? `<div class="camp-company-meta">${escapeHtml(c.owner)}</div>` : ''}
      ${meta ? `<div class="camp-company-meta">${escapeHtml(meta)}</div>` : ''}
      ${c.score != null ? `<div class="camp-company-score">${Number(c.score).toFixed(1)}</div>` : ''}
    </label>`;
  }).join('');
  $$('.camp-company-row input[type="checkbox"]', host).forEach((cb) => {
    cb.addEventListener('change', async () => {
      const row = cb.closest('.camp-company-row');
      const companyId = row.dataset.id;
      if (cb.checked) {
        await addCampaignRecipientAction([companyId]);
        row.classList.add('checked');
      } else {
        await removeCampaignRecipientAction(companyId);
        row.classList.remove('checked');
      }
    });
  });
}

function refreshCampCheckboxes() {
  const recipIds = new Set(campState.recipients.map((r) => r.company_id));
  $$('.camp-company-row', $('#camp-company-list')).forEach((row) => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb) return;
    const checked = recipIds.has(row.dataset.id);
    cb.checked = checked;
    row.classList.toggle('checked', checked);
  });
}

async function addCampaignRecipientAction(companyIds) {
  if (!campState.activeCampaignId) return;
  try {
    await fetch(`/api/campaigns/${campState.activeCampaignId}/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_ids: companyIds }),
    });
    // Reload recipients
    const res = await fetch(`/api/campaigns/${campState.activeCampaignId}`);
    if (res.ok) {
      const data = await res.json();
      campState.recipients = data.recipients;
      renderCampaignRecipients();
    }
  } catch {}
}

function populateCampStateFilter() {
  const sel = $('#camp-state-filter');
  if (!sel) return;
  const current = sel.value;
  // Get unique states from existing companies data
  const states = [...new Set(state.companies.map((c) => c.state).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All states</option>' +
    states.map((s) => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`).join('');
}

// Merge field click-to-insert
function bindMergeFieldClicks() {
  $$('.camp-merge-hint code').forEach((el) => {
    el.addEventListener('click', () => {
      const field = el.textContent;
      // Insert into whichever field was last focused, default to body
      const body = $('#camp-body');
      const subj = $('#camp-subject');
      const target = document.activeElement === subj ? subj : body;
      const pos = target.selectionStart ?? target.value.length;
      const before = target.value.slice(0, pos);
      const after = target.value.slice(target.selectionEnd ?? pos);
      target.value = before + field + after;
      target.setSelectionRange(pos + field.length, pos + field.length);
      target.focus();
    });
  });
}

// Preview
async function openCampaignPreview() {
  await saveCampaignDraft();
  if (!campState.recipients.length) {
    toast('Add recipients first', 'error');
    return;
  }
  try {
    const res = await fetch(`/api/campaigns/${campState.activeCampaignId}/preview`);
    if (!res.ok) { toast('Preview failed', 'error'); return; }
    const { merged } = await res.json();
    campState.previewData = merged;
    campState.previewIdx = 0;
    renderCampaignPreview();
    $('#camp-preview-modal').hidden = false;
  } catch { toast('Preview failed', 'error'); }
}

function renderCampaignPreview() {
  const d = campState.previewData[campState.previewIdx];
  if (!d) return;
  const total = campState.previewData.length;
  $('#camp-preview-counter').textContent = `${campState.previewIdx + 1} / ${total}`;
  $('#camp-preview-to').textContent = `To: ${d.to_email || '(no email)'} — ${d.company_name}`;
  $('#camp-preview-subject').textContent = `Subject: ${d.subject}`;
  $('#camp-preview-body').innerHTML = d.body;
}

function campPreviewNav(dir) {
  campState.previewIdx = Math.max(0, Math.min(campState.previewData.length - 1, campState.previewIdx + dir));
  renderCampaignPreview();
}

function initCampaignBindings() {
  $('#camp-new-btn')?.addEventListener('click', createNewCampaign);
  $('#camp-back-btn')?.addEventListener('click', closeCampaignEditor);
  $('#camp-save-btn')?.addEventListener('click', saveCampaignDraft);
  $('#camp-delete-btn')?.addEventListener('click', deleteCampaignAction);
  $('#camp-preview-btn')?.addEventListener('click', openCampaignPreview);
  $('#camp-generate-btn')?.addEventListener('click', generateCampaignEmails);
  $('#camp-close-preview')?.addEventListener('click', () => { $('#camp-preview-modal').hidden = true; });
  $('#camp-prev-preview')?.addEventListener('click', () => campPreviewNav(-1));
  $('#camp-next-preview')?.addEventListener('click', () => campPreviewNav(1));

  // Search with debounce
  const searchHandler = () => {
    clearTimeout(campState.searchDebounce);
    campState.searchDebounce = setTimeout(campSearchCompanies, 300);
  };
  $('#camp-search')?.addEventListener('input', searchHandler);
  // Dropdown toggle
  $$('.camp-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const wasHidden = menu.hidden;
      $$('.camp-dropdown-menu').forEach(m => m.hidden = true);
      menu.hidden = !wasHidden;
    });
  });
  document.addEventListener('click', () => {
    $$('.camp-dropdown-menu').forEach(m => m.hidden = true);
  });
  $$('.camp-dropdown-menu').forEach(menu => {
    menu.addEventListener('click', e => e.stopPropagation());
  });
  // Select-all checkboxes
  $$('.camp-select-all').forEach(sa => {
    sa.addEventListener('change', () => {
      const group = sa.dataset.group;
      $$(`input[data-group="${group}"]:not(.camp-select-all)`).forEach(cb => cb.checked = sa.checked);
      updateCampDropdownLabel(group);
      campSearchCompanies();
    });
  });
  // Delegate change events for individual checkboxes
  document.addEventListener('change', (e) => {
    if (e.target.dataset?.group && !e.target.classList.contains('camp-select-all')) {
      const group = e.target.dataset.group;
      const all = $$(`input[data-group="${group}"]:not(.camp-select-all)`);
      const allChecked = all.every(cb => cb.checked);
      const sa = $(`.camp-select-all[data-group="${group}"]`);
      if (sa) sa.checked = allChecked;
      updateCampDropdownLabel(group);
      campSearchCompanies();
    }
  });
  // Populate state dropdown dynamically
  populateCampStateDropdown();

  bindMergeFieldClicks();
}

// ---------- Global search ----------
let _gsDebounce = null;
function initGlobalSearch() {
  const input = $('#global-search');
  const results = $('#global-search-results');
  if (!input || !results) return;
  input.addEventListener('input', () => {
    clearTimeout(_gsDebounce);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    _gsDebounce = setTimeout(() => globalSearch(q), 250);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) globalSearch(input.value.trim());
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.global-search-wrap')) results.hidden = true;
  });
}

async function globalSearch(q) {
  const results = $('#global-search-results');
  try {
    const [compRes, ctRes] = await Promise.all([
      fetch(`/api/companies?search=${encodeURIComponent(q)}&sort=score_desc`),
      fetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=5`),
    ]);
    const companies = compRes.ok ? (await compRes.json()).companies?.slice(0, 5) || [] : [];
    const contacts = ctRes.ok ? (await ctRes.json()).contacts?.slice(0, 5) || [] : [];
    if (!companies.length && !contacts.length) {
      results.innerHTML = '<div class="gs-empty">No results found.</div>';
      results.hidden = false;
      return;
    }
    let html = '';
    if (companies.length) {
      html += '<div class="gs-section-label">Companies</div>';
      html += companies.map(c => {
        const loc = [c.city, c.state].filter(Boolean).join(', ');
        return `<div class="gs-item" data-type="company" data-id="${c.id}">
          <div><div class="gs-item-name">${escapeHtml(c.name)}</div><div class="gs-item-sub">${escapeHtml(loc)}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div></div>
          <div class="gs-item-right">${c.score ? `<div class="gs-item-score">${Number(c.score).toFixed(1)}</div>` : ''}<div class="gs-item-meta">${escapeHtml(c.tier || '')}</div></div>
        </div>`;
      }).join('');
    }
    if (contacts.length) {
      html += '<div class="gs-section-label">Contacts</div>';
      html += contacts.map(c => `<div class="gs-item" data-type="contact" data-company-id="${c.company_id || ''}">
        <div><div class="gs-item-name">${escapeHtml(c.name)}</div><div class="gs-item-sub">${escapeHtml(c.title || '')}${c.company_name ? ' · ' + escapeHtml(c.company_name) : ''}</div></div>
        <div class="gs-item-right"><div class="gs-item-meta">${escapeHtml(c.phone || c.email || '')}</div></div>
      </div>`).join('');
    }
    results.innerHTML = html;
    results.hidden = false;
    $$('.gs-item', results).forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.type;
        const id = type === 'company' ? item.dataset.id : item.dataset.companyId;
        if (id) {
          const companiesTab = document.querySelector('.tab[data-tab="companies"]');
          if (companiesTab) companiesTab.click();
          setTimeout(() => openDetail(id), 50);
        }
        results.hidden = true;
        input.value = '';
      });
    });
  } catch { results.hidden = true; }
}

// ============================================================================
// Mandates (Buy-Side Mandate Management)
// ============================================================================

const mandateState = {
  mandates: [],
  activeMandateId: null,
  activeMandateData: null,
  activeCompanies: [],
  progressReports: [],
  searchDebounce: null,
  geoTags: [],
  vertTags: [],
  editingId: null,
  queueMandateCompanyIds: null,
};

function fmtDollars(n) {
  if (n == null || isNaN(Number(n))) return '';
  return '$' + Number(n).toLocaleString();
}

function fmtTalkTime(seconds) {
  const s = Number(seconds) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
}

// ---------- Load & render mandates ----------

async function loadMandates() {
  try {
    const res = await fetch('/api/mandates');
    if (!res.ok) return;
    const data = await res.json();
    mandateState.mandates = data.mandates || [];
    renderMandateList();
    populatePRMandateSelect();
  } catch (e) { console.error('[mandates]', e); }
}

function renderMandateList() {
  const host = $('#mandate-list');
  if (!host) return;
  const detail = $('#mandate-detail');
  if (detail) detail.hidden = true;

  if (!mandateState.mandates.length) {
    host.innerHTML = '<div class="empty-msg">No active mandates. Create one to get started.</div>';
    return;
  }
  host.innerHTML = mandateState.mandates.map(m => {
    const geos = (typeof m.target_geographies === 'string' ? JSON.parse(m.target_geographies || '[]') : m.target_geographies || []);
    const verts = (typeof m.target_verticals === 'string' ? JSON.parse(m.target_verticals || '[]') : m.target_verticals || []);
    const tags = [...geos, ...verts].slice(0, 6).map(t => `<span class="mandate-tag">${escapeHtml(t)}</span>`).join('');
    const revRange = m.revenue_min || m.revenue_max
      ? `${m.revenue_min ? fmtDollars(m.revenue_min) : '?'} - ${m.revenue_max ? fmtDollars(m.revenue_max) : '?'} rev`
      : '';
    return `<div class="mandate-card" data-mandate-id="${m.id}">
      <div class="mandate-card-name">${escapeHtml(m.buyer_name)}</div>
      <div class="mandate-card-meta">${escapeHtml(revRange)}${m.reporting_frequency ? ' · ' + escapeHtml(m.reporting_frequency) : ''}</div>
      ${tags ? `<div class="mandate-card-tags">${tags}</div>` : ''}
      <div class="mandate-card-stats">
        <div class="mandate-card-stat"><strong>${m.company_count || 0}</strong> companies</div>
      </div>
    </div>`;
  }).join('');

  $$('.mandate-card', host).forEach(card => {
    card.addEventListener('click', () => openMandateDetail(card.dataset.mandateId));
  });
}

// ---------- Mandate detail ----------

async function openMandateDetail(id) {
  try {
    const res = await fetch(`/api/mandates/${id}`);
    if (!res.ok) return toast('Mandate not found', 'error');
    const data = await res.json();
    mandateState.activeMandateId = id;
    mandateState.activeMandateData = data.mandate;
    mandateState.activeCompanies = data.companies || [];
    renderMandateDetail();
  } catch (e) { toast('Failed to load mandate', 'error'); }
}

function renderMandateDetail() {
  const m = mandateState.activeMandateData;
  if (!m) return;
  $('#mandate-list').innerHTML = '';
  const detail = $('#mandate-detail');
  detail.hidden = false;

  $('#mandate-detail-name').textContent = m.buyer_name;
  $('#mandate-detail-status').textContent = m.status || 'active';

  const geos = (typeof m.target_geographies === 'string' ? JSON.parse(m.target_geographies || '[]') : m.target_geographies || []);
  const verts = (typeof m.target_verticals === 'string' ? JSON.parse(m.target_verticals || '[]') : m.target_verticals || []);
  const metaParts = [];
  if (m.revenue_min || m.revenue_max) metaParts.push(`<span>Revenue: <strong>${m.revenue_min ? fmtDollars(m.revenue_min) : '?'} - ${m.revenue_max ? fmtDollars(m.revenue_max) : '?'}</strong></span>`);
  if (m.ebitda_min || m.ebitda_max) metaParts.push(`<span>EBITDA: <strong>${m.ebitda_min ? fmtDollars(m.ebitda_min) : '?'} - ${m.ebitda_max ? fmtDollars(m.ebitda_max) : '?'}</strong></span>`);
  if (geos.length) metaParts.push(`<span>Geos: <strong>${geos.join(', ')}</strong></span>`);
  if (verts.length) metaParts.push(`<span>Industries: <strong>${verts.join(', ')}</strong></span>`);
  metaParts.push(`<span>Reporting: <strong>${m.reporting_frequency || 'biweekly'}</strong></span>`);
  $('#mandate-detail-meta').innerHTML = metaParts.join('');

  renderMandatePipelineTable();
}

function renderMandatePipelineTable() {
  const tbody = $('#mandate-pipeline-tbody');
  if (!tbody) return;
  const companies = mandateState.activeCompanies;
  if (!companies.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:20px">No companies in this mandate yet. Use the search above to add some.</td></tr>';
    return;
  }
  const stages = ['Execution', 'Introduction', 'Engage', 'Qualify'];
  let html = '';
  for (const stage of stages) {
    const stageCompanies = companies.filter(c => c.deal_stage === stage);
    if (!stageCompanies.length) continue;
    html += `<tr class="stage-header stage-header-${stage}"><td colspan="9">${escapeHtml(stage)} (${stageCompanies.length})</td></tr>`;
    for (const c of stageCompanies) {
      const loc = [c.city, c.state].filter(Boolean).join(', ');
      html += `<tr data-company-id="${c.company_id}">
        <td><strong style="cursor:pointer" onclick="openDetail('${c.company_id}')">${escapeHtml(c.company_name)}</strong></td>
        <td>${escapeHtml(loc)}</td>
        <td>${c.score != null ? Number(c.score).toFixed(1) : ''}</td>
        <td>
          <select class="mandate-stage-select" data-field="deal_stage" data-company-id="${c.company_id}">
            ${stages.map(s => `<option value="${s}" ${s === c.deal_stage ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </td>
        <td><input type="checkbox" class="mandate-check" data-field="nda_sent" data-company-id="${c.company_id}" ${c.nda_sent ? 'checked' : ''} title="NDA Sent" />
            <input type="checkbox" class="mandate-check" data-field="nda_signed" data-company-id="${c.company_id}" ${c.nda_signed ? 'checked' : ''} title="NDA Signed" /></td>
        <td><input type="checkbox" class="mandate-check" data-field="offer_sent" data-company-id="${c.company_id}" ${c.offer_sent ? 'checked' : ''} title="Offer Sent" />
            <input type="checkbox" class="mandate-check" data-field="offer_signed" data-company-id="${c.company_id}" ${c.offer_signed ? 'checked' : ''} title="Offer Signed" /></td>
        <td><input type="text" class="mandate-tev-input" data-field="offer_tev" data-company-id="${c.company_id}" value="${c.offer_tev ? Number(c.offer_tev).toLocaleString() : ''}" placeholder="$" /></td>
        <td><input type="text" class="mandate-next-input" data-field="next_step" data-company-id="${c.company_id}" value="${escapeHtml(c.next_step || '')}" placeholder="Next step..." /></td>
        <td><button class="mandate-remove-btn" data-company-id="${c.company_id}" title="Remove">&times;</button></td>
      </tr>`;
    }
  }
  tbody.innerHTML = html;

  // Bind inline edit handlers
  $$('.mandate-stage-select', tbody).forEach(sel => {
    sel.addEventListener('change', () => updateMandateCompany(sel.dataset.companyId, { deal_stage: sel.value }));
  });
  $$('.mandate-check', tbody).forEach(chk => {
    chk.addEventListener('change', () => updateMandateCompany(chk.dataset.companyId, { [chk.dataset.field]: chk.checked }));
  });
  $$('.mandate-tev-input', tbody).forEach(inp => {
    inp.addEventListener('change', () => {
      const val = inp.value.replace(/[^0-9]/g, '');
      updateMandateCompany(inp.dataset.companyId, { offer_tev: val ? Number(val) : null });
    });
  });
  $$('.mandate-next-input', tbody).forEach(inp => {
    inp.addEventListener('change', () => updateMandateCompany(inp.dataset.companyId, { next_step: inp.value }));
  });
  $$('.mandate-remove-btn', tbody).forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this company from the mandate?')) return;
      await fetch(`/api/mandates/${mandateState.activeMandateId}/companies/${btn.dataset.companyId}`, { method: 'DELETE' });
      openMandateDetail(mandateState.activeMandateId);
    });
  });
}

async function updateMandateCompany(companyId, updates) {
  try {
    await fetch(`/api/mandates/${mandateState.activeMandateId}/companies/${companyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    // If stage changed, reload to re-sort
    if (updates.deal_stage) openMandateDetail(mandateState.activeMandateId);
  } catch (e) { toast('Update failed', 'error'); }
}

// ---------- Create / Edit mandate modal ----------

function openMandateModal(mandate) {
  mandateState.editingId = mandate?.id || null;
  mandateState.geoTags = mandate ? (typeof mandate.target_geographies === 'string' ? JSON.parse(mandate.target_geographies || '[]') : mandate.target_geographies || []) : [];
  mandateState.vertTags = mandate ? (typeof mandate.target_verticals === 'string' ? JSON.parse(mandate.target_verticals || '[]') : mandate.target_verticals || []) : [];

  $('#mandate-modal-title').textContent = mandate ? 'Edit Mandate' : 'New Mandate';
  $('#mm-buyer-name').value = mandate?.buyer_name || '';
  $('#mm-logo-url').value = mandate?.buyer_logo_url || '';
  $('#mm-rev-min').value = mandate?.revenue_min || '';
  $('#mm-rev-max').value = mandate?.revenue_max || '';
  $('#mm-ebitda-min').value = mandate?.ebitda_min || '';
  $('#mm-ebitda-max').value = mandate?.ebitda_max || '';
  $('#mm-frequency').value = mandate?.reporting_frequency || 'biweekly';
  renderTagList('mm-geo-list', mandateState.geoTags, 'geo');
  renderTagList('mm-vert-list', mandateState.vertTags, 'vert');
  $('#mandate-modal').hidden = false;
}

function renderTagList(hostId, tags, type) {
  const host = $(`#${hostId}`);
  if (!host) return;
  host.innerHTML = tags.map((t, i) =>
    `<span class="tag-chip">${escapeHtml(t)}<span class="tag-chip-x" data-type="${type}" data-idx="${i}">&times;</span></span>`
  ).join('');
  $$('.tag-chip-x', host).forEach(x => {
    x.addEventListener('click', () => {
      const arr = x.dataset.type === 'geo' ? mandateState.geoTags : mandateState.vertTags;
      arr.splice(Number(x.dataset.idx), 1);
      renderTagList(hostId, arr, x.dataset.type);
    });
  });
}

async function saveMandate() {
  const buyer_name = $('#mm-buyer-name').value.trim();
  if (!buyer_name) return toast('Buyer name required', 'error');
  const body = {
    buyer_name,
    buyer_logo_url: $('#mm-logo-url').value.trim() || null,
    revenue_min: Number($('#mm-rev-min').value) || null,
    revenue_max: Number($('#mm-rev-max').value) || null,
    ebitda_min: Number($('#mm-ebitda-min').value) || null,
    ebitda_max: Number($('#mm-ebitda-max').value) || null,
    target_geographies: mandateState.geoTags,
    target_verticals: mandateState.vertTags,
    reporting_frequency: $('#mm-frequency').value,
  };

  const url = mandateState.editingId ? `/api/mandates/${mandateState.editingId}` : '/api/mandates';
  const method = mandateState.editingId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { toast('Save failed', 'error'); return; }
  $('#mandate-modal').hidden = true;
  toast(mandateState.editingId ? 'Mandate updated' : 'Mandate created');
  loadMandates();
}

// ---------- CSV export ----------

function exportPipelineCSV(mandateId) {
  window.open(`/api/mandates/${mandateId}/pipeline-report.csv`, '_blank');
}

// ---------- Add company search ----------

function initMandateAddSearch() {
  const input = $('#mandate-add-search');
  const results = $('#mandate-add-results');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    clearTimeout(mandateState.searchDebounce);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    mandateState.searchDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/campaigns/search/companies?q=${encodeURIComponent(q)}&limit=10`);
        if (!res.ok) return;
        const data = await res.json();
        const existing = new Set(mandateState.activeCompanies.map(c => c.company_id));
        const filtered = (data.companies || []).filter(c => !existing.has(c.id));
        if (!filtered.length) { results.innerHTML = '<div class="mandate-add-item" style="color:var(--text-muted)">No results</div>'; results.hidden = false; return; }
        results.innerHTML = filtered.map(c => {
          const loc = [c.city, c.state].filter(Boolean).join(', ');
          return `<div class="mandate-add-item" data-id="${c.id}">
            <div><div class="mandate-add-item-name">${escapeHtml(c.name)}</div><div class="mandate-add-item-sub">${escapeHtml(loc)}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div></div>
            <div style="font-size:0.82rem;color:var(--text-muted)">${c.score ? Number(c.score).toFixed(1) : ''}</div>
          </div>`;
        }).join('');
        results.hidden = false;
        $$('.mandate-add-item', results).forEach(item => {
          item.addEventListener('click', async () => {
            const companyId = item.dataset.id;
            if (!companyId) return;
            const r = await fetch(`/api/mandates/${mandateState.activeMandateId}/companies`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ company_id: companyId }),
            });
            if (r.ok) {
              toast('Company added');
              input.value = '';
              results.hidden = true;
              openMandateDetail(mandateState.activeMandateId);
            } else {
              const err = await r.json();
              toast(err.error || 'Failed to add', 'error');
            }
          });
        });
      } catch { results.hidden = true; }
    }, 300);
  });

  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 200));
}

// ---------- Mandate filter helpers ----------

async function populateMandateStateDropdown() {
  const container = $('#mandate-state-options');
  if (!container) return;
  let states = [...new Set((state.companies || []).map(c => c.state).filter(Boolean))].sort();
  if (!states.length) {
    try {
      const res = await fetch('/api/companies?sort=state_asc');
      if (res.ok) {
        const data = await res.json();
        states = [...new Set((data.companies || []).map(c => c.state).filter(Boolean))].sort();
      }
    } catch {}
  }
  container.innerHTML = states.map(s =>
    `<label class="camp-dropdown-item"><input type="checkbox" value="${escapeHtml(s)}" data-group="m-state" /> ${escapeHtml(s)}</label>`
  ).join('');
}

function getMandateDropdownValues(group) {
  return $$(`input[data-group="${group}"]:checked:not(.camp-select-all)`).map(cb => cb.value);
}

function updateMandateDropdownLabel(group) {
  const selected = getMandateDropdownValues(group);
  const btn = group === 'm-state' ? $('#mandate-state-btn') : $('#mandate-industry-btn');
  if (!btn) return;
  const allLabel = group === 'm-state' ? 'All States' : 'All Industries';
  if (selected.length === 0) btn.textContent = allLabel;
  else if (selected.length <= 3) btn.textContent = selected.join(', ');
  else btn.textContent = `${selected.length} selected`;
}

async function mandateFilterSearch() {
  const states = getMandateDropdownValues('m-state');
  const industries = getMandateDropdownValues('m-industry');
  // Allow search with or without filters
  const params = new URLSearchParams();
  if (states.length) params.set('state', states.join(','));
  if (industries.length) params.set('industry', industries.join(','));
  try {
    const res = await fetch(`/api/campaigns/search/companies?${params}`);
    if (!res.ok) return;
    const { companies } = await res.json();
    const existing = new Set(mandateState.activeCompanies.map(c => c.company_id));
    const filtered = (companies || []).filter(c => !existing.has(c.id));
    if (!filtered.length) {
      toast('No new companies found matching filters', 'error');
      return;
    }
    // Show results in a modal-like dropdown below the filter row
    const resultsEl = $('#mandate-add-results');
    resultsEl.innerHTML = `<div style="padding:8px;font-weight:600;border-bottom:1px solid var(--card-border)">
      ${filtered.length} companies found — click to add
      <button type="button" class="btn-ghost btn-xs" id="mandate-filter-close" style="float:right">&times;</button>
    </div>` +
    filtered.map(c => {
      const loc = [c.city, c.state].filter(Boolean).join(', ');
      return `<div class="mandate-add-item" data-id="${c.id}">
        <div><div class="mandate-add-item-name">${escapeHtml(c.name)}</div><div class="mandate-add-item-sub">${escapeHtml(loc)}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div></div>
        <div style="font-size:0.82rem;color:var(--text-muted)">${c.score ? Number(c.score).toFixed(1) : ''}</div>
      </div>`;
    }).join('');
    resultsEl.hidden = false;
    $('#mandate-filter-close')?.addEventListener('click', () => { resultsEl.hidden = true; });
    $$('.mandate-add-item', resultsEl).forEach(item => {
      item.addEventListener('click', async () => {
        const companyId = item.dataset.id;
        if (!companyId) return;
        const r = await fetch(`/api/mandates/${mandateState.activeMandateId}/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_id: companyId }),
        });
        if (r.ok) {
          toast('Company added');
          item.remove();
          openMandateDetail(mandateState.activeMandateId);
        } else {
          const err = await r.json();
          toast(err.error || 'Failed to add', 'error');
        }
      });
    });
  } catch { toast('Search failed', 'error'); }
}

// ---------- Progress Reports ----------

function populatePRMandateSelect() {
  const sel = $('#pr-mandate-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select mandate...</option>' +
    mandateState.mandates.map(m => `<option value="${m.id}">${escapeHtml(m.buyer_name)}</option>`).join('');
}

async function loadProgressReports(mandateId) {
  if (!mandateId) { $('#pr-list').innerHTML = '<div class="empty-msg">Select a mandate to view reports.</div>'; return; }
  try {
    const res = await fetch(`/api/mandates/${mandateId}/progress-reports`);
    if (!res.ok) return;
    const data = await res.json();
    mandateState.progressReports = data.reports || [];
    renderProgressReports();
  } catch (e) { console.error('[pr]', e); }
}

function renderProgressReports() {
  const host = $('#pr-list');
  if (!host) return;
  if (!mandateState.progressReports.length) {
    host.innerHTML = '<div class="empty-msg">No reports yet. Click "+ New Report" to create one.</div>';
    return;
  }
  host.innerHTML = mandateState.progressReports.map(r => {
    const status = r.is_published ? 'published' : 'draft';
    return `<div class="pr-card">
      <div class="pr-card-header">
        <div class="pr-card-period">${new Date(r.period_start).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})} — ${new Date(r.period_end).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})}</div>
        <span class="pr-card-status ${status}">${status}</span>
      </div>
      <div class="pr-card-stats">
        <div class="pr-stat"><div class="pr-stat-value">${r.calls_made || 0}</div><div class="pr-stat-label">Calls Made</div></div>
        <div class="pr-stat"><div class="pr-stat-value">${fmtTalkTime(r.talk_time_seconds)}</div><div class="pr-stat-label">Talk Time</div></div>
        <div class="pr-stat"><div class="pr-stat-value">${r.emails_sent || 0}</div><div class="pr-stat-label">Emails Sent</div></div>
        <div class="pr-stat"><div class="pr-stat-value">${r.new_companies_contacted || 0}</div><div class="pr-stat-label">New Contacted</div></div>
        <div class="pr-stat"><div class="pr-stat-value">${r.companies_advanced || 0}</div><div class="pr-stat-label">Advanced</div></div>
      </div>
      ${r.notes ? `<div class="pr-card-notes">${escapeHtml(r.notes)}</div>` : ''}
      <div class="pr-card-actions">
        ${r.is_published
          ? `<button class="btn-ghost btn-xs" onclick="viewPublishedReport('${r.id}')">View / Print</button>
             <button class="btn-ghost btn-xs" onclick="unpublishReport('${r.id}')">Edit</button>`
          : `<button class="btn-ghost btn-xs" onclick="publishReport('${r.id}')">Publish</button>
             <button class="btn-ghost btn-xs" style="color:var(--red)" onclick="deleteReport('${r.id}')">Delete</button>`}
      </div>
    </div>`;
  }).join('');
}

async function createProgressReport() {
  const mandateId = $('#pr-mandate-select')?.value;
  if (!mandateId) return toast('Select a mandate first', 'error');
  const period_start = $('#prm-start').value;
  const period_end = $('#prm-end').value;
  const notes = $('#prm-notes').value;
  if (!period_start || !period_end) return toast('Period dates required', 'error');
  try {
    const res = await fetch(`/api/mandates/${mandateId}/progress-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_start, period_end, notes }),
    });
    if (!res.ok) { toast('Failed to create report', 'error'); return; }
    $('#pr-modal').hidden = true;
    toast('Report created with auto-populated stats');
    loadProgressReports(mandateId);
  } catch (e) { toast('Error creating report', 'error'); }
}

async function publishReport(id) {
  await fetch(`/api/progress-reports/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_published: true }),
  });
  const mandateId = $('#pr-mandate-select')?.value;
  if (mandateId) loadProgressReports(mandateId);
  toast('Report published');
}

async function unpublishReport(id) {
  await fetch(`/api/progress-reports/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_published: false }),
  });
  const mandateId = $('#pr-mandate-select')?.value;
  if (mandateId) loadProgressReports(mandateId);
  toast('Report unpublished — you can now edit and republish');
}

async function viewPublishedReport(reportId) {
  try {
    const res = await fetch(`/api/progress-reports/${reportId}`);
    if (!res.ok) return toast('Failed to load report', 'error');
    const report = await res.json();
    // Get the mandate info
    const mandateId = report.mandate_id;
    const mRes = await fetch(`/api/mandates/${mandateId}`);
    const mandate = mRes.ok ? await mRes.json() : {};

    const periodStart = new Date(report.period_start).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const periodEnd = new Date(report.period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const buyerName = mandate.buyer_name || 'Client';
    const companies = mandate.companies || [];

    const stageOrder = ['Execution', 'Introduction', 'Engage', 'Qualify'];
    const grouped = {};
    stageOrder.forEach(s => grouped[s] = []);
    companies.forEach(c => {
      const s = c.deal_stage || 'Qualify';
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(c);
    });

    const pipelineRows = stageOrder.map(stage => {
      if (!grouped[stage] || !grouped[stage].length) return '';
      return `<tr class="pr-print-stage-header"><td colspan="5" style="font-weight:700;background:#f0e8d0;padding:6px 10px;">${stage}</td></tr>` +
        grouped[stage].map(c => `<tr><td style="padding:4px 10px;">${escapeHtml(c.company_name || '')}</td><td>${escapeHtml(c.owner || '')}</td><td>${escapeHtml((c.city || '') + (c.state ? ', ' + c.state : ''))}</td><td>${c.deal_stage || ''}</td><td>${escapeHtml(c.next_step || '')}</td></tr>`).join('');
    }).join('');

    const printHtml = `
    <div id="pr-print-overlay" class="pr-print-overlay" onclick="if(event.target===this)this.remove()">
      <div class="pr-print-doc">
        <div class="pr-print-actions no-print">
          <button onclick="window.print()" class="btn-primary btn-xs">Print / Save PDF</button>
          <button onclick="this.closest('.pr-print-overlay').remove()" class="btn-ghost btn-xs">Close</button>
        </div>
        <div class="pr-print-header">
          <div style="font-size:1.4rem;font-weight:700;color:#0D1B2A;">Progress Report</div>
          <div style="font-size:0.9rem;color:#666;">Prepared for ${escapeHtml(buyerName)}</div>
          <div style="font-size:0.82rem;color:#888;margin-top:4px;">${periodStart} — ${periodEnd}</div>
        </div>
        <div class="pr-print-metrics">
          <div class="pr-print-metric"><div class="pr-print-metric-val">${report.calls_made || 0}</div><div class="pr-print-metric-label">Calls Made</div></div>
          <div class="pr-print-metric"><div class="pr-print-metric-val">${fmtTalkTime(report.talk_time_seconds)}</div><div class="pr-print-metric-label">Talk Time</div></div>
          <div class="pr-print-metric"><div class="pr-print-metric-val">${report.emails_sent || 0}</div><div class="pr-print-metric-label">Emails Sent</div></div>
          <div class="pr-print-metric"><div class="pr-print-metric-val">${report.new_companies_contacted || 0}</div><div class="pr-print-metric-label">New Contacted</div></div>
          <div class="pr-print-metric"><div class="pr-print-metric-val">${report.companies_advanced || 0}</div><div class="pr-print-metric-label">Advanced</div></div>
        </div>
        ${report.notes ? `<div class="pr-print-notes"><div style="font-weight:700;margin-bottom:6px;">Summary</div><div>${escapeHtml(report.notes)}</div></div>` : ''}
        <div class="pr-print-pipeline">
          <div style="font-weight:700;margin-bottom:8px;">Pipeline Status</div>
          <table class="pr-print-table">
            <thead><tr><th>Company</th><th>Contact</th><th>Location</th><th>Stage</th><th>Next Step</th></tr></thead>
            <tbody>${pipelineRows || '<tr><td colspan="5" style="text-align:center;color:#888;">No companies in mandate</td></tr>'}</tbody>
          </table>
        </div>
        <div class="pr-print-footer">
          <div>www.SellsAdvisors.com | Office: +1 (479) 334-3226</div>
          <div>HQ: 5100 W JB Hunt Dr, STE 830 Rogers, AR 72758</div>
          <div style="margin-top:4px;color:#999;">Confidential & Proprietary</div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', printHtml);
  } catch (e) { toast('Error loading report: ' + e.message, 'error'); }
}

async function deleteReport(id) {
  if (!confirm('Delete this draft report?')) return;
  await fetch(`/api/progress-reports/${id}`, { method: 'DELETE' });
  const mandateId = $('#pr-mandate-select')?.value;
  if (mandateId) loadProgressReports(mandateId);
  toast('Report deleted');
}

// ---------- Detail panel: company mandates ----------

async function loadCompanyMandates(companyId) {
  const section = $('#d-mandates-section');
  const list = $('#d-mandates-list');
  const count = $('#d-mandates-count');
  const sel = $('#d-mandate-select');
  if (!section || !list) return;

  try {
    const [mandRes, allRes] = await Promise.all([
      fetch(`/api/companies/${companyId}/mandates`),
      fetch('/api/mandates'),
    ]);
    const { mandates: companyMandates } = await mandRes.json();
    const { mandates: allMandates } = await allRes.json();

    if (count) count.textContent = companyMandates.length;

    if (companyMandates.length) {
      list.innerHTML = companyMandates.map(mc => `
        <div class="d-mandate-row">
          <span class="d-mandate-buyer">${escapeHtml(mc.buyer_name)}</span>
          <span class="deal-stage-badge deal-stage-${mc.deal_stage}">${escapeHtml(mc.deal_stage)}</span>
          <button class="d-mandate-remove" data-mandate-id="${mc.mandate_id}" title="Remove">&times;</button>
        </div>
      `).join('');
      $$('.d-mandate-remove', list).forEach(btn => {
        btn.addEventListener('click', async () => {
          await fetch(`/api/mandates/${btn.dataset.mandateId}/companies/${companyId}`, { method: 'DELETE' });
          loadCompanyMandates(companyId);
        });
      });
    } else {
      list.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0">Not in any mandate</div>';
    }

    // Populate dropdown with mandates not already assigned
    const assigned = new Set(companyMandates.map(mc => mc.mandate_id));
    const available = allMandates.filter(m => !assigned.has(m.id));
    if (sel) {
      sel.innerHTML = '<option value="">Add to mandate...</option>' +
        available.map(m => `<option value="${m.id}">${escapeHtml(m.buyer_name)}</option>`).join('');
    }
  } catch (e) { console.error('[company-mandates]', e); }
}

// ---------- Call Targets ----------

async function loadCallTargets() {
  try {
    const res = await fetch('/api/call-targets');
    if (!res.ok) return;
    const { targets } = await res.json();
    state.callTargets = targets;
    const select = $('#queue-target-select');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">All Companies</option>' +
      targets.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    if (currentVal) select.value = currentVal;
  } catch {}
}

function applyTargetFilter() {
  const targetId = $('#queue-target-select')?.value;
  const editBtn = $('#queue-target-edit');
  const deleteBtn = $('#queue-target-delete');
  if (editBtn) editBtn.hidden = !targetId;
  if (deleteBtn) deleteBtn.hidden = !targetId;

  if (!targetId) {
    state.activeTargetFilter = null;
    renderQueueList();
    return;
  }

  const target = (state.callTargets || []).find(t => t.id === targetId);
  if (!target) return;
  state.activeTargetFilter = target;
  renderQueueList();
}

function getFilteredQueue() {
  let queue = state.queue || [];
  const target = state.activeTargetFilter;
  if (!target) return queue;

  const industries = (typeof target.filter_industries === 'string' ? JSON.parse(target.filter_industries) : target.filter_industries) || [];
  const states = (typeof target.filter_states === 'string' ? JSON.parse(target.filter_states) : target.filter_states) || [];
  const tiers = (typeof target.filter_tiers === 'string' ? JSON.parse(target.filter_tiers) : target.filter_tiers) || [];
  const minScore = target.filter_min_score ? Number(target.filter_min_score) : null;
  const maxScore = target.filter_max_score ? Number(target.filter_max_score) : null;

  return queue.filter(c => {
    if (industries.length && !industries.includes(c.industry || 'Plumbing')) return false;
    if (states.length && !states.includes((c.state || '').toUpperCase())) return false;
    if (tiers.length && !tiers.includes(c.tier)) return false;
    if (minScore != null && (c.score || 0) < minScore) return false;
    if (maxScore != null && (c.score || 0) > maxScore) return false;
    return true;
  });
}

function renderQueueList() {
  renderQueue({ queue: state.queue });
  setTimeout(renderQueueWithMandateFilter, 50);
}

function openTargetModal(target = null) {
  state.editingTargetId = target ? target.id : null;
  $('#target-modal-title').textContent = target ? 'Edit Target' : 'Create Target';
  $('#target-name').value = target ? target.name : '';
  $('#target-min-score').value = target?.filter_min_score || '';
  $('#target-max-score').value = target?.filter_max_score || '';

  // Render industry chips
  const INDUSTRIES = ['Plumbing','HVAC','Pest Control','Restoration','Painting','Electrical','Septic','Cleaning','Landscaping','Roofing','Excavation','Fire Protection','Pool Service','Garage Door','Insulation','Other'];
  const selectedIndustries = target ? (typeof target.filter_industries === 'string' ? JSON.parse(target.filter_industries) : target.filter_industries) || [] : [];
  $('#target-industries').innerHTML = INDUSTRIES.map(i =>
    `<span class="settings-chip ${selectedIndustries.includes(i) ? 'active' : ''}" data-industry="${escapeHtml(i)}">${escapeHtml(i)}</span>`
  ).join('');
  $$('#target-industries .settings-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  // Render state chips
  const allStates = [...new Set((state.companies || []).map(c => c.state).filter(Boolean))].sort();
  const selectedStates = target ? (typeof target.filter_states === 'string' ? JSON.parse(target.filter_states) : target.filter_states) || [] : [];
  $('#target-states').innerHTML = allStates.map(s =>
    `<span class="settings-chip ${selectedStates.includes(s.toUpperCase()) ? 'active' : ''}" data-state="${escapeHtml(s.toUpperCase())}">${escapeHtml(s)}</span>`
  ).join('');
  $$('#target-states .settings-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  // Tier chips
  const selectedTiers = target ? (typeof target.filter_tiers === 'string' ? JSON.parse(target.filter_tiers) : target.filter_tiers) || [] : [];
  $$('#target-tiers .settings-chip').forEach(chip => {
    const tier = chip.dataset.tier;
    chip.classList.toggle('active', selectedTiers.includes(tier));
    chip.onclick = () => chip.classList.toggle('active');
  });

  $('#target-modal').hidden = false;
}

async function saveTarget() {
  const name = $('#target-name').value.trim();
  if (!name) return toast('Target name required', 'error');

  const filter_industries = [...$$('#target-industries .settings-chip.active')].map(c => c.dataset.industry);
  const filter_states = [...$$('#target-states .settings-chip.active')].map(c => c.dataset.state);
  const filter_tiers = [...$$('#target-tiers .settings-chip.active')].map(c => c.dataset.tier);
  const filter_min_score = $('#target-min-score').value ? Number($('#target-min-score').value) : null;
  const filter_max_score = $('#target-max-score').value ? Number($('#target-max-score').value) : null;

  const body = { name, filter_industries, filter_states, filter_tiers, filter_min_score, filter_max_score };

  try {
    const url = state.editingTargetId ? `/api/call-targets/${state.editingTargetId}` : '/api/call-targets';
    const method = state.editingTargetId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) {
      toast(state.editingTargetId ? 'Target updated' : 'Target created', 'ok');
      $('#target-modal').hidden = true;
      await loadCallTargets();
    } else { toast('Failed to save target', 'error'); }
  } catch { toast('Error saving target', 'error'); }
}

async function deleteTarget() {
  const targetId = $('#queue-target-select')?.value;
  if (!targetId) return;
  if (!confirm('Delete this target list?')) return;
  await fetch(`/api/call-targets/${targetId}`, { method: 'DELETE' });
  $('#queue-target-select').value = '';
  applyTargetFilter();
  await loadCallTargets();
  toast('Target deleted', 'ok');
}

// ---------- Queue mandate filter ----------

async function loadQueueMandateFilter() {
  const sel = $('#queue-mandate-filter');
  if (!sel) return;
  try {
    const res = await fetch('/api/mandates');
    if (!res.ok) return;
    const { mandates } = await res.json();
    sel.innerHTML = '<option value="">All Companies</option>' +
      mandates.map(m => `<option value="${m.id}">${escapeHtml(m.buyer_name)}</option>`).join('');
    // Restore from localStorage
    const saved = localStorage.getItem('callQueue_mandateFilter');
    if (saved && mandates.find(m => m.id === saved)) {
      sel.value = saved;
      applyQueueMandateFilter(saved);
    }
  } catch {}
}

async function applyQueueMandateFilter(mandateId) {
  const badge = $('#queue-mandate-badge');
  if (!mandateId) {
    mandateState.queueMandateCompanyIds = null;
    localStorage.removeItem('callQueue_mandateFilter');
    if (badge) badge.hidden = true;
    return;
  }
  localStorage.setItem('callQueue_mandateFilter', mandateId);
  try {
    const res = await fetch(`/api/mandates/${mandateId}`);
    if (!res.ok) return;
    const data = await res.json();
    mandateState.queueMandateCompanyIds = new Set((data.companies || []).map(c => c.company_id));
    if (badge) {
      badge.textContent = '\u25C6 Filtered: ' + data.mandate.buyer_name + ' \u2715';
      badge.hidden = false;
    }
  } catch {}
}

// ---------- Init mandate bindings ----------

function initMandateBindings() {
  // Subtab switching
  $$('.mandate-subtab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.mandate-subtab').forEach(t => t.classList.toggle('active', t === tab));
      const sub = tab.dataset.mandateSub;
      const pipeView = $('#mandate-pipeline-view');
      const progView = $('#mandate-progress-view');
      if (pipeView) pipeView.hidden = sub !== 'pipeline';
      if (progView) progView.hidden = sub !== 'progress';
    });
  });

  // New mandate
  const newBtn = $('#mandate-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => openMandateModal(null));

  // Modal
  const modalClose = $('#mandate-modal-close');
  if (modalClose) modalClose.addEventListener('click', () => { $('#mandate-modal').hidden = true; });
  const mmCancel = $('#mm-cancel');
  if (mmCancel) mmCancel.addEventListener('click', () => { $('#mandate-modal').hidden = true; });
  const mmSave = $('#mm-save');
  if (mmSave) mmSave.addEventListener('click', saveMandate);

  // Tag inputs
  const geoInput = $('#mm-geo-input');
  if (geoInput) geoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && geoInput.value.trim()) {
      e.preventDefault();
      mandateState.geoTags.push(geoInput.value.trim());
      geoInput.value = '';
      renderTagList('mm-geo-list', mandateState.geoTags, 'geo');
    }
  });
  const vertInput = $('#mm-vert-input');
  if (vertInput) vertInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && vertInput.value.trim()) {
      e.preventDefault();
      mandateState.vertTags.push(vertInput.value.trim());
      vertInput.value = '';
      renderTagList('mm-vert-list', mandateState.vertTags, 'vert');
    }
  });

  // Back button
  const backBtn = $('#mandate-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => {
    mandateState.activeMandateId = null;
    loadMandates();
  });

  // Edit button
  const editBtn = $('#mandate-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    if (mandateState.activeMandateData) openMandateModal(mandateState.activeMandateData);
  });

  // Delete button
  const deleteBtn = $('#mandate-delete-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    if (!confirm('Close this mandate?')) return;
    await fetch(`/api/mandates/${mandateState.activeMandateId}`, { method: 'DELETE' });
    mandateState.activeMandateId = null;
    toast('Mandate closed');
    loadMandates();
  });

  // Export CSV
  const exportBtn = $('#mandate-export-csv');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (mandateState.activeMandateId) exportPipelineCSV(mandateState.activeMandateId);
  });

  // Add company search
  initMandateAddSearch();

  // Import button
  $('#mandate-import-btn')?.addEventListener('click', () => $('#mandate-import-file')?.click());
  $('#mandate-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !mandateState.activeMandateId) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/mandates/${mandateState.activeMandateId}/import`, { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        toast(`${data.matched} companies added${data.not_found.length ? `, ${data.not_found.length} not found` : ''}`, 'ok');
        openMandateDetail(mandateState.activeMandateId);
      } else { toast(data.error || 'Import failed', 'error'); }
    } catch { toast('Import failed', 'error'); }
    e.target.value = '';
  });

  // Mandate filter dropdowns
  $('#mandate-state-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#mandate-state-menu');
    const wasHidden = menu.hidden;
    $('#mandate-state-menu').hidden = true;
    $('#mandate-industry-menu').hidden = true;
    menu.hidden = !wasHidden;
  });
  $('#mandate-industry-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#mandate-industry-menu');
    const wasHidden = menu.hidden;
    $('#mandate-state-menu').hidden = true;
    $('#mandate-industry-menu').hidden = true;
    menu.hidden = !wasHidden;
  });
  $('#mandate-state-menu')?.addEventListener('click', e => e.stopPropagation());
  $('#mandate-industry-menu')?.addEventListener('click', e => e.stopPropagation());

  // Select-all for mandate filters
  $$('.camp-select-all[data-group="m-state"]').forEach(sa => {
    sa.addEventListener('change', () => {
      $$('input[data-group="m-state"]:not(.camp-select-all)').forEach(cb => cb.checked = sa.checked);
      updateMandateDropdownLabel('m-state');
    });
  });
  $$('.camp-select-all[data-group="m-industry"]').forEach(sa => {
    sa.addEventListener('change', () => {
      $$('input[data-group="m-industry"]:not(.camp-select-all)').forEach(cb => cb.checked = sa.checked);
      updateMandateDropdownLabel('m-industry');
    });
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset?.group === 'm-state' && !e.target.classList.contains('camp-select-all')) {
      updateMandateDropdownLabel('m-state');
    }
    if (e.target.dataset?.group === 'm-industry' && !e.target.classList.contains('camp-select-all')) {
      updateMandateDropdownLabel('m-industry');
    }
  });

  // Populate mandate state dropdown
  populateMandateStateDropdown();

  // Search & Add button
  $('#mandate-filter-search')?.addEventListener('click', mandateFilterSearch);

  // Progress reports
  const prSelect = $('#pr-mandate-select');
  if (prSelect) prSelect.addEventListener('change', () => loadProgressReports(prSelect.value));

  const prNewBtn = $('#pr-new-btn');
  if (prNewBtn) prNewBtn.addEventListener('click', () => {
    if (!$('#pr-mandate-select')?.value) return toast('Select a mandate first', 'error');
    // Default dates to last 2 weeks
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
    $('#prm-start').value = start.toISOString().slice(0, 10);
    $('#prm-end').value = end.toISOString().slice(0, 10);
    $('#prm-notes').value = '';
    $('#pr-modal').hidden = false;
  });

  const prmClose = $('#pr-modal-close');
  if (prmClose) prmClose.addEventListener('click', () => { $('#pr-modal').hidden = true; });
  const prmCancel = $('#prm-cancel');
  if (prmCancel) prmCancel.addEventListener('click', () => { $('#pr-modal').hidden = true; });
  const prmSave = $('#prm-save');
  if (prmSave) prmSave.addEventListener('click', createProgressReport);

  // Detail panel: add to mandate
  const dMandateAddBtn = $('#d-mandate-add-btn');
  if (dMandateAddBtn) dMandateAddBtn.addEventListener('click', async () => {
    const mandateId = $('#d-mandate-select')?.value;
    if (!mandateId || !state.activeId) return;
    const r = await fetch(`/api/mandates/${mandateId}/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: state.activeId }),
    });
    if (r.ok) { toast('Added to mandate'); loadCompanyMandates(state.activeId); }
    else { const err = await r.json(); toast(err.error || 'Failed', 'error'); }
  });

  // Queue mandate filter
  const queueFilter = $('#queue-mandate-filter');
  if (queueFilter) queueFilter.addEventListener('change', () => {
    applyQueueMandateFilter(queueFilter.value);
    // Re-render the queue list with filter
    renderQueueWithMandateFilter();
  });
  const queueBadge = $('#queue-mandate-badge');
  if (queueBadge) queueBadge.addEventListener('click', () => {
    const sel = $('#queue-mandate-filter');
    if (sel) sel.value = '';
    applyQueueMandateFilter('');
    renderQueueWithMandateFilter();
  });
}

function renderQueueWithMandateFilter() {
  const items = $$('.queue-row', $('#queue-list'));
  if (!mandateState.queueMandateCompanyIds) {
    items.forEach(item => { item.style.display = ''; });
    return;
  }
  items.forEach(item => {
    const companyId = item.dataset?.companyId || item.dataset?.id;
    if (companyId && !mandateState.queueMandateCompanyIds.has(companyId)) {
      item.style.display = 'none';
    } else {
      item.style.display = '';
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// FEATURE 1: Pipeline Tab Enrichment
// ═══════════════════════════════════════════════════════════════════

// Note: Enriched pipeline rendering is now handled inline in renderKanbanCard + renderPipelineBoard

// 1C: Stale filter toggle
function initStaleFilter() {
  const toggle = $('#stale-filter-toggle');
  if (toggle) toggle.addEventListener('change', () => {
    _staleFilter = toggle.checked;
    renderPipelineBoard();
  });
  const pipeSearch = $('#pipeline-search');
  if (pipeSearch) {
    let _psDebounce;
    pipeSearch.addEventListener('input', () => {
      clearTimeout(_psDebounce);
      _psDebounce = setTimeout(() => renderPipelineBoard(), 250);
    });
  }
}

// 1D: Pre-Engagement Watchlist
let _peEditingId = null;

async function loadPreEngagement() {
  const res = await fetch('/api/pre-engagement');
  const data = await res.json();
  const items = data.items || [];
  renderPreEngagementTable(items);
}

function renderPreEngagementTable(items) {
  const tbody = $('#pe-tbody');
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-msg">No pre-engagement accounts yet.</td></tr>';
    return;
  }
  const groups = { High: [], Medium: [], Low: [] };
  for (const item of items) {
    const g = groups[item.priority] || groups.Medium;
    g.push(item);
  }
  let html = '';
  for (const [priority, group] of Object.entries(groups)) {
    if (!group.length) continue;
    html += `<tr class="pe-group-header"><td colspan="11">${escapeHtml(priority)} Priority (${group.length})</td></tr>`;
    for (const item of group) {
      const promoted = item.promoted_company_id;
      html += `<tr class="pe-row ${promoted ? 'pe-promoted' : ''}" data-pe-id="${item.id}">
        <td><strong>${escapeHtml(item.account_name)}</strong></td>
        <td>${escapeHtml(item.primary_contact || '')}</td>
        <td>${item.website ? `<a href="${escapeHtml(item.website)}" target="_blank" rel="noopener">${escapeHtml(item.website.replace(/^https?:\/\//, ''))}</a>` : ''}</td>
        <td><span class="pe-priority-pill pe-priority-${item.priority.toLowerCase()}">${escapeHtml(item.priority)}</span></td>
        <td>${escapeHtml(item.status || 'New')}</td>
        <td>${escapeHtml(item.next_action || '')}</td>
        <td>${item.first_contact_date || ''}</td>
        <td><input type="checkbox" class="pe-check" data-field="initial_docs_sent" ${item.initial_docs_sent ? 'checked' : ''} /></td>
        <td><input type="checkbox" class="pe-check" data-field="initial_data_received" ${item.initial_data_received ? 'checked' : ''} /></td>
        <td><input type="checkbox" class="pe-check" data-field="initial_model_created" ${item.initial_model_created ? 'checked' : ''} /></td>
        <td>
          ${promoted ? `<span class="pe-promoted-badge">Promoted</span>` : `<button class="btn-ghost btn-xs pe-promote-btn" data-id="${item.id}">Promote</button>`}
          <button class="btn-ghost btn-xs pe-edit-btn" data-id="${item.id}">Edit</button>
        </td>
      </tr>`;
    }
  }
  tbody.innerHTML = html;

  // Bind actions
  $$('.pe-check', tbody).forEach(cb => {
    cb.addEventListener('change', async () => {
      const row = cb.closest('.pe-row');
      const peId = row?.dataset.peId;
      if (!peId) return;
      await fetch(`/api/pre-engagement/${peId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [cb.dataset.field]: cb.checked }),
      });
    });
  });
  $$('.pe-promote-btn', tbody).forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Promote this account to the pipeline?')) return;
      const res = await fetch(`/api/pre-engagement/${btn.dataset.id}/promote`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast(`Promoted to pipeline${data.existed ? ' (company already existed)' : ''}`, 'ok');
        loadPreEngagement();
        loadPipelineBoard();
      } else {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Failed', 'error');
      }
    });
  });
  $$('.pe-edit-btn', tbody).forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items.find(i => i.id === btn.dataset.id);
      if (item) openPeModal(item);
    });
  });
}

function openPeModal(item) {
  _peEditingId = item ? item.id : null;
  $('#pe-modal-title').textContent = item ? 'Edit Pre-Engagement Account' : 'Add Pre-Engagement Account';
  $('#pe-account-name').value = item?.account_name || '';
  $('#pe-primary-contact').value = item?.primary_contact || '';
  $('#pe-website').value = item?.website || '';
  $('#pe-priority').value = item?.priority || 'Medium';
  $('#pe-status').value = item?.status || 'New';
  $('#pe-next-action').value = item?.next_action || '';
  $('#pe-first-contact').value = item?.first_contact_date || '';
  $('#pe-notes').value = item?.notes || '';
  $('#pe-linked-company-id').value = '';
  $('#pe-account-matches').hidden = true;
  $('#pe-modal').hidden = false;
}

// Pre-engagement company autocomplete
(function() {
  let _peSearchDebounce;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'pe-account-name') return;
    clearTimeout(_peSearchDebounce);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#pe-account-matches').hidden = true; return; }
    _peSearchDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/companies?search=${encodeURIComponent(q)}&sort=score_desc`);
        if (!res.ok) return;
        const { companies } = await res.json();
        const matches = (companies || []).slice(0, 6);
        const box = $('#pe-account-matches');
        if (!matches.length) { box.hidden = true; return; }
        box.innerHTML = matches.map(c => {
          const loc = [c.city, c.state].filter(Boolean).join(', ');
          return `<div class="gs-item" data-id="${c.id}" data-name="${escapeHtml(c.name)}" data-owner="${escapeHtml(c.owner || '')}" data-website="${escapeHtml(c.website || '')}">
            <div><div class="gs-item-name">${escapeHtml(c.name)}</div><div class="gs-item-sub">${escapeHtml(loc)}${c.owner ? ' · ' + escapeHtml(c.owner) : ''}</div></div>
          </div>`;
        }).join('');
        box.hidden = false;
        $$('.gs-item', box).forEach(item => {
          item.addEventListener('click', () => {
            $('#pe-account-name').value = item.dataset.name;
            $('#pe-primary-contact').value = item.dataset.owner || '';
            $('#pe-website').value = item.dataset.website || '';
            $('#pe-linked-company-id').value = item.dataset.id;
            box.hidden = true;
          });
        });
      } catch {}
    }, 250);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#pe-account-name') && !e.target.closest('#pe-account-matches')) {
      const box = $('#pe-account-matches');
      if (box) box.hidden = true;
    }
  });
})();

async function savePeItem() {
  const body = {
    account_name: $('#pe-account-name').value.trim(),
    primary_contact: $('#pe-primary-contact').value.trim() || null,
    website: $('#pe-website').value.trim() || null,
    priority: $('#pe-priority').value,
    status: $('#pe-status').value,
    next_action: $('#pe-next-action').value.trim() || null,
    first_contact_date: $('#pe-first-contact').value || null,
    notes: $('#pe-notes').value.trim() || null,
  };
  if (!body.account_name) { toast('Account name required', 'error'); return; }
  const url = _peEditingId ? `/api/pre-engagement/${_peEditingId}` : '/api/pre-engagement';
  const method = _peEditingId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) {
    toast(_peEditingId ? 'Updated' : 'Added', 'ok');
    $('#pe-modal').hidden = true;
    loadPreEngagement();
  } else {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Failed', 'error');
  }
}

// 1E: Deal Contacts in detail panel
async function loadDealContacts(companyId) {
  const [dcRes, ctRes] = await Promise.all([
    fetch(`/api/companies/${companyId}/deal-contacts`).then(r => r.json()),
    fetch(`/api/companies/${companyId}/contacts`).then(r => r.json()),
  ]);
  const dealContacts = dcRes.deal_contacts || [];
  const contacts = ctRes.contacts || [];

  $('#d-deal-contacts-count').textContent = dealContacts.length;
  const host = $('#d-deal-contacts');
  if (!dealContacts.length) {
    host.innerHTML = '<div class="sb-hint">No deal contacts linked.</div>';
  } else {
    host.innerHTML = dealContacts.map(dc => `
      <div class="dc-card">
        <div class="dc-info">
          <strong>${escapeHtml(dc.contact_name)}</strong>
          ${dc.role ? `<span class="dc-role-badge">${escapeHtml(dc.role)}</span>` : ''}
          ${dc.contact_title ? `<div class="dc-detail">${escapeHtml(dc.contact_title)}</div>` : ''}
          ${dc.contact_phone ? `<div class="dc-detail">${escapeHtml(dc.contact_phone)}</div>` : ''}
          ${dc.contact_email ? `<div class="dc-detail">${escapeHtml(dc.contact_email)}</div>` : ''}
        </div>
        <button class="btn-ghost btn-xs dc-remove" data-dc-id="${dc.id}">Remove</button>
      </div>
    `).join('');
    $$('.dc-remove', host).forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/companies/${companyId}/deal-contacts/${btn.dataset.dcId}`, { method: 'DELETE' });
        toast('Removed', 'ok');
        loadDealContacts(companyId);
      });
    });
  }

  // Populate contact dropdown (exclude already linked)
  const linkedIds = new Set(dealContacts.map(dc => dc.contact_id));
  const sel = $('#d-dc-contact-select');
  sel.innerHTML = '<option value="">Link a contact...</option>' +
    contacts.filter(c => !linkedIds.has(c.id)).map(c =>
      `<option value="${c.id}">${escapeHtml(c.name)}${c.title ? ' — ' + escapeHtml(c.title) : ''}</option>`
    ).join('');
}

// Mark Reviewed in detail
async function markCompanyReviewed() {
  if (!state.activeId) return;
  const res = await fetch(`/api/companies/${state.activeId}/mark-reviewed`, { method: 'POST' });
  if (res.ok) { toast('Marked as reviewed', 'ok'); openDetail(state.activeId); }
}

// ═══════════════════════════════════════════════════════════════════
// FEATURE 2: Invite Tab
// ═══════════════════════════════════════════════════════════════════

const inviteState = {
  platform: 'teams',
  teamMembers: [],
  externalAttendees: [],
  teamsJoinUrl: '',
};

function initInviteTab() {
  // Platform buttons
  $$('.invite-plat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.invite-plat-btn').forEach(b => b.classList.toggle('active', b === btn));
      inviteState.platform = btn.dataset.platform;
      $('#invite-teams-paste').hidden = btn.dataset.platform !== 'teams';
    });
  });

  // Teams paste parser
  $('#invite-teams-parse')?.addEventListener('click', () => {
    const text = $('#invite-teams-text').value || '';
    const urlMatch = text.match(/https:\/\/teams\.microsoft\.com\/[^\s)]+/);
    if (urlMatch) {
      inviteState.teamsJoinUrl = urlMatch[0];
      toast('Teams join URL parsed', 'ok');
    }
    const idMatch = text.match(/Meeting ID:\s*(\S+)/i);
    if (idMatch) inviteState.teamsMeetingId = idMatch[1];
    const pcMatch = text.match(/Passcode:\s*(\S+)/i);
    if (pcMatch) inviteState.teamsPasscode = pcMatch[1];
  });

  // Load team members
  fetch('/api/auth/users').then(r => r.json()).then(data => {
    const users = data.users || [];
    const host = $('#invite-team-members');
    if (!host) return;
    host.innerHTML = users.map(u => `
      <label class="invite-team-check">
        <input type="checkbox" value="${u.id}" data-name="${escapeHtml(u.name)}" data-email="${escapeHtml(u.email)}" />
        <span>${escapeHtml(u.name)}</span>
        <span class="invite-team-email">${escapeHtml(u.email)}</span>
      </label>
    `).join('');
  });

  // External contact search
  let extSearchTimer;
  $('#invite-ext-search')?.addEventListener('input', () => {
    clearTimeout(extSearchTimer);
    const q = $('#invite-ext-search').value.trim();
    if (q.length < 2) { $('#invite-ext-results').hidden = true; return; }
    extSearchTimer = setTimeout(async () => {
      const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=10`);
      const data = await res.json();
      const contacts = data.contacts || [];
      const host = $('#invite-ext-results');
      if (!contacts.length) { host.hidden = true; return; }
      host.innerHTML = contacts.map(c => `
        <div class="invite-ext-result" data-name="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email || '')}">
          ${escapeHtml(c.name)}${c.email ? ' — ' + escapeHtml(c.email) : ''}
          <span class="invite-ext-company">${escapeHtml(c.company_name || '')}</span>
        </div>
      `).join('');
      host.hidden = false;
      $$('.invite-ext-result', host).forEach(el => {
        el.addEventListener('click', () => {
          inviteState.externalAttendees.push({ name: el.dataset.name, email: el.dataset.email });
          renderInviteExternals();
          host.hidden = true;
          $('#invite-ext-search').value = '';
        });
      });
    }, 300);
  });

  // Manual external add
  $('#invite-ext-add')?.addEventListener('click', () => {
    const name = $('#invite-ext-name').value.trim();
    const email = $('#invite-ext-email').value.trim();
    if (!name && !email) return;
    inviteState.externalAttendees.push({ name: name || email, email });
    renderInviteExternals();
    $('#invite-ext-name').value = '';
    $('#invite-ext-email').value = '';
  });

  // Generate
  $('#invite-generate')?.addEventListener('click', generateInvite);
  $('#invite-copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText($('#invite-text').textContent);
    toast('Invite copied', 'ok');
  });
  $('#invite-copy-emails')?.addEventListener('click', () => {
    const emails = [];
    $$('input[type="checkbox"]:checked', $('#invite-team-members')).forEach(cb => {
      if (cb.dataset.email) emails.push(cb.dataset.email);
    });
    inviteState.externalAttendees.forEach(a => { if (a.email) emails.push(a.email); });
    navigator.clipboard.writeText(emails.join('; '));
    toast(`${emails.length} emails copied`, 'ok');
  });

  // Timezone display
  updateInviteTimezones();
  $('#invite-time')?.addEventListener('change', updateInviteTimezones);
}

function renderInviteExternals() {
  const host = $('#invite-ext-list');
  if (!host) return;
  host.innerHTML = inviteState.externalAttendees.map((a, i) => `
    <div class="invite-ext-item">
      <span>${escapeHtml(a.name)}${a.email ? ' (' + escapeHtml(a.email) + ')' : ''}</span>
      <button class="btn-ghost btn-xs invite-ext-remove" data-idx="${i}">x</button>
    </div>
  `).join('');
  $$('.invite-ext-remove', host).forEach(btn => {
    btn.addEventListener('click', () => {
      inviteState.externalAttendees.splice(Number(btn.dataset.idx), 1);
      renderInviteExternals();
    });
  });
}

function updateInviteTimezones() {
  const time = $('#invite-time')?.value || '10:00';
  const [h, m] = time.split(':').map(Number);
  const ct = `${((h % 12) || 12)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} CT`;
  const et = `${(((h + 1) % 12) || 12)}:${String(m).padStart(2, '0')} ${(h + 1) >= 12 ? 'PM' : 'AM'} ET`;
  const pt = `${(((h - 2 + 24) % 12) || 12)}:${String(m).padStart(2, '0')} ${(h - 2 + 24) >= 12 && (h - 2 + 24) < 24 ? 'PM' : 'AM'} PT`;
  const mt = `${(((h - 1 + 24) % 12) || 12)}:${String(m).padStart(2, '0')} ${(h - 1 + 24) >= 12 && (h - 1 + 24) < 24 ? 'PM' : 'AM'} MT`;
  const display = $('#invite-tz-display');
  if (display) display.textContent = `${ct} | ${et} | ${mt} | ${pt}`;
}

function generateInvite() {
  const title = $('#invite-title').value.trim() || 'Meeting';
  const date = $('#invite-date').value;
  const time = $('#invite-time').value || '10:00';
  if (!date) { toast('Date required', 'error'); return; }

  const [h, m] = time.split(':').map(Number);
  const ct = `${((h % 12) || 12)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} CT`;
  const dateStr = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const team = [];
  $$('input[type="checkbox"]:checked', $('#invite-team-members')).forEach(cb => {
    team.push(cb.dataset.name);
  });
  const externals = inviteState.externalAttendees.map(a => a.name);

  let text = `${title}\n`;
  text += `${dateStr} at ${ct}\n\n`;

  if (inviteState.platform === 'teams') {
    text += `Microsoft Teams Meeting\n`;
    if (inviteState.teamsJoinUrl) text += `Join: ${inviteState.teamsJoinUrl}\n`;
    if (inviteState.teamsMeetingId) text += `Meeting ID: ${inviteState.teamsMeetingId}\n`;
    if (inviteState.teamsPasscode) text += `Passcode: ${inviteState.teamsPasscode}\n`;
  } else if (inviteState.platform === 'zoom') {
    text += `Zoom Meeting\n`;
  } else if (inviteState.platform === 'in-person') {
    text += `In-Person Meeting\n`;
  } else {
    text += `Phone Call\n`;
  }

  if (team.length) text += `\nTeam: ${team.join(', ')}\n`;
  if (externals.length) text += `External: ${externals.join(', ')}\n`;

  $('#invite-text').textContent = text;
  $('#invite-output').hidden = false;

  // Save to API
  const attendees = [
    ...team.map(n => ({ name: n, type: 'team' })),
    ...inviteState.externalAttendees.map(a => ({ ...a, type: 'external' })),
  ];
  fetch('/api/calendar-invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, platform: inviteState.platform, meeting_date: date, time_ct: ct, attendees, invite_text: text }),
  });
}

// ═══════════════════════════════════════════════════════════════════
// FEATURE 3: Documents Tab
// ═══════════════════════════════════════════════════════════════════

const LEGAL_FIELDS = {
  mnda: [
    { key: 'DATE', label: 'Date', type: 'date' },
    { key: 'COUNTERPARTY LEGAL NAME', label: 'Counterparty Legal Name' },
    { key: 'JURISDICTION', label: 'Jurisdiction' },
    { key: 'ENTITY TYPE', label: 'Entity Type' },
    { key: 'SIGNATORY NAME', label: 'Signatory Name' },
    { key: 'SIGNATORY TITLE', label: 'Signatory Title' },
    { key: 'SIGNATORY EMAIL', label: 'Signatory Email', type: 'email' },
  ],
  sellside_buyer_nda: [
    { key: 'DATE', label: 'Date', type: 'date' },
    { key: 'TARGET COMPANY LEGAL NAME', label: 'Target Company Legal Name' },
    { key: 'JURISDICTION', label: 'Jurisdiction' },
    { key: 'ENTITY TYPE', label: 'Entity Type' },
    { key: 'RECIPIENT LEGAL NAME', label: 'Recipient Legal Name' },
    { key: 'SIGNATORY NAME', label: 'Signatory Name' },
    { key: 'SIGNATORY TITLE', label: 'Signatory Title' },
    { key: 'SIGNATORY EMAIL', label: 'Signatory Email', type: 'email' },
  ],
  engagement_letter: [
    { key: 'date', label: 'Effective Date', type: 'date' },
    { key: 'client_name', label: 'Client Legal Name' },
    { key: 'jurisdiction', label: 'Jurisdiction (state of formation)' },
    { key: 'entity_type', label: 'Entity Type (LLC, Corporation, LP, etc.)' },
    { key: 'retainer_fee', label: 'Retainer Fee ($)', type: 'number' },
    { key: 'success_fee_pct', label: 'Success Fee (%)', type: 'number' },
    { key: 'success_fee_min', label: 'Success Fee Minimum ($)', type: 'number' },
    { key: 'client_contact', label: 'Client Contact (Name, Title)' },
    { key: 'client_address', label: 'Client Street Address' },
    { key: 'client_city_state_zip', label: 'Client City, State, ZIP' },
    { key: 'client_email', label: 'Client Email', type: 'email' },
  ],
};

function initDocumentsTab() {
  // Sub-tabs
  $$('.docs-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.docs-subtab').forEach(b => b.classList.toggle('active', b === btn));
      const sub = btn.dataset.docsSub;
      $('#docs-branded-view').hidden = sub !== 'branded';
      $('#docs-legal-view').hidden = sub !== 'legal';
    });
  });

  // Branded generate
  $('#doc-branded-generate')?.addEventListener('click', async () => {
    const title = $('#doc-branded-title').value.trim();
    const subtitle = $('#doc-branded-subtitle').value.trim();
    const content = $('#doc-branded-content').value.trim();
    if (!title || !content) { toast('Title and content required', 'error'); return; }
    const status = $('#doc-branded-status');
    status.textContent = 'Generating...';
    status.hidden = false;
    try {
      const res = await fetch('/api/generate-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'branded', data: { title, subtitle, content } }),
      });
      const data = await res.json();
      if (data.ok) {
        status.innerHTML = `Document ready: <a href="${data.download_url}" download class="btn-primary btn-xs" style="text-decoration:none">Download</a>`;
      } else {
        status.textContent = data.error || 'Failed';
      }
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  });

  // Legal type change — show fields
  $('#doc-legal-type')?.addEventListener('change', () => {
    const type = $('#doc-legal-type').value;
    const fields = LEGAL_FIELDS[type] || [];
    const host = $('#doc-legal-fields');
    if (!fields.length) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = fields.map(f => `
      <div class="doc-field-row">
        <label class="camp-label">${escapeHtml(f.label)}</label>
        <input type="${f.type || 'text'}" class="cf-input doc-legal-input" data-key="${escapeHtml(f.key)}" />
      </div>
    `).join('');
  });

  // Auto-fill from deal dropdown
  loadLegalDealDropdown();
  $('#doc-legal-deal')?.addEventListener('change', () => {
    const companyId = $('#doc-legal-deal').value;
    if (!companyId) return;
    const company = state.companies.find(c => c.id === companyId);
    if (!company) return;
    // Try to fill common fields
    const setField = (key, val) => {
      const input = $(`.doc-legal-input[data-key="${key}"]`);
      if (input && val) input.value = val;
    };
    setField('COUNTERPARTY LEGAL NAME', company.name);
    setField('TARGET COMPANY LEGAL NAME', company.name);
    setField('DATE', new Date().toISOString().slice(0, 10));
    setField('JURISDICTION', company.state || '');
  });

  // Legal generate
  $('#doc-legal-generate')?.addEventListener('click', async () => {
    const type = $('#doc-legal-type').value;
    if (!type) { toast('Select document type', 'error'); return; }
    const data = {};
    $$('.doc-legal-input').forEach(inp => {
      data[inp.dataset.key] = inp.value.trim();
    });
    const status = $('#doc-legal-status');
    status.textContent = 'Generating...';
    status.hidden = false;
    try {
      const res = await fetch('/api/generate-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, data }),
      });
      const result = await res.json();
      if (result.ok) {
        status.innerHTML = `Document ready: <a href="${result.download_url}" download class="btn-primary btn-xs" style="text-decoration:none">Download .docx</a>`;
      } else {
        status.textContent = result.error || 'Failed';
      }
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  });
}

function loadLegalDealDropdown() {
  const sel = $('#doc-legal-deal');
  if (!sel) return;
  // Populate from pipeline board data
  const options = ['<option value="">Select deal (optional)...</option>'];
  for (const stage of (state.pipelineStages || [])) {
    const companies = (state.pipelineBoard || {})[stage.key] || [];
    for (const c of companies) {
      if (stage.key !== 'no_contact' && stage.key !== 'closed_lost') {
        options.push(`<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(stage.label)})</option>`);
      }
    }
  }
  sel.innerHTML = options.join('');
}

// ═══════════════════════════════════════════════════════════════════
// FEATURE 4: Calendar Enhancement + Outlook Stub
// ═══════════════════════════════════════════════════════════════════

let _calendarCallLogs = [];

async function loadCalendarCallLogs() {
  if (!state.calendarCursor) return;
  const { year, month } = state.calendarCursor;
  try {
    const res = await fetch(`/api/calendar/call-logs?year=${year}&month=${month}`);
    if (res.ok) {
      const data = await res.json();
      _calendarCallLogs = data.call_logs || [];
    }
  } catch {
    _calendarCallLogs = [];
  }
}

// Calendar call logs are loaded inline in loadCalendar()

function renderCalendarWithCalls() {
  // After original render, inject call log chips
  const grid = $('#cal-grid');
  if (!grid || !_calendarCallLogs.length) return;
  for (const cl of _calendarCallLogs) {
    const dkey = (cl.called_at || '').slice(0, 10);
    const cell = grid.querySelector(`[data-date="${dkey}"]`);
    if (!cell) continue;
    const eventsDiv = cell.querySelector('.cal-cell-events');
    if (!eventsDiv) continue;
    const dur = cl.duration_sec ? `${Math.floor(cl.duration_sec / 60)}m` : '';
    const chip = document.createElement('div');
    chip.className = 'cal-event-chip cal-call-chip';
    chip.title = `Call: ${cl.company_name || 'Unknown'} ${dur}`;
    chip.textContent = `\u260E ${cl.company_name || 'Call'} ${dur}`;
    eventsDiv.appendChild(chip);
  }
}

async function loadOutlookStatus() {
  const badge = $('#cal-outlook-badge');
  if (!badge) return;
  try {
    const res = await fetch('/api/outlook/status');
    const data = await res.json();
    badge.textContent = data.connected ? 'Outlook: Connected' : 'Outlook: Not connected';
    badge.className = 'cal-outlook-badge' + (data.connected ? ' cal-outlook-connected' : '');
  } catch {
    badge.textContent = 'Outlook: Not connected';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Initialization for new features
// ═══════════════════════════════════════════════════════════════════

function initNewFeatures() {
  // Pipeline sub-tabs
  $$('.pipeline-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.pipeline-subtab').forEach(b => b.classList.toggle('active', b === btn));
      const sub = btn.dataset.pipelineSub;
      $('#pipeline-board-view').hidden = sub !== 'board';
      $('#pipeline-pre-engagement-view').hidden = sub !== 'pre-engagement';
      if (sub === 'pre-engagement') loadPreEngagement();
    });
  });

  // Pre-engagement modal
  $('#pe-add-btn')?.addEventListener('click', () => openPeModal(null));
  $('#pe-modal-close')?.addEventListener('click', () => { $('#pe-modal').hidden = true; });
  $('#pe-modal-cancel')?.addEventListener('click', () => { $('#pe-modal').hidden = true; });
  $('#pe-modal-save')?.addEventListener('click', savePeItem);

  // Stale filter
  initStaleFilter();

  // Deal contacts in detail — add button
  $('#d-dc-add-btn')?.addEventListener('click', async () => {
    const contactId = $('#d-dc-contact-select').value;
    const role = $('#d-dc-role').value.trim();
    if (!contactId || !state.activeId) return;
    const res = await fetch(`/api/companies/${state.activeId}/deal-contacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, role: role || null }),
    });
    if (res.ok) { toast('Contact linked', 'ok'); $('#d-dc-role').value = ''; loadDealContacts(state.activeId); }
    else { const err = await res.json().catch(() => ({})); toast(err.error || 'Failed', 'error'); }
  });

  // Draft Invite button in detail
  $('#d-draft-invite-btn')?.addEventListener('click', () => {
    if (!state.activeId) return;
    const company = state.companies.find(c => c.id === state.activeId);
    // Switch to Invite tab
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'invite'));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-invite'));
    // Pre-fill title
    if (company) {
      $('#invite-title').value = `Call - ${company.name}`;
    }
  });

  // Invite tab
  initInviteTab();

  // Documents tab
  initDocumentsTab();

  // Tab switch hooks for new tabs
  const origTabHandlers = {};
  $$('.tab', $('#main-tabs')).forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (target === 'invite') { /* already loaded via initInviteTab */ }
      if (target === 'documents') { loadLegalDealDropdown(); }
    });
  });
}

// Deal contacts loaded inline in openDetail()

// ═══════════════════════════════════════════════════════════════════
// Deal Popup Modal
// ═══════════════════════════════════════════════════════════════════

const DP_MS_KEYS = ['buyer_list','qoe','teaser','cim','network_intros','buyer_outreach','iois_received','mgmt_meetings','lois_received','loi_signed','diligence','closing'];
const DP_MS_LABELS = {
  buyer_list: 'Buyer List', qoe: 'QoE', teaser: 'Teaser', cim: 'CIM',
  network_intros: 'Network Intros', buyer_outreach: 'Buyer Outreach',
  iois_received: 'IOIs Received', mgmt_meetings: 'Mgmt Meetings',
  lois_received: 'LOIs Received', loi_signed: 'LOI Signed',
  diligence: 'Diligence', closing: 'Closing'
};

async function openDealPopup(companyId) {
  state.dealPopupId = companyId;
  const company = state.companies.find(c => c.id === companyId)
    || (state.pipelineBoard ? Object.values(state.pipelineBoard).flat().find(c => c.id === companyId) : null);
  if (!company) return;

  // Title
  $('#dp-title').textContent = company.name;

  // Stage dropdown
  const stageSelect = $('#dp-stage');
  stageSelect.innerHTML = state.pipelineStages.map(s =>
    `<option value="${s.key}" ${company.pipeline_stage === s.key ? 'selected' : ''}>${escapeHtml(s.label)}</option>`
  ).join('');

  // Priority
  $('#dp-priority').value = company.deal_priority || '';

  // Metrics
  $('#dp-valuation').value = company.valuation || '';
  $('#dp-probability').value = company.probability || '';
  $('#dp-close-date').value = company.est_close_date ? company.est_close_date.split('T')[0] : '';
  $('#dp-created-date').textContent = company.created_at
    ? new Date(company.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '\u2014';

  // Last reviewed
  if (company.last_reviewed_at) {
    const daysAgo = Math.floor((Date.now() - new Date(company.last_reviewed_at).getTime()) / 86400000);
    $('#dp-reviewed-text').textContent = `Last reviewed ${daysAgo === 0 ? 'today' : daysAgo + 'd ago'}`;
  } else {
    $('#dp-reviewed-text').textContent = 'Not yet reviewed';
  }

  // Next steps
  $('#dp-next-steps').value = company.next_steps || '';

  // Load milestones
  loadDealPopupMilestones(companyId);

  // Load notes
  loadDealPopupNotes(companyId);

  // Show modal
  $('#deal-popup').hidden = false;
}

function closeDealPopup() {
  $('#deal-popup').hidden = true;
  state.dealPopupId = null;
}

async function loadDealPopupMilestones(companyId) {
  const container = $('#dp-milestones');
  try {
    const res = await fetch(`/api/companies/${companyId}/milestones`);
    const data = await res.json();
    // milestones comes back as { key: state } map
    const milestones = data.milestones || {};

    container.innerHTML = DP_MS_KEYS.map(k => {
      const s = milestones[k] || 'not_started';
      return `<button type="button" class="dp-ms-pill dp-ms-${s}" data-key="${k}" data-state="${s}">${escapeHtml(DP_MS_LABELS[k])}</button>`;
    }).join('');

    $$('.dp-ms-pill', container).forEach(pill => {
      pill.addEventListener('click', async () => {
        const key = pill.dataset.key;
        const r = await fetch(`/api/companies/${companyId}/milestones/${key}`, { method: 'PUT' });
        if (r.ok) {
          const d = await r.json();
          pill.dataset.state = d.state;
          pill.className = `dp-ms-pill dp-ms-${d.state}`;
          // Also update the kanban card dots
          const dot = document.querySelector(`.kc-dot[data-company="${companyId}"][data-key="${key}"]`);
          if (dot) {
            dot.dataset.state = d.state;
            dot.style.background = d.state === 'complete' ? 'var(--green)' : d.state === 'in_progress' ? 'var(--gold)' : '#ccc';
          }
        }
      });
    });
  } catch { container.innerHTML = ''; }
}

async function loadDealPopupNotes(companyId) {
  const list = $('#dp-notes-list');
  try {
    const res = await fetch(`/api/companies/${companyId}/notes`);
    if (!res.ok) { list.innerHTML = '<div class="dp-empty">No notes yet.</div>'; return; }
    const data = await res.json();
    const notes = data.notes || [];
    if (!notes.length) { list.innerHTML = '<div class="dp-empty">No notes yet.</div>'; return; }
    list.innerHTML = notes.map(n => {
      const date = n.created_at ? new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return `<div class="dp-note">\u2022 ${escapeHtml(n.note || '')} <span class="dp-note-date">(${date})</span></div>`;
    }).join('');
  } catch { list.innerHTML = '<div class="dp-empty">No notes yet.</div>'; }
}

function initDealPopupBindings() {
  $('#dp-close')?.addEventListener('click', closeDealPopup);

  // Close on backdrop click
  $('#deal-popup')?.addEventListener('click', (e) => {
    if (e.target.id === 'deal-popup') closeDealPopup();
  });

  $('#dp-mark-reviewed')?.addEventListener('click', async () => {
    const id = state.dealPopupId;
    if (!id) return;
    await fetch(`/api/companies/${id}/mark-reviewed`, { method: 'POST' });
    $('#dp-reviewed-text').textContent = 'Last reviewed today';
    toast('Marked as reviewed', 'ok');
  });

  $('#dp-save-metrics')?.addEventListener('click', async () => {
    const id = state.dealPopupId;
    if (!id) return;
    const body = {
      valuation: Number($('#dp-valuation').value) || null,
      probability: Number($('#dp-probability').value) || null,
      est_close_date: $('#dp-close-date').value || null,
      deal_priority: $('#dp-priority').value || null,
    };
    await fetch(`/api/companies/${id}/deal-fields`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    toast('Metrics saved', 'ok');
    loadPipelineBoard();
  });

  $('#dp-stage')?.addEventListener('change', async () => {
    const id = state.dealPopupId;
    const stage = $('#dp-stage').value;
    if (!id || !stage) return;
    await fetch(`/api/companies/${id}/pipeline`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ stage }) });
    toast('Stage updated', 'ok');
    loadPipelineBoard();
  });

  $('#dp-priority')?.addEventListener('change', async () => {
    const id = state.dealPopupId;
    if (!id) return;
    const body = { deal_priority: $('#dp-priority').value || null };
    await fetch(`/api/companies/${id}/deal-fields`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    toast('Priority updated', 'ok');
  });

  $('#dp-save-next-steps')?.addEventListener('click', async () => {
    const id = state.dealPopupId;
    if (!id) return;
    const body = { next_steps: $('#dp-next-steps').value.trim() || null };
    await fetch(`/api/companies/${id}/deal-fields`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    toast('Next steps saved', 'ok');
  });

  $('#dp-add-note')?.addEventListener('click', async () => {
    const id = state.dealPopupId;
    const text = $('#dp-note-input').value.trim();
    if (!id || !text) return;
    await fetch(`/api/companies/${id}/notes`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ note: text }) });
    $('#dp-note-input').value = '';
    loadDealPopupNotes(id);
    toast('Note added', 'ok');
  });

  $('#dp-view-full')?.addEventListener('click', () => {
    const id = state.dealPopupId;
    closeDealPopup();
    if (id) openDetail(id);
  });

  $('#dp-view-calls')?.addEventListener('click', () => {
    const id = state.dealPopupId;
    closeDealPopup();
    if (id) openDetail(id);
  });

  $('#dp-draft-invite')?.addEventListener('click', () => {
    const id = state.dealPopupId;
    closeDealPopup();
    const inviteTab = document.querySelector('.tab[data-tab="invite"]');
    if (inviteTab) inviteTab.click();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ADVISOR NETWORK MODULE
// ═══════════════════════════════════════════════════════════════════════════

const advisorState = {
  advisors: [],
  activeAdvisorId: null,
  viewMode: 'list', // list | pipeline | queue
};

const ADVISOR_TYPE_LABELS = {
  cpa: 'CPA', ria: 'RIA / Wealth', attorney: 'Attorney', lender: 'Lender',
  coach: 'Coach', insurance: 'Insurance', fractional_cfo: 'Fractional CFO',
};

const ADVISOR_STAGE_LABELS = {
  identified: 'Identified', researched: 'Researched', queued: 'Queued',
  outreach_sent: 'Outreach Sent', first_response: 'First Response',
  intro_meeting_booked: 'Meeting Booked', intro_meeting_done: 'Meeting Done',
  active_partner: 'Active Partner', dormant: 'Dormant', declined: 'Declined',
};

const ADVISOR_STAGE_COLORS = {
  identified: '#6b7280', researched: '#3b82f6', queued: '#8b5cf6',
  outreach_sent: '#f59e0b', first_response: '#10b981', intro_meeting_booked: '#06b6d4',
  intro_meeting_done: '#0ea5e9', active_partner: '#22c55e', dormant: '#9ca3af', declined: '#ef4444',
};

function advisorTierClass(score) {
  if (score >= 7.5) return 'strong-buy';
  if (score >= 5.0) return 'watchlist';
  return 'pass';
}

function advisorTierLabel(score) {
  if (score >= 7.5) return 'Strong Fit';
  if (score >= 5.0) return 'Moderate Fit';
  return 'Low Fit';
}

async function loadAdvisors() {
  const type = $('#advisor-type-filter')?.value || '';
  const stage = $('#advisor-stage-filter')?.value || '';
  const search = $('#advisor-search')?.value || '';
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (stage) params.set('relationshipStage', stage);
  if (search) params.set('search', search);

  try {
    const [listRes, statsRes] = await Promise.all([
      fetch(`/api/advisors?${params}`),
      fetch('/api/advisors/stats'),
    ]);
    const listData = await listRes.json();
    const statsData = await statsRes.json();
    advisorState.advisors = listData.advisors || [];
    renderAdvisorStats(statsData);
    renderAdvisorView();
  } catch (err) {
    console.error('Failed to load advisors:', err);
  }
}

function renderAdvisorStats(stats) {
  const el = $('#advisor-stats-bar');
  if (!el) return;
  el.innerHTML = `
    <span class="advisor-stat">Total: <strong>${stats.total || 0}</strong></span>
    <span class="advisor-stat">Researched: <strong>${stats.researched || 0}</strong></span>
    <span class="advisor-stat tier-strong-buy">Strong Fit: <strong>${stats.strongFit || 0}</strong></span>
    <span class="advisor-stat">Active Partners: <strong>${stats.activePartners || 0}</strong></span>
    <span class="advisor-stat">In Outreach: <strong>${stats.inOutreach || 0}</strong></span>
  `;
}

function renderAdvisorView() {
  const mode = advisorState.viewMode;
  $('#advisor-list').hidden = mode !== 'list';
  $('#advisor-pipeline').hidden = mode !== 'pipeline';
  $('#advisor-queue-view').hidden = mode !== 'queue';

  if (mode === 'list') renderAdvisorList();
  else if (mode === 'pipeline') renderAdvisorPipeline();
  else if (mode === 'queue') loadAdvisorQueue();
}

function renderAdvisorList() {
  const el = $('#advisor-list');
  if (!el) return;
  if (advisorState.advisors.length === 0) {
    el.innerHTML = '<div class="empty-state">No advisors yet. Click "+ Add Advisor" or run research from Claude Code.</div>';
    return;
  }
  el.innerHTML = `
    <table class="advisor-table">
      <thead>
        <tr>
          <th>Name</th><th>Type</th><th>Firm</th><th>Location</th>
          <th>Fit Score</th><th>Stage</th><th>Last Contact</th>
        </tr>
      </thead>
      <tbody>
        ${advisorState.advisors.map(a => `
          <tr class="advisor-row" data-id="${a.id}">
            <td class="advisor-name-cell">${escapeHtml(a.name)}</td>
            <td><span class="advisor-type-badge advisor-type-${a.type}">${ADVISOR_TYPE_LABELS[a.type] || a.type}</span></td>
            <td>${escapeHtml(a.firm || '-')}</td>
            <td>${escapeHtml([a.city, a.state].filter(Boolean).join(', ') || '-')}</td>
            <td>${a.fit_score != null ? `<span class="tier-pill ${advisorTierClass(a.fit_score)}">${Number(a.fit_score).toFixed(1)}</span>` : '-'}</td>
            <td><span class="advisor-stage-pill" style="background:${ADVISOR_STAGE_COLORS[a.relationship_stage] || '#6b7280'}">${ADVISOR_STAGE_LABELS[a.relationship_stage] || a.relationship_stage}</span></td>
            <td>${a.last_contact_date ? new Date(a.last_contact_date).toLocaleDateString() : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  $$('.advisor-row', el).forEach(row => {
    row.addEventListener('click', () => openAdvisorDetail(row.dataset.id));
  });
}

function renderAdvisorPipeline() {
  const el = $('#advisor-pipeline');
  if (!el) return;
  const stages = ['identified','researched','queued','outreach_sent','first_response','intro_meeting_booked','intro_meeting_done','active_partner'];
  const byStage = {};
  stages.forEach(s => byStage[s] = []);
  for (const a of advisorState.advisors) {
    const s = a.relationship_stage || 'identified';
    if (byStage[s]) byStage[s].push(a);
    else if (s !== 'dormant' && s !== 'declined') byStage.identified.push(a);
  }
  el.innerHTML = `<div class="pipeline-board advisor-pipeline-board">
    ${stages.map(s => `
      <div class="pipeline-col" data-stage="${s}">
        <div class="pipeline-col-header" style="border-color:${ADVISOR_STAGE_COLORS[s]}">
          <span>${ADVISOR_STAGE_LABELS[s]}</span>
          <span class="pipeline-count">${byStage[s].length}</span>
        </div>
        <div class="pipeline-cards">
          ${byStage[s].map(a => `
            <div class="pipeline-card advisor-pipeline-card" data-id="${a.id}">
              <div class="pipeline-card-name">${escapeHtml(a.name)}</div>
              <div class="pipeline-card-sub">${escapeHtml(a.firm || '')}</div>
              <div class="pipeline-card-meta">
                <span class="advisor-type-badge advisor-type-${a.type}">${ADVISOR_TYPE_LABELS[a.type] || a.type}</span>
                ${a.fit_score != null ? `<span class="tier-pill ${advisorTierClass(a.fit_score)}">${Number(a.fit_score).toFixed(1)}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>`;
  $$('.advisor-pipeline-card', el).forEach(card => {
    card.addEventListener('click', () => openAdvisorDetail(card.dataset.id));
  });
}

async function loadAdvisorQueue() {
  const el = $('#advisor-queue-view');
  if (!el) return;
  try {
    const res = await fetch('/api/advisors/queue');
    const data = await res.json();
    const advisors = data.advisors || [];
    if (advisors.length === 0) {
      el.innerHTML = '<div class="empty-state">No advisors due for follow-up today.</div>';
      return;
    }
    el.innerHTML = advisors.map(a => `
      <div class="advisor-queue-card" data-id="${a.id}">
        <div class="advisor-queue-left">
          <div class="advisor-queue-name">${escapeHtml(a.name)}</div>
          <div class="advisor-queue-meta">
            <span class="advisor-type-badge advisor-type-${a.type}">${ADVISOR_TYPE_LABELS[a.type] || a.type}</span>
            ${escapeHtml(a.firm || '')} &mdash; ${escapeHtml([a.city, a.state].filter(Boolean).join(', '))}
          </div>
          ${a.next_action ? `<div class="advisor-queue-action">Next: ${escapeHtml(a.next_action)}</div>` : ''}
        </div>
        <div class="advisor-queue-right">
          ${a.fit_score != null ? `<span class="tier-pill ${advisorTierClass(a.fit_score)}">${Number(a.fit_score).toFixed(1)}</span>` : ''}
          <span class="advisor-stage-pill" style="background:${ADVISOR_STAGE_COLORS[a.relationship_stage] || '#6b7280'}">${ADVISOR_STAGE_LABELS[a.relationship_stage] || a.relationship_stage}</span>
        </div>
      </div>
    `).join('');
    $$('.advisor-queue-card', el).forEach(card => {
      card.addEventListener('click', () => openAdvisorDetail(card.dataset.id));
    });
  } catch (err) {
    el.innerHTML = '<div class="empty-state">Failed to load queue.</div>';
  }
}

async function openAdvisorDetail(id) {
  advisorState.activeAdvisorId = id;
  try {
    const res = await fetch(`/api/advisors/${id}`);
    if (!res.ok) return toast('Advisor not found', 'error');
    const data = await res.json();
    renderAdvisorDetail(data);
    $('#advisor-detail-panel').hidden = false;
    document.body.classList.add('detail-open');
  } catch (err) {
    toast('Failed to load advisor', 'error');
  }
}

function renderAdvisorDetail({ advisor, credentials, contacts, referrals, ownerLinks }) {
  const d = advisor.dossier_json || {};
  const b = advisor.fit_score_breakdown_json || {};

  // Header
  $('#advisor-detail-header').innerHTML = `
    <div class="advisor-detail-name">${escapeHtml(advisor.name)}</div>
    <div class="advisor-detail-sub">
      <span class="advisor-type-badge advisor-type-${advisor.type}">${ADVISOR_TYPE_LABELS[advisor.type] || advisor.type}</span>
      ${advisor.firm ? `<span>${escapeHtml(advisor.firm)}</span>` : ''}
      ${advisor.title ? `<span>&mdash; ${escapeHtml(advisor.title)}</span>` : ''}
    </div>
    <div class="advisor-detail-loc">${escapeHtml([advisor.city, advisor.state].filter(Boolean).join(', '))}</div>
    <div class="advisor-detail-score-row">
      ${advisor.fit_score != null ? `<span class="tier-pill ${advisorTierClass(advisor.fit_score)}" style="font-size:14px">${advisorTierLabel(advisor.fit_score)} (${Number(advisor.fit_score).toFixed(1)})</span>` : ''}
      <span class="advisor-stage-pill" style="background:${ADVISOR_STAGE_COLORS[advisor.relationship_stage] || '#6b7280'};font-size:12px">${ADVISOR_STAGE_LABELS[advisor.relationship_stage] || advisor.relationship_stage}</span>
    </div>
    <div class="advisor-detail-actions">
      <select id="advisor-stage-select" class="cf-input cf-input-sm" style="width:180px">
        ${Object.entries(ADVISOR_STAGE_LABELS).map(([k, v]) => `<option value="${k}" ${k === advisor.relationship_stage ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <button type="button" class="btn-ghost btn-xs" id="btn-advisor-stage-save">Update Stage</button>
      <button type="button" class="btn-ghost btn-xs" id="btn-advisor-reresearch">Re-Research</button>
    </div>
  `;

  // Body
  const hs = d.hunger_signals || {};
  const ss = d.specialty_signals || {};
  const ns = d.network_signals || {};
  const reach = d.reachability || {};
  const hooks = d.personal_rapport_hooks || {};

  let bodyHtml = '';

  // Contact info
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Contact Info</div>
    <div class="advisor-info-grid">
      ${advisor.email ? `<div><strong>Email:</strong> <a href="mailto:${escapeHtml(advisor.email)}">${escapeHtml(advisor.email)}</a></div>` : ''}
      ${advisor.phone ? `<div><strong>Phone:</strong> ${escapeHtml(advisor.phone)}</div>` : ''}
      ${advisor.linkedin_url ? `<div><strong>LinkedIn:</strong> <a href="${escapeHtml(advisor.linkedin_url)}" target="_blank">Profile</a></div>` : ''}
      ${advisor.website ? `<div><strong>Website:</strong> <a href="${escapeHtml(advisor.website)}" target="_blank">${escapeHtml(advisor.website)}</a></div>` : ''}
    </div>
  </div>`;

  // Fit score breakdown
  if (b && Object.keys(b).length) {
    bodyHtml += `<div class="advisor-section">
      <div class="advisor-section-title">Fit Score Breakdown</div>
      <div class="advisor-score-bars">
        ${Object.entries(b).map(([k, v]) => `
          <div class="advisor-score-bar-row">
            <span class="advisor-score-label">${k.replace(/_/g, ' ')}</span>
            <div class="advisor-score-bar"><div class="advisor-score-fill" style="width:${(v / 10) * 100}%;background:${v >= 7.5 ? '#22c55e' : v >= 5 ? '#f59e0b' : '#ef4444'}"></div></div>
            <span class="advisor-score-val">${Number(v).toFixed(1)}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  // Outreach angles — handle both string[] and object[] formats
  const angles = d.outreach_angles || [];
  if (angles.length) {
    bodyHtml += `<div class="advisor-section">
      <div class="advisor-section-title">Outreach Angles</div>
      <div class="advisor-angles-list">${angles.map(a => {
        if (typeof a === 'string') return `<div class="advisor-angle-item"><div class="advisor-angle-hook">${escapeHtml(a)}</div></div>`;
        return `<div class="advisor-angle-item">
          <div class="advisor-angle-hook">${escapeHtml(a.hook || '')}</div>
          ${a.grounded_in_fact ? `<div class="advisor-angle-fact">Based on: ${escapeHtml(a.grounded_in_fact)}</div>` : ''}
          ${a.suggested_channel ? `<div class="advisor-angle-channel">Via: ${escapeHtml(a.suggested_channel)}</div>` : ''}
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  // Credentials
  if (credentials && credentials.length) {
    bodyHtml += `<div class="advisor-section">
      <div class="advisor-section-title">Credentials</div>
      <div class="advisor-creds">${credentials.map(c => `<span class="advisor-cred">${escapeHtml(c.credential)}${c.earned_year ? ` (${c.earned_year})` : ''}</span>`).join(' ')}</div>
    </div>`;
  }

  // Hunger signals
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Hunger Signals</div>
    <div class="advisor-signals">
      ${hs.newly_independent ? '<span class="signal-tag signal-hot">Newly Independent</span>' : ''}
      ${hs.growing_team ? '<span class="signal-tag signal-hot">Growing Team</span>' : ''}
      ${hs.content_output_frequency === 'high' ? '<span class="signal-tag signal-hot">High Content Output</span>' : ''}
      ${hs.career_stage ? `<div class="signal-detail"><strong>Career Stage:</strong> ${escapeHtml(hs.career_stage)}</div>` : ''}
      ${hs.personal_book_incentive ? `<div class="signal-detail"><strong>Book Incentive:</strong> ${escapeHtml(hs.personal_book_incentive)}</div>` : ''}
      ${hs.growth_signals_summary ? `<div class="signal-detail">${escapeHtml(hs.growth_signals_summary)}</div>` : ''}
    </div>
  </div>`;

  // Specialty signals
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Specialty Signals</div>
    <div class="advisor-signals">
      ${ss.serves_business_owners ? '<span class="signal-tag signal-good">Serves Business Owners</span>' : ''}
      ${ss.serves_smb_trades_homeservices ? '<span class="signal-tag signal-hot">Serves Trades / Home Services</span>' : ''}
      ${ss.does_exit_or_succession_work ? '<span class="signal-tag signal-good">Exit / Succession Work</span>' : ''}
      ${ss.deal_or_transaction_experience ? '<span class="signal-tag signal-good">Deal Experience</span>' : ''}
    </div>
  </div>`;

  // Personal rapport hooks
  const hasRapportData = hooks.alma_mater || (hooks.hobbies_or_interests && hooks.hobbies_or_interests.length) || hooks.recent_life_events || (hooks.prior_employers && hooks.prior_employers.length);
  if (hasRapportData) {
    const lifeEvents = Array.isArray(hooks.recent_life_events) ? hooks.recent_life_events.join(', ') : (hooks.recent_life_events || '');
    bodyHtml += `<div class="advisor-section">
      <div class="advisor-section-title">Rapport Hooks</div>
      <div class="advisor-info-grid">
        ${hooks.alma_mater ? `<div><strong>Alma Mater:</strong> ${escapeHtml(hooks.alma_mater)}</div>` : ''}
        ${hooks.prior_employers?.length ? `<div><strong>Prior Employers:</strong> ${hooks.prior_employers.map(e => escapeHtml(e)).join(', ')}</div>` : ''}
        ${hooks.hobbies_or_interests?.length ? `<div><strong>Interests:</strong> ${hooks.hobbies_or_interests.map(h => escapeHtml(h)).join(', ')}</div>` : ''}
        ${lifeEvents ? `<div><strong>Recent:</strong> ${escapeHtml(lifeEvents)}</div>` : ''}
        ${hooks.shared_connections_to_jack?.length ? `<div><strong>Shared Connections:</strong> ${hooks.shared_connections_to_jack.map(c => escapeHtml(c)).join(', ')}</div>` : ''}
      </div>
    </div>`;
  }

  // Risk flags — handle both string[] and object[] formats
  const risks = d.risk_flags || [];
  if (risks.length) {
    bodyHtml += `<div class="advisor-section">
      <div class="advisor-section-title">Risk Flags</div>
      <div class="advisor-risks-list">${risks.map(r => {
        if (typeof r === 'string') return `<div class="risk-item">${escapeHtml(r)}</div>`;
        return `<div class="risk-item risk-${r.severity || 'low'}">
          <span class="risk-severity">${(r.severity || 'low').toUpperCase()}</span>
          <span class="risk-flag">${escapeHtml(r.flag || '')}</span>
          ${r.detail ? `<div class="risk-detail">${escapeHtml(r.detail)}</div>` : ''}
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  // Contact log
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Contact Log <button type="button" class="btn-ghost btn-xs" id="btn-add-advisor-contact">+ Log Contact</button></div>
    <div id="advisor-contact-log">
      ${contacts && contacts.length ? contacts.map(c => `
        <div class="advisor-contact-entry">
          <div class="advisor-contact-date">${new Date(c.contact_date).toLocaleDateString()} via ${escapeHtml(c.channel)} (${c.direction})</div>
          <div>${escapeHtml(c.summary || '')}</div>
          ${c.next_action ? `<div class="advisor-contact-next">Next: ${escapeHtml(c.next_action)}${c.next_action_date ? ` by ${new Date(c.next_action_date).toLocaleDateString()}` : ''}</div>` : ''}
        </div>
      `).join('') : '<div class="empty-sub">No contacts logged yet.</div>'}
    </div>
  </div>`;

  // Referrals
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Referrals <button type="button" class="btn-ghost btn-xs" id="btn-add-referral">+ Log Referral</button></div>
    <div id="advisor-referral-log">
      ${referrals && referrals.length ? referrals.map(r => `
        <div class="advisor-referral-entry">
          <span class="referral-direction ${r.direction}">${r.direction === 'inbound' ? 'From Advisor' : 'To Advisor'}</span>
          ${r.prospect_name ? `<span>${escapeHtml(r.prospect_name)}</span>` : ''}
          <span>${escapeHtml(r.scope || '')}</span>
          <span class="referral-status">${escapeHtml(r.status)}</span>
          ${r.estimated_value ? `<span>$${Number(r.estimated_value).toLocaleString()}</span>` : ''}
        </div>
      `).join('') : '<div class="empty-sub">No referrals yet.</div>'}
    </div>
  </div>`;

  // Linked owners
  bodyHtml += `<div class="advisor-section">
    <div class="advisor-section-title">Linked Owners</div>
    <div id="advisor-owner-links">
      ${ownerLinks && ownerLinks.length ? ownerLinks.map(l => `
        <div class="advisor-owner-link">
          <span class="link-type-badge ${l.link_type}">${l.link_type}</span>
          <span class="link-owner-name" data-id="${l.prospect_id}" style="cursor:pointer;text-decoration:underline">${escapeHtml(l.prospect_name || 'Unknown')}</span>
          <span>${escapeHtml([l.prospect_city, l.prospect_state].filter(Boolean).join(', '))}</span>
          ${l.confidence ? `<span>(${(l.confidence * 100).toFixed(0)}% confidence)</span>` : ''}
        </div>
      `).join('') : '<div class="empty-sub">No linked owners.</div>'}
    </div>
  </div>`;

  $('#advisor-detail-body').innerHTML = bodyHtml;

  // Bind events
  $('#btn-advisor-stage-save')?.addEventListener('click', async () => {
    const newStage = $('#advisor-stage-select')?.value;
    if (!newStage) return;
    await fetch(`/api/advisors/${advisor.id}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: newStage }) });
    toast('Stage updated');
    loadAdvisors();
    openAdvisorDetail(advisor.id);
  });

  $('#btn-advisor-reresearch')?.addEventListener('click', async () => {
    await fetch(`/api/advisors/${advisor.id}/re-research`, { method: 'POST' });
    toast('Re-research started');
  });

  $('#btn-add-advisor-contact')?.addEventListener('click', () => showAdvisorContactForm(advisor.id));
  $('#btn-add-referral')?.addEventListener('click', () => showReferralForm(advisor.id));

  $$('.link-owner-name', $('#advisor-owner-links')).forEach(el => {
    el.addEventListener('click', () => {
      closeAdvisorDetail();
      openDetail(el.dataset.id);
    });
  });
}

function closeAdvisorDetail() {
  $('#advisor-detail-panel').hidden = true;
  document.body.classList.remove('detail-open');
  advisorState.activeAdvisorId = null;
}

function showAdvisorContactForm(advisorId) {
  const log = $('#advisor-contact-log');
  if (!log) return;
  log.insertAdjacentHTML('afterbegin', `
    <div class="advisor-contact-form" id="advisor-contact-form">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="acf-channel" class="cf-input cf-input-sm" style="width:120px">
          <option value="email">Email</option><option value="call">Call</option>
          <option value="linkedin">LinkedIn</option><option value="in_person">In Person</option>
          <option value="event">Event</option>
        </select>
        <select id="acf-direction" class="cf-input cf-input-sm" style="width:120px">
          <option value="outbound">Outbound</option><option value="inbound">Inbound</option>
        </select>
      </div>
      <textarea id="acf-summary" class="cf-input" rows="2" placeholder="Summary of the interaction&hellip;"></textarea>
      <input type="text" id="acf-next-action" class="cf-input cf-input-sm" placeholder="Next action (optional)" />
      <input type="date" id="acf-next-action-date" class="cf-input cf-input-sm" />
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="button" class="btn-primary btn-xs" id="acf-save">Save</button>
        <button type="button" class="btn-ghost btn-xs" id="acf-cancel">Cancel</button>
      </div>
    </div>
  `);
  $('#acf-cancel').addEventListener('click', () => $('#advisor-contact-form')?.remove());
  $('#acf-save').addEventListener('click', async () => {
    const body = {
      channel: $('#acf-channel').value,
      direction: $('#acf-direction').value,
      summary: $('#acf-summary').value,
      next_action: $('#acf-next-action').value || null,
      next_action_date: $('#acf-next-action-date').value || null,
    };
    await fetch(`/api/advisors/${advisorId}/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Contact logged');
    openAdvisorDetail(advisorId);
  });
}

function showReferralForm(advisorId) {
  const log = $('#advisor-referral-log');
  if (!log) return;
  log.insertAdjacentHTML('afterbegin', `
    <div class="advisor-contact-form" id="referral-form">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="ref-direction" class="cf-input cf-input-sm" style="width:150px">
          <option value="inbound">From Advisor (inbound)</option>
          <option value="outbound">To Advisor (outbound)</option>
        </select>
        <input type="text" id="ref-scope" class="cf-input cf-input-sm" placeholder="Scope (e.g. estate planning)" style="width:180px" />
      </div>
      <input type="number" id="ref-value" class="cf-input cf-input-sm" placeholder="Estimated value ($)" />
      <textarea id="ref-notes" class="cf-input" rows="2" placeholder="Notes&hellip;"></textarea>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="button" class="btn-primary btn-xs" id="ref-save">Save</button>
        <button type="button" class="btn-ghost btn-xs" id="ref-cancel">Cancel</button>
      </div>
    </div>
  `);
  $('#ref-cancel').addEventListener('click', () => $('#referral-form')?.remove());
  $('#ref-save').addEventListener('click', async () => {
    const body = {
      direction: $('#ref-direction').value,
      scope: $('#ref-scope').value || null,
      estimated_value: $('#ref-value').value ? Number($('#ref-value').value) : null,
      notes: $('#ref-notes').value || null,
    };
    await fetch(`/api/advisors/${advisorId}/referrals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Referral logged');
    openAdvisorDetail(advisorId);
  });
}

function initAdvisorBindings() {
  // Filters
  $('#advisor-type-filter')?.addEventListener('change', loadAdvisors);
  $('#advisor-stage-filter')?.addEventListener('change', loadAdvisors);
  let searchTimeout;
  $('#advisor-search')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadAdvisors, 300);
  });
  $('#advisor-view-mode')?.addEventListener('change', (e) => {
    advisorState.viewMode = e.target.value;
    renderAdvisorView();
  });

  // Close detail
  $('#advisor-detail-close')?.addEventListener('click', closeAdvisorDetail);

  // Add advisor modal (manual entry)
  $('#btn-add-advisor-manual')?.addEventListener('click', () => {
    $('#add-advisor-modal').hidden = false;
  });
  $('#add-advisor-modal-close')?.addEventListener('click', () => {
    $('#add-advisor-modal').hidden = true;
  });
  $('#btn-save-advisor')?.addEventListener('click', async () => {
    const name = $('#add-adv-name')?.value?.trim();
    const type = $('#add-adv-type')?.value;
    if (!name) return toast('Name is required', 'error');
    try {
      await fetch('/api/advisors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type,
          firm: $('#add-adv-firm')?.value?.trim() || null,
          title: $('#add-adv-title')?.value?.trim() || null,
          city: $('#add-adv-city')?.value?.trim() || null,
          state: $('#add-adv-state')?.value?.trim()?.toUpperCase() || null,
          email: $('#add-adv-email')?.value?.trim() || null,
          linkedin_url: $('#add-adv-linkedin')?.value?.trim() || null,
        }),
      });
      $('#add-advisor-modal').hidden = true;
      // Clear form
      ['add-adv-name','add-adv-firm','add-adv-title','add-adv-city','add-adv-state','add-adv-email','add-adv-linkedin'].forEach(id => { const el = $(`#${id}`); if (el) el.value = ''; });
      toast('Advisor added');
      loadAdvisors();
    } catch (err) {
      toast('Failed to add advisor', 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => { init(); initGlobalSearch(); initMandateBindings(); initNewFeatures(); initDealPopupBindings(); initAdvisorBindings(); });
