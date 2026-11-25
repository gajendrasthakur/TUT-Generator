'use strict';

const { norm, normLines } = require('./text');
const { extractIdentifiers } = require('./identifiers');

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

/* ------------------------------------------------------------------ dates */

/**
 * Parses a date string. Returns {candidates:[{y,m,d,fmt}], raw} or null.
 * Numeric dates with both parts <= 12 produce two candidates (dd/mm and mm/dd).
 */
function parseDateRaw(raw) {
  const s = norm(raw);
  if (!s) return null;

  let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    const c = [];
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) c.push({ y, m: b, d: a, fmt: 'dd/mm' });
    if (b >= 1 && b <= 31 && a >= 1 && a <= 12 && a !== b) c.push({ y, m: a, d: b, fmt: 'mm/dd' });
    if (a === b && c.length === 0 && a >= 1 && a <= 12) c.push({ y, m: a, d: b, fmt: 'dd/mm' });
    return c.length ? { candidates: c, raw: s } : { candidates: [], raw: s, invalid: true };
  }

  m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
  if (m) return { candidates: [{ y: +m[1], m: +m[2], d: +m[3], fmt: 'yyyy-mm-dd' }], raw: s };

  m = /^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]*(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    return { candidates: [{ y, m: MONTHS[m[2].toLowerCase()], d: +m[1], fmt: 'dd Mon yyyy' }], raw: s };
  }
  return { candidates: [], raw: s, invalid: true };
}

