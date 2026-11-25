'use strict';

const { norm, uniq, truncate } = require('./text');
const { classifyHeading, LABELS } = require('./sections');
const { extractIdentifiers, matchTokens, tagTokens } = require('./identifiers');
const { extractNames, parseChannel } = require('./components');

const ID_RE = /\bN_\d{2,6}\b|\b(?:ADO|CRF|INC|RITM|TASK|Defect|Bug|ALM)[\s#:\-\u2013\u2014]*\d{3,9}\b|\b\d{5,9}\b|\b[A-Z][A-Z0-9]+-\d+\b/gi;

/* ------------------------------------------------------------ markers */

/**
 * Splits one line into plain-text pieces and Start/End markers that carry change identifiers.
 * Generic markers without an identifier ("Start of the change") are dropped from the text.
 */
function splitMarkers(line) {
  const re = /\b(Start|Begin(?:ning)?|End)\s+of\b/gi;
  const hits = [];
  let m;
  while ((m = re.exec(line))) hits.push({ i: m.index, kind: /^end/i.test(m[1]) ? 'end' : 'start' });
  if (!hits.length) return [{ kind: 'text', text: line }];

  const out = [];
  const lead = line.slice(0, hits[0].i);
  if (norm(lead)) out.push({ kind: 'text', text: lead });
  for (let k = 0; k < hits.length; k++) {
    const seg = line.slice(hits[k].i, k + 1 < hits.length ? hits[k + 1].i : line.length);
    const head = seg.slice(0, 150);
    const tokens = uniq(tagTokens(head));
    if (!tokens.length) {
      if (/^(start|begin\w*|end)\s+of\s+(the\s+)?changes?\b/i.test(seg)) continue;
      out.push({ kind: 'text', text: seg });
      continue;
    }
    let lastEnd = 0;
    ID_RE.lastIndex = 0;
    let im;
    while ((im = ID_RE.exec(head))) lastEnd = im.index + im[0].length;
    const rest = seg.slice(lastEnd).replace(/^[\s:.\-\u2013\u2014,*]+/, '');
    out.push({ kind: hits[k].kind, tag: norm(seg.slice(0, Math.max(lastEnd, 12))), tokens });
    if (norm(rest)) out.push({ kind: 'text', text: rest });
  }
  return out;
}

/* ------------------------------------------------------------ scoping */

function isPathOnly(t) {
  return /^\/[\w:.\-/]+$/.test(t.trim());
}

/**
 * Walks the document once and returns:
 *  - regions: one per matching Start/End pair
 *  - mentions: fallback hits when no markers exist
 *  - sectionBlocks: blocks grouped by canonical section (for interface-level facts)
 */
function scopeChange(blocks, embeds, revTokens) {
  const regions = [];
  const open = [];
  const mentions = [];
  let section = { key: 'cover', label: LABELS.cover, level: 0 };
  const revSet = new Set(revTokens);
  const intersects = (tokens) => tokens.some((t) => revSet.has(t));

  const closeRegion = (r, how) => {
    r.closed = how;
    const i = open.indexOf(r);
    if (i >= 0) open.splice(i, 1);
  };

  const addLine = (text, extra) => {
    const t = norm(text);
    if (!t) return;
    for (const r of open) r.lines.push({ text: t, section: section.key, label: section.label, ...extra });
  };

  const processLine = (rawLine, extra) => {
    for (const piece of splitMarkers(rawLine)) {
      if (piece.kind === 'text') {
        addLine(piece.text, extra);
      } else if (piece.kind === 'start') {
        if (intersects(piece.tokens)) {
          const same = open.find((r) => r.tag === piece.tag);
          if (!same) {
            const r = {
              tag: piece.tag,
              tokens: piece.tokens,
              extraTokens: piece.tokens.filter((t) => !revSet.has(t)),
              startSection: section.key,
              startLabel: section.label,
              lines: [],
              tables: [],
              embeds: [],
              closed: null
            };
            regions.push(r);
            open.push(r);
          }
        }
      } else if (piece.kind === 'end') {
        if (intersects(piece.tokens)) {
          for (const r of open.slice()) if (r.tokens.some((t) => piece.tokens.includes(t))) closeRegion(r, 'end');
        }
      }
    }
  };

  const sectionBlocks = {};
  let lastLabel = '';
  blocks.forEach((b, bi) => {
    if (b.type === 'p') {
      const h = classifyHeading(b.text, b.style, b.hadTab);
      if (h) {
        section = h;
        // A region still open when a new top-level section starts is unterminated.
        for (const r of open.slice()) if (h.level <= 1 && r.startSection !== section.key) closeRegion(r, 'unterminated');
      }
      (sectionBlocks[section.key] = sectionBlocks[section.key] || []).push({ ...b, bi, label: lastLabel });
      const t = norm(b.text);
      if (t && t.length <= 40 && !/^(start|end) of/i.test(t) && !h) lastLabel = t.replace(/[:\s]+$/, '');
      const lines = String(b.text || '').split(/\n/);
      for (const ln of lines) {
        if (!norm(ln)) continue;
        if (isPathOnly(ln) || !h) processLine(ln, { kind: 'p' });
      }
      if (open.length && b.oles) for (const o of b.oles) for (const r of open) r.embeds.push(o.rid);
      if (!open.length && !regions.length && revTokens.length && !h) {
        for (const tk of tagTokens(b.text)) if (revSet.has(tk)) mentions.push({ text: norm(b.text), section: section.key, label: section.label });
      }
    } else if (b.type === 'tbl') {
      (sectionBlocks[section.key] = sectionBlocks[section.key] || []).push({ ...b, bi, label: lastLabel });
      const wasOpen = open.slice();
      const touched = new Map(); // region -> rows
      b.rows.forEach((row, ri) => {
        const before = open.slice();
        const lenBefore = regions.length;
        for (const cell of row) for (const ln of String(cell).split(/\n/)) if (norm(ln)) processLine(ln, { kind: 'cell', tableIndex: bi });
        const involved = new Set([...before, ...open, ...regions.slice(lenBefore)]);
        for (const r of involved) {
          if (!touched.has(r)) touched.set(r, []);
          touched.get(r).push(ri);
        }
        if (!regions.length) {
          const joined = row.join(' ');
          for (const tk of tagTokens(joined)) if (revSet.has(tk)) mentions.push({ text: truncate(norm(joined), 300), section: section.key, label: section.label });
        }
      });
      for (const [r, rowsIdx] of touched) {
        const uniqRows = uniq(rowsIdx);
        r.tables.push({
          bi,
          section: section.key,
          label: section.label,
          nearLabel: lastLabel,
          header: b.rows[0] || [],
          rows: uniqRows.map((i) => ({ index: i, cells: b.rows[i] })),
          whole: wasOpen.includes(r) && uniqRows.length === b.rows.length
        });
        if (wasOpen.includes(r) && b.oles) for (const o of b.oles) r.embeds.push(o.rid);
      }
    }
  });
  for (const r of open.slice()) closeRegion(r, 'unterminated');
  return { regions, mentions: uniq(mentions.map((m) => JSON.stringify(m))).map((s) => JSON.parse(s)).slice(0, 40), sectionBlocks };
}

/* ------------------------------------------------- interface-level facts */

function rowMap(rows) {
  const map = {};
  for (const r of rows) {
    const k = norm(r[0]).replace(/[:\s]+$/, '').toLowerCase();
    if (!k) continue;
    const v = r.slice(1).map((c) => String(c || '').trim()).filter(Boolean).join(' | ');
    if (!(k in map)) map[k] = v;
  }
  return map;
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? norm(m[1]) : '';
}

function extractInterface(blocks, sectionBlocks) {
  const info = {
    id: '',
    name: '',
    shortDescription: '',
    title: '',
    sourceSystem: '',
    targetSystems: [],
    senderChannels: [],
    receiverChannels: [],
    icos: [],
    messageMappings: [],
    operationMappings: [],
    adapters: {},
    evidence: {}
  };

  // Cover paragraphs & document information
  const allP = blocks.filter((b) => b.type === 'p').slice(0, 60);
  for (const b of allP) {
    const t = norm(b.text);
    let m = /^Interface Name\s*:\s*(.+)$/i.exec(t);
    if (m && !info.name) {
      info.name = m[1];
      info.evidence.name = 'Cover page';
    }
    m = /^Generated Document Name\s*:\s*(.+)$/i.exec(t);
    if (m && !info.title) info.title = m[1];
  }
  const generalTables = (sectionBlocks.general || []).filter((b) => b.type === 'tbl');
  for (const t of generalTables) {
    const map = rowMap(t.rows);
    if (map['development id'] && !info.id) {
      info.id = firstMatch(map['development id'], /(I\d{6})/);
      info.evidence.id = '1. General Information';
    }
    if (map['title'] && !info.title) info.title = map['title'];
    if (map['short description'] && !info.shortDescription) {
      info.shortDescription = map['short description'].split(' | ')[0];
      info.evidence.shortDescription = '1. General Information';
    }
  }
  if (!info.id) {
    const idm = /\bI\d{6}\b/.exec(info.title || '') || /\bI\d{6}\b/.exec(blocks.slice(0, 40).map((b) => (b.type === 'p' ? b.text : '')).join(' '));
    if (idm) info.id = idm[0];
  }
  if (!info.name) info.name = info.shortDescription || info.title;

  // Source/target from "<thing> from <A> to <B>" in names
  const fromTo = /\bfrom\s+(.+?)\s+to\s+(.+)$/i.exec(info.shortDescription || info.title || info.name || '');
  if (fromTo) {
    info.sourceSystem = norm(fromTo[1].replace(/^SAP\s+/i, 'SAP '));
    info.targetSystems = uniq(fromTo[2].split(/\s+(?:and|&)\s+|,\s*/i).map(norm));
    info.evidence.sourceSystem = 'Interface title';
    info.evidence.targetSystems = 'Interface title';
  }

  // Channels & adapters (sender/receiver adapter sections)
  const adapterBlocks = []
    .concat(sectionBlocks.sender_adapter || [], sectionBlocks.receiver_adapter || [], sectionBlocks.config_scenario || [])
    .filter((b) => b.type === 'tbl');
  const allTables = Object.values(sectionBlocks).flat().filter((b) => b.type === 'tbl');
  const seenCh = new Set();
  for (const t of allTables) {
    const map = rowMap(t.rows);
    const nm = map['name'] && /^CC_/.test(map['name'].split(' | ')[0]) ? map['name'].split(' | ')[0] : null;
    if (nm && !seenCh.has(nm)) {
      seenCh.add(nm);
      const ch = parseChannel(nm);
      ch.adapterType = (map['adapter type'] || '').split(' | ')[0] || ch.adapter || '';
      ch.service = (map['service'] || '').split(' | ')[0];
      ch.description = (map['description'] || '').split(' | ')[0];
      ch.status = (map['status'] || '').split(' | ')[0];
      ch.label = t.label || '';
      (ch.direction === 'Sender' ? info.senderChannels : info.receiverChannels).push(ch);
    }
  }

  // ICOs
  for (const t of (sectionBlocks.ico || []).filter((b) => b.type === 'tbl')) {
    const map = rowMap(t.rows);
    if (!map['sender interface'] && !map['sender communication channel']) continue;
    const ico = {
      senderBusinessSystem: (map['sender business system'] || '').split(' | ')[0],
      senderInterface: (map['sender interface'] || '').split(' | ')[0],
      senderNamespace: (map['sender namespace'] || '').split(' | ')[0],
      description: (map['description'] || '').split(' | ')[0],
      senderChannel: (map['sender communication channel'] || '').split(' | ')[0],
      receiverChannels: uniq(extractNames(map['receiver communication channels'] || '').channels),
      receiverChannelText: (map['receiver communication channels'] || '').replace(/ \| /g, '; '),
      determinationType: (map['type of receiver determination'] || '').replace(/\s+/g, ' '),
      rules: [],
      operationMappings: [],
      label: t.label || ''
    };
    // receiver-determination rows: [condition, component]
    const start = t.rows.findIndex((r) => /^condition$/i.test(norm(r[0])) && /communication component/i.test(norm(r[1] || '')));
    if (start >= 0) {
      for (let i = start + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (/^receiver interfaces/i.test(norm(r[0]))) break;
        if (r.length >= 2 && norm(r[1])) ico.rules.push({ condition: String(r[0] || '').split(/\n/).map(norm).filter(Boolean), component: norm(r[1]) });
      }
    }
    const omRow = t.rows.findIndex((r) => /^condition$/i.test(norm(r[0])) && /operation mapping/i.test(norm(r[1] || '')));
    if (omRow >= 0) {
      for (let i = omRow + 1; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (/^(swcv|parameters)/i.test(norm(r[0]))) break;
        const om = extractNames(r.join(' ')).operationMappings[0];
        const si = extractNames(r.join(' ')).serviceInterfaces[0];
        if (om || si) ico.operationMappings.push({ operationMapping: om || '', interface: si || '' });
      }
    }
    info.icos.push(ico);
    if (ico.senderChannel && !info.senderChannels.find((c) => c.name === ico.senderChannel)) info.senderChannels.push(parseChannel(ico.senderChannel));
    for (const c of ico.receiverChannels) if (!info.receiverChannels.find((x) => x.name === c)) info.receiverChannels.push(parseChannel(c));
  }

  // Mappings
  for (const t of (sectionBlocks.message_mapping || []).filter((b) => b.type === 'tbl')) {
    const map = rowMap(t.rows);
    if (map['name']) {
      const tgt = t.rows.find((r) => /^target message/i.test(norm(r[0])));
      const src = t.rows.find((r) => /^source message/i.test(norm(r[0])));
      info.messageMappings.push({ name: map['name'].split(' | ')[0], source: src ? norm(src[1]) : '', target: tgt ? norm(tgt[1]) : '', label: t.label || '' });
    }
  }
  for (const t of (sectionBlocks.operation_mapping || []).filter((b) => b.type === 'tbl')) {
    const map = rowMap(t.rows);
    if (map['name']) info.operationMappings.push({ name: map['name'].split(' | ')[0], label: t.label || '' });
  }

  // Interface type (from adapters)
  const sAd = uniq(info.senderChannels.map((c) => (c.adapter || c.adapterType || '').toUpperCase()).filter(Boolean));
  const rAd = uniq(info.receiverChannels.map((c) => (c.adapter || c.adapterType || '').toUpperCase()).filter(Boolean));
  info.adapters = { sender: sAd, receiver: rAd };

  // Sender business system / source system
  const ico0 = info.icos[0];
  if (ico0 && ico0.senderBusinessSystem) info.senderBusinessSystem = ico0.senderBusinessSystem;

  return info;
}

/* ------------------------------------------------------- change content */

const FIELD_STOP = new Set(['new', 'the', 'below', 'following', 'target', 'source', 'this', 'that', 'each', 'every', 'one', 'a', 'an', 'is', 'are', 'was', 'been', 'has', 'have', 'of', 'in', 'to', 'as', 'for', 'and', 'or', 'any', 'all', 'mapped', 'added', 'updated', 'mandatory', 'optional', 'respective', 'corresponding', 'same', 'other', 'additional', 'existing', 'above', 'both', 'dummy', 'only', 'with', 'same', 'such', 'value', 'values', 'xsd', 'idoc', 'proxy']);

function detectFields(lines) {
  const source = [];
  const target = [];
  const both = [];
  let mode = null;
  for (const l of lines) {
    const t = l.text;
    if (isPathOnly(t) || /^\/[\w:]/.test(t)) {
      const leaf = t.trim().split('/').filter(Boolean).slice(-1)[0];
      const rec = { path: t.trim(), name: leaf };
      if (mode === 'target') target.push(rec);
      else if (mode === 'source') source.push(rec);
      else both.push(rec);
      continue;
    }
    if (/\bsource\b/i.test(t) && !/\btarget\b/i.test(t)) mode = 'source';
    else if (/\btarget\b/i.test(t) && !/\bsource\b/i.test(t)) mode = 'target';
    else if (/\b(and|&)\b.*\b(source|target)\b/i.test(t) && /\bsource\b/i.test(t) && /\btarget\b/i.test(t)) mode = null;
    // inline paths within a sentence
    for (const m of t.matchAll(/(?:\/(?:[\w]+:)?[A-Za-z_][\w.\-]*){3,}/g)) {
      const leaf = m[0].split('/').filter(Boolean).slice(-1)[0];
      const rec = { path: m[0], name: leaf };
      if (/\btarget\b/i.test(t) && !/\bsource\b/i.test(t)) target.push(rec);
      else if (/\bsource\b/i.test(t) && !/\btarget\b/i.test(t)) source.push(rec);
      else both.push(rec);
    }
  }
  const named = [];
  for (const l of lines) {
    const t = l.text;
    for (const m of t.matchAll(/\b(?:field|fields|element|segment|node|attribute)s?\s+["\u201C']?([A-Za-z_][A-Za-z0-9_]{2,})["\u201D']?/gi)) named.push({ name: m[1], kind: 'name', context: t });
    for (const m of t.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s+(?:field|element|segment|node)\b/gi)) named.push({ name: m[1], kind: 'name', context: t });
    for (const m of t.matchAll(/\b(Z[A-Z]{2,}[A-Z0-9_]{3,})\b/g)) named.push({ name: m[1], kind: 'segment', context: t });
  }
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = (x.path || x.name).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const namedClean = dedupe(named.filter((n) => !FIELD_STOP.has(n.name.toLowerCase()) && !/^(?:A1|H1)[A-Z]$/.test(n.name)));
  return { source: dedupe(source), target: dedupe(target), unassigned: dedupe(both), named: namedClean.slice(0, 40) };
}

/** Sentences carrying behaviour/obligation language. */
function detectStatements(lines) {
  const out = [];
  const modal = /\b(should|must|shall|will|only when|only if|only send|does not|do not|not be|ensure|expected|instead of|otherwise|if |when |optional|mandatory|skip|filter|exclude|route|routed|routing|split|default|leading zero|convert)\b/i;
  for (const l of lines) {
    const t = l.text;
    if (t.length < 25 || t.length > 600 || isPathOnly(t)) continue;
    if (/^\|/.test(t)) continue;
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const p of parts) {
      const s = norm(p);
      if (s.length >= 25 && modal.test(s)) out.push({ text: s, section: l.section, label: l.label });
    }
  }
  const seen = new Set();
  return out.filter((s) => (seen.has(s.text) ? false : seen.add(s.text))).slice(0, 25);
}

module.exports = { scopeChange, extractInterface, detectFields, detectStatements, splitMarkers };
