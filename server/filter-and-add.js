#!/usr/bin/env node
/**
 * filter-and-add.js — Conservative P3/DB filtering then batch add.
 * Usage: node server/filter-and-add.js data/discovered-batch5.json
 */
var fs = require('fs');
var path = require('path');
var nanoid = require('nanoid').nanoid;
var db = require('./db');
var normalizeName = db.normalizeName;
var insertCompany = db.insertCompany;
var listCompanies = db.listCompanies;
var initSchema = db.initSchema;

function fuzzyMatch(nameA, nameB) {
  var keyA = normalizeName(nameA);
  var keyB = normalizeName(nameB);
  if (!keyA || !keyB) return null;

  // 1. Exact normalized match
  if (keyA === keyB) return 'exact';

  // 2. Substring: shorter must be >= 60% of longer AND >= 12 chars
  var shorter = keyA.length <= keyB.length ? keyA : keyB;
  var longer = keyA.length <= keyB.length ? keyB : keyA;
  if (shorter.length >= 12 && longer.indexOf(shorter) !== -1 && shorter.length >= longer.length * 0.6) {
    return 'substring';
  }

  // 3. First 2 non-generic words match (skip "the", "all", "a")
  var skip = { the: 1, all: 1, a: 1, an: 1 };
  var wA = keyA.split(/\s+/).filter(function(w) { return !skip[w]; });
  var wB = keyB.split(/\s+/).filter(function(w) { return !skip[w]; });
  var p2A = wA.slice(0, 2).join(' ');
  var p2B = wB.slice(0, 2).join(' ');
  if (p2A.length >= 12 && p2B.length >= 12 && p2A === p2B) return 'prefix2';

  return null;
}

async function main() {
  var inputFile = process.argv[2];
  if (!inputFile) { console.error('Usage: node server/filter-and-add.js <json-file>'); process.exit(1); }

  await initSchema();

  var candidates = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  var p3Names = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'p3-universe-names.json'), 'utf8'));
  var dbCompanies = await listCompanies({ sort: 'score_desc' });

  var p3Excluded = [];
  var dbExcluded = [];
  var added = [];

  for (var idx = 0; idx < candidates.length; idx++) {
    var c = candidates[idx];
    if (!c.name) continue;

    var p3Match = null;
    for (var pi = 0; pi < p3Names.length; pi++) {
      var m = fuzzyMatch(c.name, p3Names[pi]);
      if (m) { p3Match = { p3Name: p3Names[pi], matchType: m }; break; }
    }
    if (p3Match) { p3Excluded.push({ name: c.name, p3Name: p3Match.p3Name, matchType: p3Match.matchType }); continue; }

    var dbMatch = null;
    for (var di = 0; di < dbCompanies.length; di++) {
      var m2 = fuzzyMatch(c.name, dbCompanies[di].name);
      if (m2) { dbMatch = { dbName: dbCompanies[di].name, matchType: m2 }; break; }
    }
    if (dbMatch) { dbExcluded.push({ name: c.name, dbName: dbMatch.dbName, matchType: dbMatch.matchType }); continue; }

    var id = nanoid();
    var name_key = normalizeName(c.name);
    if (!name_key) continue;
    try {
      await insertCompany({ id: id, name: c.name, name_key: name_key, city: c.city || null, state: c.state || null, phone: c.phone || null, website: c.website || null, owner: c.owner || null, email: c.email || null, address: c.address || null, crm_known: false });
      added.push({ id: id, name: c.name, city: c.city, state: c.state });
    } catch (err) {
      dbExcluded.push({ name: c.name, note: 'insert conflict' });
    }
  }

  console.log(JSON.stringify({ total_candidates: candidates.length, p3_excluded: p3Excluded.length, db_excluded: dbExcluded.length, added: added.length, p3_excluded_details: p3Excluded, db_excluded_details: dbExcluded }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
