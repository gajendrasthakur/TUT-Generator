'use strict';
/* SAP PI/PO TUT Generator - browser client. All dynamic content is rendered with textContent (no innerHTML). */
(function () {
  var STEPS = ['Upload', 'Change Summary', 'TUT type', 'Preview', 'Download'];
  var state = { sessionId: null, summary: null, revision: null, preview: null, stepIdx: 0 };
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function show(id, on) { $(id).hidden = !on; }

  function setStep(i) {
    state.stepIdx = i;
    var nav = $('steps');
    clear(nav);
    STEPS.forEach(function (s, k) {
      nav.appendChild(el('div', { class: 's' + (k < i ? ' done' : '') + (k === i ? ' active' : ''), text: (k + 1) + '. ' + s }));
    });
    $('btn-restart').hidden = i === 0 && !state.sessionId;
  }

  function alertMsg(msg, kind) {
    var a = $('alert');
    if (!msg) { a.hidden = true; return; }
    a.className = 'alert ' + (kind || 'error');
    a.textContent = msg;
    a.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function busy(on, text) { $('busy').hidden = !on; if (text) $('busy-text').textContent = text; }

  function api(path, body, form) {
    var opt = { method: 'POST' };
    if (form) opt.body = form;
    else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(Object.assign({ sessionId: state.sessionId }, body || {})); }
    return fetch(path, opt).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        return (ct.indexOf('json') >= 0 ? r.json() : Promise.resolve({})).then(function (j) { throw new Error(j.error || 'The request failed.'); });
      }
      return r;
    });
  }
  function apiJson(path, body, form) { return api(path, body, form).then(function (r) { return r.json(); }); }

  /* ------------------------------------------------------------- upload */
  var chosen = null;
  function setFile(f) {
    chosen = f || null;
    $('file-name').textContent = f ? f.name + ' (' + (f.size / 1048576).toFixed(1) + ' MB)' : 'No file selected';
    $('btn-upload').disabled = !f;
  }
  $('file').addEventListener('change', function (e) { setFile(e.target.files[0]); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

  $('btn-upload').addEventListener('click', function () {
    if (!chosen) return;
    alertMsg('');
    var fd = new FormData();
    fd.append('tsd', chosen);
    busy(true, 'Reading and analysing the TSD\u2026 large documents can take a minute.');
    apiJson('/api/upload', null, fd).then(onAnalysed).catch(function (e) { alertMsg(e.message); }).then(function () { busy(false); });
  });

  function onAnalysed(r) {
    state.sessionId = r.sessionId;
    state.revision = r.revision;
    state.summary = r.summary;
    if (r.needsClarification || !r.summary) showRevision(r);
    else showSummary();
  }

  /* ------------------------------------------------- revision clarification */
  function issuesBox(issues) {
    var box = el('div');
    (issues || []).forEach(function (i) { box.appendChild(el('div', { class: 'note ' + (i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'info'), text: i.text })); });
    return box;
  }

  function showRevision(r) {
    ['step-upload', 'step-summary', 'step-type', 'step-preview'].forEach(function (s) { show(s, false); });
    show('step-revision', true);
    setStep(0);
    var rev = r.revision;
    var issues = $('rev-issues'); clear(issues); issues.appendChild(issuesBox(rev.issues));
    if (rev.status === 'missing') issues.appendChild(el('div', { class: 'note error', text: 'No Revision History could be read from this document. Enter the change manually below.' }));
    var wrap = $('rev-table-wrap'); clear(wrap);
    if (rev.entries.length) {
      var t = el('table', { class: 'grid' });
      t.appendChild(el('thead', null, [el('tr', null, ['', 'Rev', 'Date', 'Summary of changes', 'Revised by'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      rev.entries.forEach(function (e) {
        var cand = rev.candidates.indexOf(e.position) >= 0;
        var tr = el('tr', { class: cand ? 'sel' : '' });
        var btn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Use this' });
        btn.addEventListener('click', function () { pickRevision(e.position); });
        tr.appendChild(el('td', null, [btn]));
        tr.appendChild(el('td', { text: e.number }));
        tr.appendChild(el('td', { text: e.date + (e.dateIssue ? ' (date problem)' : '') }));
        tr.appendChild(el('td', { class: 'pre', text: e.summary }));
        tr.appendChild(el('td', { text: e.revisedBy }));
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t);
    }
  }
  function pickRevision(pos) {
    alertMsg(''); busy(true, 'Analysing the selected change\u2026');
    apiJson('/api/select-revision', { position: pos }).then(onAnalysed).catch(function (e) { alertMsg(e.message); }).then(function () { busy(false); });
  }
  $('btn-manual').addEventListener('click', function () {
    alertMsg(''); busy(true, 'Analysing the change\u2026');
    apiJson('/api/manual-revision', { number: $('m-number').value, date: $('m-date').value, description: $('m-desc').value, identifiers: $('m-ids').value })
      .then(onAnalysed).catch(function (e) { alertMsg(e.message); }).then(function () { busy(false); });
  });

  /* ---------------------------------------------------------- summary */
  function kvTable(rows) {
    var t = el('table', { class: 'kv' });
    rows.forEach(function (r) {
      var v = r[1];
      var td = el('td');
      if (Array.isArray(v)) {
        if (!v.length) td.appendChild(el('span', { class: 'na', text: 'Not stated in the TSD' }));
        else if (v.length === 1) td.textContent = v[0];
        else { var ul = el('ul', { class: 'plain' }); v.forEach(function (x) { ul.appendChild(el('li', { text: x })); }); td.appendChild(ul); }
      } else if (v === '' || v == null) td.appendChild(el('span', { class: 'na', text: 'Not stated in the TSD' }));
      else td.textContent = v;
      if (r[2]) td.className = r[2];
      t.appendChild(el('tr', null, [el('th', { text: r[0] }), td]));
    });
    return t;
  }

  function showSummary() {
    var s = state.summary;
    ['step-upload', 'step-revision', 'step-type', 'step-preview'].forEach(function (x) { show(x, false); });
    show('step-summary', true);
    setStep(1);
    var notes = $('rev-notes'); clear(notes);
    if (state.revision) notes.appendChild(issuesBox(state.revision.issues));
    var b = $('summary-body'); clear(b);

    b.appendChild(el('h4', { text: 'Interface' }));
    b.appendChild(kvTable([
      ['Interface ID / name', (s.interface.id || '') + (s.interface.name ? ' \u2013 ' + s.interface.name : '')],
      ['Interface description', s.interface.description],
      ['Source system', s.interface.sourceSystem],
      ['Target system(s)', s.interface.targetSystems],
      ['Interface type (adapters)', s.interface.type]
    ]));

    b.appendChild(el('h4', { text: 'Latest revision (change under test)' }));
    b.appendChild(kvTable([
      ['Revision number', s.revision.number],
      ['Revision date', s.revision.date],
      ['CRF / WRICEF', s.revision.crf],
      ['XREF', s.revision.xref],
      ['ADO / JIRA', s.revision.adoJira],
      ['Other identifiers', s.revision.other],
      ['Revised by', s.revision.revisedBy]
    ]));
    b.appendChild(el('h4', { text: 'Exact change description (verbatim from the Revision History \u2013 not modified)' }));
    b.appendChild(el('div', { class: 'verbatim', text: s.revision.description }));

    b.appendChild(el('h4', { text: 'Technical components and fields affected' }));
    var rows = [['Change type recognised', s.changeTypes], ['TSD sections with the change', s.sections.length ? s.sections : []]];
    s.components.forEach(function (c) { rows.push([c.label, c.values]); });
    if (s.fields.length) rows.push(['Fields / segments (source / target side as stated in the TSD)', s.fields.map(function (f) { return f.name + (f.side && f.side !== 'unspecified' ? ' [' + f.side + ']' : '') + (f.path ? ' \u2013 ' + f.path : ''); })]);
    if (s.embedded.length) rows.push(['Embedded objects referenced', s.embedded.map(function (e) { return e.name + ' (' + e.kind + ')'; })]);
    b.appendChild(kvTable(rows));

    if (s.regionExcerpts.length) {
      b.appendChild(el('h4', { text: 'Extract of the change text in the TSD' }));
      s.regionExcerpts.forEach(function (r) {
        b.appendChild(el('div', { class: 'hint', text: r.section }));
        b.appendChild(el('div', { class: 'verbatim', text: r.lines.join('\n') }));
      });
    }

    b.appendChild(el('h4', { text: 'Application\u2019s understanding of the expected change' }));
    s.understanding.forEach(function (u) { b.appendChild(el('div', { class: 'note ' + (/^CONFLICT/.test(u) ? 'error' : 'info'), text: u })); });
    if (!s.scopeFound) b.appendChild(el('div', { class: 'note warn', text: 'No Start/End change markers were found for this revision. Please check the details above carefully.' }));

    $('c-source').value = ''; $('c-target').value = ''; $('c-fields').value = ''; $('c-detail').value = ''; $('c-confirm').checked = false; $('btn-confirm').disabled = true;
    show('c-nomarker', !s.scopeFound);
    $('c-source').placeholder = s.interface.sourceSystem ? 'Extracted: ' + s.interface.sourceSystem : 'Not found in the TSD \u2013 please enter';
    $('c-target').placeholder = s.interface.targetSystems.length ? 'Extracted: ' + s.interface.targetSystems.join(', ') : 'Not found in the TSD \u2013 please enter';
  }
  $('c-confirm').addEventListener('change', function () { $('btn-confirm').disabled = !$('c-confirm').checked; });
  $('btn-confirm').addEventListener('click', function () {
    alertMsg('');
    var fields = $('c-fields').value.split(/\s*,\s*/).filter(Boolean);
    apiJson('/api/confirm-summary', { confirmed: true, corrections: { sourceSystem: $('c-source').value, targetSystem: $('c-target').value, fieldNames: fields, changeDetail: $('c-detail').value } })
      .then(showType).catch(function (e) { alertMsg(e.message); });
  });

  /* -------------------------------------------------------------- type */
  function showType() {
    ['step-upload', 'step-revision', 'step-summary', 'step-preview'].forEach(function (x) { show(x, false); });
    show('step-type', true);
    setStep(2);
    var sys = $('needed-sys'); clear(sys);
    var s = state.summary;
    var missingSrc = !s.interface.sourceSystem && !$('c-source').value;
    var missingTgt = !s.interface.targetSystems.length && !$('c-target').value;
    if (missingSrc || missingTgt) sys.appendChild(el('div', { class: 'note warn', text: 'The source and/or target system could not be found in the TSD. Please go back and enter them in the Corrections section.' }));
    updateGenerate();
  }
  function selectedType() { var r = document.querySelector('input[name=tutType]:checked'); return r ? r.value : ''; }
  function updateGenerate() {
    $('btn-generate').disabled = !selectedType();
    ['positive', 'negative'].forEach(function (t) { $('card-' + t).classList.toggle('selected', selectedType() === t); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=tutType]'), function (r) { r.addEventListener('change', updateGenerate); });

  $('btn-generate').addEventListener('click', function () {
    alertMsg(''); busy(true, 'Generating test cases from the change\u2026');
    apiJson('/api/generate', { inputs: {
      tutType: selectedType(), environment: $('i-env').value, scenario: $('i-scenario').value,
      expectedBehavior: $('i-expected').value, samplePayload: $('i-payload').value, assumptions: $('i-assume').value
    } }).then(function (r) { state.preview = r.preview; showPreview(); }).catch(function (e) { alertMsg(e.message); }).then(function () { busy(false); });
  });

  /* ----------------------------------------------------------- preview */
  var BASIS_CLASS = { 'Stated in TSD': 'b-tsd', 'Derived from TSD condition': 'b-derived', 'Tester input (not in TSD)': 'b-tester', 'Needs confirmation': 'b-confirm' };
  function badge(text, cls) { return el('span', { class: 'badge ' + cls, text: text }); }

  function grid(headers, rows) {
    var t = el('table', { class: 'grid' });
    t.appendChild(el('thead', null, [el('tr', null, headers.map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody');
    rows.forEach(function (r) { tb.appendChild(el('tr', null, r.map(function (c) { var td = el('td'); if (c && c.nodeType) td.appendChild(c); else { td.textContent = c == null ? '' : c; td.className = 'pre'; } return td; }))); });
    t.appendChild(tb);
    return el('div', { class: 'table-wrap' }, [t]);
  }

  function showPreview() {
    ['step-upload', 'step-revision', 'step-summary', 'step-type'].forEach(function (x) { show(x, false); });
    show('step-preview', true);
    setStep(3);
    var p = state.preview;

    var v = $('validation'); clear(v);
    var vd = p.verdict;
    v.appendChild(el('h3', { text: 'Quality check (10 checks)' }));
    v.appendChild(el('div', { class: 'note ' + (vd.fail ? 'error' : vd.warn ? 'warn' : 'ok'), text: vd.verdict + ' \u2013 ' + vd.pass + ' passed, ' + vd.warn + ' to review, ' + vd.fail + ' failed.' }));
    var LBL = { pass: 'Pass', warn: 'Review', fail: 'Fail' };
    p.validation.forEach(function (c) {
      var d = el('details', { class: 'case check' });
      if (c.status !== 'pass') d.open = true;
      var sm = el('summary');
      sm.appendChild(badge(LBL[c.status] || c.status, 'b-' + c.status));
      sm.appendChild(document.createTextNode(' ' + c.id + '. ' + c.name));
      d.appendChild(sm);
      var body = el('div', { class: 'body' });
      body.appendChild(el('p', { text: c.detail }));
      var ul = el('ul', { class: 'plain' });
      (c.evidence || []).forEach(function (e) { ul.appendChild(el('li', { text: e })); });
      body.appendChild(ul);
      d.appendChild(body);
      v.appendChild(d);
    });

    var f = $('flags'); clear(f);
    if (p.flags.length) {
      f.appendChild(el('h3', { text: 'Items requiring your confirmation (' + p.flags.length + ')' }));
      p.flags.forEach(function (x) { f.appendChild(el('div', { class: 'note ' + (x.severity === 'error' ? 'error' : x.severity === 'warn' ? 'warn' : 'info'), text: (x.section ? x.section + ': ' : '') + x.text })); });
    }

    var c = $('cases'); clear(c);
    if (!p.testCases.length) c.appendChild(el('div', { class: 'note error', text: 'No test case could be generated from the TSD. Go back and add a scenario and the expected behaviour.' }));
    p.testCases.forEach(function (tc, i) {
      var d = el('details', { class: 'case' });
      if (i === 0) d.open = true;
      d.appendChild(el('summary', { text: tc.id + ' \u2013 ' + tc.scenario }));
      var body = el('div', { class: 'body' });
      body.appendChild(kvTable([['Test objective', tc.objective], ['Change reference', tc.changeRef]]));
      body.appendChild(el('h4', { text: 'Preconditions' }));
      var ul = el('ul', { class: 'plain' }); tc.preconditions.forEach(function (x) { ul.appendChild(el('li', { text: x })); }); body.appendChild(ul);
      body.appendChild(el('h4', { text: 'Test data' }));
      body.appendChild(grid(['Field / item', 'Value', 'Source'], tc.testData.map(function (t) { return [t.field, t.value, badge(t.source, BASIS_CLASS[t.source] || 'b-tester')]; })));
      body.appendChild(el('h4', { text: 'Execution steps' }));
      body.appendChild(grid(['#', 'Action', 'Expected', 'Evidence'], tc.steps.map(function (s) { return [String(s.n), s.action, s.expected, s.evidence]; })));
      body.appendChild(el('h4', { text: 'Expected results' }));
      body.appendChild(grid(['Expected result', 'Basis', 'TSD reference'], tc.expected.map(function (e) { return [e.text, badge(e.basis, BASIS_CLASS[e.basis] || 'b-tester'), e.ref]; })));
      body.appendChild(el('p', { class: 'hint', text: 'Actual results, status and evidence/screenshot areas are left blank for the tester in the Word document.' }));
      d.appendChild(body); c.appendChild(d);
    });

    var hasFail = p.validation.some(function (x) { return x.status === 'fail'; });
    $('p-approve').checked = false;
    $('p-approve').disabled = hasFail || !p.testCases.length;
    $('btn-download').disabled = true;
    if (hasFail) f.appendChild(el('div', { class: 'note error', text: 'The quality check has failures, so the document cannot be downloaded yet. Go back and provide the missing information.' }));
  }
  $('p-approve').addEventListener('change', function () {
    var on = $('p-approve').checked;
    apiJson('/api/approve', { approved: on }).then(function (r) { $('btn-download').disabled = !r.ok; }).catch(function (e) { $('p-approve').checked = false; $('btn-download').disabled = true; alertMsg(e.message); });
  });
  $('btn-back').addEventListener('click', function () { alertMsg(''); showType(); });

  $('btn-download').addEventListener('click', function () {
    alertMsg(''); busy(true, 'Building the Word document\u2026');
    api('/api/download', {}).then(function (r) {
      var name = 'TUT.docx';
      var m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '');
      if (m) name = m[1];
      return r.blob().then(function (b) {
        var url = URL.createObjectURL(b);
        var a = el('a', { href: url, download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        setStep(4);
        alertMsg('The Word document "' + name + '" was downloaded. It is fully editable.', 'info');
      });
    }).catch(function (e) { alertMsg(e.message); }).then(function () { busy(false); });
  });

  /* ----------------------------------------------------------- restart */
  $('btn-restart').addEventListener('click', function () {
    var id = state.sessionId;
    state = { sessionId: null, summary: null, revision: null, preview: null, stepIdx: 0 };
    if (id) fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
    ['step-revision', 'step-summary', 'step-type', 'step-preview'].forEach(function (x) { show(x, false); });
    show('step-upload', true); setFile(null); $('file').value = ''; alertMsg(''); setStep(0);
  });

  setStep(0);
})();
