// Dev and test only: a desk's side of the simplified view (task 47), on a small scale. Never in a production bundle.
// It speaks `deskd`'s wire as API.md section 14 has it (`sub/minified-stage-a` `8161db0`: the ad switch too), with what `a26aee5` added (`fold`,
// `filters`, `paywall`, the `vote` run, `terms_wall`, a site keyed by its registrable domain): the closed MDoc schema
// copied at `web/src/simple/mdoc-schema.json` is the authority, and `mockSimpleView.test.ts` holds every page here to
// it. Its pages are made up here; a test can load others, such as the prototype's own captures, which `fromCapture`
// turns into MDoc as `deskd`'s builder would. Every site, person and product is invented.
//
// Nothing here may touch `window` or `document` at import time or in the pure parts (`builtInPages`, `toMDoc`,
// `fromCapture`): the unit test runs them under Node.
import { THEMES } from '../theme/tokens';

type Raw = Record<string, unknown>;
type Timer = ReturnType<typeof setTimeout>;

/** One of the prototype's captured pages, in its v1 format (synthetic ones are in `tests/fixtures/captures/*.doc.json`). */
export interface Capture {
  meta: Raw;
  order: string[];
  add: Record<string, Raw>;
}

export interface MockSimplePage {
  title: string;
  kind?: 'article' | 'page';
  /** Section 14 blocks without `key`; the mock keys them. Controls carry `node`; the mock adds `fp` (`fp-<node>`) where a page left it out. */
  blocks: Raw[];
  /** `get` answers `view: 'stream'` with this `fallback.reason`, and `cause` with it (a `challenge`'s, `remembered`'s). */
  fallback?: string;
  cause?: string;
  /** The head's own parts: `site`, `hidden`, `challenge`, `article`, `pageHeight`, `sensitive`, `origin`. */
  head?: Raw;
}

/** One island's media element, as the mock desk plays it. */
interface MockMedia {
  time: number;
  duration: number;
  playing: boolean;
  since: number;
  volume: number;
  muted: boolean;
  captions: boolean;
}

export interface MockSimpleControl {
  /**
   * The desk's `deskd` serves section 14. False, as every desk today: each `browser.minified.*` method and the topic
   * answer `not_found`, as a `deskd` before it would, and the office shows the real page with no switch. A test of the
   * view turns it on; `npm run dev` with `?simple=1` does too.
   */
  serves: boolean;
  pages: Record<string, MockSimplePage>;
  /** A page from a test: a `MockSimplePage`, or one of the prototype's captures `{meta, order, add}`, converted with `fromCapture`. */
  loadPage(url: string, page: MockSimplePage | Capture): void;
  /** The desk's site memory, by registrable domain (here: the host's last two labels, lower case). */
  sites: Record<string, 'simplified' | 'stream'>;
  /** Sites with ad blocking turned off (`browser.adblock.site.set`), by registrable domain, as `/data/desk/adblock-off`. */
  adblockOff: string[];
  /** Answer `browser.adblock.site.set` `not_found`, as a `deskd` before the switch would. */
  noAdblockSwitch: boolean;
  /** How long `browser.minified.site.get` takes to answer, either way: the window's question about the view among them. */
  siteDelayMs: number;
  /** Island ids whose `browser.minified.island` answers `live: false, reason: 'covered'`. */
  refuseIslands: string[];
  /** How long the desk takes to give an island's box. */
  islandDelayMs: number;
  /** The island's box comes, but the stream stays the whole screen: a `deskd` that sends no `stream.crop`. */
  noCrop: boolean;
  /** Every `act` with `action: 'media'`, as `{nodeId, ...value}` (so `{nodeId: 'v1', verb: 'play'}`). */
  media: Raw[];
  /** `get`s with `retry: true`. */
  retries: number;
  /** The island whose crop the stream carries now: set by a live `browser.minified.island`, cleared by a non-live `browser.stream.set` or a new page. */
  island: { key: string; w: number; h: number } | null;
  /** Every `browser.minified.act`'s params, as sent. */
  acts: Raw[];
  /** Answer every act `{done: false, reason: 'missed'}`, as the zero-wrong-target rule would. */
  refuseActs: boolean;
  /** `get` answers `pending` and the topic sends nothing, as a desk whose distiller hangs. */
  silent: boolean;
  /** How long a page takes to come after the tab gets there. */
  delayMs: number;
  /** Answer `browser.minified.image` with a picture, as a tab that loaded its images. */
  images: boolean;
  /** Topic events sent plus `get` replies that carried an `mdoc`. */
  sent: number;
}

// ----------------------------------------------------------------- building blocks, in section 14's shapes

type Run = string | Raw;

const b = (...runs: Run[]): Raw => ({ r: 'b', runs });
const it = (...runs: Run[]): Raw => ({ r: 'i', runs });
const br = (): Raw => ({ r: 'br' });
const link = (node: string, url: string, ...runs: Run[]): Raw => ({ r: 'link', node, url, runs });
const btn = (node: string, label: string, extra: Raw = {}): Raw => ({ r: 'button', node, label, ...extra });
const field = (node: string, kind: string, label: string, extra: Raw = {}): Raw => ({ r: 'field', node, kind, label, value: '', ...extra });
const select = (node: string, label: string, options: string[], selected: number): Raw => ({ r: 'select', node, label, options, selected });
const check = (node: string, kind: 'checkbox' | 'radio', label: string, checked: boolean, extra: Raw = {}): Raw => ({ r: 'check', node, kind, checked, label, ...extra });
const vote = (score: string, up: string, down: string, state?: 'up' | 'down'): Raw => ({ r: 'vote', score, up: { node: up }, down: { node: down }, ...(state ? { state } : {}) });

const heading = (level: number, ...runs: Run[]): Raw => ({ t: 'heading', level, runs });
const para = (...runs: Run[]): Raw => ({ t: 'para', runs });
const deep = (depth: number, ...runs: Run[]): Raw => ({ t: 'para', depth, runs });
const item = (ordinal: number, ...runs: Run[]): Raw => ({ t: 'item', depth: 1, ordinal, runs });
const grouped = (block: Raw): Raw => ({ ...block, grouped: true });

// ----------------------------------------------------------------- made-up pages

function essay(): MockSimplePage {
  const blocks: Raw[] = [
    {
      t: 'bar',
      runs: [field('m1', 'query', 'Search', { placeholder: 'Search the journal', enter: true }), btn('m6', 'Search')],
      menus: [{ label: 'Site menu', kind: 'menu', runs: [link('m2', 'https://read.example/', 'Home'), link('m3', 'https://read.example/latest', 'Latest'), link('m4', 'https://read.example/about', 'About'), btn('m5', 'Subscribe')] }],
    },
    heading(1, 'The quiet craft of keeping a desk'),
    { t: 'meta', runs: ['By a staff writer · 6 min read'] },
    para('Most of what makes a workplace calm is invisible. It is the drawer that closes, the light that stays even, the ', it('absence'), ' of things asking for attention. This essay is a test page: every word was written for the office’s own tests.'),
    { t: 'image', image: 'img-desk', alt: 'A wooden desk by a window', width: 1200, height: 675 },
    para('A desk, like a page, reads best when it holds only what you came for. ', link('e1', 'https://read.example/notes/attention', 'Attention'), ' is the scarce part, and ', b('clutter spends it'), ' before you notice.'),
    heading(2, 'Three habits'),
    item(1, 'Clear the surface at the end of the day.'),
    item(2, 'Keep one thing open at a time, and ', link('e2', 'https://read.example/notes/close', 'close the rest'), '.'),
    item(3, 'Leave a note for tomorrow’s first task.'),
    { t: 'para', quote: 1, runs: ['A tidy desk is not a goal. It is what remains when you stop adding things you do not need.'] },
    heading(2, 'What the numbers say'),
    {
      t: 'table',
      rows: [
        [{ head: true, runs: ['Habit'] }, { head: true, runs: ['Minutes a day'] }, { head: true, runs: ['Kept after a month'] }],
        [{ runs: ['Clear the surface'] }, { runs: ['4'] }, { runs: ['71%'] }],
        [{ runs: ['One thing open'] }, { runs: ['0'] }, { runs: ['48%'] }],
        [{ runs: ['A note for tomorrow'] }, { runs: ['2'] }, { runs: ['83%'] }],
      ],
    },
    para('The figures above are made up for this test, and so is the code below.'),
    { t: 'code', text: 'function tidy(desk) {\n\treturn desk.filter((thing) => thing.needed);\n}' },
  ];
  for (let i = 1; i <= 36; i += 1) {
    if (i % 9 === 0) blocks.push(heading(2, `Part ${i / 9 + 2}`));
    blocks.push(para(`Paragraph ${i}. The long middle of an essay is where a reader settles in, so it needs room to breathe: a measured line, generous spacing, and nothing moving at the edges. `, link(`e${10 + i}`, `https://read.example/notes/${i}`, `Note ${i}`), ` follows it, and the page carries on in the same calm voice, sentence after sentence, until it ends.`));
  }
  blocks.push({ t: 'rule' }, para('Thanks for reading. ', link('e90', 'https://read.example/latest', 'More essays'), '.'));
  blocks.push(
    { t: 'group', label: 'More from this site', size: 1 },
    grouped({
      t: 'cards',
      layout: 'grid',
      repeat: 2,
      items: [
        { title: { node: 'g1', url: 'https://read.example/notes/drawers', text: 'Why a drawer that closes beats a shelf' }, image: { image: 'img-drawer', width: 320, height: 240 }, meta: ['4 min read'] },
        { title: { node: 'g2', url: 'https://read.example/notes/light', text: 'The case for one even light' }, image: { image: 'img-light', width: 320, height: 240 }, meta: ['6 min read'] },
      ],
    }),
  );
  return {
    title: 'The quiet craft of keeping a desk',
    kind: 'article',
    blocks,
    head: {
      site: { name: 'The Quiet Journal' },
      hidden: { counts: { ads: 5, cookie: 1, newsletter: 1, recommended: 1 }, trackers: 14, done: { cookie: 'rejected' } },
      article: { byline: ['A staff writer'], readMinutes: 6 },
    },
  };
}

