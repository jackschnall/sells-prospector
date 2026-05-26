const fs = require('fs');
const path = require('path');

// Load config (re-read each call so edits take effect without restart)
function loadConfig() {
  const configPath = path.join(__dirname, 'advisor-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ─── Fit Score ──────────────────────────────────────────────────────────────

/**
 * Compute the hunger sub-score from dossier hunger_signals.
 * Each sub-signal is scored 0-10, then combined via sub-weights.
 */
function computeHungerScore(dossier) {
  const config = loadConfig();
  const sw = config.hungerSubWeights;
  const hs = dossier.hunger_signals || {};

  const hasGrowthSignals = Array.isArray(hs.growing_team_signals)
    ? hs.growing_team_signals.length > 0
    : !!hs.growing_team;

  const scores = {
    newly_independent: hs.newly_independent ? 9 : (dossier.firm_profile?.is_newly_independent ? 8 : 3),
    career_stage: scoreCareerStage(hs.career_stage),
    personal_book_incentive: scoreBookIncentive(hs.personal_book_incentive),
    content_output: scoreContentOutput(hs.content_output_frequency),
    recent_certifications: scoreCerts(hs.recent_certifications),
    growing_team: hasGrowthSignals ? 8 : 4,
  };

  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(sw)) {
    const s = scores[key];
    if (typeof s === 'number') {
      total += s * weight;
      weightSum += weight;
    }
  }
  return weightSum > 0 ? +(total / weightSum).toFixed(2) : 5;
}

function scoreCareerStage(stage) {
  if (!stage) return 5;
  // Handle the structured enum values from the new schema
  const enumScores = {
    newly_independent: 9,
    junior_partner: 8,
    just_made_partner: 8,
    senior_associate_on_track: 7,
    senior_manager_on_track: 7,
    producer_at_large_firm: 7,
    established: 3,
    unknown: 5,
  };
  if (enumScores[stage] !== undefined) return enumScores[stage];
  // Fallback: fuzzy match for free-text career_stage values
  const s = stage.toLowerCase();
  if (s.includes('solo') || s.includes('founder') || s.includes('launched') || s.includes('newly_independent')) return 9;
  if (s.includes('junior partner') || s.includes('just-made') || s.includes('new partner')) return 8;
  if (s.includes('senior manager') || s.includes('senior associate') || s.includes('partner track')) return 7;
  if (s.includes('producer')) return 7;
  if (s.includes('associate') || s.includes('manager')) return 6;
  if (s.includes('senior partner') || s.includes('managing partner') || s.includes('established')) return 3;
  return 5;
}

function scoreBookIncentive(incentive) {
  // New schema uses boolean; old schema used string
  if (incentive === true) return 9;
  if (incentive === false) return 4;
  if (!incentive) return 5;
  const s = String(incentive).toLowerCase();
  if (s.includes('eat-what-you-kill') || s.includes('producer') || s.includes('commission')) return 9;
  if (s.includes('hybrid') || s.includes('bonus')) return 7;
  if (s.includes('salaried')) return 4;
  return 5;
}

function scoreContentOutput(freq) {
  const map = { high: 9, medium: 7, low: 4, none: 2 };
  return map[freq] || 5;
}

function scoreCerts(certs) {
  if (!Array.isArray(certs) || certs.length === 0) return 3;
  const currentYear = new Date().getFullYear();
  const recent = certs.filter(c => c.year && c.year >= currentYear - 3);
  if (recent.length >= 2) return 9;
  if (recent.length === 1) return 7;
  return 5;
}

/**
 * Compute the full fit score from a dossier.
 * Returns { fitScore, breakdown } where breakdown has per-category scores.
 */
function computeFitScore(dossier, advisorType, pipelineGeos = []) {
  const config = loadConfig();
  const w = config.fitScoreWeights;

  const breakdown = {
    profile_fit: scoreProfileFit(dossier, advisorType),
    hunger_signals: computeHungerScore(dossier),
    client_overlap: scoreClientOverlap(dossier, pipelineGeos),
    network_strength: scoreNetworkStrength(dossier),
    reachability: scoreReachability(dossier),
    geographic_relevance: scoreGeographicRelevance(dossier, pipelineGeos),
  };

  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(w)) {
    const s = breakdown[key];
    if (typeof s === 'number') {
      total += s * weight;
      weightSum += weight;
    }
  }

  const fitScore = weightSum > 0 ? +(total / weightSum).toFixed(2) : 0;

  return { fitScore, breakdown };
}

function scoreProfileFit(dossier, advisorType) {
  let score = 5;
  const ss = dossier.specialty_signals || {};

  if (ss.serves_business_owners) score += 1.5;
  if (ss.serves_smb_trades_homeservices) score += 1.5;
  if (ss.does_exit_or_succession_work) score += 1;
  if (ss.deal_or_transaction_experience) score += 0.5;

  // Credential bonus
  const creds = dossier.credentials || [];
  const config = loadConfig();
  const typeConfig = config.perTypeFilters[advisorType] || {};
  const preferred = typeConfig.preferredCredentials || [];
  for (const c of creds) {
    if (preferred.includes(c.credential)) score += 0.3;
  }

  return Math.min(10, Math.max(0, +score.toFixed(2)));
}