function toIso(c) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(c.y).padStart(4, '0')}-${p(c.m)}-${p(c.d)}`;
}

function plausible(c, now) {
  const yr = now.getUTCFullYear();
  return c.y >= 2015 && c.y <= yr + 1;
}

/* --------------------------------------------------------------- table I/O */

function headerIndex(headerCells) {
  const idx = { number: -1, date: -1, project: -1, summary: -1, by: -1 };
  headerCells.forEach((h, i) => {
    const t = norm(h).toLowerCase();
    if (idx.number < 0 && /(revision|rev|version).*(no|number|#)|^(no|rev|version)\b/.test(t)) idx.number = i;
    else if (idx.date < 0 && /date/.test(t)) idx.date = i;
    else if (idx.project < 0 && /project|market/.test(t)) idx.project = i;
    else if (idx.summary < 0 && /(summary|description|change|comment)/.test(t)) idx.summary = i;
    else if (idx.by < 0 && /(revised|author|by|name)/.test(t)) idx.by = i;
  });
  return idx;
}

function isRevisionHeader(cells) {
  const t = cells.map((c) => norm(c).toLowerCase()).join(' | ');
  return /revision|version/.test(t) && /date/.test(t) && /(summary|description|changes?)/.test(t);
}

function findRevisionTable(blocks) {
  // Prefer a table that directly follows a "Revision History" heading, else any table with a matching header.
  let afterHeading = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'p' && /^revision history$/i.test(norm(b.text)) && !b.hadTab) {
      afterHeading = i;
      break;
    }
  }
  const scan = (from, to) => {
    for (let i = from; i < to && i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'tbl' && b.rows.length >= 2) {
        for (let r = 0; r < Math.min(2, b.rows.length); r++) {
          if (isRevisionHeader(b.rows[r])) return { block: b, headerRow: r };
        }
      }
    }
    return null;
  };
  return (afterHeading >= 0 && scan(afterHeading, afterHeading + 6)) || scan(0, blocks.length);
}

function rowsToEntries(rows, headerRow) {
  const idx = headerIndex(rows[headerRow]);
  if (idx.number < 0) idx.number = 0;
  if (idx.date < 0) idx.date = 1;
  if (idx.summary < 0) idx.summary = Math.min(3, rows[headerRow].length - 1);
  const entries = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const joined = row.map(norm).join('');
    if (!joined) continue;
    const numberRaw = norm(row[idx.number]);
    const dateRaw = norm(row[idx.date]);
    const summaryLines = normLines(row[idx.summary] || '');
    if (!numberRaw && !dateRaw && !summaryLines.length) continue;
    entries.push({
      position: entries.length + 1,
      numberRaw,
      dateRaw,
      project: idx.project >= 0 ? norm(row[idx.project]) : '',
      summary: summaryLines.join('\n'),
      revisedBy: idx.by >= 0 ? norm(row[idx.by]) : ''
    });
  }
  return entries;
}

/** Fallback for PDFs: rows are text lines "N  dd/mm/yyyy  PROJECT  summary ... by". */
function linesToEntries(lines) {
  const start = lines.findIndex((l) => /^revision history$/i.test(norm(l)));
  if (start < 0) return [];
  const entries = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = norm(lines[i]);
    if (!l) continue;
    if (/^(design authority|table of contents|0?\.?\s*document information|1\.?\s*general information)/i.test(l)) break;
    const m = /^(\d{1,3})\s+(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\s+(.*)$/.exec(l);
    if (m) {
      if (cur) entries.push(cur);
      cur = { position: entries.length + 1, numberRaw: m[1], dateRaw: m[2], project: '', summary: m[3], revisedBy: '' };
    } else if (cur && !/^revision number/i.test(l)) {
      cur.summary += '\n' + l;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/* -------------------------------------------------------------- analysis */

function analyseRevisions(entries, now = new Date()) {
  const issues = [];
  if (!entries.length) {
    return { status: 'missing', entries: [], latest: null, candidates: [], issues: [{ level: 'error', text: 'No Revision History entries could be read from the document.' }] };
  }

  // Dominant numeric date format from unambiguous dates.
  let ddmm = 0;
  let mmdd = 0;
  for (const e of entries) {
    const p = parseDateRaw(e.dateRaw);
    if (p && p.candidates.length === 1) {
      if (p.candidates[0].fmt === 'dd/mm') ddmm++;
      else if (p.candidates[0].fmt === 'mm/dd') mmdd++;
    }
  }
  const dominant = mmdd > ddmm ? 'mm/dd' : 'dd/mm';

  // Pass 1: parse numbers and all unambiguous dates.
  for (const e of entries) {
    const n = /\d+/.exec(e.numberRaw);
    e.number = n ? parseInt(n[0], 10) : null;
    e.date = null;
    e.dateIssue = null;
    e.dateAmbiguous = false;
    e._cands = null;
    const p = parseDateRaw(e.dateRaw);
    if (!p || !p.candidates.length) {
      e.dateIssue = e.dateRaw ? 'unreadable' : 'missing';
    } else {
      const cands = p.candidates.filter((c) => plausible(c, now));
      if (!cands.length) e.dateIssue = 'implausible';
      else if (cands.length === 1) e.date = toIso(cands[0]);
      else {
        e.dateAmbiguous = true;
        e._cands = cands;
      }
    }
    e.ids = extractIdentifiers(e.summary);
  }
  // Pass 2: resolve ambiguous dd/mm vs mm/dd using the surrounding unambiguous rows, because some TSDs mix
  // both formats. Fall back to the document's dominant format when both readings fit equally well.
  const days = (iso) => Date.parse(iso + 'T00:00:00Z') / 86400000;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e._cands) continue;
    let prev = null;
    let next = null;
    for (let j = i - 1; j >= 0 && !prev; j--) if (entries[j].date && !entries[j]._cands) prev = entries[j].date;
    for (let j = i + 1; j < entries.length && !next; j++) if (entries[j].date && !entries[j]._cands) next = entries[j].date;
    const penalty = (c) => {
      const d = days(toIso(c));
      let pen = 0;
      if (prev && d < days(prev)) pen += days(prev) - d;
      if (next && d > days(next)) pen += d - days(next);
      return pen;
    };
    const scored = e._cands.map((c) => ({ c, pen: penalty(c) })).sort((a, b) => a.pen - b.pen);
    const tied = scored.filter((s) => s.pen === scored[0].pen);
    const pick = (tied.find((s) => s.c.fmt === dominant) || tied[0]).c;
    e.date = toIso(pick);
    e.dateAmbiguousResolvedBy = tied.length === 1 ? 'neighbouring rows' : 'dominant format';
  }
  for (const e of entries) delete e._cands;

  const hasNumbers = entries.some((e) => e.number != null);
  const lastPos = entries.reduce((a, b) => (b.position > a.position ? b : a));

  // by number (ties -> later position)
  let byNumber = null;
  if (hasNumbers) {
    for (const e of entries) {
      if (e.number == null) continue;
      if (!byNumber || e.number > byNumber.number || (e.number === byNumber.number && e.position > byNumber.position)) byNumber = e;
    }
  }
  // by date (ties -> higher number, later position)
  let byDate = null;
  for (const e of entries) {
    if (!e.date) continue;
    if (
      !byDate ||
      e.date > byDate.date ||
      (e.date === byDate.date && ((e.number || 0) > (byDate.number || 0) || ((e.number || 0) === (byDate.number || 0) && e.position > byDate.position)))
    )
      byDate = e;
  }

  // Data-quality notes
  const dupNums = {};
  for (const e of entries) if (e.number != null) dupNums[e.number] = (dupNums[e.number] || 0) + 1;
  const dups = Object.keys(dupNums).filter((k) => dupNums[k] > 1);
  if (dups.length) issues.push({ level: 'info', text: `Duplicate revision numbers in the table: ${dups.join(', ')}.` });
  const bad = entries.filter((e) => e.dateIssue);
  for (const e of bad) {
    issues.push({
      level: 'warn',
      text: `Revision ${e.numberRaw || '#' + e.position} has ${e.dateIssue === 'implausible' ? 'an implausible' : e.dateIssue === 'missing' ? 'no' : 'an unreadable'} date ("${e.dateRaw}").`
    });
  }

  const primary = byNumber || lastPos;
  let status = 'ok';
  let candidates = [primary];

  if (byDate && byDate !== primary) {
    if (primary.date && byDate.date > primary.date) {
      status = 'conflict';
      candidates = [primary, byDate];
      issues.push({
        level: 'error',
        text: `Revision ${primary.numberRaw} (highest revision number, dated ${primary.dateRaw}) is older than revision ${byDate.numberRaw} (dated ${byDate.dateRaw}). The latest entry is unclear.`
      });
    } else if (!primary.date) {
      status = 'warning';
      issues.push({
        level: 'warn',
        text: `The highest-numbered revision (${primary.numberRaw}) has a date that cannot be verified, so it was chosen by revision number only.`
      });
    }
  }
  if (status !== 'conflict' && primary !== lastPos && hasNumbers) {
    if (lastPos.number != null && lastPos.number < primary.number) {
      issues.push({
        level: 'info',
        text: `The latest entry (revision ${primary.numberRaw}) is not the last row of the table (row ${primary.position} of ${entries.length}).`
      });
    }
  }
  if (primary.dateAmbiguous) {
    issues.push({
      level: 'info',
      text: `The date "${primary.dateRaw}" can be read as dd/mm or mm/dd; it was read as ${primary.date} (decided by ${primary.dateAmbiguousResolvedBy}).`
    });
  }
  if (lastPos !== primary && !candidates.includes(lastPos) && status === 'conflict') candidates.push(lastPos);

  return {
    status,
    dominantDateFormat: dominant,
    entries,
    latest: status === 'conflict' ? null : primary,
    candidates,
    issues
  };
}

/** Public entry: from the docx block list. */
function parseRevisionHistory(blocks, now = new Date()) {
  const found = findRevisionTable(blocks);
  if (!found) {
    return { status: 'missing', entries: [], latest: null, candidates: [], issues: [{ level: 'error', text: 'No Revision History table was found.' }] };
  }
  const entries = rowsToEntries(found.block.rows, found.headerRow);
  return analyseRevisions(entries, now);
}

/** Public entry: from PDF text lines. */
function parseRevisionHistoryFromLines(lines, now = new Date()) {
  return analyseRevisions(linesToEntries(lines), now);
}

module.exports = { parseRevisionHistory, parseRevisionHistoryFromLines, analyseRevisions, parseDateRaw };
