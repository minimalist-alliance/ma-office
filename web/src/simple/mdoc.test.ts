import { describe, expect, it } from 'vitest';
import { bareVote, blockRef, foldsDeep, MAX_COMMENT_NEST, rowSlots, shownDate, hiddenTotal, LIMITS, parseBlock, parseHead, plainText, safeUrl, secretIn, type Block, type SiteAction, type SiteInfo, type Target } from './mdoc';

// MDoc v1 as `deskd` sends it (API.md section 14, `sub/minified-stage-a` `8161db0`).
const block = (raw: unknown): Block | null => parseBlock(raw, 'k1').block;
const nodesOf = (raw: unknown): [string, string][] => parseBlock(raw, 'k1').nodes;
const para = (...runs: unknown[]) => ({ t: 'para', key: 'k1', runs });
const HEAD = { v: 1, tabId: 't1', title: 'T', kind: 'page', sensitive: false, truncated: false, loading: false, blocks: [] };

describe('safeUrl', () => {
  it('keeps plain http(s) and nothing else', () => {
    expect(safeUrl('https://ok.example/a?b=1')).toBe('https://ok.example/a?b=1');
    expect(safeUrl('http://ok.example')).toBe('http://ok.example/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://x/1', 'file:///etc/passwd', 'https://user:pw@evil.example/', '', 42, null, 'not a url']) {
      expect(safeUrl(bad), String(bad)).toBeNull();
    }
    expect(safeUrl(`https://ok.example/${'a'.repeat(LIMITS.url)}`)).toBeNull();
  });
});

