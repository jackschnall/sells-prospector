// Zillow provider — median home value by metro/zip. Feeds the new
// market_quality scoring signal: higher home values correlate with
// higher-ticket residential plumbing work (water heaters, repipes,
// luxury remodels) and healthier revenue per job.
//
// Zillow's Bridge API has restrictive ToS (no local storage, dynamic-only,
// limited approvals). In v1 we ship:
//   - MOCK_MODE synthetic data
//   - A RapidAPI Zillow adapter when ZILLOW_RAPIDAPI_KEY is set (common
//     unofficial channel with permissive terms)
//   - An MCP-ready shape so this can be swapped for the Zillow MCP server
//     (github.com/sap156/zillow-mcp-server) later without touching callers.

function status() {
  if (process.env.MOCK_MODE === '1') return 'mock';
  if (process.env.ZILLOW_RAPIDAPI_KEY) return 'live';
  return 'unavailable';
}

// Rough home-value anchors by state (2024 approximations, $USD).
// Used only in MOCK_MODE to produce state-aware plausible values.
const STATE_ANCHORS = {
  CA: 750000, WA: 620000, MA: 600000, CO: 560000, NY: 520000,
  OR: 510000, NJ: 500000, UT: 480000, NH: 470000, AZ: 430000,
  FL: 410000, VA: 400000, NV: 420000, ID: 430000, RI: 440000,
  CT: 410000, MD: 400000, MT: 460000, ME: 400000, DE: 370000,
  MN: 340000, GA: 340000, NC: 340000, TX: 310000, SC: 310000,
  TN: 310000, PA: 270000, WI: 280000, NM: 290000, DC: 600000,
  WY: 330000, VT: 370000, HI: 820000, AK: 370000,
  MI: 240000, MO: 230000, IN: 220000, AL: 220000, OH: 220000,
  KY: 200000, AR: 200000, OK: 200000, LA: 210000, KS: 220000,
  NE: 240000, IA: 210000, SD: 250000, ND: 260000, MS: 180000, WV: 160000,
};

function mockFetch(company) {
  const seed = (company.name || '') + ':zillow';
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const anchor = STATE_ANCHORS[(company.state || '').toUpperCase()] || 300000;
  // +/- 30% variation around the state anchor
  const median = Math.round(anchor * (0.7 + rand() * 0.6));
  const yoy = +((rand() - 0.4) * 8).toFixed(1); // -3.2% to +4.8%
  return {
    source: 'zillow-mock',
    region: company.city && company.state ? `${company.city}, ${company.state}` : company.state || 'Unknown',
    median_home_value: median,
    yoy_change_pct: yoy,
    inventory_level: rand() > 0.6 ? 'tight' : 'balanced',
  };
}

async function fetch(company) {
  if (process.env.MOCK_MODE === '1') return mockFetch(company);
  if (!process.env.ZILLOW_RAPIDAPI_KEY) return null;
  if (!company.city || !company.state) return null;

  // RapidAPI Zillow-com1 search endpoint — returns listings whose median we
  // derive. This is a best-effort aggregation; for production, replace with
  // Bridge API or ZHVI region download when credentials are approved.
  const location = `${company.city}, ${company.state}`;
  const res = await globalThis.fetch(
    `https://zillow-com1.p.rapidapi.com/propertyExtendedSearch?location=${encodeURIComponent(location)}&home_type=Houses&status_type=ForSale`,
    {
      headers: {
        'x-rapidapi-key': process.env.ZILLOW_RAPIDAPI_KEY,
        'x-rapidapi-host': 'zillow-com1.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`Zillow HTTP ${res.status}`);
  const data = await res.json();
  const props = Array.isArray(data.props) ? data.props : [];
  if (!props.length) return null;

  const prices = props.map((p) => p.price).filter((n) => typeof n === 'number' && n > 10000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];

  return {
    source: 'zillow',
    region: location,
    median_home_value: median,
    yoy_change_pct: null, // not available from search endpoint
    inventory_level: props.length > 200 ? 'ample' : props.length > 50 ? 'balanced' : 'tight',
  };
}

module.exports = { fetch, status, STATE_ANCHORS };
