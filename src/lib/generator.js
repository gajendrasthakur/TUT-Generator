'use strict';

const { norm, uniq, truncate } = require('./text');

const { BASIS } = require('./basis');
const { runChecks } = require('./validate');

const MAX_PAYLOAD = 20000;

/* ------------------------------------------------------------ helpers */

function exp(text, basis, ref) {
  return { text, basis, ref: ref || '' };
}

function receiverChannelFor(ifc, label) {
  if (!label) return null;
  const key = String(label).toUpperCase().replace(/^TPBS_/, '').replace(/_(PBNA|GLOBAL)$/, '');
  const hit = (ifc.receiverChannels || []).find((c) => {
    const hay = [c.name, c.service, c.description].join(' ').toUpperCase();
    return hay.includes(key);
  });
  if (hit) return hit;
  for (const ico of ifc.icos || []) {
    const m = new RegExp('(CC_[A-Za-z0-9_]+)\\s*\\(([^)]*' + key + '[^)]*)\\)', 'i').exec(ico.receiverChannelText || '');
    if (m) return (ifc.receiverChannels || []).find((c) => c.name === m[1]) || { name: m[1] };
  }
  return null;
}

function icoFor(ifc, label) {
  const key = String(label || '').toUpperCase().replace(/^TPBS_/, '');
  for (const ico of ifc.icos || []) {
    if (key && (ico.rules || []).some((r) => r.component.toUpperCase().includes(key))) return ico;
  }
  return (ifc.icos || [])[0] || null;
}

function triggerStep(ifc, ico) {
  const chName = (ico && ico.senderChannel) || ((ifc.senderChannels || [])[0] || {}).name || '';
  const ch = (ifc.senderChannels || []).find((c) => c.name === chName) || {};
  const ad = String(ch.adapter || ch.adapterType || (ifc.adapters.sender || [])[0] || '').toUpperCase();
  const src = ifc.sourceSystem || 'the source system';
  let action = `Trigger the source message from ${src}.`;
  let evidence = 'Screenshot / reference of the triggered source message (document number, timestamp).';
  if (/IDOC/.test(ad)) {
    action = `Trigger the IDoc from ${src} (e.g. WE19 / output processing) and note the IDoc number.`;
    evidence = 'IDoc number and IDoc status (WE02) in the source system; IDoc XML.';
  } else if (/PROXY/.test(ad)) {
    action = `Trigger the outbound proxy message from ${src}.`;
    evidence = 'Proxy trigger evidence in the source system (e.g. SXI_MONITOR / SPROXY log) and Message ID.';
  } else if (/JMS/.test(ad)) {
    action = 'Place / trigger the JMS message on the sender queue.';
  } else if (/REST|SOAP/.test(ad)) {
    action = `Send the ${ad} request to the sender channel endpoint.`;
    evidence = 'Request payload and HTTP response / status.';
  } else if (/FILE|SFTP/.test(ad)) {
    action = 'Place the source file in the sender channel directory.';
  }
  return { action, evidence, channel: chName };
}