describe('runs', () => {
  it('rebuilds every run from the schema and drops what it does not know', () => {
    const b = block(para('plain ', { r: 'b', runs: ['bold'] }, { r: 'zz', runs: ['unknown'] }, { r: 'link', node: 'e.1', fp: 'a1', url: 'javascript:x', runs: ['a link'] }, { r: 'br' }));
    expect(b).toEqual({
      t: 'para',
      quote: 0,
      nest: 0,
      dialog: false,
      c: [
        { t: 'text', text: 'plain ' },
        { t: 'mark', kind: 'strong', c: [{ t: 'text', text: 'bold' }] },
        { t: 'link', ref: 'e.1', url: null, c: [{ t: 'text', text: 'a link' }], name: '', next: false },
        { t: 'br' },
      ],
    });
  });

  it('never takes style, class, ids or HTML from the page, nor a word it inherits', () => {
    // A block with a field the schema doesn't name isn't deskd's: it's dropped whole (T47O-1).
    expect(block({ ...para('x'), dangerouslySetInnerHTML: { __html: '<b>' }, style: 'color:red', class: 'evil', id: 'root' })).toBeNull();
    expect(Object.keys(block(para('x')) ?? {}).sort()).toEqual(['c', 'dialog', 'nest', 'quote', 't']);
    // `constructor` and `__proto__` are words a page can send; they're no mark, field or island kind here.
    expect(block(para({ r: 'constructor', runs: ['x'] }, { r: '__proto__', runs: ['y'] }))).toBeNull();
    expect(block(para({ r: 'field', node: 'f', fp: 'a', kind: 'constructor', label: 'L', value: '' }))).toMatchObject({ c: [{ t: 'picker' }] });
  });

  it('cleans bidi overrides and control characters from text', () => {
    const b = block(para('a‮b\u0007c'));
    expect(b && 'c' in b ? plainText(b.c) : '').toBe('abc');
  });

  it('a control is usable only with its node and fingerprint, which it registers for `act`', () => {
    expect(nodesOf(para({ r: 'button', node: 'b.1', fp: 'f1', label: 'Go' }, { r: 'button', node: 'b.2', label: 'No fp' }))).toEqual([['b.1', 'f1']]);
    expect(block(para({ r: 'button', node: 'b.2', label: 'No fp' }))).toMatchObject({ c: [{ t: 'button', ref: null }] });
  });

  it("makes a field's kind an on-screen keyboard only, and a picker of what can't be typed", () => {
    const f = (kind: string) => (block(para({ r: 'field', node: 'f.1', fp: 'a', kind, label: 'L', value: 'v' })) as { c: unknown[] }).c[0];
    expect(f('plain')).toMatchObject({ t: 'field', kind: 'line', hint: 'text' });
    expect(f('query')).toMatchObject({ t: 'field', hint: 'search', enterSubmits: true });
    expect(f('email_address')).toMatchObject({ t: 'field', hint: 'email' });
    expect(f('phone_number')).toMatchObject({ t: 'field', hint: 'tel' });
    expect(f('multiline')).toMatchObject({ t: 'field', kind: 'lines' });
    for (const kind of ['date_choice', 'file_choice', 'colour_choice', 'password', 'email', 'tel']) expect(f(kind), kind).toMatchObject({ t: 'picker', label: 'L' });
  });

  it('makes a sensitive run "Sign in" or "Pay", never a field, with its own origin (T47-1)', () => {
    const s = (kind: string) => {
      const b = block(para({ r: 'sensitive', kind, origin: 'https://pay.example/frame' }));
      return b && 'c' in b ? secretIn(b.c) : null;
    };
    expect(s('password')).toEqual({ t: 'secret', kind: 'signin', origin: 'https://pay.example' });
    expect(s('one_time_code')?.kind).toBe('signin');
    expect(s('card')?.kind).toBe('pay');
    expect(s('payment')?.kind).toBe('pay');
    expect(block({ t: 'sensitive', key: 'k1', kind: 'password' })).toMatchObject({ t: 'para', c: [{ t: 'secret', kind: 'signin', origin: null }] });
  });

  it('reads a select by index, and a select of several as a picker', () => {
    const sel = { r: 'select', node: 's.1', fp: 'a', label: 'Sort', options: ['Featured', 'Price'], selected: 1 };
    expect(block(para(sel))).toMatchObject({ c: [{ t: 'select', ref: 's.1', selected: 1, options: ['Featured', 'Price'] }] });
    expect(block(para({ ...sel, selected: 9 }))).toMatchObject({ c: [{ selected: -1 }] });
    expect(block(para({ ...sel, multiple: true }))).toMatchObject({ c: [{ t: 'picker', value: 'Price' }] });
  });

  it('reads a vote as one control, and a bare score as text', () => {
    expect(block(para({ r: 'vote', score: '196', up: { node: 'u.1', fp: 'a' }, down: { node: 'd.1', fp: 'b' }, state: 'up' }))).toMatchObject({ c: [{ t: 'vote', up: 'u.1', down: 'd.1', score: '196', state: 'up' }] });
    expect(block(para({ r: 'vote', score: '12' }))).toMatchObject({ c: [{ t: 'text', text: '12' }] });
  });

  it('caps nesting and the number of runs', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { r: 'b', runs: [deep] };
    expect(block(para(deep))).not.toBeNull();
    const many = Array.from({ length: LIMITS.runs + 50 }, () => 'w');
    const b = block(para(...many));
    expect(b && 'c' in b ? b.c.length : 0).toBeLessThanOrEqual(LIMITS.runs);
  });
});

