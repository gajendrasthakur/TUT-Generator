// 'use strict';

// const path = require('path');
// const crypto = require('crypto');
// const express = require('express');
// const multer = require('multer');

// const { readDocx } = require('./lib/docxReader');
// const { readPdf } = require('./lib/pdfReader');
// const { parseRevisionHistory, parseRevisionHistoryFromLines, analyseRevisions } = require('./lib/revision');
// const { analyseChange, buildRevisionView, extractIdentifiers } = require('./lib/analyze');
// const { generateTut } = require('./lib/generator');
// const { buildDocx } = require('./lib/docxWriter');
// const { buildChangeSummary } = require('./lib/summary');
// const { inspectDocx } = require('./lib/docCheck');
// const { checkFormat, summarize } = require('./lib/validate');
// const { truncate } = require('./lib/text');

// /* ------------------------------------------------------------------ config */

// const HOST = '127.0.0.1'; // never bind to all interfaces
// const PORT = Number(process.env.PORT) || 3000;
// const MAX_UPLOAD = 80 * 1024 * 1024;
// const SESSION_TTL_MS = 60 * 60 * 1000;
// const MAX_SESSIONS = 10;
// const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// /* ----------------------------------------------------------------- logging */

// /** Structured log line. Never pass document content, payloads or tokens here. */
// function log(level, msg, extra) {
//   const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, extra || {}));
//   (level === 'error' ? console.error : console.log)(line);
// }

// /* ---------------------------------------------------------------- sessions */

// const sessions = new Map();

// function sweep() {
//   const now = Date.now();
//   for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
// }
// setInterval(sweep, 5 * 60 * 1000).unref();

// function createSession(data) {
//   sweep();
//   if (sessions.size >= MAX_SESSIONS) {
//     const oldest = Array.from(sessions.entries()).sort((a, b) => a[1].touched - b[1].touched)[0];
//     if (oldest) sessions.delete(oldest[0]);
//   }
//   const id = crypto.randomBytes(24).toString('base64url');
//   const s = Object.assign({ id, touched: Date.now(), stage: 'uploaded' }, data);
//   sessions.set(id, s);
//   return s;
// }

// function getSession(id) {
//   if (typeof id !== 'string' || id.length > 80) return null;
//   const s = sessions.get(id);
//   if (!s) return null;
//   s.touched = Date.now();
//   return s;
// }

// /* ---------------------------------------------------------------- helpers */

// class HttpError extends Error {
//   constructor(status, message) {
//     super(message);
//     this.status = status;
//   }
// }

// function needSession(req) {
//   const s = getSession(req.body && req.body.sessionId);
//   if (!s) throw new HttpError(404, 'Session not found or expired. Please upload the TSD again.');
//   return s;
// }

// function str(v, max) {
//   return typeof v === 'string' ? truncate(v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''), max) : '';
// }

// function detectKind(buf, name) {
//   const ext = path.extname(name || '').toLowerCase();
//   const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
//   const isPdf = buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
//   if (ext === '.docx' && isZip) return 'docx';
//   if (ext === '.pdf' && isPdf) return 'pdf';
//   return null;
// }

// function stageEntry(s, entry) {
//   s.entry = entry;
//   s.analysis = analyseChange(s.doc, s.rev, entry);
//   s.summary = buildChangeSummary(s.analysis);
//   s.stage = 'summary';
//   s.confirmed = false;
//   s.corrections = null;
//   s.tut = null;
//   s.approved = false;
// }

// function revisionResponse(s) {
//   return {
//     sessionId: s.id,
//     fileName: s.fileName,
//     format: s.doc.format,
//     revision: buildRevisionView(s.rev),
//     needsClarification: s.stage === 'uploaded',
//     summary: s.stage === 'summary' ? s.summary : null
//   };
// }

// /* --------------------------------------------------------------------- app */

// const app = express();
// app.disable('x-powered-by');

// // DNS-rebinding / cross-site protection: only accept requests addressed to this local server.
// app.use((req, res, next) => {
//   if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return res.status(403).json({ error: 'Forbidden' });
//   const origin = req.headers.origin;
//   if (origin && req.method !== 'GET' && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return res.status(403).json({ error: 'Forbidden' });
//   next();
// });

