// Population-based market sizing.
//
// For each unique "city, state" in the current prospect list, estimate:
//   - metro area population (web_search or mock)
//   - addressable plumbing company count (heuristic: ~1 per 250,000 people)
//   - loaded plumber count (how many companies in that market are in our DB)
//   - tier: hot | warm | cold
//
// Tier logic:
//   hot  — loaded >= 60% of addressable (we have strong coverage to mine)
//   warm — 20% <= loaded < 60% (decent coverage, room to grow)
//   cold — loaded < 20% (sparse — may need to source more targets before working)
//
// Market tier is used as a tiebreaker for companies with identical scores
// and surfaces in a sidebar panel so the deal team can see which metros
// are worth the partner's time right now.

const { MODELS, callWithWebSearch } = require('./claude');
const { upsertMarket, getMarket, listMarkets, countCompaniesInMarket } = require('./db');

// Addressable plumbing companies per person. BLS QCEW shows ~130K plumbing
// establishments nationally against ~335M people → ~1 per 2,570 people for
// ALL plumbers including single-operator LLCs. We target the $5-50M segment
// which is ~1 in every 50-100 plumbers, so effectively ~1 per 200-300k.
// We use 250k as the midpoint.
const ADDRESSABLE_PER_CAPITA = 1 / 250000;

function marketKey(city, state) {
  return `${String(city || '').trim().toLowerCase()}|${String(state || '').trim().toUpperCase()}`;
}

function tierFor(loaded, addressable) {
  if (!addressable || addressable <= 0) return 'cold';
  const coverage = loaded / addressable;
  if (coverage >= 0.6) return 'hot';
  if (coverage >= 0.2) return 'warm';
  return 'cold';
}

function scoreFor(loaded, addressable) {
  if (!addressable || addressable <= 0) return 0;
  // Map coverage [0..1] → 0..10, but soft-cap: 50% coverage already scores ~8.
  const coverage = Math.min(1, loaded / addressable);
  return +(Math.min(10, coverage * 16).toFixed(1));
}

// ---------------- MOCK / LIVE population lookup ----------------

// Rough metro population anchors for common seed cities. Used only by the
// mock path and as a sanity fallback.
const CITY_ANCHORS = {
  'austin|tx': 2400000, 'dallas|tx': 7700000, 'houston|tx': 7200000, 'san antonio|tx': 2600000,
  'phoenix|az': 4900000, 'tucson|az': 1050000,
  'denver|co': 2950000, 'colorado springs|co': 770000,
  'atlanta|ga': 6100000, 'charlotte|nc': 2700000, 'raleigh|nc': 1450000,
  'nashville|tn': 2050000, 'memphis|tn': 1330000,
  'tampa|fl': 3200000, 'orlando|fl': 2700000, 'miami|fl': 6200000, 'jacksonville|fl': 1650000,
  'chicago|il': 9500000, 'indianapolis|in': 2100000, 'columbus|oh': 2150000, 'cleveland|oh': 2050000,
  'minneapolis|mn': 3700000, 'detroit|mi': 4300000, 'st louis|mo': 2800000, 'kansas city|mo': 2200000,
  'boston|ma': 4900000, 'new york|ny': 19600000, 'philadelphia|pa': 6200000,
  'los angeles|ca': 13200000, 'san diego|ca': 3300000, 'san francisco|ca': 4700000,
  'sacramento|ca': 2400000, 'san jose|ca': 2000000,
  'seattle|wa': 4000000, 'portland|or': 2500000,
  'salt lake city|ut': 1260000, 'las vegas|nv': 2300000,
  'washington|dc': 6300000, 'baltimore|md': 2800000,
};

function mockPopulation(city, state) {
  const key = marketKey(city, state);
  if (CITY_ANCHORS[key]) return CITY_ANCHORS[key];
  // Deterministic seeded random per city so numbers are stable across runs.
  const seed = key + ':pop';
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const t = Math.imul(h ^ (h >>> 15), h | 1);
  const rand = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  // 80k – 1.5M range for unknown metros.
  return Math.round(80000 + rand * 1420000);
}