describe('blocks', () => {
  it('reads the bar: its fields in the row, its links and menus folded', () => {
    const b = block({ t: 'bar', key: 'k1', runs: [{ r: 'field', node: 's.1', fp: 'a', kind: 'query', label: 'Search', value: '' }, { r: 'button', node: 's.2', fp: 'b', label: 'Go' }, { r: 'link', node: 'm.0', fp: 'c', url: 'https://x.example/', runs: ['Home'] }], menus: [{ label: 'Filters', kind: 'filters', runs: [{ r: 'button', node: 'f.1', fp: 'd', label: 'New' }] }] });
    expect(b).toMatchObject({ t: 'bar', fields: [{ t: 'field', hint: 'search' }, { t: 'button', label: 'Go' }], groups: [{ name: 'Site menu', kind: 'menu' }, { name: 'Filters', kind: 'filters' }] });
    expect(b && blockRef(b)).toBe('s.1');
    // The first distiller's chrome, `controls`, is the same bar.
    expect(block({ t: 'controls', key: 'k1', runs: [{ r: 'link', node: 'm.2', fp: 'a', url: 'https://x.example/', runs: ['Home'] }] })).toMatchObject({ t: 'bar', fields: [], groups: [{ name: 'Site menu' }] });
  });

  it("keeps the bar's sign-in and cart as actions, and never shows two menus (P24's \"Menu\" twice)", () => {
    // Stack Overflow (task 47's P24): the bar has Search and a loose "Log in"; the distiller's own "Site menu" holds the
    // site's nav and the same "Log in" again. "Log in" used to fold into a second "Site menu", drawn as "Menu Menu".
    const login = { r: 'link', node: 'so.3v', fp: 'c', url: 'https://stackoverflow.com/users/login', runs: ['Log in'] };
    const b = block({
      t: 'bar',
      key: 'k1',
      runs: [{ r: 'field', node: 'so.3s', fp: 'a', kind: 'query', label: 'Search', value: '' }, login],
      menus: [{ label: 'Site menu', kind: 'menu', runs: [{ r: 'link', node: 'so.3o', fp: 'd', url: 'https://stackoverflow.com/', runs: ['Home'] }, login, { r: 'link', node: 'so.3y', fp: 'e', url: 'https://stackoverflow.com/questions', runs: ['Questions'] }] }],
    });
    expect(b).toMatchObject({ t: 'bar', actions: [{ kind: 'signin', ref: 'so.3v', label: 'Log in' }], groups: [{ name: 'Site menu', kind: 'menu' }] });
    const bar = b as Extract<Block, { t: 'bar' }>;
    expect(bar.groups).toHaveLength(1);
    // The row already shows "Log in", so the menu doesn't repeat it.
    expect(bar.groups[0]?.c.map((r) => ('ref' in r ? r.ref : null))).toEqual(['so.3o', 'so.3y']);

    // A bar's leftover links and the distiller's own "Site menu" merge into one menu; a cart keeps its count.
    const shop = block({
      t: 'bar',
      key: 'k1',
      runs: [{ r: 'link', node: 'p.1', fp: 'a', url: 'https://shop.example/new', runs: ['New'] }, { r: 'link', node: 'p.2', fp: 'b', url: 'https://shop.example/cart', runs: ['Cart 2'] }],
      menus: [{ label: 'Site menu', kind: 'menu', runs: [{ r: 'link', node: 'p.3', fp: 'c', url: 'https://shop.example/lamps', runs: ['Lamps'] }, { r: 'link', node: 'p.1', fp: 'a', url: 'https://shop.example/new', runs: ['New'] }] }],
    }) as Extract<Block, { t: 'bar' }>;
    expect(shop.actions).toEqual([{ kind: 'cart', ref: 'p.2', label: 'Cart', count: 2 }]);
    expect(shop.groups.map((g) => g.name)).toEqual(['Site menu']);
    expect(shop.groups[0]?.c.map((r) => ('ref' in r ? r.ref : null))).toEqual(['p.1', 'p.3']);
  });

  it('reads cards with every field the schema gives, and registers their nodes', () => {
    const raw = { t: 'cards', key: 'k1', layout: 'grid', repeat: 2, items: [{ title: { text: 'Lamp', node: 'c.1', fp: 'a', url: 'https://shop.example/1' }, image: { image: 'img1', width: 600, height: 600 }, price: '$48.00', listPrice: '$60.00', rating: '4.6', ratingCount: '1,204', badge: 'Best seller', delivery: 'Tomorrow', meta: ['Brass'], chips: ['New'], actions: [{ r: 'button', node: 'c.2', fp: 'b', label: 'Add to cart' }] }, { title: { text: '' } }] };
    expect(block(raw)).toMatchObject({ t: 'cards', layout: 'grid', items: [{ ref: 'c.1', url: 'https://shop.example/1', title: 'Lamp', img: { src: 'img1', w: 600, h: 600 }, price: '$48.00', listPrice: '$60.00', stars: '4.6', ratingCount: '1,204', badge: 'Best seller', delivery: 'Tomorrow', meta: ['Brass'], chips: ['New'], actions: [{ ref: 'c.2', label: 'Add to cart' }] }] });
    expect(nodesOf(raw)).toEqual([['c.2', 'b'], ['c.1', 'a']]);
    expect(block({ t: 'cards', key: 'k1', layout: 'list', repeat: 1, items: [{ title: { text: 'x' }, rating: '11', duration: '8:14' }] })).toMatchObject({ items: [{ stars: '', duration: '8:14' }] });
  });

  it('reads an island from its media, live only with its id and fingerprint; drops ads and ad-sized frames', () => {
    const live = { t: 'island', key: 'k1', kind: 'video', width: 1280, height: 720, island: 'v1.a', fp: 'f', state: 'live', main: true, label: 'A film', media: { duration: 1120, time: 30, paused: false, frame: false, poster: 'img2', tracks: [{ kind: 'chapters', label: 'C', lang: 'en', on: false }, { kind: 'captions', label: 'English', lang: 'en', on: true }] } };
    expect(block(live)).toMatchObject({ t: 'island', key: 'k1', ref: 'v1.a', kind: 'video', main: true, name: 'A film', duration: 1120, time: 30, playing: true, captions: true, captionsTrack: 1, captionsOn: true, drm: false, poster: 'img2' });
    expect(nodesOf(live)).toEqual([['v1.a', 'f']]);
    expect(block({ ...live, state: 'click' })).toMatchObject({ ref: null });
    expect(block({ ...live, media: { frame: false, drm: true } })).toMatchObject({ drm: true, captions: false, playing: false });
    expect(block({ ...live, ad: true })).toBeNull();
    expect(block({ t: 'island', key: 'k1', kind: 'frame', width: 300, height: 250, state: 'none' })).toBeNull();
    expect(block({ t: 'island', key: 'k1', kind: 'embed', width: 640, height: 360, state: 'none' })).toMatchObject({ kind: 'frame', ref: null });
  });

  it('reads a linked image at its shown size, a comment depth, and a group or fold header', () => {
    expect(block({ t: 'image', key: 'k1', image: 'img3', alt: 'A', width: 1600, height: 1200, renderedWidth: 400, renderedHeight: 300, link: { node: 'i.1', fp: 'a', url: 'https://x.example/a' } })).toMatchObject({ t: 'figure', img: { src: 'img3', w: 400, h: 300 }, ref: 'i.1', url: 'https://x.example/a' });
    expect(block({ ...para('reply'), depth: 99 })).toMatchObject({ nest: LIMITS.nest });
    expect(block({ t: 'group', key: 'k1', label: 'More from this site', size: 2 })).toMatchObject({ t: 'group', name: 'More from this site', blocks: [] });
    expect(block({ t: 'fold', key: 'k1', label: '', kind: 'comments', lead: 2, size: 0, meta: '119 comments' })).toMatchObject({ t: 'fold', name: 'Comments', meta: '119 comments', lead: 2 });
    expect(block({ t: 'fold', key: 'k1', label: '', kind: 'other', lead: 0, size: 1 })).toBeNull();
  });

  it('makes a paragraph that starts with ">" a quote, without the mark (R44)', () => {
    expect(block(para('> Sorting first makes it faster.'))).toMatchObject({ t: 'para', quote: 1, c: [{ t: 'text', text: 'Sorting first makes it faster.' }] });
    expect(block(para('>', { r: 'i', runs: ['quoted'] }))).toMatchObject({ quote: 1, c: [{ t: 'mark', kind: 'em' }] });
    expect(block(para('3 > 2, plainly.'))).toMatchObject({ quote: 0 });
  });

  it('reads the answer, the filters and a comment', () => {
    const a = block({ t: 'answer', key: 'k1', label: 'Copilot Search', runs: ['The best'], sources: [{ r: 'link', node: 's.1', fp: 'a', url: 'https://r.example/', runs: ['r.example'] }, 'text'] });
    expect(a).toMatchObject({ t: 'answer', name: 'Copilot Search', blocks: [{ t: 'para' }], sources: [{ t: 'link', ref: 's.1' }] });
    const f = block({ t: 'filters', key: 'k1', count: 58, runs: [{ r: 'button', node: 'f.1', fp: 'a', label: 'Free Shipping', pressed: true }], sort: { r: 'select', node: 'f.2', fp: 'b', label: 'Sort', options: ['Featured'], selected: 0 }, menus: [{ label: 'Price', kind: 'filters', runs: [{ r: 'button', node: 'f.3', fp: 'c', label: 'Under $25' }] }] });
    expect(f).toMatchObject({ t: 'filters', count: 58, chips: [{ t: 'button', pressed: true }], sort: { t: 'select', label: 'Sort' }, groups: [{ name: 'Price', kind: 'filters' }] });
    const c = block({ t: 'comment', key: 'k1', kind: 'answer', depth: 1, author: { name: 'ada', role: 'OP' }, score: '12', up: { r: 'button', node: 'u', fp: 'a', label: 'Upvote', pressed: true }, down: { r: 'button', node: 'd', fp: 'b', label: 'Downvote' }, reply: { r: 'button', node: 'r', fp: 'c', label: 'Reply' }, accepted: true, more: 3, runs: ['Sort it first.'] });
    expect(c).toMatchObject({ t: 'comment', kind: 'answer', nest: 1, author: 'ada', role: 'OP', vote: { up: 'u', down: 'd', score: '12', state: 'up' }, reply: { ref: 'r' }, accepted: true, more: 3 });
    expect(block({ t: 'paywall', key: 'k1' })).toEqual({ t: 'paywall', dialog: false });
    expect(block({ t: 'structured', key: 'k1', type: 'recipe', data: {} })).toBeNull();
  });
});

