'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  HeadingLevel,
  VerticalAlign,
  TableLayoutType,
  HeightRule,
  LevelFormat
} = require('docx');
const { BASIS } = require('./generator');

/* Layout constants (A4 portrait, 2 cm side margins) */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
const CONTENT_W = PAGE_W - 2 * MARGIN; // 9638 DXA

const FONT = 'Calibri';
const MONO = 'Consolas';
const C = {
  navy: '1F3A5F',
  blue: '0A6ED1',
  border: 'BFC5CD',
  label: 'EEF2F7',
  white: 'FFFFFF',
  muted: '5B6770',
  tsd: 'E6F4EA',
  derived: 'E8F0FE',
  tester: 'F1F3F4',
  confirm: 'FFF4CE',
  err: 'FDE7E9'
};

/* ---------------------------------------------------------------- helpers */

/** Remove characters that are illegal in XML 1.0 and clamp length. */
function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  if (max && t.length > max) t = t.slice(0, max - 1) + '\u2026';
  return t;
}

function run(text, o = {}) {
  return new TextRun({
    text: clean(text),
    bold: o.bold,
    italics: o.italics,
    color: o.color,
    size: o.size,
    font: o.font
  });
}

function para(text, o = {}) {
  const lines = clean(text).split(/\r?\n/);
  const children = [];
  lines.forEach((ln, i) => {
    children.push(
      new TextRun({
        text: ln,
        bold: o.bold,
        italics: o.italics,
        color: o.color,
        size: o.size,
        font: o.font,
        break: i > 0 ? 1 : undefined
      })
    );
  });
  return new Paragraph({
    children,
    alignment: o.align,
    keepNext: o.keepNext,
    keepLines: o.keepLines,
    spacing: { before: o.before || 0, after: o.after == null ? 60 : o.after },
    pageBreakBefore: o.pageBreakBefore,
    heading: o.heading,
    numbering: o.bullet ? { reference: 'bullets', level: 0 } : undefined
  });
}

function mixed(parts, o = {}) {
  return new Paragraph({
    children: parts.map((p) => run(p.text, p)),
    keepNext: o.keepNext,
    spacing: { before: o.before || 0, after: o.after == null ? 60 : o.after }
  });
}

function h1(text, o = {}) {
  return para(text, { heading: HeadingLevel.HEADING_1, keepNext: true, before: 240, after: 100, pageBreakBefore: o.pageBreakBefore });
}
function h2(text, o = {}) {
  return para(text, { heading: HeadingLevel.HEADING_2, keepNext: true, before: 160, after: 80, pageBreakBefore: o.pageBreakBefore });
}
function h3(text) {
  return para(text, { heading: HeadingLevel.HEADING_3, keepNext: true, before: 120, after: 60 });
}

const THIN = { style: BorderStyle.SINGLE, size: 4, color: C.border };
const CELL_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN };

function cell(content, width, o = {}) {
  const kids = Array.isArray(content) ? content : [typeof content === 'string' ? para(content, { after: 0, size: o.size, bold: o.bold, color: o.color, keepNext: o.keepNext, font: o.font }) : content];
  return new TableCell({
    children: kids.length ? kids : [para('', { after: 0 })],
    width: { size: width, type: WidthType.DXA },
    columnSpan: o.span,
    verticalAlign: o.valign || VerticalAlign.TOP,
    shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    borders: CELL_BORDERS
  });
}

function row(cells, o = {}) {
  return new TableRow({
    children: cells,
    cantSplit: o.cantSplit !== false,
    tableHeader: o.header,
    height: o.minHeight ? { value: o.minHeight, rule: HeightRule.ATLEAST } : undefined
  });
}

function table(widths, rows) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows
  });
}

function spacer(after = 120) {
  return new Paragraph({ children: [], spacing: { before: 0, after } });
}

/** Two-column label/value table. */
function kv(rows, labelW = 2700) {
  const valW = CONTENT_W - labelW;
  return table(
    [labelW, valW],
    rows.map(([k, v, fill]) =>
      row([cell(k, labelW, { fill: C.label, bold: true, color: C.navy }), cell(Array.isArray(v) ? v : String(v == null || v === '' ? 'Not stated in the TSD' : v), valW, { fill })])
    )
  );
}

