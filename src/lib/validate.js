'use strict';

/**
 * Pre-generation quality check (the 10 questions of the validation step).
 * Every check returns { id, name, status: pass|warn|fail, detail, evidence: [string] } so the tester can see
 * exactly what was verified and what was not. Checks are deterministic and look at the real generated content.
 */

const { BASIS } = require('./basis');
const { norm } = require('./text');

const FIELD_TYPES = ['optional_field', 'new_field', 'new_segment', 'structure_reimport', 'data_type', 'mapping_logic', 'split_filter'];
const WORSE = { pass: 0, warn: 1, fail: 2 };

function worst(list) {
  return list.reduce((a, b) => (WORSE[b] > WORSE[a] ? b : a), 'pass');
}

function idText(a) {
  return a.entry.identifiers.map((i) => `${i.type} ${i.value}`).join(', ');
}

function allText(cases) {
  return cases
    .map((c) => [c.scenario, c.objective, ...c.testData.map((t) => `${t.field} ${t.value}`), ...c.expected.map((e) => e.text), ...c.steps.map((s) => s.action)].join(' '))
    .join('\n')
    .toLowerCase();
}

/* 1 */
function checkLatestRevision(a) {
  const ev = [];
  const rv = a.revisionInfo || {};
  const status = a.revisionStatus;
  ev.push(`Selected: revision ${a.entry.number}, dated ${a.entry.date || 'n/a'} (row ${a.entry.position} of ${rv.total || '?'} in the Revision History).`);
  let st = 'pass';
  if (rv.selectedBy === 'user') {
    st = 'warn';
    ev.push('The entry was chosen or entered by the user because the Revision History was unclear or missing.');
  } else {
    ev.push('Chosen automatically by highest revision number, and cross-checked against revision dates.');
  }
  if (rv.manual) {
    st = 'warn';
    ev.push('The change was entered manually, not read from the Revision History.');
  }
  if (status === 'warning') {
    st = worst([st, 'warn']);
    ev.push('The Revision History has data-quality warnings (see below).');
  }
  for (const i of rv.issues || []) ev.push(`${i.level === 'error' ? 'Problem' : i.level === 'warn' ? 'Warning' : 'Note'}: ${i.text}`);
  if (!a.entry.description || a.entry.description.length < 5) {
    st = 'fail';
    ev.push('The revision entry has no usable change description.');
  }
  return {
    id: 1,
    name: 'Is the latest revision entry correctly identified?',
    status: st,
    detail: st === 'pass' ? `Revision ${a.entry.number} (${a.entry.date}) is the latest entry by number and date.` : `Revision ${a.entry.number} was selected but needs your attention.`,
    evidence: ev
  };
}

/* 2 */
function checkExactChange(a, cases) {
  const ev = [];
  const tx = allText(cases);
  const ids = a.entry.identifiers;
  const cited = cases.filter((c) => c.changeRef && ids.every((i) => c.changeRef.includes(i.value)));
  ev.push(`${cases.length} test case(s); ${cited.length} cite every change identifier of the revision (${idText(a) || 'none available'}).`);
  let st = cases.length ? 'pass' : 'fail';

  const anchors = [];
  const rt = a.routing;
  if (rt) for (const r of rt.receivers) anchors.push(r.component, r.receiver, ...rt.fields);
  for (const f of (a.fields.named || []).slice(0, 6)) anchors.push(f.name);
  for (const f of (a.fields.target || []).concat(a.fields.source || []).slice(0, 6)) anchors.push(f.name);
  const wanted = Array.from(new Set(anchors.filter(Boolean).map((x) => String(x).toLowerCase())));
  const hit = wanted.filter((w) => tx.includes(w));
  if (wanted.length) {
    ev.push(`Elements the change touches that appear in the test cases: ${hit.length} of ${wanted.length}${hit.length ? ` (${hit.slice(0, 6).join(', ')})` : ''}.`);
    if (!hit.length && cases.length) st = 'warn';
  }
  if (!a.scopeFound) {
    st = st === 'fail' ? st : 'warn';
    ev.push('No Start/End change markers were found, so the change is based on the Revision History text' + (a.testerChangeDetail ? ' and the tester description.' : ' only.'));
  } else {
    ev.push(`Change text found in ${a.sectionsTouched.length} TSD section(s): ${a.sectionsTouched.slice(0, 5).join('; ')}.`);
  }
  const other = (a.revisionInfo && a.revisionInfo.otherIds) || [];
  const leaked = other.filter((o) => tx.includes(String(o).toLowerCase()));
  if (leaked.length) {
    st = 'fail';
    ev.push(`Test cases mention identifiers of other revisions: ${leaked.join(', ')}.`);
  } else if (other.length) {
    ev.push(`No identifiers of other revisions appear in the test cases (${other.length} other identifier(s) checked).`);
  }
  return {
    id: 2,
    name: 'Does the TUT address that exact change?',
    status: st,
    detail: cases.length ? (st === 'pass' ? 'Test cases reference the change identifiers and the elements the change touches.' : 'Test cases exist but the link to the change is weaker than normal; see the evidence.') : 'No test case could be generated.',
    evidence: ev
  };
}

