'use strict';

const JSZip = require('jszip');

/**
 * Structural check of a generated .docx (used by validation check 9). It reads the real OOXML, so it verifies
 * what is in the file, not what the generator intended.
 */
async function inspectDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : '');
  const doc = await read('word/document.xml');
  const headers = Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n));
  const footers = Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n));
  let footerXml = '';
  for (const f of footers) footerXml += await read(f);

  const rows = (doc.match(/<w:tr[ >]/g) || []).length;
  const cantSplit = (doc.match(/<w:cantSplit\b/g) || []).length;
  const headerRows = (doc.match(/<w:tblHeader\b/g) || []).length;
  const tables = (doc.match(/<w:tbl>/g) || []).length;
  const pageBreaks = (doc.match(/<w:pageBreakBefore\b/g) || []).length + (doc.match(/<w:br w:type="page"/g) || []).length;
  const headings = (doc.match(/<w:pStyle w:val="Heading[1-3]"/g) || []).length;

  const fonts = new Set();
  for (const m of doc.matchAll(/w:ascii="([^"]+)"/g)) fonts.add(m[1]);
  const styles = await read('word/styles.xml');
  for (const m of styles.matchAll(/w:ascii="([^"]+)"/g)) fonts.add(m[1]);

  // Paragraph sequence at body level (outside tables) to find consecutive empty paragraphs and empty-before-break.
  const body = doc.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '<TABLE/>');
  const parts = body.match(/<w:p[ >][\s\S]*?<\/w:p>|<TABLE\/>/g) || [];
  const isEmpty = (p) => p !== '<TABLE/>' && !/<w:t[ >]/.test(p) && !/<w:t>/.test(p) && !/<w:drawing/.test(p);
  let emptyRuns = 0;
  let emptyBeforeBreak = 0;
  for (let i = 0; i < parts.length; i++) {
    if (isEmpty(parts[i]) && i + 1 < parts.length && isEmpty(parts[i + 1])) emptyRuns++;
    if (isEmpty(parts[i]) && i + 1 < parts.length && /<w:pageBreakBefore\b/.test(parts[i + 1])) emptyBeforeBreak++;
  }

  return {
    hasHeader: headers.length > 0,
    hasFooter: footers.length > 0,
    hasPageField: /PAGE/.test(footerXml),
    tables,
    rows,
    rowsCantSplit: cantSplit,
    headerRows,
    fonts: Array.from(fonts).sort(),
    headings,
    pageBreaks,
    emptyRuns,
    emptyBeforeBreak
  };
}

module.exports = { inspectDocx };