function result(q: string, i: number): Raw {
  return {
    title: { node: `r${i}`, url: `https://shop${i % 3}.example/item/${i}`, text: `${q || 'Result'} ${i}: a brass desk lamp, model ${100 + i}` },
    snippet: 'Warm light, a weighted base and a cloth cord. Made to sit quietly at the edge of a desk and light the page, not the room.',
    meta: [`shop${i % 3}.example › lamps`],
    ...(i % 3 === 1 ? { image: { image: `img-r${i}`, width: 400, height: 300 } } : {}),
  };
}

function results(q: string, extra = 0): MockSimplePage {
  const n = 8 + extra;
  const items: Raw[] = [];
  for (let i = 1; i <= n; i += 1) items.push(result(q, i));
  return {
    title: `${q} at Wayfind`,
    kind: 'page',
    blocks: [
      { t: 'bar', runs: [field('s1', 'query', 'Search', { value: q, placeholder: 'Search', enter: true }), btn('s2', 'Search')], menus: [] },
      {
        t: 'answer',
        label: 'Wayfind Answer',
        runs: [
          b('The best desk lamps combine adjustable light, low glare and a steady base,'),
          ' with brass and walnut models leading most reviews this year.',
          br(),
          br(),
          b('Top picks'),
          br(),
          b('Best overall: '),
          'a brass lamp with a weighted base and a warm, even light.',
          br(),
          b('Best budget: '),
          'a clamp lamp that folds flat and fits a small desk.',
          br(),
          b('Best for reading: '),
          'a walnut lamp with a linen shade and a dimmer.',
          br(),
          b('Best for a small room: '),
          'a slim lamp on a wall arm, which keeps the desk clear.',
          br(),
          br(),
          'Reviewers agree that a lamp should light the page, not the room, and that a dimmer is worth paying for. Most also say a warm bulb reads easier late in the day, and that a cloth cord lasts longer than a plastic one.',
        ],
        sources: [link('sa1', 'https://reviews.example/lamps', 'reviews.example'), link('sa2', 'https://homeandlight.example/best', 'homeandlight.example')],
      },
      { t: 'cards', layout: 'list', repeat: 4, items: items.slice(0, 4) },
      heading(2, 'Videos'),
      {
        t: 'cards',
        layout: 'grid',
        repeat: 3,
        items: [
          { title: { node: 'v1', url: 'https://watch.example/clip', text: 'Wiring a brass lamp, start to finish' }, image: { image: 'img-w1', width: 640, height: 360 }, duration: '8:14', meta: ['Lampworks', '3 wk ago'] },
          { title: { node: 'v2', url: 'https://watch.example/clip2', text: 'Three desk lamps compared in one long evening' }, image: { image: 'img-w2', width: 640, height: 360 }, duration: '12:40', meta: ['Quiet Rooms', '2 mo ago'] },
          { title: { node: 'v3', url: 'https://watch.example/clip3', text: 'Why warm light reads easier' }, image: { image: 'img-w3', width: 640, height: 360 }, duration: '5:02', meta: ['Lampworks', '1 yr ago'] },
        ],
      },
      { t: 'cards', layout: 'list', repeat: items.length - 4, items: items.slice(4) },
    ],
    head: { site: { name: 'Wayfind' }, hidden: { counts: { sponsored: 3, ads: 1 }, trackers: 6 } },
  };
}

function shop(): MockSimplePage {
  const lamps = ['Brass desk lamp', 'Walnut reading lamp', 'Linen shade floor lamp', 'Clamp lamp, matte black', 'Ceramic table lamp', 'Banker\u2019s lamp, green'];
  return {
    title: 'Desk lamps',
    kind: 'page',
    blocks: [
      {
        t: 'bar',
        runs: [field('p1', 'query', 'Search the shop', { placeholder: 'Search the shop', enter: true })],
        menus: [{ label: 'Site menu', kind: 'menu', runs: [link('p2', 'https://shop.example/new', 'New'), link('p3', 'https://shop.example/lamps', 'Lamps'), link('p4', 'https://shop.example/desks', 'Desks'), link('p7', 'https://shop.example/signin', 'Sign in'), link('p8', 'https://shop.example/cart', 'Cart 1')] }],
      },
      {
        t: 'filters',
        count: 14,
        runs: [btn('fl1', 'Free delivery'), btn('fl2', 'Under $100', { pressed: true }), select('fl3', 'Delivery day', ['Delivery day', 'Tomorrow', 'This week'], 0), btn('fl4', 'Brass'), btn('fl5', 'Dimmable')],
        sort: select('fs', 'Sort', ['Sort: Featured', 'Sort: Price, low to high', 'Sort: Rating'], 0),
        menus: [
          { label: 'Delivery', kind: 'filters', runs: [btn('fl1', 'Free delivery'), btn('fl6', 'Tomorrow')] },
          { label: 'Price', kind: 'filters', runs: [btn('fl2', 'Under $100', { pressed: true }), btn('fl7', '$100 to $200'), btn('fl8', 'Over $200')] },
          { label: 'Material', kind: 'filters', runs: [btn('fl4', 'Brass'), btn('fl9', 'Walnut'), btn('fl10', 'Linen')] },
          { label: 'Features', kind: 'filters', runs: [btn('fl5', 'Dimmable'), btn('fl11', 'USB port')] },
        ],
      },
      { t: 'meta', runs: ['1 to 6 of 214 lamps'] },
      heading(1, 'Desk lamps'),
      {
        t: 'cards',
        layout: 'grid',
        repeat: lamps.length,
        items: lamps.map((text, i) => ({
          title: { node: `l${i}`, url: `https://shop.example/lamps/${i}`, text },
          image: { image: `img-lamp${i}`, width: 600, height: 600 },
          price: `$${(48 + i * 17).toFixed(2)}`,
          rating: ['4.6', '4.2', '4.8', '3.9', '4.5', '4.7'][i],
          chips: i % 2 ? ['In stock'] : ['New', 'Free delivery'],
          actions: [btn(`l${i}c`, 'Add to cart')],
          // One card with every listing field (R13): the list price struck, the rating's count, a badge, a delivery line.
          ...(i === 2 ? { listPrice: '$99.00', ratingCount: '1,204', badge: 'Best seller', delivery: 'Free delivery tomorrow' } : {}),
          // A condition worth its own line only when it's bad (R13, the Designer's call).
          ...(i === 3 ? { meta: ['Out of stock'] } : {}),
        })),
      },
    ],
    head: {
      site: { name: 'Northfield Lamps', actions: [{ tag: 'search', node: 'p1', label: 'Search' }, { tag: 'signin', node: 'p7', label: 'Sign in' }, { tag: 'cart', node: 'p8', label: 'Cart', count: 1 }] },
      hidden: { counts: { ads: 2, popup: 1 }, trackers: 9 },
    },
  };
}