/** Header-row grid. `cols` = [{title, width}] ; rows = array of arrays (string | {text, fill, bold}) */
function grid(cols, rows, o = {}) {
  const widths = cols.map((c) => c.width);
  const head = row(
    cols.map((c) => cell(c.title, c.width, { fill: C.navy, bold: true, color: C.white, size: 19 })),
    { header: true }
  );
  const body = rows.map((r) =>
    row(
      r.map((v, i) => {
        if (v && typeof v === 'object' && !Array.isArray(v) && v.text !== undefined) return cell(v.text, widths[i], { fill: v.fill, bold: v.bold, size: 19, font: v.font });
        if (Array.isArray(v)) return cell(v, widths[i], { size: 19 });
        return cell(v == null ? '' : String(v), widths[i], { size: 19 });
      }),
      { minHeight: o.minHeight }
    )
  );
  return table(widths, [head].concat(body));
}

function bullets(list) {
  return list.map((t) => para(t, { bullet: true, after: 40 }));
}

function noteBox(text, fill) {
  return table([CONTENT_W], [row([cell(text, CONTENT_W, { fill: fill || C.confirm, size: 19 })])]);
}

function codeBox(text) {
  const lines = clean(text, 20000).split(/\r?\n/);
  const kids = lines.map((ln) => new Paragraph({ children: [new TextRun({ text: ln, font: MONO, size: 17 })], spacing: { before: 0, after: 0 } }));
  return table([CONTENT_W], [row([cell(kids, CONTENT_W, { fill: 'F6F8FA' })], { cantSplit: false })]);
}

function evidenceBox(label, hint, minHeight) {
  return table(
    [CONTENT_W],
    [
      row([cell([para(label + (hint ? ` \u2013 ${hint}` : ''), { bold: true, size: 18, color: C.navy, after: 0, keepNext: true })], CONTENT_W, { fill: C.label })]),
      row([cell([para('', { after: 0 })], CONTENT_W)], { minHeight: minHeight || 2600 })
    ]
  );
}

function basisFill(b) {
  switch (b) {
    case BASIS.TSD:
      return C.tsd;
    case BASIS.DERIVED:
      return C.derived;
    case BASIS.TESTER:
      return C.tester;
    default:
      return C.confirm;
  }
}

function idList(ids) {
  return (ids || []).map((i) => `${i.type} ${i.value}`);
}

function refValue(ids, types) {
  const v = (ids || []).filter((i) => types.includes(i.type)).map((i) => `${i.type} ${i.value}`);
  return v.length ? v.join(', ') : 'Not available in the Revision History';
}

function adapterText(ifc) {
  const s = (ifc.adapters && ifc.adapters.sender) || [];
  const r = (ifc.adapters && ifc.adapters.receiver) || [];
  if (!s.length && !r.length) return '';
  return `Sender: ${s.join(', ') || 'n/a'}  |  Receiver: ${r.join(', ') || 'n/a'}`;
}

