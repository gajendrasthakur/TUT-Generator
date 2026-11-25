'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { analyseRevisions, parseDateRaw } = require('../src/lib/revision');
const { extractIdentifiers } = require('../src/lib/identifiers');
const { generateTut } = require('../src/lib/generator');
const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { analyseChange } = require('../src/lib/analyze');

const rows = (list) => list.map((r, i) => ({ position: i + 1, numberRaw: r[0], dateRaw: r[1], project: '', summary: r[2] || '', revisedBy: '' }));
const NOW = new Date('2026-11-20T00:00:00Z');

test('latest revision is chosen by number even when it is not the last row', () => {
  const r = analyseRevisions(rows([['1', '01/01/2025'], ['3', '10/03/2025'], ['2', '05/02/2025']]), NOW);
  assert.strictEqual(r.latest.numberRaw, '3');
  assert.ok(r.issues.some((i) => /not the last row/.test(i.text)));
});

test('conflicting number and date order is reported, not guessed', () => {
  const r = analyseRevisions(rows([['5', '01/01/2025'], ['4', '10/03/2026']]), NOW);
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(r.latest, null);
  assert.strictEqual(r.candidates.length >= 2, true);
});

test('typo year is flagged and the entry is chosen by number only', () => {
  const r = analyseRevisions(rows([['5', '01/01/2025'], ['6', '19/07/3025']]), NOW);
  assert.strictEqual(r.latest.numberRaw, '6');
  assert.ok(r.issues.some((i) => /implausible/.test(i.text)));
  assert.strictEqual(r.status, 'warning');
});

test('ambiguous dd/mm vs mm/dd is resolved from neighbouring rows', () => {
  const r = analyseRevisions(rows([['1', '25/01/2025'], ['2', '03/02/2025'], ['3', '28/02/2025']]), NOW);
  assert.strictEqual(r.entries[1].date, '2025-02-03');
});

test('parseDateRaw handles textual and numeric formats', () => {
  assert.ok(parseDateRaw('15 Jun 2026').candidates.length >= 1);
  assert.strictEqual(parseDateRaw('not a date').candidates.length, 0);
});

test('missing revision history returns status missing', () => {
  assert.strictEqual(analyseRevisions([], NOW).status, 'missing');
});

test('identifier extraction recognises XREF, ADO, CRF, RITM and JIRA', () => {
  const ids = extractIdentifiers('N_11561 / ADO- 16729680, CRF28203 RITM10296736 and PBNA-1234');
  assert.deepStrictEqual(ids.xref, ['N_11561']);
  assert.deepStrictEqual(ids.ado, ['16729680']);
  assert.deepStrictEqual(ids.crf, ['CRF28203']);
  assert.deepStrictEqual(ids.ritm, ['RITM10296736']);
  assert.deepStrictEqual(ids.jira, ['PBNA-1234']);
});

test('I001940 routing: conflict between condition and narrative is surfaced', async () => {
  const dir = path.resolve(__dirname, '..', '..', 'I001940');
  if (!fs.existsSync(dir)) return;
  const f = fs.readdirSync(dir).find((x) => /^TSD.*\.docx$/i.test(x));
  const doc = await readDocx(fs.readFileSync(path.join(dir, f)));
  const rev = parseRevisionHistory(doc.blocks);
  const a = analyseChange(doc, rev, rev.latest);
  assert.strictEqual(a.routing.conflicts.length, 1);
  const rc = a.routing.receivers[0];
  assert.match(rc.before.text, /AND/);
  assert.match(rc.after.text, /OR/);
  assert.ok(rc.after.eval.every((e) => e.routed === true));
});

test('I007071 without markers: no invented cases; tester description produces a labelled case', async () => {
  const dir = path.resolve(__dirname, '..', '..', 'I007071');
  if (!fs.existsSync(dir)) return;
  const f = fs.readdirSync(dir).find((x) => /^TSD.*\.docx$/i.test(x));
  const doc = await readDocx(fs.readFileSync(path.join(dir, f)));
  const rev = parseRevisionHistory(doc.blocks);
  const a = analyseChange(doc, rev, rev.latest);
  const none = generateTut(a, { tutType: 'positive' });
  assert.strictEqual(none.testCases.length, 0);
  assert.ok(none.validation.some((v) => v.status === 'fail'));
  const some = generateTut(a, { tutType: 'positive', changeDetail: 'Order rule field is now optional', expectedBehavior: 'IDoc is created' });
  assert.strictEqual(some.testCases.length, 1);
  assert.strictEqual(some.testCases[0].expected[0].basis, 'Tester input (not in TSD)');
  assert.ok(!some.flags.some((x) => x.section === 'Test scenario'));
});
