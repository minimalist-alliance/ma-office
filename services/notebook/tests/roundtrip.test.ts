// The Agent's Markdown is exact (draft ADR "the Agent's tools and approvals" §17, Notebook: "Markdown round trips lossless
// on 1,000 pages"): pageMarkdown.ts writes a page, markdown.ts reads it back, and it's the same page, every block, mark,
// color and character; and writing what was read gives the same Markdown again. Then a corpus by hand of what agents
// write: headings, lists, tables, code, links, embeds (images), and what each becomes. Fake text only.
import { Node } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { fromMarkdown, readMarkdown } from '../src/markdown.ts';
import { cleanDoc, notebookSchema, type PMNode } from '../src/model.ts';
import { pageMarkdown } from '../src/pageMarkdown.ts';
import { randomPage } from './helpers/randomPages.ts';

/** As the schema has it, every default filled in: the shape two bodies are compared in. */
const norm = (doc: PMNode): unknown => Node.fromJSON(notebookSchema(), cleanDoc(doc)?.doc).toJSON();
const t = (text: string, ...marks: (string | { type: string; attrs?: Record<string, unknown> })[]): PMNode =>
  marks.length ? { type: 'text', text, marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) } : { type: 'text', text };
const p = (...content: PMNode[]): PMNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const page = (...content: PMNode[]): PMNode => ({ type: 'doc', content });

const PAGES = 1000;