describe('parseHead', () => {
  it('needs a rev, and reads the site, what was hidden, a challenge and the article', () => {
    const nodes = new Map<string, Target>();
    expect(parseHead({ url: 'https://x.example/' }, nodes)).toBeNull();
    const m = parseHead(
      {
        ...HEAD,
        rev: 7,
        url: 'https://x.example/',
        origin: 'https://x.example',
        kind: 'article',
        // An action with a tag the schema lacks, or without its node, is dropped; the rest stay.
        site: { name: 'X', icon: 'img9', actions: [{ tag: 'cart', node: 'c.1', fp: 'a', label: 'Cart', count: 2 }, { tag: 'nope', node: 'c.2', fp: 'b', label: 'N' }, { tag: 'search', label: 'S' }] },
        hidden: { counts: { ads: 5, cookie: 1, shorts: 2 }, trackers: 14, done: { cookie: 'rejected' } },
        challenge: { reason: 'person_check' },
        article: { kicker: 'Desks', byline: ['A', 'B'], readMinutes: 6, lead: { image: 'img4', width: 1200, height: 800, caption: 'A desk', credit: 'Photo: C' } },
      },
      nodes,
    );
    expect(m).toMatchObject({ rev: 7, mode: 'article', origin: 'https://x.example', challenge: 'person_check' });
    expect(m?.site).toEqual({ name: 'X', icon: 'img9', actions: [{ kind: 'cart', ref: 'c.1', label: 'Cart', count: 2 }] });
    // A site action's block, for `act`, is "site".
    expect(nodes.get('c.1')).toEqual({ fp: 'a', block: 'site' });
    // Blocking is on unless the desk says `false` (section 14 at 8161db0); no `done.label`, no label.
    expect(m?.hidden).toMatchObject({ trackers: 14, cookie: 'rejected', cookieLabel: '', blocking: true });
    // The count is the rows, never the trackers.
    expect(hiddenTotal(m?.hidden ?? null)).toBe(8);
    expect(m?.article).toMatchObject({ kicker: 'Desks', byline: ['A', 'B'], readMinutes: 6, lead: { img: { src: 'img4' }, caption: 'A desk', credit: 'Photo: C' } });
    // A site the member turned blocking off for: nothing hidden, `blocking: false`; the label the desk pressed is text.
    const off = parseHead({ ...HEAD, rev: 1, url: 'https://x.example/', hidden: { counts: {}, blocking: false, done: { cookie: 'rejected', label: 'Reject\u202e all' } } }, nodes);
    expect(off?.hidden).toMatchObject({ blocking: false, cookieLabel: 'Reject all' });
    expect(hiddenTotal(off?.hidden ?? null)).toBe(0);
    // A part that doesn't fit is left out; the head stays.
    expect(parseHead({ ...HEAD, rev: 1, url: 'https://x.example/', challenge: { reason: 'what' }, hidden: { counts: {}, blocking: 'no' } }, nodes)).toMatchObject({ challenge: null, hidden: null });
    // A head that doesn't fit isn't read at all: a field it doesn't name, a missing one, another version.
    expect(parseHead({ ...HEAD, rev: 1, url: 'https://x.example/', style: 'x' }, nodes)).toBeNull();
    expect(parseHead({ ...HEAD, rev: 1 }, nodes)).toBeNull();
    expect(parseHead({ ...HEAD, rev: 1, url: 'https://x.example/', v: 2 }, nodes)).toBeNull();
  });
});

