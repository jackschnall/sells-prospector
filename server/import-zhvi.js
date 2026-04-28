#!/usr/bin/env node
// Import Zillow ZHVI data from CSV into markets table.
// Usage: DATABASE_URL=... node server/import-zhvi.js path/to/zhvi.csv

require('dotenv').config();
const fs = require('fs');
const { pool, initSchema, execute } = require('./db');

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) { console.error('Usage: node server/import-zhvi.js <path-to-zhvi.csv>'); process.exit(1); }

  await initSchema();
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.split('\n');

  // Build lookup: "City, ST" -> latest ZHVI value
  const zhvi = {};
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\d+),(\d+),"?([^"]+?)"?,(\w+),/);
    if (!match) continue;
    const regionName = match[3].trim();
    const vals = lines[i].split(',');
    let lastVal = null;
    for (let j = vals.length - 1; j >= 5; j--) {
      const v = parseFloat(vals[j]);
      if (v && v > 10000) { lastVal = Math.round(v); break; }
    }
    if (lastVal) zhvi[regionName.toLowerCase()] = { name: regionName, value: lastVal };
  }

  console.log(`Loaded ${Object.keys(zhvi).length} metros from ZHVI CSV`);

  const { rows: markets } = await pool.query('SELECT key, city, state FROM markets');
  let updated = 0;
  for (const m of markets) {
    let found = null;
    for (const [key, data] of Object.entries(zhvi)) {
      if (key.startsWith(m.city.toLowerCase() + ', ') || key.startsWith(m.city.toLowerCase() + '-')) {
        if (key.includes(m.state.toLowerCase()) || data.name.includes(m.state)) {
          found = data; break;
        }
      }
    }
    if (found) {
      await execute('UPDATE markets SET median_home_value = $1, updated_at = NOW() WHERE key = $2', [found.value, m.key]);
      console.log(`${m.city}, ${m.state} -> $${found.value.toLocaleString()}`);
      updated++;
    } else {
      console.log(`${m.city}, ${m.state} -> NO MATCH`);
    }
  }
  console.log(`\nUpdated ${updated} / ${markets.length} markets`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