function qa(): MockSimplePage {
  const code = ['#include <algorithm>', '#include <ctime>', '#include <iostream>', '', 'int main()', '{', '    // Generate data', '    const unsigned arraySize = 32768;', '    int data[arraySize];', '', '    for (unsigned c = 0; c < arraySize; ++c)', '        data[c] = std::rand() % 256;', '', '    // With this, the next loop runs faster.', '    std::sort(data, data + arraySize);', '', '    // Test', '    clock_t start = clock();', '    long long sum = 0;', '    for (unsigned i = 0; i < 100000; ++i)', '    {', '        for (unsigned c = 0; c < arraySize; ++c)', '        {', '            if (data[c] >= 128)', '                sum += data[c];', '        }', '    }', '', '    double elapsedTime = static_cast<double>(clock()-start) / CLOCKS_PER_SEC;', '', '    std::cout << elapsedTime << \'\\n\';', '    std::cout << "sum = " << sum << \'\\n\';', '}'].join('\n');
  return {
    title: 'Why is a sorted array faster to process?',
    kind: 'page',
    blocks: [
      heading(1, 'Why is processing a sorted array faster than an unsorted one?'),
      { t: 'meta', runs: ['25 answers · asked Jun 27, 2012 · viewed 2.0m times'] },
      para(b('gmancode'), ' asked Jun 27, 2012', vote('27,548', 'q1u', 'q1d')),
      para('In this C++ code, sorting the data (', it('before'), ' the timed region) makes the primary loop about six times faster:'),
      { t: 'code', text: code },
      { t: 'fold', label: 'Comments', kind: 'comments', lead: 2, size: 4, meta: '12 more comments' },
      grouped(para(b('169'), ' Another observation is that you do not need to sort the array, only partition it with the value 128.')),
      grouped(para(b('70'), ' Here is an experiment that shows partitioning is enough: measure it, then sort it.')),
      grouped(para('A third comment, folded.')),
      grouped(para('A fourth comment, folded.')),
      heading(2, '25 Answers'),
      para(b('mysticial'), ' answered Jun 27, 2012 · Accepted', btn('q2', 'Reply'), vote('35,297', 'q2u', 'q2d')),
      para('You are a victim of ', link('q3', 'https://qa.example/wiki/branch-prediction', 'branch prediction'), ' fail.'),
      heading(2, 'More answers'),
      {
        t: 'comment',
        kind: 'answer',
        depth: 0,
        author: { name: 'ada_l', role: 'Moderator' },
        score: '412',
        up: btn('q4u', 'Upvote'),
        down: btn('q4d', 'Downvote'),
        reply: btn('q4r', 'Reply'),
        accepted: true,
        runs: ['Sorting makes the branch predictable: once the values pass 128, every test goes the same way, so the processor guesses right almost every time.'],
      },
      {
        t: 'comment',
        kind: 'answer',
        depth: 0,
        author: { name: 'tomas_k' },
        score: '38',
        up: btn('q5u', 'Upvote'),
        down: btn('q5d', 'Downvote'),
        reply: btn('q5r', 'Reply'),
        more: 3,
        runs: ['A branchless version of the loop runs at the same speed sorted or not, which shows where the time goes.'],
      },
    ],
    head: { site: { name: 'Stack Answers' }, hidden: { counts: { ads: 15, cookie: 1 }, trackers: 22, done: { cookie: 'rejected', label: 'Necessary cookies only' } } },
  };
}

function forum(): MockSimplePage {
  return {
    title: 'Primer for an old enamel sign?',
    kind: 'page',
    blocks: [
      heading(1, 'Primer for an old enamel sign before repainting?'),
      { t: 'meta', runs: ['Restoration · 6 replies'] },
      para(b('hollis_m'), ' · Nov 4', btn('f2', 'Reply'), vote('196', 'f1u', 'f1d')),
      para('Picked this up at an estate sale. Steel, single-sided, the enamel is flaking along the bottom edge. What goes on bare steel first?'),
      deep(1, b('pieter.v'), ' · Nov 4', btn('f3', 'Reply'), vote('60', 'f3u', 'f3d', 'up')),
      deep(1, 'Wire-brush the loose rust, then a rust-converting primer on the bare spots only. Feather the edges of the old enamel.'),
      deep(2, b('hollis_m'), ' · Nov 4', btn('f4', 'Reply'), vote('3', 'f4u', 'f4d')),
      deep(2, 'Thanks. Does the converter need a top primer, or straight to paint?'),
      deep(3, b('pieter.v'), ' · Nov 5', btn('f5', 'Reply'), vote('17', 'f5u', 'f5d')),
      deep(3, 'A thin coat of etch primer over it, then paint.'),
      deep(4, b('ana_k'), ' · Nov 5'),
      deep(4, 'Seconding the etch primer. I skipped it once and regretted it.'),
      deep(5, b('hollis_m'), ' · Nov 6'),
      deep(5, 'Will do. Thanks, both.'),
    ],
    head: { site: { name: 'Workbench Community' } },
  };
}

function watch(): MockSimplePage {
  const video = (island: string, label: string, y: number, w: number, h: number, media: Raw, extra: Raw = {}): Raw => ({
    t: 'island',
    kind: 'video',
    width: w,
    height: h,
    island,
    box: { x: 0, y, width: w, height: h },
    state: 'live',
    label,
    media: { time: 0, paused: true, frame: false, ...media },
    ...extra,
  });
  return {
    title: 'A short film about light',
    kind: 'page',
    blocks: [
      video('v1', 'A short film about light', 80, 1280, 720, { duration: 1120, tracks: [{ kind: 'captions', label: 'English', lang: 'en', on: false }], poster: 'img-poster' }, { main: true }),
      heading(1, 'A short film about light'),
      para(b('Lantern Films'), ' · 182K subscribers ', btn('w1', 'Subscribe'), ' ', btn('w2', 'Like 1.2K'), ' ', btn('w3', 'Share')),
      { t: 'fold', label: 'Description', kind: 'description', lead: 0, size: 2, meta: '12,400 views · 3 days ago' },
      grouped(para('A test page with a video on it. The video shows as a live island: a crop of the real page, streamed only while it plays.')),
      grouped(para('Shot over one long afternoon at a north-facing window.')),
      { t: 'fold', label: 'Comments', kind: 'comments', lead: 0, size: 6, meta: '214' },
      ...Array.from({ length: 6 }, (_, i) => grouped(para(`Comment ${i + 1}. Lovely light in the second half, and the sound is just right for a quiet afternoon.`))),
      heading(2, 'Up next'),
      {
        t: 'cards',
        layout: 'grid',
        repeat: 3,
        items: [
          { title: { node: 'u1', url: 'https://watch.example/u1', text: 'Morning light in a small room' }, image: { image: 'img-u1', width: 640, height: 360 }, duration: '12:45', meta: ['Lantern Films', '2 wk ago'] },
          { title: { node: 'u2', url: 'https://watch.example/u2', text: 'Window, table, and an hour of rain' }, image: { image: 'img-u2', width: 640, height: 360 }, duration: '1:02:10', meta: ['Quiet Rooms', '1 mo ago'] },
          { title: { node: 'u3', url: 'https://watch.example/u3', text: 'How we light a desk for film' }, image: { image: 'img-u3', width: 640, height: 360 }, duration: '8:02', meta: ['Lantern Films', '3 mo ago'] },
        ],
      },
      para('More from the channel, below.'),
      video('v2', 'Morning, slowly', 2400, 640, 360, { duration: 92 }),
      video('v3', 'A rented film', 2800, 640, 360, { duration: 5400, drm: true }),
      { t: 'island', kind: 'frame', width: 300, height: 250, state: 'none', ad: true, label: 'advertisement' },
      para('The end of the page.'),
    ],
    head: { site: { name: 'Kestrel' }, hidden: { counts: { ads: 3, recommended: 2 }, trackers: 11 } },
  };
}