function stepsFor(ctx, focus, receiverLabel, extra) {
  const { ifc } = ctx;
  const ico = icoFor(ifc, receiverLabel);
  const trig = triggerStep(ifc, ico);
  const rc = receiverChannelFor(ifc, receiverLabel);
  const steps = [];
  ctx.lastRefs = {
    senderChannel: trig.channel || '',
    receiverChannel: (rc && rc.name) || (ctx.recvChannels || [])[0] || '',
    idoc: /IDOC/i.test(String((ifc.adapters.sender || []).join(' ')))
  };
  const add = (action, expected, evidence) => steps.push({ n: steps.length + 1, action, expected, evidence });

  add(trig.action + (extra && extra.dataNote ? ` ${extra.dataNote}` : ''), 'Source message is created successfully.', trig.evidence);
  add(
    'Open SAP PO Message Monitoring (Integration Engine / Advanced Adapter Engine) and locate the message by Message ID.' +
      (trig.channel ? ` Sender channel: ${trig.channel}.` : ''),
    'Message is received in SAP PO via the sender communication channel.',
    'Message ID and message log (screenshot).'
  );
  if (focus.includes('routing')) {
    add(
      'In the message log / audit log, check receiver determination' +
        (ico && ico.description ? ` for ICO "${ico.description}"` : '') +
        '. Note which receiver(s) were determined.',
      (extra && extra.routingExpected) || 'Receivers determined as expected for the input value.',
      'Audit-log screenshot showing the determined receiver(s).'
    );
  }
  if (focus.includes('mapping')) {
    const om = ((ico && ico.operationMappings) || []).map((o) => o.operationMapping).filter(Boolean)[0] || ((ifc.operationMappings || [])[0] || {}).name;
    const mm = ((ifc.messageMappings || [])[0] || {}).name;
    add(
      'Open the message payload tabs and capture the before-mapping and after-mapping payloads' +
        (om ? ` (operation mapping ${om}` + (mm ? `, message mapping ${mm}` : '') + ')' : mm ? ` (message mapping ${mm})` : '') +
        '.',
      (extra && extra.mappingExpected) || 'Payload is transformed as per the documented mapping.',
      'Before-mapping and after-mapping payload (screenshots / saved XML).'
    );
  }
  if (focus.includes('delivery')) {
    add(
      'Check the receiver communication channel and the final message status' +
        (rc && rc.name ? ` (channel ${rc.name}${rc.adapterType ? ', ' + rc.adapterType : ''})` : '') +
        '.',
      (extra && extra.deliveryExpected) || 'Message is delivered successfully; status is Delivered / Successful.',
      'Message status and channel audit-log screenshot.'
    );
  }
  if (focus.includes('noDelivery')) {
    add(
      'Confirm in the message log that no delivery to the receiver under test took place' + (rc && rc.name ? ` (channel ${rc.name})` : '') + '.',
      (extra && extra.noDeliveryExpected) || 'No delivery to this receiver.',
      'Message log / receiver overview (screenshot).'
    );
  }
  if (focus.includes('error')) {
    add(
      'Check the message status, error category and error text in Message Monitoring and in the channel audit log.',
      (extra && extra.errorExpected) || 'Result as stated in the Expected Results.',
      'Error text and message status (screenshot).'
    );
  }
  if (focus.includes('target')) {
    add('Verify the data in the target system / target payload.', (extra && extra.targetExpected) || 'Target data is as expected.', 'Target payload or target-system evidence.');
  }
  return steps;
}

function commonPre(ctx, extra) {
  const { ifc, inputs, entry } = ctx;
  const pre = [];
  const env = inputs.environment ? ` in ${inputs.environment}` : '';
  const refs = entry.identifiers.map((i) => `${i.type} ${i.value}`).join(', ');
  pre.push(`The PI/PO objects delivered for ${refs || 'the change'} are imported and activated${env}.`);
  const ch = (extra && extra.channels) || [];
  for (const c of ch) if (c) pre.push(`Communication channel ${c} is active.`);
  pre.push('The tester has access to SAP PO Message Monitoring and (where applicable) the source and target systems.');
  if (inputs.assumptions) pre.push(`Tester-stated condition: ${inputs.assumptions}`);
  return pre;
}

function nextId(ctx) {
  ctx.seq = (ctx.seq || 0) + 1;
  return `TUT-${ctx.ifc.id || 'IF'}-${ctx.tutType === 'negative' ? 'N' : 'P'}-${String(ctx.seq).padStart(2, '0')}`;
}

function addCase(ctx, c) {
  c.id = nextId(ctx);
  c.refs = ctx.lastRefs || { senderChannel: '', receiverChannel: '', idoc: false };
  c.actual = '';
  c.status = '';
  c.remarks = '';
  c.changeRef = ctx.entry.identifiers.map((i) => `${i.type} ${i.value}`).join(', ');
  ctx.cases.push(c);
  return c;
}

function flag(ctx, severity, text, section) {
  if (!ctx.flags.some((f) => f.text === text)) ctx.flags.push({ severity, text, section: section || '' });
}

function samplePayloadNote(ctx) {
  return ctx.inputs.samplePayload ? 'Use the tester-supplied sample payload (see Test Data); adjust only the fields listed.' : '';
}

/* ---------------------------------------------------- change-text helpers */

function tsdLines(analysis, sectionRe) {
  const out = [];
  for (const r of analysis.regions) {
    if (!r.lines) continue;
    for (const l of r.lines) out.push({ text: l, section: r.section });
  }
  return sectionRe ? out.filter((x) => sectionRe.test(x.section)) : out;
}

