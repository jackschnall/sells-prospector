// Advisor Network — prompt templates per advisor type
// Used by advisor-research.js for structured dossier generation.
//
// Base prompt + type-specific overlays are stored as markdown files in
// server/prompts/ for easy editing without touching code. This module
// reads them at require-time and composes the full system prompt per type.

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function readPrompt(filename) {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
}

// Read base + all overlays once at startup
const BASE_PROMPT = readPrompt('advisor_research_base.md');

const TYPE_OVERLAYS = {
  cpa: readPrompt('advisor_research_cpa.md'),
  ria: readPrompt('advisor_research_ria.md'),
  attorney: readPrompt('advisor_research_attorney.md'),
  lender: readPrompt('advisor_research_lender.md'),
  coach: readPrompt('advisor_research_coach.md'),
  insurance: readPrompt('advisor_research_insurance.md'),
  fractional_cfo: readPrompt('advisor_research_fractional_cfo.md'),
};

/**
 * Compose the full system prompt for a given advisor type.
 * Substitutes the {{TYPE_SPECIFIC_BLOCK}} placeholder with the type overlay.
 */
function getResearchSystemPrompt(advisorType) {
  const overlay = TYPE_OVERLAYS[advisorType] || '';
  return BASE_PROMPT.replace('{{TYPE_SPECIFIC_BLOCK}}', overlay);
}

/**
 * Build the user prompt for a single advisor research job.
 * Substitutes template variables from the advisor record.
 */
function buildAdvisorUserPrompt(advisor, advisorType, geo) {
  // Build the system prompt with template variables filled in
  let systemPrompt = getResearchSystemPrompt(advisorType);
  systemPrompt = systemPrompt
    .replace('{{name}}', advisor.name || '')
    .replace('{{firm}}', advisor.firm || 'Unknown')
    .replace('{{title}}', advisor.title || 'Unknown')
    .replace('{{city}}', advisor.city || 'Unknown')
    .replace('{{state}}', advisor.state || 'Unknown')
    .replace('{{linkedin_url}}', advisor.linkedin_url || 'Not provided')
    .replace('{{email}}', advisor.email || 'Not provided')
    .replace('{{advisor_type}}', advisorType);

  // The user prompt is minimal — the system prompt has all the context
  const userPrompt = `Research the following advisor and produce the structured dossier JSON.

Name: ${advisor.name}
${advisor.firm ? `Firm: ${advisor.firm}` : ''}
${advisor.title ? `Title: ${advisor.title}` : ''}
${advisor.city ? `City: ${advisor.city}` : ''}
${advisor.state ? `State: ${advisor.state}` : ''}
${advisor.linkedin_url ? `LinkedIn: ${advisor.linkedin_url}` : ''}
${advisor.website ? `Website: ${advisor.website}` : ''}

Advisor type: ${advisorType}
${geo ? `Our target geographies: ${geo}` : ''}

Use web_search to gather all available data. Be thorough — check firm website, LinkedIn,
state licensing directories, SEC IAPD/BrokerCheck (for RIAs), state bar (for attorneys),
conference speaker lists, and press releases.

IMPORTANT: The source_log array is MANDATORY. Every data point must have a source.
Do NOT fabricate facts. If you can't verify something, use null.

Return the final JSON object only.`;

  return { systemPrompt, userPrompt };
}


// ─── Identify Prompt (unchanged — finds candidates in a geo) ────────────────

const ADVISOR_IDENTIFY_SYSTEM_PROMPT = `You are a research analyst for Sells Advisors, a sell-side M&A advisory firm targeting
trades and home-services businesses. Your job is to identify potential advisor referral
partners in a given geography.

We want "young and hungry" advisors — people actively building their book of business.
This is a PROFILE, not a firm size. It includes:
- Newly independent advisors (broke off from a big firm in last 0-5 years)
- Junior partners or just-made partners at any size firm
- Senior associates / senior managers on a partner track
- Producers at large firms who are personally building their book

What DISQUALIFIES someone is being senior enough to coast on inherited referral lanes.

Use web_search to find candidates matching the criteria. Search across:
- LinkedIn profiles
- State licensing directories (CPA boards, state bar, SEC IAPD)
- CEPA directory (exit-planning-institute.org)
- EOS Implementer directory (eosworldwide.com)
- Vistage Chair directory (vistage.com)
- Firm websites and team pages
- "40 under 40" / "rising stars" lists in trade publications
- Conference speaker lists
- Google searches with profession + geography

For each candidate found, return basic identifying information. DO NOT fabricate names —
only return people you found in actual search results.

Return a JSON object:
{
  "candidates": [
    {
      "name": "string",
      "firm": "string or null",
      "title": "string or null",
      "city": "string",
      "state": "string (2-letter)",
      "linkedin_url": "string or null",
      "website": "string or null",
      "source": "string — URL or directory where you found them",
      "why_they_fit": "string — brief reason they match our young-and-hungry criteria"
    }
  ],
  "search_notes": "string — what searches you ran, what worked, what didn't"
}`;