function signin(): MockSimplePage {
  return {
    title: 'Notebooks and paper',
    kind: 'page',
    blocks: [
      { t: 'para', dialog: true, runs: ['We use cookies to remember your basket.'] },
      { t: 'para', dialog: true, runs: [btn('c1', 'Reject all'), ' ', btn('c2', 'Accept')] },
      { t: 'heading', level: 2, dialog: true, runs: ['Sign in to see your orders'] },
      { t: 'para', dialog: true, runs: [field('f1', 'email_address', 'Email')] },
      { t: 'para', dialog: true, runs: [{ r: 'sensitive', kind: 'password', origin: 'https://shop.example' }] },
      heading(1, 'Notebooks and paper'),
      para('A test shop page with a sign-in dialog over it.'),
      item(0, link('n1', 'https://shop.example/notebook-a5', 'A5 notebook, dotted')),
      item(0, link('n2', 'https://shop.example/notebook-a4', 'A4 notebook, plain')),
    ],
    head: { sensitive: true },
  };
}

function form(): MockSimplePage {
  return {
    title: 'Book a table',
    kind: 'page',
    blocks: [
      heading(1, 'Book a table'),
      para(field('g1', 'plain', 'Your name', { placeholder: 'Your name', enter: true })),
      para(field('g2', 'phone_number', 'Phone', { enter: true })),
      para(select('g3', 'Guests', ['1 guest', '2 guests', '4 guests'], 1)),
      para(check('g4', 'checkbox', 'Window seat', false)),
      para(check('g5', 'radio', 'Lunch', true, { group: 'meal' }), check('g6', 'radio', 'Dinner', false, { group: 'meal' })),
      para(field('g7', 'multiline', 'Notes', { placeholder: 'Anything we should know?' })),
      para(field('g8', 'date_choice', 'Date')),
      para(btn('g9', 'Book')),
    ],
  };
}

/** Everything a hostile page, or a broken desk, might send. None of it may do anything but show as text (T47-6). Invalid against the schema on purpose. */
function hostile(): MockSimplePage {
  return {
    title: 'Your Minimalist Alliance session expired',
    kind: 'page',
    blocks: [
      heading(1, '<script>window.__svPwned = 1</script><img src=x onerror="window.__svPwned = 2">'),
      para(link('x1', 'javascript:window.__svPwned=3', 'A javascript link'), ' ', link('x2', 'data:text/html,<script>window.__svPwned=4</script>', 'A data link'), ' ', link('x3', 'https://user:pass@evil.example/', 'A link with a password in it'), ' ', link('x4', 'https://ok.example/\u202egnp.exe', 'A plain link')),
      para('Right-to-left override: \u202eevil.example\u202c and a bell \u0007.'),
      // Fields the schema never names: the whole block is dropped (T47O-1), so none of it shows.
      { t: 'para', runs: ['A block the schema refuses.'], dangerouslySetInnerHTML: { __html: '<b>raw</b>' }, style: 'color:red', class: 'evil', id: 'ma-root' },
      { t: 'image', image: 'img-evil-pixel', alt: 'tracking pixel', width: 400, height: 200 },
      { t: 'nonsense', runs: ['an unknown block'] },
      para({ r: 'zz', node: 'r9', runs: ['an unknown run'] }, link('x5', 'https://ok.example/', b(it({ r: 'code', runs: [{ r: 'sup', runs: [{ r: 'sub', runs: [{ r: 's', runs: [b(it('deep'))] }] }] }] })))),
      { t: 'para', dialog: true, runs: ['Your Minimalist Alliance session expired. Sign in again.'] },
      // An HTML input type where deskd's own word belongs: the client must never set `type=` from it (T47-1).
      { t: 'para', dialog: true, runs: [field('x6', 'password', 'One-time code'), ' ', { r: 'sensitive', kind: 'one_time_code', origin: 'https://hostile.example' }] },
    ],
  };
}

function paywalled(): MockSimplePage {
  return {
    title: 'A town that kept its trains',
    kind: 'article',
    blocks: [
      heading(1, 'A town that kept its trains'),
      { t: 'meta', runs: ['By a staff writer · 4 min read'] },
      para('When the line was due to close, the town bought the station for a pound and ran it with volunteers. Forty years on, the trains still stop twice an hour.'),
      para('The timetable hangs in the waiting room, written by hand each spring. Nobody has missed a train for want of knowing when it comes.'),
      para('This article is made up for the office’s tests, and its wall is too: the real page shows only this much to a reader who hasn’t subscribed.'),
      { t: 'paywall' },
    ],
    head: { article: { kicker: 'Transport', byline: ['A staff writer'], readMinutes: 4 } },
  };
}

/** A docs page (the spec's R52 and R58): its sections in place, and its own contents in the chrome, so the rail shows. */
function docs(): MockSimplePage {
  const sections = ['Syntax', 'Parameters', 'Return value', 'Description', 'Examples'];
  return {
    title: 'Array.prototype.sorted()',
    kind: 'article',
    blocks: [
      {
        t: 'bar',
        runs: [field('d1', 'query', 'Search the docs', { placeholder: 'Search the docs', enter: true })],
        menus: [
          { label: 'In this article', kind: 'contents', runs: sections.map((x, i) => link(`dc${i}`, `https://docs.example/api/sorted#${x.toLowerCase().replace(/ /g, '-')}`, x)) },
          { label: 'Reference', kind: 'menu', runs: [link('dr1', 'https://docs.example/api/', 'Arrays'), link('dr2', 'https://docs.example/api/maps', 'Maps')] },
        ],
      },
      heading(1, 'Array.prototype.sorted()'),
      para('The ', { r: 'code', runs: ['sorted()'] }, ' method of an array returns a new array with its elements in order, and leaves the array it was called on as it was.'),
      heading(2, 'Syntax'),
      { t: 'code', text: 'sorted()\nsorted(compareFn)' },
      heading(2, 'Parameters'),
      para({ r: 'code', runs: ['compareFn'] }, ' (optional): a function that says the order of two elements. It returns a negative number if the first comes first, a positive one if it comes second, and zero to keep their order.'),
      heading(2, 'Return value'),
      para('A new array with the elements in order. Its length is the original’s.'),
      heading(2, 'Description'),
      ...Array.from({ length: 4 }, (_, i) => para(`Paragraph ${i + 1} of the description, made up for the office’s tests. Without a compare function, elements are put in order by their text, so 10 comes before 9; with one, numbers sort as numbers. The sort is stable: elements that compare equal keep the order they had.`)),
      heading(2, 'Examples'),
      { t: 'code', text: 'const months = [\'Mar\', \'Jan\', \'Feb\'];\nconst inOrder = months.sorted();\nconsole.log(inOrder); // [\'Feb\', \'Jan\', \'Mar\']\nconsole.log(months); // [\'Mar\', \'Jan\', \'Feb\']' },
      ...Array.from({ length: 4 }, (_, i) => para(`Example note ${i + 1}: sorting a copy keeps the original for the next step, which is why this method exists beside the one that sorts in place.`)),
    ],
    head: { site: { name: 'Docs' }, hidden: { counts: { ads: 2 } } },
  };
}

/**
 * Stack Overflow as `deskd` really sends it (P24, task 47's brand review): the head carries `site.actions: [signin]`, the bar has
 * a search field and a menu, the question's vote is two buttons around a number (no `vote` mark), and its comments are
 * `comment` blocks four levels deep.
 */
function stack(): MockSimplePage {
  const c = (n: number, depth: number, text: string): Raw => ({ t: 'comment', kind: 'comment', depth, author: { name: `user${n}` }, reply: btn(`c${n}r`, 'Reply'), runs: [text] });
  return {
    title: 'Why is processing a sorted array faster?',
    kind: 'page',
    blocks: [
      { t: 'bar', runs: [field('so3s', 'query', 'Search', { placeholder: 'Search', enter: true })], menus: [{ label: 'Site menu', kind: 'menu', runs: [link('so3o', 'https://so.example/', 'Home'), link('so3y', 'https://so.example/questions', 'Questions')] }] },
      heading(1, 'Why is processing a sorted array faster than processing an unsorted array?'),
      para(btn('so1u', 'Up'), ' 27548 ', btn('so1d', 'Down')),
      para('In this C++ code, sorting the data makes the primary loop about six times faster.'),
      c(1, 0, 'A top-level comment.'),
      c(2, 1, 'A reply to it.'),
      c(3, 2, 'A reply to a reply.'),
      c(4, 3, 'Deeper than R27 shows: folded.'),
    ],
    head: { site: { name: 'Stack Overflow', actions: [{ tag: 'signin', node: 'so3v', label: 'Log in' }] } },
  };
}

