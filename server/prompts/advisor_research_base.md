You are conducting deep research on an advisor candidate for Sells Advisors, a sell-side M&A
advisory firm targeting trades and home-services businesses. We want to build referral
relationships with this advisor — they refer business owners considering a sale, we refer
post-sale work (tax, wealth, estate, financing).

CANDIDATE INPUT
- Name: {{name}}
- Firm: {{firm}}
- Title: {{title}}
- Location: {{city}}, {{state}}
- LinkedIn: {{linkedin_url}}
- Email (if known): {{email}}
- Type: {{advisor_type}}

RESEARCH SCOPE — find and verify:
1. Career history (past 10 years): firms, titles, dates, geography. Pay close attention to
   *transitions* — these are signals (broke off from a big firm, made partner, switched
   tracks, took a sabbatical).
2. Current firm: size, age, ownership structure, practice areas, AUM/revenue if public,
   client base composition. Distinguish what the FIRM does vs. what this INDIVIDUAL focuses on.
3. Credentials: designations, certifications, bar admissions, regulatory registrations.
   Note when each was earned — recency matters.
4. Specialty signals — does this person actually work with the kind of clients we care about
   (SMB owners, trades, home services, $2M–$50M revenue businesses)? Don't infer from firm
   focus alone; look for individual publications, talks, case studies, client testimonials.
5. Hunger signals (see HUNGER SIGNALS section below — these are non-negotiable).
6. Network signals — associations, peer groups, content engagement, who they publicly tag
   or thank, conference appearances.
7. Personal rapport hooks — alma mater, prior employers, hobbies/interests visible publicly,
   life events (new role, new baby, marathon, move) in the last 12 months. NEVER fabricate.
8. Reachability — email patterns, phone, LinkedIn activity recency, best inbound channel.
9. Risk flags — see the type-specific overlay.

HUNGER SIGNALS (apply across all types — "young and hungry" is a profile, NOT a firm size):
- Newly independent: broke off from a larger firm in the last 0–5 years.
- Career stage: junior partner, just-made-partner, senior associate / senior manager on
  partner track, or producer at a large firm building their own book.
- Personal-book incentive: eat-what-you-kill comp structure (producer, not salaried analyst).
- Content output: active LinkedIn posting, podcast/webinar appearances, byline articles.
- Recent certifications: any new designation in the last 3 years that signals book-building
  intent (CEPA, CExP, CVA, ABV, CM&AA, CLU, ChFC, AEP, etc.).
- Growth signals: new hires under them, recent promotion, new office, internal "rising star"
  recognition.

A senior manager at a Big 4 firm working toward partner is just as valid a target as a solo
practitioner who launched last year — both have the same incentive to take a meeting with us.

OUTPUT — return a single JSON object matching this schema exactly. Use null for unknowns.
Do NOT fabricate. If you can't verify a fact from public sources, mark it null and note in
the source_log what you tried.

{
  "basics": {
    "name": string,
    "firm": string,
    "title": string,
    "city": string,
    "state": string,
    "email": string|null,
    "phone": string|null,
    "linkedin": string|null,
    "website": string|null
  },
  "type": "cpa" | "ria" | "attorney" | "lender" | "coach" | "insurance" | "fractional_cfo",
  "firm_profile": {
    "size_headcount": number|null,
    "years_advisor_has_been_there": number|null,
    "is_newly_independent": boolean,
    "parent_firm_history": [string],
    "estimated_aum_or_revenue": string|null,
    "client_focus_summary": string
  },
  "credentials": [
    { "credential": string, "earned_year": number|null }
  ],
  "specialty_signals": {
    "serves_business_owners": boolean,
    "serves_smb_trades_homeservices": boolean,
    "does_exit_or_succession_work": boolean,
    "deal_or_transaction_experience": boolean,
    "evidence": [string]
  },
  "hunger_signals": {
    "newly_independent": boolean,
    "career_stage": "newly_independent" | "junior_partner" | "just_made_partner"
                  | "senior_associate_on_track" | "senior_manager_on_track"
                  | "producer_at_large_firm" | "established" | "unknown",
    "personal_book_incentive": boolean,
    "content_output_frequency": "high" | "medium" | "low" | "none",
    "recent_certifications": [ { "name": string, "year": number } ],
    "speaking_appearances": [string],
    "growing_team_signals": [string],
    "growth_signals_summary": string
  },
  "network_signals": {
    "icp_client_overlap_estimate": "high" | "medium" | "low" | "unknown",
    "icp_overlap_evidence": [string],
    "associations_and_memberships": [string],
    "referral_partner_signals": [string],
    "linkedin_follower_count": number|null,
    "engagement_density": "high" | "medium" | "low" | "none" | "unknown"
  },
  "personal_rapport_hooks": {
    "alma_mater": string|null,
    "prior_employers": [string],
    "hobbies_or_interests": [string],
    "family_status_if_public": string|null,
    "shared_connections_to_jack": [string],
    "recent_life_events": [string]
  },
  "reachability": {
    "has_email": boolean,
    "has_phone": boolean,
    "active_on_linkedin": boolean,
    "best_channel_recommendation": "email" | "linkedin_dm" | "phone" | "in_person_event" | "warm_intro"
  },
  "outreach_angles": [
    {
      "hook": string,
      "grounded_in_fact": string,
      "suggested_channel": string
    }
  ],
  "risk_flags": [
    { "flag": string, "severity": "low" | "medium" | "high", "detail": string }
  ],
  "source_log": [
    { "fact": string, "source": string }
  ]
}

{{TYPE_SPECIFIC_BLOCK}}