// app.use((req, res, next) => {
//   res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
//   res.setHeader('X-Content-Type-Options', 'nosniff');
//   res.setHeader('X-Frame-Options', 'DENY');
//   res.setHeader('Referrer-Policy', 'no-referrer');
//   res.setHeader('Cache-Control', 'no-store');
//   next();
// });

// app.use(express.json({ limit: '256kb' }));
// app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: MAX_UPLOAD, files: 1, fields: 4, parts: 6 }
// });

// const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// /* 1. Upload + analyse -------------------------------------------------------- */
// app.post(
//   '/api/upload',
//   upload.single('tsd'),
//   wrap(async (req, res) => {
//     if (!req.file) throw new HttpError(400, 'Please choose a TSD file (.docx or .pdf).');
//     const kind = detectKind(req.file.buffer, req.file.originalname);
//     if (!kind) throw new HttpError(400, 'Only .docx and .pdf files are supported, and the file content must match its extension.');

//     const t0 = Date.now();
//     let doc;
//     try {
//       doc = kind === 'docx' ? await readDocx(req.file.buffer) : await readPdf(req.file.buffer);
//     } catch (e) {
//       log('error', 'document read failed', { kind, bytes: req.file.size, err: e && e.message });
//       throw new HttpError(422, 'The document could not be read. It may be corrupt, password protected or not a valid TSD.');
//     }
//     const rev = kind === 'docx' ? parseRevisionHistory(doc.blocks) : parseRevisionHistoryFromLines(doc.blocks.map((b) => b.text));
//     const s = createSession({ doc, rev, fileName: str(req.file.originalname.replace(/[\\/]/g, '_'), 120), kind });

//     if (rev.status === 'ok' || rev.status === 'warning') stageEntry(s, rev.latest);
//     log('info', 'document analysed', { kind, bytes: req.file.size, ms: Date.now() - t0, revisionStatus: rev.status, entries: rev.entries.length });
//     res.json(revisionResponse(s));
//   })
// );

// /* 1b. User resolves an unclear Revision History ----------------------------- */
// app.post(
//   '/api/select-revision',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     const pos = Number(req.body.position);
//     const entry = s.rev.entries.find((e) => e.position === pos);
//     if (!entry) throw new HttpError(400, 'Please choose one of the listed revision entries.');
//     stageEntry(s, entry);
//     res.json(revisionResponse(s));
//   })
// );

// app.post(
//   '/api/manual-revision',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     const number = str(req.body.number, 20);
//     const date = str(req.body.date, 30);
//     const description = str(req.body.description, 4000);
//     if (!description) throw new HttpError(400, 'Please enter the change description exactly as it should be tested.');
//     const parsed = analyseRevisions([{ position: 1, numberRaw: number, dateRaw: date, project: '', summary: description, revisedBy: '' }]);
//     const entry = parsed.entries[0];
//     entry.ids = extractIdentifiers(description + ' ' + str(req.body.identifiers, 400));
//     stageEntry(s, entry);
//     res.json(revisionResponse(s));
//   })
// );

// /* 2. User confirms or corrects the change summary --------------------------- */
// app.post(
//   '/api/confirm-summary',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     if (s.stage === 'uploaded' || !s.analysis) throw new HttpError(409, 'The latest revision has not been established yet.');
//     const c = req.body.corrections || {};
//     const fieldNames = Array.isArray(c.fieldNames) ? c.fieldNames.map((x) => str(x, 120)).filter((x) => /^[\w./\[\]:@=\- ]{2,120}$/.test(x)).slice(0, 10) : [];
//     if (req.body.confirmed !== true) throw new HttpError(400, 'Please confirm the change summary to continue.');
//     s.corrections = {
//       sourceSystem: str(c.sourceSystem, 200),
//       targetSystem: str(c.targetSystem, 200),
//       fieldNames,
//       changeDetail: str(c.changeDetail, 2000),
//       note: str(c.note, 2000)
//     };
//     s.confirmed = true;
//     s.stage = 'confirmed';
//     s.tut = null;
//     s.approved = false;
//     res.json({ ok: true });
//   })
// );