const plain = (host: string): MockSimplePage => ({ title: host, kind: 'page', blocks: [heading(1, host), para('A plain test page, made up by the mock desk.')] });

/** Every page the mock desk has built in, by URL (a search page too, which the desk makes per query). */
export function builtInPages(): Record<string, MockSimplePage> {
  return {
    'https://read.example/essay': essay(),
    'https://watch.example/clip': watch(),
    'https://shop.example/signin': signin(),
    'https://form.example/book': form(),
    'https://hostile.example/': hostile(),
    'https://shop.example/lamps': shop(),
    'https://forum.example/t/primer': forum(),
    'https://so.example/q/sorted': stack(),
    'https://qa.example/q/sorted-array': qa(),
    'https://search.example/?q=lamps': results('lamps'),
    'https://news.example/paywalled': paywalled(),
    'https://docs.example/api/sorted': docs(),
    'https://bank.example/': { title: 'Bank', blocks: [], fallback: 'sensitive_site' },
    'https://map.example/': { title: 'Map', blocks: [], fallback: 'canvas_app' },
    'https://broken.example/': { title: 'Broken', blocks: [], fallback: 'distiller_error' },
    'https://terms.example/': { title: 'Terms', blocks: [], fallback: 'terms_wall' },
    // A page only the member can get through falls back with its cause (section 14 at `d0561b4`).
    'https://check.example/': { title: 'Just a moment', blocks: [], fallback: 'challenge', cause: 'person_check' },
    'https://pay.example/checkout': { title: 'Checkout', blocks: [], fallback: 'challenge', cause: 'payment' },
    'https://login.example/': { title: 'Sign in', blocks: [], fallback: 'challenge', cause: 'sign_in' },
    'https://gone.example/': { title: 'Not found', blocks: [], fallback: 'http_error' },
  };
}

// ----------------------------------------------------------------- MDoc

function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every control with a `node` gets its fingerprint, and every live island its own, as deskd's half would give them. */
function withFps<T>(tree: T): T {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (typeof v['node'] === 'string' && v['fp'] === undefined) v['fp'] = `fp-${v['node']}`;
      if (v['t'] === 'island' && typeof v['island'] === 'string' && v['fp'] === undefined) v['fp'] = `fp-${v['island']}`;
      Object.values(v).forEach(walk);
    }
  };
  walk(tree);
  return tree;
}