/* 3 */
function checkConsistency(a, cases) {
  const ev = [];
  let st = 'pass';
  const rt = a.routing;
  if (rt) {
    for (const rc of rt.receivers) {
      const inCfg = (a.interface.icos || []).some((ico) => (ico.rules || []).some((r) => r.component === rc.component));
      ev.push(`Receiver ${rc.component || rc.receiver}: ${inCfg ? 'found in the ICO receiver-determination of the TSD.' : 'NOT found in the ICO section of the TSD.'}`);
      if (!inCfg) st = worst([st, 'warn']);
      const rcvr = (a.interface.receiverChannels || []).some((c) => c.service === rc.component || String(c.service || '').toUpperCase().includes(String(rc.receiver || '').toUpperCase()));
      ev.push(`A receiver communication channel for ${rc.component || rc.receiver} is ${rcvr ? 'documented' : 'not documented'} in the TSD.`);
      if (!rcvr) st = worst([st, 'warn']);
    }
    if (rt.conflicts.length) {
      st = 'warn';
      for (const c of rt.conflicts) ev.push(`CONFLICT: the documented condition routes ${c.field} = ${c.value} to ${c.receiver}, but the TSD says it should ${c.stated ? '' : 'not '}be routed (${c.section}).`);
    } else if (rt.intent.length) ev.push(`${rt.intent.length} narrative statement(s) about routing agree with the documented condition.`);
  }
  const unknownChannels = [];
  const known = new Set([...(a.interface.senderChannels || []), ...(a.interface.receiverChannels || [])].map((c) => c.name));
  for (const c of a.related.names.channels || []) if (!known.has(c) && !/INTERMEDIATE/.test(c)) unknownChannels.push(c);
  if (known.size) {
    ev.push(`Channel names in the change text: ${(a.related.names.channels || []).length}; not in the interface's channel list: ${unknownChannels.length}${unknownChannels.length ? ` (${unknownChannels.slice(0, 3).join(', ')})` : ''}.`);
    if (unknownChannels.length) st = worst([st, 'warn']);
  }
  const used = new Set(cases.flatMap((c) => [c.refs && c.refs.receiverChannel, c.refs && c.refs.senderChannel]).filter(Boolean));
  for (const ch of used) {
    if (known.size && !known.has(ch)) {
      st = worst([st, 'warn']);
      ev.push(`Channel ${ch} used in a test case is not in the TSD channel list.`);
    }
  }
  if (!a.scopeFound) {
    st = worst([st, 'warn']);
    ev.push('Only the Revision History text is available, so consistency with the rest of the TSD cannot be confirmed.');
  }
  if (!ev.length) ev.push('No cross-checkable facts were found for this change type.');
  return {
    id: 3,
    name: 'Are the technical details consistent with the rest of the TSD?',
    status: st,
    detail: st === 'pass' ? 'Receivers, channels and conditions used in the test cases are present in the TSD.' : 'Some details are missing from, or contradict, other TSD sections.',
    evidence: ev
  };
}

