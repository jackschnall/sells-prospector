// Yelp provider — review count, rating, years-in-business, category validation.
// MCP-ready: an official Yelp MCP server exists at github.com/yelp/yelp-mcp; when
// PROVIDERS_MCP=1 we could dispatch through an MCP client. For v1 we call the
// Yelp Fusion REST API directly (same underlying data, fewer moving parts).

function status() {
  if (process.env.MOCK_MODE === '1') return 'mock';
  if (process.env.YELP_API_KEY) return 'live';
  return 'unavailable';
}

function mockFetch(company) {
  const seed = (company.name || '') + ':yelp';
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
  return {
    source: 'yelp-mock',
    business_id: `mock-${Math.floor(rand() * 99999)}`,
    rating: +(3.6 + rand() * 1.4).toFixed(1),
    review_count: Math.floor(30 + rand() * 400),
    categories: ['Plumbing', 'Water Heater Installation/Repair'],
    is_claimed: rand() > 0.25,
    price: rand() > 0.5 ? '$$' : '$$$',
    url: null,
  };
}

async function fetch(company) {
  if (process.env.MOCK_MODE === '1') return mockFetch(company);
  if (!process.env.YELP_API_KEY) return null;

  const params = new URLSearchParams({
    term: `${company.name} plumbing`,
    location: [company.city, company.state].filter(Boolean).join(', ') || 'USA',
    categories: 'plumbing',
    limit: '3',
  });
  const res = await globalThis.fetch(
    `https://api.yelp.com/v3/businesses/search?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Yelp HTTP ${res.status}`);
  const data = await res.json();
  const best = (data.businesses || [])[0];
  if (!best) return null;

  return {
    source: 'yelp',
    business_id: best.id,
    rating: best.rating ?? null,
    review_count: best.review_count ?? null,
    categories: (best.categories || []).map((c) => c.title),
    is_claimed: null, // not in search endpoint response
    price: best.price || null,
    url: best.url || null,
  };
}

module.exports = { fetch, status };
