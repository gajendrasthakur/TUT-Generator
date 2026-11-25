'use strict';

const { norm, uniq, truncate } = require('./text');
const { parseRevisionHistory, parseRevisionHistoryFromLines, analyseRevisions } = require('./revision');
const { matchTokens, flattenIds, extractIdentifiers } = require('./identifiers');
const { scopeChange, extractInterface, detectFields, detectStatements } = require('./scope');
const { extractConditionGroups, evalAst, groupToString, extractNames, parseChannel, conditionTokens, parseCondition } = require('./components');

/* ----------------------------------------------------------- classifier */

const TYPE_RULES = [
  {
    type: 'revert',
    label: 'Reversal / removal of an earlier change',
    re: /\b(have been removed|has been removed|reverted|revert(?:ed)?|rolled back|removed against)\b/i
  },
  {
    type: 'no_po_change',
    label: 'No PI/PO build change (documentation / test only)',
    re: /\b(no new change in po|no change in po|only tut|tut only|only the tut|documentation only|admin change)\b/i
  },
  {
    type: 'routing',
    label: 'Routing / receiver determination condition',
    re: /\b(routing|receiver determination|receiver routing|routing condition|extended receiver|route[ds]? (?:to|only)|receiver condition)\b/i
  },
  {
    type: 'new_receiver',
    label: 'New receiver / interface extended to another system',
    re: /\b(new receiver|addition of (?:a )?new receiver|additional (?:target|receiver)|extended? (?:this |the existing |existing )?interface to|extend(?:ed|ing)? (?:the )?(?:existing )?interface|added (?:a )?second ico)\b/i
  },
  {
    type: 'optional_field',
    label: 'Field made optional / mandatory',
    re: /\b(made optional|optional in|becomes optional|made mandatory|minoccurs|mandatory to optional)\b/i
  },
  {
    type: 'new_segment',
    label: 'New IDoc segment / structure node',
    re: /\b(new segment|segment[^.]{0,40}\b(?:added|addition)|addition of (?:a )?new segment|additional segments?)\b/i
  },
  {
    type: 'structure_reimport',
    label: 'Structure re-import / structural change',
    re: /\b(re-?import|structure re-?import|structural changes?|structure change)\b/i
  },
  {
    type: 'new_field',
    label: 'New or modified field',
    re: /\b(new fields?|additional fields?|fields? (?:is|are|has been|have been)? ?added|addition of (?:new )?fields?|added (?:a )?new fields?|new field)\b/i
  },
  {
    type: 'data_type',
    label: 'Data type / length / format change',
    re: /\b(data ?type|length of|changed from [^.]{0,30} to|type of the (?:source )?field|format fix|field length|from \d+ to \d+ characters)\b/i
  },
  {
    type: 'split_filter',
    label: 'Message split / filter / skip condition',
    re: /\b(splitting|split the message|filter(?:ed|ing)?|exclude|skip (?:records|items)|skip(?:ped)? when)\b/i
  },
  {
    type: 'mapping_logic',
    label: 'Mapping logic change',
    re: /\b(mapping (?:change|changes|update|updates|fix|logic)|mapping (?:is|was|has been) (?:updated|changed|fixed)|updated? (?:the )?(?:mapping|logic)|logic (?:change|update)|conversion|leading zero|concatenat|default value)\b/i
  },
  {
    type: 'configuration',
    label: 'Configuration / channel / archiving / parameter change',
    re: /\b(parameter|channel|archiv|queue|jms|certificate|authentication|oauth|adapter|namespace)\b/i
  }
];

function classify(text) {
  const hits = [];
  for (const r of TYPE_RULES) if (r.re.test(text)) hits.push({ type: r.type, label: r.label });
  return hits;
}

/* ---------------------------------------------------------- helpers */

function sectionLabelOf(section) {
  return section || '';
}

function regionText(regions) {
  const lines = [];
  for (const r of regions) for (const l of r.lines) lines.push(l);
  return lines;
}

function lookupEmbedded(doc, regions, wanted) {
  // Search embedded Excel mapping sheets referenced in the change regions for rows that mention the given names.
  const out = [];
  const rids = uniq(regions.flatMap((r) => r.embeds));
  const names = uniq(wanted.map((w) => w.toLowerCase())).filter((n) => n.length >= 3);
  for (const rid of rids) {
    const e = doc.embeds[rid];
    if (!e) continue;
    if (e.kind === 'xlsx') {
      for (const sh of e.sheets) {
        for (const row of sh.rows) {
          const joined = row.join(' | ');
          const low = joined.toLowerCase();
          if (names.some((n) => low.includes(n))) out.push({ source: `${e.name} / ${sh.name}`, text: truncate(joined, 400) });
        }
      }
    } else if (e.kind === 'docx') {
      for (const ln of e.lines) if (names.some((n) => ln.toLowerCase().includes(n))) out.push({ source: e.name, text: truncate(ln, 400) });
    }
  }
  return out.slice(0, 30);
}

