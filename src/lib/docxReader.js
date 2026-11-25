'use strict';

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const { norm } = require('./text');

const LIMITS = {
  maxEntryBytes: 60 * 1024 * 1024, // single decompressed part
  maxTotalBytes: 400 * 1024 * 1024, // all parts together (zip-bomb guard)
  maxEmbeddedBytes: 25 * 1024 * 1024,
  maxEmbeddedDocs: 40,
  maxSheetRows: 3000,
  maxSheetCols: 40
};

function parseXml(xml) {
  // Reject DTDs/entities outright - Office files never need them (XXE / billion-laughs guard).
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Unsupported XML content');
  }
  return new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
}

function kids(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
  return out;
}

function byLocal(node, name) {
  return kids(node).filter((k) => k.localName === name);
}

function attr(node, local) {
  if (!node || !node.attributes) return null;
  for (let i = 0; i < node.attributes.length; i++) {
    const a = node.attributes[i];
    if ((a.localName || a.name.split(':').pop()) === local) return a.value;
  }
  return null;
}

async function readPart(zip, name) {
  const f = zip.file(name);
  if (!f) return null;
  return f.async('string');
}

async function assertSafeZip(zip) {
  let total = 0;
  zip.forEach((p, entry) => {
    const sz = entry && entry._data && Number.isFinite(entry._data.uncompressedSize) ? entry._data.uncompressedSize : 0;
    if (sz > LIMITS.maxEntryBytes) throw new Error('Document part is too large');
    total += sz;
  });
  if (total > LIMITS.maxTotalBytes) throw new Error('Document is too large when decompressed');
}

/* ---------------------------------------------------------------- text */

function runStruck(r) {
  const rPr = byLocal(r, 'rPr')[0];
  if (!rPr) return false;
  for (const name of ['strike', 'dstrike']) {
    const s = byLocal(rPr, name)[0];
    if (s) {
      const v = (attr(s, 'val') || '').toLowerCase();
      if (v !== '0' && v !== 'false' && v !== 'off') return true;
    }
  }
  return false;
}

/**
 * Text of a w:p. Skips textboxes / mc:Fallback to avoid duplicated diagram text.
 * Struck-through runs are returned separately in `struck` (TSD authors strike out content that was removed).
 */
function paragraphText(p) {
  let out = '';
  let struck = '';
  let hadTab = false;
  const walk = (n, isStruck) => {
    for (const c of kids(n)) {
      const ln = c.localName;
      const add = (s) => {
        if (isStruck) struck += s;
        else out += s;
      };
      if (ln === 'r') walk(c, isStruck || runStruck(c));
      else if (ln === 't') add(c.textContent);
      else if (ln === 'tab') {
        add(' ');
        hadTab = true;
      } else if (ln === 'br' || ln === 'cr') add('\n');
      else if (ln === 'noBreakHyphen') add('-');
      else if (ln === 'rPr' || ln === 'txbxContent' || ln === 'Fallback' || ln === 'delText' || ln === 'instrText') continue;
      else walk(c, isStruck);
    }
  };
  walk(p, false);
  return { text: out, struck, hadTab };
}

function paragraphStyle(p) {
  const pPr = byLocal(p, 'pPr')[0];
  if (!pPr) return '';
  const ps = byLocal(pPr, 'pStyle')[0];
  return ps ? attr(ps, 'val') || '' : '';
}

function findOleRelIds(p) {
  const ids = [];
  const walk = (n) => {
    for (const c of kids(n)) {
      if (c.localName === 'OLEObject') {
        const rid = attr(c, 'id');
        if (rid) ids.push({ rid, progId: attr(c, 'ProgID') || '' });
      } else if (c.localName === 'object' || c.localName === 'r' || c.localName === 'pict' || c.localName === 'AlternateContent' || c.localName === 'Choice' || c.localName === 'hyperlink' || c.localName === 'ins' || c.localName === 'smartTag') {
        walk(c);
      }
    }
  };
  walk(p);
  return ids;
}

/* ---------------------------------------------------------------- body */

function readTable(tbl, ctx) {
  const rows = [];
  for (const tr of byLocal(tbl, 'tr')) {
    const cells = [];
    for (const tc of byLocal(tr, 'tc')) {
      const parts = [];
      const struckParts = [];
      const embeds = [];
      for (const el of kids(tc)) {
        if (el.localName === 'p') {
          const pt = paragraphText(el);
          parts.push(pt.text);
          if (pt.struck.trim()) struckParts.push(pt.struck);
          for (const o of findOleRelIds(el)) embeds.push(o);
        } else if (el.localName === 'tbl') {
          // nested table -> flatten rows
          for (const r of readTable(el, ctx)) {
            parts.push(r.cells.join(' | '));
            if (r.struck.some(Boolean)) struckParts.push(r.struck.filter(Boolean).join(' | '));
          }
        }
      }
      cells.push({ text: parts.join('\n'), struck: struckParts.join('\n'), embeds });
    }
    rows.push({ cells: cells.map((c) => c.text), struck: cells.map((c) => c.struck), embeds: cells.flatMap((c) => c.embeds) });
  }
  return rows;
}

function walkBody(container, blocks, ctx) {
  for (const el of kids(container)) {
    const ln = el.localName;
    if (ln === 'p') {
      const { text, struck, hadTab } = paragraphText(el);
      blocks.push({
        type: 'p',
        text,
        struck,
        style: paragraphStyle(el),
        hadTab,
        oles: findOleRelIds(el)
      });
    } else if (ln === 'tbl') {
      const rows = readTable(el, ctx);
      blocks.push({
        type: 'tbl',
        rows: rows.map((r) => r.cells),
        struckRows: rows.map((r) => r.struck),
        oles: rows.flatMap((r) => r.embeds)
      });
    } else if (ln === 'sdt') {
      const content = byLocal(el, 'sdtContent')[0];
      if (content) walkBody(content, blocks, ctx);
    }
  }
}

