// Market Intelligence — scored rankings of top US metros for plumbing M&A prospecting.
//
// Tier 1 signals (60% weight): Population/growth, median home value, housing permits,
//   housing age, plumbing company density
// Tier 2 signals (25% weight): M&A activity, PE platform presence, owner age demographics
// Tier 3 signals (15% weight): Geographic fit (Southeast/Sun Belt preference)
//
// Saturation: Fresh (<25%), Active (25-75%), Saturated (>75%)

const { db } = require('./db');

// ---------- Seed data for ~40 top metros ----------
// Sources: Census Bureau, Zillow, Census Building Permits Survey, BLS QCEW (approximate 2025 values)
const METRO_SEED = [
  // Tier 1 Sun Belt
  { city: 'Dallas', state: 'TX', msa_name: 'Dallas-Fort Worth-Arlington', population: 8100000, population_growth: 1.8, median_home_value: 370000, housing_permits: 65000, housing_age_score: 6.5, plumbing_density: 42, ma_activity_score: 8.5 },
  { city: 'Houston', state: 'TX', msa_name: 'Houston-The Woodlands-Sugar Land', population: 7300000, population_growth: 1.6, median_home_value: 310000, housing_permits: 55000, housing_age_score: 6.0, plumbing_density: 45, ma_activity_score: 8.0 },
  { city: 'Phoenix', state: 'AZ', msa_name: 'Phoenix-Mesa-Chandler', population: 5100000, population_growth: 2.1, median_home_value: 430000, housing_permits: 45000, housing_age_score: 5.5, plumbing_density: 38, ma_activity_score: 7.5 },
  { city: 'Atlanta', state: 'GA', msa_name: 'Atlanta-Sandy Springs-Alpharetta', population: 6300000, population_growth: 1.4, median_home_value: 380000, housing_permits: 40000, housing_age_score: 6.8, plumbing_density: 36, ma_activity_score: 8.0 },
  { city: 'Tampa', state: 'FL', msa_name: 'Tampa-St. Petersburg-Clearwater', population: 3300000, population_growth: 1.7, median_home_value: 380000, housing_permits: 25000, housing_age_score: 7.2, plumbing_density: 40, ma_activity_score: 7.0 },
  { city: 'Charlotte', state: 'NC', msa_name: 'Charlotte-Concord-Gastonia', population: 2800000, population_growth: 2.0, median_home_value: 370000, housing_permits: 22000, housing_age_score: 6.0, plumbing_density: 35, ma_activity_score: 7.5 },
  { city: 'Nashville', state: 'TN', msa_name: 'Nashville-Davidson-Murfreesboro', population: 2100000, population_growth: 1.5, median_home_value: 420000, housing_permits: 18000, housing_age_score: 6.5, plumbing_density: 38, ma_activity_score: 7.5 },
  { city: 'Orlando', state: 'FL', msa_name: 'Orlando-Kissimmee-Sanford', population: 2800000, population_growth: 2.0, median_home_value: 380000, housing_permits: 20000, housing_age_score: 5.8, plumbing_density: 37, ma_activity_score: 6.5 },
  { city: 'Austin', state: 'TX', msa_name: 'Austin-Round Rock-Georgetown', population: 2500000, population_growth: 2.8, median_home_value: 450000, housing_permits: 22000, housing_age_score: 5.0, plumbing_density: 34, ma_activity_score: 7.0 },
  { city: 'San Antonio', state: 'TX', msa_name: 'San Antonio-New Braunfels', population: 2700000, population_growth: 1.4, median_home_value: 290000, housing_permits: 16000, housing_age_score: 6.2, plumbing_density: 36, ma_activity_score: 6.0 },
  { city: 'Jacksonville', state: 'FL', msa_name: 'Jacksonville', population: 1700000, population_growth: 1.6, median_home_value: 350000, housing_permits: 14000, housing_age_score: 6.5, plumbing_density: 38, ma_activity_score: 6.0 },
  { city: 'Raleigh', state: 'NC', msa_name: 'Raleigh-Cary', population: 1500000, population_growth: 2.2, median_home_value: 410000, housing_permits: 18000, housing_age_score: 5.5, plumbing_density: 32, ma_activity_score: 6.5 },

  // Secondary Sun Belt
  { city: 'Birmingham', state: 'AL', msa_name: 'Birmingham-Hoover', population: 1150000, population_growth: 0.3, median_home_value: 230000, housing_permits: 5500, housing_age_score: 8.0, plumbing_density: 42, ma_activity_score: 5.5 },
  { city: 'Greenville', state: 'SC', msa_name: 'Greenville-Anderson-Easley', population: 950000, population_growth: 1.4, median_home_value: 280000, housing_permits: 8000, housing_age_score: 7.0, plumbing_density: 35, ma_activity_score: 5.0 },
  { city: 'Knoxville', state: 'TN', msa_name: 'Knoxville', population: 900000, population_growth: 0.9, median_home_value: 310000, housing_permits: 5500, housing_age_score: 7.5, plumbing_density: 38, ma_activity_score: 4.5 },
  { city: 'Chattanooga', state: 'TN', msa_name: 'Chattanooga', population: 580000, population_growth: 0.8, median_home_value: 280000, housing_permits: 3500, housing_age_score: 7.5, plumbing_density: 40, ma_activity_score: 4.0 },
  { city: 'Baton Rouge', state: 'LA', msa_name: 'Baton Rouge', population: 870000, population_growth: 0.2, median_home_value: 230000, housing_permits: 4000, housing_age_score: 7.0, plumbing_density: 44, ma_activity_score: 4.5 },
  { city: 'New Orleans', state: 'LA', msa_name: 'New Orleans-Metairie', population: 1250000, population_growth: 0.1, median_home_value: 260000, housing_permits: 4500, housing_age_score: 8.5, plumbing_density: 46, ma_activity_score: 5.0 },
  { city: 'Savannah', state: 'GA', msa_name: 'Savannah', population: 420000, population_growth: 1.5, median_home_value: 310000, housing_permits: 4000, housing_age_score: 7.5, plumbing_density: 36, ma_activity_score: 3.5 },
  { city: 'Charleston', state: 'SC', msa_name: 'Charleston-North Charleston', population: 850000, population_growth: 1.8, median_home_value: 400000, housing_permits: 7000, housing_age_score: 7.0, plumbing_density: 34, ma_activity_score: 5.0 },
  { city: 'Columbia', state: 'SC', msa_name: 'Columbia', population: 850000, population_growth: 0.8, median_home_value: 230000, housing_permits: 4500, housing_age_score: 7.0, plumbing_density: 36, ma_activity_score: 3.5 },
  { city: 'Pensacola', state: 'FL', msa_name: 'Pensacola-Ferry Pass-Brent', population: 520000, population_growth: 1.2, median_home_value: 300000, housing_permits: 4000, housing_age_score: 7.0, plumbing_density: 38, ma_activity_score: 3.5 },
  { city: 'Huntsville', state: 'AL', msa_name: 'Huntsville', population: 520000, population_growth: 1.8, median_home_value: 300000, housing_permits: 5000, housing_age_score: 6.0, plumbing_density: 34, ma_activity_score: 4.0 },
  { city: 'Fayetteville', state: 'AR', msa_name: 'Fayetteville-Springdale-Rogers', population: 600000, population_growth: 2.2, median_home_value: 290000, housing_permits: 5000, housing_age_score: 4.5, plumbing_density: 30, ma_activity_score: 4.0 },

  // Midwest Growth
  { city: 'Indianapolis', state: 'IN', msa_name: 'Indianapolis-Carmel-Anderson', population: 2100000, population_growth: 0.8, median_home_value: 270000, housing_permits: 14000, housing_age_score: 7.5, plumbing_density: 38, ma_activity_score: 6.0 },
  { city: 'Columbus', state: 'OH', msa_name: 'Columbus', population: 2200000, population_growth: 1.0, median_home_value: 290000, housing_permits: 12000, housing_age_score: 7.0, plumbing_density: 36, ma_activity_score: 5.5 },
  { city: 'Kansas City', state: 'MO', msa_name: 'Kansas City', population: 2200000, population_growth: 0.6, median_home_value: 280000, housing_permits: 10000, housing_age_score: 7.5, plumbing_density: 38, ma_activity_score: 5.5 },
  { city: 'Louisville', state: 'KY', msa_name: 'Louisville/Jefferson County', population: 1300000, population_growth: 0.4, median_home_value: 250000, housing_permits: 5500, housing_age_score: 7.5, plumbing_density: 40, ma_activity_score: 4.5 },
  { city: 'Cincinnati', state: 'OH', msa_name: 'Cincinnati', population: 2250000, population_growth: 0.3, median_home_value: 260000, housing_permits: 8000, housing_age_score: 8.0, plumbing_density: 40, ma_activity_score: 5.0 },
  { city: 'Memphis', state: 'TN', msa_name: 'Memphis', population: 1350000, population_growth: 0.1, median_home_value: 210000, housing_permits: 4500, housing_age_score: 8.0, plumbing_density: 42, ma_activity_score: 4.5 },

  // Other high-potential
  { city: 'Denver', state: 'CO', msa_name: 'Denver-Aurora-Lakewood', population: 2950000, population_growth: 1.2, median_home_value: 550000, housing_permits: 22000, housing_age_score: 6.5, plumbing_density: 32, ma_activity_score: 7.0 },
  { city: 'Las Vegas', state: 'NV', msa_name: 'Las Vegas-Henderson-Paradise', population: 2400000, population_growth: 2.0, median_home_value: 420000, housing_permits: 18000, housing_age_score: 4.5, plumbing_density: 34, ma_activity_score: 6.0 },
  { city: 'Salt Lake City', state: 'UT', msa_name: 'Salt Lake City', population: 1300000, population_growth: 1.5, median_home_value: 480000, housing_permits: 10000, housing_age_score: 6.0, plumbing_density: 30, ma_activity_score: 5.5 },
  { city: 'Boise', state: 'ID', msa_name: 'Boise City', population: 800000, population_growth: 2.5, median_home_value: 430000, housing_permits: 8000, housing_age_score: 5.0, plumbing_density: 28, ma_activity_score: 4.0 },
  { city: 'Miami', state: 'FL', msa_name: 'Miami-Fort Lauderdale-Pompano Beach', population: 6200000, population_growth: 0.8, median_home_value: 480000, housing_permits: 30000, housing_age_score: 7.5, plumbing_density: 36, ma_activity_score: 7.0 },
  { city: 'Oklahoma City', state: 'OK', msa_name: 'Oklahoma City', population: 1450000, population_growth: 0.8, median_home_value: 220000, housing_permits: 8000, housing_age_score: 7.0, plumbing_density: 42, ma_activity_score: 4.5 },
  { city: 'Tulsa', state: 'OK', msa_name: 'Tulsa', population: 1000000, population_growth: 0.4, median_home_value: 200000, housing_permits: 4500, housing_age_score: 7.5, plumbing_density: 44, ma_activity_score: 4.0 },
  { city: 'Little Rock', state: 'AR', msa_name: 'Little Rock-North Little Rock-Conway', population: 750000, population_growth: 0.3, median_home_value: 200000, housing_permits: 3000, housing_age_score: 7.5, plumbing_density: 40, ma_activity_score: 3.5 },
  { city: 'Richmond', state: 'VA', msa_name: 'Richmond', population: 1350000, population_growth: 0.8, median_home_value: 340000, housing_permits: 8000, housing_age_score: 7.5, plumbing_density: 34, ma_activity_score: 5.0 },
  { city: 'Jackson', state: 'MS', msa_name: 'Jackson', population: 580000, population_growth: -0.2, median_home_value: 170000, housing_permits: 2000, housing_age_score: 8.0, plumbing_density: 42, ma_activity_score: 3.0 },
];