function embeddedSummary(doc, regions) {
  const rids = uniq(regions.flatMap((r) => r.embeds));
  const items = [];
  for (const rid of rids) {
    const e = doc.embeds[rid];
    if (!e) continue;
    if (e.kind === 'xlsx') items.push({ name: e.name, kind: 'Excel mapping workbook', detail: e.sheets.map((s) => s.name).join(', ') });
    else if (e.kind === 'docx') items.push({ name: e.name, kind: 'Embedded Word document', detail: truncate((e.lines || []).slice(0, 4).join(' / '), 200) });
    else items.push({ name: e.name, kind: 'Embedded object (content not readable)', detail: '' });
  }
  return items;
}

/* ------------------------------------------------------- main analysis */

function buildRevisionView(rev) {
  return {
    status: rev.status,
    dominantDateFormat: rev.dominantDateFormat,
    issues: rev.issues,
    entries: rev.entries.map((e) => ({
      position: e.position,
      number: e.numberRaw,
      date: e.dateRaw,
      isoDate: e.date,
      project: e.project,
      summary: e.summary,
      revisedBy: e.revisedBy,
      dateIssue: e.dateIssue
    })),
    candidates: rev.candidates.map((c) => c.position),
    latestPosition: rev.latest ? rev.latest.position : null
  };
}

/**
 * Builds the analysis of one document for one chosen revision entry.
 * `doc` is the reader output; `rev` is the revision analysis; `entry` is the chosen revision entry.
 */
function analyseChange(doc, rev, entry) {
  const tokens = matchTokens(entry.ids);
  const scope = scopeChange(doc.blocks, doc.embeds, tokens);
  const ifc = extractInterface(doc.blocks, scope.sectionBlocks);

  const regions = scope.regions;
  const lines = regionText(regions);
  const summaryLines = entry.summary.split('\n').map((s) => ({ text: norm(s), section: 'revision', label: 'Revision History' }));
  const allLines = summaryLines.concat(lines);
  const fieldInfo = detectFields(allLines);
  const statements = detectStatements(lines);

  // Classification from revision summary + region narrative (not tables).
  const narrative = [entry.summary].concat(regions.flatMap((r) => r.lines.filter((l) => l.section !== 'utp').map((l) => l.text))).join('\n');
  const summaryTypes = classify(entry.summary);
  const regionTypes = classify(narrative);
  let types = summaryTypes.length ? summaryTypes : regionTypes;
  // Routing is only reliable when conditions are really present.
  const condGroups = extractConditionGroups(lines.filter((l) => l.section !== 'utp').map((l) => l.text));
  if (condGroups.length && !types.some((t) => t.type === 'routing')) types = types.concat([{ type: 'routing', label: 'Routing / receiver determination condition' }]);
  if (!types.length) types = [{ type: 'unclassified', label: 'Change type not recognised from the TSD text' }];
  // prefer specific over generic
  const order = ['revert', 'no_po_change', 'routing', 'new_receiver', 'optional_field', 'new_segment', 'structure_reimport', 'new_field', 'data_type', 'split_filter', 'mapping_logic', 'configuration', 'unclassified'];
  types.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  if (types.length > 1 && types.some((t) => t.type === 'mapping_logic' || t.type === 'new_field') && types.some((t) => t.type === 'configuration')) {
    types = types.filter((t) => t.type !== 'configuration');
  }

  // Condition groups -> literal evaluation + stated intent.
  const routing = buildRouting(condGroups, statements, ifc);

  // Related table rows from the TSD itself (excluding the TSD's own UTP rows, reported separately).
  const regionTables = [];
  for (const r of regions) {
    for (const t of r.tables) {
      if (t.section === 'utp') continue;
      regionTables.push({ section: t.label, region: r.tag, header: t.header.map(norm), rows: t.rows.slice(0, 25).map((x) => x.cells.map((c) => truncate(norm(c), 220))), whole: t.whole });
    }
  }
  const tsdUtp = [];
  for (const r of regions) {
    for (const t of r.tables) {
      if (t.section !== 'utp') continue;
      for (const row of t.rows) {
        const cells = row.cells.map((c) => norm(c));
        if (cells.length >= 5 && !/^test condition/i.test(cells[0])) tsdUtp.push({ condition: cells[0], step: cells[1], description: cells[2], testData: cells[3], expected: cells[4], actual: cells[5] || '', executed: cells[6] || '' });
      }
    }
  }

  const sectionsTouched = uniq(regions.map((r) => r.startLabel));
  const regionSections = regions.map((r) => ({
    tag: r.tag,
    section: r.startLabel,
    closed: r.closed,
    lines: r.lines.filter((l) => l.section !== 'utp' && l.kind !== 'cell').map((l) => l.text).slice(0, 40),
    tableCount: r.tables.filter((t) => t.section !== 'utp').length
  }));

  const namedForLookup = fieldInfo.source.concat(fieldInfo.target).map((f) => f.name).concat(fieldInfo.named.map((n) => n.name));
  const embeddedHits = lookupEmbedded(doc, regions, namedForLookup);

  const related = {
    names: extractNames(lines.map((l) => l.text).join('\n')),
    embeddedObjects: embeddedSummary(doc, regions),
    embeddedHits
  };

  return {
    entry: {
      number: entry.numberRaw,
      date: entry.dateRaw,
      isoDate: entry.date,
      project: entry.project,
      description: entry.summary,
      revisedBy: entry.revisedBy,
      position: entry.position,
      identifiers: flattenIds(entry.ids)
    },
    markerTokens: tokens,
    interface: ifc,
    types,
    regions: regionSections,
    sectionsTouched,
    regionTables,
    fields: fieldInfo,
    statements,
    routing,
    related,
    tsdUtp,
    mentions: scope.mentions,
    scopeFound: regions.length > 0,
    revisionStatus: rev.status,
    revisionInfo: {
      total: rev.entries.length,
      issues: (rev.issues || []).map((i) => ({ level: i.level, text: i.text })),
      selectedBy: rev.latest && rev.latest === entry ? 'auto' : 'user',
      manual: !rev.entries.includes(entry) || (rev.entries.length === 1 && rev.entries[0] === entry && !rev.entries[0].numberRaw && !rev.entries[0].dateRaw),
      otherIds: uniq(
        rev.entries
          .filter((e) => e !== entry)
          .flatMap((e) => flattenIds(e.ids || {}))
          .map((i) => i.value)
          .filter((v) => !flattenIds(entry.ids || {}).some((x) => x.value === v))
      )
    },
    docFormat: doc.format
  };
}