// /* 3. Generate the preview ---------------------------------------------------- */
// function previewOf(tut) {
//   return {
//     meta: tut.meta,
//     inputs: { tutType: tut.inputs.tutType, environment: tut.inputs.environment, scenario: tut.inputs.scenario },
//     interface: { id: tut.analysis.interface.id, name: tut.analysis.interface.name },
//     entry: tut.analysis.entry,
//     testCases: tut.testCases,
//     flags: tut.flags,
//     unconfirmed: tut.unconfirmed,
//     validation: tut.validation,
//     verdict: summarize(tut.validation)
//   };
// }

// /** Builds the Word file, inspects its real structure and replaces check 9 with the measured result. */
// async function buildAndCheck(s) {
//   const first = await buildDocx(s.tut);
//   const stats = await inspectDocx(first.buffer);
//   s.tut.validation = s.tut.validation.map((v) => (v.id === 9 ? checkFormat(stats) : v));
//   // Rebuild so the appendix in the file shows the measured result of check 9 (layout is unchanged by this).
//   s.docx = await buildDocx(s.tut);
// }

// app.post(
//   '/api/generate',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     if (!s.confirmed) throw new HttpError(409, 'Please confirm the Change Summary first.');
//     const i = req.body.inputs || {};
//     const inputs = {
//       tutType: i.tutType === 'negative' ? 'negative' : i.tutType === 'positive' ? 'positive' : '',
//       scenario: str(i.scenario, 2000),
//       sourceSystem: (s.corrections && s.corrections.sourceSystem) || str(i.sourceSystem, 200),
//       targetSystem: (s.corrections && s.corrections.targetSystem) || str(i.targetSystem, 200),
//       samplePayload: str(i.samplePayload, 20000),
//       expectedBehavior: str(i.expectedBehavior, 2000),
//       environment: ['DEV', 'QAS', 'UAT', 'PRD', 'OTHER'].includes(i.environment) ? i.environment : '',
//       assumptions: str(i.assumptions, 2000),
//       fieldNames: (s.corrections && s.corrections.fieldNames) || [],
//       changeDetail: (s.corrections && s.corrections.changeDetail) || ''
//     };
//     if (!inputs.tutType) throw new HttpError(400, 'Please choose Positive or Negative TUT.');
//     s.tut = generateTut(s.analysis, inputs);
//     s.docx = null;
//     await buildAndCheck(s);
//     s.stage = 'preview';
//     s.approved = false;
//     log('info', 'tut generated', { tutType: inputs.tutType, cases: s.tut.testCases.length, flags: s.tut.flags.length });
//     res.json({ sessionId: s.id, preview: previewOf(s.tut) });
//   })
// );

// /* 4. Approve the preview, then download ------------------------------------- */
// app.post(
//   '/api/approve',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     if (!s.tut) throw new HttpError(409, 'Generate the preview first.');
//     if (s.tut.validation.some((v) => v.status === 'fail')) throw new HttpError(409, 'The quality check has failures. Provide the missing information and regenerate.');
//     s.approved = req.body.approved === true;
//     res.json({ ok: s.approved });
//   })
// );

// app.post(
//   '/api/download',
//   wrap(async (req, res) => {
//     const s = needSession(req);
//     if (!s.tut || !s.approved) throw new HttpError(409, 'Review and approve the preview before downloading.');
//     if (!s.docx) await buildAndCheck(s);
//     const { buffer, fileName } = s.docx;
//     res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
//     res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
//     res.setHeader('Content-Length', buffer.length);
//     log('info', 'tut downloaded', { bytes: buffer.length });
//     res.end(buffer);
//   })
// );

// app.post('/api/reset', (req, res) => {
//   if (req.body && typeof req.body.sessionId === 'string') sessions.delete(req.body.sessionId);
//   res.json({ ok: true });
// });

// /* ----------------------------------------------------------------- errors */

