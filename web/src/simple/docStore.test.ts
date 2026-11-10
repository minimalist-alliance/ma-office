import { describe, expect, it } from 'vitest';
import { applyMDoc, applyPatch, HISTORY_PER_TAB, pageKey, PageHistory, type SimpleDoc } from './docStore';
import { SiteMemory, siteOf } from './siteMemory';

// MDoc v1 and its patches, as `deskd` sends them (API.md section 14).
const head = (rev = 1, url = 'https://x.example/a') => ({ v: 1, tabId: 't1', rev, url, title: 'T', kind: 'page', sensitive: false, truncated: false, loading: false });
const para = (key: string, text: string, node?: string) => ({ t: 'para', key, runs: node ? [{ r: 'link', node, fp: `fp-${node}`, url: 'https://x.example/', runs: [text] }] : [text] });
const doc = (rev: number, blocks: unknown[], url?: string) => ({ ...head(rev, url), blocks });

describe('applyMDoc and applyPatch', () => {
  it('builds a page from its blocks, keyed by node or key, with every node and its block for `act`', () => {
    const a = applyMDoc(null, doc(1, [para('k1', 'one'), para('k2', 'two', 'e.5')])) as SimpleDoc;
    expect(a.blocks.map((b) => b.key)).toEqual(['h:k1', 'r:e.5']);
    expect(a.nodes.get('e.5')).toEqual({ fp: 'fp-e.5', block: 'k2' });
    expect(a.meta.rev).toBe(1);
  });

  it('patches in place from the rev it holds, and keeps unchanged blocks as the same objects', () => {
    const a = applyMDoc(null, doc(1, [para('k1', 'one'), para('k2', 'two', 'e.5')])) as SimpleDoc;
    const b = applyPatch(a, { base: 1, rev: 2, at: 1, remove: 1, insert: [para('k3', 'two, changed', 'e.5')], head: head(2) }) as SimpleDoc;
    // The block that didn't change is the same object, so React skips it; the changed one keeps its key by its node.
    expect(b.blocks[0]).toBe(a.blocks[0]);
    expect(b.blocks[1]?.key).toBe('r:e.5');
    expect(b.nodes.get('e.5')?.block).toBe('k3');
    expect(b.meta.rev).toBe(2);
    expect(b.cache.has('k2')).toBe(false);
    // From another rev, or out of range: it doesn't apply, and the caller asks `get` again.
    expect(applyPatch(b, { base: 1, rev: 3, at: 0, remove: 0, insert: [], head: head(3) })).toBeNull();
    expect(applyPatch(b, { base: 2, rev: 3, at: 1, remove: 5, insert: [], head: head(3) })).toBeNull();
    expect(applyPatch(null, { base: 2, rev: 3, at: 0, remove: 0, insert: [], head: head(3) })).toBeNull();
  });

  it('gathers a group or fold header\'s grouped blocks under it, and ends at a paywall', () => {
    const d = applyMDoc(null, doc(1, [
      para('k1', 'story'),
      { t: 'fold', key: 'f', label: 'Comments', kind: 'comments', lead: 1, size: 2, meta: '9 more' },
      { ...para('c1', 'first'), grouped: true },
      { ...para('c2', 'second', 'n.2'), grouped: true },
      { t: 'fold', key: 'f0', label: 'Comments', kind: 'comments', lead: 0, size: 0, meta: '119 comments' },
      { t: 'group', key: 'g', label: 'More from this site', size: 1 },
      { ...para('g1', 'link card'), grouped: true },
      { t: 'paywall', key: 'p' },
      para('k9', 'never shown'),
    ])) as SimpleDoc;
    expect(d.blocks.map((b) => b.block.t)).toEqual(['para', 'fold', 'fold', 'group', 'paywall']);
    expect(d.blocks[1]?.block).toMatchObject({ t: 'fold', lead: 1, blocks: [{ t: 'para' }, { t: 'para' }] });
    expect(d.nodes.get('n.2')?.block).toBe('c2');
  });

  it('ignores what it cannot read, and keys repeats apart', () => {
    expect(applyMDoc(null, { rev: 1 })).toBeNull();
    expect(applyMDoc(null, { blocks: [] })).toBeNull();
    const a = applyMDoc(null, doc(1, [para('k1', 'same'), para('k1', 'same'), { t: 'para', key: '<script>', runs: ['x'] }])) as SimpleDoc;
    expect(a.blocks.map((b) => b.key)).toEqual(['h:k1', 'h:k1~1']);
  });
});

describe('PageHistory', () => {
  it('keeps the last pages per tab, in memory only, and forgets closed tabs', () => {
    const h = new PageHistory();
    for (let i = 0; i < HISTORY_PER_TAB + 2; i += 1) h.put('t1', applyMDoc(null, doc(1, [], `https://x.example/${i}`)) as SimpleDoc);
    expect(h.get('t1', 'https://x.example/0')).toBeNull();
    expect(h.get('t1', `https://x.example/${HISTORY_PER_TAB + 1}`)).not.toBeNull();
    h.keepOnly([]);
    expect(h.get('t1', `https://x.example/${HISTORY_PER_TAB + 1}`)).toBeNull();
  });

  it('matches pages without their fragment', () => {
    expect(pageKey('https://x.example/a#top')).toBe('https://x.example/a');
  });
});

describe('site memory', () => {
  it('sends the host, which deskd maps to its registrable domain, and nothing but http(s)', () => {
    expect(siteOf('https://www.Shop.Example/a')).toBe('www.shop.example');
    expect(siteOf('https://bücher.example/')).toBe('xn--bcher-kva.example');
    expect(siteOf('about:blank')).toBeNull();
    expect(siteOf('chrome://newtab/')).toBeNull();
  });

  it('asks the desk once, shows a choice at once, and never lets an older answer win', async () => {
    let answer: (v: { choice: 'simple' | 'full' | null; domain: string | null }) => void = () => undefined;
    const sets: unknown[] = [];
    const memory = new SiteMemory({ get: () => new Promise((r) => (answer = r)), set: async (site, choice) => void sets.push([site, choice]) });
    expect(memory.choice('a.example')).toBeUndefined();
    await memory.remember('a.example', 'full');
    expect(memory.choice('a.example')).toBe('full');
    answer({ choice: 'simple', domain: 'a.example' });
    await Promise.resolve();
    expect(memory.choice('a.example')).toBe('full');
    expect(sets).toEqual([['a.example', 'full']]);
  });

  it("keeps the desk's registrable domain for a host, only one the host ends with (T47O-3)", async () => {
    const domains: Record<string, string> = { 'news.example.co.uk': 'example.co.uk', 'evil.example': 'minimalistalliance.com', 'x.example': 'EXAMPLE' };
    const memory = new SiteMemory({ get: async (site) => ({ choice: null, domain: domains[site] ?? null }), set: async () => undefined });
    for (const host of [...Object.keys(domains), 'y.example']) memory.choice(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(memory.domain('news.example.co.uk')).toBe('example.co.uk');
    expect(memory.domain('evil.example')).toBeUndefined();
    expect(memory.domain('x.example')).toBe('example');
    expect(memory.domain('y.example')).toBeUndefined();
  });
});
