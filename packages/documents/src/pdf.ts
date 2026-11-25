import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Block, DocModel } from './model';

/** Renders a document to PDF with the standard fonts, so every traveller can open it anywhere. */

const PAGE = { w: 612, h: 792, margin: 54 };
const SIZE = { title: 18, subtitle: 10, heading: 12, body: 10 };
const LINE = 1.35;

/** The text as the PDF's standard font can draw it: typographic characters it knows are kept, others become "?". */
export function pdfSafe(s: string, font: PDFFont): string {
  const norm = s.replaceAll(String.fromCharCode(160), ' ').replace(/\t/g, '    ');
  let out = '';
  for (const ch of norm) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        // A word longer than the line is broken where it must be.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          lines.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderPdf(doc: DocModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  pdf.setProducer('Astra Travel');
  pdf.setCreator('Astra Travel');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE.w - 2 * PAGE.margin;
  let page: PDFPage = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;

  const ensure = (needed: number) => {
    if (y - needed < PAGE.margin) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
    }
  };
  const draw = (text: string, f: PDFFont, size: number, x = PAGE.margin, w = width, color = rgb(0, 0, 0)) => {
    for (const l of wrap(pdfSafe(text, f), f, size, w)) {
      ensure(size * LINE);
      y -= size * LINE;
      if (l) page.drawText(l, { x, y, size, font: f, color });
    }
  };

  draw(doc.title, bold, SIZE.title);
  if (doc.subtitle) draw(doc.subtitle, font, SIZE.subtitle, PAGE.margin, width, rgb(0.3, 0.3, 0.3));
  y -= 8;

  const block = (b: Block) => {
    if (b.kind === 'pagebreak') {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
      return;
    }
    y -= 6;
    if (b.kind === 'heading') {
      ensure(SIZE.heading * LINE * 2);
      draw(b.text.toUpperCase(), bold, SIZE.heading);
    } else if (b.kind === 'paragraph') {
      draw(b.text, font, SIZE.body);
    } else if (b.kind === 'pairs') {
      for (const [k, v] of b.rows) {
        const labelW = 150;
        const lines = wrap(pdfSafe(v, font), font, SIZE.body, width - labelW);
        ensure(SIZE.body * LINE * Math.max(1, lines.length));
        const top = y;
        draw(`${k}:`, bold, SIZE.body, PAGE.margin, labelW - 6);
        const after = y;
        y = top;
        for (const l of lines) {
          y -= SIZE.body * LINE;
          if (l) page.drawText(l, { x: PAGE.margin + labelW, y, size: SIZE.body, font });
        }
        y = Math.min(y, after);
      }
    } else {
      const cols = b.head.length;
      const cw = width / cols;
      const row = (cells: string[], f: PDFFont) => {
        const wrapped = cells.map((c) => wrap(pdfSafe(c, f), f, SIZE.body - 1, cw - 6));
        const h = Math.max(...wrapped.map((l) => l.length)) * (SIZE.body - 1) * LINE;
        ensure(h + 4);
        const top = y;
        wrapped.forEach((lines, i) => {
          let yy = top;
          for (const l of lines) {
            yy -= (SIZE.body - 1) * LINE;
            if (l) page.drawText(l, { x: PAGE.margin + i * cw, y: yy, size: SIZE.body - 1, font: f });
          }
        });
        y = top - h - 4;
      };
      row(b.head, bold);
      for (const r of b.rows) row(r, font);
    }
  };
  for (const b of doc.blocks) block(b);
  return pdf.save();
}
