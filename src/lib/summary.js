'use strict';

const { truncate } = require('./text');
const { fieldTargets } = require('./generator');

function interfaceType(ifc) {
  const s = (ifc.adapters && ifc.adapters.sender) || [];
  const r = (ifc.adapters && ifc.adapters.receiver) || [];
  if (!s.length && !r.length) return '';
  return `${s.join(' / ') || 'n/a'} \u2192 ${r.join(' / ') || 'n/a'}`;
}

function understanding(a) {
  const parts = [];
  const e = a.entry;
  const rt = a.routing;
  if (rt && rt.receivers.length) {
    for (const rc of rt.receivers) {
      const b = rc.before ? `from "${rc.before.text}" ` : '';
      parts.push(`The receiver determination condition for ${rc.component || rc.receiver} is changed ${b}to "${rc.after.text}". Test cases check which inputs are routed to that receiver and which are not.`);
    }
    for (const it of rt.intent) parts.push(`Stated in ${it.section}: "${truncate(it.text, 240)}"`);
    for (const c of rt.conflicts) {
      parts.push(
        `CONFLICT: the documented condition routes ${c.field} = ${c.value} to ${c.receiver}, but the TSD narrative says it should ${c.stated ? '' : 'not '}be routed. You must confirm which is correct.`
      );
    }
  }
  const labels = a.types.map((t) => t.label);
  if (!rt || !rt.receivers.length) {
    parts.push(`The change is recognised as: ${labels.join('; ')}. Test cases verify this change as described in the Revision History and in the TSD sections listed below.`);
  } else if (labels.length > 1) {
    parts.push(`Other recognised change aspects: ${labels.filter((l) => !/Routing/.test(l)).join('; ') || 'none'}.`);
  }
  if (!a.scopeFound) parts.push('No "Start of / End of" markers for this revision were found, so only the Revision History text is available.');
  if (e.identifiers.length === 0) parts.push('The Revision History entry contains no recognisable change identifier (CRF/XREF/ADO/JIRA).');
  return parts;
}

function buildChangeSummary(a) {
  const i = a.interface;
  const e = a.entry;
  const ids = (types) => e.identifiers.filter((x) => types.includes(x.type)).map((x) => `${x.type} ${x.value}`);
  const n = a.related.names;
  const comps = [];
  const add = (label, arr) => arr && arr.length && comps.push({ label, values: arr.slice(0, 12) });
  add('Communication channels', n.channels);
  add('Operation mappings', n.operationMappings);
  add('Message mappings', n.messageMappings);
  add('Message / data types', (n.messageTypes || []).concat(n.dataTypes || []));
  add('Service interfaces', n.serviceInterfaces);
  add('Paths', n.paths);
  if (a.routing) add('Receiver determination', a.routing.receivers.map((r) => `${r.component || r.receiver}: ${r.after.text}`));

  const fields = fieldTargets(a).map((f) => ({ name: f.name, path: f.path, side: f.side, kind: f.kind }));
  return {
    interface: {
      id: i.id,
      name: i.name,
      description: i.shortDescription || i.title || '',
      sourceSystem: i.sourceSystem || '',
      targetSystems: i.targetSystems || [],
      type: interfaceType(i)
    },
    revision: {
      number: e.number,
      date: e.date,
      project: e.project,
      revisedBy: e.revisedBy,
      description: e.description,
      crf: ids(['CRF', 'WRICEF']),
      xref: ids(['XREF']),
      adoJira: ids(['ADO', 'JIRA']),
      other: ids(['INC', 'RITM', 'TASK', 'Defect', 'Bug', 'ALM'])
    },
    changeTypes: a.types.map((t) => t.label),
    sections: a.sectionsTouched || [],
    components: comps,
    fields,
    embedded: (a.related.embeddedObjects || []).map((x) => ({ name: x.name, kind: x.kind })),
    understanding: understanding(a),
    scopeFound: a.scopeFound,
    regionExcerpts: (a.regions || [])
      .filter((r) => r.lines.length)
      .slice(0, 6)
      .map((r) => ({ section: r.section, lines: r.lines.slice(0, 6).map((l) => truncate(l, 400)) }))
  };
}

module.exports = { buildChangeSummary };
