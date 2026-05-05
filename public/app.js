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
    const stageColors = { no_contact: '#8B8FA3', initial_contact: '#3B82F6', nurture: '#8B5CF6', lead_memo: '#F59E0B', pitch: '#EC4899', engagement_letter: '#10B981', lois_collected: '#06B6D4', deal_closed: '#22C55E', closed_lost: '#EF4444' };
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
  renderPipelineBoard();
}

function renderPipelineBoard() {
  const host = $('#kanban-board');
  if (!host) return;
  const stages = state.pipelineStages;
  if (!stages.length) { host.innerHTML = '<div class="dash-empty">Loading pipeline stages...</div>'; return; }

  const tierFilter = state.filter.tier || '';
  let totalCount = 0;
  host.innerHTML = stages.map((s) => {
    const all = state.pipelineBoard[s.key] || [];
    const companies = tierFilter ? all.filter((c) => c.tier === tierFilter) : all;
    totalCount += companies.length;
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
    `;
  }).join('');

  const countEl = $('#pipeline-total-count');
  if (countEl) countEl.textContent = `${totalCount} companies total`;

  // Click handlers on kanban cards
  $$('.kanban-card', host).forEach((el) => {
    el.addEventListener('click', () => openDetail(el.dataset.id));
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
  return `
    <div class="kanban-card ${tierClass(c.tier)}" data-id="${c.id}" draggable="true">
      <div class="kc-top">
        <span class="kc-score ${tierClass(c.tier)}">${fmtScore(c.score)}</span>
        <span class="kc-name">${escapeHtml(c.name)}</span>
      </div>
      <div class="kc-meta">
        ${c.owner ? escapeHtml(c.owner) : ''}
        ${c.city ? ' · ' + escapeHtml(c.city) + (c.state ? ', ' + escapeHtml(c.state) : '') : ''}
      </div>
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
      <div class="ct-row">
        ${ct.phone ? `<span>${escapeHtml(ct.phone)}</span>` : ''}
        ${ct.email ? `<span>${escapeHtml(ct.email)}</span>` : ''}
        ${ct.linkedin ? `<a href="${escapeHtml(ct.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}
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
      if (target === 'campaigns') loadCampaignsList();
      if (target === 'deleted') loadDeletedItems();
      if (target === 'actlog') loadActivityLog();
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
  $('#d-name').textContent = c.name;
  $('#d-sub').textContent = loc || '—';
  $('#d-tier').textContent = tierLabel(c.tier);
  $('#d-tier').className = `detail-tier ${tierClass(c.tier)}`;
  $('#d-summary').textContent = c.summary || 'No research summary yet.';

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
  renderKeyInfo(c.key_info, '#d-keyinfo', '#d-keyinfo-section');

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
    $$('input[type="checkbox"]', indDrop).forEach((cb) => {
      cb.addEventListener('change', () => {
        const checked = $$('input[type="checkbox"]:checked', indDrop).map((c) => c.value);
        state.filter.industries = checked;
        const total = $$('input[type="checkbox"]', indDrop).length;
        indBtn.textContent = checked.length === total || checked.length === 0
          ? 'All Industries \u25BE'
          : checked.map((v) => v).join(', ') + ' \u25BE';
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
  $('#hide-crm').addEventListener('change', (e) => {
    state.filter.hideCrm = e.target.checked;
    loadCompanies();
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
    device.register();
    state.twilioDevice = device;
  } catch (err) {
    console.error('[twilio] Device init failed:', err.message);
  }
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
  } catch (err) {
    list.innerHTML = `<div class="queue-empty">Error loading queue: ${escapeHtml(err.message)}</div>`;
  }
}

function renderQueue(data) {
  const list = $('#queue-list');
  if (!list) return;
  const rows = state.queue;
  if (!rows.length) {
    if (data.empty_reason === 'no_assignments') {
      list.innerHTML = `
        <div class="queue-empty">
          <div style="font-weight:600;margin-bottom:6px;">No territories assigned yet.</div>
          <div>Ask your admin to assign verticals/territories in Settings.</div>
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
        <div class="queue-row ${selected}" data-id="${escapeHtml(r.id)}">
          <div class="queue-rank">${r.rank}</div>
          <div class="queue-row-score">${score}</div>
          <div class="queue-row-main">
            <div class="queue-row-name">${escapeHtml(r.name)}</div>
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
  renderKeyInfo(qpCompany?.key_info, '#qp-keyinfo', '#qp-keyinfo-section');

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

function renderKeyInfo(keyInfo, hostSel, sectionSel) {
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
    return `<div class="keyinfo-row"><span class="keyinfo-label">${escapeHtml(label)}</span><span class="keyinfo-value">${escapeHtml(val)}</span></div>`;
  }).join('');
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
          <textarea class="debrief-q-textarea" data-idx="${i}" data-question="${escapeHtml(q)}" placeholder="Your answer (minimum ${d.min_answer_len} characters)">${escapeHtml(drafted)}</textarea>
          <div class="debrief-q-counter" data-counter="${i}">${drafted.length} / ${d.min_answer_len} min</div>
        </div>`;
    })
    .join('');

  // Wire textareas
  $$('.debrief-q-textarea').forEach((ta) => {
    ta.addEventListener('input', () => {
      const idx = ta.dataset.idx;
      const counter = $(`.debrief-q-counter[data-counter="${idx}"]`);
      const n = ta.value.length;
      const minLen = d.min_answer_len || 10;
      counter.textContent = `${n} / ${minLen} min`;
      counter.classList.toggle('valid', n >= minLen);
      validateDebriefForm();
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
  const d = state.debriefCall;
  if (!d) return;
  const disp = $('#debrief-disposition')?.value || 'answered';
  if (disp === 'no_answer_no_vm') {
    // No requirements — can submit immediately
    $('#debrief-submit').disabled = false;
    return;
  }
  if (disp === 'no_answer_left_vm') {
    // Need at least 10 chars describing the VM
    const vmNote = ($('#debrief-vm-note')?.value || '').trim();
    $('#debrief-submit').disabled = vmNote.length < 10;
    return;
  }
  // answered — normal Q&A validation
  const minLen = d.min_answer_len || 10;
  const tas = $$('.debrief-q-textarea');
  const allValid = tas.length > 0 && tas.every((ta) => ta.value.trim().length >= minLen);
  $('#debrief-submit').disabled = !allValid;
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
  renderCalendar();
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
      const verts = (u.assigned_verticals || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      const terrs = (u.assigned_territories || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      return `
        <div class="settings-user-row" data-user="${escapeHtml(u.id)}">
          <div>
            <div class="settings-user-name">${escapeHtml(u.name || '—')} <span class="settings-user-role ${u.role}">${escapeHtml(roleLabel)}</span>${restrictedBadge}</div>
            <div class="settings-user-email">${escapeHtml(u.email || '')}</div>
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
  'Plumbing', 'HVAC', 'Pest Control', 'Restoration',
  'Painting', 'Electrical', 'Septic', 'Cleaning',
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
  // Render industry chips
  const vBox = $('#settings-user-verticals');
  vBox.innerHTML = SETTINGS_VERTICALS
    .map((v) => {
      const active = (u.assigned_verticals || []).includes(v) ? 'active' : '';
      return `<span class="settings-chip ${active}" data-vert="${escapeHtml(v)}">${escapeHtml(v)}</span>`;
    })
    .join('');
  $$('.settings-chip[data-vert]', vBox).forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
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
  // Restricted toggle
  const restrictCb = $('#settings-user-restricted');
  if (restrictCb) restrictCb.checked = !!u.restricted;
  $('#settings-user-modal').hidden = false;
}

function closeSettingsUserModal() {
  $('#settings-user-modal').hidden = true;
  state.settingsEditingUser = null;
}

async function saveSettingsUser() {
  const u = state.settingsEditingUser;
  if (!u) return;
  const role = $('#settings-user-role').value;
  const verticals = $$('.settings-chip.active[data-vert]').map((c) => c.dataset.vert);
  const territories = $$('.settings-chip.active[data-terr]').map((c) => c.dataset.terr);
  const restricted = !!$('#settings-user-restricted')?.checked;
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
      body: JSON.stringify({ verticals, territories, restricted }),
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

  // Contacts tab + Add Company / Add Contact
  $('#btn-add-company')?.addEventListener('click', () => openCompanyModal());
  $('#company-modal-close')?.addEventListener('click', closeCompanyModal);
  $('#cm-cancel')?.addEventListener('click', closeCompanyModal);
  $('#cm-save')?.addEventListener('click', saveCompanyModal);

  $('#btn-add-contact')?.addEventListener('click', () => openContactModal());
  $('#contact-modal-close')?.addEventListener('click', closeContactModal);
  $('#ctm-cancel')?.addEventListener('click', closeContactModal);
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
  const title = c.title ? escapeHtml(c.title) : '';
  const primary = c.is_primary ? '<span class="contact-row-primary-pill">Primary</span>' : '';
  const phoneLink = c.phone ? `<a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a>` : '';
  const emailLink = c.email ? `<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : '';
  const linkedinLink = c.linkedin ? `<a href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : '';
  const contactInfo = [phoneLink, emailLink, linkedinLink].filter(Boolean).join('') ||
    '<span style="color: rgba(13,27,42,0.35)">No contact info</span>';
  const companyName = escapeHtml(c.company_name || 'No company linked');
  const companyMeta = [c.company_city, c.company_state].filter(Boolean).map(escapeHtml).join(', ');
  const companyLink = c.company_id
    ? `<button type="button" class="contact-row-company-link" data-company-id="${escapeHtml(c.company_id)}" title="Open company">${companyName}</button>`
    : `<span style="color: rgba(13,27,42,0.4)">${companyName}</span>`;
  return `
    <div class="contact-row">
      <div class="contact-row-main">
        <div class="contact-row-name">${name}${primary}</div>
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
  $('#ctm-phone').value = s.phone ?? contact?.phone ?? '';
  $('#ctm-email').value = s.email ?? contact?.email ?? '';
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
  const body = {
    company_id,
    name,
    title: $('#ctm-title').value.trim() || null,
    phone: $('#ctm-phone').value.trim() || null,
    email: $('#ctm-email').value.trim() || null,
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
  $('#camp-body').value = campState.campaign.body_template || '';
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
        body_template: $('#camp-body').value,
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

async function campSearchCompanies() {
  const q = $('#camp-search')?.value || '';
  const tier = $('#camp-tier-filter')?.value || '';
  const stateVal = $('#camp-state-filter')?.value || '';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tier) params.set('tier', tier);
  if (stateVal) params.set('state', stateVal);
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
  $('#camp-preview-body').textContent = d.body;
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
  $('#camp-close-preview')?.addEventListener('click', () => { $('#camp-preview-modal').hidden = true; });
  $('#camp-prev-preview')?.addEventListener('click', () => campPreviewNav(-1));
  $('#camp-next-preview')?.addEventListener('click', () => campPreviewNav(1));

  // Search with debounce
  const searchHandler = () => {
    clearTimeout(campState.searchDebounce);
    campState.searchDebounce = setTimeout(campSearchCompanies, 300);
  };
  $('#camp-search')?.addEventListener('input', searchHandler);
  $('#camp-tier-filter')?.addEventListener('change', campSearchCompanies);
  $('#camp-state-filter')?.addEventListener('change', campSearchCompanies);

  bindMergeFieldClicks();
}

document.addEventListener('DOMContentLoaded', init);
