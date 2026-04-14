const { MODELS, callJson } = require('./claude');
const { CONTACTS_SYSTEM_PROMPT } = require('./prompts');
const { mockContacts } = require('./mock');

async function runContacts(company, research) {
  if (process.env.MOCK_MODE === '1') {
    return mockContacts(company, research);
  }

  const userPrompt = `Company: ${company.name} (${company.city || '?'}, ${company.state || '?'})
CSV-provided phone: ${company.phone || 'none'}
CSV-provided owner: ${company.owner || 'none'}

Raw research:
${JSON.stringify(research, null, 2)}

Extract the best contact information and return the required JSON.`;

  const { parsed } = await callJson({
    model: MODELS.worker,
    system: CONTACTS_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 800,
  });

  return {
    owner: parsed.owner || company.owner || null,
    phone: parsed.phone || company.phone || null,
    email: parsed.email || null,
    address: parsed.address || null,
    linkedin: parsed.linkedin || null,
    confidence: parsed.confidence || 'low',
  };
}

module.exports = { runContacts };