describe('the vote line (finding 1)', () => {
  const btn = (node: string, label: string) => ({ r: 'button', node, fp: 'a', label });
  it("reads a number between two buttons as R26's vote, never a channel row", () => {
    const b = block(para(btn('v.1', 'Up'), ' 27548 ', btn('v.2', 'Down')));
    const c = (b as Extract<Block, { t: 'para' }>).c;
    expect(bareVote(c)).toMatchObject({ t: 'vote', up: 'v.1', down: 'v.2', score: '27548', state: null });
    for (const score of ['1,204', '-3', '1.2k']) {
      expect(bareVote((block(para(btn('v.1', 'Up'), ` ${score} `, btn('v.2', 'Down'))) as Extract<Block, { t: 'para' }>).c)).toMatchObject({ score });
    }
  });
  it('leaves a name, a word or a longer line alone', () => {
    const run = (...r: unknown[]) => (block(para(...r)) as Extract<Block, { t: 'para' }>).c;
    expect(bareVote(run(btn('v.1', 'Subscribe'), ' Lantern Films ', btn('v.2', 'Like')))).toBeNull();
    expect(bareVote(run(btn('v.1', 'Up'), ' 12 votes ', btn('v.2', 'Down')))).toBeNull();
    expect(bareVote(run(btn('v.1', 'Up'), ' 12 ', btn('v.2', 'Down'), ' ana_k '))).toBeNull();
    expect(bareVote(run(btn('v.1', 'Up'), ' 12 '))).toBeNull();
  });
});