/* ---------------------------------------------------------------- rels */

function parseRels(xml) {
  const map = {};
  if (!xml) return map;
  const doc = parseXml(xml);
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    map[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type') || '' };
  }
  return map;
}

/* ---------------------------------------------------------------- xlsx */

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsx(buf) {
  const zip = await JSZip.loadAsync(buf);
  await assertSafeZip(zip);
  const wbXml = await readPart(zip, 'xl/workbook.xml');
  if (!wbXml) return null;
  const wbRels = parseRels(await readPart(zip, 'xl/_rels/workbook.xml.rels'));
  const wb = parseXml(wbXml);

  const shared = [];
  const ssXml = await readPart(zip, 'xl/sharedStrings.xml');
  if (ssXml) {
    const ss = parseXml(ssXml);
    const sis = ss.getElementsByTagName('si');
    for (let i = 0; i < sis.length; i++) {
      const ts = sis[i].getElementsByTagName('t');
      let s = '';
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent;
      shared.push(s);
    }
  }

  const sheets = [];
  const sheetEls = wb.getElementsByTagName('sheet');
  for (let i = 0; i < sheetEls.length; i++) {
    const se = sheetEls[i];
    const name = se.getAttribute('name');
    const rid = attr(se, 'id');
    const rel = wbRels[rid];
    if (!rel) continue;
    const path = 'xl/' + rel.target.replace(/^\/?(xl\/)?/, '');
    const xml = await readPart(zip, path);
    if (!xml) continue;
    const doc = parseXml(xml);
    const rowEls = doc.getElementsByTagName('row');
    const rows = [];
    for (let r = 0; r < rowEls.length && rows.length < LIMITS.maxSheetRows; r++) {
      const cells = [];
      const cEls = rowEls[r].getElementsByTagName('c');
      let any = false;
      for (let c = 0; c < cEls.length; c++) {
        const ce = cEls[c];
        const idx = colIndex(ce.getAttribute('r'));
        if (idx >= LIMITS.maxSheetCols) continue;
        const t = ce.getAttribute('t');
        let val = '';
        if (t === 'inlineStr') {
          const ts = ce.getElementsByTagName('t');
          for (let j = 0; j < ts.length; j++) val += ts[j].textContent;
        } else {
          const v = ce.getElementsByTagName('v')[0];
          if (v) val = t === 's' ? shared[parseInt(v.textContent, 10)] || '' : v.textContent;
        }
        val = norm(val);
        if (val) any = true;
        cells[idx] = val;
      }
      if (any) {
        for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
        rows.push(cells);
      }
    }
    sheets.push({ name: norm(name), rows });
  }
  return { kind: 'xlsx', sheets };
}

/* -------------------------------------------------------- embedded docx */

async function readEmbeddedDocxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  await assertSafeZip(zip);
  const xml = await readPart(zip, 'word/document.xml');
  if (!xml) return null;
  const doc = parseXml(xml);
  const body = doc.getElementsByTagName('w:body')[0] || doc.documentElement;
  const blocks = [];
  walkBody(body, blocks, {});
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'p') {
      const t = norm(b.text);
      if (t) lines.push(t);
    } else {
      for (const r of b.rows) lines.push(r.map(norm).join(' | '));
    }
  }
  return { kind: 'docx', lines: lines.slice(0, 600) };
}

/* ---------------------------------------------------------------- main */

/**
 * Reads a TSD .docx. Returns an ordered list of blocks plus embedded-object info.
 * blocks: {type:'p', text, style, hadTab, oles} | {type:'tbl', rows, oles}
 * embeds: map rid -> {name, kind, ...}
 */
async function readDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  await assertSafeZip(zip);
  const docXml = await readPart(zip, 'word/document.xml');
  if (!docXml) throw new Error('Not a valid Word document');

  const rels = parseRels(await readPart(zip, 'word/_rels/document.xml.rels'));
  const doc = parseXml(docXml);
  const body = doc.getElementsByTagName('w:body')[0];
  if (!body) throw new Error('Not a valid Word document');

  const blocks = [];
  walkBody(body, blocks, {});

  // Resolve embedded Excel / Word objects that are referenced from the body.
  const embeds = {};
  const wanted = new Set();
  for (const b of blocks) for (const o of b.oles || []) wanted.add(o.rid);
  let loaded = 0;
  for (const rid of wanted) {
    const rel = rels[rid];
    if (!rel) continue;
    const target = rel.target.replace(/^\/?(word\/)?/, 'word/');
    const name = target.split('/').pop();
    const info = { name, kind: 'other' };
    if (/\.xlsx$/i.test(name) || /\.docx$/i.test(name)) {
      const f = zip.file(target);
      const size = f && f._data && f._data.uncompressedSize;
      if (f && loaded < LIMITS.maxEmbeddedDocs && (!size || size <= LIMITS.maxEmbeddedBytes)) {
        try {
          const buf = await f.async('nodebuffer');
          loaded++;
          const parsed = /\.xlsx$/i.test(name) ? await readXlsx(buf) : await readEmbeddedDocxText(buf);
          if (parsed) Object.assign(info, parsed);
        } catch (e) {
          info.error = true;
        }
      }
    } else if (/\.bin$/i.test(name)) {
      info.kind = 'package';
    }
    embeds[rid] = info;
  }

  const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/')).length;
  return { format: 'docx', blocks, embeds, stats: { embeddedObjects: Object.keys(embeds).length, images: media } };
}

module.exports = { readDocx, readXlsx, LIMITS };