describe('a page as Markdown reads back as the same page', () => {
  it(`${PAGES} random pages: every block, mark, color and character, and the Markdown again the same`, () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= PAGES; seed += 1) {
      const doc = randomPage(seed);
      expect(() => Node.fromJSON(notebookSchema(), doc).check(), `page ${seed} is a page`).not.toThrow();
      const md = pageMarkdown(doc);
      const back = fromMarkdown(md);
      if (JSON.stringify(norm(back)) !== JSON.stringify(norm(doc))) {
        failures.push(`page ${seed}`);
        if (failures.length === 1) {
          // The first failure in full, to fix it by.
          expect(norm(back), `page ${seed}:\n${md}`).toEqual(norm(doc));
        }
        continue;
      }
      expect(pageMarkdown(back), `page ${seed} again`).toBe(md);
    }
    expect(failures).toEqual([]);
  });

  it('what Markdown alone would lose: spaces at the ends, empty lines, line breaks, entities, a closing #', () => {
    const doc = page(
      { type: 'heading', attrs: { level: 1 }, content: [t('  Title with spaces #')] },
      p(),
      p(t(' lead and trail ')),
      p(t('a'), { type: 'hardBreak' }),
      p(t('&amp; is not &, and &#32; is not a space')),
      p(t('line\nbreak')),
      { type: 'heading', attrs: { level: 2 } },
      p(t('\ttab first')),
      { type: 'paragraph' },
    );
    const md = pageMarkdown(doc);
    expect(norm(fromMarkdown(md))).toEqual(norm(doc));
    expect(md).toContain('<p></p>');
    expect(md).toContain('&#32;lead and trail&#32;');
    expect(md).toContain('a<br>');
  });

  it('colors: highlights and text colors by name, a block by a line before it, an item after its marker', () => {
    const doc = page(
      { type: 'heading', attrs: { level: 1, color: 'blue' }, content: [t('Plan')] },
      p(t('lit', { type: 'highlight', attrs: { color: 'amber' } }), t(' and '), t('rose', { type: 'highlight', attrs: { color: 'rose' } }), t(' and '), t('old', { type: 'highlight', attrs: { color: 'yellow' } })),
      { type: 'paragraph', attrs: { color: 'violet' }, content: [t('A callout, with '), t('slate text', { type: 'textColor', attrs: { color: 'slate' } })] },
      { type: 'bulletList', content: [{ type: 'listItem', attrs: { color: 'green' }, content: [p(t('green item'))] }, { type: 'listItem', content: [p(t('plain item'))] }] },
      { type: 'codeBlock', attrs: { language: 'js', color: 'amber' }, content: [t('x()')] },
      { type: 'blockquote', attrs: { color: 'rose' }, content: [p(t('quoted'))] },
    );
    const md = pageMarkdown(doc);
    expect(md).toBe(
      [
        '{color=blue}',
        '# Plan',
        '',
        '<mark>lit</mark> and <mark data-color="rose">rose</mark> and <mark data-color="yellow">old</mark>',
        '',
        '{color=violet}',
        'A callout, with <span data-text-color="slate">slate text</span>',
        '',
        '- {color=green} green item',
        '- plain item',
        '',
        '{color=amber}',
        '```js',
        'x()',
        '```',
        '',
        '{color=rose}',
        '> quoted',
        '',
      ].join('\n'),
    );
    expect(norm(fromMarkdown(md))).toEqual(norm(doc));
  });

  it('lists of a kind side by side stay two lists, by taking turns with their markers', () => {
    const item = (s: string): PMNode => ({ type: 'listItem', content: [p(t(s))] });
    const doc = page(
      { type: 'bulletList', content: [item('a')] },
      { type: 'bulletList', content: [item('b')] },
      { type: 'orderedList', attrs: { start: 1 }, content: [item('c')] },
      { type: 'orderedList', attrs: { start: 1 }, content: [item('d')] },
    );
    const md = pageMarkdown(doc);
    expect(md).toBe('- a\n\n* b\n\n1. c\n\n1) d\n');
    expect(norm(fromMarkdown(md))).toEqual(norm(doc));
  });

  it('code keeps its tabs, blank lines and fences inside; inline code keeps its backticks and spaces', () => {
    const doc = page(
      { type: 'codeBlock', attrs: { language: 'go' }, content: [t('func f() {\n\treturn\n}\n\n```\nnot the end\n')] },
      p(t('a `tick`', 'code'), t(' and '), t(' spaced ', 'code'), t(' and '), t('``', 'code')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('in a list')), { type: 'codeBlock', attrs: { language: null }, content: [t('\tdeep\n   \nlast')] }] }] },
    );
    const md = pageMarkdown(doc);
    expect(md).toContain('````go\nfunc f() {\n\treturn\n}');
    expect(norm(fromMarkdown(md))).toEqual(norm(doc));
  });

  it('links keep their address and title, parentheses and spaces included', () => {
    const doc = page(p(t('one', { type: 'link', attrs: { href: 'https://example.com/a_(b)', title: 'Its "title"' } }), t(' two', { type: 'link', attrs: { href: 'http://example.org/with space' } })));
    const md = pageMarkdown(doc);
    expect(md).toBe(`[one](https://example.com/a_\\(b\\) 'Its "title"')[ two](<http://example.org/with space>)\n`);
    expect(norm(fromMarkdown(md))).toEqual(norm(doc));
  });
});