describe('where replies fold (finding 5)', () => {
  it('folds a comment block deeper than 2 (R27: three levels), a paragraph reply deeper than 3', () => {
    const comment = (nest: number) => ({ t: 'comment', nest }) as unknown as Block;
    const p = (nest: number) => ({ t: 'para', nest }) as unknown as Block;
    expect([0, 1, 2, 3].map((n) => foldsDeep(comment(n)))).toEqual([false, false, false, true]);
    expect([0, 1, 2, 3, 4].map((n) => foldsDeep(p(n)))).toEqual([false, false, false, false, true]);
    expect(MAX_COMMENT_NEST).toBe(2);
  });
});

describe("the site row's actions (finding 2)", () => {
  const act = (kind: SiteAction['kind'], ref: string, label = ''): SiteAction => ({ kind, ref, label, count: null });
  const bar = (raw: unknown) => block(raw) as Extract<Block, { t: 'bar' }>;
  const search = { r: 'field', node: 's.1', fp: 'a', kind: 'query', label: 'Search', value: '' };
  const menus = [{ label: 'Site menu', kind: 'menu', runs: [{ r: 'link', node: 'm.1', fp: 'b', url: 'https://x.example/', runs: ['Home'] }] }];
  const site = (...actions: SiteAction[]): SiteInfo => ({ name: 'X', icon: null, actions });
  it("on deskd's real path (the head carries site.actions) still shows Search and Menu beside Sign in", () => {
    const b = bar({ t: 'bar', key: 'k1', runs: [search], menus });
    expect(rowSlots(site(act('signin', 'h.1', 'Log in')), b, false)).toEqual([{ t: 'search' }, { t: 'menu', i: 0 }, { t: 'action', a: act('signin', 'h.1', 'Log in') }]);
  });
  it('is Search, Menu, Cart, Sign in in that order, three at most, a kind once, the head first', () => {
    const b = bar({ t: 'bar', key: 'k1', runs: [search, { r: 'link', node: 'b.1', fp: 'c', url: 'https://x.example/in', runs: ['Sign in'] }], menus });
    const slots = rowSlots(site(act('cart', 'h.2', 'Cart'), act('signin', 'h.1', 'Log in')), b, false);
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.t)).toEqual(['search', 'menu', 'action']);
    expect(slots[2]).toEqual({ t: 'action', a: act('cart', 'h.2', 'Cart') });
    // Without a search field, the cart gets the third place.
    expect(rowSlots(site(act('cart', 'h.2', 'Cart'), act('signin', 'h.1', 'Log in')), bar({ t: 'bar', key: 'k1', runs: [], menus }), false).map((s) => (s.t === 'action' ? s.a.kind : s.t))).toEqual(['menu', 'cart', 'signin']);
  });
  it('puts a cart before Sign in, with a count or without (the Nov 9 re-review)', () => {
    const b = bar({ t: 'bar', key: 'k1', runs: [search], menus });
    const kinds = (...a: SiteAction[]) => rowSlots(site(...a), b, false).map((s) => (s.t === 'action' ? `${s.a.kind}${s.a.count ?? ''}` : s.t));
    expect(kinds({ ...act('cart', 'h.2', 'Cart'), count: 2 }, act('signin', 'h.1', 'Sign in'))).toEqual(['search', 'menu', 'cart2']);
    expect(kinds(act('signin', 'h.1', 'Sign in'), { ...act('cart', 'h.2', 'Cart'), count: 2 })).toEqual(['search', 'menu', 'cart2']);
    expect(kinds(act('cart', 'h.2', 'Cart'), act('signin', 'h.1', 'Sign in'))).toEqual(['search', 'menu', 'cart']);
    expect(kinds({ ...act('cart', 'h.2', 'Cart'), count: 0 }, act('signin', 'h.1', 'Sign in'))).toEqual(['search', 'menu', 'cart0']);
    // With room for both, the counted cart still comes first; the bar's own cart and its count count too.
    expect(rowSlots(site({ ...act('cart', 'h.2', 'Cart'), count: 1 }, act('signin', 'h.1')), bar({ t: 'bar', key: 'k1', runs: [], menus }), false).map((s) => (s.t === 'action' ? s.a.kind : s.t))).toEqual(['menu', 'cart', 'signin']);
    const own = bar({ t: 'bar', key: 'k1', runs: [search, { r: 'link', node: 'b.1', fp: 'c', url: 'https://x.example/in', runs: ['Sign in'] }, { r: 'link', node: 'b.2', fp: 'd', url: 'https://x.example/cart', runs: ['Cart 3'] }], menus });
    expect(rowSlots(null, own, false).map((s) => (s.t === 'action' ? `${s.a.kind}${s.a.count ?? ''}` : s.t))).toEqual(['search', 'menu', 'cart3']);
  });
  it("takes the head's Search and Sections where the bar has none, and no Search on a results page", () => {
    expect(rowSlots(site(act('search', 'h.0'), act('sections', 'h.3'), act('signin', 'h.1')), null, false).map((s) => (s.t === 'action' ? s.a.kind : s.t))).toEqual(['search', 'sections', 'signin']);
    const b = bar({ t: 'bar', key: 'k1', runs: [search], menus });
    expect(rowSlots(site(act('search', 'h.0'), act('signin', 'h.1')), b, true).map((s) => (s.t === 'action' ? s.a.kind : s.t))).toEqual(['menu', 'signin']);
  });
  it('is never just "Log in" when the bar has more', () => {
    const b = bar({ t: 'bar', key: 'k1', runs: [search], menus });
    expect(rowSlots(site(act('signin', 'h.1', 'Log in')), b, false).length).toBeGreaterThan(1);
  });
});

describe("an article's date (the real test desk, Nov 9: Wikipedia's facts line read 2003-12-30T21:52:59Z)", () => {
  it('reads an ISO 8601 day as the day the page gave, and leaves any other words alone', () => {
    expect(shownDate('2003-12-30T21:52:59Z')).toBe('Dec 30, 2003');
    expect(shownDate('2026-11-09T23:30:00-07:00')).toBe('Nov 9, 2026');
    expect(shownDate('2026-11-09T05:34:00.000+05:30')).toBe('Nov 9, 2026');
    expect(shownDate('2012-06-27')).toBe('Jun 27, 2012');
    for (const words of ['Updated Monday, November 9, 2026', 'Nov 4', '2026-13-01', '2026-02-30', '', 'yesterday']) expect(shownDate(words)).toBe(words);
  });
});