// ---------- Scoring ----------

// Normalize a value to 0-10 scale given a range [min, max].
function normalize(value, min, max) {
  if (max === min) return 5;
  return Math.max(0, Math.min(10, ((value - min) / (max - min)) * 10));
}

function scoreMarket(m) {
  // Tier 1 signals (60% total weight)
  const popScore = normalize(m.population, 300000, 8000000);            // bigger = better (more targets)
  const growthScore = normalize(m.population_growth, -0.5, 3.0);       // faster growth = better
  const homeValueScore = normalize(m.median_home_value, 150000, 550000); // higher = more plumbing spend
  const permitsScore = normalize(m.housing_permits, 1000, 65000);       // more permits = growth
  const housingAgeScore = m.housing_age_score;                          // already 0-10, higher = older = more repair
  const densityScore = normalize(m.plumbing_density, 25, 50);          // more plumbers = bigger market

  // Tier 1 composite (average of sub-signals, then weighted 60%)
  const tier1 = (popScore * 0.15 + growthScore * 0.25 + homeValueScore * 0.15 +
                 permitsScore * 0.15 + housingAgeScore * 0.15 + densityScore * 0.15);

  // Tier 2 signals (25% weight) — M&A activity is our primary proxy
  const tier2 = m.ma_activity_score; // already 0-10

  // Tier 3 signals (15% weight) — geographic fit
  // Southeast US and Sun Belt states score higher
  const sunBeltStates = ['TX', 'FL', 'GA', 'NC', 'SC', 'TN', 'AL', 'LA', 'AZ', 'NV', 'AR', 'MS'];
  const warmStates = ['CO', 'UT', 'OK', 'VA', 'KY', 'IN', 'OH', 'MO', 'ID'];
  let geoScore = 4; // default
  if (sunBeltStates.includes(m.state)) geoScore = 9;
  else if (warmStates.includes(m.state)) geoScore = 6;
  const tier3 = geoScore;

  // Composite
  const composite = tier1 * 0.60 + tier2 * 0.25 + tier3 * 0.15;
  return +composite.toFixed(1);
}

