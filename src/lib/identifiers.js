'use strict';

const { norm, uniq } = require('./text');

/** Prefixes that look like JIRA keys but are not (avoid false positives). */
const NOT_JIRA = new Set([
  'ADO', 'CRF', 'INC', 'RITM', 'TASK', 'N', 'UTF', 'ISO', 'SHA', 'AES', 'TLS', 'SSL', 'EDI', 'XI', 'IDOC',
  'PQGC', 'HTTP', 'UTC', 'EST', 'EDT', 'ALM', 'RFC', 'ZG', 'CC', 'DT', 'MT', 'SI', 'MM', 'OM', 'PO', 'RE', 'US', 'A', 'B'
]);

function digitsList(s) {
  return (s.match(/\d{5,9}/g) || []).map((d) => d);
}

/**
 * Extracts every change identifier that can be recognised in a piece of text.
 * Returns arrays of unique strings per identifier family.
 */
function extractIdentifiers(text) {
  const t = norm(text);
  const ids = {
    xref: [],
    ado: [],
    crf: [],
    jira: [],
    inc: [],
    ritm: [],
    defect: [],
    bug: [],
    task: [],
    alm: [],
    wricef: []
  };
  if (!t) return ids;

  for (const m of t.matchAll(/\bN_\d{2,6}\b/g)) ids.xref.push(m[0].toUpperCase());

  // "ADO 1234567", "ADO-1234567", "ADO: 1234567", "ADO #1234567", "ADO - 18774294, 19229799"
  for (const m of t.matchAll(/\bADO(?:\s*(?:ID|Bug|task|item))?[\s#:\-\u2013\u2014]*(\d{5,9}(?:\s*(?:,|&|and|\/)\s*\d{5,9})*)/gi)) {
    ids.ado.push(...digitsList(m[1]));
  }
  for (const m of t.matchAll(/\bCRF\s*#?\s*(\d{4,6})\b/gi)) ids.crf.push('CRF' + m[1]);
  for (const m of t.matchAll(/\bINC\s*#?\s*(\d{6,9})\b/gi)) ids.inc.push('INC' + m[1]);
  for (const m of t.matchAll(/\bRITM\s*#?\s*(\d{6,9})\b/gi)) ids.ritm.push('RITM' + m[1]);
  for (const m of t.matchAll(/\bTASK\s*#?\s*(\d{6,9})\b/gi)) ids.task.push('TASK' + m[1]);
  for (const m of t.matchAll(/\bDefect\s*#?\s*(\d{3,6})\b/gi)) ids.defect.push(m[1]);
  for (const m of t.matchAll(/\bBug\s*:?\s*#?\s*(\d{5,9})\b/gi)) ids.bug.push(m[1]);
  for (const m of t.matchAll(/\bALM[-\s]?(\d{4,6})\b/gi)) ids.alm.push('ALM-' + m[1]);
  for (const m of t.matchAll(/\bI\d{6}\b/g)) ids.wricef.push(m[0]);

  for (const m of t.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
    if (!NOT_JIRA.has(m[1])) ids.jira.push(m[0]);
  }

  for (const k of Object.keys(ids)) ids[k] = uniq(ids[k]);
  return ids;
}

/**
 * Tokens used to decide whether a "Start of ..." marker belongs to a given revision.
 * XREF -> "N_11561"; numeric references -> the digits; textual refs (CRF, INC...) -> upper-case token.
 */
function matchTokens(ids) {
  const tokens = [];
  for (const x of ids.xref) tokens.push(x);
  for (const k of ['ado', 'bug', 'defect']) for (const d of ids[k]) tokens.push(d);
  for (const k of ['crf', 'inc', 'ritm', 'task', 'alm']) for (const v of ids[k]) tokens.push(v.replace(/^ALM-/, ''));
  for (const j of ids.jira) tokens.push(j);
  return uniq(tokens.map((x) => String(x).toUpperCase()));
}

/** Tokens found in a marker/tag text (same normalisation as matchTokens). */
function tagTokens(tag) {
  return matchTokens(extractIdentifiers(tag)).concat(
    // Also catch bare numbers such as "Start of 18774294" and "Start of Change: 5309183"
    (norm(tag).match(/\b\d{6,9}\b/g) || []).map((d) => d.toUpperCase())
  );
}

function flattenIds(ids) {
  const out = [];
  const label = {
    xref: 'XREF',
    ado: 'ADO',
    crf: 'CRF',
    jira: 'JIRA',
    inc: 'INC',
    ritm: 'RITM',
    defect: 'Defect',
    bug: 'Bug',
    task: 'TASK',
    alm: 'ALM',
    wricef: 'WRICEF'
  };
  for (const k of Object.keys(label)) for (const v of ids[k] || []) out.push({ type: label[k], value: v });
  return out;
}

module.exports = { extractIdentifiers, matchTokens, tagTokens, flattenIds };
