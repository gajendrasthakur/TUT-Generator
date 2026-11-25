'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readDocx } = require('../src/lib/docxReader');
const { parseRevisionHistory } = require('../src/lib/revision');
const { analyseChange } = require('../src/lib/analyze');
const { generateTut } = require('../src/lib/generator');
const { runChecks, checkFormat, summarize } = require('../src/lib/validate');
const { inspectDocx } = require('../src/lib/docCheck');
const { buildDocx } = require('../src/lib/docxWriter');

const root = path.resolve(__dirname, '..', '..');
async function load(id) {
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => /^TSD.*\.docx$/i.test(x));
  const doc = await readDocx(fs.readFileSync(path.join(dir, f)));
  const rev = parseRevisionHistory(doc.blocks);
  return analyseChange(doc, rev, rev.latest);
}

test('all 10 checks are produced, in order, each with evidence', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive' });
  assert.deepStrictEqual(t.validation.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const c of t.validation) {
    assert.ok(['pass', 'warn', 'fail'].includes(c.status));
    assert.ok(c.evidence.length > 0, `check ${c.id} has evidence`);
  }
});

test('check 2 fails when a test case mentions the identifier of another revision', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive' });
  t.testCases[0].scenario += ' (see N_11561)';
  const checks = runChecks({ a: t.analysis, cases: t.testCases, flags: t.flags, tutType: 'positive', inputs: t.inputs });
  assert.strictEqual(checks[1].status, 'fail');
  assert.match(checks[1].evidence.join(' '), /N_11561/);
});

test('check 7 fails if a placeholder is labelled as coming from the TSD', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive' });
  t.testCases[0].testData.push({ field: 'X', value: '<something>', source: 'Stated in TSD' });
  const checks = runChecks({ a: t.analysis, cases: t.testCases, flags: t.flags, tutType: 'positive', inputs: t.inputs });
  assert.strictEqual(checks[6].status, 'fail');
});

test('check 8 fails when a case lacks the delivery/status step or has a filled-in actual result', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive' });
  t.testCases[0].actual = 'Passed';
  const checks = runChecks({ a: t.analysis, cases: t.testCases, flags: t.flags, tutType: 'positive', inputs: t.inputs });
  assert.strictEqual(checks[7].status, 'fail');
  assert.match(checks[7].evidence.join(' '), /actual result and status left blank/);
});

test('check 6 reports each expected result by basis and flags those needing confirmation', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'negative' });
  assert.strictEqual(t.validation[5].status, 'warn');
  assert.match(t.validation[5].evidence[0], /need confirmation/);
});

test('check 9 is measured on the real .docx and fails for a document without footer/header', async () => {
  const a = await load('I001940');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive' });
  const { buffer } = await buildDocx(t);
  const stats = await inspectDocx(buffer);
  assert.strictEqual(stats.rowsCantSplit, stats.rows);
  assert.strictEqual(checkFormat(stats).status, 'pass');
  assert.strictEqual(checkFormat(Object.assign({}, stats, { hasFooter: false })).status, 'fail');
  assert.strictEqual(checkFormat(Object.assign({}, stats, { emptyBeforeBreak: 2 })).status, 'fail');
  assert.strictEqual(checkFormat(null).status, 'warn');
});

test('verdict: ready only without failed checks', () => {
  const mk = (s) => ({ status: s });
  assert.strictEqual(summarize([mk('pass'), mk('warn')]).ready, true);
  assert.strictEqual(summarize([mk('pass'), mk('fail')]).ready, false);
  assert.strictEqual(summarize([mk('pass')]).verdict, 'Ready');
});

test('TSD without markers: check 2 and 3 warn instead of passing silently', async () => {
  const a = await load('I007071');
  if (!a) return;
  const t = generateTut(a, { tutType: 'positive', changeDetail: 'Order rule field is now optional', expectedBehavior: 'IDoc is created' });
  assert.strictEqual(t.validation[2].status, 'warn');
  assert.notStrictEqual(t.validation[1].status, 'pass');
});