/* 4 */
function checkFields(a) {
  const ev = [];
  const needs = a.types.some((t) => FIELD_TYPES.includes(t.type)) && !a.routing;
  const NAME = 'Are the source and target fields correctly identified?';
  if (!needs) {
    const rt = a.routing;
    if (rt) {
      ev.push(`Routing field(s): ${rt.fields.join(', ')}; values in the condition: ${Object.entries(rt.valuesByField).map(([k, v]) => `${k} = ${v.join('/')}`).join('; ')}.`);
      const paths = (a.related.names.paths || []).filter((p) => rt.fields.some((f) => p.endsWith('/' + f)));
      ev.push(paths.length ? `Source path in the TSD: ${paths[0]}` : 'The full XPath of the routing field was not found in the change text.');
      return { id: 4, name: NAME, status: paths.length ? 'pass' : 'warn', detail: paths.length ? 'The routing field and its path are identified from the TSD.' : 'The routing field is known by name but its XPath was not found.', evidence: ev };
    }
    return { id: 4, name: NAME, status: 'pass', detail: 'This change type is not field-driven.', evidence: ['No field-level change was recognised.'] };
  }
  const f = a.fields;
  const withSide = f.source.length + f.target.length;
  const names = (f.named || []).map((n) => n.name);
  ev.push(`Source-side fields: ${f.source.map((x) => x.name).join(', ') || 'none identified'}.`);
  ev.push(`Target-side fields: ${f.target.map((x) => x.name).join(', ') || 'none identified'}.`);
  if (f.unassigned.length) ev.push(`Fields found but not assigned to source or target in the TSD: ${f.unassigned.map((x) => x.name).slice(0, 6).join(', ')}.`);
  if (names.length) ev.push(`Names mentioned in the change text: ${names.slice(0, 8).join(', ')}.`);
  const desc = a.entry.description.toLowerCase();
  const inDesc = [...f.source, ...f.target, ...(f.named || [])].filter((x) => desc.includes(x.name.toLowerCase()));
  if (inDesc.length) ev.push(`Named in the Revision History itself: ${Array.from(new Set(inDesc.map((x) => x.name))).join(', ')}.`);
  let st;
  let detail;
  if (!withSide && !names.length && !f.unassigned.length) {
    st = 'fail';
    detail = 'No field or segment could be identified; the test data uses placeholders.';
  } else if (!f.source.length || !f.target.length) {
    st = 'warn';
    detail = 'Field names were found, but the source and target side is not clearly stated for all of them. Please verify.';
  } else {
    st = 'pass';
    detail = 'Source and target fields were identified from the TSD.';
  }
  const emb = (a.related.embeddedHits || []).length;
  ev.push(emb ? `${emb} matching row(s) found in embedded mapping sheets.` : 'No matching rows were found in embedded mapping sheets.');
  if (a.testerFields) {
    ev.push(`Field names supplied by the tester: ${a.testerFields.join(', ')}.`);
    if (st === 'fail') st = 'warn';
  }
  return { id: 4, name: NAME, status: st, detail, evidence: ev };
}

/* 5 */
function checkRelevance(a, cases, tutType) {
  const ev = [];
  let st = cases.length ? 'pass' : 'fail';
  ev.push(`${cases.length} ${tutType} test case(s).`);
  const generic = cases.filter((c) => /Unit Test Plan|Tester-defined|tester-described/i.test(c.objective + c.scenario + c.expected.map((e) => e.ref).join(' ')));
  if (generic.length) ev.push(`${generic.length} case(s) come from the TSD Unit Test Plan or tester input rather than from the change analysis itself.`);
  if (tutType === 'positive') {
    const noDeliver = cases.filter((c) => !c.steps.some((s) => /deliver|status/i.test(s.action + s.expected)) && !/non-routing/i.test(c.scenario));
    if (noDeliver.length) {
      st = worst([st, 'warn']);
      ev.push(`${noDeliver.length} positive case(s) have no delivery/status verification step.`);
    }
    const nonRouting = cases.filter((c) => /non-routing/i.test(c.scenario));
    if (nonRouting.length) ev.push(`${nonRouting.length} positive case(s) check intended non-routing, which the TSD states as part of the change (not a failure).`);
  } else {
    const noNeg = cases.filter((c) => !c.expected.length || c.expected.every((e) => /delivered successfully/i.test(e.text)));
    if (noNeg.length) {
      st = worst([st, 'warn']);
      ev.push(`${noNeg.length} negative case(s) expect only successful delivery: ${noNeg.map((c) => c.id).join(', ')}.`);
    }
    const kinds = cases.map((c) => (c.expected.some((e) => /routing outcome|NOT routed/i.test(e.text)) ? 'business/routing outcome' : c.expected.some((e) => /error|fail|reject/i.test(e.text)) ? 'error / failure' : 'unspecified'));
    ev.push(`Expected outcome type per case: ${kinds.map((k, i) => `${cases[i].id} = ${k}`).join('; ')}.`);
    if (kinds.includes('unspecified')) st = worst([st, 'warn']);
  }
  return {
    id: 5,
    name: 'Are the test scenarios relevant to the selected TUT type?',
    status: st,
    detail: st === 'pass' ? `Every case suits a ${tutType} TUT and is built from this change.` : `Some cases need a closer look for a ${tutType} TUT.`,
    evidence: ev
  };
}

