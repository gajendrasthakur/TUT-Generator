'use strict';

const { norm } = require('./text');

const MAX_PAGES = 400;

/**
 * Reads a PDF TSD into the same block model used for DOCX (paragraph blocks only - PDF tables cannot be
 * recovered reliably, so table-driven facts are flagged as lower confidence by the analyser).
 */
async function readPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  });
  const pdf = await loadingTask.promise;
  const blocks = [];
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const ys = Array.from(rows.keys()).sort((a, b) => b - a);
    for (const y of ys) {
      const text = rows
        .get(y)
        .sort((a, b) => a.x - b.x)
        .map((c) => c.s)
        .join(' ');
      const t = norm(text);
      if (t) blocks.push({ type: 'p', text: t, style: '', hadTab: false, oles: [] });
    }
    page.cleanup();
  }
  await loadingTask.destroy();
  return { format: 'pdf', blocks, embeds: {}, stats: { pages: pdf.numPages, embeddedObjects: 0, images: 0 } };
}

module.exports = { readPdf };
