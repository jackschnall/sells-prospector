// Canned mock output used when MOCK_MODE=1.
// All values are clearly fake (555 area code, "Sample" names) so no one confuses
// this for real research data. The UI also displays a prominent banner.

function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockDiscovery(geography, blocklistNames = []) {
  const rand = seededRandom(`discovery:${geography || 'us'}`);
  const geoLower = (geography || '').toLowerCase();
  const stateMatch = geoLower.match(/\b([a-z]{2})\b/);
  const stateGuess = stateMatch ? stateMatch[1].toUpperCase() : 'TX';
  const cities = {
    TX: ['Austin', 'Dallas', 'Houston', 'San Antonio', 'Fort Worth'],
    FL: ['Tampa', 'Orlando', 'Jacksonville', 'Miami', 'Fort Lauderdale'],
    GA: ['Atlanta', 'Savannah', 'Augusta', 'Marietta', 'Athens'],
    CA: ['Sacramento', 'San Diego', 'Fresno', 'Bakersfield', 'Long Beach'],
    NC: ['Charlotte', 'Raleigh', 'Durham', 'Greensboro', 'Cary'],
    default: ['Metro City', 'Central', 'Northside', 'Westfield', 'Eastgate'],
  };
  const pool = cities[stateGuess] || cities.default;
  const suffixes = ['Plumbing Co', 'Plumbing Services', '& Sons Plumbing', 'Plumbing Inc', 'Mechanical'];
  const adjectives = ['Heritage', 'Cornerstone', 'Liberty', 'Meridian', 'Summit', 'Lone Star', 'Southern', 'Anchor', 'Patriot', 'Granite', 'Sunbelt', 'Riverside'];

  const normalize = (n) =>
    (n || '')
      .toLowerCase()
      .replace(/[.,'"&]/g, '')
      .replace(/\b(inc|llc|ltd|co|corp|corporation|company|plumbing|services?|the)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const blocked = new Set((blocklistNames || []).map(normalize).filter(Boolean));

  const count = 8 + Math.floor(rand() * 4); // 8-11 candidates
  const candidates = [];
  const seen = new Set();
  let attempt = 0;
  while (candidates.length < count && attempt < 50) {
    attempt++;
    const name = `${adjectives[Math.floor(rand() * adjectives.length)]} ${suffixes[Math.floor(rand() * suffixes.length)]}`;
    const norm = normalize(name);
    if (!norm || seen.has(norm) || blocked.has(norm)) continue;
    seen.add(norm);
    const city = pool[Math.floor(rand() * pool.length)];
    candidates.push({
      name,
      city,
      state: stateGuess,
      website: `https://${name.replace(/\s+/g, '').toLowerCase()}.example.com`,
      phone: `(555) 0${Math.floor(10 + rand() * 89)}-${String(Math.floor(1000 + rand() * 9000)).slice(-4)}`,
    });
  }

  return {
    candidates,
    notes: `MOCK DISCOVERY — ${candidates.length} net-new candidates generated for geography "${geography || 'unspecified'}". ${blocked.size} CRM names excluded. Not real companies.`,
    raw: null,
  };
}

function mockResearch(company) {
  const rand = seededRandom(company.name);
  const rating = +(3.8 + rand() * 1.2).toFixed(1);
  const reviewCount = Math.floor(40 + rand() * 460);
  const pppAmount = Math.floor(150000 + rand() * 850000);
  const estRev = Math.round((pppAmount / 2.5) * 12 * 3.5 / 1_000_000);
  const employees = Math.floor(12 + rand() * 68);
  const years = Math.floor(12 + rand() * 28);
  const ownerTenure = Math.floor(10 + rand() * 22);
  const last4 = String(Math.floor(1000 + rand() * 9000)).slice(-4);
  const ownerName = `Sample Owner ${Math.floor(rand() * 99)}`;

  return {
    google_reviews: {
      rating,
      count: reviewCount,
      recency_note: 'Most recent reviews within last 3 months (mock)',
      sentiment: rating >= 4.3 ? 'Strongly positive' : 'Mixed-positive',
    },
    ppp: {
      amount_usd: pppAmount,
      year: 2020,
      estimated_revenue_range: `~$${estRev}M (directional, 2020 PPP-derived, mock)`,
      notes: 'Mock PPP-derived estimate. Verify with current financials.',
    },
    website: {
      url: company.website || `https://${company.name.replace(/\s+/g, '').toLowerCase()}.example.com`,
      age_years_estimate: Math.floor(8 + rand() * 12),
      services: ['Residential repair', 'Drain cleaning', 'Water heater install', 'Sewer line'],
      service_area: `${company.city || 'Mock City'} metro and surrounding counties`,
      fleet_or_team_signals: `${Math.floor(6 + rand() * 24)} trucks visible on site (mock)`,
    },
    linkedin: {
      employees_estimate: employees,
      owner_profile_url: null,
      notes: 'Mock LinkedIn signal',
    },
    bbb: {
      rating: rand() > 0.3 ? 'A+' : 'B',
      complaint_pattern: 'No significant pattern (mock)',
    },
    owner: {
      name: ownerName,
      tenure_years_estimate: ownerTenure,
      age_estimate: Math.floor(52 + rand() * 16),
      succession_signals: ownerTenure >= 18
        ? ['Long-tenured solo owner', 'No visible next-gen mention on site']
        : [],
    },
    operations: {
      employees_estimate: employees,
      trucks_estimate: Math.floor(6 + rand() * 24),
      locations: rand() > 0.8 ? 2 : 1,
      years_in_business: years,
    },
    growth: {
      review_growth_signal: 'Steady review accumulation over last 24 months (mock)',
      hiring_signals: ['Posted for service techs on Indeed (mock)'],
      expansion_signals: [],
    },
    red_flags: {
      hard_stops: [],
      yellow: rand() > 0.7 ? ['Minor billing complaint pattern (mock)'] : [],
    },
    contact: {
      owner_name: ownerName,
      phone: `(555) 010-${last4}`,
      email: `owner@${(company.name || 'example').replace(/\s+/g, '').toLowerCase()}.example.com`,
      address: company.city ? `${company.city}, ${company.state || ''}`.trim() : null,
      linkedin: null,
      confidence: 'low',
    },
    sources: [
      { label: 'Google Reviews (mock)', url: null },
      { label: 'PPP SBA data (mock)', url: null },
      { label: 'Company Website (mock)', url: null },
      { label: 'BBB (mock)', url: null },
    ],
    data_confidence: 'medium',
    notes: 'MOCK DATA — not real research. Remove MOCK_MODE=1 to use live Claude research.',
  };
}

function mockScoring(company, research) {
  const rand = seededRandom(company.name + ':score');
  const base = 4 + rand() * 5;
  const zillow = research.provider_data?.zillow;
  const medianHome = zillow?.median_home_value || 300000;
  // Home-value → 0-10 curve: $200k≈4, $350k≈6, $500k≈8, $700k+≈9.
  const marketScore = Math.min(
    10,
    Math.max(2, +(2 + (medianHome / 100000) * 1.1).toFixed(1))
  );
  const signals = {
    revenue_proxy: {
      score: +(base + (rand() - 0.5) * 2).toFixed(1),
      raw: research.ppp.estimated_revenue_range || 'unknown',
      notes: 'Mock scoring — PPP-derived revenue within Sells fee bracket',
    },
    operational_quality: {
      score: +(Math.min(10, research.google_reviews.rating * 2 + 0.5)).toFixed(1),
      raw: `${research.google_reviews.rating}★ / ${research.google_reviews.count} reviews`,
      notes: 'Mock — rating and review count signal sale-ability',
    },
    succession_signal: {
      score: +(research.owner.tenure_years_estimate >= 15 ? 7.5 + rand() * 2 : 4 + rand() * 3).toFixed(1),
      raw: `Owner tenure ~${research.owner.tenure_years_estimate} yrs`,
      notes: 'Mock succession heuristic — the #1 sell-side receptivity factor',
    },
    growth_trajectory: {
      score: +(5 + rand() * 3).toFixed(1),
      raw: research.growth.review_growth_signal || 'n/a',
      notes: 'Mock growth signal — buyer attractiveness',
    },
    deal_complexity: {
      score: +(research.operations.locations === 1 ? 7.5 + rand() * 2 : 5 + rand() * 2).toFixed(1),
      raw: `${research.operations.locations} location(s)`,
      notes: 'Single-owner simplicity — cleaner sell-side process (mock)',
    },
    geographic_fit: {
      score: +(5 + rand() * 3).toFixed(1),
      raw: company.state || 'unknown',
      notes: 'Mock — default mid-range',
    },
    market_quality: {
      score: marketScore,
      raw: `Median home $${Math.round(medianHome / 1000)}k${
        zillow?.region ? ` (${zillow.region})` : ''
      }`,
      notes: zillow
        ? `Zillow mock — higher home values correlate with higher-ticket residential plumbing, attractive to PE rollups`
        : 'No Zillow data — default mid-range',
    },
  };

  const rev = research.google_reviews;
  const ppp = research.ppp;
  const ops = research.operations;
  const ownr = research.owner;
  const succScore = signals.succession_signal.score;
  const revScore = signals.revenue_proxy.score;
  const opsScore = signals.operational_quality.score;
  const growthScore = signals.growth_trajectory.score;
  const marketScoreFmt = signals.market_quality.score;
  const yellowCount = research.red_flags.yellow.length;
  const hardCount = research.red_flags.hard_stops.length;
  const flagSentence = hardCount
    ? `${hardCount} hard-stop flag${hardCount === 1 ? '' : 's'} identified — this mandate is not a fit for Sells.`
    : yellowCount
      ? `${yellowCount} yellow flag${yellowCount === 1 ? '' : 's'} noted (${research.red_flags.yellow.join('; ')}) — manageable in diligence.`
      : 'No disqualifiers identified in the available data.';
  const successionSentence = ownr.succession_signals.length
    ? `Owner ${ownr.name} shows a ~${ownr.tenure_years_estimate}-year tenure with ${ownr.succession_signals.join(' and ').toLowerCase()} — the textbook profile of an owner who would take an exit conversation.`
    : `Owner ${ownr.name} has a ~${ownr.tenure_years_estimate}-year tenure but no visible succession-ready signals on the surface — may not be ready yet.`;

  // Receptivity + outreach angle + buyer universe — REQUIRED closing elements.
  const receptivity = base >= 7
    ? 'HIGH'
    : base >= 5
      ? 'MODERATE'
      : 'LOW';
  const outreachAngle = ownr.succession_signals.length
    ? `${ownr.tenure_years_estimate}-year founder with no visible succession path — lead with retirement planning and legacy transition`
    : ownr.tenure_years_estimate >= 15
      ? `Long-tenured owner (${ownr.tenure_years_estimate} yrs) — probe for strategic alternatives and optionality`
      : `Established operator (${ownr.tenure_years_estimate} yrs) — open with market-check framing rather than exit push`;
  const buyerUniverse = base >= 7
    ? 'PE roll-ups (primary — several active plumbing platforms), strategic consolidators, family-office-backed search funds (secondary)'
    : base >= 5
      ? 'Regional strategic consolidators (primary), search funds, smaller PE platforms as secondary'
      : 'Limited buyer universe — likely only local strategic buyers; not fit for a broad process';

  const recommendation = base >= 7
    ? 'Recommend prioritizing for outreach within 30 days.'
    : base >= 5
      ? 'Recommend parking on Monitor — revisit after revenue verification and a second-pass owner profile.'
      : 'Recommend passing — signal mix does not justify origination bandwidth.';

  const city = company.city || 'the local market';
  const st = company.state ? `, ${company.state}` : '';

  const summary = [
    `MOCK SUMMARY — ${company.name} (${city}${st}) shows ${rev.count} Google reviews at ${rev.rating} stars and a 2020 PPP draw of $${ppp.amount_usd.toLocaleString()}, implying a ${ppp.estimated_revenue_range} revenue run-rate squarely within Sells' fee bracket.`,
    `Operations look like a ~${ops.employees_estimate}-employee, ~${ops.trucks_estimate}-truck shop operating ${ops.years_in_business} years out of ${ops.locations} location${ops.locations === 1 ? '' : 's'}, consistent with the PPP-implied scale and sale-ability.`,
    successionSentence,
    `Signal scores: succession ${succScore}/10, revenue_proxy ${revScore}/10, operational_quality ${opsScore}/10, growth_trajectory ${growthScore}/10, market_quality ${marketScoreFmt}/10 — driven by review quality, PPP-derived revenue, and owner tenure.`,
    flagSentence,
    `${recommendation} Owner receptivity likely ${receptivity}. Outreach angle: ${outreachAngle}. Buyer universe: ${buyerUniverse}. (Directional only — MOCK_MODE.)`,
  ].join(' ');

  return {
    signals,
    final_score: null, // server recomputes from weights
    tier: null,
    summary,
    outreach_angle: outreachAngle,
  };
}

function mockFlags(company, research) {
  return {
    hard_stops: research.red_flags.hard_stops.map((f) => ({ flag: f, evidence: 'mock' })),
    yellow_flags: research.red_flags.yellow.map((f) => ({ flag: f, evidence: 'mock' })),
  };
}

function mockContacts(company, research) {
  const last4 = String(Math.floor(1000 + (seededRandom(company.name)() * 9000))).slice(-4);
  return {
    owner: research.owner.name,
    phone: `(555) 010-${last4}`,
    email: `owner@${(company.name || 'example').replace(/\s+/g, '').toLowerCase()}.example.com`,
    address: company.city ? `${company.city}, ${company.state || ''}`.trim() : null,
    linkedin: null,
    confidence: 'low',
  };
}

function mockProviderData(company) {
  // Mirrors the shape returned by server/providers/index.js so code paths
  // downstream of research don't care whether we're in mock mode or live.
  const providers = require('./providers');
  // Providers themselves detect MOCK_MODE and return mock payloads.
  // Wrap in a sync path for tests; the real call in research.js is async.
  return providers.enrichResearch(company);
}

module.exports = { mockDiscovery, mockResearch, mockScoring, mockFlags, mockContacts, mockProviderData };
