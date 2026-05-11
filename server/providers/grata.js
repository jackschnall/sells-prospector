// Grata provider — M&A deal sourcing platform.
// Enrichment: owner/executive contact info (personal email, phone) + company firmographics.
// Search: discover service-industry companies by geography, industry, size.
//
// API docs: https://docs.grata.com
// Base URL: https://search.grata.com/api/v1.2/
// Auth: Authorization header with API token.
// Env var: GRATA_API_TOKEN

const BASE_URL = 'https://search.grata.com/api/v1.2';

function status() {
  if (process.env.MOCK_MODE === '1') return 'mock';
  if (process.env.GRATA_API_TOKEN) return 'live';
  return 'unavailable';
}

function headers() {
  return {
    'Authorization': process.env.GRATA_API_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Enrich a single company via Grata's enrichment endpoint.
 * Pass domain (preferred) or company name + location for matching.
 * Returns: owner contact info, company firmographics, or null.
 */
async function enrich(company) {
  if (process.env.MOCK_MODE === '1') return mockEnrich(company);
  if (!process.env.GRATA_API_TOKEN) return null;

  // Try domain first (best match), fall back to name-based search then enrich
  const domain = extractDomain(company.website);
  let result = null;

  if (domain) {
    result = await enrichByDomain(domain);
  }

  if (!result && company.name) {
    // Search by name + location, then enrich the top match
    const match = await searchForMatch(company);
    if (match?.domain) {
      result = await enrichByDomain(match.domain);
    } else if (match?.company_uid) {
      result = await enrichByUid(match.company_uid);
    }
  }

  if (!result) return null;
  return normalizeEnrichment(result, company);
}

async function enrichByDomain(domain) {
  const res = await globalThis.fetch(`${BASE_URL}/enrich/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    console.warn(`[grata] enrich by domain ${domain}: ${res.status} ${res.statusText}`);
    return null;
  }
  return res.json();
}

async function enrichByUid(company_uid) {
  const res = await globalThis.fetch(`${BASE_URL}/enrich/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ company_uid }),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    console.warn(`[grata] enrich by uid ${company_uid}: ${res.status} ${res.statusText}`);
    return null;
  }
  return res.json();
}

/**
 * Search Grata for a company matching name + location, return the best match.
 */
async function searchForMatch(company) {
  const location = [company.city, company.state].filter(Boolean).join(', ');
  const res = await globalThis.fetch(`${BASE_URL}/search/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      search_term: company.name,
      headquarters: location ? { states: company.state ? [company.state] : undefined } : undefined,
      page_size: 3,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.results || data?.companies || [];
  if (!results.length) return null;

  // Find the best name match
  const needle = (company.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const r of results) {
    const hay = (r.company_name || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (hay.includes(needle) || needle.includes(hay)) return r;
  }
  return results[0]; // Fallback to top result
}

// ─── Search / Discovery ─────────────────────────────────────────────────────

/**
 * Search Grata for companies matching criteria.
 * @param {object} opts — { keywords, states, industries, minEmployees, maxEmployees, minRevenue, maxRevenue, ownershipTypes, pageSize, page }
 * @returns {Promise<{ companies: array, total: number }>}
 */
async function search(opts = {}) {
  if (!process.env.GRATA_API_TOKEN) return { companies: [], total: 0 };

  const body = {};
  if (opts.keywords) body.search_term = opts.keywords;
  if (opts.states?.length) body.headquarters = { states: opts.states };
  if (opts.minEmployees || opts.maxEmployees) {
    body.employees = {};
    if (opts.minEmployees) body.employees.min = opts.minEmployees;
    if (opts.maxEmployees) body.employees.max = opts.maxEmployees;
  }
  if (opts.minRevenue || opts.maxRevenue) {
    body.revenue = {};
    if (opts.minRevenue) body.revenue.min = opts.minRevenue;
    if (opts.maxRevenue) body.revenue.max = opts.maxRevenue;
  }
  if (opts.ownershipTypes?.length) body.ownership = opts.ownershipTypes;
  body.page_size = opts.pageSize || 25;
  if (opts.page) body.page = opts.page;

  const res = await globalThis.fetch(`${BASE_URL}/search/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn(`[grata] search failed: ${res.status} ${res.statusText}`);
    return { companies: [], total: 0 };
  }
  const data = await res.json();
  return {
    companies: (data.results || data.companies || []).map(normalizeSearchResult),
    total: data.total_results || data.total || 0,
  };
}

