const { MODELS, callJson } = require('./claude');
const { FLAGS_SYSTEM_PROMPT } = require('./prompts');
const { mockFlags } = require('./mock');

async function runFlags(company, research) {
  if (process.env.MOCK_MODE === '1') {
    return mockFlags(company, research);
  }

  const userPrompt = `Company: ${company.name}

Raw research:
${JSON.stringify(research, null, 2)}

Identify red flags and return the required JSON.`;

  const { parsed } = await callJson({
    model: MODELS.worker,
    system: FLAGS_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 1500,
  });

  const flags = {
    hard_stops: Array.isArray(parsed.hard_stops) ? parsed.hard_stops : [],
    yellow_flags: Array.isArray(parsed.yellow_flags) ? parsed.yellow_flags : [],
  };

  // Deterministic acquisition check — catches what AI might miss
  return addAcquisitionFlags(flags, company, research);
}

/**
 * Scan owner field and research for acquisition keywords.
 * Adds a hard_stop if PE/strategic acquisition is detected.
 * This is a safety net — runs AFTER the AI flags.
 */
function addAcquisitionFlags(flags, company, research) {
  const ACQUISITION_PATTERNS = [
    /acquired\s+by/i, /pe[- ]backed/i, /private\s+equity/i,
    /sold\s+to\b/i, /bought\s+by/i, /merged\s+with/i,
    /acquisition\s+by/i, /platform\s+acquisition/i,
    /roll[- ]?up/i, /portfolio\s+company/i,
  ];

  // Check owner field
  const ownerText = (company.owner || '') + ' ' + (research?.owner?.name || '');
  // Check research text
  const researchText = JSON.stringify(research || '');

  const alreadyFlagged = flags.hard_stops.some(f =>
    (f.flag || f || '').toLowerCase().includes('acqui') || (f.flag || f || '').toLowerCase().includes('pe')
  );
  if (alreadyFlagged) return flags;

  for (const pattern of ACQUISITION_PATTERNS) {
    if (pattern.test(ownerText)) {
      flags.hard_stops.push({
        flag: 'PE/Strategic acquisition detected in owner field',
        evidence: `Owner: "${ownerText.trim()}"`,
      });
      return flags;
    }
  }

  // Also check the raw research for strong acquisition signals
  const strongPatterns = [/ACQUIRED BY/i, /PE-BACKED/i, /sold to .* (private equity|PE|partners)/i];
  for (const pattern of strongPatterns) {
    if (pattern.test(researchText) && !pattern.test(ownerText)) {
      flags.yellow_flags.push({
        flag: 'Possible acquisition detected in research',
        evidence: 'Review raw research for acquisition references',
      });
      return flags;
    }
  }

  return flags;
}

module.exports = { runFlags };
