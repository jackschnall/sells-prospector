// ─────────────────────────────────────────────────────────────────────────────
// Contact Enrichment — two-phase identity resolution + people-search.
//
// Phase 1: Identity Discovery — state license DBs, SoS filings, website,
//          BBB/Yelp/Google, LinkedIn. Goal: build an identity fingerprint
//          (full legal name, middle name, city, age range, license number).
//
// Phase 2: Direct Contact Enrichment — people-search sites with identity
//          fingerprint for disambiguation. Only runs if Phase 1 produces
//          high or medium identity confidence.
//
// This module upgrades ONLY the contact-information discovery step.
// It does not modify research, scoring, flags, or any other pipeline step.
// ─────────────────────────────────────────────────────────────────────────────

const { callWithWebSearch, MODELS } = require('./claude');

// ─── Phase 1 Prompt: Identity Resolution ────────────────────────────────────

function buildIdentityPrompt(company, existingResearch) {
  const name = company.name || '';
  const city = company.city || '';
  const st = company.state || '';
  const website = company.website || existingResearch?.website?.url || '';
  const ownerHint = company.owner || existingResearch?.owner?.name || existingResearch?.contact?.owner_name || '';

  return `You are an identity-resolution specialist. Your ONLY goal is to build an identity fingerprint for the owner of this business. Do NOT try to find phone numbers yet — that comes later.

COMPANY:
  Name: ${name}
  City: ${city}
  State: ${st}
  Website: ${website || 'unknown'}
  Owner hint (from prior research, may be incomplete): ${ownerHint || 'unknown'}

INSTRUCTIONS — query these sources in priority order. Stop as soon as you have a full legal name plus two disambiguators (city, age, spouse, relative, middle name).

1. STATE CONTRACTOR LICENSE DATABASE (highest priority for licensed trades)
   - Search: "${name} ${st} contractor license" or "${st} DBPR license lookup ${ownerHint || name}"
   - For FL: search myfloridalicense.com or DBPR
   - For TX: search TSBPE or TDLR
   - For GA: search sos.ga.gov contractor licensing
   - For other states: search "<state> plumbing contractor license lookup"
   - Extract: full legal licensee name (including middle name/initial), license number, license status, issue date, business address.

2. SECRETARY OF STATE / BUSINESS ENTITY FILING
   - Search: "${name} ${st} secretary of state" or "${st} corporation search ${name}"
   - For FL: search sunbiz.org
   - For TX: search sos.state.tx.us
   - Extract: registered agent name, corporate officers and titles, filing date, principal address, mailing address, document number.

3. COMPANY WEBSITE (About, Team, Staff, Contact pages)
   - Search: "${website || name + ' ' + city + ' plumbing'} about team staff"
   - Extract: owner name and title, email pattern, direct email, bios with tenure info.
   - Email pattern detection: if multiple staff emails visible, identify the pattern (firstname@, firstinitial+lastname@, first.last@).

4. BBB, YELP, GOOGLE BUSINESS LISTING
   - Search: "${name} ${city} ${st} BBB" and "${name} ${city} reviews"
   - Extract: business phone, owner-named responses, years in business, established date.

5. LINKEDIN
   - Search: "${ownerHint || name + ' owner'} ${name} linkedin"
   - Extract: owner LinkedIn URL, current title, tenure.

RETURN a FINAL message containing ONLY a JSON object (no code fences, no commentary):

{
  "identity": {
    "full_legal_name": "string or null — include middle name/initial if found",
    "common_name": "string or null — the name they go by (e.g., first + last)",
    "middle_name_or_initial": "string or null",
    "title": "string or null — e.g., President, Owner, CEO",
    "company": "${name}",
    "primary_city": "${city}, ${st}",
    "business_address": "string or null",
    "approximate_age_range": "string or null — e.g., '45-60'",
    "tenure_in_business_years": null,
    "license_number": "string or null",
    "license_source": "string or null — e.g., 'FL DBPR', 'TX TSBPE'",
    "sos_document_number": "string or null",
    "is_sole_officer": true,
    "direct_email": "string or null — owner direct email if found on website",
    "business_phone": "string or null — main office number",
    "email_pattern": "string or null — describe the pattern, e.g., 'firstinitial+lastname@domain.com'",
    "linkedin_url": "string or null",
    "spouse_or_relatives": [],
    "identity_confidence": "high|medium|low",
    "identity_sources": [],
    "schema_extensions": []
  }
}

CONFIDENCE RULES:
- high: full legal name confirmed across 2+ independent sources (e.g., license DB + SoS), and at least one disambiguator (middle name, age range, spouse).
- medium: name confirmed from a single authoritative source, or cross-source confirmation without a disambiguator.
- low: owner name inferred only from website About page or reviews, no license/SoS confirmation.

Use null for any field you cannot populate. NEVER fabricate data.`;
}

