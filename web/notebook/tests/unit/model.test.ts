// The pure parts: deriving titles and counts, export, search's folding, history rules, days, themes.
import { describe, expect, it } from 'vitest';
import { addDays, dayKey, monthCells, stepActiveDay } from '../../src/model/days.ts';
import { countWords, derive } from '../../src/model/derive.ts';
import { fileName, safeHref, toHtmlBody, toHtmlDocument, toMarkdown } from '../../src/model/export.ts';
import { versionAt, versionsToPrune } from '../../src/model/history.ts';
import type { PMNode } from '../../src/model/schema.ts';
import { fold, parseQuery, SearchIndex } from '../../src/model/search.ts';
import type { VersionMeta } from '../../src/model/types.ts';
import { NOTEBOOK_THEMES, notebookThemeCss, THEME_IDS } from '../../src/theme/tokens.ts';

const t = (text: string, ...marks: string[]): PMNode => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const para = (...c: PMNode[]): PMNode => ({ type: 'paragraph', content: c });

const SAMPLE: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Trip to Lisbon')] },
    para(t('Book the '), t('tram', 'bold'), t(' early. '), { type: 'text', text: 'Map', marks: [{ type: 'link', attrs: { href: 'https://example.org/map' } }] }),
    { type: 'heading', attrs: { level: 2 }, content: [t('Packing')] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(t('Shoes')), { type: 'bulletList', content: [{ type: 'listItem', content: [para(t('Spare laces'))] }] }] },
        { type: 'listItem', content: [para(t('Hat'))] },
      ],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para(t('Passport'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [para(t('Adapter'))] },
      ],
    },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [para(t('One'))] }, { type: 'listItem', content: [para(t('Two'))] }] },
    { type: 'blockquote', content: [para(t('Travel light.', 'italic'))] },
    { type: 'codeBlock', attrs: { language: null }, content: [t('a <b> & c')] },
    { type: 'horizontalRule' },
    para(t('5 * 3 = 15 and [x]', 'highlight')),
  ],
};

describe('derive', () => {
  it('takes the first line as title, then a snippet, word count and checklist flag', () => {
    const d = derive(SAMPLE);
    expect(d.title).toBe('Trip to Lisbon');
    expect(d.snippet.startsWith('Book the tram early. Map · Packing · Shoes · Spare laces · Hat · Passport')).toBe(true);
    expect(d.hasChecklist).toBe(true);
    expect(d.text.split('\n')[0]).toBe('Trip to Lisbon');
    expect(d.wordCount).toBe(countWords(d.text));
  });

  it('gives an empty page an empty title, and skips blank leading lines', () => {
    expect(derive({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] })).toMatchObject({ title: '', snippet: '', wordCount: 0 });
    expect(derive({ type: 'doc', content: [para(), para(t('Later title')), para(t('body'))] })).toMatchObject({ title: 'Later title', snippet: 'body' });
  });

  it('joins a snippet\'s blocks and list items with " · ", with no empty parts', () => {
    const list = { type: 'bulletList', content: ['Pack the tent', 'Charge the lamp', 'Order seeds'].map((x) => ({ type: 'listItem', content: [para(t(x))] })) };
    expect(derive({ type: 'doc', content: [para(t('Weekend')), list] }).snippet).toBe('Pack the tent · Charge the lamp · Order seeds');
    expect(derive({ type: 'doc', content: [list, para(), para(t('Back by  six'))] })).toMatchObject({ title: 'Pack the tent', snippet: 'Charge the lamp · Order seeds · Back by six' });
  });

  it('counts words in any script, with apostrophes', () => {
    expect(countWords("it's a 2-step plan, naïve 東京")).toBe(7);
  });
});

