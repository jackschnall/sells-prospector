// Sells M&A Prospector — frontend

const state = {
  companies: [],
  filter: { tier: '', search: '', sort: 'score_desc', hideCrm: false, stateFilter: '', pipelineStage: '' },
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
  queue: [],
  queuePins: [],
  queueActiveId: null,
  queueCallLogId: null,
  queueCallTimer: null,
  queueCallStart: 0,
  queuePollTimer: null,
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
  $('#stat-crm').textContent = stats.inCrm ?? 0;
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

  let totalCount = 0;
  host.innerHTML = stages.map((s) => {
    const companies = state.pipelineBoard[s.key] || [];
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
const ACTIVITY_ICONS = { note: '&#9998;', call: '&#9743;', email: '&#9993;', meeting: '&#9632;', stage_change: '&#9654;', research: '&#9670;' };

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
  $('#detail-panel').hidden = true;
  document.body.classList.remove('detail-open');
  state.activeId = null;
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
  $('#d-name').textContent = c.name;
  $('#d-sub').textContent = loc || '—';
  $('#d-tier').textContent = tierLabel(c.tier);
  $('#d-tier').className = `detail-tier ${tierClass(c.tier)}`;
  $('#d-summary').textContent = c.summary || 'No summary yet.';

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

  // Contacts
  renderContacts(contacts);

  // Sources
  $('#d-sources').innerHTML = sources.length
    ? sources.map((s) => `<a class="source-chip" href="${escapeHtml(s.url || '#')}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url || 'source')}</a>`).join('')
    : '<div class="sb-hint">No sources recorded.</div>';

  // Activities
  renderActivities(activities);

  // Actions
  $('#d-override').textContent = c.crm_override ? 'Crm Override: ON' : 'Research Anyway';
  $('#d-override').hidden = !c.crm_known;
  $('#d-tearsheet').href = `/tearsheet/${c.id}`;

  // Reset contact form
  $('#d-contact-form').hidden = true;
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
        .sort((a, b) => (b.market_score || 0) - (a.market_score || 0))
        .map((m, i) => {
          const scoreClass = (m.market_score || 0) >= 7 ? 'score-high' : (m.market_score || 0) >= 5 ? 'score-mid' : 'score-low';
          return `
            <tr class="${scoreClass}">
              <td class="rank-col">${i + 1}</td>
              <td><strong>${escapeHtml(m.city)}, ${escapeHtml(m.state)}</strong><div class="msa-sub">${escapeHtml(m.msa_name || '')}</div></td>
              <td>${fmtPop(m.population)}</td>
              <td>${m.population_growth != null ? m.population_growth.toFixed(1) + '%' : '—'}</td>
              <td>${m.home_sales_volume ? fmtNum(m.home_sales_volume) : '—'}</td>
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
}

async function loadTwilioStatus() {
  try {
    const res = await fetch('/api/twilio/status');
    if (!res.ok) return;
    state.twilioStatus = await res.json();
    const badge = $('#queue-mock-badge');
    if (badge) badge.hidden = !state.twilioStatus.mock;
  } catch {}
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
      const n = state.pendingDebriefs.length;
      $('#debrief-banner-text').textContent =
        n === 1
          ? 'You have 1 pending debrief — resume to continue.'
          : `You have ${n} pending debriefs — resume the oldest.`;
      banner.hidden = false;
    }
  } catch {}
}

function resumeOldestDebrief() {
  const pending = state.pendingDebriefs || [];
  if (!pending.length) return;
  // Oldest = last in newest-first list.
  const oldest = pending[pending.length - 1];
  openDebriefModal(oldest.id);
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
            <button type="button" class="queue-skip-btn" data-skip="${escapeHtml(r.id)}">Skip today</button>
          </div>
        </div>`;
    })
    .join('');
  // Bind clicks
  $$('.queue-row', list).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.matches('.queue-skip-btn')) return;
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
  $('#qp-phone').textContent = row.phone || 'Missing — add in research';
  $('#qp-owner').textContent = row.owner || '—';

  const angleSec = $('#qp-angle-section');
  if (row.outreach_angle) {
    angleSec.hidden = false;
    $('#qp-angle').textContent = row.outreach_angle;
  } else {
    angleSec.hidden = true;
  }

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
  $('#qp-call-btn').disabled = !row.phone;
  $('#qp-call-active').hidden = true;
  $('#qp-processing').hidden = true;
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
      body: JSON.stringify({ company_id: row.id, to: row.phone || '' }),
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
    clearInterval(state.queueCallTimer);
    state.queueCallTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - state.queueCallStart) / 1000);
      $('#qp-timer').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      if (secs > 2) $('#qp-call-status').textContent = 'Connected';
    }, 500);
  } catch (err) {
    toast('Call failed: ' + err.message, 'error');
    $('#qp-call-btn').hidden = false;
    $('#qp-call-active').hidden = true;
  }
}

