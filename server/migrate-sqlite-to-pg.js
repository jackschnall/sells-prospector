#!/usr/bin/env node
/**
 * migrate-sqlite-to-pg.js — One-time migration from SQLite to Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node server/migrate-sqlite-to-pg.js
 *
 * What it does:
 *   1. Opens the SQLite database at data/prospector.db
 *   2. Ensures the Postgres schema exists (runs schema.sql)
 *   3. Migrates all tables: config, companies, notes, users, contacts, activities, markets
 *   4. Maps old outreach_status → pipeline_stage
 *   5. Maps INTEGER booleans → proper Postgres BOOLEAN
 *   6. Skips rows that already exist (ON CONFLICT DO NOTHING)
 *
 * Safe to re-run — uses INSERT ... ON CONFLICT DO NOTHING.
 */

require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'prospector.db');

async function migrate() {
  // ─── Open both databases ──────────────────────────────────────────────
  console.log('Opening SQLite database...');
  const sqlite = new Database(DB_PATH, { readonly: true });

  console.log('Connecting to Postgres...');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  // Test connection
  await pool.query('SELECT 1');
  console.log('Postgres connected.');

  // ─── Run schema.sql ───────────────────────────────────────────────────
  console.log('Ensuring Postgres schema...');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
  console.log('Schema OK.');

  // ─── Helper: check if SQLite table exists ─────────────────────────────
  function sqliteTableExists(name) {
    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!row;
  }

  // ─── 1. Config ────────────────────────────────────────────────────────
  if (sqliteTableExists('config')) {
    const configs = sqlite.prepare('SELECT * FROM config').all();
    console.log(`Migrating ${configs.length} config rows...`);
    for (const row of configs) {
      await pool.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING',
        [row.key, row.value]
      );
    }
  }

  // ─── 2. Companies ─────────────────────────────────────────────────────
  const companies = sqlite.prepare('SELECT * FROM companies').all();
  console.log(`Migrating ${companies.length} companies...`);

  for (const c of companies) {
    // Map outreach_status → pipeline_stage
    let pipelineStage = c.pipeline_stage || 'no_contact';
    if (!c.pipeline_stage && c.outreach_status) {
      const stageMap = {
        no_contact: 'no_contact',
        initial_contact: 'initial_contact',
        relationship: 'nurture',
      };
      pipelineStage = stageMap[c.outreach_status] || 'no_contact';
    }

    await pool.query(
      `INSERT INTO companies (
        id, name, name_key, city, state, phone, website, owner, email, address, linkedin,
        crm_known, crm_override, salesforce_id, status, score, tier,
        signals_json, flags_json, summary, outreach_angle, sources_json, raw_research,
        marked_for_outreach, outreach_status, last_researched_at,
        pipeline_stage, closed_lost_reason, pipeline_stage_changed_at, assigned_to,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28, $29, $30,
        $31, $32
      ) ON CONFLICT(id) DO NOTHING`,
      [
        c.id, c.name, c.name_key, c.city || null, c.state || null,
        c.phone || null, c.website || null, c.owner || null, c.email || null,
        c.address || null, c.linkedin || null,
        !!c.crm_known, !!c.crm_override, c.salesforce_id || null,
        c.status || 'pending', c.score || null, c.tier || null,
        c.signals_json || null, c.flags_json || null,
        c.summary || null, c.outreach_angle || null,
        c.sources_json || null, c.raw_research || null,
        !!c.marked_for_outreach, c.outreach_status || 'no_contact',
        c.last_researched_at || null,
        pipelineStage, c.closed_lost_reason || null,
        c.pipeline_stage_changed_at || null, c.assigned_to || null,
        c.created_at || new Date().toISOString(), c.updated_at || new Date().toISOString(),
      ]
    );
  }

  // ─── 3. Notes ─────────────────────────────────────────────────────────
  if (sqliteTableExists('notes')) {
    const notes = sqlite.prepare('SELECT * FROM notes').all();
    console.log(`Migrating ${notes.length} notes...`);
    for (const n of notes) {
      await pool.query(
        'INSERT INTO notes (id, company_id, note, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(id) DO NOTHING',
        [n.id, n.company_id, n.note, n.created_at || new Date().toISOString()]
      );
    }
  }

  // ─── 4. Users ─────────────────────────────────────────────────────────
  if (sqliteTableExists('users')) {
    const users = sqlite.prepare('SELECT * FROM users').all();
    console.log(`Migrating ${users.length} users...`);
    for (const u of users) {
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, invite_token, assigned_verticals, assigned_territories, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT(id) DO NOTHING`,
        [
          u.id, u.name, u.email, u.password_hash || null,
          u.role || 'analyst', u.invite_token || null,
          u.assigned_verticals || '[]', u.assigned_territories || '[]',
          u.created_at || new Date().toISOString(),
        ]
      );
    }
  }

  // ─── 5. Contacts ──────────────────────────────────────────────────────
  if (sqliteTableExists('contacts')) {
    const contacts = sqlite.prepare('SELECT * FROM contacts').all();
    console.log(`Migrating ${contacts.length} contacts...`);
    for (const ct of contacts) {
      await pool.query(
        `INSERT INTO contacts (id, company_id, name, title, phone, email, linkedin, is_primary, source, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT(id) DO NOTHING`,
        [
          ct.id, ct.company_id, ct.name, ct.title || null,
          ct.phone || null, ct.email || null, ct.linkedin || null,
          !!ct.is_primary, ct.source || 'manual', ct.notes || null,
          ct.created_at || new Date().toISOString(), ct.updated_at || new Date().toISOString(),
        ]
      );
    }
  }

  // ─── 6. Activities ────────────────────────────────────────────────────
  if (sqliteTableExists('activities')) {
    const activities = sqlite.prepare('SELECT * FROM activities').all();
    console.log(`Migrating ${activities.length} activities...`);
    for (const a of activities) {
      await pool.query(
        `INSERT INTO activities (id, company_id, contact_id, user_id, type, summary, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT(id) DO NOTHING`,
        [
          a.id, a.company_id, a.contact_id || null, a.user_id || null,
          a.type, a.summary, a.details || null,
          a.created_at || new Date().toISOString(),
        ]
      );
    }
  }

  // ─── 7. Markets ───────────────────────────────────────────────────────
  if (sqliteTableExists('markets')) {
    const markets = sqlite.prepare('SELECT * FROM markets').all();
    console.log(`Migrating ${markets.length} markets...`);
    for (const m of markets) {
      await pool.query(
        `INSERT INTO markets (
          key, city, state, population, msa_name, addressable, loaded, tier, score, confidence, sources_json,
          population_growth, median_home_value, housing_permits, housing_age_score, plumbing_density,
          ma_activity_score, market_score, saturation_status, home_sales_volume,
          analyzed_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19, $20,
          $21, $22
        ) ON CONFLICT(key) DO NOTHING`,
        [
          m.key, m.city, m.state, m.population || null, m.msa_name || null,
          m.addressable || null, m.loaded || null, m.tier || null, m.score || null,
          m.confidence || null, m.sources_json || null,
          m.population_growth || null, m.median_home_value || null,
          m.housing_permits || null, m.housing_age_score || null,
          m.plumbing_density || null, m.ma_activity_score || null,
          m.market_score || null, m.saturation_status || null,
          m.home_sales_volume || null,
          m.analyzed_at || new Date().toISOString(), m.updated_at || new Date().toISOString(),
        ]
      );
    }
  }

  // ─── Done ─────────────────────────────────────────────────────────────
  sqlite.close();

  // Verify counts
  const pgCompanies = await pool.query('SELECT COUNT(*) AS n FROM companies');
  const pgMarkets = await pool.query('SELECT COUNT(*) AS n FROM markets');
  const pgNotes = await pool.query('SELECT COUNT(*) AS n FROM notes');
  const pgUsers = await pool.query('SELECT COUNT(*) AS n FROM users');
  const pgContacts = await pool.query('SELECT COUNT(*) AS n FROM contacts');
  const pgActivities = await pool.query('SELECT COUNT(*) AS n FROM activities');

  console.log('\n=== Migration Complete ===');
  console.log(`Companies:  ${companies.length} SQLite → ${pgCompanies.rows[0].n} Postgres`);
  console.log(`Markets:    ${pgMarkets.rows[0].n} Postgres`);
  console.log(`Notes:      ${pgNotes.rows[0].n} Postgres`);
  console.log(`Users:      ${pgUsers.rows[0].n} Postgres`);
  console.log(`Contacts:   ${pgContacts.rows[0].n} Postgres`);
  console.log(`Activities: ${pgActivities.rows[0].n} Postgres`);

  await pool.end();
  console.log('\nDone. You can now start the server with DATABASE_URL set.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
