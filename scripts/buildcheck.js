'use strict';
// Developer utility: node scripts/buildcheck.js I001940 positive  -> writes out/<file>.docx
const fs = require('fs');
const path = require('path');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { analyseChange } = require('../src/lib/analyze');
const { generateTut } = require('../src/lib/generator');
const { buildDocx } = require('../src/lib/docxWriter');

const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(out, { recursive: true });
const only = process.argv[2];
const types = process.argv[3] ? [process.argv[3]] : ['positive', 'negative'];

(async () => {
  const dirs = fs.readdirSync(root).filter((d) => /^I\d{6}$/.test(d) && (!only || d === only));
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(root, d)).find((x) => /^TSD.*\.docx$/i.test(x));
    if (!f) continue;
    const doc = await readDocx(fs.readFileSync(path.join(root, d, f)));
    const rev = parseRevisionHistory(doc.blocks);
    const a = analyseChange(doc, rev, rev.latest || rev.candidates[0]);
    for (const t of types) {
      const tut = generateTut(a, { tutType: t, environment: 'QAS' });
      const { buffer, fileName } = await buildDocx(tut);
      fs.writeFileSync(path.join(out, `${d}_${fileName}`), buffer);
      console.log(`${d} ${t} -> ${fileName} ${buffer.length} bytes, cases=${tut.testCases.length}`);
    }
  }
  console.log('out dir:', out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
