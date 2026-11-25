'use strict';
// Developer utility: shows what the scope extractor finds for the latest revision of one TSD folder.
const fs = require('fs');
const path = require('path');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { matchTokens } = require('../src/lib/identifiers');
const { scopeChange, extractInterface } = require('../src/lib/scope');

const root = path.resolve(__dirname, '..', '..');
const dir = process.argv[2] || 'I001940';

(async () => {
  const f = fs.readdirSync(path.join(root, dir)).find((x) => /^TSD.*\.docx$/i.test(x));
  const doc = await readDocx(fs.readFileSync(path.join(root, dir, f)));
  const rev = parseRevisionHistory(doc.blocks);
  const latest = rev.latest || rev.candidates[0];
  const tokens = matchTokens(latest.ids);
  console.log('Latest:', latest.numberRaw, latest.dateRaw, '|', latest.summary.replace(/\s+/g, ' '));
  console.log('Tokens:', tokens);
  const sc = scopeChange(doc.blocks, doc.embeds, tokens);
  console.log('Regions:', sc.regions.length, ' mentions:', sc.mentions.length);
  for (const r of sc.regions) {
    console.log(`\n--- region "${r.tag}" start=${r.startLabel} closed=${r.closed} lines=${r.lines.length} tables=${r.tables.length} embeds=${r.embeds.length}`);
    r.lines.slice(0, 12).forEach((l) => console.log(`   [${l.label}] ${l.text.slice(0, 170)}`));
    r.tables.forEach((t) => console.log(`   TABLE in ${t.label} rows=${t.rows.length} whole=${t.whole}: ${JSON.stringify(t.rows.slice(0, 2).map((x) => x.cells.map((c) => String(c).slice(0, 60))))}`));
  }
  const ifc = extractInterface(doc.blocks, sc.sectionBlocks);
  console.log('\nINTERFACE:', JSON.stringify({ ...ifc, icos: ifc.icos.map((i) => ({ ...i, rules: i.rules })) }, null, 1).slice(0, 3800));
})().catch((e) => console.error(e));