function scoreClientOverlap(dossier, pipelineGeos) {
  let score = 5;
  const ns = dossier.network_signals || {};
  const overlap = (ns.icp_client_overlap_estimate || '').toLowerCase();

  // Handle both enum values and free-text
  if (overlap === 'high' || overlap.includes('strong') || overlap.includes('yes')) score += 3;
  else if (overlap === 'medium' || overlap.includes('moderate') || overlap.includes('some')) score += 1.5;
  else if (overlap === 'low' || overlap.includes('no') || overlap.includes('unlikely')) score -= 1;
  // 'unknown' leaves score at 5

  const ss = dossier.specialty_signals || {};
  if (ss.serves_smb_trades_homeservices) score += 1;

  // Evidence bonus
  const evidence = ss.evidence || ns.icp_overlap_evidence || [];
  if (Array.isArray(evidence) && evidence.length > 0) score += 0.5;

  return Math.min(10, Math.max(0, +score.toFixed(2)));
}

function scoreNetworkStrength(dossier) {
  let score = 5;
  const ns = dossier.network_signals || {};

  // Handle both old and new field names
  const memberships = ns.associations_and_memberships || ns.chamber_or_association_memberships || [];
  score += Math.min(2, memberships.length * 0.5);

  const followers = ns.linkedin_follower_count;
  if (typeof followers === 'number') {
    if (followers > 5000) score += 2;
    else if (followers > 1000) score += 1;
    else if (followers > 500) score += 0.5;
  }

  const engagement = (ns.engagement_density || '').toLowerCase();
  if (engagement === 'high' || engagement.includes('strong')) score += 1;
  else if (engagement === 'medium') score += 0.5;

  // Handle both string and array formats for referral_partner_signals
  const referralSignals = ns.referral_partner_signals;
  if (Array.isArray(referralSignals) && referralSignals.length > 0) score += 1;
  else if (typeof referralSignals === 'string' && (referralSignals.toLowerCase().includes('yes') || referralSignals.toLowerCase().includes('active'))) score += 1;

  return Math.min(10, Math.max(0, +score.toFixed(2)));
}

function scoreReachability(dossier) {
  let score = 4;
  const r = dossier.reachability || {};

  if (r.has_email) score += 2;
  if (r.has_phone) score += 2;
  if (r.active_on_linkedin) score += 2;

  return Math.min(10, Math.max(0, score));
}

function scoreGeographicRelevance(dossier, pipelineGeos) {
  if (!pipelineGeos || pipelineGeos.length === 0) return 6; // neutral default

  const basics = dossier.basics || {};
  const location = (basics.location || '').toLowerCase();
  const state = location.split(',').pop()?.trim().toUpperCase();

  // Check if advisor's state matches any pipeline geo
  for (const geo of pipelineGeos) {
    if (geo.toUpperCase() === state) return 9;
    if (location.includes(geo.toLowerCase())) return 8;
  }
  return 4;
}

// ─── Relationship Score ─────────────────────────────────────────────────────

/**
 * Compute relationship score based on activity data.
 * @param {Object} data - { referrals_in, referrals_out, last_contact_date, contacts_count, responses_count, outreach_count, connection_count_prev, connection_count_now }
 */
function computeRelationshipScore(data) {
  const config = loadConfig();
  const w = config.relationshipScoreWeights;
  const decay = config.relationshipDecay;

  // Referral activity (50%)
  const totalReferrals = (data.referrals_in || 0) + (data.referrals_out || 0);
  const referralScore = Math.min(10, totalReferrals * 2.5);

  // Engagement recency (25%) — decays over time
  let recencyScore = 0;
  if (data.last_contact_date) {
    const daysSince = (Date.now() - new Date(data.last_contact_date).getTime()) / (1000 * 60 * 60 * 24);
    // Exponential decay with configurable half-life
    recencyScore = 10 * Math.pow(0.5, daysSince / decay.halfLifeDays);
  }

  // Response rate (15%)
  const responseRate = data.outreach_count > 0
    ? (data.responses_count || 0) / data.outreach_count
    : 0;
  const responseScore = responseRate * 10;

  // Connection density growth (10%)
  let connectionScore = 5; // neutral
  if (data.connection_count_now && data.connection_count_prev) {
    const growth = data.connection_count_now - data.connection_count_prev;
    connectionScore = Math.min(10, 5 + growth);
  }

  const breakdown = {
    referral_activity: +referralScore.toFixed(2),
    engagement_recency: +recencyScore.toFixed(2),
    response_rate: +responseScore.toFixed(2),
    connection_density_growth: +connectionScore.toFixed(2),
  };

  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(w)) {
    const s = breakdown[key];
    if (typeof s === 'number') {
      total += s * weight;
      weightSum += weight;
    }
  }

  const score = weightSum > 0 ? +(total / weightSum).toFixed(2) : 0;
  return { score: Math.max(config.relationshipDecay.minScore, score), breakdown };
}

// ─── Tier ───────────────────────────────────────────────────────────────────

function computeAdvisorTier(fitScore) {
  const config = loadConfig();
  if (fitScore >= config.tierThresholds.strong_fit) return 'strong-fit';
  if (fitScore >= config.tierThresholds.moderate_fit) return 'moderate-fit';
  return 'low-fit';
}

module.exports = {
  computeFitScore,
  computeHungerScore,
  computeRelationshipScore,
  computeAdvisorTier,
  loadConfig,
};
