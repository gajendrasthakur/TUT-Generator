'use strict';

const { norm, uniq } = require('./text');

const RE = {
  channel: /\bCC_[A-Za-z0-9]+(?:_[A-Za-z0-9]+){2,}\b/g,
  om: /\bOM_[A-Za-z0-9_]+/g,
  mm: /\bMM_[A-Za-z0-9_]+/g,
  si: /\bSI_[A-Za-z0-9_]+/g,
  mt: /\bMT_[A-Za-z0-9_]+/g,
  dt: /\bDT_[A-Za-z0-9_]+/g,
  component: /\b(?:TPBS_[A-Z0-9_]+|INTEGRATION_ENGINE_JAVA_[A-Z0-9]+|[A-Z0-9]{3}_\d{3}\b)/g,
  scenario: /\bScenario_[A-Za-z0-9_]+/g,
  path: /(?:\/(?:[A-Za-z][\w.-]*:)?[A-Za-z_][\w.-]*){3,}/g,
  idocType: /\b(?:ZG[A-Z0-9_]*(?:\.[A-Z0-9_]+)+|[A-Z0-9]{4,12}\d{2}(?=\b))/g
};

function matchAll(re, text) {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re), (m) => m[0].replace(/[.,;:)]+$/, ''));
}

/** Direction/adapter parsed from the PepsiCo channel naming convention CC_<scope>_<adapter>_<SNDR|RCVR>_<name>_<id>. */
function parseChannel(name) {
  const m = /^CC_([A-Za-z0-9]+)_(.+?)_(SNDR|RCVR)_(.+)$/.exec(name);
  if (!m) return { name, direction: null, adapter: null };
  return {
    name,
    scope: m[1],
    adapter: m[2].replace(/_AAE$/, '').toUpperCase(),
    direction: m[3] === 'SNDR' ? 'Sender' : 'Receiver',
    rest: m[4]
  };
}

function extractNames(text) {
  const t = String(text || '');
  return {
    channels: uniq(matchAll(RE.channel, t)),
    operationMappings: uniq(matchAll(RE.om, t)),
    messageMappings: uniq(matchAll(RE.mm, t)),
    serviceInterfaces: uniq(matchAll(RE.si, t)),
    messageTypes: uniq(matchAll(RE.mt, t)),
    dataTypes: uniq(matchAll(RE.dt, t)),
    components: uniq(matchAll(RE.component, t)),
    paths: uniq(matchAll(RE.path, t)).filter((p) => p.split('/').length > 3 && !/^\/\/|https?:/i.test(p))
  };
}

/* --------------------------------------------------------- conditions */

const NEQ = '\\u2260|!=|<>|not equal to';
const EQ = '=|equals';
const TERM_RE = new RegExp('((?:\\/[\\w:.\\-]+){2,})\\s*(' + NEQ + '|' + EQ + ')\\s*([^\\s/()]+)', 'gi');
const TOKEN_RE = new RegExp('((?:\\/[\\w:.\\-]+){2,})\\s*(' + NEQ + '|' + EQ + ')\\s*([^\\s/()]+)|\\b(AND|OR)\\b|([()])', 'gi');

function normOp(op) {
  const o = op.toLowerCase();
  return o === '=' || o === 'equals' ? '=' : '\u2260';
}

function cleanText(line) {
  return norm(line).replace(/[\uFFFD]/g, '').replace(/\u00C2/g, '');
}