/** The MDoc a page is at this `rev`: the head, then every block keyed by a hash of itself, unique in the document. */
export function toMDoc(url: string, page: MockSimplePage, at: { tabId: string; rev: number }): Raw {
  let origin: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
  } catch {
    // not a URL: no origin
  }
  const used = new Set<string>();
  const blocks = page.blocks.map((raw) => {
    const block = withFps(clone(raw));
    delete block['key'];
    const base = hash(JSON.stringify(block));
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}~${n}`;
    used.add(key);
    return { ...block, key };
  });
  return {
    v: 1,
    tabId: at.tabId,
    rev: at.rev,
    url: url.slice(0, 2048),
    ...(origin ? { origin } : {}),
    title: page.title.slice(0, 256),
    kind: page.kind ?? 'page',
    sensitive: false,
    truncated: false,
    loading: false,
    blocks,
    ...withFps(clone(page.head ?? {})),
  };
}

/** The head alone, as a patch carries it. */
const headOf = (doc: Raw): Raw => {
  const head = { ...doc };
  delete head['blocks'];
  return head;
};

const keysOf = (doc: Raw): string[] => (doc['blocks'] as Raw[]).map((x) => x['key'] as string);

/** One splice from `before` to `after`: the blocks they share at each end stay. */
export function splice(before: Raw, after: Raw): { at: number; remove: number; insert: Raw[] } {
  const a = keysOf(before);
  const z = keysOf(after);
  let at = 0;
  while (at < a.length && at < z.length && a[at] === z[at]) at += 1;
  let tail = 0;
  while (tail < a.length - at && tail < z.length - at && a[a.length - 1 - tail] === z[z.length - 1 - tail]) tail += 1;
  return { at, remove: a.length - at - tail, insert: (after['blocks'] as Raw[]).slice(at, z.length - tail) };
}

// ----------------------------------------------------------------- the prototype's captures, as deskd's builder would make them

const FORMATS = new Set(['b', 'i', 'code', 'sup', 'sub', 's']);
const TEXT_KINDS: Record<string, string> = { text: 'plain', search: 'query', email: 'email_address', tel: 'phone_number', url: 'web_address', number: 'numeric' };
const CHOICE_KINDS: Record<string, string> = { date: 'date_choice', time: 'time_choice', 'datetime-local': 'datetime_choice', month: 'month_choice', week: 'week_choice', color: 'colour_choice', range: 'range_choice', file: 'file_choice' };
const SECRET_AC = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/i;

const int = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const on = (v: unknown): boolean => v === true || v === 1;
const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 2048) : null);
const imageId = (src: unknown): string | null => (typeof src === 'string' && src ? `img-${hash(src)}` : null);

function captureRuns(raw: unknown, origin: string | null): Run[] {
  if (!Array.isArray(raw)) return [];
  const out: Run[] = [];
  for (const x of raw) {
    const r = captureRun(x, origin);
    if (r !== null && r !== '') out.push(r);
  }
  return out;
}

function nodeOf(ref: unknown): Raw {
  return typeof ref === 'string' && ref ? { node: ref } : {};
}

function captureInput(ref: unknown, o: Raw, origin: string | null): Raw | null {
  const type = typeof o['t'] === 'string' ? o['t'].toLowerCase() : 'text';
  const label = text(o['l'], 200);
  const ac = typeof o['ac'] === 'string' ? o['ac'] : '';
  const where = origin ? { origin } : {};
  if (type === 'password') return { r: 'sensitive', kind: 'password', ...where };
  if (/one-time-code/i.test(ac)) return { r: 'sensitive', kind: 'one_time_code', ...where };
  if (/(^|\s)cc-/i.test(ac)) return { r: 'sensitive', kind: 'card', ...where };
  if (on(o['mask']) || SECRET_AC.test(ac)) return { r: 'sensitive', kind: 'masked', ...where };
  const disabled = on(o['d']) ? { disabled: true } : {};
  if (type === 'checkbox' || type === 'radio') {
    const group = text(o['g'], 80);
    return { r: 'check', ...nodeOf(ref), kind: type, checked: on(o['c']), label, ...(group ? { group } : {}), ...disabled };
  }
  if (type === 'submit' || type === 'button' || type === 'reset') return { r: 'button', ...nodeOf(ref), label: text(o['v'], 200) || label, ...disabled };
  if (type === 'hidden') return null;
  const choice = CHOICE_KINDS[type];
  const kind = choice ?? TEXT_KINDS[type] ?? 'plain';
  const placeholder = text(o['p'], 200);
  return { r: 'field', ...nodeOf(ref), kind, label, value: text(o['v'], 20_000), ...(placeholder ? { placeholder } : {}), ...disabled, ...(choice ? {} : { enter: true }) };
}

function captureRun(x: unknown, origin: string | null): Run | null {
  if (typeof x === 'string') return x;
  if (!Array.isArray(x) || typeof x[0] !== 'string') return null;
  const tag = x[0];
  if (FORMATS.has(tag)) {
    const runs = captureRuns(x.slice(1), origin);
    return runs.length ? { r: tag, runs } : null;
  }
  switch (tag) {
    case 'br':
      return { r: 'br' };
    case 'a': {
      const url = httpUrl(x[2]);
      const runs = captureRuns(x.slice(3), origin);
      if (!runs.length) runs.push(url ? url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) : 'link');
      return { r: 'link', ...nodeOf(x[1]), ...(url ? { url } : {}), runs };
    }
    case 'img': {
      const image = imageId(x[1]);
      return image ? { r: 'image', image, alt: text(x[2], 200), width: int(x[3], 0, 20_000, 0), height: int(x[4], 0, 20_000, 0) } : null;
    }
    case 'btn': {
      const f = isObj(x[3]) ? x[3] : {};
      const flags: Raw = {};
      if (f['p'] === 1 || f['p'] === 0) flags['pressed'] = f['p'] === 1;
      if (f['e'] === 1 || f['e'] === 0) flags['expanded'] = f['e'] === 1;
      if (f['s'] === 1) flags['selected'] = true;
      if (on(f['d'])) flags['disabled'] = true;
      return { r: 'button', ...nodeOf(x[1]), label: text(x[2], 200), ...flags };
    }
    case 'in':
      return isObj(x[2]) ? captureInput(x[1], x[2], origin) : null;
    case 'ta': {
      if (!isObj(x[2])) return null;
      const o = x[2];
      const placeholder = text(o['p'], 200);
      const oneLine = on(o['enter']);
      return { r: 'field', ...nodeOf(x[1]), kind: oneLine ? 'plain' : 'multiline', label: text(o['l'], 200), value: text(o['v'], 20_000), ...(placeholder ? { placeholder } : {}), ...(on(o['d']) ? { disabled: true } : {}), ...(oneLine ? { enter: true } : {}) };
    }
    case 'sel': {
      if (!isObj(x[2])) return null;
      const o = x[2];
      const pairs = Array.isArray(o['o']) ? o['o'].filter((p): p is unknown[] => Array.isArray(p)).slice(0, 300) : [];
      return { r: 'select', ...nodeOf(x[1]), label: text(o['l'], 200), options: pairs.map((p) => text(p[1], 200)), selected: pairs.findIndex((p) => p[0] === o['v']), ...(on(o['d']) ? { disabled: true } : {}) };
    }
    default:
      return null;
  }
}

function captureBlock(raw: Raw, origin: string | null): Raw | null {
  const dialog = on(raw['dlg']) ? { dialog: true } : {};
  const runs = (): Run[] => captureRuns(raw['c'], origin);
  switch (raw['k']) {
    case 'h': {
      const c = runs();
      return c.length ? { t: 'heading', level: int(raw['l'], 1, 6, 2), runs: c, ...dialog } : null;
    }
    case 'p': {
      const c = runs();
      if (!c.length) return null;
      return { t: 'para', runs: c, ...(typeof raw['q'] === 'number' ? { quote: int(raw['q'], 1, 8, 1) } : {}), ...(typeof raw['n'] === 'number' && raw['n'] > 0 ? { depth: int(raw['n'], 1, 8, 1) } : {}), ...dialog };
    }
    case 'li': {
      const c = runs();
      return c.length ? { t: 'item', depth: int(raw['d'], 1, 8, 1), ordinal: int(raw['o'], 0, 1_000_000, 0), ...(on(raw['cont']) ? { cont: true } : {}), runs: c, ...dialog } : null;
    }
    case 'pre': {
      const code = text(raw['t'], 200_000);
      return code.trim() ? { t: 'code', text: code, ...dialog } : null;
    }
    case 'hr':
      return { t: 'rule', ...dialog };
    case 'img': {
      const image = imageId(raw['s']);
      if (!image) return null;
      const url = httpUrl(raw['u']);
      const opens = typeof raw['r'] === 'string' ? { link: { node: raw['r'], ...(url ? { url } : {}) } } : {};
      return { t: 'image', image, alt: text(raw['a'], 200), width: int(raw['w'], 0, 20_000, 0), height: int(raw['h'], 0, 20_000, 0), ...opens, ...dialog };
    }
    case 'tbl': {
      if (!Array.isArray(raw['rows'])) return null;
      const rows = raw['rows']
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.filter(isObj).map((cell) => ({ ...(on(cell['h']) ? { head: true } : {}), ...(typeof cell['cs'] === 'number' ? { span: int(cell['cs'], 1, 20, 1) } : {}), runs: captureRuns(cell['c'], origin) })))
        .filter((row) => row.length);
      return rows.length ? { t: 'table', rows, ...dialog } : null;
    }
    case 'meta': {
      const c = runs();
      return c.length ? { t: 'meta', runs: c, ...dialog } : null;
    }
    case 'chrome': {
      const c = runs();
      return c.length ? { t: 'controls', runs: c, ...dialog } : null;
    }
    case 'media': {
      const m = raw['m'] === 'iframe' ? 'frame' : raw['m'];
      if (m !== 'video' && m !== 'audio' && m !== 'canvas' && m !== 'frame' && m !== 'embed') return null;
      const label = text(raw['n'], 100);
      return { t: 'island', kind: m, width: int(raw['w'], 0, 20_000, 0), height: int(raw['h'], 0, 20_000, 0), state: 'none', ...(label ? { label } : {}), ...dialog };
    }
    default:
      return null;
  }
}

/** One of the prototype's captures (v1 shapes) as section 14 blocks; anything else in it is dropped. */
export function fromCapture(raw: Capture): MockSimplePage {
  let origin: string | null = null;
  try {
    origin = new URL(String(raw.meta['url'])).origin;
  } catch {
    // no origin
  }
  const blocks: Raw[] = [];
  for (const h of raw.order) {
    const x = raw.add[h];
    const block = isObj(x) ? captureBlock(x, origin) : null;
    if (block) blocks.push(block);
  }
  return {
    title: text(raw.meta['title'], 256),
    kind: raw.meta['mode'] === 'article' ? 'article' : 'page',
    blocks,
    head: raw.meta['truncated'] === true ? { truncated: true } : {},
  };
}

// ----------------------------------------------------------------- the desk

/** A host's registrable domain, as `SiteMemory` keys it (here, its last two labels). */
const registrable = (host: string): string => host.toLowerCase().split('.').filter(Boolean).slice(-2).join('.');

const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
};

function fail(code: string, details: Raw = {}): never {
  throw Object.assign(new Error(`${code}${details['reason'] ? `: ${String(details['reason'])}` : ''}`), { code, details });
}

interface Live {
  tabId: string;
  url: string;
  /** Null: not a web page. */
  page: MockSimplePage | null;
  /** The rev this page started at: an act from before it is about another document. */
  startRev: number;
  /** The distiller has answered (after `delayMs`). */
  ready: boolean;
  /** The MDoc as last sent, or null before `ready`. */
  doc: Raw | null;
  /** `get` with `retry` looked again: the site's memory doesn't hold for this page. */
  retried: boolean;
  /** Result cards added to a search page by `scroll`. */
  extra: number;
}

const ACTIONS = new Set(['click', 'check', 'fill', 'press', 'select', 'scroll', 'media']);
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'Backspace']);
const VERBS = new Set(['play', 'pause', 'seek', 'volume', 'track']);

export class MockSimpleDesk {
  readonly control: MockSimpleControl;
  private readonly watchers = new Map<string, Set<(e: Raw) => void>>();
  private readonly revs = new Map<string, number>();
  private readonly players = new Map<string, MockMedia>();
  private live: Live | null = null;
  private seq = 0;
  private epoch = 0;
  private readyTimer: Timer | undefined;
  private changeTimer: Timer | undefined;

  constructor(private readonly navigate: (url: string) => void) {
    const pages = builtInPages();
    this.control = {
      pages,
      serves: false,
      loadPage: (url, page) => {
        pages[url] = 'order' in page ? fromCapture(page) : page;
      },
      sites: {},
      adblockOff: [],
      noAdblockSwitch: false,
      siteDelayMs: 0,
      refuseIslands: [],
      islandDelayMs: 0,
      noCrop: false,
      media: [],
      retries: 0,
      island: null,
      acts: [],
      refuseActs: false,
      silent: false,
      delayMs: 40,
      images: true,
      sent: 0,
    };
  }

  private nextRev(tabId: string): number {
    const rev = (this.revs.get(tabId) ?? 0) + 1;
    this.revs.set(tabId, rev);
    return rev;
  }

  private pageFor(url: string, extra = 0): MockSimplePage | null {
    if (url.startsWith('https://search.example/')) return results(new URL(url).searchParams.get('q') ?? '', extra);
    const host = hostOf(url);
    if (!host) return null;
    return this.control.pages[url] ?? plain(host);
  }

  /** The tab on screen is now at this URL. */
  tabChanged(tabId: string, url: string): void {
    if (this.live && this.live.url === url && this.live.tabId === tabId) return;
    const startRev = this.nextRev(tabId);
    this.live = { tabId, url, page: this.pageFor(url), startRev, ready: false, doc: null, retried: false, extra: 0 };
    this.control.island = null;
    this.players.clear();
    clearTimeout(this.readyTimer);
    clearTimeout(this.changeTimer);
    const live = this.live;
    this.readyTimer = setTimeout(() => {
      if (this.live !== live) return;
      live.ready = true;
      live.doc = live.page ? this.mdoc(live.url, live.page, { tabId, rev: this.nextRev(tabId) }) : null;
      if (!live.doc) this.nextRev(tabId);
      this.emit(tabId, 'changed', this.state(tabId));
    }, this.control.delayMs);
  }

  watch(tabId: string, fn: (e: Raw) => void): () => void {
    let set = this.watchers.get(tabId);
    if (!set) {
      set = new Set();
      this.watchers.set(tabId, set);
    }
    set.add(fn);
    const timer = setTimeout(() => {
      if (this.control.silent || !set.has(fn)) return;
      this.seq += 1;
      this.control.sent += 1;
      fn({ type: 'snapshot', seq: this.seq, ...this.state(tabId) });
    }, 10);
    return () => {
      clearTimeout(timer);
      set.delete(fn);
    };
  }

  private emit(tabId: string, type: string, data: Raw): void {
    if (this.control.silent) return;
    for (const fn of this.watchers.get(tabId) ?? []) {
      this.seq += 1;
      this.control.sent += 1;
      fn({ type, seq: this.seq, ...data });
    }
  }

  /** What the tab shows now: `get`'s answer without the MDoc, and the topic's `snapshot`. */
  private state(tabId: string, retry = false): Raw {
    const rev = this.revs.get(tabId) ?? 0;
    const live = this.live;
    if (!live || live.tabId !== tabId || !live.ready || this.control.silent) return { tabId, rev, view: 'pending' };
    if (!live.page) return { tabId, rev, view: 'stream', fallback: { reason: 'not_page' } };
    if (live.page.fallback) return { tabId, rev, view: 'stream', fallback: { reason: live.page.fallback, ...(live.page.cause ? { cause: live.page.cause } : {}) } };
    if (!retry && !live.retried && this.control.sites[registrable(hostOf(live.url))] === 'stream') return { tabId, rev, view: 'stream', fallback: { reason: 'member_choice' } };
    return { tabId, rev, view: 'simplified' };
  }

  /** A page's MDoc, with `hidden.blocking: false` on a site the member turned blocking off for, as deskd's head says. */
  private mdoc(url: string, page: MockSimplePage, at: { tabId: string; rev: number }): Raw {
    const doc = toMDoc(url, page, at);
    if (!this.control.adblockOff.includes(registrable(hostOf(url)))) return doc;
    const hidden = isObj(doc['hidden']) ? doc['hidden'] : { counts: {} };
    return { ...doc, hidden: { ...hidden, blocking: false } };
  }

  /** The page changed under the member's act: one patch from the MDoc they had to the new one. */
  private changed(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      const live = this.live;
      if (!live?.ready || !live.page || !live.doc) return;
      const before = live.doc;
      const probe = this.mdoc(live.url, live.page, { tabId: live.tabId, rev: before['rev'] as number });
      if (JSON.stringify(probe) === JSON.stringify(before)) return;
      const rev = this.nextRev(live.tabId);
      const after = { ...probe, rev };
      live.doc = after;
      this.emit(live.tabId, 'patch', { tabId: live.tabId, base: before['rev'], rev, ...splice(before, after), head: headOf(after) });
    }, 16);
  }

  answer(method: string, params: Raw): unknown {
    const c = this.control;
    switch (method) {
      case 'browser.minified.get':
        return this.get(params);
      case 'browser.minified.act':
        return this.act(params);
      case 'browser.minified.image':
        return this.image(params);
      case 'browser.minified.island':
        return this.island(params);
      case 'browser.minified.site.get':
      case 'browser.minified.site.set': {
        const named = typeof params['host'] === 'string' ? params['host'] : params['tabId'] === undefined || params['tabId'] === this.live?.tabId ? hostOf(this.live?.url ?? '') : '';
        const host = registrable(named);
        if (!host) fail('bad_request', { reason: 'host' });
        if (method === 'browser.minified.site.set' && 'view' in params) {
          const view = params['view'];
          if (view === null || view === undefined) delete c.sites[host];
          else if (view === 'simplified' || view === 'stream') c.sites[host] = view;
          else fail('bad_request', { reason: 'view' });
          // A choice of the simplified view looks at the page again, as deskd's would.
          const live = this.live;
          if (view === 'simplified' && live && registrable(hostOf(live.url)) === host) setTimeout(() => this.live === live && this.emit(live.tabId, 'changed', this.state(live.tabId)), 16);
        }
        return { host, ...(c.sites[host] ? { view: c.sites[host] } : {}), sensitive: false };
      }
      case 'browser.minified.sites.list':
        return { sites: Object.entries(c.sites).map(([host, view]) => ({ host, view, sensitive: false })) };
      case 'browser.minified.sites.clear':
        for (const host of Object.keys(c.sites)) delete c.sites[host];
        c.adblockOff.length = 0;
        return {};
      case 'browser.adblock.site.set': {
        // ADR 0073's per-site switch: the desk keeps the list, and the page loads again under it.
        if (c.noAdblockSwitch) fail('not_found');
        if (typeof params['on'] !== 'boolean') fail('bad_request', { reason: 'on' });
        const named = typeof params['host'] === 'string' ? params['host'] : hostOf(this.live?.url ?? '');
        const host = registrable(named);
        if (!host) fail('bad_request', { reason: 'host' });
        const at = c.adblockOff.indexOf(host);
        if (params['on'] && at >= 0) c.adblockOff.splice(at, 1);
        if (!params['on'] && at < 0) c.adblockOff.push(host);
        if (this.live && registrable(hostOf(this.live.url)) === host) this.changed();
        return { host, on: params['on'] };
      }
      default:
        return fail('not_found');
    }
  }

  private tabOf(params: Raw): string {
    const tabId = params['tabId'] ?? this.live?.tabId;
    if (typeof tabId !== 'string' || !this.revs.has(tabId)) fail('not_found', { reason: 'tab' });
    return tabId;
  }

  private get(params: Raw): Raw {
    const tabId = this.tabOf(params);
    const retry = params['retry'] === true;
    if (retry) this.control.retries += 1;
    const live = this.live;
    const state = this.state(tabId, retry);
    if (retry && live && live.tabId === tabId && state['view'] === 'simplified') live.retried = true;
    if (state['view'] !== 'simplified' || !live?.doc) return state;
    if (params['since'] === live.doc['rev']) return { ...state, unchanged: true };
    this.control.sent += 1;
    return { ...state, mdoc: live.doc };
  }

  /** The control `nodeId` names in the block keyed `block` of the MDoc now, or null. */
  private find(doc: Raw, block: unknown, nodeId: string): Raw | null {
    if (block === 'site') {
      const site = doc['site'];
      const actions = isObj(site) && Array.isArray(site['actions']) ? site['actions'] : [];
      return actions.find((a): a is Raw => isObj(a) && a['node'] === nodeId) ?? null;
    }
    const home = (doc['blocks'] as Raw[]).find((x) => x['key'] === block);
    if (!home) return null;
    let found: Raw | null = null;
    const walk = (v: unknown): void => {
      if (found) return;
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) {
        if (v['node'] === nodeId || (v['t'] === 'island' && v['island'] === nodeId)) found = v;
        else Object.values(v).forEach(walk);
      }
    };
    walk(home);
    return found;
  }

  /** The page's own (unkeyed) control for `nodeId`, which an act changes. */
  private source(nodeId: string): Raw | null {
    let found: Raw | null = null;
    const walk = (v: unknown): void => {
      if (found) return;
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) {
        if (v['node'] === nodeId || (v['t'] === 'island' && v['island'] === nodeId)) found = v;
        else Object.values(v).forEach(walk);
      }
    };
    walk(this.live?.page?.blocks ?? []);
    return found;
  }

  private act(params: Raw): unknown {
    const c = this.control;
    c.acts.push({ ...params });
    const action = params['action'];
    const nodeId = params['nodeId'];
    const value = params['value'];
    if (action === 'media') c.media.push({ nodeId, ...(isObj(value) ? value : {}) });
    if (typeof action !== 'string' || !ACTIONS.has(action) || typeof nodeId !== 'string' || typeof params['fp'] !== 'string' || typeof params['rev'] !== 'number' || (typeof params['block'] !== 'string')) fail('bad_request', { reason: 'params' });
    const tabId = this.tabOf(params);
    if (c.refuseActs) return { done: false, reason: 'missed' };
    const live = this.live;
    const rev = params['rev'] as number;
    if (!live || live.tabId !== tabId || !live.doc || rev < live.startRev || rev > (live.doc['rev'] as number)) fail('conflict', { reason: 'changed' });
    const target = this.find(live.doc, params['block'], nodeId);
    if (!target) fail('conflict', { reason: 'gone' });
    if (target['fp'] !== params['fp']) fail('conflict', { reason: 'changed' });
    const own = this.source(nodeId);
    const kind = target['t'] === 'island' ? 'island' : typeof target['r'] === 'string' ? target['r'] : typeof target['tag'] === 'string' ? 'button' : 'text' in target || 'url' in target ? 'link' : 'button';
    switch (action) {
      case 'click': {
        if (kind === 'island' || kind === 'field' || kind === 'select') fail('conflict', { reason: 'kind' });
        const url = httpUrl(own?.['url'] ?? target['url']);
        if (url) {
          setTimeout(() => this.navigate(url), 30);
        } else if ((nodeId === 'c1' || nodeId === 'c2') && live.page) {
          // The cookie banner goes once it's answered.
          live.page.blocks = live.page.blocks.filter((x) => !(x['dialog'] && /cookies|"c1"/.test(JSON.stringify(x))));
          this.changed();
        } else if (kind === 'check' && own) {
          own['checked'] = !own['checked'];
          this.changed();
        }
        return { done: true };
      }
      case 'check':
        if (kind !== 'check' || !own) fail('conflict', { reason: 'kind' });
        if (typeof value !== 'boolean') fail('bad_request', { reason: 'value' });
        own['checked'] = value;
        this.changed();
        return { done: true };
      case 'fill':
        if (kind !== 'field' || !own || /_choice$/.test(String(own['kind']))) fail('conflict', { reason: 'kind' });
        if (typeof value !== 'string') fail('bad_request', { reason: 'value' });
        if (value.length > 65_536) fail('too_large', { limit: 65_536 });
        own['value'] = value;
        this.changed();
        return { done: true };
      case 'press':
        if ((kind !== 'field' && kind !== 'select') || !own) fail('conflict', { reason: 'kind' });
        if (typeof value !== 'string' || !KEYS.has(value)) fail('bad_request', { reason: 'value' });
        if (value === 'Enter' && kind === 'field') {
          const q = String(own['value'] ?? '');
          setTimeout(() => this.navigate(`https://search.example/?q=${encodeURIComponent(q)}`), 30);
        }
        return { done: true };
      case 'select': {
        if (kind !== 'select' || !own) fail('conflict', { reason: 'kind' });
        if (!isObj(value) || typeof value['index'] !== 'number' || typeof value['label'] !== 'string') fail('bad_request', { reason: 'value' });
        const options = Array.isArray(own['options']) ? own['options'] : [];
        const index = value['index'] as number;
        if (options[index] !== value['label']) return { done: false, reason: 'label' };
        own['selected'] = index;
        this.changed();
        return { done: true };
      }
      case 'scroll':
        if (value !== undefined && value !== 'start' && value !== 'center') fail('bad_request', { reason: 'value' });
        // Near the end of a search's results, the real page loads more.
        if (live.url.startsWith('https://search.example/')) {
          live.extra += 8;
          live.page = this.pageFor(live.url, live.extra);
          this.changed();
        }
        return { done: true };
      default:
        if (kind !== 'island') fail('conflict', { reason: 'kind' });
        if (!isObj(value) || typeof value['verb'] !== 'string' || !VERBS.has(value['verb'])) fail('bad_request', { reason: 'value' });
        return this.media(nodeId, target, value);
    }
  }

  /** The island's element: play, pause, seek, the volume, captions. Its state back, as deskd reads it. */
  private media(id: string, island: Raw, value: Raw): Raw {
    const facts = isObj(island['media']) ? island['media'] : {};
    let m = this.players.get(id);
    if (!m) {
      m = { time: Number(facts['time'] ?? 0), duration: Number(facts['duration'] ?? 0), playing: false, since: 0, volume: 1, muted: facts['muted'] === true, captions: false };
      this.players.set(id, m);
    }
    const now = performance.now();
    if (m.playing) m.time = Math.min(m.duration || Infinity, m.time + (now - m.since) / 1000);
    m.since = now;
    switch (value['verb']) {
      case 'play':
        m.playing = true;
        break;
      case 'pause':
        m.playing = false;
        break;
      case 'seek':
        if (typeof value['time'] !== 'number') fail('bad_request', { reason: 'value' });
        m.time = Math.max(0, Math.min(m.duration || Infinity, value['time']));
        break;
      case 'volume':
        if (typeof value['volume'] === 'number') m.volume = Math.max(0, Math.min(1, value['volume']));
        if (typeof value['muted'] === 'boolean') m.muted = value['muted'];
        break;
      default:
        m.captions = typeof value['track'] === 'number' && value['track'] >= 0;
    }
    return { done: true, paused: !m.playing, time: m.time, duration: m.duration, buffered: Math.min(m.duration, m.time + 30), volume: m.volume, muted: m.muted, captions: m.captions };
  }

  private island(params: Raw): unknown {
    const tabId = this.tabOf(params);
    const id = params['islandId'];
    const live = this.live;
    const block = typeof id === 'string' && live?.tabId === tabId && live.doc ? (live.doc['blocks'] as Raw[]).find((x) => x['t'] === 'island' && x['island'] === id) : undefined;
    if (!block) return fail('not_found', { reason: 'island' });
    const w = Number(block['width'] ?? 640);
    const h = Number(block['height'] ?? 360);
    const box = isObj(block['box']) ? block['box'] : {};
    const facts = isObj(block['media']) ? block['media'] : {};
    this.epoch += 1;
    // The element as the real page lays it out: a player in an 880 px column of a 1280 x 720 screen, its shape kept.
    const fit = Math.min(1, 880 / w, 640 / h);
    const base = { islandId: id, kind: block['kind'], epoch: this.epoch, rect: { x: Number(box['x'] ?? 0), y: 80, width: Math.round(w * fit), height: Math.round(h * fit) }, viewport: { width: 1280, height: 720 }, dpr: 1 };
    if (this.control.refuseIslands.includes(id as string)) return { ...base, live: false, reason: 'covered' };
    const player = this.players.get(id as string);
    const answer = (): Raw => {
      if (!this.control.noCrop) this.control.island = { key: id as string, w, h };
      return { ...base, live: true, playing: player?.playing ?? false, muted: player?.muted ?? facts['muted'] === true };
    };
    return this.control.islandDelayMs ? new Promise((done) => setTimeout(() => done(answer()), this.control.islandDelayMs)) : answer();
  }

  private image(params: Raw): unknown {
    this.tabOf(params);
    const id = params['imageId'];
    const doc = this.live?.doc;
    if (typeof id !== 'string' || !doc || !this.control.images || id.includes('evil') || !namesImage(doc, id)) return fail('not_found', { reason: 'image' });
    const url = picture();
    if (!url) return fail('not_found', { reason: 'image' });
    return { imageId: id, mime: 'image/png', data: url.slice(url.indexOf(',') + 1) };
  }
}

/** Whether the MDoc names this image id anywhere: an image block or run, a card's, the site's icon, a poster, an article's lead. */
function namesImage(doc: Raw, id: string): boolean {
  let seen = false;
  const walk = (v: unknown): void => {
    if (seen) return;
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v['image'] === id || v['icon'] === id || v['poster'] === id) seen = true;
      else Object.values(v).forEach(walk);
    }
  };
  walk(doc);
  return seen;
}

/** A made-up picture for an image or an island's still: a soft gradient, so a test page has something in its frames. */
function picture(): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const t = THEMES.light;
  const grad = g.createLinearGradient(0, 0, 320, 180);
  grad.addColorStop(0, t.accent.subtle);
  grad.addColorStop(1, t.ring.activeGlow);
  g.fillStyle = grad;
  g.fillRect(0, 0, 320, 180);
  g.fillStyle = t.glyph.soft;
  g.beginPath();
  g.arc(250, 60, 26, 0, Math.PI * 2);
  g.fill();
  return canvas.toDataURL('image/png');
}