/* --------------------------------------------------------------- routing */

function receiverFromRules(ifc, label) {
  if (!label) return null;
  const up = label.toUpperCase().replace(/^TPBS_/, '');
  for (const ico of ifc.icos || []) {
    for (const r of ico.rules || []) {
      const c = r.component.toUpperCase();
      if (c === label.toUpperCase() || c.includes(up)) return r.component;
    }
  }
  return null;
}

function leafOf(path) {
  return path.split('/').filter(Boolean).slice(-1)[0];
}

/**
 * Builds a routing model from the condition groups found in the change scope.
 * Every group is evaluated literally against every combination of the values named in the TSD, so the
 * tester gets an expected routing outcome that follows the documented condition (not an assumption).
 */
function buildRouting(groups, statements, ifc) {
  if (!groups.length) return null;
  const withReceiver = groups.map((g) => ({ ...g, receiverKey: g.receiver || g.service || null }));
  // Merge groups that state the same condition (the TSD repeats it in 2.1, 2.3 and 5.3.6); prefer the named receiver.
  const mergeByText = (arr) => {
    const out = [];
    for (const g of arr) {
      const txt = groupToString(g);
      const same = out.find((o) => groupToString(o) === txt);
      if (!same) out.push(g);
      else if (!same.receiverKey && g.receiverKey) same.receiverKey = g.receiverKey;
      else if (same.receiverKey && g.receiverKey && same.receiverKey !== g.receiverKey) (same.aliases = same.aliases || []).push(g.receiverKey);
    }
    return out;
  };
  const afterGroups = mergeByText(withReceiver.filter((g) => g.kind === 'after' || g.kind === 'current'));
  const beforeGroups = mergeByText(withReceiver.filter((g) => g.kind === 'before'));
  if (!afterGroups.length) return null;

  // Field(s) used by the conditions
  const fields = uniq(withReceiver.flatMap((g) => g.terms.map((t) => leafOf(t.path))));
  const valuesByField = {};
  for (const f of fields) {
    valuesByField[f] = uniq(withReceiver.flatMap((g) => g.terms.filter((t) => leafOf(t.path) === f).map((t) => t.value)));
  }
  // Candidate payloads: every listed value per field, plus "other"; cartesian product capped.
  let payloads = [{}];
  for (const f of fields) {
    const vals = valuesByField[f].concat(['<OTHER VALUE>']);
    const next = [];
    for (const p of payloads) for (const v of vals) next.push({ ...p, [f]: v });
    payloads = next;
    if (payloads.length > 400) {
      payloads = payloads.slice(0, 400);
      break;
    }
  }
  // When several fields are involved the full product is large; keep scenarios where each field is listed once.
  const evalRows = (g) => payloads.map((p) => ({ payload: p, routed: evalAst(g.ast, p) }));

  const receivers = [];
  const seen = new Set();
  for (const g of afterGroups) {
    const key = (g.receiverKey || 'UNKNOWN').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const before = beforeGroups.find((b) => (b.receiverKey || '').toUpperCase() === key) || (afterGroups.length === 1 ? beforeGroups[beforeGroups.length - 1] : null) || null;
    receivers.push({
      receiver: g.receiverKey,
      component: receiverFromRules(ifc, g.receiverKey) || (g.service || null),
      before: before ? { text: groupToString(before), eval: evalRows(before) } : null,
      after: { text: groupToString(g), eval: evalRows(g) }
    });
  }

  // Stated intent in the TSD narrative (to be cross-checked against the literal condition)
  const intent = [];
  const reA = /\b(?:for|to|with)\s+([A-Z][A-Z0-9_]+)\b[^.]*?\b(?:does not|do not|should not|must not|shall not|not)\s+(?:get\s+|be\s+)*(?:routed|sent|delivered)\s+to\s+([A-Z][A-Z0-9_]+)/i;
  const reB = /\bonly\s+(?:send|route)[^.]*?\bto\s+([A-Z][A-Z0-9_]+)\s+(?:only\s+)?when\s+([A-Za-z_]+)\s*=\s*([A-Z0-9_]+)/i;
  const reC = /\bwhen\s+(?:the\s+)?(?:inventory snapshot\s+)?is\s+triggered\s+for\s+([A-Z][A-Z0-9_]+)\b[^.]*?\bnot\s+(?:get\s+)?routed\s+to\s+([A-Z][A-Z0-9_]+)/i;
  for (const s of statements) {
    let m = reC.exec(s.text) || reA.exec(s.text);
    if (m) intent.push({ value: m[1].toUpperCase(), receiver: m[2].toUpperCase(), routed: false, text: s.text, section: s.label });
    m = reB.exec(s.text);
    if (m) intent.push({ value: m[3].toUpperCase(), receiver: m[1].toUpperCase(), routed: true, text: s.text, section: s.label, field: m[2] });
  }

  // Cross-check: literal evaluation vs stated intent
  const conflicts = [];
  for (const it of intent) {
    const rc = receivers.find((r) => (r.receiver || '').toUpperCase() === it.receiver || (r.component || '').toUpperCase().includes(it.receiver));
    if (!rc) continue;
    const f = fields.find((x) => (valuesByField[x] || []).some((v) => v.toUpperCase() === it.value));
    if (!f) continue;
    const row = rc.after.eval.find((e) => String(e.payload[f]).toUpperCase() === it.value && fields.every((o) => o === f || String(e.payload[o]) === '<OTHER VALUE>'));
    if (row && row.routed !== it.routed) conflicts.push({ value: it.value, field: f, receiver: it.receiver, literal: row.routed, stated: it.routed, text: it.text, section: it.section });
  }

  return {
    fields,
    valuesByField,
    receivers,
    intent,
    conflicts,
    otherRules: otherRoutingRules(ifc, fields)
  };
}

function otherRoutingRules(ifc, fields) {
  const out = [];
  for (const ico of ifc.icos || []) {
    for (const r of ico.rules || []) {
      const cond = r.condition.filter((c) => !/^(start|end) of/i.test(c)).join(' ');
      const terms = conditionTokens(cond).filter((t) => t.t === 'term');
      if (terms.length && terms.every((t) => fields.includes(leafOf(t.path)))) {
        out.push({ condition: groupToString({ ast: parseCondition(conditionTokens(cond)) }), component: r.component });
      }
    }
  }
  return out;
}

module.exports = { analyseChange, buildRevisionView, classify, TYPE_RULES, parseRevisionHistory, parseRevisionHistoryFromLines, analyseRevisions, extractIdentifiers };
