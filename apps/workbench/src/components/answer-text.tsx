import type { ReactNode } from 'react';

/**
 * Renders an agent answer: paragraphs and "- " bullet lists, as plain text. Nothing is interpreted as
 * HTML, so agent output can never inject markup.
 */
export function AnswerText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(
        <p key={`p${blocks.length}`} className="leading-7">
          {para.join(' ')}
        </p>,
      );
      para = [];
    }
    if (list.length) {
      blocks.push(
        <ul
          key={`l${blocks.length}`}
          className="list-disc space-y-1 pl-5 leading-7 marker:text-subtle"
        >
          {list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]!);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="space-y-3 text-[15px] text-fg">{blocks}</div>;
}
