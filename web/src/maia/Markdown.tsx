// Maia's reply as React elements, from `markdown.ts`'s tree. Text is only ever a text node: nothing in this folder
// writes HTML from a string, so nothing she writes can become markup. Links open in their own tab, as the account
// menu's does, because leaving this one would close the member's windows.
import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown';

function inline(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'br':
        return <br key={k} />;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'strong':
        return <strong key={k}>{inline(n.c, `${k}.`)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.c, `${k}.`)}</em>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {inline(n.c, `${k}.`)}
          </a>
        );
    }
  });
}

function block(b: Block, k: number | string): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={k}>{inline(b.c)}</p>;
    case 'h': {
      const Tag = b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5';
      return <Tag key={k}>{inline(b.c)}</Tag>;
    }
    case 'code':
      return (
        <pre key={k}>
          <code>{b.v}</code>
        </pre>
      );
    case 'list': {
      const items = b.items.map((item, i) => <li key={i}>{item.map((c, j) => block(c, j))}</li>);
      return b.ordered ? (
        <ol key={k} start={b.start === 1 ? undefined : b.start}>
          {items}
        </ol>
      ) : (
        <ul key={k}>{items}</ul>
      );
    }
    case 'quote':
      return <blockquote key={k}>{b.c.map((c, j) => block(c, j))}</blockquote>;
    case 'hr':
      return <hr key={k} />;
  }
}

export function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => block(b, i));
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <>{renderBlocks(blocks)}</>;
});
