const { MODELS, callWithWebSearch } = require('./claude');
const { RESEARCH_SYSTEM_PROMPT } = require('./prompts');
const { mockResearch } = require('./mock');
const { enrichResearch } = require('./providers');

function buildUserPrompt(company, thesis = {}) {
  const thesisLines = [];
  if (thesis.minRevenue) thesisLines.push(`Min estimated revenue: $${thesis.minRevenue}M`);
  if (thesis.geography) thesisLines.push(`Geography focus: ${thesis.geography}`);
  if (thesis.minYears) thesisLines.push(`Min years in business: ${thesis.minYears}`);
  if (thesis.minRating) thesisLines.push(`Min Google rating: ${thesis.minRating}`);

  return `Research the following plumbing company for a potential Sells M&A engagement.

Company: ${company.name}
${company.city ? `City: ${company.city}` : ''}
${company.state ? `State: ${company.state}` : ''}
${company.website ? `Website: ${company.website}` : ''}
${company.phone ? `Phone (from CSV): ${company.phone}` : ''}
${company.owner ? `Owner (from CSV): ${company.owner}` : ''}

${thesisLines.length ? `Deal thesis:\n  - ${thesisLines.join('\n  - ')}\n` : ''}
Use web_search to gather the data fields described in your instructions. When done, return the final JSON object only.`;
}

async function runResearch(company, thesis = {}) {
  if (process.env.MOCK_MODE === '1') {
    const mock = mockResearch(company);
    const providerData = await enrichResearch(company);
    mock.provider_data = providerData;
    return { research: mock, sources: mock.sources, raw: JSON.stringify(mock) };
  }

  // Kick off the web_search pipeline and external-provider enrichment in
  // parallel. Providers are best-effort — enrichResearch never throws.
  const [claudeResult, providerData] = await Promise.all([
    callWithWebSearch({
      model: MODELS.worker,
      system: RESEARCH_SYSTEM_PROMPT,
      user: buildUserPrompt(company, thesis),
      maxTokens: 6000,
      maxIterations: 8,
      maxSearches: 6,
    }),
    enrichResearch(company),
  ]);
  const { parsed, raw, sources } = claudeResult;

  if (!parsed) {
    throw new Error(`Research worker returned no parseable JSON. Raw: ${String(raw).slice(0, 500)}`);
  }

  // Merge model-declared sources with any web_search citations we collected.
  const declaredSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const allSources = [...declaredSources];
  for (const s of sources) {
    if (!allSources.some((d) => d.url === s.url)) allSources.push(s);
  }

  // Attach provider data so scoring (and the tearsheet) can reference it.
  parsed.provider_data = providerData;

  return { research: parsed, sources: allSources, raw };
}

module.exports = { runResearch };