describe('export', () => {
  it('writes GitHub-flavoured Markdown', () => {
    expect(toMarkdown(SAMPLE)).toBe(
      [
        '# Trip to Lisbon',
        '',
        'Book the **tram** early. [Map](https://example.org/map)',
        '',
        '## Packing',
        '',
        '- Shoes\n  - Spare laces\n- Hat',
        '',
        '- [x] Passport\n- [ ] Adapter',
        '',
        '1. One\n2. Two',
        '',
        '> _Travel light._',
        '',
        '```\na <b> & c\n```',
        '',
        '---',
        '',
        '<mark>5 \\* 3 = 15 and \\[x\\]</mark>',
        '',
      ].join('\n'),
    );
  });

  it('keeps marks open across neighbouring text and guards line starts', () => {
    const doc: PMNode = { type: 'doc', content: [para(t('a', 'bold'), t('b', 'bold', 'italic'), t('c')), para(t('# not a heading')), para(t('- not a list'))] };
    expect(toMarkdown(doc)).toBe('**a_b_**c\n\n\\# not a heading\n\n\\- not a list\n');
  });

  it('writes escaped HTML, drops unsafe links, and wraps a complete document', () => {
    const html = toHtmlBody(SAMPLE);
    expect(html).toContain('<h1>Trip to Lisbon</h1>');
    expect(html).toContain('<a href="https://example.org/map" rel="noopener noreferrer">Map</a>');
    expect(html).toContain('<pre><code>a &lt;b&gt; &amp; c</code></pre>');
    expect(html).toContain('<li class="task done"><input type="checkbox" disabled checked>');
    const evil: PMNode = { type: 'doc', content: [para({ type: 'text', text: 'x"><script>', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] })] };
    expect(toHtmlBody(evil)).toBe('<p>x&quot;&gt;&lt;script&gt;</p>');
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeHref('mailto:a@example.org')).toBe('mailto:a@example.org');
    const full = toHtmlDocument(SAMPLE, 'Trip <1>', 'main{}');
    expect(full.startsWith('<!doctype html>')).toBe(true);
    expect(full).toContain('<title>Trip &lt;1&gt;</title>');
    expect(full).not.toMatch(/<script|src=|href="http(?!s:\/\/example\.org)/);
  });

  it('makes safe file names', () => {
    expect(fileName('a/b:c*?', 'md')).toBe('a b c.md');
    expect(fileName('   ', 'html')).toBe('Note.html');
  });
});

describe('search rules', () => {
  it('folds case and accents without moving offsets', () => {
    expect(fold('Crème BRÛLÉE')).toBe('creme brulee');
    expect(fold('İx').length).toBe('İx'.length);
    expect(parseQuery('  Café has:checklist "tram," ')).toEqual({ terms: ['cafe', 'tram'], hasChecklist: true });
  });

  it('needs every word, matches at word starts, and ranks title hits first', () => {
    const idx = new SearchIndex();
    idx.set('a', 'Garden', 'Garden\nplant tomatoes in spring');
    idx.set('b', 'Spring cleaning', 'Spring cleaning\ngarden shed');
    idx.set('c', 'Other', 'Other\nwellspring');
    const q = (s: string) => idx.query(parseQuery(s), () => true).map((h) => h.pageId);
    expect(q('spring')).toEqual(['b', 'a']);
    expect(q('garden spring')).toEqual(['a', 'b']);
    expect(q('tom spr')).toEqual(['a']);
    expect(q('')).toEqual([]);
  });
});

describe('history rules', () => {
  const day = 86_400_000;
  const v = (id: string, at: number): VersionMeta => ({ id, pageId: 'p', createdAt: at, reason: 'session', actor: 'user', title: '', wordCount: 0 });
  it('keeps every version for 30 days, then the last of each day', () => {
    const now = new Date(2026, 10, 30, 12).getTime();
    const old = new Date(2026, 9, 1, 9).getTime();
    const list = [v('a', old), v('b', old + 3_600_000), v('c', old + day), v('d', now - 2 * day), v('e', now - 2 * day + 1000)];
    expect(versionsToPrune(list, now).sort()).toEqual(['a']);
  });
  it('picks the newest version at or before a moment', () => {
    const list = [v('a', 10), v('b', 20), v('c', 30)];
    expect(versionAt(list, 25)?.id).toBe('b');
    expect(versionAt(list, 5)).toBeNull();
  });
});

describe('days', () => {
  it('steps between active days and lays out a Monday-first month', () => {
    const days = ['2026-11-05', '2026-10-30', '2026-11-01'];
    expect(stepActiveDay(days, '2026-11-01', -1)).toBe('2026-10-30');
    expect(stepActiveDay(days, '2026-11-01', 1)).toBe('2026-11-05');
    expect(stepActiveDay(days, '2026-11-05', 1)).toBeNull();
    const cells = monthCells(2026, 10);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02');
  });
});

describe('theme tokens', () => {
  it('has the same keys in every theme, and CSS for each', () => {
    const keys = (id: (typeof THEME_IDS)[number]) => JSON.stringify(Object.keys(NOTEBOOK_THEMES[id].tab)) + JSON.stringify(Object.keys(NOTEBOOK_THEMES[id].highlight));
    expect(new Set(THEME_IDS.map(keys)).size).toBe(1);
    const css = notebookThemeCss();
    for (const id of THEME_IDS) expect(css).toContain(`:root[data-theme="${id}"]`);
    expect(css).toContain('--ma-nb-tab-blue');
    // Dusk has no pure black or white (design 3.12).
    expect(JSON.stringify(NOTEBOOK_THEMES.dusk)).not.toMatch(/#000000|#FFFFFF/i);
  });
});