// app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// // eslint-disable-next-line no-unused-vars
// app.use((err, req, res, next) => {
//   if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
//   if (err instanceof multer.MulterError) {
//     const msg = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${Math.round(MAX_UPLOAD / 1048576)} MB.` : 'The upload was rejected.';
//     return res.status(400).json({ error: msg });
//   }
//   if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
//   if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
//   log('error', 'unhandled error', { path: req.path, err: err && err.message });
//   res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
// });

// if (require.main === module) {
//   const server = app.listen(PORT, HOST, () => log('info', 'SAP PI/PO TUT Generator started', { url: `http://${HOST}:${PORT}` }));
//   server.requestTimeout = 5 * 60 * 1000;
//   server.headersTimeout = 60 * 1000;
//   server.keepAliveTimeout = 5 * 1000;
// }

// module.exports = { app, HOST, PORT };
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { readDocx } = require('./lib/docxReader');
const { readPdf } = require('./lib/pdfReader');
const { parseRevisionHistory, parseRevisionHistoryFromLines, analyseRevisions } = require('./lib/revision');
const { analyseChange, buildRevisionView, extractIdentifiers } = require('./lib/analyze');
const { generateTut } = require('./lib/generator');
const { buildDocx } = require('./lib/docxWriter');
const { buildChangeSummary } = require('./lib/summary');
const { inspectDocx } = require('./lib/docCheck');
const { checkFormat, summarize } = require('./lib/validate');
const { truncate } = require('./lib/text');

/* ------------------------------------------------------------------ config */

const IS_RENDER = Boolean(process.env.RENDER_EXTERNAL_HOSTNAME);
const HOST = IS_RENDER ? '0.0.0.0' : '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD = 80 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 10;

const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.RENDER_EXTERNAL_HOSTNAME
    ? [process.env.RENDER_EXTERNAL_HOSTNAME.toLowerCase()]
    : []),
  ...(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
]);

/* ----------------------------------------------------------------- logging */

/** Structured log line. Never pass document content, payloads or tokens here. */
function log(level, msg, extra) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, extra || {}));
  (level === 'error' ? console.error : console.log)(line);
}

/* ---------------------------------------------------------------- sessions */

const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
}
setInterval(sweep, 5 * 60 * 1000).unref();

function createSession(data) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = Array.from(sessions.entries()).sort((a, b) => a[1].touched - b[1].touched)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  const id = crypto.randomBytes(24).toString('base64url');
  const s = Object.assign({ id, touched: Date.now(), stage: 'uploaded' }, data);
  sessions.set(id, s);
  return s;
}

function getSession(id) {
  if (typeof id !== 'string' || id.length > 80) return null;
  const s = sessions.get(id);
  if (!s) return null;
  s.touched = Date.now();
  return s;
}

/* ---------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function needSession(req) {
  const s = getSession(req.body && req.body.sessionId);
  if (!s) throw new HttpError(404, 'Session not found or expired. Please upload the TSD again.');
  return s;
}

function str(v, max) {
  return typeof v === 'string' ? truncate(v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''), max) : '';
}

function detectKind(buf, name) {
  const ext = path.extname(name || '').toLowerCase();
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  const isPdf = buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (ext === '.docx' && isZip) return 'docx';
  if (ext === '.pdf' && isPdf) return 'pdf';
  return null;
}

function stageEntry(s, entry) {
  s.entry = entry;
  s.analysis = analyseChange(s.doc, s.rev, entry);
  s.summary = buildChangeSummary(s.analysis);
  s.stage = 'summary';
  s.confirmed = false;
  s.corrections = null;
  s.tut = null;
  s.approved = false;
}

function revisionResponse(s) {
  return {
    sessionId: s.id,
    fileName: s.fileName,
    format: s.doc.format,
    revision: buildRevisionView(s.rev),
    needsClarification: s.stage === 'uploaded',
    summary: s.stage === 'summary' ? s.summary : null
  };
}

/* --------------------------------------------------------------------- app */

const app = express();
app.disable('x-powered-by');

