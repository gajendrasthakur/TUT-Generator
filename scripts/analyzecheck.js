'use strict';
// Developer utility: full change analysis for every TSD (or one: node scripts/analyzecheck.js I001940).
const fs = require('fs');
const path = require('path');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { analyseChange } = require('../src/lib/analyze');

const root = path.resolve(__dirname, '..', '..');
const only = process.argv[2];
const verbose = process.argv.includes('-v');

(async () => {
  const dirs = fs.readdirSync(root).filter((d) => /^I\d{6}$/.test(d) && (!only || only.startsWith('-') || d === only));
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(root, d)).find((x) => /^TSD.*\.docx$/i.test(x));
    if (!f) continue;
    const doc = await readDocx(fs.readFileSync(path.join(root, d, f)));
    const rev = parseRevisionHistory(doc.blocks);
    const entry = rev.latest || rev.candidates[0];
    const a = analyseChange(doc, rev, entry);
    console.log(`\n=== ${d} ${a.interface.id} | ${a.interface.name}`);
    console.log(`  latest #${a.entry.number} ${a.entry.date}: ${a.entry.description.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(`  types: ${a.types.map((t) => t.type).join(', ')} | scopeFound=${a.scopeFound} regions=${a.regions.length} sections=${a.sectionsTouched.join(' ; ')}`);
    console.log(`  src=${a.interface.sourceSystem} -> tgt=${a.interface.targetSystems.join(',')} | adapters ${a.interface.adapters.sender}->${a.interface.adapters.receiver}`);
    console.log(`  fields src=${a.fields.source.length} tgt=${a.fields.target.length} unassigned=${a.fields.unassigned.length} named=${a.fields.named.slice(0, 6).map((x) => x.name).join(',')}`);
    if (a.routing) {
      for (const rc of a.routing.receivers) {
        console.log(`  ROUTING ${rc.receiver} (${rc.component}) fields=${a.routing.fields.join(',')}`);
        if (rc.before) console.log(`    before: ${rc.before.text}`);
        console.log(`    after : ${rc.after.text}`);
        if (a.routing.fields.length === 1) console.log(`    eval  : ${rc.after.eval.map((e) => `${Object.values(e.payload)[0]}=${e.routed}`).join(' ')}`);
      }
      console.log(`    intent=${a.routing.intent.length} conflicts=${a.routing.conflicts.length}`);
      a.routing.conflicts.forEach((c) => console.log(`    CONFLICT value=${c.value} receiver=${c.receiver} literal=${c.literal} stated=${c.stated}`));
    }
    if (verbose) {
      a.regions.forEach((r) => console.log(`   - ${r.tag} @${r.section} [${r.closed}] lines=${r.lines.length} tables=${r.tableCount}`));
      a.statements.slice(0, 5).forEach((s) => console.log(`   * ${s.text.slice(0, 160)}`));
    }
  }
})().catch((e) => console.error(e));
