const { MODELS, callJson } = require('./claude');
const { SCORING_SYSTEM_PROMPT } = require('./prompts');
const { mockScoring } = require('./mock');

const WEIGHTS = {
  revenue_proxy: 0.22,
  operational_quality: 0.18,
  succession_signal: 0.18,
  growth_trajectory: 0.12,
  deal_complexity: 0.1,
  geographic_fit: 0.1,
  market_quality: 0.1,
};

function computeFinalScore(signals) {
  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = signals?.[key]?.score;
    if (typeof s === 'number' && !Number.isNaN(s)) {
      total += s * weight;
      weightSum += weight;
    }
  }
  if (weightSum === 0) return 0;
  // Normalize in case some signals are missing.
  return +(total / weightSum).toFixed(2);
}

function computeTier(score) {
  if (score >= 7.5) return 'strong-buy';
  if (score >= 5.0) return 'watchlist';
  return 'pass';
}

async function runScoring(company, research, thesis = {}) {
  let signals;
  let summary;
  let outreachAngle;

  if (process.env.MOCK_MODE === '1') {
    const m = mockScoring(company, research);
    signals = m.signals;
    summary = m.summary;
    outreachAngle = m.outreach_angle || '';
  } else {
    const userPrompt = `Company: ${company.name} (${company.city || '?'}, ${company.state || '?'})

${thesis.geography ? `Deal thesis geography: ${thesis.geography}\n` : ''}Raw research:
${JSON.stringify(research, null, 2)}

Score this company and return the required JSON.`;

    const { parsed, raw } = await callJson({
      model: MODELS.orchestrator,
      system: SCORING_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 2500,
    });

    if (!parsed?.signals) {
      throw new Error(`Scoring returned no signals. Raw: ${raw.slice(0, 400)}`);
    }
    signals = parsed.signals;
    summary = parsed.summary || '';
    outreachAngle = parsed.outreach_angle || '';
  }

  // Server computes the final score from weights as ground truth.
  const finalScore = computeFinalScore(signals);
  const tier = computeTier(finalScore);

  return {
    signals,
    final_score: finalScore,
    tier,
    summary,
    outreach_angle: outreachAngle,
  };
}

module.exports = { runScoring, computeFinalScore, computeTier, WEIGHTS };
