const { MODELS, callWithWebSearch } = require('./claude');
const { DISCOVERY_SYSTEM_PROMPT } = require('./prompts');
const { mockDiscovery } = require('./mock');

function buildUserPrompt(geography, blocklistNames) {
  const blocklistText = blocklistNames && blocklistNames.length
    ? blocklistNames.slice(0, 500).map((n) => `  - ${n}`).join('\n')
    : '  (none)';

  return `Find plumbing-company owners in the following geography who may be candidates for a Sells sell-side engagement.

Geography: ${geography || '(not specified — use the entire United States)'}

BLOCKLIST — do NOT return any company whose name matches any of these (already in Sells CRM):
${blocklistText}

Use web_search to identify 8-15 NET-NEW, independently-owned plumbing companies in the geography. Return the final JSON object only.`;
}

async function runDiscovery(geography, blocklistNames = []) {
  if (process.env.MOCK_MODE === '1') {
    return mockDiscovery(geography, blocklistNames);
  }

  const { parsed, raw } = await callWithWebSearch({
    model: MODELS.worker,
    system: DISCOVERY_SYSTEM_PROMPT,
    user: buildUserPrompt(geography, blocklistNames),
    maxTokens: 4000,
    maxIterations: 10,
    maxSearches: 8,
  });

  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new Error(`Discovery worker returned no parseable candidates. Raw: ${String(raw).slice(0, 500)}`);
  }

  // Defensive client-side blocklist check (case-insensitive, strip common suffixes).
  const normalized = new Set(
    (blocklistNames || []).map(normalizeName).filter(Boolean)
  );
  const filtered = parsed.candidates.filter((c) => {
    if (!c || !c.name) return false;
    const key = normalizeName(c.name);
    return key && !normalized.has(key);
  });

  return {
    candidates: filtered,
    notes: parsed.notes || '',
    raw,
  };
}

function normalizeName(n) {
  if (!n || typeof n !== 'string') return '';
  return n
    .toLowerCase()
    .replace(/[.,'"&]/g, '')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|plumbing|services?|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { runDiscovery, normalizeName };