function saturationStatus(loaded, addressable) {
  if (!addressable || addressable <= 0) return 'Fresh';
  const pct = loaded / addressable;
  if (pct >= 0.75) return 'Saturated';
  if (pct >= 0.25) return 'Active';
  return 'Fresh';
}

function marketKey(city, state) {
  return `${String(city || '').trim().toLowerCase()}|${String(state || '').trim().toUpperCase()}`;
}

// ---------- Seed ----------

function seedMarkets() {
  const ADDRESSABLE_PER_CAPITA = 1 / 250000;

  const upsert = db.prepare(`
    INSERT INTO markets (
      key, city, state, msa_name, population, population_growth,
      median_home_value, housing_permits, housing_age_score,
      plumbing_density, ma_activity_score,
      addressable, loaded, market_score, saturation_status,
      tier, score, confidence, sources_json,
      analyzed_at, updated_at
    ) VALUES (
      @key, @city, @state, @msa_name, @population, @population_growth,
      @median_home_value, @housing_permits, @housing_age_score,
      @plumbing_density, @ma_activity_score,
      @addressable, @loaded, @market_score, @saturation_status,
      @tier, @score, @confidence, @sources_json,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(key) DO UPDATE SET
      msa_name = excluded.msa_name,
      population = excluded.population,
      population_growth = excluded.population_growth,
      median_home_value = excluded.median_home_value,
      housing_permits = excluded.housing_permits,
      housing_age_score = excluded.housing_age_score,
      plumbing_density = excluded.plumbing_density,
      ma_activity_score = excluded.ma_activity_score,
      addressable = excluded.addressable,
      loaded = excluded.loaded,
      market_score = excluded.market_score,
      saturation_status = excluded.saturation_status,
      tier = excluded.tier,
      score = excluded.score,
      confidence = excluded.confidence,
      updated_at = datetime('now')
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM companies
    WHERE LOWER(TRIM(state)) = LOWER(TRIM(?))
  `);

  const results = [];
  for (const m of METRO_SEED) {
    const key = marketKey(m.city, m.state);
    const addressable = Math.max(1, Math.round(m.population * ADDRESSABLE_PER_CAPITA));
    const loaded = countStmt.get(m.state)?.n || 0;
    const ms = scoreMarket(m);
    const sat = saturationStatus(loaded, addressable);

    // Coverage-based tier/score for backward compat
    const coverage = addressable > 0 ? loaded / addressable : 0;
    const coverageScore = +(Math.min(10, coverage * 16).toFixed(1));
    const coverageTier = coverage >= 0.6 ? 'hot' : coverage >= 0.2 ? 'warm' : 'cold';

    const row = {
      key,
      city: m.city,
      state: m.state,
      msa_name: m.msa_name,
      population: m.population,
      population_growth: m.population_growth,
      median_home_value: m.median_home_value,
      housing_permits: m.housing_permits,
      housing_age_score: m.housing_age_score,
      plumbing_density: m.plumbing_density,
      ma_activity_score: m.ma_activity_score,
      addressable,
      loaded,
      market_score: ms,
      saturation_status: sat,
      tier: coverageTier,
      score: coverageScore,
      confidence: 'high',
      sources_json: '[]',
    };
    upsert.run(row);
    results.push(row);
  }
  return results;
}