function mappingEvidence(analysis) {
  const lines = tsdLines(analysis, /Mapping|Source Structure|Target Structure|Technical Solution|Business Requirement/i)
    .filter((l) => l.text.length > 20 && !/^\/[\w:]/.test(l.text) && !/^(start|end) of/i.test(l.text));
  const hits = (analysis.related.embeddedHits || []).slice(0, 6).map((h) => ({ text: `${h.text}`, section: `Embedded: ${h.source}` }));
  return { lines: lines.slice(0, 8), embedded: hits };
}

function errorHandlingLines(analysis) {
  return tsdLines(analysis)
    .filter((l) => /\b(error|fail|fails|failed|reject|rejected|not exist|does not exist|invalid|missing|blank|empty)\b/i.test(l.text) && l.text.length > 25)
    .slice(0, 5);
}

function tsdNegatives(analysis) {
  return (analysis.tsdUtp || []).filter((r) => /negative/i.test(r.condition));
}

function tsdPositives(analysis) {
  return (analysis.tsdUtp || []).filter((r) => /positive/i.test(r.condition));
}

function cleanFieldName(n) {
  let s = String(n || '').trim().split(/\s+[-–—]\s+|\s+/)[0] || '';
  s = s.replace(/[.,;:]+$/, '');
  return /^[A-Za-z_/][\w./\[\]=-]*$/.test(s) ? s : '';
}