function buildIdentifyUserPrompt(advisorType, geo, filters = {}) {
  const typeLabel = {
    cpa: 'CPAs / accountants',
    ria: 'Wealth managers / RIAs',
    attorney: 'Estate / M&A / business attorneys',
    lender: 'Community bank lenders / SBA loan officers',
    coach: 'Business coaches / peer-group leaders',
    insurance: 'Commercial insurance brokers',
    fractional_cfo: 'Fractional / outsourced CFOs',
  }[advisorType] || advisorType;

  const searchQueries = {
    cpa: [
      `"CPA" "business advisory" OR "exit planning" OR "succession" "${geo}"`,
      `"CEPA" OR "CVA" CPA "${geo}"`,
      `site:linkedin.com CPA "business advisory" "${geo}"`,
      `"40 under 40" CPA "${geo}"`,
    ],
    ria: [
      `"wealth manager" OR "financial advisor" "business owner" OR "exit planning" "${geo}"`,
      `"CEPA" "wealth" OR "RIA" "${geo}"`,
      `"breakaway" OR "independent" RIA "${geo}"`,
      `site:adviserinfo.sec.gov "${geo}" "business owner"`,
    ],
    attorney: [
      `"attorney" "M&A" OR "succession planning" OR "business law" "${geo}"`,
      `"estate planning" "business owner" attorney "${geo}"`,
      `"40 under 40" OR "rising star" attorney "M&A" OR "business" "${geo}"`,
      `"Super Lawyers Rising Stars" "business" OR "M&A" "${geo}"`,
    ],
    lender: [
      `"SBA" "loan officer" OR "commercial banker" OR "BDO" "${geo}"`,
      `"community bank" "commercial lending" "${geo}"`,
      `"acquisition financing" "lender" OR "banker" "${geo}"`,
      `site:linkedin.com "SBA" "business development officer" "${geo}"`,
    ],
    coach: [
      `"EOS Implementer" "${geo}"`,
      `"Vistage Chair" "${geo}"`,
      `"business coach" "trades" OR "home services" OR "contractor" "${geo}"`,
      `"Nexstar" OR "Service Roundtable" coach "${geo}"`,
      `"Scaling Up" coach "${geo}"`,
    ],
    insurance: [
      `"commercial insurance" "broker" OR "producer" "trades" OR "contractor" "${geo}"`,
      `"buy-sell" "insurance" OR "key-person" "${geo}"`,
      `"CLU" OR "ChFC" "commercial" "broker" "${geo}"`,
    ],
    fractional_cfo: [
      `"fractional CFO" OR "outsourced CFO" "${geo}"`,
      `"interim CFO" "small business" "${geo}"`,
      `"B2B CFO" OR "CFO Hub" OR "Preferred CFO" "${geo}"`,
    ],
  };

  const suggestedQueries = searchQueries[advisorType] || [];

  return `Find ${typeLabel} in ${geo} who match our "young and hungry" advisor profile.

IMPORTANT — AGE/CAREER-STAGE TARGETING:
We specifically want a MIX of career stages, but at least 30-40% of candidates should be
EARLY-CAREER advisors — people who graduated college roughly 2018-2026 (within the last ~8 years).
These are associates, junior VPs, newly licensed advisors, or people who recently launched their
own practice. They have the most to gain from a referral partnership and are the least likely to
have established referral lanes locked in.

To find early-career candidates, search LinkedIn with graduation year filters or look for:
- "Associate" or "Analyst" or "Junior" in titles
- "Class of 2018" / "Class of 2019" / "Class of 2020" etc. on LinkedIn
- "40 under 40" or "rising stars" or "next gen" lists
- Recently licensed (check state board for recent licensure dates)
- Titles like "Associate Advisor", "Paraplanner promoted to Advisor", "Financial Planning Associate"

Also include mid-career and senior candidates who show strong hunger signals (breakaways,
new firms, recent CEPA certs), but make sure the batch isn't ALL 20+ year veterans.

Suggested search queries to start with:
${suggestedQueries.map(q => `- ${q}`).join('\n')}

${filters.requiredCredentials?.length ? `Required credentials: ${filters.requiredCredentials.join(', ')}` : ''}
${filters.preferredCredentials?.length ? `Preferred credentials: ${filters.preferredCredentials.join(', ')}` : ''}

Find 8-15 candidates. For each, gather their name, firm, title, city, state, and a brief
note on why they fit — ESPECIALLY note if they are early-career (graduated recently, newly
licensed, etc.). Only include people you actually found in search results — do NOT fabricate
names. Return the JSON object only.`;
}


module.exports = {
  getResearchSystemPrompt,
  ADVISOR_IDENTIFY_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
  buildIdentifyUserPrompt,
};
