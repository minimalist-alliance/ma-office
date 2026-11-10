// The office's half of the simplified view's contract (security review T47O-1): `deskd`'s closed MDoc schema
// (`mdoc-schema.json`, copied from `sub/minified-stage-a`), replayed through the parser and the renderer. Fixtures are
// made from the schema itself: one of every block and run it names, and a field of every kind it has, and of kinds it
// doesn't, in every place a run can stand, with every sensitive kind beside them. The mock desk's pages and the
// prototype's captures (synthetic ones in `tests/fixtures/captures/`) go through too. Whatever comes in, the only inputs are text, checkbox and radio, a
// text input or textarea only ever stands for one of `deskd`'s plain kinds, and no sensitive or unknown kind is ever one.
//
// `deskd`'s own output can be replayed as well, from a run of its real-site harnesses (`services/deskd/real-sites/`),
// which stays outside git: `MDOC_REPLAY=<folder>[:<folder>...]` with `PNN.mdoc.json` files, as `get` answers or bare.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { builtInPages, fromCapture, toMDoc, type Capture } from '../desk/mockSimpleView';
import { BlockView, Page, Runs, type PageContext } from './blocks';
import type { SimpleController } from './controller';
import { applyMDoc, type SimpleDoc } from './docStore';
import { looksSecret, type Block, type Inline } from './mdoc';
import { blockKinds, enumWords, fits, runKinds } from './schema';

type Raw = Record<string, unknown>;
type Fields = Record<string, string>;

const schema = JSON.parse(readFileSync(join(import.meta.dirname, 'mdoc-schema.json'), 'utf8')) as { blocks: Record<string, Fields>; runs: Record<string, Fields>; parts: Record<string, Fields> };
const CAPTURES = join(import.meta.dirname, '../../tests/fixtures/captures');

/** `deskd`'s words for a field that's typed into here. Every other word is never an input. */
const PLAIN = ['plain', 'query', 'email_address', 'phone_number', 'web_address', 'numeric', 'multiline'];
/** Words that aren't `deskd`'s, as a broken or hostile desk might send: HTML types, near misses, inherited names. */
const UNKNOWN = ['password', 'text', 'email', 'tel', 'number', 'search', 'url', 'hidden', 'one_time_code', 'card', 'Plain', 'plain ', '', 'constructor', '__proto__', 'toString'];
const NOT_PLAIN = [...enumWords('field.kind').filter((k) => !PLAIN.includes(k)), ...UNKNOWN];
const SENSITIVE = [...enumWords('sensitive.kind'), 'pin', 'constructor', ''];

// ----------------------------------------------------------------- fixtures from the schema

/** The least that fits: every required field, each with a value of its type (an enum's first word). */
function minimal(spec: Fields, ctx: string): Raw {
  const out: Raw = {};
  for (const [k, type] of Object.entries(spec)) {
    if (!k.endsWith('!')) continue;
    const name = k.slice(0, -1);
    out[name] = value(type, `${ctx}.${name}`);
  }
  return out;
}

function value(type: string, key: string): unknown {
  const words = enumWords(key);
  if (words.length) return words[0];
  if (type.startsWith('map:')) {
    const part = type.slice(4);
    return part === 'any' ? {} : minimal(schema.parts[part] as Fields, part);
  }
  if (type.startsWith('list:')) return [];
  switch (type) {
    case 'string':
      return 'x';
    case 'int':
      return 1;
    case 'number':
      return 1.5;
    case 'bool':
      return false;
    case 'run':
      return 'x';
    case 'runs':
      return ['x'];
    case 'strings':
      return ['x'];
    case 'cells':
      return [[{ runs: ['x'] }]];
    case 'menus':
      return [{ label: 'M', kind: 'menu', runs: ['x'] }];
    case 'cards':
      return [{ title: { text: 'T' } }];
    default:
      return [];
  }
}

const field = (kind: string, n: number, label = 'Name'): Raw => ({ r: 'field', node: `f.${n}`, fp: `fp${n}`, kind, label, value: 'typed by the page' });
const sensitive = (kind: string): Raw => ({ r: 'sensitive', kind, origin: 'https://pay.example' });

