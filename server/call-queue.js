// ─────────────────────────────────────────────────────────────────────────────
// Call Queue — priority algorithm for the analyst's daily call surface.
//
// Buckets (in priority order, de-duped across buckets):
//   1. Scheduled callback due today or overdue (from a completed debrief OR
//      a manually-added calendar event tied to a company)
//   2. Prime never contacted (strong-buy, no call_logs)
//   3. Prime no-answer (strong-buy, most recent sentiment == 'No Answer')
//   4. Emerging never contacted (watchlist, no call_logs)
//   5. Missing phone — admin operational bucket to keep data hygiene visible
//
// Exclusions:
//   - Any company with a call_log in the past `cooldown_days` (default 7)
//   - Any company in queue_skips for today
//   - Any company in terminal pipeline stages (deal_closed, closed_lost)
//   - Scope:
//       admin → all companies
//       analyst → companies whose state ∈ assigned_territories
//                 (vertical filter deferred — all companies are plumbing today)
// ─────────────────────────────────────────────────────────────────────────────

const { pool, getUserConfig } = require('./db');

const TERMINAL_STAGES = ['deal_closed', 'closed_lost'];

function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Build a ranked call queue for a user.
 * @param {object} user - { id, role, assigned_verticals, assigned_territories }
 * @param {object} [opts] - { limit?: number, pins?: string[] }
 * @returns {Promise<{ queue: array, cooldown_days: number, empty_reason?: string }>}
 */
