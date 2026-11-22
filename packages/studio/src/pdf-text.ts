/**
 * Text of a filed form. PDFs are read with pdf.js (no script evaluation, no fonts loaded); plain text is
 * taken as is. Pages are kept as offsets so each variable can say which page its wording is on.
 */

export interface FormText {
  text: string;
  pageStarts: number[];
}

export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableDocumentError';
  }
}

export async function extractText(data: Uint8Array, contentType: string): Promise<FormText> {
  if (contentType === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n');
    const pageStarts = [0];
    // A form feed marks a page break in text exports.
    for (let i = text.indexOf('\f'); i >= 0; i = text.indexOf('\f', i + 1)) pageStarts.push(i + 1);
    return { text, pageStarts };
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Text extraction only: no fonts are loaded and nothing is rendered.
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new UnreadableDocumentError(`The PDF could not be read: ${(err as Error).message}`);
  }
  try {
    let text = '';
    const pageStarts: number[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (p > 1) text += '\f';
      pageStarts.push(text.length);
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      page.cleanup();
    }
    if (text.replace(/\s/g, '').length === 0) {
      throw new UnreadableDocumentError(
        'The PDF has no text layer (it may be a scan). Load a text PDF or a text export.',
      );
    }
    return { text, pageStarts };
  } finally {
    await task.destroy();
  }
}