/** Every place a run can stand, each holding `runs`: as a block's runs, a menu's, a table cell's, a filter row's sort. */
function everywhere(runs: Raw[]): Raw[] {
  const one = runs[0] ?? 'x';
  return [
    { t: 'heading', level: 2, runs },
    { t: 'para', runs },
    { t: 'item', depth: 1, ordinal: 0, runs },
    { t: 'meta', runs },
    { t: 'controls', runs, menus: [{ label: 'Menu', kind: 'menu', runs }] },
    { t: 'bar', runs, menus: [{ label: 'Filters', kind: 'filters', runs }] },
    { t: 'table', rows: [[{ head: true, runs }, { runs }]] },
    { t: 'answer', label: 'Answer', runs, sources: runs },
    { t: 'comment', kind: 'comment', depth: 1, runs },
    { t: 'filters', runs, sort: one, menus: [{ label: 'Price', kind: 'filters', runs }] },
    { t: 'group', label: 'More', size: 1 },
    { t: 'para', grouped: true, runs },
    { t: 'fold', label: 'Comments', kind: 'comments', lead: 0, size: 1 },
    { t: 'para', grouped: true, runs },
    { t: 'para', dialog: true, runs },
  ];
}

function mdoc(blocks: Raw[], rev = 1): Raw {
  return { v: 1, tabId: 't1', rev, url: 'https://shop.example/', origin: 'https://shop.example', title: 'T', kind: 'page', sensitive: false, truncated: false, loading: false, blocks: blocks.map((b, i) => ({ key: `k${i}`, ...b })) };
}

// ----------------------------------------------------------------- what the office makes of a document

/** Every run in the parsed page: its blocks, the bar's fields and menus, the filter row, cards, comments, tables. */
function inlines(doc: SimpleDoc): Inline[] {
  const out: Inline[] = [];
  const walk = (c: readonly Inline[]): void => {
    for (const r of c) {
      out.push(r);
      if (r.t === 'mark' || r.t === 'link') walk(r.c);
    }
  };
  const block = (b: Block): void => {
    switch (b.t) {
      case 'bar':
        walk(b.fields);
        b.groups.forEach((g) => walk(g.c));
        return;
      case 'filters':
        walk(b.chips);
        if (b.sort) walk([b.sort]);
        b.groups.forEach((g) => walk(g.c));
        return;
      case 'group':
      case 'fold':
        b.blocks.forEach(block);
        return;
      case 'answer':
        b.blocks.forEach(block);
        walk(b.sources);
        return;
      case 'cards':
        b.items.forEach((i) => walk(i.actions));
        return;
      case 'table':
        b.rows.forEach((row) => row.forEach((cell) => walk(cell.c)));
        return;
      case 'comment':
        walk(b.c);
        if (b.reply) walk([b.reply]);
        if (b.vote) walk([b.vote]);
        return;
      case 'island':
      case 'figure':
      case 'code':
      case 'rule':
      case 'paywall':
        return;
      default:
        walk(b.c);
    }
  };
  doc.blocks.forEach((kb) => block(kb.block));
  return out;
}

const stub = { image: () => Promise.resolve(null), showFull: () => undefined, signIn: () => undefined, mayAdopt: () => true } as unknown as SimpleController;
const context: PageContext = { controller: stub, site: 'shop.example', domain: 'shop.example', op: { name: '', post: null }, renderIsland: () => null };

/** The page as the office draws it: every block, then the bar and the filter row, which the site row draws. */
function html(doc: SimpleDoc): string {
  const parts: ReactNode[] = doc.blocks.map((kb) => createElement(BlockView, { key: kb.key, kb }));
  const rows: Inline[] = [];
  for (const { block: b } of doc.blocks) {
    if (b.t === 'bar') rows.push(...b.fields, ...b.groups.flatMap((g) => g.c));
    if (b.t === 'filters') rows.push(...b.chips, ...(b.sort ? [b.sort] : []), ...b.groups.flatMap((g) => g.c));
  }
  parts.push(createElement(Runs, { key: 'rows', c: rows }));
  return renderToStaticMarkup(createElement(Page.Provider, { value: context }, ...parts));
}

/** Every `<input>`'s type, and how many text areas, in markup. */
function controls(markup: string): { inputs: string[]; textareas: number } {
  const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map((m) => /\btype="([^"]*)"/.exec(m[0])?.[1] ?? '(none)');
  return { inputs, textareas: (markup.match(/<textarea\b/g) ?? []).length };
}

