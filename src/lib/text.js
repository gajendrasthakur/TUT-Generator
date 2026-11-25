'use strict';

/** Collapse whitespace (incl. NBSP) and trim. */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise but keep line structure (used for multi-line cells). */
function normLines(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set(arr.filter((x) => x !== '' && x != null)));
}

function truncate(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

module.exports = { norm, normLines, uniq, truncate };