/* 6 */
function checkJustified(cases) {
  const ev = [];
  const exps = cases.flatMap((c) => c.expected.map((e) => Object.assign({ id: c.id }, e)));
  const count = (b) => exps.filter((e) => e.basis === b).length;
  const tsd = count(BASIS.TSD);
  const der = count(BASIS.DERIVED);
  const tst = count(BASIS.TESTER);
  const conf = count(BASIS.CONFIRM);
  ev.push(`${exps.length} expected result(s): ${tsd} stated in the TSD, ${der} derived from TSD conditions, ${tst} from tester input, ${conf} need confirmation.`);
  const noRef = exps.filter((e) => e.basis !== BASIS.TESTER && e.basis !== BASIS.CONFIRM && !e.ref);
  if (noRef.length) ev.push(`${noRef.length} expected result(s) have no TSD reference.`);
  for (const e of exps.filter((x) => x.basis === BASIS.CONFIRM).slice(0, 6)) ev.push(`Needs confirmation (${e.id}): ${norm(e.text).slice(0, 160)}`);
  let st = 'pass';
  if (!exps.length) st = 'fail';
  else if (conf || noRef.length) st = 'warn';
  const allOpen = exps.length > 0 && tsd + der === 0 && tst === 0;
  if (allOpen) ev.push('The TSD does not state the expected outcome for this scenario. Nothing was invented; confirm each result with the TSD author before execution.');
  return {
    id: 6,
    name: 'Are expected results technically justified?',
    status: st,
    detail: `${tsd + der} of ${exps.length} expected result(s) are tied to the TSD; ${conf} need confirmation; ${tst} come from the tester.${allOpen ? ' No outcome is stated in the TSD, so every result is flagged rather than invented.' : ''}`,
    evidence: ev
  };
}

/* 7 */
function checkAssumptions(cases, flags, inputs) {
  const ev = [];
  const errs = flags.filter((f) => f.severity === 'error');
  const warns = flags.filter((f) => f.severity === 'warn');
  ev.push(`${errs.length} item(s) that must be confirmed, ${warns.length} to review, ${flags.length - errs.length - warns.length} note(s).`);
  for (const f of errs.concat(warns).slice(0, 8)) ev.push(`${f.severity === 'error' ? 'Must confirm' : 'Review'} \u2013 ${f.section || 'General'}: ${norm(f.text).slice(0, 170)}`);
  const ph = cases.reduce((n, c) => n + c.testData.filter((t) => /^</.test(t.value)).length, 0);
  if (ph) ev.push(`${ph} test-data value(s) are placeholders the tester must fill in (marked "Tester input").`);
  const unmarked = cases.flatMap((c) => c.testData.filter((t) => /^</.test(t.value) && t.source === BASIS.TSD));
  let st = errs.length || warns.length ? 'warn' : 'pass';
  if (unmarked.length) {
    st = 'fail';
    ev.push(`${unmarked.length} placeholder value(s) are wrongly labelled as coming from the TSD.`);
  }
  if (errs.length) ev.push('Must-confirm items are open; they are listed in the document appendix. Execution should wait for the answers.');
  if (inputs && inputs.assumptions) ev.push('The tester\u2019s own assumptions are printed in the document and labelled as tester input.');
  return {
    id: 7,
    name: 'Have unsupported assumptions been avoided?',
    status: st,
    detail: errs.length || warns.length ? `${errs.length + warns.length} item(s) cannot be supported by the TSD and are flagged instead of being invented.` : 'No unsupported assumption was needed.',
    evidence: ev
  };
}