const typable = (markup: string): number => {
  const c = controls(markup);
  return c.inputs.filter((t) => t === 'text').length + c.textareas;
};

/** What every document must show, whatever came: only text, checkbox and radio inputs, no form, no type from the page. */
function holds(doc: SimpleDoc, name: string): void {
  const markup = html(doc);
  const { inputs } = controls(markup);
  for (const t of inputs) expect(['text', 'checkbox', 'radio'], `${name}: an <input type="${t}">`).toContain(t);
  expect(markup, name).not.toMatch(/<form\b|\bname="|\bhref="|autocomplete="(?!off")/i);
  // Each text input or textarea is a field the parser made, and only ever from a plain kind. (A paragraph with a secret
  // field in it is the sign-in alone, so it can draw fewer.)
  const fields = inlines(doc).filter((r) => r.t === 'field' && (r.kind === 'line' || r.kind === 'lines'));
  expect(typable(markup), name).toBeLessThanOrEqual(fields.length);
}

const parse = (raw: unknown): SimpleDoc => {
  const doc = applyMDoc(null, raw);
  expect(doc).not.toBeNull();
  return doc as SimpleDoc;
};

// ----------------------------------------------------------------- the tests

describe("the schema's own fixtures", () => {
  it('one of every block and run the schema names fits, parses and holds', () => {
    expect(blockKinds().length).toBeGreaterThan(15);
    for (const t of blockKinds()) {
      const b = { t, ...minimal(schema.blocks[t] as Fields, t) };
      expect(fits(`block:${t}`, b), t).toBe(true);
    }
    for (const r of runKinds()) expect(fits(`run:${r}`, { r, ...minimal(schema.runs[r] as Fields, r) }), r).toBe(true);
    const blocks = blockKinds().map((t) => ({ t, ...minimal(schema.blocks[t] as Fields, t) }));
    const runs = runKinds().map((r) => ({ r, ...minimal(schema.runs[r] as Fields, r) }));
    holds(parse(mdoc([...blocks, { t: 'para', runs }])), 'every kind');
  });

  it("a plain field is a text input, in every place a run can stand, and a secret's words in it make it the sign-in", () => {
    for (const kind of PLAIN) {
      const doc = parse(mdoc(everywhere([field(kind, 1)])));
      holds(doc, kind);
      expect(typable(html(doc)), kind).toBeGreaterThan(0);
      // The office's own net under deskd's (T47O-1): the page's words ask for a password, a code or a card.
      for (const words of ['Password', 'One-time code', 'Card number', 'CVC', 'Contraseña', '6-digit code']) {
        const secret = parse(mdoc(everywhere([field(kind, 2, words)])));
        expect(typable(html(secret)), `${kind} labelled ${words}`).toBe(0);
        expect(html(secret), `${kind} labelled ${words}`).toMatch(/(Sign in|Pay) on shop\.example/);
      }
    }
    // Words that only look like it stay fields.
    for (const words of ['Postal code', 'Promo code', 'Email', 'Your name', 'Search']) expect(looksSecret(words), words).toBeNull();
  });

  it('no sensitive or unknown kind is ever an input, in any place a run can stand (T47O-1)', () => {
    for (const kind of NOT_PLAIN) {
      const doc = parse(mdoc(everywhere([field(kind, 1)])));
      const markup = html(doc);
      holds(doc, `field ${JSON.stringify(kind)}`);
      expect(typable(markup), `field ${JSON.stringify(kind)}`).toBe(0);
      expect(markup, `field ${JSON.stringify(kind)}`).toContain('Use the real page');
      // A word this office doesn't know shows nothing of what the page holds; a picker shows its value as text.
      if (UNKNOWN.includes(kind)) expect(markup, `field ${JSON.stringify(kind)}`).not.toContain('typed by the page');
    }
    for (const kind of SENSITIVE) {
      const doc = parse(mdoc([...everywhere([sensitive(kind), field('plain', 1)]), { t: 'sensitive', kind, origin: 'https://pay.example' }]));
      const markup = html(doc);
      holds(doc, `sensitive ${JSON.stringify(kind)}`);
      expect(markup, `sensitive ${JSON.stringify(kind)}`).toMatch(kind === 'card' || kind === 'payment' ? /Pay on pay\.example/ : /Sign in on pay\.example/);
    }
  });

  it("a field or sensitive run that doesn't fit is still never an input: the real page, or its sign-in", () => {
    const bad = [
      { ...field('plain', 1), type: 'password' },
      { ...field('plain', 2), autocomplete: 'one-time-code' },
      { ...field('plain', 3), value: 7 },
      { r: 'field', node: 'f.4', fp: 'a', kind: 'plain', value: '' },
    ];
    const doc = parse(mdoc(everywhere(bad)));
    expect(typable(html(doc))).toBe(0);
    expect(html(doc)).toContain('Use the real page');
    const odd = parse(mdoc(everywhere([{ r: 'sensitive', kind: 'password', origin: 'https://pay.example', extra: 1 }, { r: 'sensitive' }])));
    expect(typable(html(odd))).toBe(0);
    expect(html(odd)).toMatch(/Sign in on shop\.example/);
  });

  it("a block, run or head with a field the schema doesn't name, or of the wrong type, isn't drawn", () => {
    const doc = parse(mdoc([{ t: 'para', runs: ['kept'] }, { t: 'para', runs: ['dropped'], style: 'color:red' }, { t: 'para', runs: [{ r: 'b', runs: ['bold'], class: 'x' }, ' and plain'] }, { t: 'heading', level: '2', runs: ['dropped'] }]));
    const markup = html(doc);
    expect(markup).toContain('kept');
    expect(markup).not.toContain('dropped');
    expect(markup).not.toContain('bold');
    expect(markup).toContain(' and plain');
    expect(applyMDoc(null, { ...mdoc([]), onclick: 'x' })).toBeNull();
    expect(applyMDoc(null, { ...mdoc([]), sensitive: 'false' })).toBeNull();
  });
});