/** Extracts all "path = value" / "path \u2260 value" terms from a line (in order). */
function conditionTerms(line) {
  const out = [];
  const s = cleanText(line);
  TERM_RE.lastIndex = 0;
  let m;
  while ((m = TERM_RE.exec(s))) out.push({ path: m[1], op: normOp(m[2]), value: m[3].replace(/[,;"'.]+$/, '') });
  return out;
}

/** Tokenises a block of text into a flat list: term | AND | OR | ( | ). */
function conditionTokens(text) {
  const s = cleanText(text);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    if (m[1]) out.push({ t: 'term', path: m[1], op: normOp(m[2]), value: m[3].replace(/[,;"'.]+$/, '') });
    else if (m[4]) out.push({ t: m[4].toUpperCase() });
    else if (m[5]) out.push({ t: m[5] });
  }
  return out;
}

/** Builds an AST (OR of ANDs, parentheses supported). Missing connectors default to AND. */
function parseCondition(tokens) {
  let i = 0;
  const parseOr = () => {
    const parts = [parseAnd()];
    while (tokens[i] && tokens[i].t === 'OR') {
      i++;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { op: 'OR', args: parts };
  };
  const parseAnd = () => {
    const parts = [parseAtom()];
    while (i < tokens.length && tokens[i].t !== 'OR' && tokens[i].t !== ')') {
      if (tokens[i].t === 'AND') i++;
      if (i >= tokens.length || tokens[i].t === 'OR' || tokens[i].t === ')') break;
      parts.push(parseAtom());
    }
    return parts.length === 1 ? parts[0] : { op: 'AND', args: parts };
  };
  const parseAtom = () => {
    const tk = tokens[i];
    if (!tk) return { op: 'TRUE', args: [] };
    if (tk.t === '(') {
      i++;
      const e = parseOr();
      if (tokens[i] && tokens[i].t === ')') i++;
      return e;
    }
    if (tk.t === 'term') {
      i++;
      return { op: 'TERM', term: tk };
    }
    i++;
    return { op: 'TRUE', args: [] };
  };
  return parseOr();
}

function astTerms(ast, acc = []) {
  if (!ast) return acc;
  if (ast.op === 'TERM') acc.push(ast.term);
  else (ast.args || []).forEach((a) => astTerms(a, acc));
  return acc;
}

function astToString(ast, top = true) {
  if (!ast) return '';
  if (ast.op === 'TERM') return `${ast.term.path.split('/').slice(-1)[0]} ${ast.term.op} ${ast.term.value}`;
  if (ast.op === 'TRUE') return '';
  const s = ast.args.map((a) => astToString(a, false)).filter(Boolean).join(` ${ast.op} `);
  return top || ast.args.length === 1 ? s : `(${s})`;
}

/** Evaluates against a payload given as { fieldLeafName: value }. Unknown leaf names are treated as "not equal". */
function evalAst(ast, payload) {
  if (ast.op === 'TRUE') return true;
  if (ast.op === 'TERM') {
    const leaf = ast.term.path.split('/').slice(-1)[0];
    const has = Object.prototype.hasOwnProperty.call(payload, leaf);
    const eq = has && String(payload[leaf]).toLowerCase() === String(ast.term.value).toLowerCase();
    return ast.term.op === '=' ? eq : !eq;
  }
  if (ast.op === 'AND') return ast.args.every((a) => evalAst(a, payload));
  return ast.args.some((a) => evalAst(a, payload));
}

/**
 * Finds routing / receiver-determination condition groups in a list of scoped lines, e.g.
 *   "Before change condition for AVAIL:"  a \u2260 SVT AND b \u2260 SCHUB
 *   "Condition as part of this change for AVAIL:" a \u2260 SVT OR b \u2260 SCHUB
 * A group = a heading line (before / after / receiver label) plus the following lines up to the next heading or prose.
 */
function extractConditionGroups(lines) {
  const groups = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.tokens.some((t) => t.t === 'term')) {
      cur.ast = parseCondition(cur.tokens);
      cur.terms = astTerms(cur.ast);
      groups.push(cur);
    }
    cur = null;
  };
  const start = (kind, label, receiver) => {
    flush();
    cur = { kind, label, receiver: receiver || null, tokens: [] };
  };
  for (const raw of lines) {
    const l = cleanText(raw);
    if (!l) continue;
    const hasTerm = conditionTerms(l).length > 0;
    const isBefore = /\b(before|existing|old|previous|earlier)\b[^/]*\bcondition|\bcondition\b[^/]*\b(before|existing|old|previous)\b/i.test(l);
    const isAfter =
      /\bcondition\b[^/]*\b(as part of this change|updated|new|after|changed|now)\b|\b(as part of this change|updated|new|changed)\b[^/]*\bcondition\b/i.test(l) && !isBefore;
    const forRecv = /\bfor\s+([A-Z][A-Za-z0-9_]+)\s*:/.exec(l);
    const svcRecv = /^Service\s*:\s*(\S+)/i.exec(l);
    const labelOnly = /^for\s+([A-Z][A-Za-z0-9_]+)\s*:/i.exec(l);

    if (isBefore && !hasTerm) {
      const r = /\bfor\s+([A-Z][A-Za-z0-9_]+)\s*:?\s*$/.exec(l.replace(/:\s*$/, ''));
      start('before', l.replace(/:\s*$/, ''), r ? r[1] : null);
      continue;
    }
    if (isAfter && !hasTerm) {
      const r = /\bfor\s+([A-Z][A-Za-z0-9_]+)\s*:?\s*$/.exec(l.replace(/:\s*$/, ''));
      start('after', l.replace(/:\s*$/, ''), r ? r[1] : null);
      continue;
    }
    if (labelOnly && hasTerm) {
      start('current', `Condition for ${labelOnly[1]}`, labelOnly[1]);
      cur.tokens.push(...conditionTokens(l.replace(/^for\s+[A-Za-z0-9_]+\s*:/i, '')));
      continue;
    }
    if (hasTerm || /^(AND|OR)$/i.test(l) || /^[()]$/.test(l)) {
      if (!cur) start('current', 'Condition stated in the change', null);
      cur.tokens.push(...conditionTokens(l));
      continue;
    }
    if (svcRecv && cur) {
      cur.receiver = cur.receiver || svcRecv[1];
      cur.service = svcRecv[1];
      flush();
      continue;
    }
    if (cur && /^(condition|condition updated as|party|service)\b/i.test(l)) continue;
    // prose line ends the current group
    if (cur) flush();
  }
  flush();
  return groups;
}

function groupToString(g) {
  return astToString(g.ast);
}

module.exports = {
  extractNames,
  parseChannel,
  conditionTerms,
  conditionTokens,
  parseCondition,
  extractConditionGroups,
  evalAst,
  groupToString,
  RE
};
