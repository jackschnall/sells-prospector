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

  return {
    hard_stops: Array.isArray(parsed.hard_stops) ? parsed.hard_stops : [],
    yellow_flags: Array.isArray(parsed.yellow_flags) ? parsed.yellow_flags : [],
  };
}

module.exports = { runFlags };