describe("the mock desk's pages and the prototype's captures", () => {
  it('every built-in page holds', () => {
    for (const [url, page] of Object.entries(builtInPages())) {
      if (page.fallback) continue;
      const doc = applyMDoc(null, toMDoc(url, page, { tabId: 't1', rev: 1 }));
      // The hostile page has a head that fits and blocks that don't, on purpose.
      expect(doc, url).not.toBeNull();
      holds(doc as SimpleDoc, url);
    }
  });

  it.runIf(existsSync(CAPTURES))("every one of the prototype's captures holds, and with every field made each kind it isn't", () => {
    const names = readdirSync(CAPTURES).filter((f) => f.endsWith('.doc.json'));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const raw = JSON.parse(readFileSync(join(CAPTURES, name), 'utf8')) as Capture;
      const wire = toMDoc(String(raw.meta['url']), fromCapture(raw), { tabId: 't1', rev: 1 });
      holds(parse(wire), name);
      for (const kind of [...NOT_PLAIN.slice(0, 4), 'password']) expect(typable(html(parse(rekind(wire, kind)))), `${name} as ${kind}`).toBe(0);
    }
  });
});

/** The document with every field made `kind`, and every one of them sensitive too, as a desk that got them all wrong. */
function rekind(doc: unknown, kind: string): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) as Raw;
      if (o['r'] === 'field') o['kind'] = kind;
      return o;
    }
    return v;
  };
  return walk(doc);
}

const REPLAY = (process.env['MDOC_REPLAY'] ?? '').split(':').filter((d) => d && existsSync(d));

describe.runIf(REPLAY.length > 0)("deskd's own output, replayed (MDOC_REPLAY)", () => {
  it('every simplified page fits, parses and holds; with its fields made each kind they are not, none is an input', () => {
    let pages = 0;
    for (const dir of REPLAY) {
      for (const name of readdirSync(dir).filter((f) => /^P\d+\.mdoc\.json$/.test(f)).sort()) {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Raw;
        const wire = raw['view'] === 'simplified' ? raw['mdoc'] : raw['v'] === 1 ? raw : null;
        if (!wire) continue;
        pages += 1;
        const where = `${dir}/${name}`;
        const doc = applyMDoc(null, wire);
        expect(doc, `${where} doesn't fit the schema`).not.toBeNull();
        holds(doc as SimpleDoc, where);
        for (const kind of [...NOT_PLAIN.slice(0, 4), 'password']) expect(typable(html(parse(rekind(wire, kind)))), `${where} as ${kind}`).toBe(0);
      }
    }
    expect(pages).toBeGreaterThan(0);
    console.log(`replayed ${pages} of deskd's documents`);
  });
});