/* 8 */
function checkSteps(a, cases) {
  const ev = [];
  const miss = [];
  const need = (c, label, ok) => {
    if (!ok) miss.push(`${c.id}: ${label}`);
  };
  const adapters = ((a.interface.adapters && a.interface.adapters.sender) || []).join(' ').toUpperCase();
  const routing = !!a.routing;
  for (const c of cases) {
    const t = c.steps.map((s) => s.action).join('\n').toLowerCase();
    need(c, 'trigger of the source message', /trigger|send|place/.test(t));
    need(c, 'message received in SAP PO / message monitoring', /message monitoring|received in sap po/.test(t));
    if (routing) need(c, 'receiver determination check', /receiver determination/.test(t));
    if (!routing && /mapping/i.test(c.scenario + c.objective)) need(c, 'before/after-mapping payload', /mapping payload|after-mapping/.test(t));
    need(c, 'delivery or no-delivery / error status check', /delivery|delivered|status|error/.test(t));
    need(c, 'evidence text on every step', c.steps.every((s) => s.evidence));
    need(c, 'actual result and status left blank', c.actual === '' && c.status === '');
    if (/IDOC/.test(adapters)) need(c, 'IDoc number / IDoc monitoring evidence', /idoc/.test(c.steps.map((s) => s.evidence + s.action).join(' ').toLowerCase()));
  }
  ev.push(`Checked ${cases.length} case(s) for: source trigger, SAP PO message monitoring, ${routing ? 'receiver determination, ' : ''}payload evidence, delivery/status, evidence per step, blank actual result/status${/IDOC/.test(adapters) ? ', IDoc evidence' : ''}.`);
  const req = ['id', 'scenario', 'objective', 'testData', 'steps', 'expected'];
  const incomplete = cases.filter((c) => req.some((f) => !c[f] || (Array.isArray(c[f]) && !c[f].length)));
  for (const c of incomplete) miss.push(`${c.id || 'case'}: a required test-case field is empty`);
  ev.push('Each case has: ID, scenario, objective, preconditions, test data, steps, expected results, actual result (blank), status (blank), remarks.');
  for (const m of miss.slice(0, 8)) ev.push(`Missing \u2013 ${m}`);
  const st = !cases.length ? 'fail' : miss.length ? 'fail' : 'pass';
  return {
    id: 8,
    name: 'Are all required testing steps included?',
    status: st,
    detail: st === 'pass' ? 'Every case has all the SAP PO verification steps that are relevant to this interface and change.' : `${miss.length} required step(s) or field(s) are missing.`,
    evidence: ev
  };
}