describe('what agents write, and what it becomes', () => {
  it('headings, lists, task lists and quotes as Markdown has them', () => {
    const { doc, converted } = readMarkdown('# Trip\n\n## Before\n\n- [ ] Book the train\n- [x] Pack\n  - socks\n\n1. One\n2. Two\n\n> Remember the passports.\n');
    expect(converted).toEqual([]);
    expect(norm(doc)).toEqual(
      norm(
        page(
          { type: 'heading', attrs: { level: 1 }, content: [t('Trip')] },
          { type: 'heading', attrs: { level: 2 }, content: [t('Before')] },
          {
            type: 'taskList',
            content: [
              { type: 'taskItem', attrs: { checked: false }, content: [p(t('Book the train'))] },
              { type: 'taskItem', attrs: { checked: true }, content: [p(t('Pack')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('socks'))] }] }] },
            ],
          },
          { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('One'))] }, { type: 'listItem', content: [p(t('Two'))] }] },
          { type: 'blockquote', content: [p(t('Remember the passports.'))] },
        ),
      ),
    );
  });

  it('a table has no node in the Notebook: its rows become lines, its cells apart, and the result says so', () => {
    const { doc, converted } = readMarkdown('| Item | Qty |\n|---|--:|\n| Tea | 2 |\n| Milk | 1 |\n');
    expect(converted).toEqual(['table']);
    expect(doc.content).toEqual([p(t('Item | Qty')), p(t('Tea | 2')), p(t('Milk | 1'))]);
    // Read back and written again, it stays what it became: nothing more is lost.
    const again = fromMarkdown(pageMarkdown(doc));
    expect(norm(again)).toEqual(norm(doc));
  });

  it('an image (an embed) becomes a link to it, its alt text the link; other HTML stays as text; both said', () => {
    const r = readMarkdown('![A cat](https://example.com/cat.png) ![](https://example.com/dog.png) ![local](file:///x.png)\n\n<div>raw</div>\n\n#### Deep\n');
    expect(r.converted).toEqual(['image', 'html', 'heading_level']);
    expect(r.doc.content?.[0]).toEqual(
      p(
        t('A cat', { type: 'link', attrs: { href: 'https://example.com/cat.png' } }),
        t(' '),
        t('https://example.com/dog.png', { type: 'link', attrs: { href: 'https://example.com/dog.png' } }),
        t(' local'),
      ),
    );
    expect(r.doc.content?.[1]).toEqual(p(t('<div>raw</div>')));
    expect(r.doc.content?.[2]).toEqual({ type: 'heading', attrs: { level: 3 }, content: [t('Deep')] });
  });

  it('code with its language, links, autolinks, and marks in any of their spellings', () => {
    const { doc, converted } = readMarkdown(
      '```python\nprint("hi")\n```\n\nSee [the docs](https://example.com/docs "Docs") or <https://example.org>, **bold**, __bold__, *it*, _it_, ~~gone~~, `code`, <u>u</u>, <mark>m</mark>.\n',
    );
    expect(converted).toEqual([]);
    expect(doc.content?.[0]).toEqual({ type: 'codeBlock', attrs: { language: 'python' }, content: [t('print("hi")')] });
    const marks = (doc.content?.[1]?.content ?? []).filter((n) => n.marks).map((n) => [n.text, (n.marks ?? []).map((m) => m.type).join('+')]);
    expect(marks).toEqual([
      ['the docs', 'link'],
      ['https://example.org', 'link'],
      ['bold', 'bold'],
      ['bold', 'bold'],
      ['it', 'italic'],
      ['it', 'italic'],
      ['gone', 'strike'],
      ['code', 'code'],
      ['u', 'underline'],
      ['m', 'highlight'],
    ]);
    expect(doc.content?.[1]?.content?.[1]?.marks?.[0]).toEqual({ type: 'link', attrs: { href: 'https://example.com/docs', title: 'Docs' } });
  });

  it("Markdown from elsewhere reads the same however it's spelled: what was read is what an agent writes back", () => {
    // Whatever an agent writes, reading the page and writing that back changes nothing more.
    for (const md of [
      'Setext\n===\n\nAnd\n---\n',
      '* star\n+ plus\n- dash\n',
      '1) paren\n2) paren\n',
      'Hard  \nbreak and soft\nbreak\n',
      '> quote\nlazy line\n\n> - [ ] in a quote\n',
      '- a\n\n- b\n\n  para in b\n',
      '~~~\n```\n~~~\n',
      'Tab\tinside and nbsp\n',
      '| a | b |\n|---|---|\n| 1 | 2 |\n',
    ]) {
      const once = fromMarkdown(md);
      const written = pageMarkdown(once);
      expect(norm(fromMarkdown(written)), JSON.stringify(md)).toEqual(norm(once));
      expect(pageMarkdown(fromMarkdown(written)), JSON.stringify(md)).toBe(written);
    }
  });
});
