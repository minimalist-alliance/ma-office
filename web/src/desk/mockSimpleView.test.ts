// The mock desk speaks `deskd`'s wire exactly (API.md section 14): every MDoc it sends passes the closed schema that
// `deskd`'s own `MDocSchemaTest` holds deskd to (`web/src/simple/mdoc-schema.json`, copied from `sub/minified-stage-a`
// `a26aee5`'s `services/deskd/src/test/resources/minified/mdoc-schema.json`), and every patch it sends takes the
// document the client has to the one `get` gives.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtInPages, fromCapture, MockSimpleDesk, toMDoc, type Capture } from './mockSimpleView';

type Raw = Record<string, unknown>;
type Fields = Record<string, string>;

interface Schema {
  head: Fields;
  blocks: Record<string, Fields>;
  runs: Record<string, Fields>;
  parts: Record<string, Fields>;
  enums: Record<string, string[]>;
}

const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../simple/mdoc-schema.json'), 'utf8')) as Schema;
const CAPTURES = join(import.meta.dirname, '../../tests/fixtures/captures');

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every way `doc` breaks the schema, as `path: what`. Empty when it passes. */
function check(doc: unknown): string[] {
  const errors: string[] = [];
  const fields = (v: unknown, spec: Fields, ctx: string, path: string, tag?: string): void => {
    if (!isObj(v)) {
      errors.push(`${path}: not an object`);
      return;
    }
    const known = new Map(Object.entries(spec).map(([k, t]) => [k.replace(/!$/, ''), { type: t, required: k.endsWith('!') }]));
    for (const [name, { required }] of known) if (required && !(name in v)) errors.push(`${path}.${name}: missing`);
    for (const [name, value] of Object.entries(v)) {
      if (name === tag) continue;
      const f = known.get(name);
      if (!f) errors.push(`${path}.${name}: not in the schema`);
      else typed(value, f.type, `${ctx}.${name}`, `${path}.${name}`);
    }
  };
  const list = (v: unknown, path: string, each: (x: unknown, p: string) => void): void => {
    if (!Array.isArray(v)) errors.push(`${path}: not a list`);
    else v.forEach((x, i) => each(x, `${path}[${i}]`));
  };
  const run = (v: unknown, path: string): void => {
    if (typeof v === 'string') return;
    if (!isObj(v) || typeof v['r'] !== 'string' || !schema.runs[v['r']]) {
      errors.push(`${path}: not a run (${isObj(v) ? String(v['r']) : typeof v})`);
      return;
    }
    fields(v, schema.runs[v['r']] as Fields, v['r'], path, 'r');
  };
  const block = (v: unknown, path: string): void => {
    if (!isObj(v) || typeof v['t'] !== 'string' || !schema.blocks[v['t']]) {
      errors.push(`${path}: not a block (${isObj(v) ? String(v['t']) : typeof v})`);
      return;
    }
    fields(v, schema.blocks[v['t']] as Fields, v['t'], path, 't');
  };
  const part = (v: unknown, name: string, path: string): void => {
    const spec = schema.parts[name];
    if (!spec) errors.push(`${path}: no part ${name} in the schema`);
    else fields(v, spec, name, path);
  };
  const typed = (v: unknown, type: string, enumKey: string, path: string): void => {
    const allowed = schema.enums[enumKey];
    if (allowed && !allowed.includes(v as string)) errors.push(`${path}: ${JSON.stringify(v)} isn't one of ${enumKey}'s words`);
    if (type.startsWith('map:')) {
      const name = type.slice(4);
      if (name === 'any') {
        if (!isObj(v)) errors.push(`${path}: not an object`);
      } else part(v, name, path);
      return;
    }
    if (type.startsWith('list:')) {
      list(v, path, (x, p) => part(x, type.slice(5), p));
      return;
    }
    switch (type) {
      case 'string':
        if (typeof v !== 'string') errors.push(`${path}: not a string`);
        return;
      case 'int':
        if (!Number.isInteger(v)) errors.push(`${path}: not an int`);
        return;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${path}: not a number`);
        return;
      case 'bool':
        if (typeof v !== 'boolean') errors.push(`${path}: not a bool`);
        return;
      case 'strings':
        list(v, path, (x, p) => typeof x !== 'string' && errors.push(`${p}: not a string`));
        return;
      case 'runs':
        list(v, path, run);
        return;
      case 'run':
        run(v, path);
        return;
      case 'blocks':
        list(v, path, block);
        return;
      case 'cells':
        list(v, path, (row, p) => list(row, p, (cell, q) => part(cell, 'cell', q)));
        return;
      case 'menus':
        list(v, path, (x, p) => part(x, 'menu', p));
        return;
      case 'cards':
        list(v, path, (x, p) => part(x, 'card', p));
        return;
      case 'tracks':
        list(v, path, (x, p) => part(x, 'track', p));
        return;
      default:
        errors.push(`${path}: unknown type ${type}`);
    }
  };
  fields(doc, schema.head, 'head', 'mdoc');
  if (isObj(doc) && Array.isArray(doc['blocks'])) {
    const keys = doc['blocks'].map((x) => (isObj(x) ? x['key'] : undefined));
    if (new Set(keys).size !== keys.length) errors.push('mdoc.blocks: keys not unique');
  }
  return errors;
}

/** Every field `kind` in a document, at any depth. */
function fieldKinds(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v['r'] === 'field') out.push(String(v['kind']));
      Object.values(v).forEach(walk);
    }
  };
  walk(doc);
  return out;
}

const HTML_TYPES = ['text', 'password', 'email', 'tel', 'url', 'number', 'search', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file', 'hidden', 'checkbox', 'radio', 'submit', 'button'];

describe('the mock desk, against the MDoc schema', () => {
  const pages = builtInPages();

  it('checks what it says it checks', () => {
    expect(check({ v: 1 })).toContain('mdoc.tabId: missing');
    expect(check(toMDoc('https://a.example/', { title: 'A', blocks: [{ t: 'para', runs: [{ r: 'field', kind: 'email', label: 'x', value: '' }] }] }, { tabId: 't', rev: 1 })).join()).toMatch(/field\.kind/);
    expect(check(toMDoc('https://a.example/', { title: 'A', blocks: [{ t: 'para', runs: ['x'], style: 'color:red' }] }, { tabId: 't', rev: 1 })).join()).toMatch(/style: not in the schema/);
  });

  for (const [url, page] of Object.entries(pages)) {
    if (url === 'https://hostile.example/') continue;
    it(`${url} passes`, () => {
      const doc = toMDoc(url, page, { tabId: 't1', rev: 3 });
      expect(check(doc)).toEqual([]);
      for (const kind of fieldKinds(doc)) expect(HTML_TYPES).not.toContain(kind);
    });
  }

  it('the hostile page breaks it, on purpose', () => {
    const errors = check(toMDoc('https://hostile.example/', pages['https://hostile.example/'] as never, { tabId: 't1', rev: 1 }));
    expect(errors.join('\n')).toMatch(/dangerouslySetInnerHTML: not in the schema/);
    expect(errors.join('\n')).toMatch(/not a block \(nonsense\)/);
    expect(errors.join('\n')).toMatch(/not a run \(zz\)/);
    expect(errors.join('\n')).toMatch(/"password" isn't one of field\.kind's words/);
  });

  it.runIf(existsSync(CAPTURES))("the prototype's captures, converted, pass", () => {
    const names = readdirSync(CAPTURES).filter((f) => f.endsWith('.doc.json'));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const raw = JSON.parse(readFileSync(join(CAPTURES, name), 'utf8')) as Capture;
      const doc = toMDoc(String(raw.meta['url']), fromCapture(raw), { tabId: 't1', rev: 1 });
      expect(check(doc), name).toEqual([]);
      for (const kind of fieldKinds(doc)) expect(HTML_TYPES, name).not.toContain(kind);
    }
  });
});

describe('the mock desk, on the wire', () => {
  afterEach(() => vi.useRealTimers());

  /** A desk at `url`, with the page there and a listener on its topic. */
  async function deskAt(url: string): Promise<{ desk: MockSimpleDesk; events: Raw[]; nav: string[] }> {
    vi.useFakeTimers();
    const nav: string[] = [];
    const desk = new MockSimpleDesk((u) => nav.push(u));
    desk.control.delayMs = 5;
    const events: Raw[] = [];
    desk.watch('t1', (e) => events.push(e));
    desk.tabChanged('t1', url);
    await vi.advanceTimersByTimeAsync(20);
    return { desk, events, nav };
  }

  const get = (desk: MockSimpleDesk, p: Raw = {}): Raw => desk.answer('browser.minified.get', { tabId: 't1', ...p }) as Raw;

  /** The client's half: a patch applied to the document it has. */
  function apply(doc: Raw, patch: Raw): Raw {
    expect(patch['base']).toBe(doc['rev']);
    const blocks = [...(doc['blocks'] as Raw[])];
    blocks.splice(patch['at'] as number, patch['remove'] as number, ...(patch['insert'] as Raw[]));
    return { ...(patch['head'] as Raw), blocks };
  }

  /** The control `node` names, and the key of its block. */
  function where(doc: Raw, node: string): { block: string; fp: string } {
    for (const b of doc['blocks'] as Raw[]) {
      let fp: string | null = null;
      const walk = (v: unknown): void => {
        if (fp) return;
        if (Array.isArray(v)) v.forEach(walk);
        else if (isObj(v)) {
          if (v['node'] === node || (v['t'] === 'island' && v['island'] === node)) fp = v['fp'] as string;
          else Object.values(v).forEach(walk);
        }
      };
      walk(b);
      if (fp) return { block: b['key'] as string, fp };
    }
    throw new Error(`no node ${node}`);
  }

  async function act(desk: MockSimpleDesk, doc: Raw, node: string, action: string, value?: unknown): Promise<unknown> {
    const r = desk.answer('browser.minified.act', { tabId: 't1', nodeId: node, action, value, rev: doc['rev'], ...where(doc, node) });
    await vi.advanceTimersByTimeAsync(40);
    return r;
  }

  it('sends a snapshot, then the page as `changed`, and `get` gives the MDoc and `unchanged` after', async () => {
    const { desk, events } = await deskAt('https://form.example/book');
    // The page (after 5 ms) comes before the subscription's first snapshot (after 10 ms) here: both say where it stands.
    expect(events.map((e) => e['type']).sort()).toEqual(['changed', 'snapshot']);
    for (const e of events) expect(e).toMatchObject({ view: 'simplified', tabId: 't1' });
    expect(events.some((e) => 'mdoc' in e)).toBe(false);
    const r = get(desk);
    expect(r['view']).toBe('simplified');
    expect(check(r['mdoc'])).toEqual([]);
    expect(get(desk, { since: r['rev'] })).toEqual({ tabId: 't1', rev: r['rev'], view: 'simplified', unchanged: true });
    expect(() => get(desk, { tabId: 'nope' })).toThrow(expect.objectContaining({ code: 'not_found' }) as Error);
  });

  it('patches take the old document to the new one: fill, check, select, the cookie banner, more results', async () => {
    const steps: [string, string, string, unknown][] = [
      ['https://form.example/book', 'g1', 'fill', 'Ada'],
      ['https://form.example/book', 'g4', 'check', true],
      ['https://form.example/book', 'g3', 'select', { index: 2, label: '4 guests' }],
      ['https://shop.example/signin', 'c1', 'click', undefined],
      ['https://search.example/?q=lamps', 's1', 'scroll', 'start'],
    ];
    for (const [url, node, action, value] of steps) {
      const { desk, events } = await deskAt(url);
      const before = get(desk)['mdoc'] as Raw;
      expect(await act(desk, before, node, action, value)).toEqual({ done: true });
      const patch = events.find((e) => e['type'] === 'patch');
      expect(patch, `${url} ${action}`).toBeTruthy();
      const after = get(desk, { since: before['rev'] })['mdoc'] as Raw;
      expect(apply(before, patch as Raw)).toEqual(after);
      expect(check(after)).toEqual([]);
      vi.useRealTimers();
    }
  });

  it('refuses rather than guesses: a stale rev, a wrong fingerprint, a node not in that block, a label that moved', async () => {
    const { desk } = await deskAt('https://form.example/book');
    const doc = get(desk)['mdoc'] as Raw;
    const g1 = where(doc, 'g1');
    const g3 = where(doc, 'g3');
    const call = (p: Raw): unknown => desk.answer('browser.minified.act', { tabId: 't1', rev: doc['rev'], ...p });
    expect(() => call({ nodeId: 'g1', action: 'fill', value: 'x', ...g1, rev: 0 })).toThrow(expect.objectContaining({ code: 'conflict' }) as Error);
    expect(() => call({ nodeId: 'g1', action: 'fill', value: 'x', ...g1, fp: 'fp-other' })).toThrow(expect.objectContaining({ code: 'conflict', details: { reason: 'changed' } }) as Error);
    expect(() => call({ nodeId: 'g1', action: 'fill', value: 'x', ...g3 })).toThrow(expect.objectContaining({ code: 'conflict', details: { reason: 'gone' } }) as Error);
    expect(call({ nodeId: 'g3', action: 'select', value: { index: 2, label: '2 guests' }, ...g3 })).toEqual({ done: false, reason: 'label' });
    expect(() => call({ nodeId: 'g1', action: 'type', value: 'x', ...g1 })).toThrow(expect.objectContaining({ code: 'bad_request' }) as Error);
  });

  it('falls back as the wire says: a page’s own reason, the member’s choice for the site, and `retry`', async () => {
    const { desk } = await deskAt('https://bank.example/');
    expect(get(desk)).toMatchObject({ view: 'stream', fallback: { reason: 'sensitive_site' } });
    desk.answer('browser.minified.site.set', { host: 'www.read.example', view: 'stream' });
    expect(desk.control.sites).toEqual({ 'read.example': 'stream' });
    desk.tabChanged('t1', 'https://read.example/essay');
    await vi.advanceTimersByTimeAsync(80);
    expect(get(desk)).toMatchObject({ view: 'stream', fallback: { reason: 'member_choice' } });
    expect(get(desk, { retry: true })).toMatchObject({ view: 'simplified' });
    expect(desk.control.retries).toBe(1);
  });

  it('plays an island through `act media`, and gives its box', async () => {
    const { desk } = await deskAt('https://watch.example/clip');
    const doc = get(desk)['mdoc'] as Raw;
    expect(desk.answer('browser.minified.island', { tabId: 't1', islandId: 'v1' })).toMatchObject({ islandId: 'v1', live: true, rect: { width: 880, height: 495 } });
    expect(desk.control.island).toEqual({ key: 'v1', w: 1280, h: 720 });
    expect(await act(desk, doc, 'v1', 'media', { verb: 'play' })).toMatchObject({ done: true, paused: false, duration: 1120 });
    expect(await act(desk, doc, 'v1', 'media', { verb: 'track', track: 0 })).toMatchObject({ captions: true });
    expect(desk.control.media).toEqual([{ nodeId: 'v1', verb: 'play' }, { nodeId: 'v1', verb: 'track', track: 0 }]);
    desk.control.refuseIslands = ['v2'];
    expect(desk.answer('browser.minified.island', { tabId: 't1', islandId: 'v2' })).toMatchObject({ live: false, reason: 'covered' });
  });
});