function safeName(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/* ------------------------------------------------------------ doc content */

function titleBlock(tut) {
  const a = tut.analysis;
  const type = tut.meta.tutType === 'negative' ? 'Negative' : 'Positive';
  return [
    para('Technical Unit Testing (TUT)', { size: 44, bold: true, color: C.navy, after: 40 }),
    para(`${type} TUT \u2013 SAP PI/PO`, { size: 28, color: C.blue, after: 40 }),
    para(`${a.interface.id || ''}${a.interface.id && a.interface.name ? ' \u2013 ' : ''}${a.interface.name || ''}`, { size: 26, bold: true, after: 160 }),
    kv([
      ['Interface ID', a.interface.id],
      ['Interface Name', a.interface.name],
      ['TUT Type', `${type} TUT`],
      ['Revision under test', `Revision ${a.entry.number} dated ${a.entry.date}`],
      ['Change reference', idList(a.entry.identifiers).join(', ') || 'Not available in the Revision History'],
      ['SAP PO Environment', tut.inputs.environment || 'To be filled in by tester'],
      ['Prepared on', tut.meta.generatedAt.slice(0, 10)],
      ['Tester / Executed by', ' ']
    ]),
    spacer(60)
  ];
}

function interfaceDetails(tut) {
  const a = tut.analysis;
  const i = a.interface;
  const chList = (arr) => (arr && arr.length ? arr.map((c) => `${c.name}${c.adapterType || c.adapter ? ` (${c.adapterType || c.adapter})` : ''}`).join('\n') : '');
  const ico = (i.icos || [])[0] || {};
  const oms = (i.icos || []).flatMap((x) => (x.operationMappings || []).map((o) => o.operationMapping)).filter(Boolean);
  const mms = (i.messageMappings || []).map((m) => m.name).filter(Boolean);
  return [
    h1('1. Interface Details'),
    kv([
      ['Interface ID / Name', `${i.id}${i.name ? ' \u2013 ' + i.name : ''}`],
      ['Interface Description', i.shortDescription || i.title],
      ['Source System', i.sourceSystem],
      ['Target System(s)', (i.targetSystems || []).join(', ')],
      ['Interface Type / Adapters', adapterText(i)],
      ['Sender Communication Channel(s)', chList(i.senderChannels)],
      ['Receiver Communication Channel(s)', chList(i.receiverChannels)],
      ['Integrated Configuration (ICO)', ico.description || ''],
      ['Operation Mapping(s)', uniqStr(oms).join('\n')],
      ['Message Mapping(s)', uniqStr(mms).join('\n')]
    ]),
    para('Source: Technical Specification Document (TSD). Values shown as "Not stated in the TSD" could not be established from the document.', { italics: true, size: 17, color: C.muted, before: 60 })
  ];
}

function uniqStr(a) {
  return Array.from(new Set(a.filter(Boolean)));
}

/** "Start of the change / Change / End of the Change" block in the style of the existing TUTs. */
function changeBlock(tut) {
  const e = tut.analysis.entry;
  const fmt = (i) => (i.type === 'ADO' ? `ADO-${i.value}` : i.type === 'XREF' || i.type === 'CRF' ? (i.type === 'CRF' ? i.value : `XREF ${i.value}`) : `${i.type} ${i.value}`);
  const ids = (e.identifiers || []).map(fmt).join(', ') || `Revision ${e.number}`;
  const lines = [
    para(`Start of the change: ${ids}`, { bold: true, color: C.navy, after: 40, keepNext: true }),
    para(`Change: ${clean(e.description).replace(/\s+/g, ' ')}`, { after: 40, keepNext: true }),
    para(`End of the Change: ${ids}`, { bold: true, color: C.navy, after: 0 })
  ];
  return table([CONTENT_W], [row([cell(lines, CONTENT_W, { fill: C.label })])]);
}

function changeReference(tut) {
  const a = tut.analysis;
  const e = a.entry;
  return [
    h1('2. Change Reference'),
    kv([
      ['Revision Number', e.number],
      ['Revision Date', e.date],
      ['Project', e.project],
      ['Revised By', e.revisedBy],
      ['CRF / WRICEF Reference', refValue(e.identifiers, ['CRF', 'WRICEF'])],
      ['XREF Reference', refValue(e.identifiers, ['XREF'])],
      ['ADO / JIRA Reference', refValue(e.identifiers, ['ADO', 'JIRA'])],
      ['Other Change Identifiers', refValue(e.identifiers, ['INC', 'RITM', 'TASK', 'Defect', 'Bug', 'ALM'])],
      ['Change Description (verbatim from the Revision History)', e.description],
      ['Change type recognised', a.types.map((t) => t.label).join('; ')],
      ['TSD sections containing the change', (a.sectionsTouched || []).join('\n') || 'No Start/End change markers found']
    ]),
    spacer(80),
    changeBlock(tut)
  ];
}

function objective(tut) {
  const a = tut.analysis;
  const pos = tut.meta.tutType === 'positive';
  const e = a.entry;
  const txt = pos
    ? `To verify, in SAP PO, that the change documented in revision ${e.number} (${e.date}) of the TSD for interface ${a.interface.id} works as intended: valid input data is processed successfully, the changed behaviour is visible in the SAP PO message processing and the target payload, and the message is delivered successfully.`
    : `To verify, in SAP PO, the behaviour of interface ${a.interface.id} for invalid, missing or unexpected input data that is relevant to the change documented in revision ${e.number} (${e.date}) of the TSD, including the expected handling and the monitoring evidence. A business rejection or an intended non-routing is not treated as a technical failure unless the TSD says so.`;
  return [h1('3. Objective'), para(txt), para(`Change under test: ${clean(e.description).replace(/\s+/g, ' ')}`, { italics: true })];
}

function scope(tut) {
  const a = tut.analysis;
  const n = a.related.names;
  const comps = [];
  const add = (lbl, arr) => arr && arr.length && comps.push(`${lbl}: ${arr.slice(0, 8).join(', ')}`);
  add('Communication channels', n.channels);
  add('Operation mappings', n.operationMappings);
  add('Message mappings', n.messageMappings);
  add('Message / data types', (n.messageTypes || []).concat(n.dataTypes || []));
  add('Paths', n.paths);
  const out = [
    h1('4. Scope of Testing'),
    h3('In scope'),
    ...bullets([`Only the change of revision ${a.entry.number} (${idList(a.entry.identifiers).join(', ') || 'see Change Reference'}), as described in section 2 and in the TSD sections listed there.`].concat(comps)),
    h3('Out of scope'),
    ...bullets([
      'Changes of earlier revisions (unless directly needed to validate this change).',
      'Full regression of the interface that is not affected by this change.'
    ])
  ];
  if (tut.unconfirmed) {
    out.push(spacer(60), noteBox(`${tut.unconfirmed} item(s) could not be established from the TSD and require confirmation before execution. They are marked "Needs confirmation" in the expected results and listed in Appendix A.`));
  }
  return out;
}

function scenarioSection(tut) {
  const out = [h1('5. Test Scenario')];
  if (tut.inputs.scenario) out.push(para('Tester-provided scenario context:', { bold: true }), para(tut.inputs.scenario));
  out.push(
    para(`The following ${tut.testCases.length} ${tut.meta.tutType} test case(s) were derived from the change:`, { keepNext: true }),
    grid(
      [
        { title: 'Test Case ID', width: 2300 },
        { title: 'Test Scenario', width: CONTENT_W - 2300 }
      ],
      tut.testCases.map((c) => [c.id, c.scenario])
    )
  );
  if (tut.inputs.assumptions) out.push(spacer(60), para('Conditions / assumptions stated by the tester:', { bold: true }), para(tut.inputs.assumptions));
  return out;
}

function commonPreconditions(tut) {
  const cases = tut.testCases;
  if (!cases.length) return [];
  const first = cases[0].preconditions;
  return first.filter((p) => cases.every((c) => c.preconditions.includes(p)));
}

function preconditionsSection(tut, common) {
  const out = [h1('6. Preconditions')];
  if (common.length) out.push(para('Applicable to all test cases:', { keepNext: true }), ...bullets(common));
  else out.push(para('See the individual test cases.'));
  out.push(para('Additional preconditions per test case are listed within each test case.', { italics: true, size: 18, color: C.muted }));
  return out;
}

function testDataSection(tut) {
  const out = [h1('7. Test Data')];
  out.push(para('Test data per test case is listed in each test case. Values are derived from the TSD (blue/green) or must be entered by the tester (grey).'));
  if (tut.inputs.samplePayload) out.push(h3('Tester-supplied sample payload'), codeBox(tut.inputs.samplePayload));
  else out.push(para('No sample payload was supplied; the tester prepares a valid source message for the interface and changes only the fields stated in the test case.', { italics: true }));
  return out;
}

function caseBlock(c, common, idx) {
  const out = [];
  out.push(h2(`${c.id} \u2013 ${clean(c.scenario, 140)}`, { pageBreakBefore: idx > 0 }));
  out.push(
    kv([
      ['Test Case ID', c.id],
      ['Test Scenario', c.scenario],
      ['Test Objective', c.objective],
      ['Change reference', c.changeRef]
    ])
  );

  const own = c.preconditions.filter((p) => !common.includes(p));
  out.push(h3('Preconditions'));
  out.push(...(own.length ? bullets(own) : [para('As listed in section 6 (common preconditions).', { italics: true })]));

  out.push(h3('Test Data'));
  out.push(
    grid(
      [
        { title: 'Field / Item', width: 2900 },
        { title: 'Value', width: 4538 },
        { title: 'Source of value', width: 2200 }
      ],
      c.testData.map((t) => [t.field, t.value, { text: t.source, fill: basisFill(t.source) }])
    )
  );

  out.push(h3('Test Execution Steps'));
  out.push(
    grid(
      [
        { title: 'Step', width: 640 },
        { title: 'Action', width: 4000 },
        { title: 'Expected result of the step', width: 2600 },
        { title: 'Evidence to capture', width: 2398 }
      ],
      c.steps.map((s) => [String(s.n), s.action, s.expected, s.evidence])
    )
  );

  out.push(h3('Expected Results'));
  out.push(
    grid(
      [
        { title: '#', width: 500 },
        { title: 'Expected result', width: 5338 },
        { title: 'Basis', width: 1700 },
        { title: 'TSD reference', width: 2100 }
      ],
      c.expected.map((e, k) => [String(k + 1), e.text, { text: e.basis, fill: basisFill(e.basis), bold: e.basis === BASIS.CONFIRM }, e.ref])
    )
  );

  out.push(h3('Actual Results'));
  out.push(table([CONTENT_W], [row([cell([para('', { after: 0 })], CONTENT_W)], { minHeight: 1500 })]));

  out.push(h3('Test Status'));
  out.push(
    table(
      [2700, 3469, 1700, 1769],
      [
        row([
          cell('Status', 2700, { fill: C.label, bold: true, color: C.navy }),
          cell('\u2610 Passed     \u2610 Failed     \u2610 Blocked', 3469),
          cell('Executed by', 1700, { fill: C.label, bold: true, color: C.navy }),
          cell(' ', 1769)
        ]),
        row([cell('Execution date', 2700, { fill: C.label, bold: true, color: C.navy }), cell(' ', 3469), cell('Defect / ticket', 1700, { fill: C.label, bold: true, color: C.navy }), cell(' ', 1769)])
      ]
    )
  );

  out.push(h3('Reference Values (fill in during execution)'));
  const refRows = [['Source Message ID', ' ']];
  if (c.refs && c.refs.idoc) refRows.push(['IDoc number (source system)', ' ']);
  if (c.refs && c.refs.senderChannel) refRows.push(['Sender communication channel', c.refs.senderChannel]);
  if (c.refs && c.refs.receiverChannel) refRows.push(['Target communication channel', c.refs.receiverChannel]);
  refRows.push(['Target-side message ID / reference', ' ']);
  out.push(kv(refRows));


  out.push(h3('Evidence / Screenshots'));
  c.steps.forEach((s) => {
    out.push(evidenceBox(`Step ${s.n}`, clean(s.evidence, 160), 2400), spacer(80));
  });

  out.push(h3('Remarks'));
  out.push(table([CONTENT_W], [row([cell([para(c.remarks || '', { after: 0 })], CONTENT_W)], { minHeight: 700 })]));
  return out;
}

function summarySection(tut, n) {
  return [
    h1(`${n}. Test Status Summary`, { pageBreakBefore: true }),
    grid(
      [
        { title: 'Test Case ID', width: 2100 },
        { title: 'Test Scenario', width: 3938 },
        { title: 'Status', width: 1200 },
        { title: 'Executed by / date', width: 2400 }
      ],
      tut.testCases.map((c) => [c.id, clean(c.scenario, 140), '', '']),
      { minHeight: 480 }
    ),
    spacer(120),
    kv([
      ['Overall result', '\u2610 Passed     \u2610 Failed     \u2610 Passed with remarks'],
      ['Tester signature / date', ' '],
      ['Reviewer signature / date', ' ']
    ])
  ];
}

function appendix(tut) {
  const out = [h1('Appendix A \u2013 Items Requiring Confirmation', { pageBreakBefore: true })];
  if (!tut.flags.length) out.push(para('No open items.'));
  else {
    const sevFill = { error: C.err, warn: C.confirm, info: C.derived };
    const sevText = { error: 'Must confirm', warn: 'Please confirm', info: 'Note' };
    out.push(
      grid(
        [
          { title: 'Level', width: 1500 },
          { title: 'Area', width: 1900 },
          { title: 'Item', width: 6238 }
        ],
        tut.flags.map((f) => [{ text: sevText[f.severity] || f.severity, fill: sevFill[f.severity], bold: true }, f.section, f.text])
      )
    );
  }
  out.push(h1('Appendix B \u2013 Pre-generation Quality Check'));
  const st = { pass: 'Pass', warn: 'Review', fail: 'Fail' };
  const fill = { pass: C.tsd, warn: C.confirm, fail: C.err };
  out.push(
    grid(
      [
        { title: '#', width: 450 },
        { title: 'Check', width: 3000 },
        { title: 'Result', width: 1000 },
        { title: 'What was verified', width: 5188 }
      ],
      tut.validation.map((v) => [
        String(v.id),
        v.name,
        { text: st[v.status] || v.status, fill: fill[v.status], bold: true },
        [para(v.detail, { size: 19, bold: true, after: 40 })].concat((v.evidence || []).map((e) => para(e, { size: 18, bullet: true, after: 20 })))
      ])
    )
  );
  out.push(
    spacer(80),
    para('Legend \u2013 basis of expected results:', { bold: true, keepNext: true }),
    grid(
      [
        { title: 'Basis', width: 2800 },
        { title: 'Meaning', width: 6838 }
      ],
      [
        [{ text: BASIS.TSD, fill: C.tsd }, 'Taken directly from the TSD text, tables or Unit Test Plan.'],
        [{ text: BASIS.DERIVED, fill: C.derived }, 'Logically derived from a condition or structure documented in the TSD (for example, the evaluation of a receiver-determination condition).'],
        [{ text: BASIS.TESTER, fill: C.tester }, 'Supplied by the tester or a placeholder the tester must fill in; not stated in the TSD.'],
        [{ text: BASIS.CONFIRM, fill: C.confirm }, 'Could not be established (or conflicts) in the TSD; must be confirmed before the test is executed.']
      ]
    )
  );
  return out;
}

/* -------------------------------------------------------------- the file */

async function buildDocx(tut) {
  const a = tut.analysis;
  const type = tut.meta.tutType === 'negative' ? 'Negative' : 'Positive';
  const common = commonPreconditions(tut);

  const children = [
    ...titleBlock(tut),
    ...interfaceDetails(tut),
    ...changeReference(tut),
    ...objective(tut),
    ...scope(tut),
    ...scenarioSection(tut),
    ...preconditionsSection(tut, common),
    ...testDataSection(tut),
    h1('8. Test Cases', { pageBreakBefore: true }),
    para('Each test case contains its test data, execution steps, expected results, and areas for the actual results, status and SAP PO evidence. Expected results are tagged with their basis (see Appendix B).')
  ];
  tut.testCases.forEach((c, i) => children.push(...caseBlock(c, common, i)));
  children.push(...summarySection(tut, 9));
  children.push(...appendix(tut));

  const headerText = `SAP PI/PO \u2013 Technical Unit Testing (${type}) | ${a.interface.id || ''} | Rev ${a.entry.number}`;
  const doc = new Document({
    creator: 'SAP PI/PO TUT Generator',
    title: clean(`TUT ${a.interface.id} ${type} Rev ${a.entry.number}`),
    description: 'Technical Unit Testing document generated from the Technical Specification Document',
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 }, paragraph: { spacing: { after: 60, line: 264 } } },
        heading1: { run: { font: FONT, size: 30, bold: true, color: C.navy }, paragraph: { spacing: { before: 240, after: 100 } } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: C.blue }, paragraph: { spacing: { before: 160, after: 80 } } },
        heading3: { run: { font: FONT, size: 22, bold: true, color: C.navy }, paragraph: { spacing: { before: 120, after: 60 } } }
      }
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }]
        }
      ]
    },
    sections: [
      {
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: 1304, bottom: 1134, left: MARGIN, right: MARGIN, header: 567, footer: 567 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: clean(headerText), size: 17, color: C.muted, font: FONT })],
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.border, space: 4 } },
                spacing: { after: 0 }
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'Internal \u2013 Technical Unit Test Evidence    |    Page ', size: 17, color: C.muted, font: FONT }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 17, color: C.muted, font: FONT }),
                  new TextRun({ text: ' of ', size: 17, color: C.muted, font: FONT }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 17, color: C.muted, font: FONT })
                ],
                alignment: AlignmentType.CENTER,
                border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.border, space: 4 } },
                spacing: { before: 0, after: 0 }
              })
            ]
          })
        },
        children
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = `TUT_${safeName(a.interface.id || 'Interface')}_${type}_Rev${safeName(a.entry.number)}.docx`;
  return { buffer, fileName };
}

module.exports = { buildDocx };
