'use strict';
// Developer utility: node scripts/gencheck.js I001940 [positive|negative]
const fs = require('fs');
const path = require('path');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { analyseChange } = require('../src/lib/analyze');
const { generateTut } = require('../src/lib/generator');

const root = path.resolve(__dirname, '..', '..');
const only = process.argv[2];
const types = process.argv[3] ? [process.argv[3]] : ['positive', 'negative'];

(async () => {
  const dirs = fs.readdirSync(root).filter((d) => /^I\d{6}$/.test(d) && (!only || d === only));
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(root, d)).find((x) => /^TSD.*\.docx$/i.test(x));
    if (!f) continue;
    const doc = await readDocx(fs.readFileSync(path.join(root, d, f)));
    const rev = parseRevisionHistory(doc.blocks);
    const entry = rev.latest || rev.candidates[0];
    const a = analyseChange(doc, rev, entry);
    for (const t of types) {
      const r = generateTut(a, { tutType: t });
      console.log(`\n=== ${d} ${t} | types=${r.meta.changeTypes.join('; ')} | cases=${r.testCases.length} flags=${r.flags.length}`);
      if (only) {
        for (const c of r.testCases) {
          console.log(` [${c.id}] ${c.scenario}\n   obj: ${c.objective}\n   steps=${c.steps.length}`);
          c.expected.forEach((e) => console.log(`   exp(${e.basis}): ${e.text.slice(0, 200)}`));
        }
        r.flags.forEach((fl) => console.log(` FLAG[${fl.severity}] ${fl.text.slice(0, 260)}`));
        r.validation.forEach((v) => console.log(` CHECK ${v.status} ${v.name} -- ${v.detail.slice(0, 140)}`));
      } else {
        r.testCases.slice(0, 3).forEach((c) => console.log(`  - ${c.scenario.slice(0, 120)}`));
        r.flags.forEach((fl) => console.log(`  FLAG[${fl.severity}] ${fl.text.slice(0, 140)}`));
      }
    }
  }
})().catch((e) => console.error(e));
