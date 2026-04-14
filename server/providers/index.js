// Pluggable providers layer for enriching research beyond web_search.
// Each provider follows a uniform interface: { fetch(company): Promise<data|null> }.
// All calls are wrapped in safeCall() — a provider failure NEVER breaks a
// company's research job. We silently degrade and let the scoring layer
// handle missing signals gracefully.
//
// Provider precedence per source:
//   1. MCP server (if PROVIDERS_MCP=1 and config points to a running MCP host)
//   2. Direct REST API (if the relevant *_API_KEY env var is present)
//   3. MOCK_MODE synthetic data
//   4. Return null (signal will default to mid-range at scoring time)

const yelp = require('./yelp');
const places = require('./places');
const zillow = require('./zillow');

async function safeCall(name, fn) {
  try {
    const result = await fn();
    return result ?? null;
  } catch (err) {
    // Never throw — providers are best-effort. Log once for debugging.
    console.warn(`[providers] ${name} failed: ${err.message || err}`);
    return null;
  }
}

async function enrichResearch(company) {
  // Run providers in parallel. Independent failures must not cascade.
  const [yelpData, placesData, zillowData] = await Promise.all([
    safeCall('yelp', () => yelp.fetch(company)),
    safeCall('places', () => places.fetch(company)),
    safeCall('zillow', () => zillow.fetch(company)),
  ]);

  return {
    yelp: yelpData,
    places: placesData,
    zillow: zillowData,
  };
}

function providerStatus() {
  return {
    yelp: yelp.status(),
    places: places.status(),
    zillow: zillow.status(),
  };
}

module.exports = { enrichResearch, providerStatus };
