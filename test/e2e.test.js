'use strict';
process.env.PORT = process.env.PORT || '3917';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { app, HOST, PORT } = require('../src/server');

const base = `http://${HOST}:${PORT}`;
const root = path.resolve(__dirname, '..', '..');
let server;

function tsdPath(id) {
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => /^TSD.*\.docx$/i.test(x));
  return f ? path.join(dir, f) : null;
}

async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null), res: r };
}

async function upload(file, name) {
  const fd = new FormData();
  fd.append('tsd', new Blob([fs.readFileSync(file)]), name || path.basename(file));
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  return { status: r.status, json: await r.json() };
}

test.before(async () => {
  server = app.listen(PORT, HOST);
  await new Promise((r) => server.once('listening', r));
});
test.after(() => server.close());

test('server rejects requests with a foreign Host header', async () => {
  const http = require('http');
  const status = await new Promise((resolve, reject) => {
    const rq = http.request({ host: HOST, port: PORT, path: '/', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
    rq.on('error', reject);
    rq.end();
  });
  assert.strictEqual(status, 403);
});

test('sets security headers', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('rejects a file whose content does not match its extension', async () => {
  const fd = new FormData();
  fd.append('tsd', new Blob([Buffer.from('not a zip at all')]), 'fake.docx');
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.strictEqual(r.status, 400);
});

test('download is blocked until the preview is approved', async () => {
  const p = tsdPath('I001940');
  if (!p) return;
  const up = await upload(p);
  assert.strictEqual(up.status, 200);
  const sid = up.json.sessionId;
  assert.strictEqual((await post('/api/download', { sessionId: sid })).status, 409);
  assert.strictEqual((await post('/api/generate', { sessionId: sid, inputs: { tutType: 'positive' } })).status, 409);
});

test('full flow on I001940: latest revision, summary, positive TUT, docx download', async () => {
  const p = tsdPath('I001940');
  if (!p) return;
  const up = await upload(p);
  assert.strictEqual(up.json.needsClarification, false);
  const s = up.json.summary;
  assert.strictEqual(s.revision.number, '6');
  assert.ok(s.revision.adoJira.includes('ADO 26519505'));
  assert.ok(s.revision.description.includes('Routing logic update for AVAIL Receiver'));
  assert.ok(s.understanding.some((u) => /^CONFLICT/.test(u)), 'documented condition conflicts with the narrative');
  const sid = up.json.sessionId;

  assert.strictEqual((await post('/api/confirm-summary', { sessionId: sid, confirmed: false })).status, 400);
  assert.strictEqual((await post('/api/confirm-summary', { sessionId: sid, confirmed: true, corrections: {} })).status, 200);

  const g = await post('/api/generate', { sessionId: sid, inputs: { tutType: 'positive', environment: 'QAS' } });
  assert.strictEqual(g.status, 200);
  assert.ok(g.json.preview.testCases.length >= 1);
  assert.ok(g.json.preview.flags.some((f) => f.severity === 'error' && /conflict/i.test(f.text)));
  for (const c of g.json.preview.testCases) {
    assert.ok(c.steps.length >= 3);
    assert.strictEqual(c.actual, '');
    assert.strictEqual(c.status, '');
  }
  const checks = g.json.preview.validation;
  assert.strictEqual(checks.length, 10);
  assert.deepStrictEqual(checks.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(checks.every((c) => Array.isArray(c.evidence) && c.evidence.length));
  assert.strictEqual(checks[8].status, 'pass', 'format check is measured on the real .docx');
  assert.strictEqual(checks[2].status, 'warn', 'routing conflict makes consistency a review item');
  assert.strictEqual(g.json.preview.verdict.total, 10);

  assert.strictEqual((await post('/api/download', { sessionId: sid })).status, 409);
  assert.strictEqual((await post('/api/approve', { sessionId: sid, approved: true })).json.ok, true);

  const d = await fetch(base + '/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
  assert.strictEqual(d.status, 200);
  assert.match(d.headers.get('content-disposition'), /TUT_I001940_Positive_Rev6\.docx/);
  const zip = await JSZip.loadAsync(Buffer.from(await d.arrayBuffer()));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('Technical Unit Testing'));
  assert.ok(xml.includes('ADO 26519505'));
  assert.ok(zip.file('word/footer1.xml'), 'footer present');
  const footer = await zip.file('word/footer1.xml').async('string');
  assert.ok(/PAGE/.test(footer), 'page number field present');
});

test('negative TUT does not assume a failed message for non-routing', async () => {
  const p = tsdPath('I001940');
  if (!p) return;
  const up = await upload(p);
  const sid = up.json.sessionId;
  await post('/api/confirm-summary', { sessionId: sid, confirmed: true, corrections: {} });
  const g = await post('/api/generate', { sessionId: sid, inputs: { tutType: 'negative' } });
  const text = JSON.stringify(g.json.preview.testCases);
  assert.match(text, /routing outcome, not an error/);
});

test('generic error responses do not leak internals', async () => {
  const r = await post('/api/select-revision', { sessionId: 'nope', position: 1 });
  assert.strictEqual(r.status, 404);
  assert.ok(!/at\s+\S+\s+\(/.test(JSON.stringify(r.json)));
});

function buildPdf(lines) {
  let y = 780;
  let c = 'BT /F1 11 Tf\n';
  lines.forEach((l) => { c += `1 0 0 1 50 ${y} Tm (${l}) Tj\n`; y -= 18; });
  c += 'ET';
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', `<</Length ${c.length}>>\nstream\n${c}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer<</Size 6/Root 1 0 R>>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('PDF TSD: latest revision is found and the change is flagged for review', async () => {
  const pdf = buildPdf(['Revision History', 'Revision Number Revision Date Project Summary of Changes', '1 01/02/2025 PBNA Initial version', '2 15/06/2026 PBNA ADO 26519505: Routing logic update for AVAIL Receiver']);
  const fd = new FormData();
  fd.append('tsd', new Blob([pdf]), 'tsd.pdf');
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.summary.revision.number, '2');
  assert.ok(j.summary.revision.adoJira.includes('ADO 26519505'));
  assert.strictEqual(j.summary.scopeFound, false);
});
