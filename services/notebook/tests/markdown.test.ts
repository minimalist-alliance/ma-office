// Markdown into a page body (src/markdown.ts), for the Agent's Notebook tools: what each construct becomes, that what
// export.ts writes reads back as the same page, and that no input throws or makes a body the schema refuses.
import { Node } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { fromMarkdown, inline, plainText } from '../src/markdown.ts';
import { cleanDoc, notebookSchema, toMarkdown, type PMNode } from '../src/model.ts';

const md = (text: string): PMNode[] => fromMarkdown(text).content ?? [];
const t = (text: string, ...marks: string[]): PMNode => (marks.length ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text });
/** As the schema has it, every default filled in: the shape two bodies are compared in. */
const norm = (doc: PMNode): unknown => Node.fromJSON(notebookSchema(), cleanDoc(doc)?.doc).toJSON();

describe('blocks', () => {
  it('headings: # is the Title, ## and ### below it, deeper ones are ###; setext too', () => {
    expect(md('# Plan\n## Week\n### Day\n#### Hour ##')).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [t('Plan')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('Week')] },
      { type: 'heading', attrs: { level: 3 }, content: [t('Day')] },
      { type: 'heading', attrs: { level: 3 }, content: [t('Hour')] },
    ]);
    expect(md('Plan\n===\n\nWeek\n---')).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [t('Plan')] },
      { type: 'heading', attrs: { level: 2 }, content: [t('Week')] },
    ]);
    expect(md('#hashtag')).toEqual([{ type: 'paragraph', content: [t('#hashtag')] }]);
    // A rule after a list ends it, though it looks like an item.
    expect(md('- a\n- - -\n* b').map((b) => b.type)).toEqual(['bulletList', 'horizontalRule', 'bulletList']);
  });

  it('paragraphs: lines join with a space; two spaces or a backslash at a line end is a hard break', () => {
    expect(md('one\ntwo\n\nthree  \nfour\\\nfive')).toEqual([
      { type: 'paragraph', content: [t('one two')] },
      { type: 'paragraph', content: [t('three'), { type: 'hardBreak' }, t('four'), { type: 'hardBreak' }, t('five')] },
    ]);
  });

  it('lists: bulleted, numbered from their start, task lists with their boxes, nested', () => {
    expect(md('- a\n- b\n  - b1\n\n3. c\n4. d\n\n- [ ] todo\n- [x] done')).toEqual([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('a')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('b')] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('b1')] }] }] }] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('c')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [t('d')] }] },
        ],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [t('todo')] }] },
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [t('done')] }] },
        ],
      },
    ]);
  });

  it("an item's first block is a paragraph, as the schema wants", () => {
    const [list] = md('- ## Heading item\n- \n- ```\n  code\n  ```');
    expect(list?.content?.map((item) => item.content?.[0]?.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(list?.content?.[2]?.content?.[1]).toMatchObject({ type: 'codeBlock' });
    expect(cleanDoc({ type: 'doc', content: md('- ## Heading item\n- \n- ```\n  code\n  ```') })).not.toBeNull();
  });

  it('quotes, fenced code with its language, rules', () => {
    expect(md('> quoted **here**\n> - and a list\n\n```ts\nconst a = 1;\n\n```\n\n~~~\n```inside```\n~~~\n\n---\n***')).toEqual([
      {
        type: 'blockquote',
        content: [
          { type: 'paragraph', content: [t('quoted '), t('here', 'bold')] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('and a list')] }] }] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\n')] },
      { type: 'codeBlock', attrs: { language: null }, content: [t('```inside```')] },
      { type: 'horizontalRule' },
      { type: 'horizontalRule' },
    ]);
  });

  it('a table has no node here: each row is a paragraph, its cells apart', () => {
    expect(md('| Name | Qty |\n|---|---:|\n| Tea | 2 |\n| Milk | 1 |\n\nAfter')).toEqual([
      { type: 'paragraph', content: [t('Name | Qty')] },
      { type: 'paragraph', content: [t('Tea | 2')] },
      { type: 'paragraph', content: [t('Milk | 1')] },
      { type: 'paragraph', content: [t('After')] },
    ]);
  });

  it('nothing in it is no blocks', () => {
    expect(md('')).toEqual([]);
    expect(md('\n  \n\t\n')).toEqual([]);
  });
});