/* 9 */
function checkFormat(docStats) {
  const NAME = 'Is the document professionally formatted?';
  if (!docStats) {
    return { id: 9, name: NAME, status: 'warn', detail: 'The Word document has not been built yet; it is checked when you approve the preview.', evidence: ['Structural checks run on the generated .docx.'] };
  }
  const ev = [];
  let st = 'pass';
  const add = (ok, good, bad) => {
    ev.push(ok ? good : bad);
    if (!ok) st = 'fail';
  };
  add(docStats.hasHeader, 'Header present.', 'Header is missing.');
  add(docStats.hasFooter && docStats.hasPageField, 'Footer with page number field present.', 'Footer or page number is missing.');
  add(docStats.tables > 0, `${docStats.tables} table(s).`, 'No tables.');
  add(docStats.rowsCantSplit === docStats.rows, `All ${docStats.rows} table rows are set not to split across pages.`, `${docStats.rows - docStats.rowsCantSplit} of ${docStats.rows} rows can split across pages.`);
  add(docStats.headerRows > 0, `${docStats.headerRows} repeating table header row(s).`, 'Tables have no repeating header rows.');
  add(docStats.fonts.length <= 2, `Fonts used: ${docStats.fonts.join(', ')}.`, `Too many fonts: ${docStats.fonts.join(', ')}.`);
  add(docStats.headings >= 8, `${docStats.headings} headings.`, 'Too few headings.');
  add(docStats.emptyRuns === 0, 'No consecutive empty paragraphs outside table spacing (no blank pages caused by spacing).', `${docStats.emptyRuns} run(s) of consecutive empty paragraphs may create blank pages.`);
  add(docStats.emptyBeforeBreak === 0, 'No empty paragraph directly before a forced page break.', `${docStats.emptyBeforeBreak} empty paragraph(s) before a page break may create a blank page.`);
  ev.push(`${docStats.pageBreaks} forced page break(s) (one per extra test case plus the appendix and summary).`);
  return {
    id: 9,
    name: NAME,
    status: st,
    detail: st === 'pass' ? 'The generated Word file has headers, footers with page numbers, repeating table headers and non-splitting rows.' : 'The generated Word file has formatting problems; see the evidence.',
    evidence: ev
  };
}

/* 10 */
function checkTraceability(a, cases) {
  const ev = [];
  let st = 'pass';
  const secs = new Set(cases.flatMap((c) => c.expected.map((e) => e.ref)).filter(Boolean));
  ev.push(`Expected results cite ${secs.size} distinct TSD location(s): ${Array.from(secs).slice(0, 5).join('; ') || 'none'}.`);
  const kept = cases.every((c) => !c.changeRef || a.entry.identifiers.every((i) => c.changeRef.includes(i.value)));
  ev.push(kept ? 'The change description is printed verbatim from the Revision History in the Change Reference and the change block.' : 'Some test cases do not carry all change identifiers.');
  if (!kept) st = 'warn';
  if (!a.entry.description) st = 'fail';
  const terms = Array.from(
    new Set(
      [...(a.interface.senderChannels || []), ...(a.interface.receiverChannels || [])]
        .map((c) => c.name)
        .concat(a.related.names.channels || [], a.related.names.operationMappings || [], a.related.names.messageMappings || [])
        .filter(Boolean)
    )
  );
  const used = cases.map((c) => JSON.stringify(c)).join(' ');
  const preserved = terms.filter((t) => used.includes(t));
  const upper = used.toUpperCase();
  const altered = terms.filter((t) => !used.includes(t) && upper.includes(t.toUpperCase()));
  if (terms.length) ev.push(`Technical names used in the test cases exactly as written in the TSD: ${preserved.length}; of ${terms.length} channel/mapping names known for this interface. Names are not renamed.`);
  else ev.push('No channel or mapping names were available to compare.');
  if (altered.length) {
    st = 'warn';
    ev.push(`Names whose spelling or case differs from the TSD: ${altered.join(', ')}.`);
  }
  return {
    id: 10,
    name: 'Is every statement traceable to the TSD, with the original wording preserved?',
    status: st,
    detail: st === 'pass' ? 'Technical names and the change description are carried over unchanged, and expected results cite their TSD location.' : 'Traceability gaps were found; see the evidence.',
    evidence: ev
  };
}

function runChecks({ a, cases, flags, tutType, inputs, docStats }) {
  return [
    checkLatestRevision(a),
    checkExactChange(a, cases),
    checkConsistency(a, cases),
    checkFields(a),
    checkRelevance(a, cases, tutType),
    checkJustified(cases),
    checkAssumptions(cases, flags, inputs),
    checkSteps(a, cases),
    checkFormat(docStats),
    checkTraceability(a, cases)
  ];
}

/** Overall verdict used by the UI and the download gate. */
function summarize(checks) {
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const pass = checks.filter((c) => c.status === 'pass').length;
  return {
    pass,
    warn,
    fail,
    total: checks.length,
    ready: fail === 0,
    verdict: fail ? 'Not ready \u2013 fix the failed checks' : warn ? 'Ready after review \u2013 resolve the items marked Review' : 'Ready'
  };
}

module.exports = { runChecks, checkFormat, summarize };