async function buildQueue(user, opts = {}) {
  if (!user) throw new Error('user required');
  const limit = Math.max(1, Math.min(200, opts.limit || 50));
  const pins = Array.isArray(opts.pins) ? opts.pins : [];
  const cooldownDays = Number(await getUserConfig(user.id, 'queue_cooldown_days', 7)) || 7;
  const isAdmin = user.role === 'admin';

  // Analyst scope: territories (state codes). Empty → empty queue w/ hint.
  const territories = parseArr(user.assigned_territories).map((t) => String(t).toUpperCase());
  if (!isAdmin && territories.length === 0) {
    return { queue: [], cooldown_days: cooldownDays, empty_reason: 'no_assignments' };
  }

  // Load queue_skips for today (user-scoped).
  const { rows: skipRows } = await pool.query(
    `SELECT company_id FROM queue_skips WHERE user_id = $1 AND skipped_on = CURRENT_DATE`,
    [user.id]
  );
  const skipSet = new Set(skipRows.map((r) => r.company_id));

  // Base candidate set: companies in scope, excluding terminal stages.
  const territoryFilter = isAdmin ? '' : `AND UPPER(COALESCE(c.state, '')) = ANY($1::text[])`;
  const baseParams = isAdmin ? [] : [territories];
  const terminalIdx = baseParams.length + 1;
  baseParams.push(TERMINAL_STAGES);
  const cooldownIdx = baseParams.length + 1;
  baseParams.push(cooldownDays);

  // Pull each company with: last-call info + next scheduled callback (if any).
  // We left-join the MOST RECENT call_log per company and a pending callback event.
  // We also left-join the SOONEST upcoming manual calendar event (today or overdue).
  const sql = `
    WITH last_call AS (
      SELECT DISTINCT ON (company_id)
        company_id,
        id            AS last_call_id,
        called_at     AS last_called_at,
        sentiment     AS last_sentiment,
        status        AS last_status,
        debrief_status AS last_debrief_status
      FROM call_logs
      ORDER BY company_id, called_at DESC NULLS LAST
    ),
    pending_callback AS (
      SELECT DISTINCT ON (cl.company_id)
        cl.company_id,
        cl.id AS call_log_id,
        cl.scheduled_callback_date
      FROM call_logs cl
      WHERE cl.scheduled_callback_date IS NOT NULL
        AND cl.debrief_status = 'complete'
        AND cl.scheduled_callback_date <= CURRENT_DATE
      ORDER BY cl.company_id, cl.scheduled_callback_date ASC
    ),
    pending_event AS (
      SELECT DISTINCT ON (ce.company_id)
        ce.company_id,
        ce.id         AS event_id,
        ce.starts_at  AS event_starts_at,
        ce.title      AS event_title,
        ce.description AS event_description,
        ce.source     AS event_source
      FROM calendar_events ce
      WHERE ce.company_id IS NOT NULL
        AND COALESCE(ce.completed, FALSE) = FALSE
        AND ce.starts_at::date <= CURRENT_DATE
      ORDER BY ce.company_id, ce.starts_at ASC
    )
    SELECT
      c.id, c.name, c.city, c.state, c.phone, c.owner, c.email,
      c.score, c.tier, c.outreach_angle, c.pipeline_stage,
      lc.last_call_id, lc.last_called_at, lc.last_sentiment,
      lc.last_status, lc.last_debrief_status,
      pc.scheduled_callback_date, pc.call_log_id AS callback_call_log_id,
      pe.event_id, pe.event_starts_at, pe.event_title, pe.event_description, pe.event_source
    FROM companies c
    LEFT JOIN last_call lc ON lc.company_id = c.id
    LEFT JOIN pending_callback pc ON pc.company_id = c.id
    LEFT JOIN pending_event pe ON pe.company_id = c.id
    WHERE (c.pipeline_stage IS NULL OR NOT (c.pipeline_stage = ANY($${terminalIdx}::text[])))
      ${territoryFilter}
      -- cooldown: exclude if last call within cooldown_days AND no pending callback/event due
      AND (
        lc.last_called_at IS NULL
        OR lc.last_called_at < NOW() - ($${cooldownIdx} || ' days')::interval
        OR pc.scheduled_callback_date IS NOT NULL
        OR pe.event_id IS NOT NULL
      )
    ORDER BY c.score DESC NULLS LAST, c.name ASC
  `;
  const { rows: candidates } = await pool.query(sql, baseParams);

  // Filter out today's skips (unless the row is a pinned override).
  const pinSet = new Set(pins);
  const usable = candidates.filter((r) => pinSet.has(r.id) || !skipSet.has(r.id));

  // Assign buckets + reason.
  const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const seen = new Set();

  function push(bucket, row, reason) {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    buckets[bucket].push({
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      phone: row.phone,
      owner: row.owner,
      email: row.email,
      score: row.score,
      tier: row.tier,
      outreach_angle: row.outreach_angle,
      pipeline_stage: row.pipeline_stage,
      bucket,
      reason,
      last_call: row.last_call_id
        ? {
            id: row.last_call_id,
            called_at: row.last_called_at,
            sentiment: row.last_sentiment,
            status: row.last_status,
            debrief_status: row.last_debrief_status,
          }
        : null,
      callback: row.scheduled_callback_date
        ? {
            date: row.scheduled_callback_date,
            call_log_id: row.callback_call_log_id,
          }
        : null,
      event: row.event_id
        ? {
            id: row.event_id,
            starts_at: row.event_starts_at,
            title: row.event_title,
            description: row.event_description,
            source: row.event_source,
          }
        : null,
    });
  }

  // Pinned rows always go to the top as a synthetic bucket-0 group (rendered as bucket 1).
  for (const row of usable) {
    if (pinSet.has(row.id)) push(1, row, 'Pinned to top');
  }

  for (const row of usable) {
    // Bucket 1a: scheduled callback due (from completed debrief)
    if (row.scheduled_callback_date) {
      const when = new Date(row.scheduled_callback_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const whenDay = new Date(when.getFullYear(), when.getMonth(), when.getDate());
      const overdue = whenDay < today;
      push(1, row, overdue ? 'Callback overdue' : 'Callback due today');
      continue;
    }
    // Bucket 1b: manual calendar event for today or overdue
    if (row.event_id) {
      const when = new Date(row.event_starts_at);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const whenDay = new Date(when.getFullYear(), when.getMonth(), when.getDate());
      const overdue = whenDay < today;
      const timeStr = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const title = row.event_title || 'Scheduled task';
      const reason = overdue
        ? `Overdue: ${title}`
        : `${timeStr} — ${title}`;
      push(1, row, reason);
      continue;
    }
    const hasCall = !!row.last_call_id;
    // Bucket 2: Prime never contacted
    if (!hasCall && row.tier === 'strong-buy') {
      push(2, row, 'Prime target — never called');
      continue;
    }
    // Bucket 3: Prime no-answer
    if (hasCall && row.tier === 'strong-buy' && row.last_sentiment === 'No Answer') {
      push(3, row, 'Prime — no answer last time');
      continue;
    }
    // Bucket 4: Emerging never contacted
    if (!hasCall && row.tier === 'watchlist') {
      push(4, row, 'Emerging — never called');
      continue;
    }
    // Bucket 5: Missing phone (operational)
    if (!row.phone && row.tier !== 'pass') {
      push(5, row, 'Missing phone — research needed');
      continue;
    }
  }

  const queue = []
    .concat(buckets[1], buckets[2], buckets[3], buckets[4], buckets[5])
    .slice(0, limit)
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return {
    queue,
    cooldown_days: cooldownDays,
    empty_reason: queue.length === 0 ? 'all_caught_up' : undefined,
  };
}

module.exports = { buildQueue };