// Host and Origin validation helps protect against DNS rebinding and cross-site requests.
app.use((req, res, next) => {
  const requestHost = String(req.headers.host || '').toLowerCase();

  if (!ALLOWED_HOSTS.has(requestHost)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const origin = req.headers.origin;

  if (origin && req.method !== 'GET') {
    let originHost;

    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!ALLOWED_HOSTS.has(originHost)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  next();
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1, fields: 4, parts: 6 }
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* 1. Upload + analyse -------------------------------------------------------- */
app.post(
  '/api/upload',
  upload.single('tsd'),
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Please choose a TSD file (.docx or .pdf).');
    const kind = detectKind(req.file.buffer, req.file.originalname);
    if (!kind) throw new HttpError(400, 'Only .docx and .pdf files are supported, and the file content must match its extension.');

    const t0 = Date.now();
    let doc;
    try {
      doc = kind === 'docx' ? await readDocx(req.file.buffer) : await readPdf(req.file.buffer);
    } catch (e) {
      log('error', 'document read failed', { kind, bytes: req.file.size, err: e && e.message });
      throw new HttpError(422, 'The document could not be read. It may be corrupt, password protected or not a valid TSD.');
    }
    const rev = kind === 'docx' ? parseRevisionHistory(doc.blocks) : parseRevisionHistoryFromLines(doc.blocks.map((b) => b.text));
    const s = createSession({ doc, rev, fileName: str(req.file.originalname.replace(/[\\/]/g, '_'), 120), kind });

    if (rev.status === 'ok' || rev.status === 'warning') stageEntry(s, rev.latest);
    log('info', 'document analysed', { kind, bytes: req.file.size, ms: Date.now() - t0, revisionStatus: rev.status, entries: rev.entries.length });
    res.json(revisionResponse(s));
  })
);

/* 1b. User resolves an unclear Revision History ----------------------------- */
app.post(
  '/api/select-revision',
  wrap(async (req, res) => {
    const s = needSession(req);
    const pos = Number(req.body.position);
    const entry = s.rev.entries.find((e) => e.position === pos);
    if (!entry) throw new HttpError(400, 'Please choose one of the listed revision entries.');
    stageEntry(s, entry);
    res.json(revisionResponse(s));
  })
);

app.post(
  '/api/manual-revision',
  wrap(async (req, res) => {
    const s = needSession(req);
    const number = str(req.body.number, 20);
    const date = str(req.body.date, 30);
    const description = str(req.body.description, 4000);
    if (!description) throw new HttpError(400, 'Please enter the change description exactly as it should be tested.');
    const parsed = analyseRevisions([{ position: 1, numberRaw: number, dateRaw: date, project: '', summary: description, revisedBy: '' }]);
    const entry = parsed.entries[0];
    entry.ids = extractIdentifiers(description + ' ' + str(req.body.identifiers, 400));
    stageEntry(s, entry);
    res.json(revisionResponse(s));
  })
);

/* 2. User confirms or corrects the change summary --------------------------- */
app.post(
  '/api/confirm-summary',
  wrap(async (req, res) => {
    const s = needSession(req);
    if (s.stage === 'uploaded' || !s.analysis) throw new HttpError(409, 'The latest revision has not been established yet.');
    const c = req.body.corrections || {};
    const fieldNames = Array.isArray(c.fieldNames) ? c.fieldNames.map((x) => str(x, 120)).filter((x) => /^[\w./\[\]:@=\- ]{2,120}$/.test(x)).slice(0, 10) : [];
    if (req.body.confirmed !== true) throw new HttpError(400, 'Please confirm the change summary to continue.');
    s.corrections = {
      sourceSystem: str(c.sourceSystem, 200),
      targetSystem: str(c.targetSystem, 200),
      fieldNames,
      changeDetail: str(c.changeDetail, 2000),
      note: str(c.note, 2000)
    };
    s.confirmed = true;
    s.stage = 'confirmed';
    s.tut = null;
    s.approved = false;
    res.json({ ok: true });
  })
);

/* 3. Generate the preview ---------------------------------------------------- */
function previewOf(tut) {
  return {
    meta: tut.meta,
    inputs: { tutType: tut.inputs.tutType, environment: tut.inputs.environment, scenario: tut.inputs.scenario },
    interface: { id: tut.analysis.interface.id, name: tut.analysis.interface.name },
    entry: tut.analysis.entry,
    testCases: tut.testCases,
    flags: tut.flags,
    unconfirmed: tut.unconfirmed,
    validation: tut.validation,
    verdict: summarize(tut.validation)
  };
}

/** Builds the Word file, inspects its real structure and replaces check 9 with the measured result. */
async function buildAndCheck(s) {
  const first = await buildDocx(s.tut);
  const stats = await inspectDocx(first.buffer);
  s.tut.validation = s.tut.validation.map((v) => (v.id === 9 ? checkFormat(stats) : v));
  // Rebuild so the appendix in the file shows the measured result of check 9 (layout is unchanged by this).
  s.docx = await buildDocx(s.tut);
}

app.post(
  '/api/generate',
  wrap(async (req, res) => {
    const s = needSession(req);
    if (!s.confirmed) throw new HttpError(409, 'Please confirm the Change Summary first.');
    const i = req.body.inputs || {};
    const inputs = {
      tutType: i.tutType === 'negative' ? 'negative' : i.tutType === 'positive' ? 'positive' : '',
      scenario: str(i.scenario, 2000),
      sourceSystem: (s.corrections && s.corrections.sourceSystem) || str(i.sourceSystem, 200),
      targetSystem: (s.corrections && s.corrections.targetSystem) || str(i.targetSystem, 200),
      samplePayload: str(i.samplePayload, 20000),
      expectedBehavior: str(i.expectedBehavior, 2000),
      environment: ['DEV', 'QAS', 'UAT', 'PRD', 'OTHER'].includes(i.environment) ? i.environment : '',
      assumptions: str(i.assumptions, 2000),
      fieldNames: (s.corrections && s.corrections.fieldNames) || [],
      changeDetail: (s.corrections && s.corrections.changeDetail) || ''
    };
    if (!inputs.tutType) throw new HttpError(400, 'Please choose Positive or Negative TUT.');
    s.tut = generateTut(s.analysis, inputs);
    s.docx = null;
    await buildAndCheck(s);
    s.stage = 'preview';
    s.approved = false;
    log('info', 'tut generated', { tutType: inputs.tutType, cases: s.tut.testCases.length, flags: s.tut.flags.length });
    res.json({ sessionId: s.id, preview: previewOf(s.tut) });
  })
);

/* 4. Approve the preview, then download ------------------------------------- */
app.post(
  '/api/approve',
  wrap(async (req, res) => {
    const s = needSession(req);
    if (!s.tut) throw new HttpError(409, 'Generate the preview first.');
    if (s.tut.validation.some((v) => v.status === 'fail')) throw new HttpError(409, 'The quality check has failures. Provide the missing information and regenerate.');
    s.approved = req.body.approved === true;
    res.json({ ok: s.approved });
  })
);

app.post(
  '/api/download',
  wrap(async (req, res) => {
    const s = needSession(req);
    if (!s.tut || !s.approved) throw new HttpError(409, 'Review and approve the preview before downloading.');
    if (!s.docx) await buildAndCheck(s);
    const { buffer, fileName } = s.docx;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    log('info', 'tut downloaded', { bytes: buffer.length });
    res.end(buffer);
  })
);

app.post('/api/reset', (req, res) => {
  if (req.body && typeof req.body.sessionId === 'string') sessions.delete(req.body.sessionId);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- errors */

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${Math.round(MAX_UPLOAD / 1048576)} MB.` : 'The upload was rejected.';
    return res.status(400).json({ error: msg });
  }
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  log('error', 'unhandled error', { path: req.path, err: err && err.message });
  res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
});

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    log('info', 'SAP PI/PO TUT Generator started', {
      host: HOST,
      port: PORT,
      url: IS_RENDER
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
        : `http://${HOST}:${PORT}`
    });
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 5 * 1000;
}

module.exports = { app, HOST, PORT };
