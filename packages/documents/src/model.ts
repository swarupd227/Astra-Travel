/** A document as structured content: rendered to plain text (for storage and checks) and to PDF. */

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'pairs'; rows: [string, string][] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'pagebreak' };

export interface DocModel {
  title: string;
  subtitle?: string | undefined;
  blocks: Block[];
}

/** The plain text of a document: what the PDF says, in reading order. */
export function toText(doc: DocModel): string {
  const lines: string[] = [doc.title];
  if (doc.subtitle) lines.push(doc.subtitle);
  for (const b of doc.blocks) {
    lines.push('');
    if (b.kind === 'heading') lines.push(b.text.toUpperCase());
    else if (b.kind === 'paragraph') lines.push(b.text);
    else if (b.kind === 'pairs') for (const [k, v] of b.rows) lines.push(`${k}: ${v}`);
    else if (b.kind === 'table') {
      lines.push(b.head.join(' | '));
      for (const r of b.rows) lines.push(r.join(' | '));
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A filed form's assembled text as paragraphs: blank lines separate them, single line breaks are kept. */
export function paragraphs(text: string): Block[] {
  return text
    .split(/\f/)
    .flatMap((page, i) => [...(i > 0 ? ([{ kind: 'pagebreak' }] as Block[]) : []), ...page.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p): Block => ({ kind: 'paragraph', text: p }))]);
}