// ─── Phase 2 Prompt: People-Search Enrichment ───────────────────────────────

function buildEnrichmentPrompt(identity) {
  const name = identity.common_name || identity.full_legal_name || '';
  const city = identity.primary_city || '';
  const middleName = identity.middle_name_or_initial || '';
  const ageRange = identity.approximate_age_range || '';
  const relatives = (identity.spouse_or_relatives || []).join(', ');
  const company = identity.company || '';

  return `You are a contact-enrichment specialist. You have a verified identity fingerprint for a business owner and need to find their direct cell phone number and home address using people-search sites.

IDENTITY FINGERPRINT:
  Full Legal Name: ${identity.full_legal_name || name}
  Common Name: ${name}
  Middle Name/Initial: ${middleName || 'unknown'}
  Company: ${company}
  City: ${city}
  Age Range: ${ageRange || 'unknown'}
  Known Relatives/Spouse: ${relatives || 'none known'}
  License Number: ${identity.license_number || 'none'}
  Business Address: ${identity.business_address || 'unknown'}

INSTRUCTIONS:

1. QUERY PEOPLE-SEARCH SITES — try up to 3 sites in this order until one returns results:
   a) FastPeopleSearch: search "fastpeoplesearch.com ${name} ${city}"
   b) ThatsThem: search "thatsthem.com ${name} ${city}"
   c) TruePeopleSearch: search "truepeoplesearch.com ${name} ${city}"
   d) NUWBER: search "nuwber.com ${name} ${city}"

   If a site returns CAPTCHA or empty results, move to the next one. Do NOT retry the same site.

2. DISAMBIGUATE RESULTS — people-search will return multiple matches. Filter using the fingerprint:
   - Middle name/initial: if fingerprint has "${middleName}" and a result shows an initial match, that's a strong signal.
   - Age range: ${ageRange ? `Owner is approximately ${ageRange} years old.` : 'No age data — skip this filter.'}
   - Geographic match: must be in or near ${city} (include adjacent suburbs and metro area).
   - Relatives: ${relatives ? `Known relatives: ${relatives}. Match against "possible relatives" on detail pages.` : 'No relatives known — skip this filter.'}

   ONLY accept a match if at least TWO of these filters align. One alone is not enough.

3. EXTRACT FROM THE CONFIRMED MATCH:
   - Current address (with start date if available)
   - Phone numbers — note carrier type if shown (wireless = cell, landline = home phone)
   - Previous addresses
   - Spouse / relatives
   - Email addresses (rare but sometimes present)

4. CLASSIFY PHONE NUMBERS:
   - Wireless → direct cell
   - Landline at home address → home landline
   - Landline at business address → business phone (already known)

RETURN a FINAL message containing ONLY a JSON object (no code fences, no commentary):

{
  "enrichment": {
    "direct_cell": "string or null — (XXX) XXX-XXXX format",
    "direct_cell_carrier": "string or null — e.g., 'Verizon Wireless', 'AT&T Wireless'",
    "home_landline": "string or null",
    "home_address": "string or null — full address",
    "previous_addresses": [],
    "spouse_name": "string or null",
    "relatives": [],
    "approximate_age": null,
    "email_addresses": [],
    "people_search_source": "string or null — which site the data came from",
    "people_search_url": "string or null — the specific result URL",
    "contact_confidence": "high|medium|low",
    "contact_confidence_reasoning": "string — explain why you rated confidence this way, referencing which disambiguation filters matched",
    "schema_extensions": []
  }
}

CONFIDENCE RULES:
- high: middle name/initial matched exactly, AND at least one additional filter (age, spouse, geography) confirmed, AND no better alternative candidate exists.
- medium: name + city matched but no middle name available, OR age fell in a broad range but no other disambiguator, OR only one people-search source was reachable.
- low: multiple candidates matched equally, or owner identity was itself low-confidence, or no people-search site returned usable results.

If you cannot find a confident match, return null for direct_cell and set confidence to "low" with reasoning. Do NOT guess.`;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

async function runContactEnrichment(company, existingResearch) {
  // Phase 1: Identity Resolution
  const identityPrompt = buildIdentityPrompt(company, existingResearch);
  const phase1 = await callWithWebSearch({
    model: MODELS.worker,
    system: 'You are an identity-resolution specialist for business owner contact discovery. Use web_search to find authoritative records. Return only the requested JSON.',
    user: identityPrompt,
    maxTokens: 4000,
    maxIterations: 10,
    maxSearches: 8,
  });

  const identity = phase1.parsed?.identity || phase1.parsed || {};
  const identityConfidence = identity.identity_confidence || 'low';

  // If identity confidence is low, skip Phase 2
  if (identityConfidence === 'low') {
    return {
      identity,
      enrichment: null,
      contact: buildContactBlock(identity, null),
      raw: { phase1: phase1.raw },
    };
  }

  // Phase 2: People-Search Enrichment
  const enrichPrompt = buildEnrichmentPrompt(identity);
  const phase2 = await callWithWebSearch({
    model: MODELS.worker,
    system: 'You are a contact-enrichment specialist. Use web_search to query people-search sites and find direct contact information. Return only the requested JSON.',
    user: enrichPrompt,
    maxTokens: 3000,
    maxIterations: 8,
    maxSearches: 6,
  });

  const enrichment = phase2.parsed?.enrichment || phase2.parsed || {};

  return {
    identity,
    enrichment,
    contact: buildContactBlock(identity, enrichment),
    raw: { phase1: phase1.raw, phase2: phase2.raw },
  };
}

// ─── Merge identity + enrichment into a unified contact block ───────────────

function buildContactBlock(identity, enrichment) {
  const e = enrichment || {};
  return {
    owner_name: identity.full_legal_name || identity.common_name || null,
    owner_title: identity.title || null,
    direct_email: identity.direct_email || (e.email_addresses && e.email_addresses[0]) || null,
    direct_cell: e.direct_cell || null,
    direct_cell_carrier: e.direct_cell_carrier || null,
    home_landline: e.home_landline || null,
    home_address: e.home_address || null,
    business_phone: identity.business_phone || null,
    business_address: identity.business_address || null,
    linkedin_url: identity.linkedin_url || null,
    spouse_name: e.spouse_name || null,
    approximate_age: e.approximate_age || null,
    license_number: identity.license_number || null,
    license_source: identity.license_source || null,
    email_pattern: identity.email_pattern || null,
    sources: {
      identity: identity.identity_sources || [],
      contact: e.people_search_source ? [e.people_search_source] : [],
    },
    identity_confidence: identity.identity_confidence || 'low',
    contact_confidence: e.contact_confidence || (identity.identity_confidence === 'low' ? 'low' : 'medium'),
    contact_confidence_reasoning: e.contact_confidence_reasoning || 'Phase 2 not run or no enrichment data available.',
    schema_extensions: [
      ...(identity.schema_extensions || []),
      ...(e.schema_extensions || []),
    ],
  };
}

module.exports = { runContactEnrichment };
