// The Bible app's view (S-150): a quiet reading room. It runs in the desk app contract's sandboxed frame (no network, no
// storage, no clipboard) and reaches its service only through the Desk app's bridge, in the wire of apps/bible/API.md
// (appApi 1.0). Everything the member reads, marks and types goes between this frame and their desk, nowhere else.
// Plain script, no framework and no build step: index.html is the frame's body, view.css its stylesheet.
'use strict';
(() => {
  // ------------------------------------------------------------------------------------------------ words
  // Sales's final words (business/bible-app-copy.md section 2) and the Designer's labels; the lines marked "draft" are
  // ours, for Sales (docs/sub-status/bible-view.md lists every one).
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const W = {
    gotoPlaceholder: 'Type a reference, like John 3:16',
    savedEmpty: 'Nothing saved yet. Select a verse to highlight, bookmark or add a note.',
    broken: 'This translation couldn’t be opened. The others still work.',
    searchNone: (abbr) => `No verses in ${abbr} with those words.`,
    searchAll: 'Search all four translations',
    searchCount: (n, abbr) => `${n} verses in ${abbr}`,
    goRef: (ref) => `Go to ${ref}`,
    copied: 'Copied',
    deleteNote: 'Delete note',
    noteDeleted: 'Note deleted',
    undo: 'Undo',
    size: 'Size',
    oneVersePerLine: 'One verse per line',
    footnotes: 'Footnotes',
    // The Designer's labels.
    goto: 'Go to', translation: 'Translation', search: 'Search', saved: 'Saved', text: 'Text', more: 'More', close: 'Close',
    ot: 'Old Testament', nt: 'New Testament', books: 'Books', about: (name) => `About ${name}`,
    statement: 'Public-domain statement', source: 'Source',
    highlight: 'Highlight', none: 'None', bookmark: 'Bookmark', note: 'Note', copy: 'Copy',
    all: 'All', bookmarks: 'Bookmarks', highlights: 'Highlights', notes: 'Notes', showAll: (n) => `Show all ${n}`,
    colors: { amber: 'Amber', green: 'Green', blue: 'Blue', rose: 'Rose' },
    // Drafts, for Sales.
    pressCopy: `Press ${MAC ? '⌘C' : 'Ctrl+C'} to copy.`,
    notRef: 'No book or chapter by that name.',
    searchCountAll: (n) => `${n} verses in all four translations`,
    searchNoneAll: 'No verses in any of the four translations with those words.',
    searchPlaceholder: (abbr) => `Search ${abbr}`,
    searchTooLong: 'Search takes up to 12 words.',
    showMore: 'Show more',
    sourceWords: (site, name) => `${site}’s page for the ${name}`,
    sourceHint: 'To visit it, copy this address into your desk’s Browser.',
    noTexts: 'The translations couldn’t be opened. Your highlights, bookmarks and notes are still saved.',
    notAnswering: 'The Bible app isn’t answering.',
    tryAgain: 'Try again',
    full: 'There’s no room on this desk to save more.',
    saveFailed: 'That couldn’t be saved. Try again.',
    failed: 'That didn’t work. Try again.',
    verse: (label) => `Verse ${label}`,
    gutterBookmark: (ref) => `Bookmark, ${ref}`,
    gutterNote: (ref) => `Note, ${ref}`,
    footnote: (l) => `Footnote ${l}`,
    sizeN: (n) => `Size ${n}`,
    chapters: 'Chapters',
    verseActions: 'Verse',
    noteField: 'Note',
    copyField: 'Verses to copy',
  };
  const CREDIT = {
    bsb: 'Berean Standard Bible (BSB). Dedicated to the public domain by its publishers in 2023.',
    web: 'World English Bible (WEB). Public domain.',
    kjv: 'King James Version (KJV), the 1769 text. Public domain in the United States.',
    asv: 'American Standard Version (ASV), 1901. Public domain.',
  };
  // Standard short names for Go to's grid under 560 px (the Designer's: full names from about 600 px wide).
  const SHORT = {
    GEN: 'Gen', EXO: 'Exod', LEV: 'Lev', NUM: 'Num', DEU: 'Deut', JOS: 'Josh', JDG: 'Judg', RUT: 'Ruth', '1SA': '1 Sam', '2SA': '2 Sam',
    '1KI': '1 Kgs', '2KI': '2 Kgs', '1CH': '1 Chr', '2CH': '2 Chr', EZR: 'Ezra', NEH: 'Neh', EST: 'Esth', JOB: 'Job', PSA: 'Ps', PRO: 'Prov',
    ECC: 'Eccl', SNG: 'Song', ISA: 'Isa', JER: 'Jer', LAM: 'Lam', EZK: 'Ezek', DAN: 'Dan', HOS: 'Hos', JOL: 'Joel', AMO: 'Amos', OBA: 'Obad',
    JON: 'Jonah', MIC: 'Mic', NAM: 'Nah', HAB: 'Hab', ZEP: 'Zeph', HAG: 'Hag', ZEC: 'Zech', MAL: 'Mal', MAT: 'Matt', MRK: 'Mark', LUK: 'Luke',
    JHN: 'John', ACT: 'Acts', ROM: 'Rom', '1CO': '1 Cor', '2CO': '2 Cor', GAL: 'Gal', EPH: 'Eph', PHP: 'Phil', COL: 'Col', '1TH': '1 Thess',
    '2TH': '2 Thess', '1TI': '1 Tim', '2TI': '2 Tim', TIT: 'Titus', PHM: 'Phlm', HEB: 'Heb', JAS: 'Jas', '1PE': '1 Pet', '2PE': '2 Pet',
    '1JN': '1 John', '2JN': '2 John', '3JN': '3 John', JUD: 'Jude', REV: 'Rev',
  };
  const COLORS = ['amber', 'blue', 'green', 'rose']; // Notebook's order (its PALETTE)
  const SIZES = [16, 18, 20, 22, 24];
  const DEFAULT_PREFS = { textSize: 18, oneVersePerLine: false, footnotes: true, highlightColor: 'amber', place: null };

  // ------------------------------------------------------------------------------------------------ the bridge
  // The contract sample's bridge (spikes/app-contract-sample/app/view/view.js; docs/app-api/view-bridge.md).
  const bridge = (() => {
    let port = null;
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();
    const ready = new Promise((resolve) => {
      addEventListener('message', (e) => {
        if (e.source !== parent || !e.data || e.data.t !== 'ma.bridge' || !e.ports[0] || port) return;
        port = e.ports[0];
        port.onmessage = ({ data }) => {
          if (!data) return;
          if (data.t === 'res' || data.t === 'err') {
            const p = pending.get(data.id);
            pending.delete(data.id);
            if (p) data.t === 'res' ? p.resolve(data.res) : p.reject(data.err || { code: 'internal' });
          } else if (data.t === 'evt') {
            const l = listeners.get(data.sub);
            if (l) l(data.evt);
          } else if (data.t === 'theme') {
            applyTheme(data.tokens);
          }
        };
        applyTheme(e.data.tokens);
        resolve(e.data);
      });
    });
    const send = (msg) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ ...msg, id });
    });
    return {
      call: async (m, p, idem) => (await ready, send(idem ? { t: 'call', m, p, idem } : { t: 'call', m, p })),
      subscribe: async (topic, onEvent) => {
        await ready;
        const { subId } = await send({ t: 'sub', topic });
        listeners.set(subId, onEvent);
        return subId;
      },
    };
  })();

  function applyTheme(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v === 'string' && /^[A-Za-z0-9.]{1,64}$/.test(k)) root.style.setProperty('--ma-' + k.replace(/\./g, '-'), v);
    }
    if (['light', 'dusk', 'dark'].includes(tokens.theme)) root.dataset.theme = tokens.theme;
  }

  // One member action keeps one key across its retries (API.md, "Mutations"). UUIDv7: 48 bits of time, then random.
  function idemKey() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    let t = Date.now();
    for (let i = 5; i >= 0; i--) {
      b[i] = t % 256;
      t = Math.floor(t / 256);
    }
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reasonOf = (e) => (e && e.details && e.details.reason) || '';
  // The desk not connected, or the service still loading its data: retry, with the same key for a mutation.
  const transient = (e) => e && e.code === 'unavailable' && (reasonOf(e) === 'link' || reasonOf(e) === 'starting');
  async function ask(m, p, idem) {
    for (let i = 0; ; i++) {
      try {
        return await bridge.call(m, p || {}, idem);
      } catch (e) {
        if (!transient(e) || i >= 7) throw e;
        await sleep(Math.min(200 * 2 ** i, 3000));
      }
    }
  }
  const read = (m, p) => ask(m, p);
  const mutate = (m, p) => ask(m, p, idemKey());

  // ------------------------------------------------------------------------------------------------ DOM helpers
  // Plain script, checked by tsc with checkJs (tests/tsconfig.view.json): these casts only tell it what the DOM holds.
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const tgt = (e) => /** @type {any} */ (e.target);
  const all$ = (sel, root = document) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);
  const one$ = (sel, root = document) => /** @type {HTMLElement | null} */ (root.querySelector(sel));
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    search: [['circle', { cx: 10.5, cy: 10.5, r: 6.25 }], ['path', { d: 'M15.3 15.3 20 20' }]],
    ribbon: [['path', { d: 'M6.75 3.75h10.5v16.5L12 16.4l-5.25 3.85z' }]],
    ribbonFill: [['path', { d: 'M6.75 3.75h10.5v16.5L12 16.4l-5.25 3.85z', class: 'fillc' }]],
    note: [['path', { d: 'M5.75 3.75h8.5l4 4v12.5H5.75z' }], ['path', { d: 'M14 3.75V8h4.25' }], ['path', { d: 'M9 12.25h6M9 15.75h4.5' }]],
    close: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
    back: [['path', { d: 'M15 5.5 8.5 12l6.5 6.5' }]],
    copy: [['rect', { x: 8.75, y: 8.75, width: 11, height: 11, rx: 2.2 }], ['path', { d: 'M15.25 8.75V6.2a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.05a2 2 0 0 0 2 2h2.55' }]],
    info: [['circle', { cx: 12, cy: 12, r: 8.6 }], ['path', { d: 'M12 11v5.6' }], ['circle', { cx: 12, cy: 7.7, r: 0.9, class: 'dot' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    left: [['path', { d: 'M19 12H5.5M11 6l-6 6 6 6' }]],
    right: [['path', { d: 'M5 12h13.5M13 6l6 6-6 6' }]],
    goto: [['path', { d: 'M5 12h13.5M13 6l6 6-6 6' }]],
  };
  function icon(name, size = 20) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name]) {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      s.append(n);
    }
    return s;
  }
  const letter = (i) => (i < 26 ? String.fromCharCode(97 + i) : letter(Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26)));

  // ------------------------------------------------------------------------------------------------ state
  const S = {
    translations: [],
    tr: 'bsb',
    booksBy: new Map(), // translation -> books
    prefs: { ...DEFAULT_PREFS },
    at: null, // {book, chapter}: where the window is, even when the text couldn't be read
    ch: null, // bible.chapter's result
    marks: [],
    order: [], // the chapter's verse items' first verse numbers, in reading order
    items: new Map(), // first verse -> item
    itemOf: new Map(), // any verse number -> its item's first verse
    sel: [],
    anchor: null,
    rev: null,
    busy: 0,
    dirty: false,
    search: { q: '', all: false, res: null },
    savedKind: '',
  };
  const app = $('app');
  const col = $('col');
  const scroller = $('scroll');
  const panel = $('panel');
  const layer = $('layer');
  const toastEl = $('toast');
  // Search's count, said through a region that is always there: one put in with the results is often not read (WCAG 4.1.3).
  const saidEl = $('said');
  const narrow = matchMedia('(max-width: 520px)');

  const trInfo = (code) => S.translations.find((t) => t.code === code);
  const abbr = (code) => (trInfo(code) || { abbreviation: String(code).toUpperCase() }).abbreviation;
  function books(code = S.tr) {
    return S.booksBy.get(code) || S.booksBy.values().next().value || [];
  }
  function book(id, code) {
    return books(code).find((b) => b.id === id) || [...S.booksBy.values()].flat().find((b) => b.id === id) || null;
  }
  const bookName = (id, code) => (book(id, code) || { name: id }).name;
  const chapName = (id, n, code) => `${id === 'PSA' ? 'Psalm' : bookName(id, code)} ${n}`;
  function verseRef(id, n, v, ve, code) {
    return `${chapName(id, n, code)}:${v}${ve && ve > v ? `–${ve}` : ''}`;
  }
  function refText(ref, code) {
    return ref.verse ? verseRef(ref.book, ref.chapter, ref.verse, ref.verseEnd, code) : chapName(ref.book, ref.chapter, code);
  }

  // ------------------------------------------------------------------------------------------------ start
  document.title = 'Bible';
  let subscribed = false;
  async function start() {
    app.dataset.state = 'starting';
    col.replaceChildren();
    col.setAttribute('aria-busy', 'true');
    let st;
    try {
      st = await read('bible.state');
    } catch {
      return showNotAnswering();
    }
    S.translations = Array.isArray(st.translations) ? st.translations : [];
    S.prefs = { ...DEFAULT_PREFS, ...(st.prefs || {}) };
    if (st.books) S.booksBy.set(st.translation, st.books);
    S.tr = st.translation || 'bsb';
    applyPrefs();
    if (!subscribed) {
      subscribed = true;
      bridge.subscribe('bible.marks', onMarksEvent).catch(() => {
        subscribed = false;
      });
    }
    app.dataset.state = 'ready';
    for (const b of all$('.tbar button')) /** @type {HTMLButtonElement} */ (b).disabled = false;
    if (st.available === false) return showNoTexts();
    const place = S.prefs.place;
    if (place && place.book && place.chapter) {
      await open({ translation: S.tr, book: place.book, chapter: place.chapter, verse: place.verse, align: 'top' });
    } else {
      await open({ translation: S.tr, book: 'GEN', chapter: 1 });
    }
    scroller.focus({ preventScroll: true });
  }

  function stateMsg(text, ...rest) {
    closeBar();
    col.removeAttribute('aria-busy');
    col.replaceChildren(h('div', { class: 'state', role: 'status' }, h('p', { text }), ...rest));
  }
  function showNotAnswering() {
    app.dataset.state = 'error';
    stateMsg(W.notAnswering, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => start() }, W.tryAgain)));
  }
  function showNoTexts() {
    S.ch = null;
    for (const id of ['refBtn', 'trBtn', 'searchBtn']) $(id).disabled = true;
    updateToolbar();
    stateMsg(W.noTexts);
  }

  // ------------------------------------------------------------------------------------------------ navigation
  let navSeq = 0;
  async function booksFor(code) {
    if (!S.booksBy.has(code)) S.booksBy.set(code, (await read('bible.books', { translation: code })).books);
    return S.booksBy.get(code);
  }

  /** Opens a chapter. `verse` scrolls there: to the top for a restored place or a translation switch, with a brief underlay
   *  for a reference the member went to (`flash`).
   *  @param {{translation: string, book: string, chapter: number, verse?: number, align?: string, flash?: boolean}} to */
  async function open({ translation, book: id, chapter, verse, align, flash }) {
    const seq = ++navSeq;
    const hadFocus = col.contains(document.activeElement);
    let ch;
    try {
      [ch] = await Promise.all([read('bible.chapter', { translation, book: id, chapter }), booksFor(translation)]);
    } catch (e) {
      if (seq !== navSeq) return;
      if (e && e.code === 'unavailable' && reasonOf(e) === 'translation') return showBroken(translation, id, chapter);
      if (e && e.code === 'not_found' && !(id === 'GEN' && chapter === 1)) return open({ translation, book: 'GEN', chapter: 1 });
      return toast(W.failed);
    }
    if (seq !== navSeq) return;
    S.tr = translation;
    S.at = { book: ch.book, chapter: ch.chapter };
    S.ch = ch;
    S.marks = Array.isArray(ch.marks) ? ch.marks : [];
    S.sel = [];
    S.anchor = null;
    render();
    updateToolbar();
    scrollToVerse(verse, align || (flash ? 'flash' : 'top'));
    if (flash && verse) flashVerse(S.itemOf.get(verse) ?? verse);
    if (hadFocus) $('chHead').focus({ preventScroll: true });
    savePlace(true);
  }

  function go(ref, extra) {
    return open({ translation: S.tr, book: ref.book, chapter: ref.chapter, ...extra });
  }

  function showBroken(code, id, chapter) {
    S.tr = code;
    S.at = { book: id, chapter };
    S.ch = null;
    S.marks = [];
    S.sel = [];
    updateToolbar();
    const others = S.translations.filter((t) => t.code !== code);
    stateMsg(W.broken, h('div', { class: 'row' }, others.map((t) => h('button', {
      class: 'btn', type: 'button', onclick: () => open({ translation: t.code, book: id, chapter }),
    }, t.name))));
  }

  function updateToolbar() {
    const at = S.at;
    const ref = at ? chapName(at.book, at.chapter) : '';
    $('refLabel').textContent = ref;
    $('refBtn').setAttribute('aria-label', ref ? `${W.goto}, ${ref}` : W.goto);
    const ab = abbr(S.tr);
    $('trLabel').textContent = ab;
    $('trBtn').setAttribute('aria-label', `${W.translation}, ${ab}`);
  }

  // ------------------------------------------------------------------------------------------------ the reading column
  function render() {
    const ch = S.ch;
    closePopover(false, 'fn');
    closeBar();
    col.removeAttribute('aria-busy');
    col.classList.toggle('ovpl', !!S.prefs.oneVersePerLine);
    S.order = [];
    S.items = new Map();
    S.itemOf = new Map();
    const frag = document.createDocumentFragment();
    frag.append(h('h1', { class: 'ch-head', id: 'chHead', tabindex: '-1' }, chapName(ch.book, ch.chapter)));
    let fnN = 0;
    const nextLetter = () => letter(fnN++);
    let block = null;
    let kind = '';
    const newBlock = (cls, k) => {
      block = h('p', { class: cls });
      kind = k;
      frag.append(block);
      return block;
    };
    for (const it of ch.items || []) {
      if (it.kind === 'heading') {
        frag.append(heading(it, nextLetter));
        block = null;
        continue;
      }
      if (it.kind !== 'verse') continue;
      const start = it.verse;
      S.order.push(start);
      S.items.set(start, it);
      for (let v = start; v <= (it.verseEnd || start); v++) S.itemOf.set(v, start);
      const segs = Array.isArray(it.segments) && it.segments.length ? it.segments : [{ kind: 'prose', at: 0, text: it.text }];
      const notesBy = assignNotes(it, segs);
      // The number goes before the verse's own words, after a Psalm's title inside it ("A Psalm of David.").
      let numAt = segs.findIndex((x) => x.kind !== 'title' && x.kind !== 'heading');
      if (numAt < 0) numAt = segs.findIndex((x) => x.kind !== 'heading');
      let first = true;
      segs.forEach((seg, i) => {
        const pb = i === 0 ? it.p : seg.p;
        const bb = i === 0 ? it.b : seg.b;
        if (seg.kind === 'heading') {
          frag.append(heading(seg, nextLetter));
          block = null;
          return;
        }
        let target;
        const sb = bb ? ' sb' : '';
        if (seg.kind === 'poetry') {
          const lv = Math.min(4, Math.max(1, seg.level | 0 || 1));
          target = newBlock(`ql l${lv}${sb}`, 'q');
          target.dataset.lv = String(lv);
        }
        else if (seg.kind === 'title') target = newBlock(`ttl${sb}`, 't');
        else {
          const k = seg.kind === 'indent' ? 'i' : 'p';
          const fresh = !block || kind !== k || pb || bb || (S.prefs.oneVersePerLine && first);
          target = fresh ? newBlock((k === 'i' ? 'pr pind' : 'pr') + sb, k) : block;
        }
        if (target.childNodes.length) target.append(' ');
        target.append(versePart(it, seg, i === numAt, notesBy.get(i) || [], nextLetter));
        first = false;
      });
      if (S.prefs.oneVersePerLine) block = null;
    }
    const nav = h('nav', { class: 'foot', 'aria-label': W.chapters });
    if (ch.prev) nav.append(h('button', { class: 'qbtn prev', type: 'button', onclick: () => go(ch.prev) }, icon('left', 18), chapName(ch.prev.book, ch.prev.chapter)));
    if (ch.next) nav.append(h('button', { class: 'qbtn next', type: 'button', onclick: () => go(ch.next) }, chapName(ch.next.book, ch.next.chapter), icon('right', 18)));
    frag.append(nav);
    col.replaceChildren(frag);
    hangPoems();
    col.dataset.at = `${S.tr}.${ch.book}.${ch.chapter}`;
    const firstVn = one$('.vn', col);
    if (firstVn) firstVn.tabIndex = 0;
    paintMarks();
  }

  /** A wrapped poetry line hangs 1.5em past the deepest level in its poem (a run of poetry lines), so a wrap never lines
   *  up with the next level's start: 3em in Psalm 23, whose lines are at levels 1 and 2. */
  function hangPoems() {
    let run = [];
    const flush = () => {
      const deepest = Math.max(1, ...run.map((el) => Number(el.dataset.lv) || 1));
      for (const el of run) el.style.setProperty('--wrap', String(deepest));
      run = [];
    };
    for (const el of all$(':scope > *', col)) {
      if (el.classList.contains('ql')) run.push(el);
      else if (run.length) flush();
    }
    if (run.length) flush();
  }

  /** Each footnote goes in the segment whose words it follows: `at` is after the character before it (API.md). */
  function assignNotes(it, segs) {
    const out = new Map();
    const texty = segs.map((s, i) => [s, i]).filter(([s]) => s.kind !== 'heading');
    for (const n of it.notes || []) {
      let pick = texty[texty.length - 1];
      for (const pair of texty) {
        if (n.at <= pair[0].at + pair[0].text.length) {
          pick = pair;
          break;
        }
      }
      if (!pick) continue;
      const [seg, i] = pick;
      const off = Math.max(0, Math.min(seg.text.length, n.at - seg.at));
      if (!out.has(i)) out.set(i, []);
      out.get(i).push({ off, text: n.text });
    }
    for (const list of out.values()) list.sort((a, b) => a.off - b.off);
    return out;
  }

  const fnText = new WeakMap();
  function withNotes(el, text, notes, nextLetter) {
    let i = 0;
    for (const n of notes) {
      el.append(text.slice(i, n.off));
      i = n.off;
      if (S.prefs.footnotes) {
        const l = nextLetter();
        // A span, not a button: a button is an atomic inline, which a line may break before or after, and a marker must
        // never start a line apart from the word it follows.
        const b = h('span', { class: 'fn', role: 'button', tabindex: '0', 'aria-label': W.footnote(l), 'aria-expanded': 'false' }, l);
        fnText.set(b, n.text);
        el.append(b);
      }
    }
    el.append(text.slice(i));
  }

  function heading(it, nextLetter) {
    const lv = String(it.level || '1');
    const el = h(lv === '1' ? 'h2' : lv === '2' ? 'h3' : 'p', { class: `sec${['d', 'r', 'e'].includes(lv) ? ' ' + lv : ''}` });
    withNotes(el, it.text || '', (it.notes || []).map((n) => ({ off: n.at, text: n.text })).sort((a, b) => a.off - b.off), nextLetter);
    return el;
  }

  function versePart(it, seg, first, notes, nextLetter) {
    const part = h('span', { class: seg.kind === 'title' ? 'v ttlp' : 'v', 'data-v': it.verse });
    if (first) {
      const label = it.verseEnd ? `${it.verse}–${it.verseEnd}` : String(it.verse);
      part.append(h('span', { class: 'vn', role: 'button', tabindex: '-1', 'aria-label': W.verse(label), 'aria-pressed': 'false' }, label), ' ');
    }
    const vt = h('span', { class: 'vt' });
    withNotes(vt, seg.text, notes, nextLetter);
    part.append(vt);
    return part;
  }

  const partsOf = (v) => col.querySelectorAll(`.v[data-v="${v}"]`);
  const HL = COLORS.map((c) => `hl-${c}`);

  function paintMarks() {
    if (!S.ch) return;
    for (const vt of col.querySelectorAll('.vt.hl')) vt.classList.remove('hl', ...HL);
    const hl = new Map();
    for (const m of S.marks) {
      if (m.kind !== 'highlight' || !COLORS.includes(m.color)) continue;
      const v = S.itemOf.get(m.verse);
      if (v !== undefined && !hl.has(v)) hl.set(v, m.color);
    }
    for (const [v, c] of hl) for (const p of partsOf(v)) p.querySelector('.vt').classList.add('hl', `hl-${c}`);
    layoutGutter();
    if (S.sel.length) updateBar();
  }

  function marksAt(v) {
    return S.marks.filter((m) => S.itemOf.get(m.verse) === v);
  }

  let openNoteId = null;
  function layoutGutter() {
    const ae = /** @type {HTMLElement | null} */ (document.activeElement);
    const focused = ae && ae.dataset ? ae.dataset.gm : null;
    for (const n of col.querySelectorAll('.gm')) n.remove();
    if (!S.ch) return;
    const by = new Map();
    for (const m of S.marks) {
      if (m.kind === 'highlight') continue;
      const v = S.itemOf.get(m.verse);
      if (v === undefined) continue;
      const e = by.get(v) || {};
      if (m.kind === 'bookmark' && !e.bm) e.bm = m;
      if (m.kind === 'note' && !e.note) e.note = m;
      by.set(v, e);
    }
    if (!by.size) return;
    const cr = col.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(col).lineHeight) || 30;
    for (const [v, e] of by) {
      const part = col.querySelector(`.v[data-v="${v}"]`);
      const r = part && part.querySelector('.vt').getClientRects()[0];
      if (!r) continue;
      let top = r.top + r.height / 2 - cr.top - 12;
      const ref = verseRef(S.ch.book, S.ch.chapter, v);
      for (const [kind, m] of [['bm', e.bm], ['nt', e.note]]) {
        if (!m) continue;
        const key = `${kind}:${v}`;
        const b = h('button', {
          class: `gm ${kind}${kind === 'nt' && m.id === openNoteId ? ' open' : ''}`, type: 'button', 'data-gm': key,
          'aria-label': kind === 'bm' ? W.gutterBookmark(ref) : W.gutterNote(ref),
          onclick: (ev) => {
            ev.stopPropagation();
            if (kind === 'bm') openSaved(m.id);
            else openNote(v, m);
          },
        }, icon(kind === 'bm' ? 'ribbonFill' : 'note', 15));
        b.style.top = `${Math.round(top)}px`;
        part.before(b);
        if (focused === key) b.focus({ preventScroll: true });
        top += lh;
      }
    }
  }

  function scrollToVerse(v, align) {
    if (!v || v <= 1) {
      scroller.scrollTop = 0;
      return;
    }
    const start = S.itemOf.get(v) ?? S.order.filter((x) => x <= v).pop();
    const part = start !== undefined && col.querySelector(`.v[data-v="${start}"]`);
    if (!part) return;
    const r = part.getClientRects()[0] || part.getBoundingClientRect();
    scroller.scrollTop += r.top - scroller.getBoundingClientRect().top - (align === 'flash' ? 56 : 10);
  }

  function flashVerse(v) {
    const parts = partsOf(v);
    for (const p of parts) p.classList.remove('flash');
    void col.offsetWidth;
    for (const p of parts) p.classList.add('flash');
    setTimeout(() => {
      for (const p of parts) p.classList.remove('flash');
    }, 1250);
  }

  /** The verse at the top of the column: the last one that starts at or above its top edge (so a restored place, which
   *  puts its verse's first line there, reads back as the same verse). */
  function topVerse() {
    const limit = scroller.getBoundingClientRect().top + 12;
    let v = S.order[0] || 1;
    let last = null;
    for (const part of all$('.v', col)) {
      if (part.dataset.v === last) continue;
      last = part.dataset.v;
      const r = part.getClientRects()[0];
      if (!r) continue;
      if (r.top > limit) break;
      v = Number(last);
    }
    return v;
  }

  // The place: translation, chapter and the verse at the top of the column, in the app's data (the view has no storage).
  let lastPlace = '';
  let placeTimer = 0;
  function savePlace(now) {
    clearTimeout(placeTimer);
    if (!now) {
      placeTimer = setTimeout(() => savePlace(true), 700);
      return;
    }
    if (!S.ch) return;
    const place = { translation: S.tr, book: S.ch.book, chapter: S.ch.chapter, verse: topVerse() };
    const key = JSON.stringify(place);
    if (key === lastPlace) return;
    lastPlace = key;
    S.prefs.place = place;
    mutate('bible.prefs.set', { place }).catch(() => {
      lastPlace = '';
    });
  }

  // ------------------------------------------------------------------------------------------------ marks
  function onMarksEvent(evt) {
    const rev = evt && evt.data && evt.data.rev;
    if (rev === undefined || rev === S.rev) return;
    const first = S.rev === null;
    S.rev = rev;
    if (!first) refreshMarks();
  }

  let marksSeq = 0;
  async function refreshMarks() {
    if (S.busy) {
      S.dirty = true;
      return;
    }
    S.dirty = false;
    if (panelState && panelState.kind === 'saved') loadSaved(false);
    if (!S.ch) return;
    const seq = ++marksSeq;
    const { book: id, chapter } = S.ch;
    try {
      const r = await read('bible.marks.chapter', { book: id, chapter });
      if (seq !== marksSeq || S.busy || !S.ch || S.ch.book !== id || S.ch.chapter !== chapter) return;
      S.marks = r.marks || [];
      paintMarks();
    } catch {
      /* the next change reads them again */
    }
  }

  /** Runs member actions that change marks: the optimistic paint first, then each call, then the marks as they are. */
  async function marksAction(optimistic, calls) {
    S.busy++;
    optimistic();
    paintMarks();
    try {
      for (const c of calls) await mutate(c[0], c[1]);
    } catch (e) {
      toast(e && e.code === 'precondition_failed' ? W.full : W.saveFailed);
    } finally {
      S.busy--;
      if (!S.busy) refreshMarks();
    }
  }

  // Selected items, merged into runs of verses: [[first, last], …].
  function runs(sel) {
    const out = [];
    const ordered = S.order.filter((v) => sel.includes(v));
    for (const v of ordered) {
      const it = S.items.get(v);
      const end = it.verseEnd || it.verse;
      const last = out[out.length - 1];
      if (last && last[1] + 1 === it.verse) last[1] = end;
      else out.push([it.verse, end]);
    }
    return out;
  }

  function highlightOf(v) {
    const m = marksAt(v).find((x) => x.kind === 'highlight');
    return m ? m.color : '';
  }

  function applyHighlight(color) {
    const sel = S.sel.slice();
    const rs = runs(sel);
    const { book: id, chapter } = S.ch;
    S.prefs.highlightColor = color;
    marksAction(() => {
      S.marks = S.marks.filter((m) => !(m.kind === 'highlight' && sel.includes(S.itemOf.get(m.verse))));
      for (const [a, b] of rs) for (let v = a; v <= b; v++) S.marks.push({ id: `tmp-${v}`, kind: 'highlight', book: id, chapter, verse: v, color });
    }, rs.map(([a, b]) => ['bible.mark.put', { mark: { kind: 'highlight', book: id, chapter, verse: a, ...(b > a ? { verseEnd: b } : {}), color, translation: S.tr } }]));
  }

  function clearHighlight() {
    const sel = S.sel.slice();
    const rs = runs(sel).filter(([a, b]) => S.marks.some((m) => m.kind === 'highlight' && m.verse >= a && m.verse <= b));
    if (!rs.length) return;
    const { book: id, chapter } = S.ch;
    marksAction(() => {
      S.marks = S.marks.filter((m) => !(m.kind === 'highlight' && sel.includes(S.itemOf.get(m.verse))));
    }, rs.map(([a, b]) => ['bible.highlight.clear', { book: id, chapter, verse: a, ...(b > a ? { verseEnd: b } : {}) }]));
  }

  function toggleBookmark() {
    const sel = S.sel.slice();
    const { book: id, chapter } = S.ch;
    const marked = sel.map((v) => marksAt(v).find((m) => m.kind === 'bookmark'));
    if (marked.every(Boolean)) {
      marksAction(() => {
        S.marks = S.marks.filter((m) => !marked.includes(m));
      }, marked.map((m) => ['bible.mark.remove', { id: m.id }]));
    } else {
      const add = sel.filter((v, i) => !marked[i]);
      marksAction(() => {
        for (const v of add) S.marks.push({ id: `tmp-b${v}`, kind: 'bookmark', book: id, chapter, verse: v });
      }, add.map((v) => ['bible.mark.put', { mark: { kind: 'bookmark', book: id, chapter, verse: v, translation: S.tr } }]));
    }
  }

  // ------------------------------------------------------------------------------------------------ selecting verses
  function toggleVerse(v, range) {
    if (range && S.anchor !== null && S.order.includes(S.anchor)) {
      const a = S.order.indexOf(S.anchor);
      const b = S.order.indexOf(v);
      for (const x of S.order.slice(Math.min(a, b), Math.max(a, b) + 1)) if (!S.sel.includes(x)) S.sel.push(x);
    } else if (S.sel.includes(v)) {
      S.sel = S.sel.filter((x) => x !== v);
    } else {
      S.sel.push(v);
    }
    S.anchor = v;
    S.sel = S.order.filter((x) => S.sel.includes(x));
    paintSel();
  }

  function clearSel() {
    S.sel = [];
    S.anchor = null;
    paintSel();
  }

  function paintSel() {
    for (const p of col.querySelectorAll('.v.sel')) p.classList.remove('sel');
    for (const vn of col.querySelectorAll('.vn[aria-pressed="true"]')) vn.setAttribute('aria-pressed', 'false');
    for (const v of S.sel) {
      for (const p of partsOf(v)) p.classList.add('sel');
      const vn = col.querySelector(`.v[data-v="${v}"] .vn`);
      if (vn) vn.setAttribute('aria-pressed', 'true');
    }
    if (S.sel.length) showBar();
    else closeBar();
  }

  col.addEventListener('click', (e) => {
    const t = tgt(e);
    const fn = t.closest('.fn');
    if (fn) {
      e.stopPropagation();
      openFootnote(fn);
      return;
    }
    if (t.closest('.gm, .foot, .abar, .copybox, .state')) return;
    const part = t.closest('.v');
    if (!part) {
      if (S.sel.length) clearSel();
      return;
    }
    const s = getSelection();
    if (e.shiftKey) {
      if (s) s.removeAllRanges();
    } else if (s && !s.isCollapsed && String(s).trim()) {
      return; // a drag that selected words isn't a tap
    }
    toggleVerse(Number(part.dataset.v), e.shiftKey);
  });
  // Shift-click takes a range of verses, not a range of text.
  col.addEventListener('mousedown', (e) => {
    if (e.shiftKey && tgt(e).closest && tgt(e).closest('.v')) e.preventDefault();
  });
  scroller.addEventListener('click', (e) => {
    if (e.target === scroller && S.sel.length) clearSel();
  });

  // The column is one tab stop; ↑ ↓ move between verses, Enter or Space selects (a roving focus).
  col.addEventListener('keydown', (e) => {
    const fn = tgt(e).closest && tgt(e).closest('.fn');
    if (fn && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openFootnote(fn);
      return;
    }
    const vn = tgt(e).closest && tgt(e).closest('.vn');
    if (!vn) return;
    const all = all$('.vn', col);
    const i = all.indexOf(vn);
    let to = -1;
    if (e.key === 'ArrowDown') to = Math.min(all.length - 1, i + 1);
    else if (e.key === 'ArrowUp') to = Math.max(0, i - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = all.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const v = Number(vn.closest('.v').dataset.v);
      toggleVerse(v, e.shiftKey);
      if (S.sel.includes(v)) focusBar();
      return;
    }
    if (to < 0) return;
    e.preventDefault();
    all[to].focus();
  });
  col.addEventListener('focusin', (e) => {
    if (!tgt(e).classList || !tgt(e).classList.contains('vn')) return;
    for (const vn of col.querySelectorAll('.vn[tabindex="0"]')) vn.tabIndex = -1;
    tgt(e).tabIndex = 0;
    for (const p of partsOf(tgt(e).closest('.v').dataset.v)) p.classList.add('kf');
  });
  col.addEventListener('focusout', (e) => {
    if (tgt(e).classList && tgt(e).classList.contains('vn')) for (const p of col.querySelectorAll('.v.kf')) p.classList.remove('kf');
  });

  // ------------------------------------------------------------------------------------------------ the action bar
  let bar = null;
  function buildBar() {
    const sw = COLORS.map((c) => h('button', {
      class: 'sw', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': W.colors[c], 'data-c': c, title: W.colors[c], tabindex: '-1',
    }));
    const none = h('button', { class: 'none', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-c': '', tabindex: '-1' }, W.none);
    const row = h('div', { class: 'swrow', role: 'radiogroup', 'aria-label': W.highlight }, sw, none);
    const bm = h('button', { class: 'abtn', type: 'button', 'aria-pressed': 'false', 'data-act': 'bookmark' }, icon('ribbon', 16), W.bookmark);
    const nt = h('button', { class: 'abtn', type: 'button', 'data-act': 'note' }, icon('note', 16), W.note);
    const cp = h('button', { class: 'abtn', type: 'button', 'data-act': 'copy' }, icon('copy', 16), h('span', { class: 'cl' }, W.copy));
    const b = h('div', { class: 'abar', role: 'group', 'aria-label': W.verseActions },
      h('span', { class: 'handle', 'aria-hidden': 'true' }), h('div', { class: 'bsref' }), row, h('span', { class: 'asep' }), h('div', { class: 'acts' }, bm, nt, cp));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = tgt(e).closest('[role="radio"]');
      if (r) {
        if (r.dataset.c) applyHighlight(r.dataset.c);
        else clearHighlight();
        return;
      }
      const a = tgt(e).closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'bookmark') toggleBookmark();
      else if (a.dataset.act === 'note') openNote(S.sel[0]);
      else if (a.dataset.act === 'copy') openCopy();
    });
    const preview = (c) => {
      for (const v of S.sel) {
        for (const p of partsOf(v)) {
          const vt = p.querySelector('.vt');
          vt.classList.remove('pv-amber', 'pv-green', 'pv-blue', 'pv-rose', 'pv-none');
          if (c !== null) vt.classList.add(`pv-${c || 'none'}`);
        }
      }
    };
    // A preview follows a mouse that moves over a swatch, not a sheet that slides up under a still pointer or a finger.
    row.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const r = tgt(e).closest('[role="radio"]');
      preview(r ? r.dataset.c : null);
    });
    row.addEventListener('mouseleave', () => preview(null));
    row.addEventListener('focusout', () => preview(null));
    row.addEventListener('keydown', (e) => {
      const radios = [...row.querySelectorAll('[role="radio"]')];
      const i = radios.indexOf(document.activeElement);
      let to = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % radios.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + radios.length) % radios.length;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      for (const r of radios) r.tabIndex = -1;
      radios[to].tabIndex = 0;
      radios[to].focus();
      preview(radios[to].dataset.c);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const v = S.sel[0];
      clearSel();
      const vn = one$(`.v[data-v="${v}"] .vn`, col);
      if (vn) vn.focus();
    });
    return b;
  }

  function showBar() {
    if (!S.ch) return;
    if (!bar) bar = buildBar();
    if (!bar.isConnected) col.append(bar);
    updateBar();
    positionBar();
  }

  function closeBar() {
    closeCopy();
    if (bar) bar.remove();
    col.style.removeProperty('--sheetpad');
  }

  /** On a phone the bar is a bottom sheet: the column gets room under its last verse, and the first selected verse is
   *  scrolled to sit at least 16 px above the sheet (its top kept in view when it's taller than the room). */
  function keepClear() {
    const sheetTop = bar.getBoundingClientRect().top;
    col.style.setProperty('--sheetpad', `${Math.ceil(bar.offsetHeight)}px`);
    const parts = [...partsOf(S.sel[0])].flatMap((p) => [...p.getClientRects()]);
    if (!parts.length) return;
    const top = Math.min(...parts.map((r) => r.top));
    const bottom = Math.max(...parts.map((r) => r.bottom));
    const room = scroller.getBoundingClientRect().top + 8;
    let by = 0;
    if (bottom > sheetTop - 16) by = Math.min(Math.ceil(bottom - (sheetTop - 17)), top - room); // 17: whole pixels, at least 16
    else if (top < room) by = top - room;
    if (Math.abs(by) >= 1) scroller.scrollBy({ top: by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function selectionRef() {
    const rs = runs(S.sel);
    if (!rs.length) return '';
    const head = chapName(S.ch.book, S.ch.chapter);
    return `${head}:${rs.map(([a, b]) => (b > a ? `${a}–${b}` : String(a))).join(', ')}`;
  }

  function updateBar() {
    if (!bar || !S.sel.length) return;
    bar.querySelector('.bsref').textContent = selectionRef();
    const colors = S.sel.map(highlightOf);
    const same = colors.every((c) => c === colors[0]) ? colors[0] : null;
    const radios = [...bar.querySelectorAll('[role="radio"]')];
    let focusable = null;
    for (const r of radios) {
      const on = same !== null && r.dataset.c === same;
      r.setAttribute('aria-checked', String(on));
      if (on) focusable = r;
    }
    focusable = focusable || radios.find((r) => r.dataset.c === S.prefs.highlightColor) || radios[0];
    for (const r of radios) r.tabIndex = r === focusable ? 0 : -1;
    const allMarked = S.sel.every((v) => marksAt(v).some((m) => m.kind === 'bookmark'));
    bar.querySelector('[data-act="bookmark"]').setAttribute('aria-pressed', String(allMarked));
  }

  function positionBar() {
    if (!bar || !bar.isConnected || !S.sel.length) return;
    if (narrow.matches) {
      bar.classList.add('sheet');
      keepClear();
      return;
    }
    bar.classList.remove('sheet');
    col.style.removeProperty('--sheetpad');
    const part = col.querySelector(`.v[data-v="${S.sel[0]}"]`);
    if (!part) return;
    const vt = part.querySelector('.vt').getClientRects()[0];
    const anchor = (part.querySelector('.vn') || part).getBoundingClientRect();
    if (!vt) return;
    const cr = col.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(col).lineHeight) || 30;
    const lineTop = vt.top + vt.height / 2 - cr.top - lh / 2;
    let top = lineTop - bar.offsetHeight - 2;
    if (cr.top + top < scroller.getBoundingClientRect().top + 4) top = lineTop + lh + 4;
    const pad = parseFloat(getComputedStyle(col).paddingLeft) || 32;
    let left = anchor.left - cr.left - 9;
    left = Math.max(Math.min(pad - 9, 4), Math.min(left, col.clientWidth - bar.offsetWidth - 4));
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(Math.max(4, left))}px`;
  }

  function focusBar() {
    showBar();
    const r = bar && bar.querySelector('[role="radio"][tabindex="0"]');
    if (r) r.focus();
  }

  // ------------------------------------------------------------------------------------------------ copy
  // The frame may write the clipboard inside the member's own tap (ADR 0054's change to contract 3.2: `allow="clipboard-write"`,
  // never read). Where it's refused (an older office, another browser), the words go in a selected box for their own Ctrl+C.
  let copyBox = null;
  function copyText() {
    const words = S.sel.map((v) => S.items.get(v).text).join(' ');
    return `${words}\n${selectionRef()} (${abbr(S.tr)})`;
  }
  function saidCopied() {
    const cl = bar && bar.querySelector('.cl');
    if (!cl) return;
    cl.textContent = W.copied;
    setTimeout(() => {
      if (cl.isConnected) cl.textContent = W.copy;
    }, 1600);
  }
  function openCopy() {
    const text = copyText();
    let p = null;
    try {
      p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : null;
    } catch {
      p = null;
    }
    if (p) p.then(saidCopied, () => openCopyBox(text));
    else openCopyBox(text);
  }
  function openCopyBox(text) {
    closeCopy();
    const ta = h('textarea', { readonly: true, 'aria-label': W.copyField, rows: '4', spellcheck: 'false' });
    ta.value = text;
    copyBox = h('div', { class: 'copybox', role: 'dialog', 'aria-label': W.copy },
      ta, h('div', { class: 'cbrow' }, h('span', { text: W.pressCopy }), h('button', { class: 'ibtn', type: 'button', 'aria-label': W.close, onclick: () => closeCopy(true) }, icon('close', 18))));
    ta.addEventListener('copy', () => setTimeout(() => {
      closeCopy(true);
      saidCopied();
    }, 0));
    copyBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCopy(true);
      }
    });
    copyBox.addEventListener('click', (e) => e.stopPropagation());
    col.append(copyBox);
    if (narrow.matches) copyBox.classList.add('sheet');
    else {
      copyBox.style.top = `${bar.offsetTop + bar.offsetHeight + 6}px`;
      copyBox.style.left = `${Math.max(4, Math.min(bar.offsetLeft, col.clientWidth - copyBox.offsetWidth - 4))}px`;
    }
    ta.focus({ preventScroll: true });
    ta.select();
  }
  function closeCopy(refocus) {
    if (!copyBox) return;
    copyBox.remove();
    copyBox = null;
    if (refocus && bar && bar.isConnected) {
      const c = bar.querySelector('[data-act="copy"]');
      if (c) c.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------------------------------------ popovers
  let pop = null; // {el, anchor, kind}
  function showPopover(el, anchor, kind, opts = {}) {
    closePopover(false);
    layer.append(el);
    if (anchor && anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');
    pop = { el, anchor, kind, opts };
    placePopover();
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePopover(true);
      }
    });
  }
  function placePopover() {
    if (!pop) return;
    const { el, anchor, opts } = pop;
    if (opts.sheet && narrow.matches) {
      el.classList.add('sheet');
      el.style.left = '';
      el.style.top = '';
      return;
    }
    el.classList.remove('sheet');
    const lr = layer.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    let left = opts.right ? ar.right - lr.left - el.offsetWidth : ar.left - lr.left - (opts.nudge || 0);
    left = Math.max(8, Math.min(left, lr.width - el.offsetWidth - 8));
    let top = ar.bottom - lr.top + 6;
    if (top + el.offsetHeight > lr.height - 8 && ar.top - lr.top - el.offsetHeight - 6 > 8) top = ar.top - lr.top - el.offsetHeight - 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  function closePopover(refocus, onlyKind) {
    if (!pop || (onlyKind && pop.kind !== onlyKind)) return;
    const { el, anchor } = pop;
    pop = null;
    el.remove();
    if (anchor && anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
    if (refocus && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (e) => {
    if (pop && !pop.el.contains(e.target) && !(pop.anchor && pop.anchor.contains(e.target))) closePopover(false);
  }, true);

  function sheetHead(title, onClose) {
    return h('div', { class: 'phd sheet-only' }, h('h2', { class: 'pht', text: title }),
      h('button', { class: 'ibtn', type: 'button', 'aria-label': W.close, onclick: onClose }, icon('close', 18)));
  }

  // Go to: a field that reads a reference, then the books, then a book's chapters.
  function openGoto() {
    if (!S.at) return;
    if (pop && pop.kind === 'goto') return closePopover(true);
    closePanel(false);
    const input = h('input', { type: 'text', 'aria-label': W.goto, placeholder: W.gotoPlaceholder, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go', maxlength: '60' });
    const err = h('p', { class: 'err', role: 'alert' });
    const grid = h('div');
    const el = h('div', { class: 'pop goto', role: 'dialog', 'aria-label': W.goto },
      narrow.matches ? sheetHead(W.goto, () => closePopover(true)) : null,
      h('div', { class: 'field' }, input), err, grid);
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      try {
        const { ref } = await read('bible.lookup', { q, translation: S.tr });
        closePopover(false);
        $('refBtn').focus({ preventScroll: true });
        go(ref, { verse: ref.verse, flash: !!ref.verse });
      } catch (x) {
        err.textContent = x && x.code === 'not_found' ? W.notRef : W.failed;
      }
    });
    input.addEventListener('input', () => {
      err.textContent = '';
    });
    const pick = (id, n) => {
      closePopover(false);
      $('refBtn').focus({ preventScroll: true });
      go({ book: id, chapter: n });
    };
    const showBooks = () => {
      const list = books();
      requestAnimationFrame(() => el.dispatchEvent(new Event('scroll')));
      const section = (testament, label) => [
        h('h3', { class: 'gl', text: label }),
        h('div', { class: 'books' }, list.filter((b) => b.testament === testament).map((b) => h('button', {
          class: 'bk', type: 'button', 'aria-label': b.name, 'aria-current': S.at.book === b.id ? 'true' : null, title: b.name,
          onclick: () => (b.chapters === 1 ? pick(b.id, 1) : showChapters(b)),
        }, h('span', { class: 'full', text: b.name }), h('span', { class: 'short', text: SHORT[b.id] || b.name })))),
      ];
      grid.replaceChildren(...section('ot', W.ot), ...section('nt', W.nt));
    };
    const showChapters = (b) => {
      const back = h('button', { class: 'back', type: 'button', onclick: () => { showBooks(); input.focus(); } }, icon('back', 16), W.books);
      const chs = [];
      for (let i = 1; i <= b.chapters; i++) {
        chs.push(h('button', {
          class: 'chn', type: 'button', 'aria-label': chapName(b.id, i), 'aria-current': S.at.book === b.id && S.at.chapter === i ? 'true' : null,
          onclick: () => pick(b.id, i),
        }, String(i)));
      }
      grid.replaceChildren(h('div', { class: 'chhd' }, back, h('h3', { class: 'chbk', text: b.name })), h('div', { class: 'chs' }, chs));
      placePopover();
      el.scrollTop = 0;
      fade();
      (grid.querySelector('.chn[aria-current="true"]') || grid.querySelector('.chn')).focus();
    };
    // A fade at the bottom while more is below, so a list that ends on a row never looks complete.
    const fade = () => el.classList.toggle('below', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    el.addEventListener('scroll', fade, { passive: true });
    showBooks();
    showPopover(el, $('refBtn'), 'goto', { sheet: true });
    fade();
    input.focus();
  }

  // The translation menu: four rows, each with an About.
  function openTranslations() {
    if (pop && pop.kind === 'trans') return closePopover(true);
    closePanel(false);
    const rows = S.translations.map((t) => {
      const cur = t.code === S.tr;
      return h('div', { class: `trow${cur ? ' cur' : ''}` },
        h('button', { class: 'tpick', type: 'button', 'aria-current': cur ? 'true' : null, onclick: () => switchTranslation(t.code) },
          h('span', { class: 'tck' }, cur ? icon('check', 18) : null),
          h('span', { class: 'tnm' }, h('b', { text: t.name }), h('i', { text: `${t.abbreviation}, ${t.edition}` }))),
        h('button', { class: 'ibtn', type: 'button', 'aria-label': W.about(t.name), title: W.about(t.name), onclick: () => openAbout(t.code) }, icon('info', 18)));
    });
    const el = h('div', { class: 'pop trans', role: 'dialog', 'aria-label': W.translation }, rows);
    showPopover(el, $('trBtn'), 'trans');
    const cur = el.querySelector('.tpick[aria-current="true"]') || el.querySelector('.tpick');
    if (cur) cur.focus();
  }

  function switchTranslation(code) {
    closePopover(false);
    $('trBtn').focus({ preventScroll: true });
    if (!S.at) return;
    const verse = S.ch ? topVerse() : 1;
    open({ translation: code, book: S.at.book, chapter: S.at.chapter, verse, align: 'top' });
  }

  // A translation's About: its name and year, Sales's credit, the statement and source verbatim.
  let about = null;
  async function openAbout(code) {
    let a;
    try {
      a = await read('bible.about', { translation: code });
    } catch {
      return toast(W.failed);
    }
    const opener = $('trBtn');
    closePopover(false);
    closeAbout(false);
    const closeBtn = h('button', { class: 'ibtn', type: 'button', 'aria-label': W.close, onclick: () => closeAbout(true) }, icon('close', 18));
    // Until the contract's browser.open reaches apps (C10), the source is words, then its address as text the member can
    // select. The notice's own addresses (the KJV's) stay plain text too: nothing in the view is a link.
    let site = '';
    try {
      site = new URL(a.sourceUrl).hostname.replace(/^www\./, '');
    } catch {
      site = '';
    }
    if (site === 'ebible.org') site = 'eBible.org';
    const card = h('div', { class: 'pop about', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'aboutTitle' },
      h('div', { class: 'ash' }, h('div', {}, h('h2', { id: 'aboutTitle', tabindex: '-1', text: a.name }), h('p', { text: `${a.abbreviation}, ${a.edition}` })), closeBtn),
      CREDIT[a.code] ? h('p', { class: 'credit', text: CREDIT[a.code] }) : null,
      h('h3', { class: 'gl', text: W.statement }),
      h('p', { class: 'stmt', text: a.statement || '' }),
      a.sourceUrl ? h('h3', { class: 'gl', text: W.source }) : null,
      a.sourceUrl && site ? h('p', { class: 'srcwords', text: W.sourceWords(site, a.name) }) : null,
      a.sourceUrl ? h('p', { class: 'srcaddr', text: a.sourceUrl }) : null,
      a.sourceUrl ? h('p', { class: 'hint', text: W.sourceHint }) : null);
    const scrim = h('div', { class: 'scrim' }, card);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) closeAbout(true);
    });
    scrim.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAbout(true);
      } else if (e.key === 'Tab') {
        const f = [...card.querySelectorAll('button, input, summary, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    });
    layer.append(scrim);
    about = { scrim, opener };
    $('aboutTitle').focus();
  }
  function closeAbout(refocus) {
    if (!about) return;
    const { scrim, opener } = about;
    about = null;
    scrim.remove();
    if (refocus && opener) opener.focus({ preventScroll: true });
  }

  // Text: size, one verse per line, footnotes.
  function openText(anchor) {
    if (pop && pop.kind === 'text') return closePopover(true);
    const sizes = h('div', { class: 'sizes', role: 'radiogroup', 'aria-label': W.size }, SIZES.map((n) => {
      const b = h('button', { class: 'sz', type: 'button', role: 'radio', 'aria-checked': String(S.prefs.textSize === n), 'aria-label': W.sizeN(n), tabindex: S.prefs.textSize === n ? '0' : '-1', 'data-n': n }, 'A');
      b.style.fontSize = `${11 + (n - 16) * 0.9}px`;
      return b;
    }));
    sizes.addEventListener('click', (e) => {
      const b = tgt(e).closest('.sz');
      if (b) setPref('textSize', Number(b.dataset.n));
    });
    sizes.addEventListener('keydown', (e) => {
      const i = SIZES.indexOf(S.prefs.textSize);
      let to = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = Math.min(SIZES.length - 1, i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = Math.max(0, i - 1);
      if (to < 0) return;
      e.preventDefault();
      setPref('textSize', SIZES[to]);
      sizes.querySelector(`[data-n="${SIZES[to]}"]`).focus();
    });
    const sw = (key, label) => h('button', {
      class: 'srow', type: 'button', role: 'switch', 'aria-checked': String(!!S.prefs[key]), 'data-k': key,
      onclick: (e) => setPref(key, !S.prefs[key], e.currentTarget),
    }, h('span', { text: label }), h('span', { class: 'switch', 'aria-hidden': 'true' }));
    const el = h('div', { class: 'pop textpop', role: 'dialog', 'aria-label': W.text },
      h('h3', { class: 'gl', text: W.size }), sizes, sw('oneVersePerLine', W.oneVersePerLine), sw('footnotes', W.footnotes));
    showPopover(el, anchor, 'text', { right: true });
    (sizes.querySelector('[aria-checked="true"]') || sizes.firstChild).focus();
  }

  function applyPrefs() {
    col.style.setProperty('--fs', `${SIZES.includes(S.prefs.textSize) ? S.prefs.textSize : 18}px`);
  }

  function setPref(key, value, btn) {
    if (S.prefs[key] === value) return;
    const top = S.ch ? topVerse() : 0;
    S.prefs[key] = value;
    if (key === 'textSize') {
      applyPrefs();
      if (pop && pop.kind === 'text') {
        for (const b of pop.el.querySelectorAll('.sz')) {
          const on = Number(b.dataset.n) === value;
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        }
      }
    } else if (btn) {
      btn.setAttribute('aria-checked', String(!!value));
    }
    if (S.ch && key !== 'textSize') render();
    if (S.ch) {
      scrollToVerse(top, 'top');
      requestAnimationFrame(() => {
        layoutGutter();
        positionBar();
      });
    }
    mutate('bible.prefs.set', { [key]: value }).catch(() => toast(W.saveFailed));
  }

  // The phone's ⋯: Saved and Text.
  function openMore() {
    if (pop && pop.kind === 'more') return closePopover(true);
    const anchor = $('moreBtn');
    const el = h('div', { class: 'pop menu', role: 'menu', 'aria-label': W.more },
      h('button', { class: 'mi', type: 'button', role: 'menuitem', onclick: () => { closePopover(false); openSaved(); } }, icon('ribbon', 18), W.saved),
      h('button', { class: 'mi', type: 'button', role: 'menuitem', tabindex: '-1', onclick: () => { closePopover(false); openText(anchor); } }, h('span', { class: 'aa', 'aria-hidden': 'true', text: 'Aa' }), W.text));
    el.addEventListener('keydown', (e) => {
      const items = [...el.querySelectorAll('.mi')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    showPopover(el, anchor, 'more', { right: true });
    el.querySelector('.mi').focus();
  }

  // A footnote: a small popover with its words.
  function openFootnote(btn) {
    if (pop && pop.anchor === btn) return closePopover(true);
    const l = btn.textContent;
    const el = h('div', { class: 'pop fnpop', role: 'dialog', 'aria-label': W.footnote(l), tabindex: '-1' }, h('b', { text: l }), fnText.get(btn) || '');
    showPopover(el, btn, 'fn', { nudge: 12 });
    el.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------------------------------------ panels
  let panelState = null; // {kind, opener, onClose}
  const PANEL_BTN = { search: 'searchBtn', saved: 'savedBtn' };
  function openPanel(kind, content, opener, onClose) {
    closePanel(false);
    closePopover(false);
    panel.replaceChildren(content);
    panel.hidden = false;
    panel.setAttribute('aria-label', content.dataset.title || kind);
    panelState = { kind, opener, onClose };
    if (PANEL_BTN[kind]) $(PANEL_BTN[kind]).setAttribute('aria-expanded', 'true');
  }
  function closePanel(refocus) {
    if (!panelState) return;
    const { kind, opener, onClose } = panelState;
    panelState = null;
    if (onClose) onClose();
    panel.hidden = true;
    panel.replaceChildren();
    if (PANEL_BTN[kind]) $(PANEL_BTN[kind]).setAttribute('aria-expanded', 'false');
    if (refocus && opener && opener.isConnected) opener.focus({ preventScroll: true });
  }
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelState) {
      e.stopPropagation();
      closePanel(true);
    }
  });
  function panelHead(title) {
    return h('div', { class: 'phd' }, h('h2', { class: 'pht', text: title }),
      h('button', { class: 'ibtn', type: 'button', 'aria-label': W.close, onclick: () => closePanel(true) }, icon('close', 18)));
  }

  // Search: the current translation, or all four; results after 200 ms of no typing.
  let searchTimer = 0;
  let searchSeq = 0;
  function openSearch() {
    if (app.dataset.state !== 'ready' || $('searchBtn').disabled) return;
    if (panelState && panelState.kind === 'search') {
      panel.querySelector('input').focus();
      return;
    }
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : $('searchBtn');
    const input = h('input', { type: 'search', 'aria-label': W.search, placeholder: W.searchPlaceholder(abbr(S.tr)), autocomplete: 'off', spellcheck: 'false', maxlength: '200', enterkeyhint: 'search' });
    input.value = S.search.q;
    const results = h('div', { class: 'results' });
    const content = h('div', { class: 'search', 'data-title': W.search }, panelHead(W.search),
      h('div', { class: 'pbody' }, h('div', { class: 'field' }, icon('search', 18), input), results));
    input.addEventListener('input', () => {
      S.search.all = false;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        runSearch();
      }
    });
    openPanel('search', content, opener, () => clearTimeout(searchTimer));
    input.focus();
    if (S.search.res && S.search.res.q === input.value.trim()) renderSearch();
  }

  async function runSearch() {
    if (!panelState || panelState.kind !== 'search') return;
    const input = panel.querySelector('input');
    const q = input.value.trim();
    S.search.q = input.value;
    const seq = ++searchSeq;
    if (!q) {
      S.search.res = null;
      panel.querySelector('.results').replaceChildren();
      return;
    }
    const translation = S.search.all ? 'all' : S.tr;
    let r;
    try {
      r = await read('bible.search', { translation, q, limit: 200 });
    } catch (e) {
      if (seq !== searchSeq || !panelState || panelState.kind !== 'search') return;
      const msg = e && e.code === 'bad_request' && reasonOf(e) === 'q' ? W.searchTooLong : W.failed;
      panel.querySelector('.results').replaceChildren(h('p', { class: 'empty', text: msg }));
      return;
    }
    if (seq !== searchSeq || !panelState || panelState.kind !== 'search') return;
    S.search.res = { q, translation, hits: r.hits || [], byBook: r.byBook || [], total: r.total || 0, counts: r.counts || {}, cursor: r.cursor, ref: r.ref || null, full: new Set() };
    renderSearch();
  }

  function highlighted(text, ranges) {
    const out = [];
    let i = 0;
    for (const [s, t] of ranges || []) {
      if (s < i) continue;
      out.push(text.slice(i, s), h('b', { text: text.slice(s, t) }));
      i = t;
    }
    out.push(text.slice(i));
    return out;
  }

  function renderSearch() {
    const box = panel.querySelector('.results');
    const R = S.search.res;
    if (!box || !R) return;
    const all = R.translation === 'all';
    const ab = abbr(S.tr);
    const out = [];
    if (R.ref) {
      const code = all ? S.tr : R.translation;
      out.push(h('button', {
        class: 'goref', type: 'button',
        onclick: () => {
          closePanel(false);
          open({ translation: code, book: R.ref.book, chapter: R.ref.chapter, verse: R.ref.verse, flash: !!R.ref.verse });
        },
      }, icon('goto', 16), W.goRef(refText(R.ref, code))));
    }
    const widen = h('button', {
      class: 'lbtn', type: 'button',
      onclick: () => {
        S.search.all = true;
        runSearch();
      },
    }, W.searchAll);
    if (!R.total) {
      if (!R.ref) out.push(h('p', { class: 'empty' }, all ? W.searchNoneAll : W.searchNone(ab), all ? null : h('br'), all ? null : widen));
    } else {
      out.push(h('div', { class: 'count' }, h('span', { text: all ? W.searchCountAll(R.total) : W.searchCount(R.total, ab) })));
      const byBook = new Map();
      for (const hit of R.hits) {
        if (!byBook.has(hit.book)) byBook.set(hit.book, []);
        byBook.get(hit.book).push(hit);
      }
      for (const { book: id, count } of R.byBook) {
        const hits = byBook.get(id);
        if (!hits) break;
        const shown = R.full.has(id) ? hits : hits.slice(0, 20);
        out.push(h('h3', { class: 'grp' }, h('span', { text: bookName(id) }), h('span', { class: 'gc', text: String(count) })));
        for (const hit of shown) {
          out.push(h('button', {
            class: 'hit', type: 'button',
            onclick: () => {
              closePanel(false);
              open({ translation: hit.translation, book: hit.book, chapter: hit.chapter, verse: hit.verse, flash: true });
            },
          }, h('span', { class: 'sref' }, verseRef(hit.book, hit.chapter, hit.verse, hit.verseEnd), all ? h('span', { class: 'tag', text: abbr(hit.translation) }) : null),
          h('span', { class: 'htx' }, highlighted(hit.text, hit.ranges))));
        }
        if (count > shown.length && !R.full.has(id)) {
          out.push(h('button', { class: 'lbtn more', type: 'button', onclick: () => showAllIn(id) }, W.showAll(count)));
        }
      }
      if (R.cursor) out.push(h('button', { class: 'lbtn more', type: 'button', onclick: () => searchMore() }, W.showMore));
    }
    box.replaceChildren(...out);
    saidEl.textContent = R.total ? (all ? W.searchCountAll(R.total) : W.searchCount(R.total, ab)) : R.ref ? '' : all ? W.searchNoneAll : W.searchNone(ab);
  }

  async function searchPages(params, max) {
    const hits = [];
    let cursor = null;
    do {
      const r = await read('bible.search', { ...params, limit: 200, ...(cursor ? { cursor } : {}) });
      hits.push(...(r.hits || []));
      cursor = r.cursor;
    } while (cursor && hits.length < max);
    return hits;
  }

  async function showAllIn(id) {
    const R = S.search.res;
    try {
      const hits = await searchPages({ translation: R.translation, q: R.q, scope: id }, 5000);
      if (S.search.res !== R) return;
      R.hits = R.hits.filter((x) => x.book !== id);
      const at = R.hits.findIndex((x) => R.byBook.findIndex((b) => b.book === x.book) > R.byBook.findIndex((b) => b.book === id));
      R.hits.splice(at < 0 ? R.hits.length : at, 0, ...hits);
      R.full.add(id);
      renderSearch();
    } catch {
      toast(W.failed);
    }
  }

  async function searchMore() {
    const R = S.search.res;
    try {
      const r = await read('bible.search', { translation: R.translation, q: R.q, limit: 200, cursor: R.cursor });
      if (S.search.res !== R) return;
      const seen = new Set(R.hits.map((x) => `${x.translation}|${x.book}|${x.chapter}|${x.verse}`));
      R.hits.push(...(r.hits || []).filter((x) => !seen.has(`${x.translation}|${x.book}|${x.chapter}|${x.verse}`)));
      R.cursor = r.cursor;
      renderSearch();
    } catch {
      toast(W.failed);
    }
  }

  // Saved: bookmarks, highlights and notes, by book in canonical order.
  async function openSaved(focusId) {
    const opener = $(narrow.matches ? 'moreBtn' : 'savedBtn');
    const kinds = [['', W.all], ['bookmark', W.bookmarks], ['highlight', W.highlights], ['note', W.notes]];
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': W.saved }, kinds.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(S.savedKind === k), 'data-k': k,
      onclick: () => {
        S.savedKind = k;
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === k));
        loadSaved(false);
      },
    }, label)));
    const content = h('div', { class: 'saved', 'data-title': W.saved }, panelHead(W.saved), h('div', { class: 'pbody' }, seg, h('div', { class: 'list' })));
    openPanel('saved', content, opener);
    (seg.querySelector('[aria-pressed="true"]') || seg.firstChild).focus();
    await loadSaved(false, focusId);
  }

  let savedSeq = 0;
  /** @type {{marks: any[], cursor: string | null} | null} */
  let savedList = null;
  async function loadSaved(more, focusId) {
    if (!panelState || panelState.kind !== 'saved') return;
    const list = panel.querySelector('.list');
    const seq = ++savedSeq;
    const prev = more ? savedList : null;
    let r;
    try {
      r = await read('bible.marks.list', { order: 'canon', limit: 200, translation: S.tr, ...(S.savedKind ? { kind: S.savedKind } : {}), ...(prev && prev.cursor ? { cursor: prev.cursor } : {}) });
    } catch {
      if (seq === savedSeq) list.replaceChildren(h('p', { class: 'empty', text: W.failed }));
      return;
    }
    if (seq !== savedSeq || !panelState || panelState.kind !== 'saved') return;
    const marks = (prev ? prev.marks : []).concat(r.marks || []);
    savedList = { marks, cursor: r.cursor };
    if (!marks.length) {
      list.replaceChildren(h('p', { class: 'empty', text: W.savedEmpty }));
      return;
    }
    const out = [];
    let lastBook = '';
    for (const m of marks) {
      if (m.book !== lastBook) {
        lastBook = m.book;
        out.push(h('h3', { class: 'grp' }, h('span', { text: bookName(m.book) })));
      }
      const ind = m.kind === 'bookmark' ? h('span', { class: 'ind bm' }, icon('ribbonFill', 14))
        : m.kind === 'note' ? h('span', { class: 'ind nt' }, icon('note', 14))
          : h('span', { class: 'ind dot', 'data-c': m.color, title: W.colors[m.color] || '' });
      out.push(h('button', {
        class: 'hit', type: 'button', 'data-id': m.id,
        onclick: () => {
          closePanel(false);
          open({ translation: S.tr, book: m.book, chapter: m.chapter, verse: m.verse, flash: true });
        },
      }, h('span', { class: 'sref' }, verseRef(m.book, m.chapter, m.verse, m.verseEnd), ind),
      m.verseText ? h('span', { class: 'sline', text: m.verseText }) : null,
      m.kind === 'note' && m.text ? h('span', { class: 'snote', text: m.text.split('\n')[0] }) : null,
      m.kind === 'bookmark' && m.label ? h('span', { class: 'snote', text: m.label }) : null));
    }
    if (r.cursor) out.push(h('button', { class: 'lbtn more', type: 'button', onclick: () => loadSaved(true) }, W.showMore));
    list.replaceChildren(...out);
    if (focusId) {
      const row = one$(`[data-id="${CSS.escape(focusId)}"]`, list);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.focus();
      }
    }
  }

  // A note: a plain text box, saved as the member types; Delete note puts back an Undo for 6 s.
  let note = null;
  function openNote(v, mark) {
    if (!S.ch) return;
    const it = S.items.get(v);
    if (!it) return;
    const existing = mark || S.marks.find((m) => m.kind === 'note' && S.itemOf.get(m.verse) === v && !String(m.id).startsWith('tmp'));
    const a = document.activeElement;
    const opener = a && a !== document.body && !(bar && bar.contains(a)) ? a : col.querySelector(`.v[data-v="${v}"] .vn`);
    closeNote();
    note = {
      id: existing ? existing.id : null,
      book: S.ch.book, chapter: S.ch.chapter,
      verse: existing ? existing.verse : it.verse,
      verseEnd: existing ? existing.verseEnd : undefined,
      saved: existing ? existing.text || '' : '',
      chain: Promise.resolve(),
      timer: 0,
      deleted: false,
    };
    const n = note;
    const ta = h('textarea', { class: 'ta', 'aria-label': W.noteField, maxlength: '10000' });
    ta.value = n.saved;
    const del = h('button', { class: 'del', type: 'button', hidden: !n.id, onclick: () => deleteNote(n) }, W.deleteNote);
    const title = `${verseRef(n.book, n.chapter, n.verse, n.verseEnd)}, ${abbr(S.tr)}`;
    const content = h('div', { class: 'note', 'data-title': title }, panelHead(title), h('div', { class: 'pbody' }, ta, del));
    ta.addEventListener('input', () => {
      clearTimeout(n.timer);
      n.timer = setTimeout(() => saveNote(n, ta.value, del), 500);
    });
    openNoteId = n.id;
    openPanel('note', content, opener, () => {
      clearTimeout(n.timer);
      if (n.deleted) return;
      const text = ta.value;
      if (!text.trim() && n.id) deleteNote(n, true);
      else saveNote(n, text, del);
      if (note === n) note = null;
      openNoteId = null;
      layoutGutter();
    });
    closeBar();
    clearSel();
    layoutGutter();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function closeNote() {
    if (panelState && panelState.kind === 'note') closePanel(false);
  }
  function saveNote(n, text, del) {
    if (!text.trim() || text === n.saved || n.deleted) return n.chain;
    n.chain = n.chain.then(async () => {
      if (n.deleted || text === n.saved) return;
      S.busy++;
      try {
        const p = n.id ? { mark: { id: n.id, text } }
          : { mark: { kind: 'note', book: n.book, chapter: n.chapter, verse: n.verse, ...(n.verseEnd ? { verseEnd: n.verseEnd } : {}), text, translation: S.tr } };
        const r = await mutate('bible.mark.put', p);
        n.id = r.mark.id;
        n.saved = text;
        if (note === n) openNoteId = n.id;
        if (del) del.hidden = false;
      } catch (e) {
        toast(e && e.code === 'precondition_failed' ? W.full : W.saveFailed);
      } finally {
        S.busy--;
        if (!S.busy) refreshMarks();
      }
    });
    return n.chain;
  }
  async function deleteNote(n, closing) {
    clearTimeout(n.timer);
    const ta = panelState && panelState.kind === 'note' ? panel.querySelector('textarea') : null;
    const text = (ta && ta.value.trim() ? ta.value : n.saved) || n.saved;
    n.deleted = true;
    if (!closing) closePanel(false);
    await n.chain;
    if (!n.id) return;
    const kept = { kind: 'note', book: n.book, chapter: n.chapter, verse: n.verse, ...(n.verseEnd ? { verseEnd: n.verseEnd } : {}), text: n.saved || text, translation: S.tr };
    S.busy++;
    S.marks = S.marks.filter((m) => m.id !== n.id);
    paintMarks();
    try {
      await mutate('bible.mark.remove', { id: n.id });
      toast(W.noteDeleted, {
        label: W.undo,
        run: () => marksAction(() => S.marks.push({ ...kept, id: 'tmp-undo' }), [['bible.mark.put', { mark: kept }]]),
      });
    } catch {
      toast(W.failed);
    } finally {
      S.busy--;
      if (!S.busy) refreshMarks();
    }
  }

  // ------------------------------------------------------------------------------------------------ toast
  let toastTimer = 0;
  function toast(text, action) {
    clearTimeout(toastTimer);
    const kids = [h('span', { text })];
    if (action) {
      kids.push(h('button', {
        class: 'lbtn', type: 'button',
        onclick: () => {
          toastEl.replaceChildren();
          action.run();
        },
      }, action.label));
    }
    toastEl.replaceChildren(...kids);
    toastTimer = setTimeout(() => toastEl.replaceChildren(), action ? 6000 : 4000);
  }

  // ------------------------------------------------------------------------------------------------ toolbar and keys
  $('refBtn').addEventListener('click', openGoto);
  $('trBtn').addEventListener('click', openTranslations);
  $('searchBtn').addEventListener('click', () => (panelState && panelState.kind === 'search' ? closePanel(true) : openSearch()));
  $('savedBtn').addEventListener('click', () => (panelState && panelState.kind === 'saved' ? closePanel(true) : openSaved()));
  $('textBtn').addEventListener('click', () => openText($('textBtn')));
  $('moreBtn').addEventListener('click', openMore);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (copyBox) return closeCopy(true);
      if (about) return closeAbout(true);
      if (pop) return closePopover(true);
      if (panelState) return closePanel(true);
      if (S.sel.length) return clearSel();
      return undefined;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return undefined;
    const t = tgt(e);
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return undefined;
    if (about || app.dataset.state !== 'ready') return undefined;
    if (e.key === '/') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'g' || e.key === 'G') {
      if (!S.at || $('refBtn').disabled) return undefined;
      e.preventDefault();
      openGoto();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !pop && S.ch) {
      if (t && t.closest && t.closest('[role="radiogroup"], [role="menu"], .rpanel')) return undefined;
      const to = e.key === 'ArrowLeft' ? S.ch.prev : S.ch.next;
      if (!to) return undefined;
      e.preventDefault();
      go(to);
    }
    return undefined;
  });

  // ------------------------------------------------------------------------------------------------ layout
  let layoutQueued = false;
  const relayout = () => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutGutter();
      positionBar();
      if (pop && pop.kind === 'fn') closePopover(false);
      else placePopover();
    });
  };
  new ResizeObserver(relayout).observe(col);
  narrow.addEventListener('change', relayout);
  scroller.addEventListener('scroll', () => {
    if (pop && pop.kind === 'fn') closePopover(false);
    savePlace(false);
  }, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  start();
})();
