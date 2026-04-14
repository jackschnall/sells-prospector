// Google Places provider — independent cross-check for reviews, business age,
// and location confirmation. Complements Yelp; disagreement between Places
// and Yelp is itself a useful signal (review manipulation, duplicate listings).
//
// MCP-ready: Anthropic publishes an official Google Maps MCP server. When
// PROVIDERS_MCP=1 we could dispatch through that client. For v1 we call the
// Places API (New) directly.

function status() {
  if (process.env.MOCK_MODE === '1') return 'mock';
  if (process.env.GOOGLE_PLACES_API_KEY) return 'live';
  return 'unavailable';
}

function mockFetch(company) {
  const seed = (company.name || '') + ':places';
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
    source: 'places-mock',
    place_id: `mock-${Math.floor(rand() * 999999)}`,
    rating: +(4.0 + rand() * 1.0).toFixed(1),
    user_ratings_total: Math.floor(60 + rand() * 540),
    formatted_address: company.city
      ? `123 Mock St, ${company.city}, ${company.state || ''}`.trim()
      : null,
    business_status: 'OPERATIONAL',
    types: ['plumber', 'point_of_interest', 'establishment'],
    website: company.website || null,
  };
}

async function fetch(company) {
  if (process.env.MOCK_MODE === '1') return mockFetch(company);
  if (!process.env.GOOGLE_PLACES_API_KEY) return null;

  const query = [company.name, company.city, company.state].filter(Boolean).join(' ');
  const res = await globalThis.fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.businessStatus,places.types,places.websiteUri',
      },
      body: JSON.stringify({ textQuery: `${query} plumbing` }),
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Places HTTP ${res.status}`);
  const data = await res.json();
  const best = (data.places || [])[0];
  if (!best) return null;

  return {
    source: 'places',
    place_id: best.id,
    rating: best.rating ?? null,
    user_ratings_total: best.userRatingCount ?? null,
    formatted_address: best.formattedAddress || null,
    business_status: best.businessStatus || null,
    types: best.types || [],
    website: best.websiteUri || null,
  };
}

module.exports = { fetch, status };
