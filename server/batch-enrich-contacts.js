#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Batch Contact Enrichment — re-run the two-phase identity resolution +
// people-search enrichment on all researched companies.
//
// Usage:
//   DATABASE_URL=... node server/batch-enrich-contacts.js [--limit N] [--offset N] [--dry-run]
//
// This only runs the contact enrichment step (server/contact-enrichment.js).
// It does NOT re-run research, scoring, or flags.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { pool, initSchema, getCompany, execute } = require('./db');
const { runContactEnrichment } = require('./contact-enrichment');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const limit = Number(args.find((a, i) => args[i - 1] === '--limit') || 0) || 999;
  const offset = Number(args.find((a, i) => args[i - 1] === '--offset') || 0) || 0;
  const dryRun = args.includes('--dry-run');

  await initSchema();

  // Get all researched companies, ordered by score desc
  const { rows } = await pool.query(
    `SELECT id, name, city, state, owner, phone, email, website, score, tier
     FROM companies
     WHERE status = 'done' AND deleted_at IS NULL
     ORDER BY score DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  console.log(`\n=== Batch Contact Enrichment ===`);
  console.log(`Companies to process: ${rows.length} (offset ${offset}, limit ${limit})`);
  if (dryRun) console.log('DRY RUN — no DB writes\n');
  else console.log('');

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const tag = `[${i + 1}/${rows.length}]`;

    // Parse existing research if available (for context passed to enrichment)
    let existingResearch = null;
    try {
      const full = await getCompany(c.id);
      if (full?.raw_research) {
        existingResearch = typeof full.raw_research === 'string'
          ? JSON.parse(full.raw_research)
          : full.raw_research;
      }
    } catch {}

    console.log(`${tag} ${c.name} (${c.city || '?'}, ${c.state || '?'}) — score ${c.score || '?'}...`);

    if (dryRun) {
      console.log(`  → [dry-run] would enrich\n`);
      skipped++;
      continue;
    }

    try {
      const result = await runContactEnrichment(c, existingResearch);
      const contact = result.contact || {};

      // Update company fields with enriched data (prefer enriched over existing)
      const updates = {};
      if (contact.owner_name && (!c.owner || contact.identity_confidence === 'high')) {
        updates.owner = contact.owner_name;
      }
      if (contact.direct_cell || contact.business_phone) {
        const bestPhone = contact.direct_cell || contact.business_phone;
        if (bestPhone && bestPhone !== c.phone) updates.phone = bestPhone;
      }
      if (contact.direct_email && !c.email) {
        updates.email = contact.direct_email;
      }

      // Store full enrichment JSON
      const enrichJson = JSON.stringify({
        identity: result.identity,
        enrichment: result.enrichment,
        contact: result.contact,
      });

      // Build UPDATE query
      const sets = ['contact_enrichment = $1'];
      const params = [enrichJson];
      let idx = 2;
      for (const [key, val] of Object.entries(updates)) {
        sets.push(`${key} = $${idx++}`);
        params.push(val);
      }
      params.push(c.id);
      await execute(`UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`, params);

      const conf = contact.identity_confidence || '?';
      const cConf = contact.contact_confidence || '?';
      const cell = contact.direct_cell || 'none';
      console.log(`  ✓ identity: ${conf}, contact: ${cConf}, cell: ${cell}`);
      if (Object.keys(updates).length) {
        console.log(`  → updated: ${Object.keys(updates).join(', ')}`);
      }
      success++;
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}`);
      failed++;
    }

    // Rate limit — don't hammer the APIs
    if (i < rows.length - 1) await sleep(2000);
  }

  console.log(`\n=== Done ===`);
  console.log(`Success: ${success}, Failed: ${failed}, Skipped: ${skipped}`);
  console.log(`Total: ${rows.length}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
