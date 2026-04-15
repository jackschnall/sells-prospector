const XLSX = require('xlsx');

// Sell-side user-facing tier labels (internal values stay the same in DB).
const TIER_LABELS = {
  'strong-buy': 'Likely to Sell',
  watchlist: 'Possible',
  pass: 'Unlikely',
};

// Tier → fill color (ARGB hex with leading "FF" alpha). Applied to the
// Tier cell only so the Rankings sheet reads like a triage grid.
const TIER_FILLS = {
  'strong-buy': 'FFE8F3E8', // soft green
  watchlist: 'FFFFF5E0', // soft amber
  pass: 'FFF4E6E6', // soft red
};

const TIER_FONTS = {
  'strong-buy': 'FF1F5D2E',
  watchlist: 'FF8A6E1A',
  pass: 'FF8A2A2A',
};

const STAGE_LABELS = {
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

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s; // JSONB already parsed by pg
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function flagsSummary(flags_json) {
  const f = safeJson(flags_json) || { hard_stops: [], yellow_flags: [] };
  const hard = (f.hard_stops || []).map((x) => x.flag || x).filter(Boolean);
  const yellow = (f.yellow_flags || []).map((x) => x.flag || x).filter(Boolean);
  return { hard, yellow };
}

function signalScore(signals, key) {
  const s = signals?.[key];
  if (!s || typeof s.score !== 'number') return '';
  return s.score;
}

function signalRaw(signals, key) {
  const s = signals?.[key];
  if (!s) return '';
  return s.raw || s.notes || '';
}

// --- Rankings sheet -------------------------------------------------------
// 20 columns matching the sell-side origination view. Ordered by score_desc
// by the caller.
const RANKINGS_COLUMNS = [
  { key: 'rank', header: 'Rank', width: 6 },
  { key: 'name', header: 'Company', width: 32 },
  { key: 'tier', header: 'Tier', width: 14 },
  { key: 'score', header: 'Score', width: 8 },
  { key: 'city', header: 'City', width: 18 },
  { key: 'state', header: 'State', width: 6 },
  { key: 'owner', header: 'Owner', width: 22 },
  { key: 'phone', header: 'Phone', width: 16 },
  { key: 'email', header: 'Email', width: 28 },
  { key: 'website', header: 'Website', width: 32 },
  { key: 'address', header: 'Address', width: 28 },
  { key: 'linkedin', header: 'LinkedIn', width: 28 },
  { key: 'pipeline_stage', header: 'Pipeline Stage', width: 20 },
  { key: 'in_crm', header: 'Already in CRM', width: 14 },
  { key: 'marked', header: 'Marked for Outreach', width: 18 },
  { key: 'outreach_angle', header: 'Outreach Angle', width: 40 },
  { key: 'summary', header: 'Summary', width: 60 },
  { key: 'hard_stops', header: 'Hard Stops', width: 40 },
  { key: 'yellow_flags', header: 'Yellow Flags', width: 40 },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'last_researched', header: 'Last Researched', width: 20 },
];

function buildRankingsRows(companies) {
  return companies.map((c, i) => {
    const { hard, yellow } = flagsSummary(c.flags_json);
    return {
      rank: i + 1,
      name: c.name || '',
      tier: TIER_LABELS[c.tier] || c.tier || '',
      score: typeof c.score === 'number' ? c.score : '',
      city: c.city || '',
      state: c.state || '',
      owner: c.owner || '',
      phone: c.phone || '',
      email: c.email || '',
      website: c.website || '',
      address: c.address || '',
      linkedin: c.linkedin || '',
      pipeline_stage: STAGE_LABELS[c.pipeline_stage] || c.pipeline_stage || 'No Contact',
      in_crm: c.crm_known ? 'Yes' : 'No',
      marked: c.marked_for_outreach ? 'Yes' : 'No',
      outreach_angle: c.outreach_angle || '',
      summary: c.summary || '',
      hard_stops: hard.join('; '),
      yellow_flags: yellow.join('; '),
      status: c.status || '',
      last_researched: c.last_researched_at || '',
      _tier: c.tier || '',
    };
  });
}

function styleRankingsSheet(ws, rows) {
  // Column widths.
  ws['!cols'] = RANKINGS_COLUMNS.map((c) => ({ wch: c.width }));

  // Freeze the top row.
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!views'] = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2' }];

  // Header styling.
  for (let c = 0; c < RANKINGS_COLUMNS.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = ws[addr];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, color: { rgb: 'FFFFFFFF' }, name: 'Source Sans 3' },
      fill: { patternType: 'solid', fgColor: { rgb: 'FF0D1B2A' } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
  }

  // Tier column color-coding. Tier is column index 2.
  const tierCol = 2;
  for (let r = 0; r < rows.length; r++) {
    const internalTier = rows[r]._tier;
    const fill = TIER_FILLS[internalTier];
    const fontColor = TIER_FONTS[internalTier];
    if (!fill) continue;
    const addr = XLSX.utils.encode_cell({ r: r + 1, c: tierCol });
    const cell = ws[addr];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, color: { rgb: fontColor }, name: 'Source Sans 3' },
      fill: { patternType: 'solid', fgColor: { rgb: fill } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
  }
}