// ---------- Query ----------

function getRankings() {
  // Refresh loaded counts before returning
  const ADDRESSABLE_PER_CAPITA = 1 / 250000;
  const markets = db.prepare('SELECT * FROM markets ORDER BY market_score DESC, population DESC').all();

  // Count companies per city+state combo for accurate per-market attribution.
  // A company is attributed to a market if it shares the same state AND its city
  // matches (case-insensitive) the market city or any word in the MSA name.
  const companies = db.prepare(`
    SELECT LOWER(TRIM(city)) AS city, UPPER(TRIM(state)) AS state FROM companies
    WHERE city IS NOT NULL AND state IS NOT NULL AND city != '' AND state != ''
  `).all();

  return markets.map((m) => {
    const mCity = m.city.toLowerCase();
    const mState = m.state.toUpperCase();
    const msaWords = (m.msa_name || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);

    const loaded = companies.filter((c) => {
      if (c.state !== mState) return false;
      if (c.city === mCity) return true;
      // Check if company city appears in MSA name
      return msaWords.includes(c.city);
    }).length;

    const addressable = m.addressable || Math.max(1, Math.round((m.population || 0) * ADDRESSABLE_PER_CAPITA));
    const sat = saturationStatus(loaded, addressable);
    return {
      ...m,
      loaded,
      addressable,
      saturation_status: sat,
      coverage_pct: addressable > 0 ? Math.round((loaded / addressable) * 100) : 0,
    };
  });
}

function getMarketForState(state) {
  if (!state) return null;
  return db.prepare(
    'SELECT * FROM markets WHERE UPPER(TRIM(state)) = UPPER(TRIM(?)) ORDER BY market_score DESC LIMIT 1'
  ).get(state);
}

module.exports = {
  seedMarkets,
  getRankings,
  getMarketForState,
  scoreMarket,
  saturationStatus,
  METRO_SEED,
};