// ─── Normalize ──────────────────────────────────────────────────────────────

function normalizeEnrichment(raw, company) {
  // Extract executive contacts (Grata focuses on CEO/owner/founder)
  const contacts = raw.contacts || raw.executives || raw.people || [];
  const owner = contacts.find(c =>
    /owner|founder|president|ceo|principal/i.test(c.title || c.job_title || '')
  ) || contacts[0] || {};

  // Company-level phones/emails
  const companyPhone = raw.phone || raw.primary_phone || raw.phone_number || null;
  const companyEmail = raw.email || raw.primary_email || null;

  // Owner personal contact
  const ownerPhone = owner.phone || owner.phone_number || owner.direct_phone || null;
  const ownerEmail = owner.email || owner.work_email || owner.direct_email || null;

  return {
    source: 'grata',
    grata_uid: raw.company_uid || raw.uid || null,
    grata_domain: raw.domain || null,

    // Owner / executive
    owner_name: owner.name || owner.full_name || null,
    owner_title: owner.title || owner.job_title || null,
    owner_email: ownerEmail,
    owner_phone: ownerPhone,
    owner_linkedin: owner.linkedin || owner.linkedin_url || null,

    // Company contact (office/receptionist)
    company_phone: companyPhone,
    company_email: companyEmail,

    // Firmographics
    employee_count: raw.employee_count || raw.employees || null,
    employee_range: raw.employee_range || null,
    revenue_estimate: raw.revenue || raw.revenue_estimate || null,
    revenue_range: raw.revenue_range || null,
    year_founded: raw.year_founded || raw.founded_year || null,
    ownership_type: raw.ownership || raw.ownership_type || null,
    naics_codes: raw.naics_codes || raw.naics || null,
    description: raw.description || null,
    headquarters: raw.headquarters || null,
    website: raw.domain ? `https://${raw.domain}` : null,
    linkedin_url: raw.linkedin || raw.linkedin_url || null,

    // Raw for debugging
    _raw_contacts_count: contacts.length,
  };
}

function normalizeSearchResult(r) {
  return {
    grata_uid: r.company_uid || r.uid || null,
    name: r.company_name || r.name || null,
    domain: r.domain || null,
    city: r.city || r.headquarters?.city || null,
    state: r.state || r.headquarters?.state || null,
    employee_count: r.employee_count || r.employees || null,
    revenue_estimate: r.revenue || r.revenue_estimate || null,
    ownership_type: r.ownership || r.ownership_type || null,
    year_founded: r.year_founded || null,
    description: r.description || null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function mockEnrich(company) {
  return {
    source: 'grata-mock',
    grata_uid: 'MOCK-' + (company.id || '').slice(0, 8),
    grata_domain: extractDomain(company.website) || 'example.com',
    owner_name: company.owner || 'John Smith',
    owner_title: 'Owner/President',
    owner_email: 'john@example.com',
    owner_phone: '(555) 123-4567',
    owner_linkedin: null,
    company_phone: company.phone || '(555) 987-6543',
    company_email: 'info@example.com',
    employee_count: 25,
    revenue_estimate: 5000000,
    year_founded: 2005,
    ownership_type: 'Private',
    naics_codes: ['238220'],
    description: 'Full-service plumbing company.',
    headquarters: { city: company.city, state: company.state },
    website: company.website,
    linkedin_url: null,
    _raw_contacts_count: 1,
  };
}

module.exports = { enrich, search, status };