describe('inline', () => {
  it('bold, italic, strikethrough, code, underline and highlight', () => {
    expect(inline('**b** *i* _i_ ~~s~~ `c` <u>u</u> <mark>m</mark>')).toEqual([
      t('b', 'bold'),
      t(' '),
      t('i', 'italic'),
      t(' '),
      t('i', 'italic'),
      t(' '),
      t('s', 'strike'),
      t(' '),
      t('c', 'code'),
      t(' '),
      t('u', 'underline'),
      t(' '),
      t('m', 'highlight'),
    ]);
    expect(inline('***both***')).toEqual([{ type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] }]);
    expect(inline('**bold with `code` in it**')).toEqual([t('bold with ', 'bold'), t('code', 'code'), t(' in it', 'bold')]);
  });

  it('what only looks like emphasis stays text', () => {
    expect(inline('snake_case_name and 2 * 3 * 4 and ~5 min')).toEqual([t('snake_case_name and 2 * 3 * 4 and ~5 min')]);
    expect(inline('\\*not\\* \\_this\\_ \\# \\\\')).toEqual([t('*not* _this_ # \\')]);
    expect(inline('**unclosed')).toEqual([t('**unclosed')]);
    expect(inline('<b>bold</b> <div>raw</div> &amp; &lt;x&gt; &#169;')).toEqual([t('bold', 'bold'), t(' <div>raw</div> & <x> ©')]);
  });

  it('links: the scheme decides; an image is its alt text', () => {
    expect(inline('[site](https://example.com/a_(b)) and <https://example.org> and <me@example.com>')).toEqual([
      { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com/a_(b)' } }] },
      t(' and '),
      { type: 'text', text: 'https://example.org', marks: [{ type: 'link', attrs: { href: 'https://example.org' } }] },
      t(' and '),
      { type: 'text', text: 'me@example.com', marks: [{ type: 'link', attrs: { href: 'mailto:me@example.com' } }] },
    ]);
    expect(inline('[click](javascript:alert(1)) ![a cat](https://example.com/cat.png) [no link]')).toEqual([t('click a cat [no link]')]);
    expect(inline('[**bold** link](https://example.com "title")')).toEqual([
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }] },
      { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
    ]);
  });

  it('plain text of a block', () => {
    expect(plainText(md('## The **plan**')[0] as PMNode)).toBe('The plan');
    expect(plainText(md('- a\n- b')[0] as PMNode)).toBe('a\nb');
  });
});

describe('what export.ts writes reads back as the same page', () => {
  it('every block and mark the schema has', () => {
    const page: PMNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [t('Trip plan')] },
        { type: 'paragraph', content: [t('Mostly '), t('bold', 'bold'), t(', '), t('italic', 'italic'), t(', '), t('gone', 'strike'), t(', '), t('under', 'underline'), t(', '), t('lit', 'highlight'), t(' and '), t('code()', 'code'), t('.')] },
        { type: 'paragraph', content: [t('A '), { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com/x?y=1&z=2' } }] }, t(' then'), { type: 'hardBreak' }, t('a new line, with * and _ and [brackets] and #.')] },
        { type: 'heading', attrs: { level: 2 }, content: [t('Lists')] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [t('one')] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('one.one')] }] }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [t('two')] }] },
          ],
        },
        { type: 'orderedList', attrs: { start: 4 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('four')] }] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [t('packed')] }] }, { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [t('tickets')] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [t('A quote.')] }] },
        { type: 'codeBlock', attrs: { language: 'sh' }, content: [t('echo "hi"\nls -la')] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [t('- not a list, # not a heading, 1. not numbered')] },
        { type: 'heading', attrs: { level: 3 }, content: [t('End')] },
      ],
    };
    const back = fromMarkdown(toMarkdown(page));
    expect(norm(back)).toEqual(norm(page));
  });
});

describe('any input', () => {
  it('never throws, and always makes a body the schema takes', () => {
    const alphabet = ['*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '#', '-', '+', '1.', '|', '!', '\\', '\n', '\n\n', ' ', '  ', '\t', 'a', 'b', 'x', '[ ]', '> ', '- ', '```', 'http://x', '&amp;', '<u>', '</u>', '<mark>', '‮'];
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 600; i += 1) {
      let s = '';
      const len = 1 + rnd(60);
      for (let j = 0; j < len; j += 1) s += alphabet[rnd(alphabet.length)];
      const doc = fromMarkdown(s);
      expect(cleanDoc(doc), JSON.stringify(s)).not.toBeNull();
      expect(() => Node.fromJSON(notebookSchema(), cleanDoc(doc)?.doc).check(), JSON.stringify(s)).not.toThrow();
    }
  });

  it('64 Ki of what makes parsers slow is still quick', () => {
    for (const unit of ['*', '_a', '[', '`', '> ', '- ', '[a](', '**a', '<', '\\']) {
      const s = unit.repeat(Math.ceil(65_536 / unit.length)).slice(0, 65_536);
      const started = performance.now();
      const doc = fromMarkdown(s);
      expect(performance.now() - started, unit).toBeLessThan(3000);
      expect(cleanDoc(doc), unit).not.toBeNull();
    }
  });
});