async function endQueueCall() {
  clearInterval(state.queueCallTimer);
  const durationSec = Math.max(5, Math.floor((Date.now() - state.queueCallStart) / 1000));
  $('#qp-call-active').hidden = true;
  $('#qp-processing').hidden = false;

  if (!state.queueCallLogId) {
    $('#qp-processing').hidden = true;
    $('#qp-call-btn').hidden = false;
    return;
  }

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
    ${d.scheduled_callback_date ? `<div style="margin-top:4px;"><strong>Callback:</strong> ${escapeHtml(d.scheduled_callback_date)}</div>` : ''}
  `;

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

function validateDebriefForm() {
  const d = state.debriefCall;
  if (!d) return;
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
  const answers = collectDebriefAnswers();
  try {
    const res = await fetch(`/api/calls/${d.id}/debrief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Submit failed', 'error');
      return;
    }
    toast('Debrief saved ✓', 'ok');
    closeDebriefModal();
    await refreshPendingDebriefs();
    // Auto-advance to next row
    if (state.queueActiveId) {
      await loadQueue();
      const nextIdx = state.queue.findIndex((r) => r.id !== state.queueActiveId);
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

async function openCalendarEventModal(eventId, dateHint) {
  state.calendarEditing = null;
  $('#cal-ev-title').value = '';
  $('#cal-ev-desc').value = '';
  $('#cal-ev-date').value = dateHint || new Date().toISOString().slice(0, 10);
  $('#cal-ev-time').value = '10:00';
  $('#cal-ev-company').value = '';
  $('#cal-ev-company-matches').innerHTML = '';
  $('#cal-ev-quote-row').hidden = true;
  $('#cal-ev-quote').textContent = '';
  $('#cal-ev-delete').hidden = true;
  $('#cal-ev-complete').hidden = true;
  $('#cal-modal-title').textContent = 'New Event';

  if (eventId) {
    const ev = state.calendarEvents.find((e) => e.id === eventId);
    if (ev) {
      state.calendarEditing = ev;
      $('#cal-modal-title').textContent = 'Event Details';
      $('#cal-ev-title').value = ev.title || '';
      $('#cal-ev-desc').value = ev.description || '';
      const dt = new Date(ev.starts_at);
      $('#cal-ev-date').value = dt.toISOString().slice(0, 10);
      $('#cal-ev-time').value = dt.toTimeString().slice(0, 5);
      if (ev.transcript_quote) {
        $('#cal-ev-quote-row').hidden = false;
        $('#cal-ev-quote').textContent = ev.transcript_quote;
      }
      $('#cal-ev-delete').hidden = false;
      $('#cal-ev-complete').hidden = ev.completed;
      if (ev.company_id) {
        const match = state.companies.find((c) => c.id === ev.company_id);
        if (match) $('#cal-ev-company').value = match.name;
      }
    }
  }
  $('#cal-modal').hidden = false;
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

  const body = {
    title,
    description: $('#cal-ev-desc').value.trim() || null,
    starts_at,
    company_id: company?.id || null,
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
      if (match) $('#cal-ev-company').value = match.name;
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
      const verts = (u.assigned_verticals || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      const terrs = (u.assigned_territories || []).map((v) => `<span class="settings-user-tag">${escapeHtml(v)}</span>`).join('');
      return `
        <div class="settings-user-row" data-user="${escapeHtml(u.id)}">
          <div>
            <div class="settings-user-name">${escapeHtml(u.name || '—')} <span class="settings-user-role ${u.role}">${escapeHtml(u.role)}</span></div>
            <div class="settings-user-email">${escapeHtml(u.email || '')}</div>
            <div class="settings-user-tags">
              ${verts || '<span class="settings-user-tag">no verticals</span>'}
              ${terrs || '<span class="settings-user-tag">no territories</span>'}
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

function openSettingsUserModal(userId) {
  const u = state.settingsUsers.find((x) => x.id === userId);
  if (!u) return;
  state.settingsEditingUser = u;
  $('#settings-user-title').textContent = `Edit: ${u.name || u.email}`;
  $('#settings-user-role').value = u.role;
  $('#settings-user-territories').value = (u.assigned_territories || []).join(', ');
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
  const territories = $('#settings-user-territories').value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
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
      body: JSON.stringify({ verticals, territories }),
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
  $('#queue-refresh')?.addEventListener('click', loadQueue);
  $('#qp-call-btn')?.addEventListener('click', startQueueCall);
  $('#qp-end-btn')?.addEventListener('click', endQueueCall);

  $('#debrief-submit')?.addEventListener('click', submitDebrief);
  $('#debrief-draft-btn')?.addEventListener('click', saveDebriefAndClose);
  $('#debrief-banner-resume')?.addEventListener('click', resumeOldestDebrief);

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

  $('#settings-cooldown-save')?.addEventListener('click', saveCooldown);
  $('#settings-user-close')?.addEventListener('click', closeSettingsUserModal);
  $('#settings-user-save')?.addEventListener('click', saveSettingsUser);
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
    if (e.key === 'Escape' && !$('#detail-panel').hidden) closeDetail();
  });

  loadStatus();
  loadCompanies();
  loadMarkets();
  loadPipelineStages().then(() => loadPipelineBoard());

  // Phase 2 bootstrap
  bindPhase2();
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
      } else if (ev.type === 'activity_added') {
        if (state.activeId === ev.company_id) openDetail(state.activeId);
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

document.addEventListener('DOMContentLoaded', init);