function fieldTargets(analysis) {
  const f = analysis.fields;
  const list = [];
  const seen = new Set();
  const push = (arr, kind) =>
    arr.forEach((x) => {
      const name = cleanFieldName(x.name);
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      list.push({ name, path: x.path || '', side: kind, kind: x.kind || 'field' });
    });
  push(f.target, 'target');
  push(f.source, 'source');
  push(f.unassigned, 'unspecified');
  push(f.named, 'unspecified');
  const desc = String((analysis.entry && analysis.entry.description) || '').toLowerCase();
  const rank = (x) => {
    let r = 0;
    if (desc.includes(x.name.toLowerCase())) r -= 10; // named in the Revision History = what was changed
    if (/^Z[A-Z]+\d{2}\w*$/.test(x.name) || /^(MT|DT|SI|MM|OM)_/.test(x.name)) r += 5; // IDoc / message type, not a field
    if (x.side === 'target' || x.side === 'source') r -= 2;
    return r;
  };
  return list
    .filter((x) => x.name.length >= 3 && !/^(then|given|contains|mode|addition|missing|outer|json|name|namespace|wrapper|technical|nodename|new|the|and|for|with|from|field|value|segment)$/i.test(x.name))
    .filter((x) => !/^\/?sap\/bc\//i.test(x.path || '') && !/^SolmanDoc$/i.test(x.name))
    .map((x, i) => ({ x, i, r: rank(x) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((o) => o.x)
    .slice(0, 8);
}

/* ------------------------------------------------------- change builders */

function buildRoutingCases(ctx, analysis) {
  const rt = analysis.routing;
  const { ifc } = ctx;
  const positive = ctx.tutType === 'positive';
  const rows = [];
  for (const rc of rt.receivers) {
    const label = rc.receiver || rc.component || 'the receiver';
    const compKey = (rc.component || rc.receiver || '').toUpperCase();
    // pick representative payload rows
    let evalRows = rc.after.eval;
    if (rt.fields.length > 1) {
      const t = evalRows.filter((e) => e.routed).slice(0, 3);
      const f = evalRows.filter((e) => !e.routed).slice(0, 3);
      evalRows = t.concat(f);
    }
    const conflicted = rt.conflicts.some((c) => c.receiver === (rc.receiver || '').toUpperCase() || compKey.includes(c.receiver));
    for (const e of evalRows) {
      let routed = e.routed;
      let basis = BASIS.DERIVED;
      let note = '';
      let hasIntent = false;
      const beforeRow = rc.before && (rc.before.eval || []).find((b) => JSON.stringify(b.payload) === JSON.stringify(e.payload));
      // stated intent override (single-field comparison)
      const it = rt.intent.find((x) => {
        const f = Object.keys(e.payload).find((k) => String(e.payload[k]).toUpperCase() === x.value);
        return f && (x.receiver === (rc.receiver || '').toUpperCase() || compKey.includes(x.receiver));
      });
      if (it) {
        hasIntent = true;
        if (it.routed !== routed) {
          note = `The documented condition (${rc.after.text}) evaluates to ${routed ? 'routed' : 'not routed'} for this input, but the TSD narrative states the opposite (${it.section}). Expected result follows the stated intent - CONFIRM the intended behaviour.`;
          routed = it.routed;
          basis = BASIS.CONFIRM;
        } else {
          basis = BASIS.TSD;
        }
      }
      if (!hasIntent && conflicted && beforeRow && beforeRow.routed !== routed) {
        basis = BASIS.CONFIRM;
        note = `The documented condition changes the result for this input (before: ${beforeRow.routed ? 'routed' : 'not routed'}, after: ${routed ? 'routed' : 'not routed'}), but the TSD narrative for this change contradicts the documented condition. This expected result is not reliable - CONFIRM the intended behaviour.`;
      }
      rows.push({ rc, label, compKey, payload: e.payload, routed, basis, note, hasIntent });
    }
  }

  // Positive: inputs that are routed, plus inputs whose intended behaviour is stated in the TSD.
  const sel = positive ? rows.filter((r) => r.routed || r.hasIntent) : rows.filter((r) => !r.routed);
  const chosen = sel.slice(0, 8);
  for (const r of chosen) {
    const payloadDesc = Object.entries(r.payload)
      .map(([k, v]) => `${k} = ${v === '<OTHER VALUE>' ? 'a value that is not listed in the condition (e.g. any other value)' : v}`)
      .join('; ');
    const ch = receiverChannelFor(ifc, r.rc.component || r.label);
    const exps = [];
    if (r.routed) {
      exps.push(exp(`The message is routed to ${r.rc.component || r.label}${ch ? ` via ${ch.name}` : ''}.`, r.basis, 'Receiver determination'));
      exps.push(exp('Message status is Delivered / Successful.', BASIS.DERIVED, 'Message monitoring'));
    } else {
      exps.push(exp(`The message is NOT routed to ${r.rc.component || r.label}. This is a routing outcome, not an error; it is not expected to fail in SAP PO because of this receiver.`, r.basis, 'Receiver determination'));
      exps.push(exp('The message log shows no delivery attempt to this receiver.', BASIS.DERIVED, 'Message monitoring'));
    }
    if (r.note) exps.push(exp(r.note, BASIS.CONFIRM, 'TSD conflict'));
    const others = (rt.otherRules || []).filter((o) => o.component !== r.rc.component);
    const steps = stepsFor(ctx, ['routing', r.routed ? 'delivery' : 'noDelivery'], r.rc.component || r.label, {
      dataNote: `Set ${payloadDesc}.`,
      routingExpected: r.routed ? `${r.rc.component || r.label} is among the determined receivers.` : `${r.rc.component || r.label} is not among the determined receivers.`
    });
    addCase(ctx, {
      scenario: `${r.routed ? 'Routing to' : 'Non-routing to'} ${r.label} when ${payloadDesc}`,
      objective: `Verify the changed receiver determination condition for ${r.label}: ${r.rc.after.text}${r.rc.before ? ` (before the change: ${r.rc.before.text})` : ''}.`,
      preconditions: commonPre(ctx, { channels: [ch && ch.name] }),
      testData: Object.entries(r.payload).map(([k, v]) => ({ field: k, value: v === '<OTHER VALUE>' ? '<any value not listed above>' : v, source: BASIS.DERIVED })),
      steps,
      expected: exps,
      remarks: others.length ? `Other receiver rules for the same field(s) (from the TSD): ${others.map((o) => `${o.condition} -> ${o.component}`).join('; ')}` : ''
    });
  }
  if (!chosen.length) {
    flag(ctx, 'warn', `The documented routing condition produced no ${positive ? 'routed' : 'non-routed'} input combination to test. Please describe the expected routing behaviour.`, 'Routing');
  }
  if (rt.conflicts.length) {
    for (const c of rt.conflicts) {
      flag(
        ctx,
        'error',
        `Routing conflict in the TSD: the documented condition for ${c.receiver} routes ${c.field} = ${c.value} as "${c.literal ? 'routed' : 'not routed'}", but the TSD states it should be "${c.stated ? 'routed' : 'not routed'}" ("${truncate(c.text, 200)}"). Test cases follow the stated intent. Please confirm which is correct before executing.`,
        c.section
      );
    }
  }
  // Note on the "no receiver" behaviour
  if (!positive) {
    flag(ctx, 'info', 'If an input matches no receiver rule, SAP PO behaviour (skipped vs. "No receiver could be determined" error) depends on the ICO receiver-determination settings, which the TSD does not state. Please confirm if this case is to be executed.', 'Routing');
  }
}

function buildReceiverCases(ctx, analysis) {
  const positive = ctx.tutType === 'positive';
  const { ifc } = ctx;
  const chNames = uniq((analysis.related.names.channels || []).filter((c) => /_RCVR_/.test(c)));
  const label = (analysis.entry.description.match(/\b(?:receiver|system)\s+([A-Z][A-Za-z0-9_]{2,})\b/) || [])[1] || (ifc.targetSystems || []).slice(-1)[0] || '';
  const ch = chNames[0] ? { name: chNames[0] } : receiverChannelFor(ifc, label);
  if (positive) {
    if (!analysis.routing) {
      addCase(ctx, {
        scenario: `Message delivered to the new receiver ${label || ''}`.trim(),
        objective: `Verify that the interface delivers the message to the receiver added by this change${label ? ' (' + label + ')' : ''}.`,
        preconditions: commonPre(ctx, { channels: chNames }),
        testData: [{ field: 'Source message', value: ctx.inputs.samplePayload ? 'Tester-supplied sample payload' : 'A valid source message for this interface', source: BASIS.TESTER }],
        steps: stepsFor(ctx, ['delivery', 'mapping'], label, { dataNote: samplePayloadNote(ctx) }),
        expected: [
          exp(`The message is delivered to ${label || 'the new receiver'}${ch ? ' via ' + ch.name : ''}; status is Delivered / Successful.`, BASIS.TSD, 'Section 2.3 / 5.3'),
          exp('The after-mapping payload matches the target structure of the new receiver.', BASIS.DERIVED, 'Section 4.2 / 4.3')
        ]
      });
      flag(ctx, 'warn', 'The input value that selects the new receiver was not found in the change text. Please state which source value routes the message to the new receiver.', 'Receiver determination');
    }
  } else {
    const negs = tsdNegatives(ctx.analysis);
    if (negs.length) {
      for (const n of negs) {
        addCase(ctx, {
          scenario: `Technical delivery failure to the new receiver: ${truncate(n.description, 160)}`,
          objective: `Verify the failure handling for the receiver added by this change (from the TSD Unit Test Plan).`,
          preconditions: commonPre(ctx, { channels: chNames }).concat(['The receiver channel is stopped / the target is unreachable (as described in the TSD test).']),
          testData: [{ field: 'Source message', value: 'A valid source message', source: BASIS.TESTER }],
          steps: stepsFor(ctx, ['error'], label, { dataNote: samplePayloadNote(ctx), errorExpected: n.expected }),
          expected: [exp(n.expected || 'Message is in an error state.', BASIS.TSD, 'Section 9 (TSD Unit Test Plan)')]
        });
      }
    } else {
      flag(ctx, 'warn', 'The TSD does not contain a negative test for the new receiver. Please describe the failure scenario to test (e.g. receiver channel stopped).', 'Receiver');
    }
  }
}

function buildFieldCases(ctx, analysis, kindLabel) {
  const positive = ctx.tutType === 'positive';
  const targets = fieldTargets(analysis);
  const ev = mappingEvidence(analysis);
  const errLines = errorHandlingLines(analysis);
  const typeKey = analysis.types[0].type;

  if (!targets.length) {
    flag(ctx, 'error', `The ${kindLabel} could not be identified by name from the TSD text of this change (it may be inside an image or an embedded object). Please enter the field / segment name(s) in the confirmation step.`, 'Data Mapping');
  }
  const names = targets.length ? targets : [{ name: '<field / segment to be confirmed>', path: '', side: 'unspecified', kind: 'field' }];
  const logicExp = [];
  for (const l of ev.lines.slice(0, 3)) logicExp.push(exp(`Mapping behaviour as documented: "${truncate(l.text, 300)}"`, BASIS.TSD, l.section));
  for (const h of ev.embedded.slice(0, 2)) logicExp.push(exp(`Mapping sheet entry: ${truncate(h.text, 300)}`, BASIS.TSD, h.section));
  if (!logicExp.length) {
    logicExp.push(exp('The mapping logic for this change could not be read from the TSD text (it may be in an image). Expected target value to be confirmed against the mapping sheet.', BASIS.CONFIRM, 'Section 4.3'));
    flag(ctx, 'warn', 'No readable mapping logic was found for this change. Please confirm the expected target value(s).', 'Data Mapping');
  }

  names.slice(0, 4).forEach((f) => {
    const loc = f.path ? ` (${f.path})` : '';
    if (positive) {
      const exps = [exp(`The ${f.kind === 'segment' ? 'segment' : 'field'} ${f.name} is processed without mapping or parsing errors.`, BASIS.DERIVED, 'Message monitoring')].concat(logicExp);
      if (typeKey === 'optional_field') exps.unshift(exp(`${f.name} is populated in the target when a value is supplied in the source.`, BASIS.DERIVED, 'Section 4.2 / 4.3'));
      exps.push(exp('Message status is Delivered / Successful.', BASIS.DERIVED, 'Message monitoring'));
      addCase(ctx, {
        scenario: `${labelFor(typeKey)} - valid input for ${f.name}${loc}`,
        objective: `Verify the change for ${f.name}: ${truncate(analysis.entry.description.replace(/\s+/g, ' '), 220)}`,
        preconditions: commonPre(ctx, { channels: ctx.recvChannels }),
        testData: [
          { field: f.name, value: ctx.inputs.samplePayload ? 'Value taken from the tester-supplied payload' : '<a valid value - to be entered by tester>', source: BASIS.TESTER },
          { field: 'All other fields', value: 'Valid values (unchanged)', source: BASIS.TESTER }
        ],
        steps: stepsFor(ctx, ['mapping', 'delivery'], null, { dataNote: samplePayloadNote(ctx) }),
        expected: exps
      });
      if (typeKey === 'optional_field') {
        addCase(ctx, {
          scenario: `${labelFor(typeKey)} - ${f.name} missing in the source`,
          objective: `Verify that the interface behaves as designed when ${f.name} is not supplied in the source message.`,
          preconditions: commonPre(ctx, { channels: ctx.recvChannels }),
          testData: [
            { field: f.name, value: '<not present in the source payload>', source: BASIS.DERIVED },
            { field: 'All other fields', value: 'Valid values (unchanged)', source: BASIS.TESTER }
          ],
          steps: stepsFor(ctx, ['mapping', 'delivery'], null, { dataNote: `Remove ${f.name} from the source payload.` }),
          expected: [
            exp(`The target field is not generated in the after-mapping payload when ${f.name} is missing in the source.`, BASIS.DERIVED, 'Section 4.2 (field is optional)'),
            exp('The message is processed and delivered successfully (the field is optional in the target).', BASIS.DERIVED, 'Section 4.2')
          ]
        });
      }
    } else {
      const exps = [];
      if (errLines.length) for (const l of errLines.slice(0, 2)) exps.push(exp(`Behaviour documented in the TSD: "${truncate(l.text, 300)}"`, BASIS.TSD, l.section));
      else {
        exps.push(exp('Expected behaviour for a missing / invalid value of this field is not stated in the TSD. Confirm whether the message should (a) succeed with the field omitted or defaulted, (b) be rejected by mapping, or (c) fail in SAP PO.', BASIS.CONFIRM, 'TSD does not state'));
        flag(ctx, 'warn', `The TSD does not state the expected behaviour when ${f.name} is missing or invalid. The negative test case expects a result that must be confirmed.`, 'Error handling');
      }
      addCase(ctx, {
        scenario: `${labelFor(typeKey)} - missing / invalid value for ${f.name}${loc}`,
        objective: `Verify the behaviour of the changed mapping when ${f.name} is missing, blank or invalid. Distinguish a business rejection from a technical failure.`,
        preconditions: commonPre(ctx, { channels: ctx.recvChannels }),
        testData: [
          { field: f.name, value: '<missing / blank / invalid format - tester to choose one and record it>', source: BASIS.TESTER },
          { field: 'All other fields', value: 'Valid values (unchanged)', source: BASIS.TESTER }
        ],
        steps: stepsFor(ctx, ['mapping', 'error'], null, { dataNote: samplePayloadNote(ctx) }),
        expected: exps
      });
    }
  });
}

function labelFor(type) {
  return (
    {
      optional_field: 'Optional field',
      new_field: 'New / modified field',
      new_segment: 'New segment',
      structure_reimport: 'Structure change',
      data_type: 'Data type / format change',
      mapping_logic: 'Mapping logic',
      split_filter: 'Split / filter condition'
    }[type] || 'Change'
  );
}

function buildGenericCases(ctx, analysis, reason) {
  const positive = ctx.tutType === 'positive';
  const posRows = tsdPositives(analysis);
  const negRows = tsdNegatives(analysis);
  const chNames = uniq(analysis.related.names.channels || []);
  const rows = positive ? posRows : negRows;
  if (rows.length) {
    for (const r of rows) {
      addCase(ctx, {
        scenario: truncate(r.description || 'Scenario from the TSD Unit Test Plan', 200),
        objective: `Verify the change (${truncate(analysis.entry.description.replace(/\s+/g, ' '), 200)}) using the scenario recorded in the TSD Unit Test Plan.`,
        preconditions: commonPre(ctx, { channels: chNames.filter((c) => /_RCVR_/.test(c)) }),
        testData: [{ field: 'Source message', value: ctx.inputs.samplePayload ? 'Tester-supplied sample payload' : (r.testData || 'A valid source message for this interface'), source: r.testData ? BASIS.TSD : BASIS.TESTER }],
        steps: stepsFor(ctx, positive ? ['mapping', 'delivery'] : ['error'], null, { dataNote: samplePayloadNote(ctx), errorExpected: r.expected }),
        expected: [exp(r.expected || 'See TSD.', BASIS.TSD, 'Section 9 (TSD Unit Test Plan)')]
      });
    }
  }
  if (reason) flag(ctx, 'warn', reason, 'Change type');
  if (!rows.length) {
    flag(ctx, 'error', `No ${positive ? 'positive' : 'negative'} scenario could be derived from the TSD for this change. Please enter the scenario and the expected behaviour in the next step.`, 'Test scenario');
  }
}

function addUserCase(ctx, analysis) {
  const i = ctx.inputs;
  if (!i.expectedBehavior && !i.scenario && !(i.changeDetail && !ctx.cases.length)) return;
  if (ctx.cases.length && !i.expectedBehavior) return;
  addCase(ctx, {
    scenario: i.scenario || (i.changeDetail ? truncate(`Verify: ${i.changeDetail}`, 160) : 'Tester-defined scenario'),
    objective: `Verify the change: ${truncate(analysis.entry.description.replace(/\s+/g, ' '), 220)}${i.changeDetail ? ` (tester-described: ${truncate(i.changeDetail, 220)})` : ''}`,
    preconditions: commonPre(ctx, { channels: ctx.recvChannels }),
    testData: [{ field: 'Source message', value: i.samplePayload ? 'Tester-supplied sample payload' : '<to be entered by tester>', source: BASIS.TESTER }],
    steps: stepsFor(ctx, ctx.tutType === 'positive' ? ['mapping', 'delivery'] : ['error'], null, { dataNote: samplePayloadNote(ctx) }),
    expected: [exp(i.expectedBehavior || 'To be defined by the tester.', i.expectedBehavior ? BASIS.TESTER : BASIS.CONFIRM, 'Tester input')]
  });
}

/* ------------------------------------------------------------- main API */

function generateTut(analysis, rawInputs) {
  const inputs = {
    tutType: rawInputs.tutType === 'negative' ? 'negative' : 'positive',
    scenario: truncate(norm(rawInputs.scenario || ''), 2000),
    sourceSystem: truncate(norm(rawInputs.sourceSystem || ''), 200),
    targetSystem: truncate(norm(rawInputs.targetSystem || ''), 200),
    samplePayload: String(rawInputs.samplePayload || '').slice(0, MAX_PAYLOAD),
    expectedBehavior: truncate(norm(rawInputs.expectedBehavior || ''), 2000),
    environment: truncate(norm(rawInputs.environment || ''), 40),
    assumptions: truncate(norm(rawInputs.assumptions || ''), 2000),
    fieldNames: Array.isArray(rawInputs.fieldNames) ? rawInputs.fieldNames.map((x) => truncate(norm(x), 120)).filter(Boolean).slice(0, 10) : [],
    changeDetail: truncate(norm(rawInputs.changeDetail || ''), 2000)
  };

  // Work on a copy: confirmed corrections from the user override extracted values.
  const a = JSON.parse(JSON.stringify(analysis));
  if (inputs.changeDetail && !a.scopeFound) {
    // No change markers in the TSD: the tester's own description becomes the (labelled) basis of the change.
    const { classify } = require('./analyze');
    const t = classify(`${a.entry.description}\n${inputs.changeDetail}`);
    if (t.length && a.types.every((x) => x.type === 'unclassified')) a.types = t;
    a.testerChangeDetail = inputs.changeDetail;
    a.regions = [{ tag: 'Tester-provided change description', section: 'Tester input', closed: 'n/a', lines: [inputs.changeDetail], tableCount: 0 }];
  }
  if (inputs.sourceSystem) a.interface.sourceSystem = inputs.sourceSystem;
  if (inputs.targetSystem) a.interface.targetSystems = inputs.targetSystem.split(/\s*[,;]\s*/).filter(Boolean);
  if (inputs.fieldNames.length) {
    a.testerFields = inputs.fieldNames;
    const have = new Set(a.fields.named.map((n) => n.name.toLowerCase()));
    for (const n of inputs.fieldNames) if (!have.has(n.toLowerCase())) a.fields.named.unshift({ name: n, kind: 'name', context: 'Provided by tester' });
    a.fields.source = [];
    a.fields.target = [];
    a.fields.unassigned = [];
  }

  const ctx = {
    analysis: a,
    ifc: a.interface,
    entry: a.entry,
    inputs,
    tutType: inputs.tutType,
    cases: [],
    flags: [],
    seq: 0,
    recvChannels: uniq((a.related.names.channels || []).filter((c) => /_RCVR_/.test(c)))
  };

  const primary = a.types[0].type;
  const typeSet = new Set(a.types.map((t) => t.type));

  if (!a.scopeFound) {
    flag(ctx, 'error', 'No "Start of / End of" change markers matching this revision were found in the TSD, so the change details can only come from the Revision History text. Please review the Change Summary and provide the missing details.', 'Change scope');
  }
  if (a.docFormat === 'pdf') {
    flag(ctx, 'warn', 'The TSD was read from a PDF; tables and embedded mapping sheets are not available. Please verify field names and conditions against the TSD.', 'Document format');
  }
  if (a.regions.some((r) => r.closed === 'unterminated')) {
    flag(ctx, 'info', 'At least one change marker has no matching "End of" marker; the change text may be incomplete.', 'Change scope');
  }
  if (a.related.embeddedObjects.some((e) => /not readable/i.test(e.kind))) {
    flag(ctx, 'info', 'Some embedded objects referenced by this change cannot be read (for example pictures or binary attachments). Mapping details held only in them are not reflected in the expected results.', 'Embedded objects');
  }

  if (a.routing && (primary === 'routing' || typeSet.has('routing'))) buildRoutingCases(ctx, a);
  if (typeSet.has('new_receiver') && (primary !== 'routing' || ctx.tutType === 'negative')) buildReceiverCases(ctx, a);

  const fieldTypes = ['optional_field', 'new_field', 'new_segment', 'structure_reimport', 'data_type', 'mapping_logic', 'split_filter'];
  const fieldPrimary = a.types.find((t) => fieldTypes.includes(t.type));
  if (fieldPrimary && !(primary === 'routing' && a.routing)) {
    ctx.analysis.types = [fieldPrimary].concat(a.types.filter((t) => t !== fieldPrimary));
    buildFieldCases(ctx, a, labelFor(fieldPrimary.type).toLowerCase());
  }

  if (primary === 'revert') {
    flag(ctx, 'warn', 'This change removes or reverts an earlier change. The test should confirm the removed behaviour is no longer present; the TSD does not describe the expected end state in detail. Please confirm.', 'Change type');
  }
  if (primary === 'no_po_change') {
    flag(ctx, 'warn', 'The TSD states that there is no PI/PO build change for this revision (documentation / test only). The generated test provides regression evidence only.', 'Change type');
  }

  if (!ctx.cases.length) {
    const reason = primary === 'unclassified' || primary === 'configuration' ? `The kind of change could not be classified with confidence from the TSD text ("${truncate(a.entry.description.replace(/\s+/g, ' '), 160)}"). The scenarios below come from the TSD Unit Test Plan; please verify they cover this change.` : '';
    buildGenericCases(ctx, a, reason);
  }
  const before = ctx.cases.length;
  addUserCase(ctx, a);
  if (ctx.cases.length > before && !before) ctx.flags = ctx.flags.filter((f) => f.section !== 'Test scenario');

  const unconfirmed = ctx.flags.filter((f) => f.severity === 'error' || f.severity === 'warn').length;
  return {
    meta: {
      tutType: ctx.tutType,
      generatedAt: new Date().toISOString(),
      tsdFormat: a.docFormat,
      changeTypes: a.types.map((t) => t.label)
    },
    inputs,
    analysis: a,
    testCases: ctx.cases,
    flags: ctx.flags,
    unconfirmed,
    validation: validate(ctx, a)
  };
}

function validate(ctx, a) {
  return runChecks({ a, cases: ctx.cases, flags: ctx.flags, tutType: ctx.tutType, inputs: ctx.inputs });
}

module.exports = { generateTut, BASIS, fieldTargets };
