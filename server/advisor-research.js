const { MODELS, callWithWebSearch } = require('./claude');
const {
  ADVISOR_IDENTIFY_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
  buildIdentifyUserPrompt,
} = require('./advisor-prompts');

/**
 * Research a single advisor — produces a structured dossier.
 * Uses the composed base + type-specific overlay prompt.
 */
async function runAdvisorResearch(advisor, advisorType, geo) {
  const { systemPrompt, userPrompt } = buildAdvisorUserPrompt(advisor, advisorType, geo);

  const { parsed, raw, sources } = await callWithWebSearch({
    model: MODELS.worker,
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 8000,
    maxIterations: 10,
    maxSearches: 10,
  });

  if (!parsed) {
    throw new Error(`Advisor research returned no parseable JSON. Raw: ${String(raw).slice(0, 500)}`);
  }

  // Merge web_search citation sources with any model-declared source_log
  const sourceLog = Array.isArray(parsed.source_log) ? parsed.source_log : [];
  for (const s of sources) {
    if (!sourceLog.some((d) => d.source === s.url)) {
      sourceLog.push({ fact: s.label || 'web search result', source: s.url });
    }
  }
  parsed.source_log = sourceLog;

  return { dossier: parsed, raw, sources: sourceLog };
}

/**
 * Identify new advisor candidates in a geography.
 * Returns a list of candidate objects with basic info.
 */
async function runAdvisorIdentify(advisorType, geo, filters = {}) {
  const userPrompt = buildIdentifyUserPrompt(advisorType, geo, filters);

  const { parsed, raw, sources } = await callWithWebSearch({
    model: MODELS.worker,
    system: ADVISOR_IDENTIFY_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 4000,
    maxIterations: 10,
    maxSearches: 10,
  });

  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new Error(`Advisor identify returned no candidates. Raw: ${String(raw).slice(0, 500)}`);
  }

  return { candidates: parsed.candidates, notes: parsed.search_notes || '', sources };
}

module.exports = { runAdvisorResearch, runAdvisorIdentify };