const MARKET_SYSTEM_PROMPT = `
You are a market research analyst. Given a U.S. city and state, return the current estimated metropolitan statistical area (MSA) population. Use web_search to verify with the most recent Census or reputable source.

Return a FINAL message containing ONLY a JSON object (no code fences):

{
  "population": number,
  "msa_name": string,
  "source_label": string,
  "source_url": string|null,
  "confidence": "high"|"medium"|"low"
}

If the metro is not identifiable, return population as your best estimate with confidence "low". Never return null or 0 for population.
`.trim();

async function lookupPopulationLive(city, state) {
  const { parsed, sources } = await callWithWebSearch({
    model: MODELS.worker,
    system: MARKET_SYSTEM_PROMPT,
    user: `City: ${city}\nState: ${state}\n\nLook up the current metropolitan area population and return the JSON object.`,
    maxTokens: 1024,
    maxIterations: 4,
    maxSearches: 3,
  });
  if (!parsed || !parsed.population || parsed.population <= 0) {
    return null;
  }
  return {
    population: parsed.population,
    msa_name: parsed.msa_name || `${city}, ${state}`,
    confidence: parsed.confidence || 'medium',
    sources: sources.length ? sources : parsed.source_url
      ? [{ label: parsed.source_label || 'source', url: parsed.source_url }]
      : [],
  };
}

// ---------------- Public API ----------------

async function analyzeMarket(city, state, { force = false } = {}) {
  if (!city || !state) return null;
  const key = marketKey(city, state);

  const existing = getMarket(key);
  const loaded = countCompaniesInMarket(city, state);

  // Reuse cached population if we have it, unless force=true. Population is
  // stable; only the loaded count refreshes each run.
  if (existing && existing.population && !force) {
    const addressable = Math.max(1, Math.round(existing.population * ADDRESSABLE_PER_CAPITA));
    const tier = tierFor(loaded, addressable);
    const score = scoreFor(loaded, addressable);
    const row = {
      key,
      city,
      state,
      population: existing.population,
      msa_name: existing.msa_name,
      addressable,
      loaded,
      tier,
      score,
      confidence: existing.confidence,
      sources_json: existing.sources_json || '[]',
    };
    upsertMarket(row);
    return row;
  }

  let population;
  let msa_name = `${city}, ${state}`;
  let confidence = 'low';
  let sources = [];

  if (process.env.MOCK_MODE === '1' || !process.env.ANTHROPIC_API_KEY) {
    population = mockPopulation(city, state);
    msa_name = `${city}, ${state} Metro (mock)`;
    confidence = 'medium';
  } else {
    try {
      const live = await lookupPopulationLive(city, state);
      if (live) {
        population = live.population;
        msa_name = live.msa_name;
        confidence = live.confidence;
        sources = live.sources;
      } else {
        population = mockPopulation(city, state);
        confidence = 'low';
      }
    } catch (err) {
      console.warn(`[markets] live lookup failed for ${city}, ${state}: ${err.message}`);
      population = mockPopulation(city, state);
      confidence = 'low';
    }
  }

  const addressable = Math.max(1, Math.round(population * ADDRESSABLE_PER_CAPITA));
  const tier = tierFor(loaded, addressable);
  const score = scoreFor(loaded, addressable);

  const row = {
    key,
    city,
    state,
    population,
    msa_name,
    addressable,
    loaded,
    tier,
    score,
    confidence,
    sources_json: JSON.stringify(sources),
  };
  upsertMarket(row);
  return row;
}

function listAll() {
  return listMarkets();
}

module.exports = {
  analyzeMarket,
  listAll,
  marketKey,
  tierFor,
  ADDRESSABLE_PER_CAPITA,
};
