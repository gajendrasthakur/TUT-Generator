'use strict';
// Developer utility: runs the revision parser over every TSD under the parent folder.
const fs = require('fs');
const path = require('path');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');

const root = path.resolve(__dirname, '..', '..');

(async () => {
  const dirs = fs.readdirSync(root).filter((d) => /^I\d{6}$/.test(d));
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(root, d)).find((x) => /^TSD.*\.docx$/i.test(x));
    if (!f) continue;
    const doc = await readDocx(fs.readFileSync(path.join(root, d, f)));
    const rev = parseRevisionHistory(doc.blocks);
    const l = rev.latest;
    console.log(`\n=== ${d}  status=${rev.status}  entries=${rev.entries.length}`);
    if (l) {
      console.log(`  latest: #${l.numberRaw} ${l.dateRaw} (${l.date}) pos ${l.position}`);
      console.log(`  summary: ${l.summary.replace(/\s+/g, ' ').slice(0, 130)}`);
      console.log(`  ids: ${JSON.stringify(Object.fromEntries(Object.entries(l.ids).filter(([, v]) => v.length)))}`);
    } else {
      console.log('  candidates:', rev.candidates.map((c) => `#${c.numberRaw} ${c.dateRaw}`).join('  vs  '));
    }
    rev.issues.forEach((i) => console.log(`  [${i.level}] ${i.text}`));
  }
})();
