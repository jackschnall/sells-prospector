#!/usr/bin/env node
/**
 * cc-inject.js — CLI bridge between Claude Code and the Sells Prospector SQLite DB.
 *
 * Commands:
 *   list-pending              Print pending companies as JSON array
 *   get <id>                  Print full company row as JSON
 *   inject <id>               Read JSON from stdin, write research to DB, emit SSE event
 *   stats                     Print rollup stats
 *   set-status <id> <status>  Set company status (researching|error|done)
 *   add                       Read JSON array from stdin, insert new companies, print IDs
 *   list-all                  Print all companies (slim) as JSON array
 */

const {
  companiesToResearch,
  getCompany,
  insertCompany,
  normalizeName,
  updateCompanyResearch,
  setCompanyStatus,
  rollupStats,
  listCompanies,
} = require('./db');

const PORT = process.env.PORT || 3000;
const SSE_URL = `http://localhost:${PORT}/api/_cc-event`;

async function emitSSE(event) {
  try {
    const res = await fetch(SSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      console.error(`[cc-inject] SSE emit failed: ${res.status}`);
    }
  } catch {
    // Server might not be running — that's okay, DB write still succeeds.
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'list-pending': {
      const rows = companiesToResearch();
      const slim = rows.map(({ raw_research, signals_json, flags_json, sources_json, ...rest }) => rest);
      console.log(JSON.stringify(slim, null, 2));
      break;
    }

    case 'get': {
      const id = args[0];
      if (!id) { console.error('Usage: cc-inject get <id>'); process.exit(1); }
      const row = getCompany(id);
      if (!row) { console.error(`Company ${id} not found`); process.exit(1); }
      console.log(JSON.stringify(row, null, 2));
      break;
    }

    case 'inject': {
      const id = args[0];
      if (!id) { console.error('Usage: echo \'{"score":7.5,...}\' | cc-inject inject <id>'); process.exit(1); }

      const company = getCompany(id);
      if (!company) { console.error(`Company ${id} not found`); process.exit(1); }

      const json = await readStdin();
      let data;
      try {
        data = JSON.parse(json);
      } catch (err) {
        console.error('Invalid JSON on stdin:', err.message);
        process.exit(1);
      }

      // Ensure string-typed JSON columns
      if (data.signals_json && typeof data.signals_json !== 'string') {
        data.signals_json = JSON.stringify(data.signals_json);
      }
      if (data.flags_json && typeof data.flags_json !== 'string') {
        data.flags_json = JSON.stringify(data.flags_json);
      }
      if (data.sources_json && typeof data.sources_json !== 'string') {
        data.sources_json = JSON.stringify(data.sources_json);
      }
      if (data.raw_research && typeof data.raw_research !== 'string') {
        data.raw_research = JSON.stringify(data.raw_research);
      }

      // Defaults — updateCompanyResearch expects all named params
      data.status = data.status || 'done';
      data.owner = data.owner || null;
      data.phone = data.phone || null;
      data.email = data.email || null;
      data.address = data.address || null;
      data.linkedin = data.linkedin || null;
      data.score = data.score ?? null;
      data.tier = data.tier || null;
      data.signals_json = data.signals_json || null;
      data.flags_json = data.flags_json || null;
      data.summary = data.summary || null;
      data.outreach_angle = data.outreach_angle || null;
      data.sources_json = data.sources_json || null;
      data.raw_research = data.raw_research || null;

      updateCompanyResearch(id, data);

      // Emit SSE so frontend updates live
      const stats = rollupStats();
      await emitSSE({
        type: 'company_done',
        id: company.id,
        name: company.name,
        score: data.score,
        tier: data.tier,
      });
      await emitSSE({
        type: 'progress',
        done: stats.researched,
        total: stats.total,
      });

      console.log(JSON.stringify({
        ok: true,
        id,
        name: company.name,
        score: data.score,
        tier: data.tier,
        stats,
      }));
      break;
    }

    case 'stats': {
      console.log(JSON.stringify(rollupStats(), null, 2));
      break;
    }

    case 'set-status': {
      const id = args[0];
      const status = args[1];
      if (!id || !status) { console.error('Usage: cc-inject set-status <id> <status>'); process.exit(1); }

      const company = getCompany(id);
      if (!company) { console.error(`Company ${id} not found`); process.exit(1); }

      setCompanyStatus(id, status);

      await emitSSE({
        type: 'stage',
        stage: 'research',
        status: status === 'researching' ? 'running' : status,
        id: company.id,
        name: company.name,
      });

      console.log(JSON.stringify({ ok: true, id, status }));
      break;
    }

    case 'add': {
      const { nanoid } = require('nanoid');
      const json = await readStdin();
      let candidates;
      try {
        candidates = JSON.parse(json);
      } catch (err) {
        console.error('Invalid JSON on stdin:', err.message);
        process.exit(1);
      }
      if (!Array.isArray(candidates)) candidates = [candidates];

      const results = [];
      for (const c of candidates) {
        if (!c.name) { results.push({ error: 'missing name' }); continue; }
        const id = nanoid();
        const name_key = normalizeName(c.name);
        if (!name_key) { results.push({ error: 'empty name_key', name: c.name }); continue; }
        try {
          insertCompany({
            id,
            name: c.name,
            name_key,
            city: c.city || null,
            state: c.state || null,
            phone: c.phone || null,
            website: c.website || null,
            owner: c.owner || null,
            email: c.email || null,
            address: c.address || null,
            crm_known: 0,
          });
          results.push({ ok: true, id, name: c.name, name_key });
        } catch (err) {
          // ON CONFLICT means it already exists — look it up
          const existing = listCompanies({ search: c.name });
          const match = existing.find(r => r.name_key === name_key);
          results.push({ ok: true, id: match ? match.id : 'existing', name: c.name, note: 'already exists' });
        }
      }

      await emitSSE({ type: 'queue', total: rollupStats().total });
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case 'list-all': {
      const rows = listCompanies({ sort: 'score_desc' });
      const slim = rows.map(({ raw_research, signals_json, flags_json, sources_json, ...rest }) => rest);
      console.log(JSON.stringify(slim, null, 2));
      break;
    }

    case 'sync': {
      const { execSync } = require('child_process');
      const root = require('path').resolve(__dirname, '..');
      const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString().trim();

      // Checkpoint WAL so the DB is a single file
      const db = require('better-sqlite3')(require('path').join(root, 'data', 'prospector.db'));
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();

      // Stage, commit, push
      run('git add data/prospector.db');
      const status = run('git status --porcelain data/prospector.db');
      if (!status) {
        console.log(JSON.stringify({ ok: true, action: 'no-op', message: 'DB unchanged, nothing to push' }));
        break;
      }
      run('git commit -m "Update research data\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"');
      run('git push');
      console.log(JSON.stringify({ ok: true, action: 'pushed', message: 'DB pushed to GitHub — Railway will redeploy' }));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd || '(none)'}`);
      console.error('Commands: list-pending, get <id>, inject <id>, stats, set-status <id> <status>, add, list-all, sync');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
