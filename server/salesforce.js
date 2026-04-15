// Salesforce integration — stubbed for v1.
// The manual "paste CRM names" fallback is handled via db.markCrmKnown + /api/salesforce/known-names.
// When real OAuth is wired up later, replace fetchKnownAccountNames() with a jsforce call.

const { getConfig, setConfig, markCrmKnown } = require('./db');

async function getPastedKnownNames() {
  return (await getConfig('crm_known_names', [])) || [];
}

async function setPastedKnownNames(names) {
  const clean = (Array.isArray(names) ? names : String(names || '').split(/\r?\n/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  await setConfig('crm_known_names', clean);
  const marked = await markCrmKnown(clean);
  return { count: clean.length, marked };
}

// Stub — returns a predictable 200 payload showing what would be pushed.
function pushStub(company) {
  return {
    ok: true,
    stubbed: true,
    would_push: {
      salesforce_id: company.salesforce_id || null,
      MA_Score__c: company.score,
      MA_Tier__c: company.tier,
      MA_Last_Researched__c: company.last_researched_at,
      MA_Summary__c: company.summary,
      // Estimated_Revenue_Range__c intentionally omitted until thesis mapping is finalized
    },
    note: 'Real Salesforce push not configured. Wire up jsforce in server/salesforce.js when OAuth is ready.',
  };
}

module.exports = {
  getPastedKnownNames,
  setPastedKnownNames,
  pushStub,
};