// --- Signal Detail sheet --------------------------------------------------
// One row per (company × signal). Gives the deal team a pivot-friendly view
// to sort/filter by any signal's score and see the raw evidence.
const SIGNAL_ORDER = [
  'revenue_proxy',
  'operational_quality',
  'succession_signal',
  'growth_trajectory',
  'deal_complexity',
  'geographic_fit',
  'market_quality',
];

const SIGNAL_LABELS = {
  revenue_proxy: 'Revenue Proxy',
  operational_quality: 'Operational Quality',
  succession_signal: 'Succession Signal',
  growth_trajectory: 'Growth Trajectory',
  deal_complexity: 'Deal Complexity',
  geographic_fit: 'Geographic Fit',
  market_quality: 'Market Quality',
};

function buildSignalDetailRows(companies) {
  const rows = [];
  for (const c of companies) {
    const signals = safeJson(c.signals_json) || {};
    for (const key of SIGNAL_ORDER) {
      const s = signals[key];
      if (!s) continue;
      rows.push({
        company: c.name || '',
        tier: TIER_LABELS[c.tier] || c.tier || '',
        overall_score: typeof c.score === 'number' ? c.score : '',
        signal: SIGNAL_LABELS[key] || key,
        signal_score: typeof s.score === 'number' ? s.score : '',
        raw: s.raw || '',
        notes: s.notes || '',
      });
    }
  }
  return rows;
}

function styleSignalSheet(ws) {
  ws['!cols'] = [
    { wch: 32 },
    { wch: 14 },
    { wch: 12 },
    { wch: 22 },
    { wch: 12 },
    { wch: 40 },
    { wch: 40 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!views'] = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2' }];

  // Header styling.
  const headerCount = 7;
  for (let c = 0; c < headerCount; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = ws[addr];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, color: { rgb: 'FFFFFFFF' }, name: 'Source Sans 3' },
      fill: { patternType: 'solid', fgColor: { rgb: 'FF0D1B2A' } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
  }
}

// --- Workbook -------------------------------------------------------------
function buildWorkbook(companies, geography = '') {
  const wb = XLSX.utils.book_new();

  // Rankings sheet.
  const rankingRows = buildRankingsRows(companies);
  const rankingsForSheet = rankingRows.map((r) => {
    // Strip the internal tier marker before writing.
    const { _tier, ...rest } = r;
    return rest;
  });
  const headers = RANKINGS_COLUMNS.map((c) => c.header);
  const rankingsWs = XLSX.utils.json_to_sheet(rankingsForSheet, { header: RANKINGS_COLUMNS.map((c) => c.key) });
  // json_to_sheet uses the keys as headers by default; overwrite row 1.
  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    rankingsWs[addr] = { t: 's', v: headers[c] };
  }
  styleRankingsSheet(rankingsWs, rankingRows);
  XLSX.utils.book_append_sheet(wb, rankingsWs, 'Rankings');

  // Signal Detail sheet.
  const signalRows = buildSignalDetailRows(companies);
  const signalHeaders = ['Company', 'Tier', 'Overall Score', 'Signal', 'Signal Score', 'Raw', 'Notes'];
  const signalWs = XLSX.utils.json_to_sheet(signalRows, {
    header: ['company', 'tier', 'overall_score', 'signal', 'signal_score', 'raw', 'notes'],
  });
  for (let c = 0; c < signalHeaders.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    signalWs[addr] = { t: 's', v: signalHeaders[c] };
  }
  styleSignalSheet(signalWs);
  XLSX.utils.book_append_sheet(wb, signalWs, 'Signal Detail');

  // Optional cover metadata as a named property. Harmless if omitted.
  wb.Props = {
    Title: 'Sells M&A Origination Pipeline',
    Subject: geography ? `Geography: ${geography}` : 'Sell-side mandate origination',
    Author: 'Sells M&A Prospector',
    CreatedDate: new Date(),
  };

  return wb;
}

function workbookToBuffer(wb) {
  // cellStyles: true preserves the `s` styling we set on cells.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function buildFilename(geography) {
  const date = new Date().toISOString().slice(0, 10);
  const geo = String(geography || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  const geoPart = geo || 'all';
  return `sells-prospector-${geoPart}-${date}.xlsx`;
}

module.exports = { buildWorkbook, workbookToBuffer, buildFilename };
