// MDoc extractor (minified-mode prototype), distiller v2.
// Injected with context.add_init_script() at document start in the TOP frame only. It runs in the main world here;
// production should run the same code in an isolated world (CDP Page.createIsolatedWorld) so pages can't tamper with it.
// Exposes window.__mdoc = { extractText, lookup, prepare, quiet, hit, guardResult, focusSelect, epoch, setMode,
//                           setRules, hasRules, islands, clearOver, restoreHidden }.
//
// Output of extractText(limit, hints): line 1 = meta JSON; every following line = "<hash>\t<block JSON>".
// Blocks are a FLAT list (reader-view style), each one a small JSON object:
//   {k:'chrome', name, icon, c, acts, menu}  the site row, the only thing before the content: c = the runs shown in
//                        it (search field and button, Sign in, Cart), acts = which run is which ({k:'signin'|'cart', i}),
//                        menu = [{n:'Site menu'|'Filters'|'Contents', c:[runs]}] shown closed
//   {k:'h', l, c}        heading level l, inline runs c
//   {k:'p', c, q?, depth?, dlg?} paragraph (q = blockquote depth, depth = comment thread depth 1..3, dlg = in a real dialog)
//   {k:'li', d, o, cont?, c} list item (depth d, ordinal o or 0 for bullet)
//   {k:'pre', t} {k:'hr'} {k:'tbl', rows:[[{h?, c}]]} {k:'meta', c}
//   {k:'img', s, a, w, h, rw, rh, r?, u?} an image at its size on the real page (rw/rh; r/u: the link it opens)
//   {k:'card', g, lay:'grid'|'list', rep, title, price?, stars?, meta?, c}  one of a list of repeated items (g groups
//                        them); c = its runs: thumbnail link, title link, price, meta, snippet, chips, actions
//   {k:'media', m:'video', island:'live'|'click'|'none', ad:0, r, v?, vr?, x, y, w, h, main?, pre?, dur?, poster?, s?}
//                        a player as a live island: the crop is the <video>'s own rectangle vr (page CSS px)
//   {k:'group', n, c:[blocks]}  recirculation ("More from this site"), collapsed at the end
//   {k:'media', m, w, h, n} a canvas or app frame that can't be simplified (no URL is ever shown)
// Inline runs: "text" | ['b'|'i'|'code'|'sup'|'sub'|'s', ...runs] | ['br'] | ['a', ref, href, ...runs]
//   | ['img', src, alt, w, h] | ['btn', ref, label, flags] | ['in', ref, {t,v,p,l,c,d,n}] | ['sel', ref, {v,o,l,d}] | ['ta', ref, {v,p,l}]
// Refs are "<epoch>.<n>" and stay stable for the lifetime of the element (WeakMap), so the client can diff by block hash
// and an action on a stale ref fails instead of hitting a different element.
//
// v2 (task 47): ads, trackers' widgets, consent banners, promos and sign-in upsells are DROPPED (EasyList, EasyPrivacy
// and the EasyList Cookie List as data, from the server, plus structural rules); the site's chrome is collapsed into
// one bar; repeated items become cards; players become islands; controls without a readable name are dropped.
(() => {
  if (window.top !== window) return;
  if (window.__mdoc) return;

  const R = (function () {
    /*__READABILITY__*/
    return { Readability, isProbablyReaderable };
  })();

  // ---------------------------------------------------------------- refs
  const EPOCH = Math.floor(Math.random() * 60466176).toString(36);
  let nextRef = 1;
  const refOf = new WeakMap();
  const elOf = new Map();
  function ref(el) {
    let r = refOf.get(el);
    if (!r) {
      r = EPOCH + '.' + (nextRef++).toString(36);
      refOf.set(el, r);
      elOf.set(r, new WeakRef(el));
      if (elOf.size > 20000 && nextRef % 5000 === 0) for (const [k, w] of elOf) if (!w.deref()) elOf.delete(k);
    }
    return r;
  }
  function lookup(r) {
    const w = elOf.get(r);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  }

  // ---------------------------------------------------------------- mutation tracking (live updates + settle detection)
  let lastMut = 0, mutCount = 0, dirtyTimer = 0;
  // structural changes: elements added or removed, or a box shown, hidden or restyled. Text that changes in place (a
  // clock, a live score, a "3 min ago") is not one, so the scan behind the view is reused for that live update.
  let structMut = 0;
  const STRUCT_ATTR = new Set(['hidden', 'aria-hidden', 'open', 'class', 'style']);
  const mo = new MutationObserver((recs) => {
    lastMut = performance.now();
    mutCount += recs.length;
    for (const m of recs) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) { structMut++; break; }
        for (const n of m.removedNodes) if (n.nodeType === 1) { structMut++; break; }
      } else if (m.type === 'attributes' && STRUCT_ATTR.has(m.attributeName) && m.target.firstElementChild) structMut++;
    }
    if (!dirtyTimer) {
      dirtyTimer = setTimeout(() => {
        dirtyTimer = 0;
        try { if (window.__mdocDirty) window.__mdocDirty(mutCount); } catch (e) { /* binding not ready */ }
      }, 20);
    }
  });
  mo.observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'open',
      'disabled', 'class', 'style', 'value', 'checked', 'src', 'href'],
  });
  function quiet(minQuiet, max) {
    const start = performance.now();
    return new Promise((res) => {
      let framed = false;
      requestAnimationFrame(() => setTimeout(() => { framed = true; check(); }, 0));
      setTimeout(() => { framed = true; check(); }, 50); // rAF can be throttled in background tabs
      let done = false;
      function check() {
        if (done) return;
        const now = performance.now();
        const changed = lastMut > start;
        if (now - start >= max || (framed && (!changed || now - lastMut >= minQuiet))) {
          done = true;
          res({ waited: Math.round(now - start), muts: mutCount, changed });
        } else if (framed) setTimeout(check, Math.max(4, minQuiet - (now - lastMut)));
      }
    });
  }


  // DOM methods taken from the prototypes once: a page's form control named "querySelector" or "closest" clobbers the
  // form's own (HTMLFormElement's named controls override built-ins), and a scan must never trip over it (T47X-3)
  // (the prototypes and the test are captured at load: a page script may replace the global Element or Document later)
  const EP = Element.prototype, DP = Document.prototype, FP = DocumentFragment.prototype, NP = Node.prototype;
  const isProto = Object.prototype.isPrototypeOf;
  const isEl = (n) => !!n && isProto.call(EP, n), isDoc = (n) => !!n && isProto.call(DP, n);
  const protoOf = (n) => (isEl(n) ? EP : isDoc(n) ? DP : n && isProto.call(FP, n) ? FP : null);
  const QS = (n, s) => { const p = protoOf(n); return p ? p.querySelector.call(n, s) : n.querySelector(s); };
  const QSA = (n, s) => { const p = protoOf(n); return p ? p.querySelectorAll.call(n, s) : n.querySelectorAll(s); };
  const CLOSEST = (n, s) => (isEl(n) ? EP.closest.call(n, s) : n.closest(s));
  const MATCHES = (n, s) => (isEl(n) ? EP.matches.call(n, s) : n.matches(s));
  const CONTAINS = (n, o) => (n && isProto.call(NP, n) ? NP.contains.call(n, o) : n.contains(o));
  const ATTR = (n, a) => (isEl(n) ? EP.getAttribute.call(n, a) : n.getAttribute(a));
  const HASATTR = (n, a) => (isEl(n) ? EP.hasAttribute.call(n, a) : n.hasAttribute(a));
  const RECT = (n) => (isEl(n) ? EP.getBoundingClientRect.call(n) : n.getBoundingClientRect());
  const BYTAG = (n, t) => { const p = isEl(n) ? EP : isDoc(n) ? DP : null; return p ? p.getElementsByTagName.call(n, t) : n.getElementsByTagName(t); };
  const CHECKVIS = (n, o) => (isEl(n) ? EP.checkVisibility.call(n, o) : n.checkVisibility(o));

  // id, class and tag through the prototype's getters: a form whose control is named "id", "className" or "localName"
  // returns that control for form.id (T47X-3); other objects keep their own property
  const GET = (k) => Object.getOwnPropertyDescriptor(EP, k).get;
  const G_ID = GET('id'), G_CLS = GET('className'), G_CLIST = GET('classList'), G_LN = GET('localName');
  const G_PREV = GET('previousElementSibling');
  const IDOF = (n) => (isEl(n) ? G_ID.call(n) : n.id);
  const CLSOF = (n) => (isEl(n) ? G_CLS.call(n) : n.className);
  const CLISTOF = (n) => (isEl(n) ? G_CLIST.call(n) : n.classList);
  const LNOF = (n) => (isEl(n) ? G_LN.call(n) : n.localName);

  // ---------------------------------------------------------------- helpers
  const clip = (s, n = 160) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  function vis(el) {
    if (el.hidden) return false;
    // While a site shows a modal, modal libraries set aria-hidden on every other child of <body>: ignore it there.
    // and where a pop-up has set it on the page's main landmark or the box holding its title, it is ignored there too
    if (ATTR(el, 'aria-hidden') === 'true' && el.parentElement !== document.body &&
        !(LNOF(el) === 'main' || ATTR(el, 'role') === 'main' || (MAIN_H1 && CONTAINS(el, MAIN_H1)))) return false;
    if (el.checkVisibility) {
      if (CHECKVIS(el, { visibilityProperty: true })) return true;
      return getComputedStyle(el).display === 'contents';
    }
    return el.getClientRects().length > 0;
  }
  let MAIN_H1 = null;   // the page's title heading, found without the aria-hidden rule (set at each scan)
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', color: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };
  const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const INTERACTIVE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],' +
    '[role=searchbox],[contenteditable=""],[contenteditable=true]';
  function role(el) {
    const ex = ATTR(el, 'role');
    if (ex) {
      const r = ex.trim().split(/\s+/)[0];
      // round 5: a rich-text viewer that calls itself a textbox but can't be typed in (Vimeo's comments, a read-only
      // ProseMirror) is text to read, never a field
      if ((r === 'textbox' || r === 'searchbox') && !/^(input|textarea|select)$/.test(LNOF(el)) && !el.isContentEditable &&
          (ATTR(el, 'contenteditable') === 'false' || ATTR(el, 'aria-readonly') === 'true')) return null;
      if (r && r !== 'presentation' && r !== 'none' && r !== 'generic') return r;
    }
    switch (LNOF(el)) {
      case 'a': case 'area': return HASATTR(el, 'href') ? 'link' : null;
      case 'button': return 'button';
      case 'input': {
        const t = (ATTR(el, 'type') || 'text').toLowerCase();
        if (t === 'hidden') return null;
        if (HASATTR(el, 'list') && /^(text|search|email|tel|url)$/.test(t)) return 'combobox';
        return INPUT_ROLES[t] || 'textbox';
      }
      case 'select': return 'combobox';
      case 'textarea': return 'textbox';
      case 'summary': return el.parentElement && LNOF(el.parentElement) === 'details' ? 'button' : null;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return null;
  }
  const txt = (el) => (el.innerText !== undefined ? el.innerText : el.textContent) || '';
  // a name that is really an identifier ("help_button", "nav-toggle") or a URL is no name for a person
  const BAD_NAME = /^([a-z0-9]+([_-][a-z0-9]+)+|https?:\/\/\S+|www\.\S+|[a-z0-9.-]+\.(com|net|org|io)\/\S*|button|link|icon|image|img|svg|null|undefined)$/i;
  // "Open Menu Icon" -> "Open Menu": a role word at the end of a name says nothing
  const okName = (s) => { s = clip(s).replace(/\s+(icon|button|btn|link)$/i, ''); return s && !BAD_NAME.test(s) ? s : ''; };
  // visible text names a control even when it looks like an identifier: a person's handle ("hedgerow-dev") is a name;
  // only a URL or a bare role word is not
  const VIS_BAD = /^(https?:\/\/\S+|www\.\S+|[a-z0-9.-]+\.(com|net|org|io)\/\S*|button|link|icon|image|img|svg|null|undefined)$/i;
  const okVisible = (s) => { s = clip(s).replace(/\s+(icon|button|btn|link)$/i, ''); return s && !VIS_BAD.test(s) ? s : ''; };
  // the text a sighted member reads: screen-reader-only spans ("Filter by author", "Unread") are left out
  const SR_SEL = '[class*=sr-only i],[class*=visually-hidden i],[class*=visuallyhidden i],[class*=screen-reader i],[class*=screenreader i],[class*=a11y i],[class*=VisuallyHidden]';
  // screen-reader-only: a box of at most 2 px, taken out of the flow (position absolute or fixed), that holds text
  function srOnly(e) {
    const r = RECT(e);
    if (r.width > 2 || r.height > 2) return false;
    const p = getComputedStyle(e).position;
    return p === 'absolute' || p === 'fixed';
  }
  // round 5: the drawn twin of a screen-reader box: a sibling the page hides from screen readers (aria-hidden) but draws,
  // that says what the box says (the same digits, or the same words): IKEA's "$19.99" beside its "Price $ 19.99"
  function shownTwin(sr) {
    const said = (sr.textContent || '').replace(/\s+/g, ' ').trim();
    if (!said || said.length > 80) return '';
    const digits = (s) => s.replace(/\D+/g, ''), words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    for (const t of [G_PREV.call(sr), sr.nextElementSibling]) {
      if (!t || ATTR(t, 'aria-hidden') !== 'true' || !t.getClientRects().length) continue;
      const r = RECT(t);
      if (r.width < 4 || r.height < 4) continue;
      const shown = (t.innerText || '').replace(/\s+/g, ' ').trim();
      if (!shown || shown.length > 40) continue;
      const same = digits(shown).length >= 2 ? digits(shown) === digits(said) : words(said).includes(words(shown)) && words(shown).length >= 2;
      if (same) return shown;
    }
    return '';
  }
  function visText(el) {
    const t = txt(el);
    const kidsAll = el.firstElementChild ? BYTAG(el, '*') : null;
    if (!kidsAll || kidsAll.length > 40) return t;
    let out = t;
    for (const h of kidsAll) if (h.firstChild && h.firstChild.nodeType === 3 && srOnly(h)) { const ht = txt(h).trim(); if (ht) out = out.replace(ht, ' '); }
    // two boxes the layout sets apart read apart: a kicker and its headline in one link, "Politics sketch The lamp…"
    for (const h of kidsAll) {
      const p = isEl(h) ? G_PREV.call(h) : null;
      if (!p) continue;
      const a = txt(p).trim(), b = txt(h).trim();
      if (!a || !b || out.indexOf(a + b) < 0 || !setApart(h)) continue;
      out = out.replace(a + b, a + ' ' + b);
    }
    return out;
  }
  function accName(el) {
    // R1: a link's or button's name is its visible text; labels name only controls without one
    const ln0 = LNOF(el);
    if (ln0 !== 'input' && ln0 !== 'select' && ln0 !== 'textarea' && ln0 !== 'img') {
      const vt = okVisible(visText(el));
      // a count alone ("25") says nothing: its spoken words say what it counts ("25 Go to comments")
      if (vt && /^\(?[\d.,\s]+[kKmM]?\)?$/.test(vt)) {
        const full = okVisible(txt(el)); if (full && /\p{L}/u.test(full)) return full;
        // R38: a count never stands alone: its label or title says what it counts ("2 people liked this post")
        const lab = okName(ATTR(el, 'aria-label') || ATTR(el, 'title') || '');
        if (lab && /\p{L}/u.test(lab)) return lab.includes(vt.trim()) ? lab : vt.trim() + ' · ' + lab;
      }
      if (vt) return vt;
    }
    let s = ATTR(el, 'aria-labelledby');
    if (s) {
      const t = s.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? txt(e) : ''; }).join(' ');
      if (okName(t)) return okName(t);
    }
    s = ATTR(el, 'aria-label');
    if (s && okName(s)) return okName(s);
    const ln = LNOF(el);
    if (ln === 'input' || ln === 'select' || ln === 'textarea') {
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels, txt).join(' ');
        if (okName(t)) return okName(t);
      }
      if (ln === 'input') {
        const t = (el.type || '').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset') return clip(el.value || (t === 'reset' ? 'Reset' : 'Submit'));
        if (t === 'image') return clip(el.alt || 'Submit');
      }
      return okName(ATTR(el, 'title') || ATTR(el, 'placeholder') || '') ||
        (/search|^q$/i.test(ATTR(el, 'name') || '') ? 'Search' : '');
    }
    if (ln === 'img') return okName(el.alt || el.title || '');
    let t = okName(txt(el));
    if (!t) {
      const img = QS(el, 'img[alt]');
      if (img && okName(img.alt)) t = okName(img.alt);
      else {
        const st = QS(el, 'svg title,[aria-label],[title]');
        if (st) t = okName(ATTR(st, 'aria-label') || ATTR(st, 'title') || st.textContent);
      }
      if (!t) t = okName(ATTR(el, 'title') || ATTR(el, 'data-tooltip') || ATTR(el, 'data-title') || '');
    }
    return t;
  }
  function safeHref(h) {
    if (!h || /^\s*javascript:/i.test(h)) return '';
    // R23: an engine's redirect link (bing.com/ck, google.com/url) shows and opens as its destination
    try {
      const u = new URL(h, location.href);
      if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
        const v = u.searchParams.get('u') || '';
        if (v.startsWith('a1')) { const d = atob(v.slice(2).replace(/-/g, '+').replace(/_/g, '/')); if (/^https?:\/\//.test(d)) return d.slice(0, 300); }
      }
      if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') {
        const d = u.searchParams.get('q') || u.searchParams.get('url') || '';
        if (/^https?:\/\//.test(d)) return d.slice(0, 300);
      }
    } catch (e) { /* keep the href */ }
    return h.slice(0, 300);
  }
  function bestSrcset(ss) {
    let best = '', bw = 0;
    for (const part of (ss || '').split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const w = d ? parseFloat(d) * (d.endsWith('x') ? 600 : 1) : 1;
      if (w > bw && w <= 1600 || !best) { best = u; bw = w; }
    }
    return best;
  }
  function imgSrc(L, el) {
    const T = L || el;
    // round 5: a lazy picture the page hasn't loaded, and won't while nothing scrolls to it (past the pre-scroll's twelve
    // screens, or a carousel's slide parked off to the side), is no picture for the view: it would be an empty box
    if (L && LNOF(L) === 'img' && !L.complete && !L.naturalWidth &&
        (ATTR(L, 'loading') === 'lazy' || HASATTR(L, 'data-src') || HASATTR(L, 'data-srcset') || HASATTR(L, 'data-lazy-src'))) {
      const r = RECT(L);
      if (r.top + scrollY > 12.5 * innerHeight || r.left >= innerWidth || r.right <= 0) return '';
    }
    let s = (L && L.currentSrc) || ATTR(T, 'src') || '';
    if (!s || s.startsWith('data:') || /blank|spacer|placeholder|lazy|1x1|pixel\.gif/i.test(s)) {
      const lazy = ATTR(T, 'data-src') || ATTR(T, 'data-lazy-src') || ATTR(T, 'data-original') ||
        ATTR(T, 'data-lazy') || bestSrcset(ATTR(T, 'data-srcset') || ATTR(T, 'srcset'));
      if (lazy) s = lazy;
      else {
        const pic = T.closest && CLOSEST(T, 'picture');
        const so = pic && QS(pic, 'source[srcset],source[data-srcset]');
        if (so) s = bestSrcset(ATTR(so, 'data-srcset') || ATTR(so, 'srcset'));
      }
    }
    if (s.startsWith('data:') && s.length > 1500) return '';
    try { return new URL(s, document.baseURI).href; } catch (e) { return ''; }
  }
  function imgDims(L, el) {
    const T = L || el;
    if (L) {
      const r = RECT(L);
      if (r.width >= 2 && r.height >= 2) return [Math.round(r.width), Math.round(r.height)];
    }
    let w = +ATTR(T, 'width') || 0, h = +ATTR(T, 'height') || 0;
    if (L && (!w || !h) && L.naturalWidth) { w = L.naturalWidth; h = L.naturalHeight; }
    return [w, h];
  }
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);

  // ---------------------------------------------------------------- rules (EasyList, EasyList Cookie List; from the server)
  let RULES = null;
  function setRules(j) {
    const r = typeof j === 'string' ? JSON.parse(j) : j;
    RULES = { cls: new Map(Object.entries(r.cls)), ids: new Map(Object.entries(r.ids)), keyed: r.keyed, tags: r.tags, other: r.other, v: r.v };
    return true;
  }
  function qsa(sel, root) { try { return QSA(root || document, sel); } catch (e) { return []; } }
  let COMPILED = null;
  function compiled(hints, unhide, siteOnly) {
    const key = location.hostname + '|' + (siteOnly ? 1 : 0) + '|' + (hints.site || []).length + '|' + unhide.size;
    if (COMPILED && COMPILED.key === key) return COMPILED;
    const lists = { ad: [], consent: [] };
    const hrefRules = [];   // a[href^="…"] and friends (most of EasyList's tag-keyed rules): tested as strings, once per link
    const HREF_SEL = /^(a)?\[href(\^|\*|\$)?="([^"\\]+)"\](\s*>\s*img)?$/;
    const add = (sel, c) => {
      if (unhide.has(sel)) return;
      const m = HREF_SEL.exec(sel);
      if (m) { hrefRules.push([m[2] || '=', m[3], !!m[4], c === 'consent' ? 'consent' : 'ad']); return; }
      lists[c === 'consent' ? 'consent' : 'ad'].push(sel);
    };
    if (!siteOnly) {
      for (const tag in RULES.tags) if (BYTAG(document, tag).length) for (const [sel, c] of RULES.tags[tag]) add(sel, c);
      for (const [sel, c] of RULES.other) add(sel, c);
    }
    for (const [sel, c] of hints.site || []) add(sel, c);
    COMPILED = { key, ad: lists.ad.join(','), consent: lists.consent.join(','), hrefRules };
    // one bad selector would void the whole list: then check each once and keep only the good ones
    for (const cat of ['ad', 'consent']) {
      if (!COMPILED[cat]) continue;
      try { QS(document, COMPILED[cat]); } catch (e) {
        COMPILED[cat] = lists[cat].filter((x) => { try { QS(document, x); return true; } catch (e2) { return false; } }).join(',');
      }
    }
    return COMPILED;
  }

  // ---------------------------------------------------------------- the page scan: what to drop, collapse or island
  const AD_LABEL = /^(sponsored (video|ad|brand|product)s?\b.{0,80}|advertisement|advertisements|advert|adverts|ad|ads|sponsored|promoted|paid (post|content|partnership)|partner content|sponsored (content|links?|stories|products?|results?|posts?)( (from|by) .{1,40})?|sponsored by .{1,40}|promoted by .{1,40}|story continues below advertisement|article continues below (this )?(advertisement|ad)|report this ad|ad feedback|why this ad\??|learn (more )?about this ad|skip ad|ad\s*[·•:]\s*.{0,40}|anzeige|publicité|advertisement - scroll to continue|scroll to continue with content)$/i;
  const AD_TOKENS = new Set(['ad', 'ads', 'adv', 'advert', 'adverts', 'advertisement', 'advertising', 'adslot', 'adunit',
    'adbox', 'adcontainer', 'adwrapper', 'adsense', 'adchoices', 'dfp', 'sponsor', 'sponsored', 'sponsorship', 'promoted',
    'taboola', 'outbrain', 'zergnet', 'revcontent', 'mgid', 'teads', 'googleads', 'adsbygoogle', 'nativead', 'promotedlink']);
  const AD_PREFIX = /^(div-gpt-ad|google_ads|gpt-ad|dfp-ad|ad-slot|ad_slot|adslot|ad-container|ad-wrapper|ad-unit|ad_unit|ad-placeholder|banner-ad|ob-widget|ob_|OUTBRAIN|trc_|tbl-|taboola|outbrain|zergnet|rc-widget|mm-ads-|leaderboard-ad|native-ad|ad-rail|ad-feedback|adthrive|aditude|tude-|pb-slot|pubguru|ezoic)/i;
  const AD_IFRAME = /doubleclick|googlesyndication|googleadservices|googleads|amazon-adsystem|adnxs|criteo|taboola|outbrain|adsafeprotected|teads|safeframe|imasdk|moatads|doubleverify|innovid|flashtalking|adform|smartadserver|pubmatic|rubiconproject|openx|casalemedia|media\.net|serving-sys|eyeblaster|connatix|primis|aniview|vidazoo/i;
  // round 6: a section's subtitle that ends by saying the section is sponsored ("Save big with these great offers | Sponsored")
  const SUBHEAD_AD = /^[^|·•]{3,80}\s[|·•–—]\s*(sponsored|promoted)$/i;
  // invisible format characters a page sets inside a word (bidi marks, zero-width joiners) so a rule won't read it
  const unformat = (s) => s.replace(/\p{Cf}/gu, '');
  const AD_EXPLAIN = /^((pause|play|mute|unmute) sponsored video|why this ad\??|why am i seeing this( ad)?\??|about this ad|about the advertiser|ad ?choices|my ad cent(er|re)|ad info(rmation)?|ad options|learn more about this ad|report (this )?ad|ad feedback|leave feedback on (this )?(sponsored )?ad|this ad is based on.{0,30}|ads? by google)$/i;
  const AD_CLICK_SEL = 'a[href*="doubleclick.net"],a[href*="googleadservices.com"],a[href*="/aclk?"],a[href*="adclick"],a[href*="/pagead/"],' +
    'a[href*="/sspa/click"],a[href*="/gp/slredirect/"],a[href*="/aclick?"],' +
    // an ad network's click id on the link itself (Microsoft's, Google's, Amazon's through an engine's shopping ads),
    // and a store's own ad server (Amazon's sponsored video)
    'a[href*="msclkid="],a[href*="gclid="],a[href*="hvadid="],a[href*="//aax-"],' +
    // round 3: the same click ids inside an engine's own redirect (Yahoo's r.search link, its target URL-encoded), and
    // Amazon's other ad server (its sponsored brand rows)
    'a[href*="msclkid%3d" i],a[href*="gclid%3d" i],a[href*="hvadid%3d" i],a[href*="sponsored-ads.amazon."],' +
    // round 6: a shop's promoted-store offer (eBay's store banner over its results, "My Swanky Home › Extra 5% off")
    'a[href*="_soffid="]';
  const AD_VIDEO_SRC = /dclk_video_ads|doubleclick|googlesyndication|imasdk|innovid|flashtalking|serving-sys|adserver|\/ads?\/|connatix|aniview|primis|vidazoo|teads/i;
  const CMP = /(^|[-_ ])(cookie|cookies|gdpr|ccpa|onetrust|truste|trustarc|cookiebot|didomi|sp_message|qc-cmp2?|fc-consent|osano|termly|iubenda|usercentrics|cookieconsent|cc-window|cc-banner|privacy-banner|privacy-notice|cookielaw)([-_ ]|$)|onetrust|cookiebot|sp_message_container|CybotCookiebot|usercentrics|didomi|truste|cookie-?banner|cookie-?notice|cookie-?consent|cookie-?bar|consent-?banner|privacy-?banner|pmc-privacy/i;
  const CMP_FRAME = /privacy-mgmt\.com|consensu\.org|cookielaw\.org|onetrust|sp-prod\.net|trustarc|consentmanager|cookiebot|usercentrics|didomi|quantcast|cmp\.|\/cmp\/|consent\./i;
  const CONSENT_TXT = /cookie|consent|privacy (choices|settings|preferences|policy)|we (and our partners |and our \d+ partners )?(use|store) (cookies|data|technologies)|accept all|reject all|manage (preferences|options|cookies)|your privacy|personal data|legitimate interest|do not sell/i;
  const PROMO_TXT = /newsletter|subscribe|subscription|sign up for|sign up to|signup|get (\d+% off|the app|our app|our (daily|weekly)|updates|exclusive)|\d+\s?% off|discount|promo code|download (the|our) app|open in (the )?app|use the app|get the .{0,20}app|install (the )?app|create (a |an |your )?(free )?account|register (now|for free|today)|continue reading|already a (subscriber|member)|unlock (unlimited|full|this)|join (now|today|for free|the conversation)|support (the guardian|us|our (journalism|work)|independent)|make a contribution|donate|become a (member|supporter|subscriber)|don't miss|never miss|be the first to know|enter your email|your inbox/i;
  const SIGNIN_TXT = /\b(sign in|log in|login|sign up|create (an |a |your )?account|continue with (google|apple|facebook|email)|new to [a-z ]{1,20}\?|join [a-z ]{1,20} today|don['’]t miss what['’]s happening|get the full experience|for the best experience)\b/i;
  // walls (rating-v3 policy: the view never shows more than the real page shows this member)
  const PAYWALL_TXT = /continue reading with|subscribe (to [^.]{1,40} )?to (continue|keep) reading|(subscribe|subscription|subscriber|paid members?)[^.]{0,40}to (continue|keep) reading|to (continue|keep) reading,? (subscribe|sign in|log in|become)|already (a|have a) (subscriber|subscription|member)|unlock (unlimited|full|this|the rest)|this (article|story|content|post) is (only )?(for|available to|exclusive to|reserved for) (paid )?(subscribers|members)|keep reading with|you['’]ve (reached|read|used) (your|all|the) [^.]{0,30}(free|limit)|free articles? (left|remaining)|register (for free )?to (continue|keep) reading|create a free account to (continue|keep) reading|subscribe to read/i;
  const AGREE_BTN = /^((i )?(agree|accept)( all)?( cookies)?( (and|&) (continue|close|proceed))?|ok(ay)?|got it|i understand|continue|yes,? i agree)[.!]?$/i;
  const DISMISS_BTN = /^(close( (dialog|modal|this|window|pop-?up|banner|message))?|dismiss.{0,30}|×|✕|✖|x|no,? thanks.{0,30}|not now|maybe later|skip.{0,20}|continue (reading|to (the )?(site|article|story))( for free)?|i['’]ll do it later|remind me later)$/i;
  const MANAGE_BTN = /\b(manage|settings|preferences|options|customi[sz]e|choices|more options|configure|purposes|vendors)\b/i;
  // T47X-1: a cookie banner names cookies, partners, vendors or tracking in its own words ("consent" or "privacy policy"
  // alone is not enough), sits in a fixed or sticky box (or absolute, z-index 10 or more), and is never an app's access
  // request, a parent's approval or a signature box
  const COOKIE_WORDS = /\bcookies?\b|\b(partners|vendors)\b|\btracking\b/i;
  const NOT_COOKIE_CTX = /wants (to )?access|access (to )?your (account|data|profile)|\bauthori[sz]e\b|\boauth\b|sign in with|\bparent(al|s)?\b|\bguardian\b|\be-?sign|electronic (disclosure|signature|records)|\bsignature\b|\bpaperless\b/i;
  const ACCEPT_BTN = /^(accept|allow|agree|ok|got it)\b/i;
  function positioned(el) {
    for (let p = el, i = 0; p && p !== document.body && i < 6; p = p.parentElement, i++) {
      const cs = getComputedStyle(p);
      if (cs.position === 'fixed' || cs.position === 'sticky' || (cs.position === 'absolute' && (parseInt(cs.zIndex, 10) || 0) >= 10)) return p;
    }
    return null;
  }
  function cookieBanner(el, t) {
    t = t != null ? t : (el.innerText || '');
    return COOKIE_WORDS.test(t) && !NOT_COOKIE_CTX.test(t) && !!positioned(el);
  }
  // T47X-2: a site's own security, session or payment notice is never hidden: it stays as one small block with its buttons
  const NOTICE_TXT = /\b(unusual|suspicious|security|session|expir(e|es|ed|ing)|verif(y|ication)|declined|failed|locked|password (changed|reset))\b/i;
  const REJECT_TXT = /^(reject( all)?( cookies)?|reject (all )?(non-?essential|optional|additional)( cookies)?|decline( all)?( cookies)?|refuse( all)?|deny( all)?|i do not accept|do not accept|disagree|necessary (cookies )?only|only (necessary|essential|required)( cookies)?|(use|allow|accept) (only )?(necessary|essential|required|strictly necessary)( cookies)?( only)?|continue without (accepting|agreeing|consent)|reject and close)$/i;
  const RECIRC_HEAD = /^(recommended( for you| stories| videos| articles| reading)?|you (may|might) (also )?(like|enjoy)|more (stories|from .{1,40}|to explore|like this|on this (story|topic)|news|videos|top stories)|trending( now| stories| topics)?|most (popular|read|viewed|watched|shared|commented)|popular (now|stories|on .{1,30})|around the web|promoted (stories|content|links)|from (our|the) partners|sponsored (stories|links|content)|related (stories|articles|content|coverage|posts|reading|videos)|read (more|next)|what to read next|editors['’]? picks|top stories|more in .{1,30}|explore more|also (read|in the news)|you might have missed|in case you missed it|latest (stories|videos)|up next|people also (ask|search for|searched for)|related searches|searches related to .{1,60}|refine (this )?search|today['’]s deals|deals( for you| of the day)?|new arrivals|brands related to .{1,60}|top rated|best ?sellers|editorial recommendations|customers (also|frequently) .{1,60}|inspired by your .{1,60}|deals based on (your|this) .{1,40}|(based|inspired) on your (search|browsing|history|recent views)|recently viewed( items)?|shorts|trending (now|videos|searches)|complete (with|the look|your look|the set)|goes (well )?with|pairs well with|frequently bought together|bought together|suggested topics|new (&|and) unread( topics)?|related topics|similar topics)$/i;
  const FEEDBACK_HEAD = /^(tell us (about|what you think of) your (search |shopping )?experience\.?|tell us what you think\.?|was this (page |article |answer |post |result )?(helpful|useful)\??|help (us )?improve .{1,40}|rate this (page|article)|(send |give )?feedback|did you find (what|this) .{1,30}\??)$/i;
  const RECIRC_SPONSORED = /around the web|promoted|from (our|the) partners|sponsored|paid/i;
  // the one shelf the view keeps (at the end): the same site's own related items
  const RELATED_HEAD = /^(related( stories| articles| content| coverage| posts| reading| videos)?|up next|similar( items| products)?|more on this (story|topic)|more like this)$/i;
  const NEWSLETTER_TXT = /newsletter|subscribe|inbox|enter your email|e-?mail address|sign up for (our|the)/i;
  const RECIRC_CLS = /(^|[-_])(recirc|recirculation|most-popular|mostpopular|most-read|trending|more-stories|you-may-like|related-(articles|stories|content|posts|searches)|recommended|recommendations)([-_]|$)/i;
  const PLAYER_SEL = '.jwplayer,.jw-wrapper,video-js,.video-js,.brightcove-player,[class*="VideoPlayer"],[class*="video-player" i],' +
    '[class*="videoPlayer"],[data-testid*="video-player" i],[class*="media-player" i],[class*="MediaPlayer"],.mw-tmh-player,' +
    'smp-toucan-player,bbc-smp,[data-component="video-block"],[data-testid="video-block"],.html5-video-player,.vp-video-wrapper,' +
    'media-controller,mux-player,media-player,hls-video,[class*="aspect-video"]';
  const PLAYER_IFRAME = /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|players\.brightcove\.net|cdn\.jwplayer\.com\/players|content\.jwplatform\.com|jwplayer\.com\/players|fast\.wistia\.(net|com)\/embed|dailymotion\.com\/(embed|player)|geo\.dailymotion\.com|player\.twitch\.tv|embed\.ted\.com|streamable\.com\/[eo]\/|loom\.com\/embed|facebook\.com\/plugins\/video|tiktok\.com\/embed|player\.cnbc|vidyard\.com\/embed|embed\.vevo|bitchute\.com\/embed|rumble\.com\/embed|odysee\.com\/\$\/embed|archive\.org\/embed|commons\.wikimedia\.org\/wiki\/File:.*embedplayer|cdnapisec\.kaltura|ooyala|anvato|vod\.|\/videoembed|\/embed\/video/i;
  const PRE_ROLL_SEL = '.ad-showing,.ad-interrupting,.ytp-ad-player-overlay,.ytp-ad-module .ytp-ad-text,.jw-flag-ads,.vjs-ad-playing,.vjs-ad-loading,[class*="ad-playing"],.ima-ad-container:not([style*="display: none"]) video,[data-ad-state="playing"]';
  const CHROME_NAME = { nav: 'Site menu', header: 'Site menu', footer: 'Site menu', links: 'Site menu', filters: 'Filters', toc: 'Contents',
    navbox: 'Topic links', cats: 'Categories' };

  function tokensOf(s) {
    // "AdSlot-styles__AdSlotContainerStyled" -> ad slot styles ad slot container styled
    return s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  const classAdCache = new Map();
  function classAd(el) {
    const key = (IDOF(el) || '') + '|' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : '');
    let v = classAdCache.get(key);
    if (v === undefined) { v = classAd0(el); if (classAdCache.size < 50000) classAdCache.set(key, v); }
    return v;
  }
  function classAd0(el) {
    const names = [];
    if (IDOF(el)) names.push(IDOF(el));
    for (const c of CLISTOF(el)) names.push(c);
    for (const n of names) {
      if (AD_PREFIX.test(n)) return true;
      const toks = n.split(/[-_]/);
      for (const t of toks) if (AD_TOKENS.has(t.toLowerCase())) return true;
      const ct = tokensOf(n);
      for (let i = 0; i < ct.length; i++) {
        if ((ct[i] === 'ad' || ct[i] === 'ads') && /^(slot|unit|container|wrapper|box|banner|space|zone|label|feedback|leaderboard|rail|placeholder|block|section|wrap|holder|frame)$/.test(ct[i + 1] || '')) return true;
      }
    }
    return false;
  }

  function scanPage(hints) {
    const t0 = performance.now();
    hints = hints || {};
    const S = { junk: new Map(), chrome: new Map(), islands: [], islandOf: new Map(), cards: new Map(), skipLinks: new Set(),
      depth: new Map(), stats: { list: 0, cookie: 0, heur: 0, sub: {} }, consent: [], cmpFrames: [], challenge: null, relatedName: new Map(),
      adPlayers: new Set(), promoPlayers: new Map(), userStarted: userActed, why: new Map(), adLabels: [], tiles: new Map() };
    const body = document.body;
    if (!body) return S;
    const all = BYTAG(body, '*');
    // sub-stage times (ms), for finding where a slow page spends its scan
    let tl = performance.now();
    const lap = (k) => { const n = performance.now(); S.stats.sub[k] = Math.round((S.stats.sub[k] || 0) + n - tl); tl = n; };
    const VW = innerWidth, VH = innerHeight;
    // ------------------------------------------------ the main content, which nothing may drop
    let h1 = null;
    MAIN_H1 = null;
    for (const h of BYTAG(document, 'h1')) if ((!h.checkVisibility || CHECKVIS(h, { visibilityProperty: true })) && txt(h).trim()) { MAIN_H1 = h; break; }
    for (const h of BYTAG(document, 'h1')) if (vis(h) && txt(h).trim()) { h1 = h; break; }
    S.h1 = h1;
    const root = semanticRoot({}) || null;
    S.root = root;
    const bodyText = (body.textContent || '').length || 1;
    const docArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
    // the boxes that hold the title, the article root or a main landmark, found once (not a query per element)
    const PROT = new Set();
    const addUp = (e) => { for (let p = e; p && p !== body; p = p.parentElement) PROT.add(p); };
    if (h1) addUp(h1);
    if (root) addUp(root);
    for (const m of QSA(body, 'main,[role=main]')) addUp(m);
    const protectedEl = (el) => el === body || el === document.documentElement || PROT.has(el);
    S.prot = protectedEl;
    // nothing that holds a large share of the page's text is dropped, whatever a rule says
    const tooBig = (el) => {
      const r = RECT(el);
      if (area(r) < 0.12 * docArea && r.height < 1500) return false;
      const n = (el.textContent || '').length;
      return n > 800 && n > 0.35 * bodyText;
    };
    const mark = (el, cat, src) => {
      if (!el || S.junk.has(el) || protectedEl(el) || tooBig(el)) return false;
      S.junk.set(el, cat);
      S.stats[src] = (S.stats[src] || 0) + 1;
      if (DEBUG_SRC) S.why.set(el, src + ' ' + (new Error().stack.split('\n')[2] || '').trim().slice(0, 60));
      return true;
    };
    // the slot around an ad frame or label: climb while the parent adds little but the label and padding
    const slotOf = (el, maxText) => {
      let c = el;
      const r0 = RECT(el);
      const a0 = Math.max(area(r0), 1);
      for (let i = 0; i < 6 && c.parentElement && c.parentElement !== body; i++) {
        const p = c.parentElement;
        if (protectedEl(p)) break;
        const rp = RECT(p);
        const t = (p.innerText || '').trim().length;
        if (area(rp) > Math.max(a0 * 2.6, a0 + 140 * Math.max(rp.width, 1)) || t > (maxText || 80)) break;
        c = p;
      }
      return c;
    };
    // ------------------------------------------------ 1. EasyList / Cookie List element hiding (generic + this site)
    const unhide = new Set(hints.unhide || []);
    if (RULES && !hints.noGeneric && !hints.noCosmetic) {
      const keyedHits = [];
      for (const el of all) {
        if (IDOF(el)) {
          const c = RULES.ids.get(IDOF(el));
          if (c && !unhide.has('#' + IDOF(el))) mark(el, c === 'consent' ? 'consent' : 'ad', c === 'consent' ? 'cookie' : 'list');
          const k = RULES.keyed['i:' + IDOF(el)];
          if (k) keyedHits.push([el, k]);
        }
        if (CLISTOF(el).length) {
          for (const cl of CLISTOF(el)) {
            const c = RULES.cls.get(cl);
            if (c && !unhide.has('.' + cl)) { mark(el, c === 'consent' ? 'consent' : 'ad', c === 'consent' ? 'cookie' : 'list'); }
            const k = RULES.keyed['c:' + cl];
            if (k) keyedHits.push([el, k]);
          }
        }
      }
      lap('rules_ids_classes');
      for (const [el, ks] of keyedHits) {
        for (const [sel, c] of ks) {
          if (unhide.has(sel)) continue;
          try { if (MATCHES(el, sel)) mark(el, c === 'consent' ? 'consent' : 'ad', c === 'consent' ? 'cookie' : 'list'); } catch (e) { /* invalid */ }
        }
      }
      // the tag-keyed (for tags the page has), unkeyed and this site's selectors, compiled once per document and
      // site into one selector list per category: one native pass over the DOM instead of one query per selector
      lap('rules_keyed');
      const comp = compiled(hints, unhide);
      lap('rules_compile');
      for (const cat of ['ad', 'consent']) if (comp[cat]) for (const el of qsa(comp[cat])) mark(el, cat, cat === 'consent' ? 'cookie' : 'list');
      lap('rules_qsa');
      if (comp.hrefRules.length) {
        for (const a of QSA(document, '[href]')) {
          const h = ATTR(a, 'href');
          for (const [op, v, img, cat] of comp.hrefRules) {
            if (op === '^' ? h.startsWith(v) : op === '*' ? h.includes(v) : op === '$' ? h.endsWith(v) : h === v) {
              if (img) { for (const im of a.children) if (LNOF(im) === 'img') mark(im, cat, 'list'); } else mark(a, cat, 'list');
              break;
            }
          }
        }
      }
    } else if (!hints.noCosmetic && (hints.site || []).length) {
      const comp = compiled(hints, unhide, true);
      for (const cat of ['ad', 'consent']) if (comp[cat]) for (const el of qsa(comp[cat])) mark(el, cat, cat === 'consent' ? 'cookie' : 'list');
    }
    lap('rules');
    S.stats.t_rules = Math.round(performance.now() - t0);
    // ------------------------------------------------ 2. structure: ad frames, labels, class names
    const adHosts = new Set(hints.adHosts || []);
    const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch (e) { return ''; } };
    for (const f of BYTAG(document, 'iframe')) {
      const src = f.src || '';
      const h = hostOf(src);
      const nm = (IDOF(f) || '') + ' ' + (f.name || '') + ' ' + (f.title || '') + ' ' + (ATTR(f, 'aria-label') || '');
      if (CMP_FRAME.test(src) && vis(f) && area(RECT(f)) > 2000) { S.cmpFrames.push(src.slice(0, 300)); mark(slotOf(f, 200), 'consent', 'heur'); continue; }
      if (/challenges\.cloudflare\.com|turnstile|hcaptcha\.com|recaptcha\/(api2|enterprise)\/(anchor|bframe)/i.test(src) && vis(f)) {
        const fr = RECT(f);
        // a visible check on the page (an invisible reCAPTCHA behind a login button is not one)
        if (fr.width >= 150 && fr.height >= 50 && fr.bottom > 0) S.challenge = /cloudflare|turnstile/i.test(src) ? 'cloudflare' : 'captcha';
      }
      if (PLAYER_IFRAME.test(src) && !AD_IFRAME.test(src)) continue;
      if ((h && adHosts.has(h)) || AD_IFRAME.test(src) || /google_ads_iframe|^aswift_|3rd party ad content|advertisement|^ad[_-]?frame|sponsored/i.test(nm)) {
        // an ad layer inside a player (IMA's frame over TED's talk) is the player's own: never the player's box
        const inPlayer = CLOSEST(f, PLAYER_SEL) || (f.parentElement && bigVideo(f.parentElement.parentElement || f.parentElement));
        if (inPlayer) { if (!S.junk.has(f)) S.junk.set(f, 'ad'); } else mark(slotOf(f), 'ad', 'heur');
      }
    }
    // an ad's click link (an ad network's, or a store's own sponsored-click redirect: Amazon's /sspa/click): the whole
    // result it sits in (a repeated sibling), else its slot
    const adItems = new Set();
    for (const a of QSA(document, AD_CLICK_SEL)) {
      const it = itemOf(a, protectedEl);
      const t = it && (it.innerText || '').length < 1500 ? it : slotOf(a, 160);
      mark(t, 'sponsored', 'heur');
      if (t) adItems.add(t);
    }
    // a row or carousel whose every item is sponsored ("Shop desk lamp by type"): the whole widget, with its heading
    const adRows = new Set();
    for (const it of adItems) if (it.parentElement && it.parentElement !== body) adRows.add(it.parentElement);
    for (const L of adRows) {
      const kids = Array.from(L.children).filter((k) => vis(k));
      if (kids.length < 2 || !kids.every((k) => adItems.has(k) || S.junk.has(k))) continue;
      dropAdWidget(S, L);
    }
    // an ad's explainer control ("Why this ad?", "About this ad", AdChoices), often an icon button named only by its
    // label: the result or slot it sits in is an ad, wherever the engine puts it (P30)
    for (const e of QSA(document, 'a[aria-label],button[aria-label],[role=button][aria-label],a[title],button[title],[role=button][title]')) {
      const n = (ATTR(e, 'aria-label') || ATTR(e, 'title') || '').replace(/\s+/g, ' ').trim();
      if (!n || n.length > 60 || !AD_EXPLAIN.test(n) || inJunk(S, e)) continue;
      const it = itemOf(e, protectedEl);
      mark(it && (it.innerText || '').length < 1500 ? it : slotOf(e, 160), 'ad', 'heur');
      S.adLabels.push(e);
    }
    for (const v of BYTAG(document, 'video')) {
      if (!AD_VIDEO_SRC.test(v.currentSrc || v.src || '')) continue;
      let own = false;
      for (let p = v.parentElement, i = 0; p && p !== body && i < 8; p = p.parentElement, i++) if (ownPreRoll(p)) { own = true; break; }
      if (own) continue;
      // outside a player it is an ad slot; inside one, an ad that started by itself, muted, makes the player an ad player
      // (a recipe site's autoplaying ad video). A pre-roll the member started plays out in the island.
      if (!CLOSEST(v, PLAYER_SEL) && !(v.parentElement && bigVideo(CLOSEST(v.parentElement, 'div,section,figure') || v.parentElement) && RECT(v).width < 400)) mark(slotOf(v, 160), 'ad', 'heur');
      else if (v.muted && !v.paused && !S.userStarted) {
        const pl = CLOSEST(v, PLAYER_SEL);
        if (RECT(pl).width < 0.6 * innerWidth) S.adPlayers.add(pl);   // a video page's own player waits its pre-roll out
      }
    }
    // ad labels: found from the short text nodes (one pass), then the element that holds just the label
    lap('struct_frames_links');
    const labels = new Set();
    const subAds = new Set();   // round 6: a section's subtitle that says it's sponsored ("Top selling items | Sponsored")
    const twl = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let t = twl.nextNode(); t; t = twl.nextNode()) {
      const d = t.data;
      if (d.length > 100 || d.length < 2) continue;
      let el = t.parentElement;
      if (!el || LNOF(el) === 'script' || LNOF(el) === 'style') continue;
      // round 6: a label spelled with invisible format characters inside it ("Sp⁧onsored", eBay's) is still one
      const tt0 = unformat(d).replace(/\s+/g, ' ').trim();
      if (!tt0 || !AD_LABEL.test(tt0)) {
        if (SUBHEAD_AD.test(tt0)) { subAds.add(el); continue; }
        if (d.length > 80) continue;
        // a label split over two text nodes ("Ad · " + "site") is judged on its element
        if (el.childElementCount <= 3 && (el.textContent || '').length <= 60 && AD_LABEL.test(unformat(el.textContent || '').replace(/\s+/g, ' ').trim())) labels.add(el);
        continue;
      }
      labels.add(el);
    }
    // round 6: a section whose own head (its heading and a subtitle line under it) says it's sponsored ("Picked For You /
    // Top selling items from trusted sellers | Sponsored", eBay's carousels among its results) is an ad, whole: the
    // smallest box around the head that holds more than the head
    for (const el of subAds) {
      let hd = null;
      for (let p = el, i = 0; p && p !== body && i < 4 && !hd; p = p.parentElement, i++) {
        hd = QS(p, 'h1,h2,h3,h4,[role=heading]');
        if (hd && (p.textContent || '').length > 160) hd = null;
      }
      if (!hd || hd === h1 || !vis(el)) continue;
      const ht = (hd.parentElement && CONTAINS(hd.parentElement, el) ? hd.parentElement : hd);
      const n0 = Math.max((ht.textContent || '').length, (el.textContent || '').length);
      let sec = null;
      for (let p = ht.parentElement, i = 0; p && p !== body && i < 5; p = p.parentElement, i++) {
        if (!CONTAINS(p, el)) continue;
        const n = (p.textContent || '').length;
        if (n >= 3 * n0 && n >= 200) { sec = p; break; }
      }
      if (sec && (sec.textContent || '').length <= 4000 && !(h1 && CONTAINS(sec, h1))) mark(sec, 'sponsored', 'heur');
    }
    lap('struct_labels_tw');
    for (const el of all) {
      if (labels.has(el)) {
        const tt = unformat(el.textContent || '').replace(/\s+/g, ' ').trim();
        {
          if (tt && AD_LABEL.test(tt) && vis(el)) {
            // the label itself always goes; then the card or slot it labels (not a player: its pre-roll is waited out)
            if (!S.junk.has(el)) { S.junk.set(el, 'ad'); S.stats.heur++; }
            S.adLabels.push(el);
            if (!CLOSEST(el, PLAYER_SEL)) { const item = itemOf(el, protectedEl); if (item && !QS(item, PLAYER_SEL) && !bigVideo(item)) mark(item, /^(sponsored|promoted|paid|partner)/i.test(tt) ? 'sponsored' : 'ad', 'heur'); }
          }
        }
      }
      if ((IDOF(el) || CLISTOF(el).length) && classAd(el)) {
        // a column or article whose class says it holds ads ("sc-ad-container" on the whole recipe) is not an ad,
        // nor is a player in its ad state ("jw-flag-ads", ".ad-showing"): the island waits the pre-roll out
        if (/^(article|main|body|section)$/.test(LNOF(el)) && (el.innerText || '').length > 1500) continue;
        if (CLOSEST(el, PLAYER_SEL) || bigVideo(el)) continue;
        mark(el, 'ad', 'heur');
      }
    }
    // a row or module whose every item is labeled an ad (a search engine's shopping ads) drops whole, with its heading
    // and its own controls (dropAdWidget)
    {
      const items = new Set(), rows = new Set();
      for (const l of S.adLabels) { const it = itemOf(l, protectedEl); if (it) { items.add(it); if (it.parentElement && it.parentElement !== body) rows.add(it.parentElement); } }
      const adKid = (k) => S.junk.has(k) || [...items].some((it) => CONTAINS(k, it) && (it.textContent || '').length >= 0.8 * (k.textContent || '').length);
      for (const L of rows) {
        const kids = Array.from(L.children).filter((k) => vis(k));
        if (kids.length >= 2 && kids.every(adKid) && !protectedEl(L)) dropAdWidget(S, L);
      }
    }
    lap('struct_all');
    S.stats.t_struct = Math.round(performance.now() - t0);
    // ------------------------------------------------ 3. consent banners, promos, sign-in upsells, empty overlays
    const overlays = new Set();
    const central = new Set();   // over the middle of the screen, or a bar or corner box: not a side column
    for (const d of QSA(document, 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) if (vis(d)) { overlays.add(d); central.add(d); }
    // only near the top of the tree, where overlays live: the first seven levels, in one query
    for (const n of QSA(body, ':scope>*,:scope>*>*,:scope>*>*>*,:scope>*>*>*>*,:scope>*>*>*>*>*,:scope>*>*>*>*>*>*,:scope>*>*>*>*>*>*>*')) {
      if (NOT_OVERLAY.has(LNOF(n))) continue;   // text and media elements are never the overlay box itself
      // the box first (cheap), the style only for boxes that could be an overlay, a bottom bar or a corner box
      const r = RECT(n);
      if (r.width < 2 || r.height < 2) continue;
      if (!(area(r) >= 0.15 * VW * VH || (r.bottom >= VH - 4 && r.height >= 40 && r.width >= 0.5 * VW) ||
            (r.width < 0.45 * VW && r.bottom >= VH - 60 && r.bottom <= VH + 4))) continue;
      const cs = getComputedStyle(n);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (!vis(n)) continue;
      const fixed = cs.position === 'fixed';
      const big = fixed && area(r) >= 0.15 * VW * VH;
      const bottomBar = r.bottom >= VH - 4 && r.top > VH * 0.4 && r.height >= 40 && r.width >= 0.5 * VW;
      const corner = fixed && r.width < 0.45 * VW && r.height < 0.6 * VH && (r.right >= VW - 40 || r.left <= 40) && r.bottom >= VH - 60;
      const topNav = r.top <= 2 && r.height < 170;
      if ((big || bottomBar || corner) && !topNav) { overlays.add(n); if (bottomBar || corner || (r.left < VW / 2 && r.right > VW / 2 && r.top < VH / 2 && r.bottom > VH / 2)) central.add(n); }
    }
    lap('overlay_find');
    for (const el of all) {
      if ((IDOF(el) || CLISTOF(el).length) && CMP.test((IDOF(el) || '') + ' ' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : ''))) {
        const t = (el.innerText || '').trim();
        if (t.length < 3000 && CONSENT_TXT.test(t + ' ' + IDOF(el) + ' ' + CLSOF(el)) && vis(el) && cookieBanner(el, t)) overlays.add(el);
      }
    }
    lap('overlay_cmp');
    // a consent manager's banner set in the page's own flow (GOV.UK's, at the top): hidden from the view and counted,
    // never pressed (deskd's consent press is for a fixed box only, T47X-1)
    for (const el of all) {
      if (!(IDOF(el) || CLISTOF(el).length) || !CMP.test((IDOF(el) || '') + ' ' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : ''))) continue;
      if (S.junk.has(el) || overlays.has(el) || protectedEl(el) || !vis(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 40 || t.length > 1500 || !COOKIE_WORDS.test(t) || NOT_COOKIE_CTX.test(t) || !CONSENT_TXT.test(t)) continue;
      // a consent choice among its own controls, not just a word in its text (a recipe card for cookies has none)
      if (!Array.from(QSA(el, 'button,[role=button],a[href]')).some((b) => /\b(accept|reject|agree|allow|decline)\b|cookie (settings|preferences)|manage (cookies|preferences)|(only )?necessary( only)?$/i.test((b.innerText || '').trim()))) continue;
      if (positioned(el) || [...S.junk.keys()].some((j) => CONTAINS(j, el))) continue;
      S.junk.set(el, 'consent');
    }
    S.notices = [];
    for (const o of overlays) {
      if (protectedEl(o) || [...S.junk.keys()].some((j) => j !== o && CONTAINS(j, o) && S.junk.get(j) !== 'ad')) continue;
      const t = (o.innerText || '').replace(/\s+/g, ' ').trim();
      // T47X-2: an alert is never dropped; a security, session or payment notice is kept as one small block
      if (MATCHES(o, '[role=alert],[role=alertdialog]') || QS(o, '[role=alert],[role=alertdialog]')) continue;
      if (t && t.length < 600 && NOTICE_TXT.test(t) && !(COOKIE_WORDS.test(t))) { S.notices.push(o); S.junk.set(o, 'notice'); continue; }
      const hasMedia = QS(o, 'video,iframe,img,canvas');
      let cat = null;
      if (CONSENT_TXT.test(t) && t.length < 4000 && cookieBanner(o, t) && (CMP.test(IDOF(o) + ' ' + CLSOF(o)) ||
          (/\b(cookies?|consent|personal data|legitimate interest)\b/i.test(t) && /\b(accept|reject|agree|allow|decline|preferences|settings|manage|choices|necessary|ok|got it)\b/i.test(t)))) cat = 'consent';
      else if (!central.has(o) && !CMP.test(IDOF(o) + ' ' + CLSOF(o))) continue;   // a fixed side column is chrome, not a pop-up
      else if (PROMO_TXT.test(t) && t.length < 2500) cat = NEWSLETTER_TXT.test(t) || QS(o, 'input[type=email]') ? 'newsletter' : 'popup';
      else if (SIGNIN_TXT.test(t) && t.length < 600 && !CLOSEST(o, 'header,nav,[role=banner],[role=navigation]')) cat = 'popup';
      // R6: a bar or box over the page that only leads to signing in or up ("See NASA's full profile · Continue to X")
      else if (t.length < 400 && QS(o, 'a[href*="login" i],a[href*="signup" i],a[href*="sign-up" i],a[href*="sign_up" i],a[href*="onboarding" i],a[href*="register" i],a[href*="/i/flow/" i]') &&
               !CLOSEST(o, 'header,nav,[role=banner],[role=navigation]') && !QS(o, 'input[type=search],[role=search]')) cat = 'popup';
      else if (!t && (!hasMedia || LNOF(o) === 'iframe' && CMP_FRAME.test(o.src || ''))) cat = 'overlay';
      else if (LNOF(o) === 'iframe' || (!t && hasMedia && QS(o, 'iframe') && !QS(o, 'video'))) {
        const src = (LNOF(o) === 'iframe' ? o : QS(o, 'iframe')).src || '';
        if (!PLAYER_IFRAME.test(src)) cat = 'popup';  // a marketing iframe laid over the page (attentive, klaviyo)
      }
      if (!cat) continue;
      if (cat === 'consent') S.consent.push(consentInfo(o));
      if (S.junk.has(o)) S.junk.set(o, cat); else mark(o, cat, 'heur');
    }
    lap('overlay_classify');
    // consent banners found by the Cookie List are settled the same way
    for (const [el, c] of [...S.junk]) {
      if (c !== 'consent' || S.consent.some((x) => x.el === el) || !vis(el)) continue;
      const t = (el.innerText || '').trim();
      if (t && (NOT_COOKIE_CTX.test(t) || !COOKIE_WORDS.test(t) || MATCHES(el, '[role=alert],[role=alertdialog]'))) { S.junk.delete(el); continue; }   // not a cookie banner: it stays
      S.consent.push(consentInfo(el));
    }
    // alerts are never dropped, by any rule
    for (const [el] of [...S.junk]) if (MATCHES(el, '[role=alert],[role=alertdialog]') || (S.junk.get(el) !== 'ad' && QS(el, '[role=alert],[role=alertdialog]'))) S.junk.delete(el);
    // inline newsletter boxes, app-install promos, fundraising appeals and sign-in upsells (small boxes only)
    for (const inp of QSA(document, 'input[type=email],input[name*=email i],input[placeholder*=email i],input[autocomplete=email]')) {
      if (!vis(inp)) continue;
      let c = inp;
      for (let i = 0; i < 7 && c.parentElement && c.parentElement !== body; i++) {
        const p = c.parentElement;
        if (protectedEl(p) || (p.innerText || '').length > 700) break;
        c = p;
      }
      const t = c.innerText || '';
      if (c !== inp && PROMO_TXT.test(t) && !QS(document, 'input[type=password]')) mark(c, 'newsletter', 'heur');
    }
    for (const a of QSA(document, 'a[href*="apps.apple.com"],a[href*="itunes.apple.com"],a[href*="play.google.com/store"]')) {
      let c = a;
      for (let i = 0; i < 5 && c.parentElement && c.parentElement !== body; i++) {
        const p = c.parentElement;
        if (protectedEl(p) || (p.innerText || '').length > 400) break;
        c = p;
      }
      if (/\bapp\b/i.test(c.innerText || '') && !CLOSEST(c, 'footer,[role=contentinfo]')) mark(c, 'popup', 'heur');
    }
    lap('overlay_inline');
    for (const el of QSA(document, 'aside,section,div[class*=epic i],div[class*=banner i],div[class*=promo i],div[class*=upsell i],div[class*=cta i],div[class*=signup i],div[class*=sign-up i],div[class*=paywall i],div[class*=subscribe i],[data-testid*=signup i],[data-testid*=upsell i],[data-testid*=epic i],[data-testid*=contributions i],gu-island')) {
      if (S.junk.has(el)) continue;
      const tc = el.textContent || '';
      if (tc.length > 6000 || !(/support|contribut|donate|member|subscri|unlock|newsletter|sign|log ?in|account|join|continue with|don['’]t miss/i.test(tc))) continue;
      if (protectedEl(el) || !vis(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 1500) continue;
      const ctrls = QSA(el, 'a[href],button,[role=button]');
      if (!ctrls.length) continue;
      // (round 5: and a fundraiser's ask in the feed with its amounts to pick, the Guardian's "Support once from just $1":
      // its words and its choices both, so a story about a fundraiser stays)
      const ask = /\bfundrais(er|ing)\b|support (once|monthly|annually)|help(ing)? (to )?fund (the guardian|us|our)/i.test(t) &&
        (QSA(el, 'input[type=radio],[role=radio]').length >= 2 || /\b(support|give|donate) (once|monthly|annually)\b|\b(once|monthly|annually|a month|per month) from (just )?[$£€]/i.test(t));
      if (ask || /support (the guardian|us|our journalism|independent)|make a contribution|donate|become a (member|supporter)|subscribe (now|today|for)|unlock (unlimited|full|this)|already a subscriber|sign up for .{0,40}newsletter/i.test(t)) mark(el, NEWSLETTER_TXT.test(t) ? 'newsletter' : 'popup', 'heur');
      else if (SIGNIN_TXT.test(t) && t.length < 500 && /new to |don['’]t miss|create (an |a |your )?account|sign up|join .{1,20} today|continue with/i.test(t) &&
               !CLOSEST(el, 'header,nav,[role=banner],[role=navigation],form') && !QS(el, 'input[type=password]')) mark(el, 'popup', 'heur');
    }
    lap('overlay_promo');
    S.stats.t_overlay = Math.round(performance.now() - t0);
    // ------------------------------------------------ 3b. share rows (a row of share targets; a lone Share button stays)
    const SHARE_HREF = /facebook\.com\/(sharer|share\.php|dialog\/share)|twitter\.com\/(intent|share)|x\.com\/intent|linkedin\.com\/(share|sharing|shareArticle)|pinterest\.[a-z.]+\/pin\/create|reddit\.com\/submit|^whatsapp:|wa\.me\/|api\.whatsapp|^mailto:\?|t\.me\/share|bsky\.app\/intent|threads\.net\/intent|flipboard\.com\/bookmarklet/i;
    const SHARE_NAME = /^(share( on| to| via| with| this| article| story| page)?\b.{0,30}|copy (the )?link|tweet|post to .{1,20}|email( this| article)?|(share|send) (by|via) e-?mail)$/i;
    const shareCtl = (e) => SHARE_HREF.test(ATTR(e, 'href') || '') || SHARE_NAME.test((ATTR(e, 'aria-label') || ATTR(e, 'title') || e.textContent || '').replace(/\s+/g, ' ').trim());
    const rows = new Set();
    for (const e of QSA(body, 'a[href],button,[role=button]')) {
      if (!shareCtl(e)) continue;
      let c = e;
      for (let i = 0; i < 5 && c.parentElement && c.parentElement !== body; i++) {
        c = c.parentElement;
        const ctl = QSA(c, 'a[href],button,[role=button]');
        if (ctl.length > 10 || (c.textContent || '').replace(/\s+/g, ' ').trim().length > 220) break;
        const sh = Array.from(ctl).filter(shareCtl).length;
        if (sh >= 2 && sh >= 0.5 * ctl.length) { rows.add(c); }
      }
      if (SHARE_HREF.test(ATTR(e, 'href') || '') && !S.junk.has(e)) S.junk.set(e, 'share');
    }
    for (const c of rows) { let inner = false; for (const o of rows) if (o !== c && CONTAINS(c, o) === false && CONTAINS(o, c)) inner = true; if (!inner && !protectedEl(c) && !S.junk.has(c)) S.junk.set(c, 'share'); }
    lap('share');
    S.stats.t_share = Math.round(performance.now() - t0);
    // ------------------------------------------------ 3c. R19: Shorts shelves and vertical short-video rows
    for (const el of QSA(body, 'ytd-reel-shelf-renderer,ytd-rich-shelf-renderer[is-shorts],[is-shorts],grid-shelf-view-model,ytm-shorts-lockup-view-model')) {
      if (!S.junk.has(el) && !protectedEl(el)) S.junk.set(el, 'shorts');
    }
    for (const el of QSA(body, 'ul,ol,div,section')) {
      if (el.childElementCount < 3 || S.junk.has(el)) continue;
      // a row whose items are mostly Shorts (each item links to /shorts/), not a column that merely holds a Shorts shelf
      const kids = Array.from(el.children);
      const sh = kids.filter((c) => MATCHES(c, 'a[href*="/shorts/"]') || QS(c, 'a[href*="/shorts/"]')).length;
      if (sh >= 3 && sh >= 0.6 * kids.length && !protectedEl(el)) S.junk.set(el, 'shorts');
    }
    // ------------------------------------------------ 4. recirculation: sponsored -> dropped, the site's own -> collapsed
    const recircOf = (h) => {
      let c = h.parentElement;
      for (let i = 0; i < 4 && c && c.parentElement && c.parentElement !== body; i++) {
        if ((c.innerText || '').length > (h.innerText || '').length + 60 && QSA(c, 'a[href]').length >= 2) break;
        c = c.parentElement;
      }
      return c;
    };
    // round 4: and a list's own label line, an item of words with no link ("Searches related to …", "Was this
    // helpful?" with its two buttons: an engine's)
    for (const h of QSA(body, 'h2,h3,h4,h5,[role=heading],li,p')) {
      if ((LNOF(h) === 'li' || LNOF(h) === 'p') && ((h.textContent || '').length > 80 || QS(h, 'a[href]'))) continue;
      const t = (h.textContent || '').replace(/[\s\u200b]+/g, ' ').trim();
      // R59: a feedback box ("Was this page helpful?", "Help improve MDN") drops, uncounted
      if (t && t.length <= 60 && FEEDBACK_HEAD.test(t)) {
        // a feedback line that is a list item or a paragraph of its own is the box itself
        const c = LNOF(h) === 'li' || LNOF(h) === 'p' ? h : recircOf(h);
        if (c && !protectedEl(c) && (c.textContent || '').length < 1500) S.junk.set(c, 'feedback');
        continue;
      }
      if (!t || t.length > 60 || !RECIRC_HEAD.test(t)) continue;
      if (root && CONTAINS(root, h) && !/sponsor|promot|partner|around the web/i.test(t)) {
        // inside the article: only a short box of links counts
        const c0 = recircOf(h);
        if (!c0 || (c0.innerText || '').length > 1500) continue;
      }
      const c = recircOf(h);
      if (!c || protectedEl(c) || (c.innerText || '').length > 6000) continue;
      if (RECIRC_SPONSORED.test(t)) mark(c, 'ad', 'heur');
      else if (!S.junk.has(c)) { S.junk.set(c, RELATED_HEAD.test(t) ? 'related' : 'recirc'); S.relatedName.set(c, t); }
    }
    for (const el of all) {
      if (!(IDOF(el) || CLISTOF(el).length) || S.junk.has(el)) continue;
      const nm = (IDOF(el) || '') + ' ' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : '');
      if (RECIRC_CLS.test(nm) && !protectedEl(el)) {
        const n = (el.textContent || '').length;   // the text's size without a layout pass
        if (n < 6000 && QSA(el, 'a[href]').length >= 2 && !(root && CONTAINS(root, el) && n > 1500)) S.junk.set(el, /related/i.test(nm) ? 'related' : 'recirc');
      }
    }
    lap('recirc');
    S.stats.t_recirc = Math.round(performance.now() - t0);
    // ------------------------------------------------ 5. the site's chrome -> one collapsed bar
    const inRoot = (el) => root && CONTAINS(root, el);
    // round 3: a page's own display settings (Wikipedia's Appearance: text size, width, colour; a docs site's theme
    // switch) are the view's to decide: the panel drops, and is never Filters. Only radios whose every label is a
    // setting, with one that no size picker has (Standard, Wide, Automatic, Light, Dark...), in a box named for it or
    // beside another such group: a shop's Small / Medium / Large stays.
    {
      const SET = /^(small|smaller|standard|normal|default|medium|large|larger|wide|full width|full|narrow|automatic|auto|system|os default|light|dark|sepia|compact|comfortable|enabled|disabled|on|off)$/i;
      const DISPLAY = /^(standard|normal|default|wide|full width|narrow|automatic|auto|system|os default|light|dark|sepia|compact|comfortable)$/i;
      const NAMED = /appearance|theme|display|settings|preferences|client-pref|font-size|text-size|reading/i;
      const labelOf = (i) => { const l = i.labels && i.labels[0]; return ((l && l.innerText) || ATTR(i, 'aria-label') || ATTR(i, 'title') || '').replace(/\s+/g, ' ').trim(); };
      const groups = new Map();
      for (const i of Array.from(QSA(body, 'input[type=radio]')).slice(0, 400)) {
        const n = ATTR(i, 'name') || '';
        if (!n) continue;
        const g = groups.get(n); if (g) g.push(i); else groups.set(n, [i]);
      }
      const boxes = [];
      for (const [, g] of groups) {
        if (g.length < 2 || g.length > 6) continue;
        const labels = g.map(labelOf);
        if (!labels.every((t) => SET.test(t)) || !labels.some((t) => DISPLAY.test(t))) continue;
        let a = g[0].parentElement;
        while (a && a !== body && !g.every((i) => CONTAINS(a, i))) a = a.parentElement;
        if (a && a !== body) boxes.push(a);
      }
      const named = (e) => { for (let p = e, i = 0; p && p !== body && i < 6; p = p.parentElement, i++) if (NAMED.test((IDOF(p) || '') + ' ' + (typeof CLSOF(p) === 'string' ? CLSOF(p) : '') + ' ' + (ATTR(p, 'aria-label') || ''))) return true; return false; };
      if (boxes.length) {
        let panel = boxes[0];
        while (panel && panel !== body && !boxes.every((b) => CONTAINS(panel, b))) panel = panel.parentElement;
        const whole = panel && panel !== body && (panel.textContent || '').length < 1500 && !protectedEl(panel) && !inRoot(panel);
        for (const b of whole ? [panel] : boxes) {
          if (S.junk.has(b) || protectedEl(b) || (b.textContent || '').length >= 1500 || !(boxes.length >= 2 || named(b))) continue;
          S.junk.set(b, 'settings'); S.stats.heur++;
        }
      }
    }
    // round 4: a narrow, tall column at the side of the page that holds neither its title nor pictured links (results)
    const sideColumn = (el) => {
      const r = RECT(el);
      return r.width >= 120 && r.width <= 0.32 * VW && r.height >= 300 && (r.left < 0.3 * VW || r.right > 0.7 * VW) && !QS(el, 'h1') &&
        QSA(el, 'a[href] img').length < 3;
    };
    const chromeKind = (el) => {
      const ln = LNOF(el), r = ATTR(el, 'role') || '';
      const lab = ((ATTR(el, 'aria-label') || '') + ' ' + (IDOF(el) || '') + ' ' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : '')).toLowerCase()
        // round 3: a utility class for CSS filters (Tailwind's filter, backdrop-filter) names no filters
        .split(/\s+/).filter((t) => !/^([a-z-]+:)*(backdrop-)?filter(-none)?$/.test(t)).join(' ');
      if (/breadcrumb/.test(lab)) return null;                                     // kept inline as a path
      if (/pagination|pager|page-numbers|pages/.test(lab)) return null;           // kept inline: Next and page numbers
      if (/(^|[\s_-])(toc|table-of-contents|tableofcontents)([\s_-]|$)|contents|on this page|in this article/.test(lab) && (ln === 'nav' || r === 'navigation' || /toc/.test(lab))) return 'toc';
      if (/filter|refine|refinement|facet|sort-by|sortby/.test(lab)) return 'filters';
      if (ln === 'nav' || r === 'navigation' || r === 'menubar' || (r === 'menu' && !inRoot(el))) return 'nav';
      if ((ln === 'header' || r === 'banner') && !CLOSEST(el, 'article,[role=article],main,[role=main]') && !inRoot(el)) return 'header';
      if ((ln === 'footer' || r === 'contentinfo') && !CLOSEST(el, 'article,[role=article]') && !inRoot(el)) return 'footer';
      // a site footer or header known only by its id or class ("navFooter", "site-header", "masthead")
      if (!CLOSEST(el, 'article,[role=article],main,[role=main]') && !inRoot(el)) {
        const toks = new Set(tokensOf((IDOF(el) || '') + ' ' + (typeof CLSOF(el) === 'string' ? CLSOF(el) : '')));
        const rr = RECT(el);
        if (toks.has('footer') && rr.top + scrollY > 0.5 * document.documentElement.scrollHeight) return 'footer';
        if ((toks.has('header') || toks.has('masthead') || toks.has('navbar')) && rr.top + scrollY < 300 && rr.height < 400) return 'header';
      }
      return null;
    };
    for (const el of QSA(body, 'nav,[role=navigation],[role=menubar],[role=menu],header,[role=banner],footer,[role=contentinfo],[class*=filter i],[class*=refine i],[id*=refine i],[id*=filter i],[class*=facet i],[aria-label*=filter i],[id*=toc i],[class*=toc i],[id*=footer i],[class*=footer i],[id*=header i],[class*=masthead i],[id*=masthead i],[class*=navbar i],[id*=navbar i]')) {
      if (S.chrome.has(el) || S.junk.has(el) || protectedEl(el)) continue;
      let inside = false;   // already inside a region taken as chrome (document order: the outer one came first)
      for (let p = el.parentElement; p && p !== body; p = p.parentElement) if (S.chrome.has(p)) { inside = true; break; }
      if (inside) continue;
      let k = chromeKind(el);
      if (k === 'filters' && !QS(el, 'input[type=checkbox],input[type=radio],a[href],button,select')) k = null;
      // a page-wide box with "filter" in its class is no filter rail; a long rail at the side is one (Amazon's has 50
      // groups of refinements, well past 6000 characters)
      if (k === 'filters' && (el.textContent || '').length > 6000 && !sideColumn(el)) k = null;
      // a list's own state switch with its counts ("Open 1,024 · Closed 9,876") stays with the list: it says what the list is
      if (k === 'filters') {
        const ctl = QSA(el, 'a[href],button,[role=tab]');
        if (ctl.length >= 2 && ctl.length <= 4 && !QS(el, 'input,select') && Array.from(ctl).every((c) => /\d/.test(c.textContent || ''))) k = null;
      }
      if (!k) continue;
      // pagination inside a nav: keep it inline
      const links = QSA(el, 'a[href]');
      if (k === 'nav' && links.length && links.length <= 14 && Array.from(links).filter((a) => /^\s*(\d+|next|previous|prev|older|newer|›|»|‹|«|more)\s*$/i.test(a.textContent)).length >= Math.max(2, links.length * 0.6)) continue;
      S.chrome.set(el, k);
    }
    // a shop's filter rail known only by its shape (Best Buy's, Target's): a narrow column at the side, tall, of
    // checkboxes and collapsible headings, holding neither the page's title nor its results. It folds into Filters.
    {
      const seen = new Set();
      const CTL = 'input[type=checkbox],input[type=radio],[role=checkbox],button[aria-expanded],[role=button][aria-expanded]';
      const ctl = QSA(body, CTL);
      for (const c of Array.from(ctl).slice(0, 600)) {
        let rail = null;
        for (let a = c.parentElement, i = 0; a && a !== body && i < 14; a = a.parentElement, i++) {
          if (seen.has(a)) { rail = null; break; }
          const r = RECT(a);
          if (r.width > 0.32 * VW) break;
          if (r.width >= 160 && r.height >= 300 && (r.left < 0.3 * VW || r.right > 0.7 * VW)) rail = a;
        }
        if (!rail) continue;
        seen.add(rail);
        if (S.chrome.has(rail) || S.junk.has(rail) || protectedEl(rail) || inRoot(rail)) continue;
        let inside = false;
        for (let p = rail.parentElement; p && p !== body; p = p.parentElement) if (S.chrome.has(p) || S.junk.has(p)) { inside = true; break; }
        if (inside || QS(rail, 'h1') || QSA(rail, CTL).length < 4) continue;
        // round 3: a column of the page's own section links, with their Toggle buttons, is its Contents, not Filters
        const own = Array.from(QSA(rail, 'a[href]'));
        if (own.length >= 3 && own.filter((a) => a.hash && a.pathname === location.pathname && a.hostname === location.hostname).length >= 0.6 * own.length) {
          S.chrome.set(rail, 'toc');
          continue;
        }
        // never the results: a column of product or story links with pictures is the content, not its filters
        if (QSA(rail, 'a[href] img').length >= 3 || ((rail.textContent || '').length > 6000 && !sideColumn(rail))) continue;
        S.chrome.set(rail, 'filters');
      }
    }
    // a search form at the top of the page (outside the content) and narrow sidebars are chrome too
    lap('chrome_landmarks');
    // round 4: a list in the page's flow of nothing but its own section links (react.dev's "Reference · Usage ·
    // Troubleshooting" at the top of a page), six or more, is its Contents too
    for (const el of QSA(body, 'ul,ol')) {
      if (S.chrome.has(el) || S.junk.has(el) || protectedEl(el) || (el.parentElement && CLOSEST(el.parentElement, 'ul,ol,nav,[role=navigation]'))) continue;
      const links = Array.from(QSA(el, 'a[href]'));
      if (links.length < 6 || links.length > 200) continue;
      const own = links.filter((a) => { const h = ATTR(a, 'href') || ''; return h.startsWith('#') && h.length > 1; }).length;
      let lt = 0; for (const a of links) lt += (a.textContent || '').replace(/\s+/g, '').length;
      if (own >= 0.9 * links.length && lt >= 0.8 * (el.textContent || '').replace(/\s+/g, '').length && vis(el)) S.chrome.set(el, 'toc');
    }
    // a topic's scrubber (a forum's "1 / 33 · 2d ago" timeline in a narrow side column) is navigation in the page
    for (const el of QSA(body, '[class*=timeline i]')) {
      if (S.chrome.has(el) || S.junk.has(el) || protectedEl(el)) continue;
      if (!tokensOf(typeof CLSOF(el) === 'string' ? CLSOF(el) : '').some((t) => /timeline/.test(t))) continue;
      const r = RECT(el);
      if (r.width < 40 || r.width > 0.3 * VW || !/\b\d+\s*\/\s*\d+\b/.test(el.textContent || '')) continue;
      S.chrome.set(el, 'toc');
    }
    for (const f of QSA(body, 'form,[role=search],[id*=searchform i],[class*=searchform i],[class*=search-bar i]')) {
      if (S.chrome.has(f) || S.junk.has(f) || protectedEl(f) || inRoot(f) || [...S.chrome.keys()].some((c) => CONTAINS(c, f))) continue;
      const r = RECT(f);
      if (r.top + scrollY < 220 && r.height < 300 && QS(f, 'input:not([type=hidden]),textarea')) S.chrome.set(f, 'header');
    }
    // chrome regions' ancestors and the test for "inside one", once (no per-element pass over every region)
    const chromeAnc = new Set();
    const ancUp = (c) => { for (let p = c.parentElement; p && p !== body; p = p.parentElement) { if (chromeAnc.has(p)) break; chromeAnc.add(p); } };
    for (const c of S.chrome.keys()) ancUp(c);
    const inChromeEl = (el) => { for (let p = el; p && p !== body; p = p.parentElement) if (S.chrome.has(p)) return true; return false; };
    for (const el of QSA(body, '[class*=sidebar i],[id*=sidebar i],[class*=side-bar i]')) {
      if (S.chrome.has(el) || S.junk.has(el) || protectedEl(el) || inRoot(el) || chromeAnc.has(el) || inChromeEl(el)) continue;
      const r = RECT(el);
      if (r.width > 40 && r.width <= 0.35 * VW && r.height >= 200 && QSA(el, 'a[href]').length >= 3 && !QS(el, 'h1')) { S.chrome.set(el, 'nav'); ancUp(el); }
    }
    // skip links ("Skip to main content") are dropped; link farms outside the content go to the menu
    lap('chrome_search_side');
    for (const a of QSA(body, 'a[href^="#"],a[href*="#"]')) {
      if (/^\s*(skip|jump) (to|navigation)|^\s*skip (to )?(main )?content|^\s*back to top\s*$|^\s*accessibility (help|links)\s*$/i.test(a.textContent || ATTR(a, 'aria-label') || '')) S.skipLinks.add(a);
    }
    for (const el of QSA(body, 'ul,ol,div,section,aside')) {
      if (el.childElementCount < 3 || BYTAG(el, 'a').length < 12) continue;
      if (S.chrome.has(el) || S.junk.has(el) || inRoot(el) || protectedEl(el)) continue;
      if (CLOSEST(el, 'nav,[role=navigation],header,footer,[role=banner],[role=contentinfo]')) continue;
      if (CLOSEST(el, 'main,[role=main],table,[role=grid],[role=table]')) continue;   // a file list or a results table is content
      if (chromeAnc.has(el) || inChromeEl(el)) continue;   // a column that holds the filters (or sits in a region already collapsed)
      const links = QSA(el, 'a[href]');
      if (links.length < 12) continue;
      let lt = 0;
      for (const a of links) lt += (a.textContent || '').replace(/\s+/g, ' ').trim().length;
      const tt = (el.textContent || '').replace(/\s+/g, ' ').trim().length || 1;
      if (lt / tt >= 0.7 && lt / links.length < 26 && !QS(el, 'h1') && !QS(el, 'img[width],picture') && vis(el)) {
        // skip if this is a parent of an already marked farm (the inner one is enough)
        S.chrome.set(el, 'links'); ancUp(el);
      }
    }
    lap('chrome_farms');
    S.stats.t_chrome = Math.round(performance.now() - t0);
    // ------------------------------------------------ 6. video: players become islands
    findIslands(S);
    lap('islands');
    S.stats.t_islands = Math.round(performance.now() - t0);
    // ------------------------------------------------ 7. repeated items become cards
    // ------------------------------------------------ 7b. social posts (R69): an article with an engagement row
    // ("123 replies, 226 reposts, 1130 likes") and an author link, two or more on the page, is a post card
    S.posts = new Set();
    {
      const cands = [];
      for (const a of QSA(body, 'article,[role=article]')) {
        if (S.posts.has(a) || upHasPost(a, cands)) continue;
        const g = Array.from(QSA(a, '[role=group]')).find((x) => POST_COUNTS.test(ATTR(x, 'aria-label') || ''));
        if (g && vis(a) && !protectedEl(a)) cands.push(a);
      }
      if (cands.length >= 2) for (const a of cands) S.posts.add(a);
    }
    findCards(S);
    lap('cards');
    S.stats.t_cards = Math.round(performance.now() - t0);
    // ------------------------------------------------ 8. comment nesting
    for (const el of QSA(body, '[depth],[data-depth],td.ind[indent],[aria-level][role=comment],[aria-level][role=article],[aria-level][role=treeitem],[data-comment-depth]')) {
      // 1 = a top-level comment, 2 = a reply...: zero-based attributes (depth, indent) count from 0, aria-level from 1
      const lvl = ATTR(el, 'aria-level');
      const d = lvl ? +lvl : +(ATTR(el, 'depth') || ATTR(el, 'data-depth') || ATTR(el, 'indent') || ATTR(el, 'data-comment-depth') || 0) + 1;
      if (LNOF(el) === 'td') { const tr = CLOSEST(el, 'tr'); if (tr) S.depth.set(tr, Math.min(d, 12)); continue; }
      if (d > 0) S.depth.set(el, Math.min(d, 12));
    }
    lap('depth');
    if (!S.challenge) {
      if (/just a moment|attention required|verify you are human|checking your browser/i.test(document.title) ||
          QS(document, '#challenge-form,#cf-challenge-running,.cf-turnstile,#turnstile-wrapper,[name="cf-turnstile-response"]')) S.challenge = 'cloudflare';
    }
    // a person check, sign-in or payment page opens as the real page (the Browser says why in one line)
    const CHECK_WORDS = /(verify (that )?you('| a)re (a )?human|verify you are a person|are you a (robot|human)|not a robot|unusual traffic|checking (if the site connection is secure|your browser)|press (&|and) hold|confirm (that )?you('|’)re (a human|not a bot)|enable javascript and cookies to continue|pardon our interruption|request (was )?blocked|access (to this page has been )?denied)/i;
    if (!S.challenge && bodyText < 2500 && CHECK_WORDS.test(document.title + ' ' + (body.innerText || '').slice(0, 2500))) S.challenge = 'person-check';
    // round 4: a bot check drawn over a page's own footer and sign-up (a store's "Press & hold" box over its error page):
    // its box, or its frame, in the middle of the screen
    if (!S.challenge) {
      const boxes = Array.from(QSA(document, '[id^=px-captcha],[class*=captcha i],[id*=captcha i],' + DIALOG_SEL)).slice(0, 40);
      for (const b of boxes) {
        if (!vis(b)) continue;
        const r = RECT(b);
        if (r.width < 150 || r.height < 50 || r.bottom < 0 || r.top > VH) continue;
        const words = (b.innerText || '').slice(0, 800);
        const own = Array.from(BYTAG(b, 'iframe')).some((f) => /px-cdn\.net|px-cloud\.net|perimeterx/i.test(f.src || ''));
        if ((words.length < 800 && CHECK_WORDS.test(words)) || own || /^px-captcha/.test(IDOF(b) || '')) { S.challenge = 'person-check'; break; }
      }
    }
    if (!S.challenge) {
      const pw = Array.from(QSA(document, 'input[type=password]')).some(vis);
      const card = Array.from(QSA(document, 'input[autocomplete^="cc-"],input[name*=cardnumber i],input[id*=cardnumber i]')).some(vis) ||
        Array.from(BYTAG(document, 'iframe')).some((f) => /js\.stripe\.com|checkout\.stripe\.com|paypal\.com\/(sdk|checkoutnow)|braintree|adyen|squareup|klarna/i.test(f.src || '') && vis(f) && area(RECT(f)) > 3000);
      if (card || /^(checkout|pay|payments?|secure)\./i.test(location.hostname) || /\/(checkout|payment)(\/|$)/i.test(location.pathname)) S.challenge = 'payment';
      else if (pw) S.challenge = 'signin';
    }
    // a small app (a to-do list, a converter): a text field of its own, outside any form or search, drives it and there
    // is little to read; it works better as the real page
    if (!S.challenge) {
      const appIn = Array.from(QSA(document, 'input:not([type]),input[type=text],textarea,[contenteditable=""],[contenteditable=true]')).find((i) =>
        !CLOSEST(i, 'form,[role=search],search') && !/search|^q$/i.test((ATTR(i, 'name') || '') + ' ' + (ATTR(i, 'role') || '')) &&
        !/search/i.test((ATTR(i, 'placeholder') || '') + ' ' + (ATTR(i, 'aria-label') || '')) && vis(i) && RECT(i).width >= 200);
      if (appIn) {
        let prose = 0;
        for (const p of QSA(body, 'p,li,dd,blockquote')) { const n = (p.textContent || '').trim().length; if (n >= 60 && !CONTAINS(p, appIn) && vis(p)) prose += n; if (prose >= 600) break; }
        if (prose < 600) S.app = true;
      }
    }
    lap('challenge_app');
    try { S.structured = ldObjects(); } catch (e) { S.structured = []; }
    // comment sections known only by their heading ("Comments", "60 Comments"): the box that holds the heading and the list
    S.commentSections = new Set();
    for (const h of QSA(body, 'h2,h3,h4,[role=heading]')) {
      if (!/^\s*(\d[\d,.]*\s+)?comments?(\s*\(\d[\d,.]*\))?\s*$/i.test(h.textContent || '')) continue;
      let c = h.parentElement;
      for (let i = 0; i < 6 && c && c !== body; i++) {
        if (c.childElementCount >= 2 && (c.textContent || '').length > (h.textContent || '').length + 200) break;
        c = c.parentElement;
      }
      if (c && c !== body && !protectedEl(c)) S.commentSections.add(c);
    }
    lap('ld_comments');
    // ------------------------------------------------ 9. walls: what the real page shows this member
    try { S.wall = wallScan(S, overlays, root, protectedEl); } catch (e) { S.wall = null; }
    lap('walls');
    S.stats.ms = Math.round((performance.now() - t0) * 10) / 10;
    return S;
  }

  // a box that holds a content-sized video is a player (its pre-roll "Advertisement" label doesn't make it an ad)
  const SITE_BANNER = /(^|[\s_-])(topnews|top-news|site-?alert|sitewide(-alert)?|announcement(-bar)?|alert-?banner|emergency(-alert)?|national-?(alert|news))($|[\s_-])/i;
  const POST_COUNTS = /\b\d[\d.,]*[KkMm]? (replies|reply|reposts?|retweets?|likes?|comments?|shares?|views?)\b/;
  function upHasPost(el, list) { for (const x of list) if (CONTAINS(x, el)) return true; return false; }
  // R69: a post card: the author line (name, handle, age linking to the post), its own text with links and mentions,
  // its first photo, then one row of counts (replies, reposts, likes, views); never titled by a link or a control
  function postCard(a, ctx) {
    const links = Array.from(QSA(a, 'a[href]'));
    const named = links.filter((l) => (l.textContent || '').trim());
    const status = links.find((l) => /\/(status|statuses|posts?|p)\/[\w-]+/.test(ATTR(l, 'href') || '') && (l.textContent || '').trim().length <= 12);
    const name = named.find((l) => !/^@/.test(l.textContent.trim()) && l !== status);
    const handle = named.find((l) => /^@\w/.test(l.textContent.trim()));
    const c = [];
    // the author's name links to their profile, except on that profile itself (a link to this page says nothing)
    const here = (() => { try { const u = new URL(name ? name.href : '', location.href); return u.hostname === location.hostname && u.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, ''); } catch (e) { return false; } })();
    if (name) c.push(here ? ['b', clip(name.textContent.trim(), 60)] : ['a', ref(name), safeHref(name.href), clip(name.textContent.trim(), 60)]);
    if (handle) c.push(' ' + clip(handle.textContent.trim(), 40));
    if (status) c.push(' · ', ['a', ref(status), safeHref(status.href), clip(status.textContent.trim(), 20)]);
    // the text: the language-marked box, else the largest box of words outside the author line and the counts
    let tx = QS(a, '[lang]:not(html)');
    if (!tx) { let best = 0; for (const e of QSA(a, 'div,p,span')) { const n = (e.textContent || '').trim().length; if (n > best && n <= 1200 && !QS(e, '[role=group]') && !(name && CONTAINS(e, name))) { best = n; tx = e; } } }
    if (tx) { const g = newCtx(ctx.live, ctx.sh); g.inChrome = false; walk(tx, g); flush(g); const runs = g.blocks.flatMap((b, i) => (i ? [['br']] : []).concat(b.c || [])); if (runs.length) c.push(['br'], ...runs); }
    const inIsland = (i) => SCAN && SCAN.islands.some((c) => CONTAINS(a, c.box) && CONTAINS(c.box, i));
    const im = Array.from(QSA(a, 'img')).find((i) => RECT(i).width >= 120 && !inIsland(i));
    if (im) { const s = imgSrc(im, im); if (s) c.push(['br'], ['a', status ? ref(status) : ref(a), status ? safeHref(status.href) : '', ['img', s, clip(ATTR(im, 'alt') || '', 120), ...imgDims(im, im)]]); }
    const g = Array.from(QSA(a, '[role=group]')).find((x) => POST_COUNTS.test(ATTR(x, 'aria-label') || ''));
    if (g) { const counts = (ATTR(g, 'aria-label') || '').split(/,\s*/).filter((x) => !/bookmark/i.test(x)).join(' · '); if (counts) c.push(['br'], counts); }
    return { k: 'card', lay: 'post', g: 'posts', title: name ? clip(name.textContent.trim(), 60) : '', c };
  }
  // R55: a live demo's own title and its Run and Reset, from the boxes around its editor (MDN's sit in the shadow
  // roots of interactive-example and mdn-button: the button's name is its host's text)
  function demoBar(T) {
    let node = T;
    for (let i = 0; i < 4 && node; i++) {
      const root = node.getRootNode && node.getRootNode();
      if (!root) break;
      const scope = root === document ? (CLOSEST(T, 'section,article,figure,div') || document) : root;
      const ctl = Array.from(QSA(scope, 'button,[role=button],mdn-button,input[type=button]'));
      const nm = (b) => (b.textContent || b.value || ATTR(b, 'aria-label') || '').replace(/\s+/g, ' ').trim();
      const run = ctl.find((b) => /^run( code)?$/i.test(nm(b)));
      if (run) {
        const reset = ctl.find((b) => /^reset( code)?$/i.test(nm(b)));
        const inner = (b) => (b.shadowRoot && QS(b.shadowRoot, 'button')) || b;
        const host = root === document ? null : root.host;
        const hd = QS(scope, 'header h4,header h3,header h2,h4,h3');
        const title = clip(((host && ATTR(host, 'name')) || (hd && hd.textContent) || '').replace(/\s+/g, ' ').trim(), 120);
        const bar = [['btn', ref(inner(run)), 'Run', 0]];
        if (reset) bar.push(['btn', ref(inner(reset)), 'Reset', 0]);
        return { title, bar };
      }
      if (root === document) break;
      node = root.host;
    }
    return null;
  }
  function bigVideo(el) { for (const v of BYTAG(el, 'video')) if (RECT(v).width >= 400) return true; return false; }
  // a row or carousel whose every item is an ad ("Shop desk lamp by type", a search engine's shopping ads): the whole
  // widget drops, with its heading and its own controls ("More Products", "Was this helpful?"), as far up as its box
  // holds little else
  function dropAdWidget(S, L) {
    let w = L;
    const lt = (L.textContent || '').length;
    for (let p = L.parentElement, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) {
      if ((S.prot && S.prot(p)) || (p.textContent || '').length - lt > 200) break;
      w = p;
    }
    if (!S.junk.has(w)) { S.junk.set(w, 'sponsored'); S.stats.heur++; }
  }
  // the item a "Sponsored" label belongs to: a repeated sibling (a card, a result) or a modest box
  function itemOf(label, protectedEl) {
    let c = label;
    for (let i = 0; i < 12 && c.parentElement && c.parentElement !== document.body; i++) {
      const p = c.parentElement;
      if (protectedEl(p)) return null;
      // c is one of several similar siblings -> c is the item
      const sibs = Array.from(p.children).filter((s) => LNOF(s) === LNOF(c));
      if (sibs.length >= 3 && i >= 1) {
        const r = RECT(c);
        if (r.width >= 120 && r.height >= 40 && (c.innerText || '').length < 2500) return c;
      }
      if ((p.innerText || '').length > 2500) break;
      c = p;
    }
    const r = RECT(c);
    return r.width >= 150 && r.height >= 60 && (c.innerText || '').length < 1500 && c !== label ? c : null;
  }

  function consentInfo(el) {
    // a clearly offered "reject all" or "necessary only" choice, for the server to press with trusted input
    let rej = null;
    const box = positioned(el), br = box && RECT(box);
    const small = br && br.width * br.height < 0.5 * innerWidth * innerHeight;
    const btns = Array.from(QSA(el, 'button,a[href],[role=button],input[type=button],input[type=submit]'));
    const label = (b) => clip(b.innerText || b.value || ATTR(b, 'aria-label') || '', 80).replace(/[.!]$/, '');
    const accepts = btns.some((b) => ACCEPT_BTN.test(label(b)));
    if (small && accepts && cookieBanner(el)) for (const b of btns) {
      const t = label(b);
      if (t && REJECT_TXT.test(t) && !/accept all|allow all|agree to all|ok$|got it/i.test(t) && vis(b) && LNOF(b) !== 'a') { rej = { ref: ref(b), label: t }; break; }
    }
    return { el, ref: ref(el), id: (IDOF(el) || CLSOF(el) || LNOF(el)).toString().slice(0, 60), reject: rej };
  }

  // ---------------------------------------------------------------- islands (video)
  function deepAll(sel) {
    const out = [];
    const walk = (r) => { QSA(r, sel).forEach((x) => out.push(x)); QSA(r, '*').forEach((x) => { if (x.shadowRoot) walk(x.shadowRoot); }); };
    walk(document);
    return out;
  }
  function hostEl(e) { return e.parentElement || (e.getRootNode && e.getRootNode().host) || null; }
  function inJunk(S, e, cats) {
    for (let p = e; p; p = hostEl(p)) { const c = S.junk.get(p); if (c && (!cats || cats.includes(c))) return c; }
    return null;
  }
  function boxOf(e) {
    // the player's own box: the outermost ancestor about the player's size (its controls live there)
    const r = RECT(e);
    let box = e;
    for (let p = hostEl(e), i = 0; p && p !== document.body && i < 10; p = hostEl(p), i++) {
      const q = RECT(p);
      if (area(q) > area(r) * 1.35 || q.width > r.width * 1.25 + 4) break;
      // a player holds little text (its time, its controls); a box with real words over the video is content, not the player
      if ((p.innerText || '').length > 160) break;
      if (q.width >= r.width - 2 && q.height >= r.height - 2) box = p;
    }
    return box;
  }
  // an ad network's video player (outstream ads, ad clips in a floating player) is never the page's own video
  const AD_VIDEO = /(^|[./])(primis\.tech|connatix\.com|aniview\.com|vidazoo\.com|anyclip\.com|teads\.tv|ex\.co|avantisvideo\.com|2mdn\.net|doubleclick\.net|innovid\.com|springserve\.com|spotxchange\.com|spotx\.tv|playwire\.com|sendtonews\.com|imasdk\.googleapis\.com|redirector\.gvt1\.com)\b/i;
  const AD_VIDEO_BOX = /(^|[\s_-])(primis|prms|connatix|cnx|aniview|vidazoo|anyclip|teads|outstream|exco|avantis|ad-?video|video-?ad|pre-?roll)([\s_-]|$)/i;
  // vendors' ids and classes run into other words ("Video-iFrame-SekindoSPlayer…", Primis's player on AP's front page)
  const AD_VIDEO_NAME = /sekindo|primis|connatix|aniview|vidazoo|anyclip/i;
  const idcls = (p) => (IDOF(p) || '') + ' ' + (typeof CLSOF(p) === 'string' ? CLSOF(p) : '');
  const adSrcVideo = (v) => AD_VIDEO.test((v.currentSrc || v.src || '') + ' ' + (v.poster || '')) || AD_VIDEO_SRC.test(v.currentSrc || v.src || '');
  // the vendor's name sits on the player's own boxes (between the <video> and the box) or just above them
  function adVendorBox(box, inner) {
    const hit = (p) => { const t = idcls(p); return AD_VIDEO_BOX.test(t) || AD_VIDEO_NAME.test(t); };
    if (inner && inner !== box && CONTAINS(box, inner)) for (let p = inner.parentElement; p && p !== box; p = p.parentElement) if (hit(p)) return true;
    for (let p = box, i = 0; p && p !== document.body && i < 5; p = p.parentElement, i++) if (hit(p)) return true;
    return false;
  }
  function adVideo(box, inner) {
    const vids = inner && LNOF(inner) === 'video' ? [inner] : Array.from(QSA(box, 'video'));
    let srcs = vids.map((v) => (v.currentSrc || v.src || '') + ' ' + (v.poster || '')).join(' ') + ' ' + (inner && LNOF(inner) === 'iframe' ? inner.src || '' : '');
    if (box.querySelectorAll) for (const im of QSA(box, 'img')) srcs += ' ' + (im.currentSrc || im.src || '');
    if (AD_VIDEO.test(srcs)) return true;
    return adVendorBox(box, inner);
  }
  // the page's own player playing a pre-roll (TED's talk under IMA's ad): an ad network's <video> beside the page's own
  // <video> in one big player near the top. It stays the page's island, marked pre (the kit waits the ad out, the
  // island crops the page's own video); an ad vendor's player has no such second video and stays an ad.
  function ownPreRoll(box) {
    if (!box || !box.querySelectorAll || box === document.body) return false;
    const vids = Array.from(QSA(box, 'video'));
    if (vids.length < 2) return false;
    const ads = vids.filter(adSrcVideo);
    if (!ads.length || ads.length === vids.length || adVendorBox(box)) return false;
    const r = RECT(box);
    if (r.width < 0.45 * innerWidth || r.top + scrollY > 1.5 * innerHeight) return false;
    return vids.some((v) => !adSrcVideo(v) && (RECT(v).width >= 0.8 * r.width || (isFinite(v.duration) && v.duration > 60)));
  }
  // a story promo's player on a front page (AP's video stories): one story's box around it, with its headline linking to
  // the story's own page. The story's card shows the player's picture; the island is on the story's page.
  function promoOf(box) {
    const here = location.href.split('#')[0];
    for (let p = box.parentElement, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) {
      if ((p.textContent || '').length > 700) return null;
      const hs = Array.from(QSA(p, 'h1 a[href],h2 a[href],h3 a[href],h4 a[href],[role=heading] a[href],a[href] h2,a[href] h3,a[href] h4')).filter((h) => !CONTAINS(box, h));
      if (hs.length > 1) return null;   // a section of several stories: the player isn't one story's
      if (hs.length === 1) {
        const a = LNOF(hs[0]) === 'a' ? hs[0] : CLOSEST(hs[0], 'a[href]');
        return a && a.href && a.href.split('#')[0] !== here ? p : null;
      }
    }
    return null;
  }
  function posterOf(box) {
    const v = QS(box, 'video');
    if (v && v.poster) return v.poster;
    const im = QS(box, 'img');
    if (im) return imgSrc(im, im) || null;
    const bg = QS(box, '[style*="background-image"]');
    const m = bg && /url\(["']?([^"')]+)/.exec(ATTR(bg, 'style') || '');
    return m ? m[1] : null;
  }
  function findIslands(S) {
    const cands = [];
    const add = (box, why, src, inner) => {
      if (!box || !box.isConnected) return;
      const pre = ownPreRoll(box);
      if (!pre && adVideo(box, inner)) { if (!S.junk.has(box)) S.junk.set(box, 'ad'); return; }
      const r = RECT(box);
      // round 5: a page's own full-width player sized to a short window (Vimeo's, 1366 by 420) is no strip
      const hero = inner && LNOF(inner) === 'video' && r.width >= 0.8 * innerWidth && r.height >= 300 && r.width / r.height <= 4;
      if (r.width < 280 || r.height < 150 || (r.width / r.height > 3 && !hero) || r.width / r.height < 0.45) return;  // previews, strips
      if (inJunk(S, box)) return;   // ad slots, promos, sponsored posts: never an island
      for (const ap of S.adPlayers) if (CONTAINS(ap, box) || CONTAINS(box, ap)) { if (!S.junk.has(box)) S.junk.set(box, 'ad'); return; }
      // a player that started an ad by itself, on a page that isn't a video page (a recipe's autoplaying ad player)
      const rr = RECT(box);
      if (!S.userStarted && box.querySelector && QS(box, PRE_ROLL_SEL) && rr.width < 0.6 * innerWidth) { if (!S.junk.has(box)) S.junk.set(box, 'ad'); return; }
      const lab = [box, inner].filter(Boolean).map((e) => (ATTR(e, 'aria-label') || '') + ' ' + (ATTR(e, 'title') || '') + ' ' + (ATTR(e, 'data-ad') || '')).join(' ');
      if (/\b(sponsored|advertisement|promoted|ad)\b/i.test(lab)) return;
      if (box.closest && CLOSEST(box, '[class*=sponsor i],[data-component-type*=sponsor i],[class*=sbv-],[data-ad],[data-ad-slot]')) return;
      for (const c of cands) if (c.box === box || CONTAINS(c.box, box)) return;
      if (!pre && !S.userStarted && promoOf(box)) { S.promoPlayers.set(box, posterOf(box)); return; }
      for (let i = cands.length - 1; i >= 0; i--) if (CONTAINS(box, cands[i].box)) cands.splice(i, 1);
      cands.push({ box, why, src, inner, r, pre });
    };
    for (const v of deepAll('video')) {
      const rr = RECT(v);
      if (rr.width < 2) continue;
      // a clip inside a card (a result's hover preview) is a thumbnail, not a video to watch
      if (v.closest && CLOSEST(v, 'a[href]') && !CLOSEST(v, PLAYER_SEL)) continue;
      const box = boxOf(v);
      const host = /youtube\.com$/.test(location.hostname) ? 'youtube' : /vimeo\.com$/.test(location.hostname) ? 'vimeo' : 'html5';
      add(box, 'video', CLOSEST(v, '.jwplayer') ? 'jwplayer' : CLOSEST(v, 'video-js,.video-js') ? 'videojs' : host, v);
    }
    for (const f of BYTAG(document, 'iframe')) {
      const src = f.src || '';
      if (!PLAYER_IFRAME.test(src) || AD_IFRAME.test(src)) continue;
      if (!vis(f)) continue;
      let h = ''; try { h = new URL(src).hostname.replace(/^www\./, ''); } catch (e) { /* */ }
      add(boxOf(f), 'video', /youtube/.test(h) ? 'youtube' : /vimeo/.test(h) ? 'vimeo' : 'embed:' + h, f);
    }
    // click-to-play players: a known player box, or a "Play video" button on a 16:9 poster
    for (const p of QSA(document, PLAYER_SEL)) if (vis(p)) add(boxOf(p), 'video', MATCHES(p, '.jwplayer,.jw-wrapper') ? 'jwplayer' : 'player', p);
    for (const b of QSA(document, 'button,[role=button]')) {
      const n = (ATTR(b, 'aria-label') || ATTR(b, 'title') || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^(play( video| clip| now)?|watch( video| now)?|▶)\b/i.test(n) || n.length > 140 || !vis(b)) continue;
      let c = b, box = null;
      const rb = RECT(b);
      const ok = (r) => r.width >= 280 && r.height >= 150 && r.width / r.height >= 1.2 && r.width / r.height <= 2.4;
      if (ok(rb)) box = b;   // the play button is the whole poster
      for (let i = 0; !box && i < 8 && c.parentElement && c.parentElement !== document.body; i++) {
        c = c.parentElement;
        const r = RECT(c);
        if (ok(r) && (c.innerText || '').length <= 200 && (QS(c, 'img,picture,video') || /poster|thumbnail|player/i.test(CLSOF(c) + ' ' + IDOF(c)) || area(rb) >= 0.6 * area(r))) { box = c; break; }
        if (r.width > 1400 || (c.innerText || '').length > 600) break;
      }
      if (box) add(boxOf(box), 'video', 'click-to-play', b);
    }
    // the main one: the largest near the top (a real dialog's player, opened by the member, wins)
    let main = null, best = -1;
    for (const c of cands) {
      const y = c.r.top + scrollY;
      const inDlg = c.box.closest && CLOSEST(c.box, 'dialog[open],[role=dialog],[aria-modal=true]');
      const playing = c.inner && LNOF(c.inner) === 'video' && !c.inner.paused;
      const score = area(c.r) * (y < 2.5 * innerHeight ? 1 : 0.4) * (inDlg ? 3 : 1) * (playing ? 1.5 : 1);
      // the page's main video is a big one near the top (or the dialog's): a small promo player far down a story
      // (Ars Technica's) is never hoisted under the headline; it stays where it is, if the walk meets it
      if (!inDlg && (c.r.width < 400 || y >= 2.5 * innerHeight)) continue;
      if (score > best) { best = score; main = c; }
    }
    for (const c of cands) {
      c.main = c === main;
      S.islands.push(c);
      S.islandOf.set(c.box, c);
    }
  }
  function islandBlock(c) {
    const r = RECT(c.box);
    let v = c.inner && LNOF(c.inner) === 'video' ? c.inner : c.box.querySelector && QS(c.box, 'video');
    if (v && adSrcVideo(v) && c.box.querySelectorAll) v = Array.from(QSA(c.box, 'video')).find((x) => !adSrcVideo(x) && RECT(x).width >= 100) || v;
    const b = { k: 'media', m: 'video', island: 'none', ad: 0, r: ref(c.box), src: c.src, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    const n = clip((c.inner && (ATTR(c.inner, 'title') || ATTR(c.inner, 'aria-label'))) || ATTR(c.box, 'aria-label') || ATTR(c.box, 'title') || '', 100);
    if (n && !/^(video player|player|youtube video player|vimeo|media player)$/i.test(n)) b.n = n;
    if (c.main) b.main = 1;
    if (v) {
      // the crop is the <video> element's own rectangle (vr), never the site's player chrome; r is the player, for input
      const vr = RECT(v);
      if (vr.width >= 100) { b.v = ref(v); b.vr = [Math.round(vr.left + scrollX), Math.round(vr.top + scrollY), Math.round(vr.width), Math.round(vr.height)]; }
      if (isFinite(v.duration) && v.duration > 0) b.dur = Math.round(v.duration);
      if (v.paused) b.paused = 1;
      if (v.textTracks && v.textTracks.length) b.tracks = v.textTracks.length;
      if (v.mediaKeys) b.drm = 1;
      if (v.poster) { try { b.poster = new URL(v.poster, location.href).href.slice(0, 300); } catch (e) { /* */ } }
    }
    if (!b.poster) { const im = c.box.querySelector && QS(c.box, 'img'); if (im) { const s = imgSrc(im, im); if (s) b.poster = s.slice(0, 300); } }
    if ((c.box.querySelector && QS(c.box, PRE_ROLL_SEL)) || c.pre) b.pre = 1;
    if (c.inner && LNOF(c.inner) === 'iframe') { b.frame = 1; b.s = (c.inner.src || '').slice(0, 300); }
    // live: playing now; click: it plays when started (a poster, a paused player, a click-to-play button)
    b.island = v && !v.paused ? 'live' : 'click';
    // a click-to-play player under an unanswered consent banner waits for the site's cookie choice (BBC's player
    // won't load until the banner is answered): the renderer shows the poster and "Play on the real page" (spec 6)
    if (!v && SCAN && SCAN.consent.some((c) => c.el.isConnected && vis(c.el))) b.blocked = 'consent';
    return b;
  }

  // ---------------------------------------------------------------- cards
  // elements that are prose or inline, never a card or an overlay box themselves
  const NOT_OVERLAY = new Set('p h1 h2 h3 h4 h5 h6 li a span b i em strong code pre blockquote table thead tbody tr td th img picture svg path br hr label input select textarea button figure figcaption small sup sub time abbr cite mark s u q dd dt dl ol ul script style link meta noscript'.split(' '));
  const PROSE_ITEM = new Set('p h1 h2 h3 h4 h5 h6 blockquote pre table hr br span b i em strong code figure figcaption dd dt img'.split(' '));
  const CARD_SKIP = /^(table|tbody|thead|tr|td|th|select|svg|picture|p|span|a|button|figure|form|label|dl|pre|code)$/;
  function findCards(S) {
    const body = document.body;
    const cands = [];
    for (const P of BYTAG(body, '*')) {
      if (P.childElementCount < 3 || CARD_SKIP.test(LNOF(P))) continue;
      if (S.junk.has(P) || S.chrome.has(P)) continue;
      // group visible children by tag and width
      const groups = new Map();
      let n = 0;
      for (const c of P.children) {
        if (S.junk.has(c)) continue;
        if (PROSE_ITEM.has(LNOF(c))) { n++; const g = groups.get(LNOF(c)); if (g) g.push(c); else groups.set(LNOF(c), [c]); continue; }   // no box needed
        const r = RECT(c);
        if (r.width < 60 || r.height < 30) continue;
        n++;
        const key = LNOF(c) + ':' + Math.round(r.width / 24);
        const g = groups.get(key); if (g) g.push(c); else groups.set(key, [c]);
      }
      if (n < 3) continue;
      let G = null;
      for (const g of groups.values()) if (!G || g.length > G.length) G = g;
      if (!G || G.length < 3 || G.length < 0.5 * n || PROSE_ITEM.has(G[0].localName)) continue;   // paragraphs are not cards
      let items = G.filter((c) => cardish(c, S));
      // round 6: an engine's own modules among its results (Discussions, People also ask, Videos: a box of three or more
      // links of its own, Brave's) don't count against the results being a list; they're walked as content in place
      const mods = items.length >= 5 ? G.filter((c) => !items.includes(c) && QSA(c, 'a[href]').length >= 3).length : 0;
      if (items.length < 3 || items.length < 0.7 * (G.length - mods)) {
        // a row of tiles side by side (a forecast's days: a name, a picture, a few words) keeps its shape as a card row
        if (G.length <= 24 && !S.tiles.has(P) && QS(G[0], 'img')) {
          const rs = G.map((c) => RECT(c)), pw = RECT(P).width || 1;
          const row = rs.filter((r) => Math.abs(r.top - rs[0].top) < 8).length >= 3;
          if (row && rs.every((r) => r.width < 0.4 * pw) && G.every((c) => cardImg(c) && (c.textContent || '').replace(/\s+/g, ' ').trim().length <= 160 && vis(c))) S.tiles.set(P, G);
        }
        continue;
      }
      if (S.h1 && items.some((c) => CONTAINS(c, S.h1))) {
        // round 3: the page's h1 inside one tile of a long grid is that tile's own (a store's promo tile among its
        // products): it's walked as content, and the rest are still the cards
        if (items.length < 6) continue;
        items = items.filter((c) => !CONTAINS(c, S.h1));
      }
      if (S.posts && S.posts.size && items.some((c) => [...S.posts].some((p) => CONTAINS(c, p) || CONTAINS(p, c)))) continue;
      // round 4: a row whose items lead back to this very listing with another query ("Threshold", "$15 - $25":
      // Target's popular filters) is the listing's filters, not its results
      {
        let back = 0;
        for (const c of items) {
          const T = titleOf(c);
          if (!T || !T.a) continue;
          // a refinement keeps every part of this listing's query and adds to it (a video's next one, /watch?v=other, doesn't)
          try {
            const u = new URL(T.a.href, location.href), here = new URLSearchParams(location.search);
            let keeps = true;
            for (const [k, v] of here) if (u.searchParams.get(k) !== v) { keeps = false; break; }
            if (u.hostname === location.hostname && u.pathname === location.pathname && keeps && [...u.searchParams.keys()].length > [...here.keys()].length) back++;
          } catch (e) { /* */ }
        }
        if (back >= 3 && back >= 0.7 * items.length) { if (!S.chrome.has(P) && !(S.prot && S.prot(P))) S.chrome.set(P, 'filters'); continue; }
      }
      cands.push([P, items]);
    }
    // outermost lists win, except that an item holding a list of its own (a video carousel inside a result list)
    // is not a card: it is walked as content, and its inner list becomes cards
    const accepted = [];
    // R11: an item labeled Sponsored or Ad, or whose links are an engine's ad clicks, drops wherever it sits
    const AD_CLICK = /^https?:\/\/([a-z.]*\.)?(google\.[a-z.]+\/aclk|googleadservices\.com|bing\.com\/aclk|ad\.doubleclick\.net|duckduckgo\.com\/y\.js)/i;
    // the boxes that hold an ad label or an ad-click link, found once (an item is sponsored when it is one of them)
    const adHold = new Set();
    const holdUp = (e) => { for (let p = e; p && p !== body; p = p.parentElement) { if (adHold.has(p)) break; adHold.add(p); } };
    for (const l of S.adLabels) holdUp(l);
    // round 4: and an ad network's click id or a store's ad server on the item's own link, wherever the item sits (an
    // engine's shopping row inside its results, which the scan's own ad rule leaves alone as the page's main column)
    const AD_CLICK_ID = /([?&]|%3f|%26)(hvadid|msclkid|gclid)(=|%3d)|\/sspa\/click|\/gp\/slredirect\/|sponsored-ads\.amazon\.|\/\/aax-/i;
    for (const a of BYTAG(body, 'a')) if (a.href && (AD_CLICK.test(a.href) || AD_CLICK_ID.test(a.href))) holdUp(a);
    const sponsoredItem = (it) => adHold.has(it);
    // round 5: a row the page labels "Sponsored" in a line of its own just before it (eBay's promoted shop row): the
    // label's next few boxes that hold cards are an ad's
    const adRows = new Map();   // a box after the label -> the label's own box
    for (const l of S.adLabels) {
      if (!/^(sponsored|ad|promoted)$/i.test((l.textContent || '').trim())) continue;
      let e = l;
      while (e.parentElement && e.parentElement !== body && e.parentElement.childElementCount === 1) e = e.parentElement;
      for (let k = e.nextElementSibling, n = 0; k && n < 3; k = k.nextElementSibling, n++) adRows.set(k, e);
    }
    const adRowOf = (P) => { for (const [r, e] of adRows) if (r === P || CONTAINS(r, P)) return [r, e]; return null; };
    const short = (k) => k && (k.textContent || '').replace(/\s+/g, ' ').trim().length <= 60 && !QS(k, 'img,video');
    // round 6: in a list most of whose boxes are rows holding a list of cards, a box that only wraps a short list of the
    // same kind (a grid's row of one or two products, Best Buy's) is a row too, never one item, whatever its products are
    const sigOf = (e) => LNOF(e) + '|' + Array.from(CLISTOF(e)).sort().join(' ');
    const candSigs = new Set(cands.map(([Q]) => sigOf(Q)));
    const rowOf = (it) => {
      const n = (it.textContent || '').length;
      for (const k of candSigs) for (const q of QSA(it, k.slice(0, k.indexOf('|')))) if (q !== it && sigOf(q) === k && (q.textContent || '').length >= 0.9 * n) return true;
      return false;
    };
    for (const [P, items0] of cands) {
      if (accepted.some(([Q, its]) => its.some((it) => CONTAINS(it, P)))) continue;
      const holders = items0.filter((it) => cands.some(([Q]) => Q !== P && CONTAINS(it, Q)));
      // (only where most of the list's boxes are such rows: a grid's, never a list of results that each wrap one box)
      const rowsHere = holders.length >= 2 && holders.length >= 0.5 * items0.length;
      let items = items0.filter((it) => !holders.includes(it) && !(rowsHere && rowOf(it)));
      const row = adRows.size && items.length <= 12 ? adRowOf(P) : null;
      if (row) {
        for (const it of items) if (!S.junk.has(it)) { S.junk.set(it, 'sponsored'); S.stats.heur++; }
        // with its advertiser's line before the label, and its short lines between the label and the row ("Ends soon")
        const [r, e] = row, pv = G_PREV.call(e);
        if (short(pv) && QSA(pv, 'a[href]').length === 1 && !S.junk.has(pv)) S.junk.set(pv, 'sponsored');
        for (let k = e.nextElementSibling; k && k !== r; k = k.nextElementSibling) if (short(k) && !S.junk.has(k)) S.junk.set(k, 'sponsored');
        continue;
      }
      const ads = items.filter(sponsoredItem);
      if (ads.length >= 2 && ads.length === items.length) { dropAdWidget(S, P); continue; }
      if (ads.length) { for (const it of ads) if (!S.junk.has(it)) { S.junk.set(it, 'sponsored'); S.stats.heur++; } items = items.filter((it) => !ads.includes(it)); }
      if (items.length < 3) continue;
      accepted.push([P, items]);
      S.cards.set(P, items);
    }
    // round 6: a grid drawn as rows that are each a short list of their own (Best Buy's: a list of four products per
    // row, every row a box among the grid's rows) is one grid. Each row's list of the same kind joins it, a row of one or
    // two products too (where the rest are sponsored or still drawing), under one group, so the view shows one grid
    S.cardGroup = new Map();
    {
      const inJunkUp = (e) => { for (let p = e; p && p !== body; p = p.parentElement) if (S.junk.has(p)) return true; return false; };
      const sig = (P) => LNOF(P) + '|' + Array.from(CLISTOF(P)).sort().join(' ');
      const done = new Set();
      for (const [P] of accepted.slice()) {
        if (done.has(P) || S.cards.get(P).length > 8) continue;
        // the row: P, or a box around it holding nothing else of size; the grid: the row's parent, with other rows
        let row = P;
        for (let i = 0; i < 3 && row.parentElement && row.parentElement !== body && row.parentElement.childElementCount === 1; i++) row = row.parentElement;
        const grid = row.parentElement;
        if (!grid || grid === body || grid.childElementCount < 3 || (S.h1 && CONTAINS(grid, S.h1))) continue;
        const k = sig(P);
        // every row a box that only wraps one list of this kind; the grid's other boxes (a sponsored slot, a row still
        // drawing) fewer than its rows
        const lists = [];
        let rows = 0, other = 0;
        for (const r of grid.children) {
          if (r === row) { lists.push(P); rows++; continue; }
          if (S.junk.has(r)) continue;
          const qs = LNOF(r) === LNOF(P) && sig(r) === k ? [r] : Array.from(QSA(r, LNOF(P))).filter((x) => sig(x) === k);
          const q = qs.length === 1 ? qs[0] : null;
          if (q && (q.textContent || '').length >= 0.9 * (r.textContent || '').length) { lists.push(q); rows++; } else if ((r.textContent || '').trim()) other++;
        }
        const full = lists.filter((q) => S.cards.has(q));
        if (full.length < 2 || other > rows) continue;
        for (const q of lists) {
          done.add(q);
          S.cardGroup.set(q, P);
          if (S.cards.has(q) || inJunkUp(q)) continue;
          const its = Array.from(q.children).filter((c) => !S.junk.has(c) && !sponsoredItem(c) && cardish(c, S));
          if (its.length) { S.cards.set(q, its); accepted.push([q, its]); }
        }
      }
    }
    // a front page's story promo (a headline link with its picture) that sits alone in its column, the lead story, is
    // a card too when the page repeats that promo's class at least three times
    const items0 = new Set(), above = new Set();
    for (const [, its] of accepted) for (const it of its) { items0.add(it); for (let p = it.parentElement; p && p !== body; p = p.parentElement) above.add(p); }
    const upHas = (e, set) => { for (let p = e; p && p !== body; p = p.parentElement) if (set.has(p)) return true; return false; };
    const inCard = (e) => above.has(e) || upHas(e, items0);
    const sig = new Map();
    let seen = 0;
    for (const e of QSA(body, '[class*=promo i],[class*=teaser i],[class*=story i]')) {
      if (++seen > 600) break;
      const tok = Array.from(CLISTOF(e)).find((c) => /(promo|teaser|story)(--[\w-]+)?$/i.test(c) && !/(list|grid|group|wrapper|container|section|rail|module|feed|carousel)/i.test(c));
      if (!tok) continue;
      if (e.parentElement && CLOSEST(e.parentElement, '.' + CSS.escape(tok))) continue;   // the outermost of its kind
      const g = sig.get(tok); if (g) g.push(e); else sig.set(tok, [e]);
    }
    for (const [, els] of sig) {
      if (els.length < 3) continue;
      for (const e of els) {
        if (inCard(e) || upHas(e, S.junk) || upHas(e, S.chrome) || (S.h1 && CONTAINS(e, S.h1))) continue;
        if (!cardImg(e) || !cardish(e, S)) continue;
        const P = e.parentElement;
        if (!P || S.cards.has(P)) continue;
        S.cards.set(P, [e]);
        accepted.push([P, [e]]);
      }
    }
  }
  const RATED_LINE = /^(rating|rated|customer rating)\b.{0,30}\bout of (5|five)\b/i;
  const RATING_NAME = /^(rating\b|rated\b|[\d.]+ out of (5|five)\b|not yet (reviewed|rated)|\(?[\d,.]+[kK]? (reviews?|ratings?)\)?$)/i;
  function titleOf(c) {
    const hs = Array.from(QSA(c, 'h1,h2,h3,h4,h5,h6,[role=heading]')).filter((x) => { const r = RECT(x); return r.width > 2 && r.height > 2 && (x.innerText || '').trim().length >= 3; });
    let h = hs[0];
    // round 5: a kicker heading over the headline (the Guardian's "Media" over its story) is not the card's title
    if (h && hs.length > 1 && (h.innerText || '').trim().split(/\s+/).length <= 3) h = hs.find((x) => (x.innerText || '').trim().split(/\s+/).length >= 5) || h;
    if (h) {
      const a = CLOSEST(h, 'a[href]') || QS(h, 'a[href]') || (MATCHES(c, 'a[href]') ? c : null) || QS(c, 'a[href]');
      return { t: clip(visText(h).replace(/\s+/g, ' ').trim(), 200), a };   // (round 5: a kicker set apart stays apart)
    }
    // R23: an engine's result whose title link has no text takes its shortened destination as the title, never a URL
    const blank = Array.from(QSA(c, 'h1 a[href],h2 a[href],h3 a[href],h4 a[href]')).find((a) => !(a.innerText || '').trim() && vis(a));
    if (blank) { const t = shortUrl(safeHref(blank.href || '')); if (t) return { t, a: blank }; }
    let best = null, bl = 0, bt = '', crumb = false;
    const links = MATCHES(c, 'a[href]') ? [c, ...QSA(c, 'a[href]')] : QSA(c, 'a[href]');
    for (const a of links) {
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      let nm = t.length >= 8 ? t : (ATTR(a, 'aria-label') || ATTR(a, 'title') || '');
      // round 4: a picture link with no words of its own is named by its picture (a store carousel's tiles, Amazon's)
      if (nm.length < 8) { const im = QS(a, 'img[alt]'); const alt = im ? (ATTR(im, 'alt') || '').replace(/\s+/g, ' ').trim() : ''; if (alt.length >= 12 && !AD_LABEL.test(alt) && RECT(im).width >= 80) nm = alt; }
      // a site-name link with its address ("Good Housekeeping https://www.goodhousekeeping.com › ...") is not a title;
      // a player's control labels ("Picture-in-Picture") inside a video link are not one either
      if (/https?:\/\/|\s›\s/.test(nm) || PLAYER_CTL.test(nm.trim())) {
        // round 4: an engine's result that is one link holding its site, its address and then its title (Brave's): the
        // title is the link's own line that is neither (one the page names a title, else the last)
        const own = PLAYER_CTL.test(nm.trim()) ? '' : crumbTitle(a);
        if (own.length >= 12 && own.length > bl) { best = a; bl = own.length; bt = own; crumb = true; }
        continue;
      }
      // a rating's own link ("Rating 4.9 out of 5 stars with 11 reviews", "Not Yet Reviewed") is never the item's name
      if (RATING_NAME.test(nm.trim())) continue;
      if (QS(a, 'video') && t.length < 8) continue;
      if (nm.length > bl) { best = a; bl = nm.length; bt = nm; crumb = false; }
    }
    if (!best || bl < 8) return null;
    return crumb ? { t: clip(bt, 200), a: best, crumb: true } : { t: clip(bt, 200), a: best };
  }
  // the deepest boxes of a link that hold a line of 12 or more characters, in order: a line that is an address, a path
  // of crumbs or a bare domain is not a title
  function crumbTitle(a) {
    let last = '', named = '';
    let n = 0;
    for (const e of QSA(a, '*')) {
      if (++n > 60) break;
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 12 || Array.from(e.children).some((k) => (k.innerText || '').replace(/\s+/g, ' ').trim().length >= 12)) continue;
      if (/›|https?:\/\/|^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t) || !vis(e)) continue;
      if (/title/i.test(typeof CLSOF(e) === 'string' ? CLSOF(e) : '')) named = t;
      last = t;
    }
    return named || last;
  }
  // one quiet action row per item: per-item menus and feedback controls drop everywhere; votes become ▲ / ▼ (R26)
  const ITEM_MENU = /^(verified account|verified|back|go back|(enable|open|show) accessibility( mode| tools| menu| options)?|(collapse|expand|toggle|show|hide|open|close) (the )?(sidebar|side panel|navigation|panel)|more actions|more options|show more actions|open (user |post |comment )?(actions|menu|options)|about this (result|ad)|actions|options|menu|…|⋯|⋮|\.\.\.|feedback|send feedback|report( post| comment| this)?|hide( post| this)?|save( post)?|award|give award.*|follow|share( post)?|bookmark|add to (list|collection)|button to add a comment|search comments.*|timeline|show activity on this post\.?|improve this (question|answer|post))$/i;
  // a gallery's or carousel's own controls (the view shows the pictures) and chat bubbles (spec §5, Product)
  // (round 6: and a carousel's "Go to previous slide - Picked For You", eBay's, with whatever names its row)
  const GALLERY_CTL = /^((select|show|view|go to|open) (product )?(photo|image|slide|picture|media)\b.*|((go to|show|view) )?(the )?(next|previous|prev) (images?|photos?|slides?|pictures?|items?)( ?[-–:] .{1,80}| (in|of) .{1,60})?|zoom( in| out)?( image| photo)?|all (media|photos|images)|scroll (down )?to see more .{0,30}|(pause|play|stop) (slideshow|carousel|slides)|(open )?chat( window| with us| now)?|live chat|skip (images|gallery|carousel|photos))$/i;
  const SIGNUP_CTA = /^(join( now| (for )?free| today| us)?|sign ?up( (now|for free|free|today))?|create (a |an |your )?(free )?account|get started( (for )?free)?|start (your )?free trial|try (it )?(for )?free|register( now| for free)?)$/i;
  const UPVOTE = /^(up ?vote|upvote( this)?|vote up)$/i, DOWNVOTE = /^(down ?vote|downvote( this)?|vote down)$/i;
  // round 5: an engine's own tools around its results and its answer ("Copy to clipboard", "Change Search Assist
  // settings", "Learn more about Search Assist", "Expand Duck.ai chat input", "Share Feedback") are the engine's
  const ENGINE_TOOL = /^(save (this )?search|(good|bad) response|copy( to clipboard)?|learn more about .{2,60}|change .{2,40} settings|expand .{0,40}chat( input)?|(share|send|give) feedback)$/i;
  const PLAYER_CTL = /^(picture-in-picture|play|pause|(click to |tap to )?(mute|unmute)|click for sound|full ?screen( view| mode)?|(enter|exit) full ?screen|settings|captions|subtitles|volume|seek|replay|play video|watch again|speed|(change )?playback (speed|rate))$/i;
  function cardImg(c) {
    let best = null, ba = 0;
    for (const i of QSA(c, 'img')) {
      const r = RECT(i);
      const a = area(r);
      if (r.width >= 40 && r.height >= 40 && a > ba) { best = i; ba = a; }
    }
    return best;
  }
  const COMMENTISH = /comment|reply|replies|answer|review/i;
  function cardish(c, S) {
    const r = RECT(c);
    if (r.height > 900 || r.width < 80 || !vis(c)) return false;
    // a comment, a reply or an answer is prose with an author, not a card
    if (COMMENTISH.test(LNOF(c) + ' ' + (IDOF(c) || '') + ' ' + (typeof CLSOF(c) === 'string' ? CLSOF(c) : '') + ' ' + (ATTR(c, 'role') || '')) ||
        QS(c, '[class*=comment i],[id*=comment i],[role=comment]') && !QS(c, 'img[width],h2,h3')) return false;
    const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length > 1200) return false;
    const T = titleOf(c);
    if (!T || !T.a) return false;
    // a section of the page's own text (a docs page's "Syntax", "Examples") is content, not a card: its title link is
    // the heading's anchor to itself, or it holds code or a table
    const th = ATTR(T.a, 'href') || '';
    if (th.startsWith('#') || (T.a.hash && T.a.pathname === location.pathname && T.a.hostname === location.hostname)) return false;
    if (QS(c, 'pre,table')) return false;
    let lt = 0;
    for (const a of QSA(c, 'a[href]')) lt += (a.innerText || '').length;
    if (t.length - lt > 600) return false;              // a comment or an answer, not a card
    if (T.t.length < 12) {
      // a short title (an author's handle) over a long text is a post, not a card
      for (const n of QSA(c, 'p,span,div,yt-attributed-string')) if (!CLOSEST(n, 'a') && !n.childElementCount && (n.textContent || '').trim().length >= 100) return false;
    }
    const img = cardImg(c);
    const head = QS(c, 'h1,h2,h3,h4,h5,h6,[role=heading]');
    // round 4: a product tile whose picture hasn't drawn yet (a carousel's lazy deals) is still one: a named link and a price
    return !!(img || head || T.crumb || (T.t.length >= 12 && PRICE.test(t)));
  }
  const PRICE = /(?:[$€£¥₹]|USD|EUR|GBP)\s?\d[\d,]*(?:\.\d{2})?/;
  // an element's text as inline runs, keeping b/strong/mark (bold) and i/em (italics); at most 400 characters
  function fmtRuns(el) {
    let left = 400;
    const go = (node) => {
      const out = [];
      for (const n of node.childNodes) {
        if (left <= 0) break;
        if (n.nodeType === 3) { const t = n.data.replace(/\s+/g, ' '); if (t) { const u = t.slice(0, left); left -= u.length; out.push(u); } continue; }
        if (n.nodeType !== 1 || SKIP.has(LNOF(n)) || !vis(n) || srOnly(n)) continue;
        if (LNOF(n) === 'br') { out.push(' '); continue; }
        const disp = getComputedStyle(n).display, apart = disp !== 'inline' && disp !== 'contents';
        if (apart) out.push(' ');
        const inner = go(n);
        const f = FMT[LNOF(n)];
        if (f && f !== 'code' && inner.length) out.push([f, ...inner]); else out.push(...inner);
        if (apart) out.push(' ');
      }
      return out;
    };
    const r = normRuns(go(el));
    if (typeof r[0] === 'string') r[0] = r[0].replace(/^\s+/, '');
    const L = r.length - 1;
    if (typeof r[L] === 'string') r[L] = r[L].replace(/\s+$/, '');
    return r.filter((x) => x !== '');
  }
  // round 6: a box whose words are four or more short pieces, none a sentence's length, is a row of facts, not prose
  function facts(e) {
    let n = 0, longest = 0;
    const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t && n < 60; t = tw.nextNode()) {
      const l = t.data.replace(/\s+/g, ' ').trim().length;
      if (!l) continue;
      n++; if (l > longest) longest = l;
    }
    return n >= 4 && longest < 40;
  }
  function cardItem(c) {
    const T = titleOf(c);
    if (!T) return {};
    const it = { t: T.t };
    if (T.a) { it.r = ref(T.a); it.u = safeHref(T.a.href || ''); }
    const img = cardImg(c);
    if (img) { const s = imgSrc(img, img); const [w, h] = imgDims(img, img); if (s) it.i = [s, w, h]; }
    // a story promo's player: the story's picture is the player's poster
    if (!it.i && SCAN && SCAN.promoPlayers.size) for (const [pb, ps] of SCAN.promoPlayers) if (ps && CONTAINS(c, pb)) { const r = RECT(pb); it.i = [ps.slice(0, 300), Math.round(r.width), Math.round(r.height)]; break; }
    const full = (c.innerText || '').replace(/\s+/g, ' ');
    const off = QS(c, '.a-offscreen,[class*=price i] [aria-hidden=false],[itemprop=price],[data-testid*=price i],[class*=price i]');
    const pm = ((off && off.textContent) || '').match(PRICE) || full.match(PRICE);
    if (pm) it.p = pm[0].replace(/\s+/g, '');
    const rl = QS(c, '[aria-label*="out of 5" i],[title*="out of 5" i],[aria-label*="stars" i]');
    const rm = (rl && (ATTR(rl, 'aria-label') || ATTR(rl, 'title')) || full).match(/(\d(?:\.\d)?) out of 5/i);
    if (rm) it.s = rm[1];
    // chips: labels and badges
    const chips = [];
    for (const e of QSA(c, '[class*=label i],[class*=badge i],[class*=chip i],[class*=pill i],[class*=tag i]')) {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      // R13: at most one badge; never a piece of the title, a count, a control's word or a price
      if (t && t.length <= 24 && !chips.includes(t) && t !== it.t && !norm(it.t).includes(norm(t)) && !/^\(?[\d.,]+[kKmM]?\)?$/.test(t) &&
          !/^(compare|save|add to (cart|bag|list)|more options|quick ?view|wishlist)$/i.test(t) && !PRICE.test(t) && !AD_LABEL.test(t) &&
          !QS(e, '[class*=label i],[class*=badge i]')) chips.push(t);
      if (chips.length >= 1) break;
    }
    if (chips.length) it.ch = chips;
    // one snippet, kept with its inline bold, italics and highlights (a search page's query words): the innermost box of
    // 60 to 700 characters that isn't the title; then short meta lines from the card's other text nodes
    const meta = [], seen = new Set([norm(it.t)]);
    let snip = '', snipEl = null;
    for (const e of QSA(c, 'p,div,span,dd,[class*=snippet i],[class*=desc i]')) {
      if ((T.a && (CONTAINS(e, T.a) || CONTAINS(T.a, e))) || CLOSEST(e, 'button,[role=button],a[href]') || QS(e, 'button,[role=button]')) continue;
      const et = (e.textContent || '').replace(/\s+/g, ' ').trim(), n = et.length;
      if (n < 60 || n > 700 || !vis(e)) continue;
      // round 5: a result's address line ("Business Insider https://www.businessinsider.com › guides › …") is no snippet
      if (/https?:\/\/\S+|\S\s›\s\S/.test(et) && et.split(/\s+/).length <= 16) continue;
      // round 6: nor is a rating spelled out for a screen reader ("Rating 4.9 out of 5 stars with 11 reviews 4.9 (11 …)")
      if (RATED_LINE.test(et)) continue;
      let inner = false;
      for (const k of e.children) if (((k.textContent || '').replace(/\s+/g, ' ').trim().length) >= 0.9 * n && !FMT[LNOF(k)]) { inner = true; break; }
      if (inner) continue;
      // round 6: a row of a product's short facts ("$79.95", "or Best Offer", "Free delivery", "46 watchers": eBay's) is
      // no snippet: its pieces are the card's meta lines
      if (facts(e)) continue;
      snipEl = e; break;
    }
    if (snipEl) {
      const r = fmtRuns(snipEl), nt = norm(runText(r)), ti = norm(it.t);
      // a caption that only repeats the title (a gallery's) is no snippet
      if (runText(r).trim().length >= 60 && !(ti.includes(nt) || nt.includes(ti) && nt.length < ti.length + 12)) { snip = r; seen.add(norm(snipEl.textContent)); } else snipEl = null;
    }
    const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement;
      if (!p || !vis(p) || CLOSEST(p, 'button,[role=button],script,style,[aria-hidden=true]') || (snipEl && CONTAINS(snipEl, p))) continue;
      if (srOnly(p)) continue;   // "Unread", "Filter by author": screen-reader text
      let s = n.data.replace(/\s+/g, ' ').trim();
      if (s.length < 2 && !/^\d$/.test(s)) continue;
      if (/^[|·•,()\-–—/]+$/.test(s)) continue;
      // round 5: an item's score, a bare number in its own score box (Lobsters', HN's points), is "▲ 39", never dropped
      // as a stray count
      if (/^[\d.,]+[kKmM]?$/.test(s)) {
        const box = CLOSEST(p, '[class*=score i],[class*=points i],[class*=vote i],[class*=karma i]');
        if (box && CONTAINS(c, box)) s = /points/i.test(CLSOF(box) + '') ? s + ' points' : '▲ ' + s;
        else {
          // and a count whose own label says what it counts (GitHub's "3 comments" on an issue's comment link) says so
          const lab = CLOSEST(p, '[aria-label]');
          const t = lab && CONTAINS(c, lab) ? (ATTR(lab, 'aria-label') || '').replace(/\s+/g, ' ').trim() : '';
          if (t && t.length <= 40 && t.includes(s) && /\p{L}/u.test(t)) s = t;
        }
      }
      // round 6: a result's address line or path of crumbs ("› r › Workspaces › comments › 1g2ql2s › need_a_…") is
      // neither its snippet nor its meta, and nor is the raw host its title links to ("www.reddit.com"; a site's name
      // shown as its domain, Bing's "nytimes.com", stays)
      if ((/^›|\S\s›\s\S|https?:\/\//.test(s) && s.split(/\s+/).length <= 16) || (T.a && /^www\.[\w-]+(\.[\w-]+)+$/i.test(s) && T.a.hostname === s.toLowerCase())) continue;
      const k = norm(s);
      if (seen.has(k) || (it.p && s.includes(it.p)) || norm(it.t).includes(k) || chips.includes(s) || AD_LABEL.test(s) || FEEDBACK_HEAD.test(s)) continue;
      // (round 5: and never a tag the item's one chip already shows, "ask" of "ask devops")
      if (chips.some((ch) => (' ' + ch.toLowerCase() + ' ').includes(' ' + s.toLowerCase() + ' '))) continue;
      seen.add(k);
      if (RATED_LINE.test(s)) continue;   // (round 6)
      if (s.length >= 60) { if (!snip) snip = [clip(s, 260)]; }
      else if ((meta.length < 6 || /^(▲ )?\d[\d.,]*[kKmM]? (comments?|replies|reply|answers?|points|votes?)$|^▲ \d/i.test(s)) && meta.length < 9 && !/^\d+(\.\d+)? out of 5/.test(s)) meta.push(s);
    }
    // round 5: "authored by", "via" and "by" read with the name after them, as one line
    for (let i = meta.length - 2; i >= 0; i--) if (/\b(by|via|from)$/i.test(meta[i]) && meta[i].length <= 20) meta.splice(i, 2, meta[i] + ' ' + meta[i + 1]);
    // round 6: and a lone "opened" or "posted" reads with its date after it ("opened on Nov 11, 2026"), and an item's
    // number in this repository is its number ("#44057", not "microsoft/playwright#44057")
    for (let i = meta.length - 2; i >= 0; i--) if (/^(opened|closed|merged|posted|updated|created|edited|asked|answered|modified|published)$/i.test(meta[i]) && /^(on |at |in )?\S.{0,30}$/.test(meta[i + 1])) meta.splice(i, 2, meta[i] + ' ' + meta[i + 1]);
    { const m = location.pathname.match(/^\/([\w.-]+\/[\w.-]+)\//); if (m) for (let i = 0; i < meta.length; i++) if (meta[i].startsWith(m[1] + '#')) meta[i] = meta[i].slice(m[1].length); }
    // R13: one delivery line at most; "bought in past month", swatches, "More buying choices" and upsells drop
    let deliv = 0;
    // (round 5: and an engine's raw address and its path of crumbs, "https://www.nytimes.com", "› Office › Home office",
    // beside the site's name: the title links there)
    // (round 6: and a shop's own finders, "Find more like this", "See all similar", "See visually similar items", a
    // swatch count "+4", a price's screen-reader label "Price, product page" and a bare "List:")
    const m2 = meta.filter((x) => !/bought in (the )?(past|last) month|^[\d.,]+[kKmM]?\+$|^new at$|more buying choices|^options?:|other colou?rs|\bswatch|join prime|prime members|^sponsored$|^see options$|^more options$|^compare$|^\(?[\d.,]+\)?$|^\+\d+ (more|other)|^https?:\/\/|^›|^find more like this$|^see (all|visually) similar( items)?( on [\w .]{1,30})?\.?$|^(to|or|and|from)$|^\+\d+$|^price, product page$|^(list|was|typical)( price)?:?$/i.test(x) && !norm(it.t).includes(norm(x)) &&
      !(/deliver|shipping/i.test(x) && deliv++ > 0));
    if (m2.length) it.m = m2;
    if (snip) {
      // round 5: an engine's "...Read more" at a snippet's end is its own control, not the snippet's words
      const last = snip[snip.length - 1];
      if (typeof last === 'string') { const cut = last.replace(/\s*(\.\.\.|…)?\s*read more$/i, '…'); snip = snip.slice(0, -1).concat(cut === '…' && snip.length > 1 ? [] : [cut]); }
      it.d = snip;
    }
    // round 5: a chip that is only marks ("·"), or a piece of the snippet's own words, is no chip
    if (it.ch) {
      const st = snip ? runText(snip) : '';
      it.ch = it.ch.filter((x) => /[\p{L}\p{N}]/u.test(x) && !(st && st.includes(x)));
      if (!it.ch.length) delete it.ch;
    }
    // one row of actions
    const x = [];
    for (const b of QSA(c, 'button,[role=button]')) {
      const nm = accName(b);
      if (!nm || ITEM_MENU.test(nm) || ENGINE_TOOL.test(nm) || UPVOTE.test(nm) || DOWNVOTE.test(nm) || /^filter by\b/i.test(nm) || !/[\p{L}\p{N}]/u.test(nm)) continue;
      if (/^(previous|next|prev)( slide| photo| image| item| story)?$/i.test(nm)) continue;   // round 5: a card's own carousel (R63)
      // round 6: and its picture carousel's other controls ("Go To End", "Next Page" on each of Target's products)
      if (GALLERY_CTL.test(nm) || /^(go to (the )?(end|start|beginning|first|last)( slide| image)?|(next|previous|prev) page)$/i.test(nm)) continue;
      if (nm.length <= 30 && !x.some((y) => y[2] === nm) && vis(b)) x.push(['btn', ref(b), nm, isPrimary(b) ? { pri: 1 } : 0]);
      if (x.length >= 2) break;
    }
    if (x.length) it.x = x;
    // a card folds its secondary links, never a headline: links with a real title of their own stay, as one line
    const more = [];
    for (const a of QSA(c, 'a[href]')) {
      if (a === T.a || more.length >= 4) continue;
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 25 || (t.replace(/(?:[$€£¥₹]|USD|EUR|GBP)\s?\d[\d,.]*|\d+/g, '').match(/[A-Za-z\u00C0-\u024F]/g) || []).length < 12) continue;
      if (norm(it.t).includes(norm(t).slice(0, 40)) || more.some((y) => y[3] === t)) continue;
      if (/^(options?|colou?rs?|sizes?|styles?|variants?)\s*:/i.test(t)) continue;   // R13: swatch and option links drop
      if (RATED_LINE.test(t) || RATING_NAME.test(t)) continue;   // round 6: a rating's own link (the card shows its stars)
      const tw = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2), ti = it.t.toLowerCase();
      if (tw.length && tw.filter((w) => ti.includes(w)).length >= 0.6 * tw.length) continue;   // another version of the same item
      more.push(['a', ref(a), safeHref(a.href || ''), clip(t, 160)]);
    }
    if (more.length) it.l = more;
    return it;
  }
  const norm = (s) => (s || '').toLowerCase().replace(/[^0-9a-z]+/g, '');
  function cardsBlock(P, items, ctx) {
    const P0 = (SCAN && SCAN.cardGroup && SCAN.cardGroup.get(P)) || P;   // round 6: a grid drawn as rows is one group
    // round 5: an engine's searches for its advertisers ("Find related products & services") are ads, not results
    const adSearch = (x) => /^find related (products|searches)\b/i.test(x.t) || /\b(offers|results) from advertisers\b/i.test(x.d ? runText(x.d) : '');
    const all0 = items.filter((c) => c.isConnected && vis(c)).map(cardItem).filter((x) => x.t);
    const kept = all0.filter((x) => !adSearch(x));
    if (ctx) for (let i = kept.length; i < all0.length; i++) dropCount(ctx, 'sponsored');
    // round 5: an engine's own answer among its results (DuckDuckGo's Search Assist: a long text whose "title" is only
    // its source's domain) is its answer, one block, never a result named by a domain with a price found in its text
    const answerish = (x) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x.t.trim()) && x.d && runText(x.d).length >= 150;
    const answers = kept.filter(answerish).map((x) => ({ k: 'answer', n: 'Answer', c: x.d, src: [['a', x.r, x.u, x.t]] }));
    const its = kept.filter((x) => !answerish(x));
    if (!its.length) return answers;
    const withImg = its.filter((x) => x.i).length;
    // a grid when the page lays them side by side
    let grid = false;
    const tops = items.slice(0, 8).map((c) => Math.round(RECT(c).top));
    for (let i = 1; i < tops.length; i++) if (Math.abs(tops[i] - tops[i - 1]) < 6) { grid = true; break; }
    // video cards (16:9 thumbnails) sit three or four to a row, whatever the site's own layout
    const wide = its.filter((x) => x.i && x.i[1] && x.i[2] && x.i[1] / x.i[2] >= 1.5).length;
    const lay = (grid || wide >= 0.6 * its.length) && withImg >= 0.6 * its.length ? 'grid' : 'list';
    const g = ref(P0);
    return answers.concat(its.map((it) => {
      const c = [];
      if (it.i) c.push(['a', it.r, it.u, ['img', it.i[0], '', it.i[1], it.i[2]]]);
      c.push(['a', it.r, it.u, it.t]);
      if (it.p) c.push(' ' + it.p);
      if (it.s) c.push(' ★ ' + it.s);
      if (it.m) c.push(' · ' + it.m.join(' · '));
      if (it.d) c.push(['br'], ...it.d);
      if (it.ch) c.push(['br'], ...it.ch.map((x) => ' ' + x + ' '));
      if (it.l) { c.push(['br']); it.l.forEach((y, i) => { if (i) c.push(' · '); c.push(y); }); }
      if (it.x) c.push(['br'], ...it.x);
      const b = { k: 'card', g, lay, title: it.t, c };
      // round 6: the snippet's words whole, for a reader that keeps a card's text plain (deskd's): a snippet whose query
      // words the page set in bold is one line, never its plain pieces
      if (it.d) { const sn = runText(it.d).replace(/\s+/g, ' ').trim(); if (sn) b.snip = clip(sn, 300); }
      if (it.p) b.price = it.p;
      if (it.s) b.stars = it.s;
      if (it.m) b.meta = it.m.join(' · ');
      return b;
    }));
  }

  // ---------------------------------------------------------------- block builder
  const BLOCK = new Set(('address article aside blockquote body center dd details dialog dir div dl dt fieldset ' +
    'figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section summary ' +
    'table tbody thead tfoot tr td th caption ul legend search').split(' '));
  const SKIP = new Set('script style noscript template head meta link title base param source track map datalist option optgroup'.split(' '));
  const FMT = { b: 'b', strong: 'b', i: 'i', em: 'i', code: 'code', kbd: 'code', samp: 'code', tt: 'code', sup: 'sup', sub: 'sub', mark: 'b', s: 's', del: 's', strike: 's' };
  let maxBlocks = 8000;
  let SCAN = null;

  function newCtx(live, shared) {
    return {
      live, blocks: [], para: null, target: null, kind: null, list: [], quote: 0, dlg: 0, nest: 0,
      sh: shared || { nodes: 0, refs: 0, used: new Set(), skip: new Set(), pointer: 0, truncated: false, dropped: {}, menu: [], bar: [], recirc: [], unnamed: 0 },
    };
  }
  function kids(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (LNOF(el) === 'slot') { const a = el.assignedNodes({ flatten: true }); return a.length ? a : el.childNodes; }
    return el.childNodes;
  }
  function addRun(ctx, x) {
    if (!ctx.para) { ctx.para = []; ctx.target = ctx.para; }
    ctx.target.push(x);
  }
  function addText(ctx, s) {
    if (!s) return;
    s = s.replace(/\s+/g, ' ');
    if (s === ' ' && !ctx.para) return;
    addRun(ctx, s);
  }
  const FMT_RUN = new Set(['b', 'i', 'code', 'sup', 'sub', 's']);
  function normRuns(a) {
    const out = [];
    for (const x of a) {
      if (typeof x === 'string') {
        if (typeof out[out.length - 1] === 'string') out[out.length - 1] += x; else out.push(x);
      } else if (FMT_RUN.has(x[0])) {
        const inner = normRuns(x.slice(1));
        if (inner.length) out.push([x[0], ...inner]);
      } else {
        // a control identical to the one before it (a doubled "Mention", a repeated price) is dropped
        const prev = out[out.length - 1] || out[out.length - 2];
        if (Array.isArray(prev) && prev[0] === x[0] && (x[0] === 'btn' || x[0] === 'a') && JSON.stringify(prev.slice(2)) === JSON.stringify(x.slice(2))) continue;
        out.push(x);
      }
    }
    for (let i = 0; i < out.length; i++) if (typeof out[i] === 'string') out[i] = out[i].replace(/ {2,}/g, ' ');
    if (typeof out[0] === 'string') { out[0] = out[0].replace(/^ +/, ''); if (!out[0]) out.shift(); }
    const L = out.length - 1;
    if (L >= 0 && typeof out[L] === 'string') { out[L] = out[L].replace(/ +$/, ''); if (!out[L]) out.pop(); }
    // a paragraph of separators only ("| | [-]") says nothing
    if (out.every((x) => typeof x === 'string' && /^[\s|·•,\-–—[\]()]*$/.test(x))) return [];
    return out;
  }
  const voteOnly = (c) => c.some((x) => Array.isArray(x) && x[0] === 'btn' && x[3] && x[3].v) &&
    c.every((x) => typeof x === 'string' ? /^[\s\d.,kKmM]*$/.test(x) : x[0] === 'btn' && x[3] && x[3].v);
  // R57: a wide table whose header groups its columns (a compatibility table's Desktop, Mobile, Server over each
  // browser) becomes one small table per group, a column per row: the group's name, then a row per browser with its
  // value for each feature
  function splitGrouped(rows) {
    if (rows.length < 3) return [{ k: 'tbl', rows }];
    const g = rows[0], sub = rows[1], body = rows.slice(2);
    const span = g.slice(1).reduce((n, c) => n + (c.cs || 1), 0);
    if (!g.slice(1).every((c) => c.h && (c.cs || 1) >= 2) || !sub.every((c, i) => c.h || (i === 0 && !(c.c || []).length)) ||
        sub.length - 1 !== span || sub.length < 8 || !body.every((r) => r.length === sub.length && r[0].h)) return [{ k: 'tbl', rows }];
    const out = [];
    let col = 1;
    for (const grp of g.slice(1)) {
      const n = grp.cs || 1, name = runText(grp.c || []).trim();
      const t = [[{ c: [name ? name[0].toUpperCase() + name.slice(1) : ''], h: 1 }, ...body.map((r) => ({ c: r[0].c, h: 1 }))]];
      for (let j = col; j < col + n; j++) t.push([{ c: sub[j].c, h: 1 }, ...body.map((r) => ({ c: r[j].c }))]);
      out.push({ k: 'tbl', rows: t, grp: name });
      col += n;
    }
    return out;
  }
  const LEAD_CHARS = 160;
  const AD_TOGGLE = /^(hide|show|close) (all )?(sponsored|ads?|advertisements?)( results?| content)?$/i;   // (round 6: "result" too)
  function pushBlock(ctx, b) {
    // R57: a table's "click a cell for more" tip says nothing in the view
    if (b.k === 'p' && b.c && b.c.length === 1 && typeof b.c[0] === 'string' && /^tip: (you can )?(click|tap)\b.{0,40}\b(cell|row)/i.test(b.c[0].trim())) return;
    if (ctx.blocks.length >= maxBlocks) { ctx.sh.truncated = true; return; }
    // an ad module's own switch ("Hide sponsored results") goes with the module the view already dropped (P30)
    if (b.k === 'p' && b.c && b.c.some((x) => Array.isArray(x)) && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'btn' && AD_TOGGLE.test((x[2] || '').trim()))) return;
    if (ctx.lm) LANDMARK.add(b);
    if (!ctx.sh.leadSeen && !ctx.inFloat && !ctx.inChrome && b.k === 'p' && b.c && runText(b.c).trim().length >= LEAD_CHARS) ctx.sh.leadSeen = true;
    // R48: a topic map of counts as buttons ("20.7k views", "59 likes", "5 links") is one meta line of views, likes and replies
    if (b.k === 'p' && b.c && b.c.length >= 3) {
      const COUNT = /^[\d.,]+[kKmM]? (views?|likes?|links?|users?|replies|reply|posts?)$/i;
      const btns = b.c.filter((x) => Array.isArray(x));
      if (btns.length >= 2 && btns.every((x) => x[0] === 'btn' && COUNT.test((x[2] || '').trim())) && b.c.every((x) => Array.isArray(x) || !x.trim())) {
        const keep = btns.map((x) => x[2].trim()).filter((t) => /views?|likes?|replies|reply|posts?$/i.test(t));
        if (!keep.length) return;
        b = { k: 'meta', c: [keep.join(' · ')] };
      }
    }
    // R26: a vote control on a line of its own (Hacker News) joins the item's name line, at its right
    if (b.k === 'p' && b.c && voteOnly(b.c) && !b.vote) { ctx.vote = { c: b.c, nest: ctx.nest }; return; }
    if (ctx.vote) {
      // the held vote joins the next line only when that is an item's short name line (a link among few words);
      // otherwise it stays a line of its own, in its place
      const v = ctx.vote; ctx.vote = null;
      if ((b.k === 'p' || b.k === 'li') && b.c && v.nest === ctx.nest && runText(b.c).length <= 80 && b.c.some((x) => Array.isArray(x) && x[0] === 'a')) b.c = b.c.concat([' '], v.c);
      else ctx.blocks.push({ k: 'p', c: v.c, vote: 1 });
    }
    if (ctx.quote && (b.k === 'p' || b.k === 'li')) b.q = ctx.quote;
    if (b.k === 'p' && b.c && typeof b.c[0] === 'string' && /^\s*>\s?\S/.test(b.c[0])) { b.c = [b.c[0].replace(/^\s*>\s?/, ''), ...b.c.slice(1)]; b.q = Math.max(b.q || 0, 1); }   // R44
    if (ctx.nest) { b.depth = Math.min(ctx.nest, 3); if (ctx.nest > 3) b.deep = ctx.nest; }   // three levels; deeper ones fold
    if (ctx.dlg) b.dlg = 1;
    const prev = ctx.blocks[ctx.blocks.length - 1];
    if (prev && prev.k === b.k && (b.k === 'h' || b.k === 'p') && JSON.stringify(prev.c) === JSON.stringify(b.c)) return; // doubled title
    // R26: a lone "reply" under a comment joins the comment's name line (its author, its time), as its one action
    if (b.k === 'p' && b.c && b.c.length <= 3 && b.c.filter((x) => Array.isArray(x)).length === 1 &&
        b.c.every((x) => typeof x === 'string' ? !x.trim() : (x[0] === 'a' || x[0] === 'btn') && /^reply$/i.test(runText([x]).trim()))) {
      for (let i = ctx.blocks.length - 1, n = 0; i >= 0 && n < 12; i--, n++) {
        const q = ctx.blocks[i];
        if (q.depth !== b.depth || q.k !== 'p') continue;
        const nameLine = q.c && q.c.some((x) => Array.isArray(x) && ((x[0] === 'btn' && x[3] && x[3].v) || (x[0] === 'a' && /\b(ago|just now|yesterday)\b/i.test(runText(x.slice(3))))));
        if (nameLine) {
          // R39, R40: name, age, then Reply, then the vote, at the right
          const isVote = (x) => Array.isArray(x) && x[0] === 'btn' && x[3] && x[3].v;
          let k = q.c.length; while (k > 0 && (isVote(q.c[k - 1]) || (typeof q.c[k - 1] === 'string' && !q.c[k - 1].trim()))) k--;
          q.c = q.c.slice(0, k).concat([' · '], b.c.filter((x) => Array.isArray(x)), [' '], q.c.slice(k).filter(isVote));
          return;
        }
      }
    }
    // one row of actions: a paragraph of buttons only joins the button row just before it
    // (a toolbar's list of single buttons too: "Comfortable display density", "Compact display density" are one row)
    const btnOnly = (x) => x && (x.k === 'p' || x.k === 'li') && x.c && x.c.length && x.c.some((r) => Array.isArray(r) && r[0] === 'btn') &&
      x.c.every((r) => (Array.isArray(r) && r[0] === 'btn') || (typeof r === 'string' && r.replace(/\s+/g, '').length <= 6));
    if (btnOnly(b) && btnOnly(prev) && !b.vote && !prev.vote && prev.depth === b.depth && prev.dlg === b.dlg && prev.c.length < 12) {
      if (prev.k === 'li') { prev.k = 'p'; delete prev.d; delete prev.o; delete prev.cont; }
      prev.c.push(' ', ...b.c); return;
    }
    ctx.blocks.push(b);
  }
  // separators left over once dropped controls are gone ("4 hours ago | | [–]"): one at most, none at the ends; a line
  // of nothing but separators and breaks is no line
  const SEPS = /^[\s|·•]*$/;
  function tidy(c) {
    for (let i = 0; i < c.length; i++) if (typeof c[i] === 'string') c[i] = c[i].replace(/\s*([|·•])(\s*[|·•])+\s*/g, ' $1 ');
    if (typeof c[0] === 'string') c[0] = c[0].replace(/^[\s|·•]+/, '');
    const L = c.length - 1;
    if (L >= 0 && typeof c[L] === 'string') c[L] = c[L].replace(/[\s|·•]+$/, '');
    const out = c.filter((x) => x !== '');
    if (!out.some((x) => typeof x === 'string' ? !SEPS.test(x) : x[0] !== 'br')) return [];
    while (out.length && Array.isArray(out[0]) && out[0][0] === 'br') out.shift();
    while (out.length && Array.isArray(out[out.length - 1]) && out[out.length - 1][0] === 'br') out.pop();
    return out;
  }
  function flush(ctx) {
    if (ctx.para) {
      const c = tidy(normRuns(ctx.para));
      ctx.para = null; ctx.target = null;
      if (c.length) {
        const k = ctx.kind || { k: 'p' };
        pushBlock(ctx, Object.assign({}, k, { c }));
        if (ctx.kind && ctx.kind.k === 'li') ctx.kind = Object.assign({}, ctx.kind, { cont: 1 });
      }
    }
  }
  function walk(node, ctx) {
    // the items of a flex or grid row are separate boxes: their words never run together ("115 Following 92.2M Followers")
    let sep = false;
    if (node.nodeType === 1 && node.childElementCount >= 2) {
      let inl = true;
      for (const k of node.children) if (BLOCK.has(LNOF(k))) { inl = false; break; }
      if (inl) { const L = ctx.live(node); if (L) { const d = getComputedStyle(L).display; sep = d.includes('flex') || d.includes('grid'); } }
    }
    for (const ch of kids(node)) {
      if (ctx.sh.truncated) return;
      if (ch.nodeType === 3) addText(ctx, ch.data);
      else if (ch.nodeType === 1) {
        // an inline box set apart by its own margin, padding or display ("Lat: 38.85°N" + "Lon: 77.03°W", links laid
        // out as blocks) never runs into the word before it
        if (!sep && !BLOCK.has(LNOF(ch)) && endsWord(ctx) && gapBefore(ch, ctx)) addText(ctx, ' ');
        elem(ch, ctx); if (sep) addText(ctx, ' ');
      }
    }
  }
  function endsWord(ctx) {
    const t = ctx.target;
    if (!t || !t.length) return false;
    let x = t[t.length - 1];
    for (let i = 0; i < 5 && Array.isArray(x); i++) x = x[0] === 'btn' ? x[2] : x[0] === 'img' || x[0] === 'in' || x[0] === 'sel' || x[0] === 'ta' ? '' : x.length > 1 ? x[x.length - 1] : '';
    return typeof x === 'string' && /[^\s(\[«“'"\/-]$/.test(x);
  }
  function gapBefore(el, ctx) {
    const L = ctx.live(el);
    if (!L || L.nodeType !== 1) return false;
    return setApart(L);
  }
  // whether a box is set apart from what comes before it in its line: by its own display, float, margin or padding,
  // or by the box before it, on its right (a margin, padding, or a mark drawn after it)
  function setApart(L) {
    const cs = getComputedStyle(L);
    if (cs.display === 'none' || cs.display === 'contents') return false;
    if (/^(block|flex|grid|table|list-item|flow-root)$/.test(cs.display) || cs.cssFloat !== 'none') return true;
    if ((parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.paddingLeft) || 0) >= 3) return true;
    // or the box before it set apart on its right, by its margin or padding or a mark drawn after it (a news site's
    // kicker before its headline: "US politics sketch / Hegseth …", never "sketchHegseth")
    const P = isEl(L) ? G_PREV.call(L) : null;
    if (!P) return false;
    const ps = getComputedStyle(P);
    if (ps.display === 'none') return false;
    if ((parseFloat(ps.marginRight) || 0) + (parseFloat(ps.paddingRight) || 0) >= 3) return true;
    const after = getComputedStyle(P, '::after').content;
    return !!after && after !== 'none' && after !== 'normal' && after !== '""';
  }
  function isDataTable(t) {
    const r = (ATTR(t, 'role') || '').toLowerCase();
    if (r === 'presentation' || r === 'none') return false;
    if (QS(t, 'table')) return false;
    if (r === 'table' || r === 'grid' || t.caption || t.tHead || QS(t, 'th')) return true;
    const rows = t.rows.length, cols = rows ? t.rows[0].cells.length : 0;
    return rows >= 2 && cols >= 2 && rows * cols <= 400;
  }
  function cellRuns(cell, ctx) {
    const sub = newCtx(ctx.live, ctx.sh);
    walk(cell, sub); flush(sub);
    const out = [];
    sub.blocks.forEach((b, i) => {
      if (i) out.push(['br']);
      if (b.c) out.push(...b.c);
      else if (b.k === 'img') out.push(['img', b.s, b.a, b.w, b.h]);
      else if (b.t) out.push(b.t);
    });
    return out;
  }
  function pointerStart(L) {
    if (getComputedStyle(L).cursor !== 'pointer') return false;
    const p = L.parentElement;
    return !p || getComputedStyle(p).cursor !== 'pointer';
  }
  function flagsOf(T) {
    const f = {};
    const r = ATTR(T, 'role');
    if (r && r !== 'button') f.r = r;
    for (const [a, k] of [['aria-pressed', 'p'], ['aria-expanded', 'e'], ['aria-selected', 's'], ['aria-checked', 'c']]) {
      const v = ATTR(T, a);
      if (v === 'true') f[k] = 1; else if (v === 'false') f[k] = 0;
    }
    if (T.disabled || ATTR(T, 'aria-disabled') === 'true') f.d = 1;
    if (isPrimary(T)) f.pri = 1;
    return Object.keys(f).length ? f : 0;
  }
  // the page's primary action (a filled, colored button: "Start now", "Add to cart"), so the view keeps its emphasis
  // R68: a profile's own Follow (beside its Following and Followers links) is the profile's action, not a per-item menu
  function profileFollow(T, nm) {
    if (!/^(follow|subscribe)\b/i.test(nm)) return false;
    for (let p = T.parentElement, i = 0; p && p !== document.body && i < 5; p = p.parentElement, i++) if (QS(p, 'a[href$="/followers"],a[href$="/following"],a[href$="/verified_followers"]')) return true;
    return false;
  }
  function isPrimary(T) {
    if (ATTR(T, 'role') === 'tab') return false;       // a selected tab is a tab, not the page's call to action
    if (/(^|[\s_-])(primary|cta|btn-primary|button--primary|govuk-button--start|start-button|emphasi[sz]ed)([\s_-]|$)/i.test(typeof CLSOF(T) === 'string' ? CLSOF(T) : '')) return true;
    const r = RECT(T);
    if (r.height < 30 || r.width < 60) return false;
    if (!/\p{L}/u.test(visText(T))) return false;   // an icon button (a heart, "Save to favorites") is not the page's action
    if (/\b(favou?rites?|wish ?list|save|share|follow|like|compare)\b/i.test(visText(T) || '')) return false;   // a side action, never the primary one
    // the fill is the button's own, or that of an inner box that covers it (IKEA's "Add to bag" paints its span)
    const fills = [T];
    for (const k of T.children) { const kr = RECT(k); if (kr.width * kr.height >= 0.8 * r.width * r.height) fills.push(k); }
    for (const f of fills) {
      const m = getComputedStyle(f).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && +m[4] < 0.5)) continue;
      const [R, G, B] = [+m[1], +m[2], +m[3]];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx - mn >= 60 && mx >= 60) return true;   // saturated: a colored fill, not white, grey or black
    }
    return false;
  }
  function samePageAnchor(T) {
    const h = ATTR(T, 'href') || '';
    if (h.startsWith('#')) return true;
    try { const u = new URL(T.href); return u.hash && u.origin + u.pathname + u.search === location.origin + location.pathname + location.search; } catch (e) { return false; }
  }
  // round 5: a swatch named for its product and itself ("Men's Tree Runner - Navy Night (White Sole) swatch") is its colour
  function swatchName(nm) {
    if (!/\sswatch$/i.test(nm)) return nm;
    nm = nm.replace(/\s+swatch$/i, '');
    const t = MAIN_H1 ? (MAIN_H1.innerText || '').replace(/\s+/g, ' ').trim() : '';
    if (t && nm.toLowerCase().startsWith(t.toLowerCase() + ' - ')) return nm.slice(t.length + 3);
    return nm.replace(/^[^-–—]{3,80}\s[-–—]\s/, '');
  }
  function control(el, L, r, ctx) {
    const T = L || el;
    if (L && LNOF(T) === 'input' && /^(checkbox|radio)$/i.test(T.type || '') && ctx.sh.used.has(L)) return;   // already shown by its label
    const rf = L ? ref(L) : null;
    if (L) ctx.sh.used.add(L);
    ctx.sh.refs++;
    const ln = LNOF(T);
    if (r === 'link') {
      if (SCAN && SCAN.skipLinks.has(T)) return;
      let name = accName(T);
      if (/^skip to\b/i.test(name || '')) return;
      // heading anchors and edit links ("Permalink", "¶", "edit") say nothing in the simplified view
      if (samePageAnchor(T)) {
        const inH = CLOSEST(T, 'h1,h2,h3,h4,h5,h6');
        if (!name || /^(#|¶|§|permalink\b|link to (this )?(section|heading)|anchor\b|(copy )?link for (this )?(heading|section)\b)/i.test(name) || (inH && name.length <= 2)) return;
        // round 4: a heading's own anchor named for it ("Link for Reference", react.dev's) says nothing either
        if (inH && /^(copy )?link (for|to)\b/i.test(name)) return;
      }
      if (/^\[?edit( section| source)?\]?$/i.test(name) && CLOSEST(T, 'h1,h2,h3,h4,h5,h6,.mw-editsection')) return;
      // round 6: a reference's way back up to where it's cited ("Jump up to:", a screen reader's words for "^") goes
      if (/^(jump up( to)?:?|back to (the )?(text|citation|reference)|↑|\^)$/i.test((name || '').trim()) && CLOSEST(T, 'li,ol,.reflist,.references,[role=doc-endnotes]')) return;
      const href = safeHref(T.href || ATTR(T, 'href') || '');
      // round 6: the site's logo going home ("Go to Google home") is the site row's, never a picture in the reading
      if (name && /^(go (to|back to) )?(the )?.{0,40}\bhome( ?page)?$/i.test(name) && !(txt(T) || '').trim() && QS(T, 'img,svg') && !ctx.dlg) {
        try { const u = new URL(T.href, location.href); if (u.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '') && /^\/?(webhp)?$/.test(u.pathname.replace(/\/$/, ''))) return; } catch (e) { /* */ }
      }
      // a link around a picture (a figure, a lightbox) is the picture, at its size on the page
      const im = QS(T, 'img');
      if (im) {
        const Li = ctx.live(im) || im;
        const [w, h] = imgDims(ctx.live(im), im);
        const linkText = (txt(T) || '').replace(/\s+/g, ' ').trim();
        if (((w >= 96 && h >= 64) || w >= 120) && linkText.length < 60) {
          const s = imgSrc(ctx.live(im), im);
          if (s) { flush(ctx); pushBlock(ctx, { k: 'img', s, a: clip(ATTR(Li, 'alt') || name, 200), w, h, rw: w, rh: h, r: rf, u: href }); return; }
        }
        if (w >= 120 && h >= 64 && linkText.length >= 60) {
          // a picture inside a long link (a story teaser): the picture at its size, then the link's words
          const s = imgSrc(ctx.live(im), im);
          if (s && name) { flush(ctx); pushBlock(ctx, { k: 'img', s, a: clip(ATTR(Li, 'alt') || '', 200), w, h, rw: w, rh: h, r: rf, u: href }); addRun(ctx, ['a', rf, href, name]); return; }
        }
      }
      if (name && UPVOTE.test(name)) { addRun(ctx, ['btn', rf, '▲', { aria: 'Upvote', v: 1 }]); return; }
      if (name && DOWNVOTE.test(name)) { addRun(ctx, ['btn', rf, '▼', { aria: 'Downvote', v: 1 }]); return; }
      if (name && !/[\p{L}\p{N}]/u.test(name)) return;   // "[–]", "»": a glyph is no name
      if (name && ITEM_MENU.test(name) && !CLOSEST(T, 'nav,header,[role=navigation],[role=banner]')) return;
      if (name && SIGNUP_CTA.test(name) && !CLOSEST(T, 'form,dialog,[role=dialog]')) return;   // R6
      // R39: a thread's own navigation inside a comment (parent, next, prev, root, context, past, favorite, hide, flag)
      if (ctx.nest && name && /^(parent|next|prev|previous|root|context|past|favorite|favourite|hide|flag|un-?vote|un-?hide)$/.test(name)) return;
      if (name && GALLERY_CTL.test(name)) return;
      // round 5: a player's controls drawn as links to the page itself (the Internet Archive's "Click to mute"): the
      // island has its own
      if (name && PLAYER_CTL.test(name) && SCAN && SCAN.islands.length && samePageAnchor(T)) return;
      let inner;
      if (!name) {
        // a link whose text is its URL shows the host and path, shortened, never the URL itself
        const raw = clip(txt(T), 300);
        if (/^(https?:\/\/|www\.)\S+$/i.test(raw) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw)) name = shortUrl(T.href || raw);
      }
      const imSrc = im && !okName(txt(T)) ? imgSrc(ctx.live(im), im) : '';
      if (imSrc) inner = [['img', imSrc, name || '', ...imgDims(ctx.live(im), im)]];   // R36: a badge is its image, not its alt text
      else if (name) inner = [name];
      else if (im) {
        const s = imgSrc(ctx.live(im), im);
        if (!s) { ctx.sh.unnamed++; return; }
        inner = [['img', s, '', ...imgDims(ctx.live(im), im)]];
      } else { ctx.sh.unnamed++; return; }          // never show an href as link text
      addRun(ctx, ['a', rf, href, ...inner]);
      return;
    }
    if (ln === 'input') {
      const t = (T.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') {
        const nm = accName(T);
        if (!nm) { ctx.sh.unnamed++; return; }
        addRun(ctx, ['btn', rf, nm, flagsOf(T)]); return;
      }
      const o = { t, l: accName(T) };
      if (t === 'password') { o.v = ''; o.n = (T.value || '').length; }
      else if (t === 'checkbox' || t === 'radio') { o.c = T.checked ? 1 : 0; if (T.name) o.g = T.name; }
      else { o.v = T.value || ''; if (T.placeholder && okName(T.placeholder)) o.p = T.placeholder; }
      if (T.disabled) o.d = 1;
      addRun(ctx, ['in', rf, o]);
      if ((t === 'checkbox' || t === 'radio') && !o.l) ctx.sh.unnamed++;
      return;
    }
    if (ln === 'select') {
      const opts = Array.from(T.options).slice(0, 300).map((op) => [op.value, clip(op.text, 80)]);
      addRun(ctx, ['sel', rf, { v: T.value, o: opts, l: accName(T), d: T.disabled ? 1 : 0 }]);
      return;
    }
    if (ln === 'textarea') {
      const o = { v: T.value || '', p: okName(T.placeholder || ''), l: accName(T) };
      if (!o.l && !o.p) { const f = T.form || CLOSEST(T, 'form'); const b = f && QS(f, 'button,input[type=submit]'); o.l = clip((b && (b.innerText || b.value)) || 'Text', 40); }
      if (T.rows <= 1 || /^(combobox|searchbox)$/.test(ATTR(T, 'role') || '')) o.enter = 1;
      addRun(ctx, ['ta', rf, o]);
      return;
    }
    // R55: a live code demo's editor (CodeMirror's lines) is a code block of its own lines, never its flattened value
    if (T.isContentEditable) {
      const ls = Array.from(QSA(T, '.cm-line,.CodeMirror-line,.view-line'));
      if (ls.length >= 2) {
        flush(ctx);
        const t = ls.map((l) => (l.textContent || '').replace(/\u200b/g, '')).join('\n');
        const b = { k: 'pre', t: t.slice(0, 20000), lines: ls.length, demo: 1 };
        // its title and the site's own Run and Reset (Run presses the real button; the output arrives under it)
        const d = demoBar(T);
        if (d) {
          if (d.title) {
            b.n = d.title;
            const last = ctx.blocks[ctx.blocks.length - 1];
            if (last && last.k === 'h' && runText(last.c || []).replace(/\s+/g, ' ').trim() === d.title) ctx.blocks.pop();
          }
          if (d.bar.length) b.bar = d.bar;
        }
        pushBlock(ctx, b);
        return;
      }
    }
    if (r === 'textbox' || r === 'searchbox' || r === 'combobox' && T.isContentEditable) {
      addRun(ctx, ['in', rf, { t: 'text', v: clip(txt(T), 2000), l: accName(T), ce: 1 }]);
      return;
    }
    if (r === 'checkbox' || r === 'radio' || r === 'switch') {
      const nm = accName(T);
      addRun(ctx, ['in', rf, { t: r === 'radio' ? 'radio' : 'checkbox', c: ATTR(T, 'aria-checked') === 'true' ? 1 : 0, l: nm, aria: 1 }]);
      return;
    }
    // round 5: a button that shows only a picture of 48 px or more is that picture, and the real page picks among them.
    // A product gallery's (Allbirds' photos, each a zoom button) shows its first picture at its size and leaves the
    // rest to the real page; a strip of small thumbnails stays a strip
    {
      const im = QS(T, 'img');
      if (im && !visText(T).replace(/\s+/g, '')) {
        const ri = RECT(im), src = ri.width >= 48 && ri.height >= 48 ? imgSrc(ctx.live(im) || im, im) : '';
        if (src) {
          const [w, h] = imgDims(ctx.live(im) || im, im);
          if (ri.width >= 200 && ri.height >= 120) {
            let g = T.parentElement;
            for (let i = 0; g && g !== document.body && i < 5 && QSA(g, 'button img,[role=button] img').length < 2; i++) g = g.parentElement;
            const shown = ctx.sh.galleries || (ctx.sh.galleries = new Set());
            if (g && shown.has(g)) return;
            if (g) shown.add(g);
            flush(ctx);
            pushBlock(ctx, { k: 'img', s: src, a: clip(ATTR(im, 'alt') || '', 200), w, h, rw: w, rh: h });
            return;
          }
          addRun(ctx, ['img', src, clip(ATTR(im, 'alt') || '', 200), w, h]);
          return;
        }
      }
    }
    let nm = accName(T);
    if (!nm) { ctx.sh.unnamed++; return; }          // an icon button with no name is noise
    // round 5: a shop's badge drawn on a control that names itself otherwise (a swatch's "SALE" over its picture) is
    // the badge on that name: "Jet Black (Black Sole) · SALE"
    if (/^(sale|new|hot|final sale|sold out|low stock|limited( edition)?|best ?seller|\d{1,2}% off)$/i.test(nm)) {
      const im = QS(T, 'img');
      const own = ((ATTR(T, 'aria-label') || (im && ATTR(im, 'alt')) || ATTR(T, 'title') || '') + '').replace(/\s+/g, ' ').trim();
      if (own.length > nm.length && !own.toLowerCase().includes(nm.toLowerCase())) nm = swatchName(own) + ' · ' + nm;
    }
    nm = swatchName(nm);
    // a table cell's toggle that shows a value (a compatibility table's "12") is that value, as text
    if (CLOSEST(T, 'td,th,[role=cell],[role=gridcell]')) { const v = visText(T).replace(/\s+/g, ' ').trim(); if (v && /^[\d.,\s–—-]+$/.test(v)) { addText(ctx, v); return; } }
    if (/^(close|dismiss|×|✕|✖|x|close (menu|panel|drawer|dialog|banner))$/i.test(nm) && !ctx.dlg) return;   // it closes the site's chrome
    if (ENGINE_TOOL.test(nm) && !ctx.dlg) return;   // round 5: an engine's own tools
    // round 6: and an engine's AI chat's own buttons over its results ("New thread", its "Settings")
    if (/^(new (thread|chat|conversation)|settings|quick settings)$/i.test(nm) && (ln === 'button' || ATTR(T, 'role') === 'button') && !CLOSEST(T, 'form,dialog,[role=dialog],nav,header') && !ctx.dlg && !ctx.inChrome) return;
    if (/^(scan to get the app|get the app|download (the|our) app|open in (the )?app|use the app)$/i.test(nm) && !ctx.dlg) return;   // round 5: an app's promo
    // round 6: a word's pronunciation button in running text ("[ˈʃtaːtlɪçəs ˈbaʊˌhaʊs] Play audio", Wikipedia's) plays
    // only on the real page
    if (/^(play|listen to)( the)? (audio|pronunciation|sound)( file)?$|^listen$/i.test(nm) && CLOSEST(T, 'p,td,th,li,dd,.IPA,[class*=pronunc i]') && !ctx.dlg) return;
    // round 5: a list's own density and layout switches ("Compact display density", "Grid view") are the view's to decide
    if (/\bdisplay density\b|^(list|grid|card|table|tile|compact|comfortable)s? (view|layout|density)$|^(switch to|view as|show as) (a )?(list|grid|cards?|table)( view)?$/i.test(nm)) return;
    if (/^skip to\b/i.test(nm)) return;                                                                        // a skip button
    // a player's own controls beside an island ("Play", "Mute", "Picture-in-Picture"): the island has its own
    if ((PLAYER_CTL.test(nm) || /^\d+:\d{2}( \/ \d+:\d{2})?$/.test(nm)) && SCAN && SCAN.islands.length) {
      for (let p = T.parentElement, i = 0; p && i < 7; p = p.parentElement, i++) if (QS(p, 'video,iframe') || SCAN.islandOf.has(p)) return;
    }
    if (SIGNUP_CTA.test(nm) && !CLOSEST(T, 'form,dialog,[role=dialog]')) return;   // R6: a sign-up prompt in the page's chrome
    if (/\b(edit history|edited|revisions?|link clicks?)\b/i.test(nm) && /^[\d.,]+/.test(nm)) return;   // R48: edit counts and link click counts
    // R63: a slideshow's or carousel's own Previous, Next and Full screen drop (the view shows its current picture)
    if (/^(previous|next|prev|full ?screen|enter full ?screen)( slide| photo| image| item| story)?$/i.test(nm) &&
        CLOSEST(T, '[class*=carousel i],[class*=slideshow i],[class*=slider i],[class*=swiper i],[class*=gallery i],[class*=glide i],[class*=splide i],[class*=slick i],[aria-roledescription=carousel]')) return;
    if (GALLERY_CTL.test(nm)) {
      // a gallery's thumbnail buttons become the gallery: their pictures, in a row (never their "Select photo 3 of 9")
      const im = QS(T, 'img');
      if (im) { const Li = ctx.live(im) || im, src = imgSrc(Li, im); if (src) addRun(ctx, ['img', src, clip(ATTR(Li, 'alt') || '', 120), ...imgDims(Li, im), 'g']); }
      return;
    }
    if (UPVOTE.test(nm)) { addRun(ctx, ['btn', rf, '▲', Object.assign(flagsOf(T) || {}, { aria: 'Upvote', v: 1 })]); return; }   // R26
    if (DOWNVOTE.test(nm)) { addRun(ctx, ['btn', rf, '▼', Object.assign(flagsOf(T) || {}, { aria: 'Downvote', v: 1 })]); return; }
    if (/^copy (page|(as )?markdown)$/i.test(nm)) return;   // round 4: a docs page's copy-for-an-assistant button
    if (ITEM_MENU.test(nm) && !CLOSEST(T, 'nav,header,[role=navigation],[role=banner],form') && !isPrimary(T) && !profileFollow(T, nm)) return;   // R26, one quiet action row
    if (!/[\p{L}\p{N}]/u.test(nm)) return;
    // R2: the site's own copy button next to code (the view has its own Copy)
    if (/^copy( code)?( to clipboard)?$|copy code to clipboard/i.test(nm) && T.closest) {
      let near = !!CLOSEST(T, 'pre');
      for (let p = T.parentElement, i = 0; p && !near && i < 3; p = p.parentElement, i++) if (QS(p, 'pre')) near = true;
      if (near) return;
    }
    addRun(ctx, ['btn', rf, nm, flagsOf(T)]);
  }
  function media(el, L, ctx, m) {
    const T = L || el;
    const rc = L ? RECT(L) : { width: +ATTR(T, 'width') || 0, height: +ATTR(T, 'height') || 0 };
    if (rc.width * rc.height < 200 * 120) return;   // tracking pixels, small widgets
    flush(ctx);
    // no URL is ever shown; a frame the distiller can't read is a quiet placeholder
    pushBlock(ctx, { k: 'media', m, w: Math.round(rc.width), h: Math.round(rc.height), n: clip(ATTR(T, 'title') || ATTR(T, 'aria-label') || '', 80) });
  }
  function dropCount(ctx, cat) { ctx.sh.dropped[cat] = (ctx.sh.dropped[cat] || 0) + 1; }
  function chromeInto(el, L, ctx, kind) {
    // round 5: a list's own "Page 2" or "Next" in a nav of its own (Lobsters') is how the list goes on: it stays where
    // it is, at the list's end, as the page's next link (R16), never in the menu
    if (kind === 'nav' && L && !ctx.inChrome) {
      const ls = Array.from(QSA(L, 'a[href]')).filter((a) => vis(a));
      const nx = ls.length <= 3 && ls.find((a) => /\bnext\b/i.test(ATTR(a, 'rel') || '') && /^(page \d+|next( page)?|more|older( (posts|stories))?)\s*[›»>→]*$/i.test((a.innerText || '').trim()));
      if (nx) {
        flush(ctx);
        pushBlock(ctx, { k: 'p', c: [['a', ref(nx), safeHref(nx.href || ''), { next: 1 }, clip((nx.innerText || '').replace(/\s+/g, ' ').trim(), 40)]] });
        ctx.sh.used.add(nx);
        return;
      }
    }
    // walk the region into the menu: fields (search) go to the bar row, links and buttons to the group
    const g = newCtx(ctx.live, ctx.sh);
    g.inChrome = true;
    walk(el, g); flush(g);
    const runs = [];
    for (const b of g.blocks) {
      const take = (x) => {
        if (!Array.isArray(x)) return;
        if (x[0] === 'in' || x[0] === 'ta' || x[0] === 'sel') {
          const o = x[2] || {};
          const isSearch = x[0] !== 'sel' && (/search|^q$|find/i.test((o.l || '') + ' ' + (o.p || '') + ' ' + (o.t || '')) || o.t === 'search' || o.t === 'text');
          if (isSearch && ctx.sh.bar.some((y) => y[0] === x[0] && JSON.stringify(y.slice(2)) === JSON.stringify(x.slice(2)))) { /* the same field twice */ }
          else if (isSearch && ctx.sh.bar.filter((y) => y[0] !== 'btn').length < 2) { ctx.sh.bar.push(x); ctx.sh.barForm = true; }
          else runs.push(x);
        } else if (x[0] === 'btn' && ctx.sh.barForm && /^(search|go|submit|find)$/i.test(x[2] || '') && !ctx.sh.bar.some((y) => y[0] === 'btn')) {
          ctx.sh.bar.push(x);
        } else if (x[0] === 'a' || x[0] === 'btn') runs.push(x);
        else if (FMT_RUN.has(x[0])) x.slice(1).forEach(take);
      };
      for (const x of b.c || []) take(x);
      if (b.k === 'card') { const t = b.c.find((x) => Array.isArray(x) && x[0] === 'a' && typeof x[3] === 'string'); if (t) runs.push(t); }
    }
    // round 5: a site's side menu that also holds the page's own contents (Python's docs: 19 links to this page's
    // sections among its Previous, Next and Report a bug) gives those to Contents
    if (kind === 'nav' || kind === 'header') {
      const here = (x) => { try { const u = new URL(x[2], location.href); return !!u.hash && u.hash.length > 1 && u.origin + u.pathname === location.origin + location.pathname; } catch (e) { return false; } };
      const own = runs.filter((x) => x[0] === 'a' && here(x));
      if (own.length >= 6) {
        ctx.sh.menu.push({ kind: 'toc', n: 'Contents', c: own });
        const rest = runs.filter((x) => !own.includes(x));
        if (rest.length) ctx.sh.menu.push({ kind, n: menuName(el, kind), c: rest });
        return;
      }
    }
    if (runs.length) ctx.sh.menu.push({ kind, n: menuName(el, kind), c: runs });
  }
  function menuName(el, kind) {
    if (kind !== 'filters' && kind !== 'toc') return CHROME_NAME[kind] || 'Site menu';
    const l = ATTR(el, 'aria-label');
    return l && l.length < 40 ? clip(l, 40) : CHROME_NAME[kind];
  }
  function elem(el, ctx) {
    const ln = LNOF(el);
    if (SKIP.has(ln)) return;
    const L = ctx.live(el);
    if (L) {
      if (ctx.sh.skip.has(L)) return;
      if (!vis(L)) {
        if (ATTR(L, 'aria-hidden') === 'true' && !L.hidden && L.querySelectorAll && SCAN) {
          // players mark their video wrapper aria-hidden: a player inside one is still an island
          for (const c of SCAN.islands) if (CONTAINS(L, c.box) && !ctx.sh.used.has(c.box)) { ctx.sh.used.add(c.box); flush(ctx); pushBlock(ctx, islandBlock(c)); }
        }
        return;
      }
      if ((POSTS.size || TOPIC_POSTS.size) && !ctx.inPost) {
        const pid = IDOF(L);
        if (pid && POST_ID.test(pid) && (POSTS.has(pid) || TOPIC_POSTS.has(pid)) && (L.textContent || '').trim().length < 80) {
          flush(ctx);
          if (POSTS.has(pid)) for (const b of POSTS.get(pid)) pushBlock(ctx, Object.assign({}, b));
          else for (const b of JSON.parse(TOPIC_POSTS.get(pid))) pushBlock(ctx, b);
          return;
        }
      }
      if (SCAN) {
        const j = SCAN.junk.get(L);
        if (j) {
          if (j === 'related' && !ctx.inChrome && !ctx.inRecirc && !ctx.sh.related) {
            // at most one shelf of the same site's related items, kept at the end
            const g = newCtx(ctx.live, ctx.sh); g.inRecirc = true;
            walk(el, g); flush(g);
            if (g.blocks.length) { ctx.sh.related = { n: clip(SCAN.relatedName.get(L) || 'Related', 60), c: g.blocks }; KEPT_RELATED = L; }
            return;
          }
          if (!ctx.inRecirc || j !== 'related') { dropCount(ctx, j); return; }
        }
        if (SCAN.promoPlayers.has(L)) {
          const s = SCAN.promoPlayers.get(L), r = RECT(L);
          if (s) { flush(ctx); pushBlock(ctx, { k: 'img', s: s.slice(0, 300), a: '', w: Math.round(r.width), h: Math.round(r.height), rw: Math.round(r.width), rh: Math.round(r.height) }); }
          return;
        }
        const isl = SCAN.islandOf.get(L);
        if (isl) {
          ctx.sh.used.add(L);
          flush(ctx); pushBlock(ctx, islandBlock(isl));   // in place, where the player sits in the content
          return;
        }
        const ck = SCAN.chrome.get(L);
        if (ck && !ctx.inChrome) { chromeInto(el, L, ctx, ck); return; }
        // R26: a post's vote container (up, score, down) is one group in reading order; its other links ("Timeline",
        // bookmark) stay out of it, after it
        if (!ctx.inChrome && L.childElementCount >= 2 && /vot(e|ing)/i.test((IDOF(L) || '') + ' ' + (CLSOF(L) || ''))) {
          const ctl = Array.from(QSA(L, 'button,a[href],[role=button]'));
          const up = ctl.find((x) => UPVOTE.test(accName(x) || '')), down = ctl.find((x) => DOWNVOTE.test(accName(x) || ''));
          if (up && down) {
            let score = '', scoreEl = null;
            for (const e of QSA(L, '*')) { if (CONTAINS(e, up) || CONTAINS(e, down) || e.childElementCount) continue; const t = (e.textContent || '').trim(); if (/^[-−]?[\d.,]+[kKmM]?$/.test(t)) { score = t; scoreEl = e; break; } }
            flush(ctx);
            const c = [['btn', ref(up), '▲', { aria: 'Up vote', v: 1 }]];
            if (score) c.push(' ' + score + ' ');
            c.push(['btn', ref(down), '▼', { aria: 'Down vote', v: 1 }]);
            ctx.sh.used.add(up); ctx.sh.used.add(down);
            pushBlock(ctx, { k: 'p', c, vote: 1 });
            const skip = new Set([up, down, scoreEl]);
            const rest = newCtx(ctx.live, ctx.sh); rest.nest = ctx.nest;
            for (const x of ctl) if (!skip.has(x) && !CONTAINS(up, x) && !CONTAINS(down, x)) { const r = role(x); if (r) control(x, x, r, rest); }
            flush(rest);
            for (const rb of rest.blocks) pushBlock(ctx, rb);
            return;
          }
        }
        // round 4: a site's announcement banner above the page's title, which the member can dismiss (a forum's notice
        // with its list of links, Discourse's #banner) is one small notice, as the site's own notices are, never a long
        // run of content before the page
        if (!ctx.inChrome && SCAN.h1 && /(^|[\s_-])banner([\s_-]|$)/i.test((IDOF(L) || '') + ' ' + (typeof CLSOF(L) === 'string' ? CLSOF(L) : '')) &&
            (NP.compareDocumentPosition.call(L, SCAN.h1) & 4) && !QS(L, 'h1') && (L.textContent || '').length >= 300 && (L.textContent || '').length < 8000 &&
            Array.from(QSA(L, 'button,[role=button],a[href]')).slice(0, 40).some((b) => [accName(b), ATTR(b, 'aria-label'), ATTR(b, 'title')].some((n) => DISMISS_BTN.test((n || '').replace(/[\s\u200b]+/g, ' ').trim())))) {
          flush(ctx);
          const nb = consentBlock(L, ctx.sh, true);
          const c = [nb.c[0].replace(/[\s\u200b]+/g, ' ').trim()];
          const link = nb.x.find((x) => x[0] === 'a' && !DISMISS_BTN.test(runText(x.slice(3)).trim()));
          if (link) c.push(' ', link);
          pushBlock(ctx, { k: 'p', c, banner: 1 }); return;
        }
        // a site-wide banner (a weather service's national hazard note) whose heading is an h1 is not the page's title:
        // it stays as one small notice with its links, and the page's own heading leads
        if (!ctx.inChrome && SITE_BANNER.test((IDOF(L) || '') + ' ' + (CLSOF(L) || '')) && QS(L, 'h1') && (L.textContent || '').length < 1500) {
          flush(ctx); const nb = consentBlock(L, ctx.sh, true); nb.k = 'notice'; pushBlock(ctx, nb); return;
        }
        if (SCAN.posts && SCAN.posts.has(L) && !ctx.inChrome) {
          flush(ctx);
          const pc = postCard(L, ctx);
          const ibs = [];
          for (const c of SCAN.islands) if (CONTAINS(L, c.box) && !ctx.sh.used.has(c.box)) { ctx.sh.used.add(c.box); ibs.push(islandBlock(c)); }
          // a post whose media is a video: its card's picture is the video's poster, flagged with the island's ref
          // (`isl`): the island right after the card plays it, and a renderer draws one or the other, never both
          const hasPic = pc.c.some((x) => Array.isArray(x) && x[0] === 'a' && Array.isArray(x[3]) && x[3][0] === 'img');
          if (!hasPic && ibs.length && ibs[0].poster) {
            const st = pc.c.find((x) => Array.isArray(x) && x[0] === 'a' && /\/(status|statuses|posts?|p)\//.test(x[2] || ''));
            pc.c.push(['br'], ['a', st ? st[1] : ibs[0].r, st ? st[2] : '', ['img', ibs[0].poster, 'Video', ibs[0].w, ibs[0].h, { isl: ibs[0].r }]]);
          }
          pushBlock(ctx, pc);
          for (const ib of ibs) pushBlock(ctx, ib);
          return;
        }
        const tiles = SCAN.tiles.get(L);
        if (tiles && !ctx.inChrome) {
          flush(ctx);
          const g = ref(L);
          // round 5: a row of pictures with no names (a recipe's cooks' photos, the last one "4,927" more) is a row of
          // pictures, never cards titled by a count
          const named = (t) => { const x = (t.innerText || '').replace(/\s+/g, ' ').trim(); return x && !/^[+]?[\d.,]+[kKmM]?\+?( (more|photos?|images?|pictures?))?$/i.test(x); };
          if (!tiles.some(named)) {
            const c = [];
            for (const t of tiles) {
              const im = cardImg(t), src = im && imgSrc(im, im);
              if (src) { if (c.length) c.push(' '); c.push(['img', src, clip(ATTR(im, 'alt') || '', 160), ...imgDims(im, im)]); }
              ctx.sh.used.add(t);
            }
            if (c.length) pushBlock(ctx, { k: 'p', c });
            for (const ch of L.children) if (!tiles.includes(ch)) { elem(ch, ctx); flush(ctx); }
            return;
          }
          const textOf = (t) => {
            const lines = [];
            const tw = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
            for (let n = tw.nextNode(); n; n = tw.nextNode()) { const x = n.data.replace(/\s+/g, ' ').trim(); if (x && n.parentElement && vis(n.parentElement)) lines.push(x); }
            return lines;
          };
          const texts = tiles.map(textOf);
          // round 5: tiles that say more than their name and sell nothing (a forecast's days: "High: 66 °F · Chance
          // Rain") read as a list, each with its picture and its line; a shop's tiles stay a grid
          const lay = !texts.some((ls) => PRICE.test(ls.join(' '))) && texts.filter((ls) => ls.length > 1).length >= 0.5 * tiles.length ? 'list' : 'grid';
          tiles.forEach((t, i) => {
            const im = cardImg(t), lines = texts[i];
            const c = [];
            if (im) { const src = imgSrc(im, im); if (src) c.push(['img', src, clip(ATTR(im, 'alt') || '', 160), ...imgDims(im, im)]); }
            if (lines[0]) c.push(['b', lines[0]]);
            if (lines.length > 1) c.push(['br'], lines.slice(1).join(' · '));
            const card = { k: 'card', g, lay, title: lines[0] || '', c, rep: tiles.length, tile: 1 };
            if (lay === 'list' && lines.length > 1) card.meta = lines.slice(1).join(' · ');
            pushBlock(ctx, card);
            ctx.sh.used.add(t);
          });
          for (const ch of L.children) if (!tiles.includes(ch)) { elem(ch, ctx); flush(ctx); }
          return;
        }
        const items = SCAN.cards.get(L);
        if (items && !ctx.inChrome) {
          // the list's own order: runs of cards as card blocks, anything else (a heading, a carousel) walked as content
          flush(ctx);
          const set = new Set(items);
          let run = [];
          const videoPage = SCAN.islands.some((c) => c.main);
          const emit = () => {
            if (!run.length) return;
            const bs = cardsBlock(L, run, ctx).map((b) => Object.assign(b, { rep: items.length }));
            // R20: on a video page Up next shows six cards, then "More videos"
            const shown = videoPage && bs.length > 6 ? bs.slice(0, 6) : bs;
            for (const b of shown) pushBlock(ctx, b);
            if (shown.length < bs.length) { flush(ctx); pushBlock(ctx, { k: 'group', n: 'More videos', fold: 1, c: bs.slice(6) }); }
            for (const c of run) ctx.sh.used.add(c); run = [];
          };
          const kids = Array.from(L.children);
          for (let k = 0; k < kids.length; k++) {
            const ch = kids[k];
            if (set.has(ch)) { run.push(ch); continue; }
            // round 6: a shop's promotion tile set among its results, a few words and a link ("Holiday baking from $1",
            // Target's), between two of the list's items, isn't one of them nor the page's reading
            if (run.length && kids.slice(k + 1).some((x) => set.has(x)) && !QS(ch, 'h1,h2,h3,input,select,textarea,video') && QS(ch, 'a[href]') &&
                (ch.innerText || '').replace(/\s+/g, ' ').trim().length <= 60 && QSA(ch, 'a[href]').length <= 2) { dropCount(ctx, 'promo'); continue; }
            emit();
            elem(ch, ctx); flush(ctx);
          }
          emit();
          return;
        }
        const d = SCAN.depth.get(L);
        if (d !== undefined) { flush(ctx); const prev = ctx.nest; ctx.nest = d; walkBlock(el, ctx); ctx.nest = prev; return; }
      }
      // comments under an article or a video fold into one line with their count (spec 5); on a forum they are the page
      const ctoks = (!ctx.inFold && (ctx.junk || (SCAN && SCAN.islands.some((c) => c.main)))) ? tokensOf(ln + ' ' + (IDOF(L) || '') + ' ' + (typeof CLSOF(L) === 'string' ? CLSOF(L) : '')) : [];
      if (!ctx.inFold && (ctoks.includes('comments') || (ctoks.length && SCAN && SCAN.commentSections.has(L)) || (ctoks.includes('comment') && QSA(L, '[class*=comment i]').length >= 3)) &&
          (ctx.junk || (SCAN && SCAN.islands.some((c) => c.main))) && (L.innerText || '').length > 80 && !(SCAN && SCAN.h1 && CONTAINS(L, SCAN.h1))) {
        const g = newCtx(ctx.live, ctx.sh); g.inFold = true; g.pointerHeuristic = ctx.pointerHeuristic;
        walk(el, g); flush(g);
        if (g.blocks.length) {
          flush(ctx);
          // the section's own heading ("5,237 Comments") stays as the heading of the one fold-out line
          const hd = g.blocks[0].k === 'h' && /comment/i.test(runText(g.blocks[0].c || [])) ? g.blocks.shift() : null;
          if (hd) pushBlock(ctx, hd);
          pushBlock(ctx, { k: 'group', n: hd ? 'Show comments' : 'Comments', fold: 1, c: g.blocks.slice(0, 3000) });
        }
        return;
      }
      if (ctx.junk && (CLISTOF(L).length || IDOF(L)) && isJunk(L)) {
        // a topic's navigation box (a wiki's navbox) is navigation, not junk: it folds into the menu, a tap away (§8)
        if (!ctx.inChrome && Array.from(CLISTOF(L)).some((c) => /^(vertical-)?navbox$/i.test(c)) && QSA(L, 'a[href]').length >= 3) chromeInto(el, L, ctx, 'navbox');
        return;   // v1's article-mode rule (share bars, promos)
      }
      // breadcrumbs: one quiet line of links ("Recipes › Desserts › Cookies"), not a list
      if (!ctx.inChrome && /breadcrumb/i.test((ATTR(L, 'aria-label') || '') + ' ' + (IDOF(L) || '') + ' ' + (typeof CLSOF(L) === 'string' ? CLSOF(L) : '')) && QSA(L, 'a[href]').length >= 2 && (L.innerText || '').length < 400) {
        const g = newCtx(ctx.live, ctx.sh); g.inChrome = true;
        walk(el, g); flush(g);
        const links = [];
        for (const b of g.blocks) for (const x of b.c || []) if (Array.isArray(x) && x[0] === 'a') links.push(x);
        if (links.length) { flush(ctx); const c = []; links.forEach((x, i) => { if (i) c.push(' › '); c.push(x); }); pushBlock(ctx, { k: 'meta', c, crumbs: 1 }); }
        return;
      }
      // R30: the accepted answer is marked where it sits, never moved
      if ((CLISTOF(L).contains('accepted-answer') || ATTR(L, 'itemprop') === 'acceptedAnswer') && !ctx.markedAccepted) {
        ctx.markedAccepted = true; flush(ctx); pushBlock(ctx, { k: 'meta', c: ['✓ Accepted answer'], accepted: 1 });
      }
      // parked off the page to the left or above it, or a 1-pixel screen-reader box: not part of what a person sees
      if (ln !== 'a' && ln !== 'button' && ln !== 'input' && ln !== 'img' && !FMT[ln]) {
        const rr = RECT(L);
        // measured against the body's own box: a pop-up's scroll lock (body fixed at top: -Ypx) moves the whole page up
        const bt = BODY_BOX ? BODY_BOX.top : -scrollY, bl = BODY_BOX ? BODY_BOX.left : -scrollX;
        if ((rr.right - bl <= 0 || rr.bottom - bt <= 0) && rr.width + rr.height > 0 && /^(absolute|fixed)$/.test(getComputedStyle(L).position)) { dropCount(ctx, 'offscreen'); return; }
        // an off-canvas drawer (a cart, a menu) parked past the right edge of the window, fixed in place
        if (rr.left >= innerWidth - 1 && rr.width > 0 && getComputedStyle(L).position === 'fixed') { dropCount(ctx, 'offscreen'); return; }
        // (a screen-reader text box: a 1-pixel element holding only text; never a <slot> or a display:contents wrapper)
        if (rr.width <= 2 && rr.height <= 2 && L.childElementCount === 0 && ln !== 'slot' && !L.shadowRoot &&
            L.firstChild && L.firstChild.nodeType === 3 && L.textContent.trim() && getComputedStyle(L).display !== 'contents') {
          // round 5: a price drawn for the eye and hidden from screen readers (aria-hidden "$19.99"), beside this box
          // that says it for them ("Price $ 19.99"): the walk skipped the drawn one as hidden, so it's read here, once
          const twin = shownTwin(L);
          if (twin) { if (endsWord(ctx)) addText(ctx, ' '); addText(ctx, twin); return; }
          dropCount(ctx, 'offscreen'); return;
        }
      }
    }
    // a box floated beside the opening text (an encyclopedia's infobox, a thumbnail and its caption) is read after the
    // text it sits beside: its blocks are marked `fl`, and assemble moves those before the lead to the lead's end
    if (L && !ctx.inFloat && !ctx.inChrome && !ctx.inFold && !ctx.sh.leadSeen && FLOAT_HOST.has(ln) && floatedBox(L)) {
      flush(ctx);
      const start = ctx.blocks.length;
      ctx.inFloat = true;
      try { elem(el, ctx); } finally { ctx.inFloat = false; }
      flush(ctx);
      for (let i = start; i < ctx.blocks.length; i++) ctx.blocks[i].fl = 1;
      return;
    }
    ctx.sh.nodes++;
    switch (ln) {
      case 'video': case 'audio': return;   // a playable video is an island (above); a small clip or audio is skipped
      case 'canvas': case 'iframe': case 'embed': case 'object':
        media(el, L, ctx, ln === 'object' ? 'embed' : ln); return;
      case 'svg': case 'math': {
        const t = ATTR(el, 'aria-label');
        if (t && ln === 'math') addText(ctx, t);
        return;
      }
      case 'img': {
        const s = imgSrc(L, el);
        const [w, h] = imgDims(L, el);
        if (!s || (w && w < 16) || (h && h < 16)) return;
        const alt = clip(ATTR(el, 'alt') || '', 200);
        if ((w >= 96 && h >= 64) || w >= 120 || (!w && !h)) { flush(ctx); pushBlock(ctx, { k: 'img', s, a: alt, w, h, rw: w, rh: h }); }
        else addRun(ctx, ['img', s, alt, w, h]);
        return;
      }
      case 'picture': walk(el, ctx); return;
      case 'label': {
        const c = L && L.control;
        if (c && /^(checkbox|radio)$/i.test(c.type || '') && !ctx.sh.used.has(c) && vis(c)) { control(c, c, role(c), ctx); return; }
        if (c && /^(checkbox|radio)$/i.test(c.type || '') && ctx.sh.used.has(c)) return;
        break;
      }
      case 'br': addRun(ctx, ['br']); return;
    }
    const T = L || el;
    let r = role(T);
    if (!r && L && ctx.pointerHeuristic && !/^(label|body|html|main|article|section|ul|ol|table)$/.test(ln) &&
        T.childElementCount < 12 && T.textContent.length < 120 &&
        (HASATTR(T, 'onclick') || (HASATTR(T, 'tabindex') && T.tabIndex >= 0) || pointerStart(T)) &&
        !QS(T, INTERACTIVE_SEL)) { r = 'button'; ctx.sh.pointer++; }
    if (r && INTERACTIVE.has(r)) {
      if (r === 'option' && CLOSEST(T, 'select')) return;
      // a whole post made clickable (X wraps each post in a link) is a post, not one long link: walk into it
      if (L && SCAN && SCAN.posts && SCAN.posts.size && (r === 'link' || r === 'button') && [...SCAN.posts].some((p) => CONTAINS(T, p))) { walk(el, ctx); return; }
      control(el, L, r, ctx);
      return;
    }
    if (/^h[1-6]$/.test(ln) || r === 'heading') {
      flush(ctx);
      const lvl = ln[0] === 'h' && ln.length === 2 ? +ln[1] : (+ATTR(T, 'aria-level') || 2);
      const prev = ctx.kind; ctx.kind = { k: 'h', l: lvl };
      walk(el, ctx); flush(ctx); ctx.kind = prev;
      return;
    }
    switch (ln) {
      case 'ul': case 'ol': case 'menu': case 'dl': {
        flush(ctx);
        ctx.list.push({ n: ln === 'ol' ? (T.start || 1) : 0 });
        walk(el, ctx); flush(ctx);
        ctx.list.pop();
        return;
      }
      case 'li': case 'dt': case 'dd': {
        flush(ctx);
        const top = ctx.list[ctx.list.length - 1];
        const prev = ctx.kind;
        ctx.kind = { k: 'li', d: Math.max(1, ctx.list.length), o: top && top.n ? top.n++ : 0 };
        if (ln !== 'li') ctx.kind.o = 0, ctx.kind.dl = ln;
        // round 3: a definition continues its term, one item: the term, then what it says (Python's docs' signatures)
        if (ln === 'dd') { const pe = el.previousElementSibling; if (pe && (LNOF(pe) === 'dt' || LNOF(pe) === 'dd')) ctx.kind.cont = 1; }
        walk(el, ctx); flush(ctx); ctx.kind = prev;
        return;
      }
      case 'pre': {
        // R2: the code without the site's own buttons in it ("Copy", "Use with AI"); R33: its line count for the fold
        flush(ctx);
        let t = txt(T) || '';
        for (const b of QSA(T, 'button,[role=button]')) { const bt = (b.innerText || '').trim(); if (bt) t = t.replace(bt, ''); }
        t = t.replace(/^\s*\n/, '').slice(0, 20000);
        // round 4: a highlighter that draws each line as a box of its own reads every line twice apart ("a\n\nb"): once
        if (/\n\n/.test(t) && !/[^\n]\n[^\n]/.test(t.replace(/\n+$/, ''))) t = t.replace(/\n{2,}/g, (m) => '\n'.repeat(Math.floor(m.length / 2)));
        pushBlock(ctx, { k: 'pre', t, lines: t.split('\n').length });
        return;
      }
      case 'blockquote': flush(ctx); ctx.quote++; walk(el, ctx); flush(ctx); ctx.quote--; return;
      case 'hr': flush(ctx); pushBlock(ctx, { k: 'hr' }); return;
      case 'table':
        if (isDataTable(T)) {
          flush(ctx);
          const rows = [];
          for (const row of Array.from(el.rows).slice(0, 300)) {
            const L2 = ctx.live(row);
            if (L2 && !vis(L2)) continue;
            if (L2 && SCAN && SCAN.junk.has(L2)) { dropCount(ctx, SCAN.junk.get(L2)); continue; }
            rows.push(Array.from(row.cells).slice(0, 20).map((cell) => {
              const o = { c: cellRuns(cell, ctx) };
              if (LNOF(cell) === 'th') o.h = 1;
              if (cell.colSpan > 1) o.cs = cell.colSpan;
              return o;
            }));
          }
          if (rows.length) { for (const t of splitGrouped(rows)) pushBlock(ctx, t); }
          return;
        }
        flush(ctx); walk(el, ctx); flush(ctx); return;
    }
    if (BLOCK.has(ln)) { walkBlock(el, ctx); return; }
    const f = FMT[ln];
    if (f) {
      const run = [f];
      addRun(ctx, run);
      const prev = ctx.target;
      ctx.target = run;
      walk(el, ctx);
      if (ctx.target === run) ctx.target = prev;
      return;
    }
    if (ln.includes('-') && L) {
      const d = getComputedStyle(L).display;
      if (d !== 'inline' && d !== 'contents' && d !== 'inline-block') { flush(ctx); walk(el, ctx); flush(ctx); return; }
    }
    walk(el, ctx);
  }
  const FLOAT_HOST = new Set(['table', 'figure', 'div', 'aside', 'section']);
  // floated left or right, a box of its own (not a drop cap or an icon), and narrower than the column it sits in
  function floatedBox(L) {
    const cs = getComputedStyle(L);
    if (cs.float !== 'left' && cs.float !== 'right') return false;
    const r = RECT(L), p = L.parentElement, pw = p ? RECT(p).width : innerWidth;
    return r.width >= 100 && r.height >= 40 && pw > 0 && r.width <= 0.6 * pw;
  }
  function walkBlock(el, ctx) {
    // blocks from the site's nav and header landmarks are marked: only they may join the site menu (assemble)
    const lm = el.nodeType === 1 && (LNOF(el) === 'nav' || LNOF(el) === 'header' || /^(navigation|banner)$/.test(ATTR(el, 'role') || ''));
    flush(ctx); if (lm) ctx.lm = (ctx.lm || 0) + 1;
    walk(el, ctx); flush(ctx);
    if (lm) ctx.lm--;
  }
  let LANDMARK = new WeakSet();

  const DIALOG_SEL = 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]';
  function hoistDialogs(ctx) {
    // only real dialogs (one the member opened, a media viewer) are shown; consent, promo and sign-in ones were dropped
    const ds = Array.from(QSA(document, DIALOG_SEL)).filter((d) => vis(d) && !(d.parentElement && CLOSEST(d.parentElement, DIALOG_SEL)) &&
      !(SCAN && inJunk(SCAN, d)));
    let n = 0;
    for (const d of ds) {
      if ((d.innerText || '').trim().length < 2 && !(SCAN && SCAN.islands.some((c) => CONTAINS(d, c.box)))) continue;
      ctx.dlg = 1;
      flush(ctx);
      elem(d, ctx);
      flush(ctx);
      ctx.dlg = 0;
      ctx.sh.skip.add(d);
      n++;
    }
    for (const d of QSA(document, DIALOG_SEL)) if (SCAN && inJunk(SCAN, d)) ctx.sh.skip.add(d);
    return n;
  }


  // ---------------------------------------------------------------- site row, consent block, structured data, fold
  const runText = (runs) => (runs || []).map((x) => typeof x === 'string' ? x : Array.isArray(x) ? (x[0] === 'a' ? runText(x.slice(3)) : x[0] === 'btn' ? x[2] : FMT_RUN.has(x[0]) ? runText(x.slice(1)) : '') : '').join('');
  function shortUrl(u) {
    try {
      const x = new URL(u, location.href);
      const segs = x.pathname.split('/').filter(Boolean).slice(0, 2).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
      return clip([x.hostname.replace(/^www\./, '')].concat(segs).join(' › '), 60);
    } catch (e) { return ''; }
  }
  function siteRow(sh, groups) {
    const og = QS(document, 'meta[property="og:site_name"],meta[name="application-name"],meta[name="apple-mobile-web-app-title"]');
    let name = og && (og.content || '').trim();
    if (!name) { const m = document.title.match(/\s[|\-–—·•:]\s([^|\-–—·•:]{2,40})$/); name = m ? m[1].trim() : location.hostname.replace(/^www\./, ''); }
    let icon = '', best = 0;
    for (const l of QSA(document, 'link[rel~="icon" i],link[rel="shortcut icon" i],link[rel="apple-touch-icon" i]')) {
      const sz = parseInt(((ATTR(l, 'sizes') || '16').split('x')[0]), 10) || 16;
      if (!icon || (sz <= 64 && sz > best)) { icon = l.href; best = sz; }
    }
    if (!icon) icon = location.origin + '/favicon.ico';
    // the site's own essential actions: search is the field; sign in and cart come out of the menu
    const acts = [];
    for (const g of groups) for (const x of g.c) {
      if (x[0] !== 'a' && x[0] !== 'btn') continue;
      const label = (x[0] === 'a' ? runText(x.slice(3)) : x[2] || '').replace(/\s+/g, ' ').trim();
      if (!acts.some((a) => a.k === 'signin') && /^(sign in|log ?in|sign in \/ register|account|my account|hello, sign in.*)$/i.test(label)) acts.push({ k: 'signin', c: x });
      else if (!acts.some((a) => a.k === 'cart') && /\b(cart|basket|bag)\b/i.test(label) && label.length < 40) {
        const n = label.match(/\d+/);
        acts.push(Object.assign({ k: 'cart', c: x }, n ? { n: +n[0] } : {}));
      }
    }
    // the row shows the search field (and its button), Sign in and Cart; the rest of the nav sits in the closed menu
    const c = sh.bar.slice();
    const tags = [];
    for (const a of acts) { tags.push({ k: a.k, i: c.length, n: a.n }); c.push(a.c); }
    return { k: 'chrome', name: clip(name, 60), icon: icon.slice(0, 300), c, acts: tags, menu: groups };
  }
  function consentBlock(el, sh, links) {
    const c = newCtx((e) => e, sh);
    c.inChrome = true;
    walk(el, c); flush(c);
    const x = [];
    for (const b of c.blocks) for (const r of b.c || []) if (Array.isArray(r) && (r[0] === 'btn' || (links && r[0] === 'a')) && x.length < 3) x.push(r);
    return { k: 'consent', c: [clip(el.innerText || '', 240)], x };
  }
  function ldObjects() {
    const out = [];
    for (const sc of QSA(document, 'script[type="application/ld+json"]')) {
      let j; try { j = JSON.parse(sc.textContent); } catch (e) { continue; }
      const stack = [j];
      for (let i = 0; i < 200 && stack.length; i++) {
        const o = stack.shift();
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o)) { stack.push(...o); continue; }
        if (o['@graph']) stack.push(...[].concat(o['@graph']));
        const t = [].concat(o['@type'] || []).join(' ');
        if (/\b(Recipe|Product|VideoObject|QAPage|HowTo)\b/.test(t)) out.push(o);
      }
    }
    return out;
  }
  function isoDur(d) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(d || '');
    if (!m) return '';
    const mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
    if (!mins && m[4]) return m[4] + ' s';
    return mins >= 60 ? Math.floor(mins / 60) + ' h' + (mins % 60 ? ' ' + (mins % 60) + ' min' : '') : mins + ' min';
  }
  const str = (v) => typeof v === 'string' ? v : Array.isArray(v) ? str(v[0]) : v && typeof v === 'object' ? str(v.name || v['@value'] || v.text || '') : v == null ? '' : String(v);
  // JSON-LD leads: the page's structured payload as a facts block after the headline
  function factsBlock(objs) {
    if (!objs || !objs.length) return null;
    const pick = objs.find((o) => /Recipe/.test([].concat(o['@type']).join(' '))) || objs.find((o) => /Product/.test([].concat(o['@type']).join(' '))) ||
      objs.find((o) => /VideoObject|QAPage|HowTo/.test([].concat(o['@type']).join(' ')));
    const type = ([].concat(pick['@type']).join(' ').match(/Recipe|Product|VideoObject|QAPage|HowTo/) || [''])[0];
    const b = { k: 'facts', type, name: clip(str(pick.name), 160) };
    const ar = pick.aggregateRating;
    if (ar && (ar.ratingValue || ar.ratingValue === 0)) b.rating = [Math.round(parseFloat(str(ar.ratingValue)) * 10) / 10, parseInt(str(ar.ratingCount || ar.reviewCount), 10) || undefined];
    if (type === 'Recipe') {
      b.prep = isoDur(str(pick.prepTime)); b.cook = isoDur(str(pick.cookTime)); b.total = isoDur(str(pick.totalTime));
      b.serves = clip(str(pick.recipeYield), 40);
      const ing = [].concat(pick.recipeIngredient || []).map(str).filter(Boolean);
      b.ing = ing.slice(0, 80).map((x) => clip(x, 120));
      b.steps = [].concat(pick.recipeInstructions || []).length || undefined;
    } else if (type === 'Product') {
      const offers = [].concat(pick.offers || []);
      const o = offers[0] || {};
      const price = str(o.price || o.lowPrice);
      if (price) b.price = (str(o.priceCurrency) === 'USD' || !str(o.priceCurrency) ? '$' : str(o.priceCurrency) + ' ') + price;
      if (o.availability) b.avail = str(o.availability).replace(/^https?:\/\/schema\.org\//, '');
      if (pick.brand) b.brand = clip(str(pick.brand), 60);
    } else if (type === 'VideoObject') {
      b.dur = isoDur(str(pick.duration));
      if (pick.uploadDate) b.date = str(pick.uploadDate).slice(0, 10);
    } else if (type === 'QAPage') {
      const q = pick.mainEntity || {};
      b.answers = parseInt(str(q.answerCount), 10) || undefined;
      if (q.acceptedAnswer) b.accepted = 1;
    }
    for (const k of Object.keys(b)) if (b[k] === '' || b[k] === undefined) delete b[k];
    return b;
  }
  // the recipe rule: the story before the recipe folds into one line, the author's words a tap away
  function foldStory(body, facts) {
    const first = norm((facts.ing || [])[0] || '').slice(0, 24);
    let end = -1;
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      const t = norm(b.c ? runText(b.c) : '');
      if ((b.k === 'h' && /^ingredients?/.test(t)) || (first && t.includes(first))) { end = i; break; }
    }
    if (end <= 0) return body;
    // keep everything up to the headline, its byline and the hero image; fold the prose after them
    const fold = [], keep = [];
    let chars = 0;
    const h1 = body.findIndex((b) => b.k === 'h' && b.l === 1);
    let hero = false;
    for (let i = 0; i < end; i++) {
      const b = body[i];
      if (i <= h1 || b.k === 'meta' || (b.k === 'h' && b.l === 1) || (b.k === 'img' && !hero && !fold.length && (hero = true))) { keep.push(b); continue; }
      if (b.k === 'p' || b.k === 'li' || b.k === 'h' || b.k === 'img') { fold.push(b); if (b.c) chars += runText(b.c).length; }
      else keep.push(b);
    }
    if (chars < 600) return body;
    const mins = Math.max(1, Math.round(chars / 5 / 230));
    // round 5: what the cook needs before the recipe (its rating, times and how many it makes) stays out of the fold,
    // as one line under the title, from the recipe's own facts
    const facts1 = [];
    if (facts.rating && facts.rating[0]) facts1.push('★ ' + facts.rating[0] + (facts.rating[1] ? ' (' + facts.rating[1].toLocaleString('en-US') + ')' : ''));
    if (facts.prep) facts1.push('Prep ' + facts.prep);
    if (facts.cook) facts1.push('Cook ' + facts.cook);
    if (facts.total) facts1.push('Total ' + facts.total);
    if (facts.serves) facts1.push((/^\d+$/.test(facts.serves) ? 'Serves ' : '') + facts.serves);
    if (facts1.length >= 2) {
      let at = keep.findIndex((b) => b.k === 'h' && b.l === 1) + 1;
      while (keep[at] && keep[at].k === 'meta') at++;
      keep.splice(at, 0, { k: 'meta', c: [facts1.join(' · ')], facts: 1 });
    }
    return keep.concat([{ k: 'group', n: 'The story before the recipe · ' + mins + ' min read', fold: 1, c: fold }], body.slice(end));
  }

  // the site row (chrome), then the content in reading order, then at most one related shelf
  // a block that is only the site's navigation: links and buttons with no reading text of its own
  function navLike(b) {
    if (!b || !b.c || !(b.k === 'p' || b.k === 'li' || (b.k === 'h' && b.l >= 2)) || b.crumbs || b.depth) return false;
    let ctl = 0, text = 0;
    for (const x of b.c) {
      if (typeof x === 'string') text += x.replace(/[\s|·•,\-–—/›»]+/g, '').length;
      else if (Array.isArray(x) && (x[0] === 'a' || x[0] === 'btn' || x[0] === 'in' || x[0] === 'sel' || x[0] === 'ta')) ctl++;
      else if (Array.isArray(x) && FMT_RUN.has(x[0])) text += runText(x.slice(1)).length;
    }
    return ctl > 0 && text <= 3;
  }
  function assemble(ctx, head, body, st) {
    const out = [];
    const sh = ctx.sh;
    const facts = SCAN && factsBlock(SCAN.structured);
    // round 4: a heading that holds only a control and its label ("Sort by: [select]", Amazon's toolbar) titles nothing
    for (const b of [...head, ...body]) {
      if (b.k === 'h' && b.c && b.c.some((x) => Array.isArray(x) && (x[0] === 'sel' || x[0] === 'in' || x[0] === 'btn')) &&
          b.c.every((x) => typeof x === 'string' ? !x.trim() || /^[^.!?]{1,30}:\s*$/.test(x.trim()) : x[0] === 'sel' || x[0] === 'in' || x[0] === 'btn' || x[0] === 'br')) {
        b.k = 'p'; delete b.l;
      }
    }
    // R29: the page's title is a heading even when the walk didn't meet one (h1, og:title, JSON-LD name, the title tag)
    const hb = [...head, ...body];
    if (!hb.some((b) => b.k === 'h' && b.l === 1)) {
      const label = (b) => { const t = runText(b.c || []).trim(); return (b.c || []).every((x) => typeof x === 'string' ? !x.trim() : Array.isArray(x) && x[0] === 'a') || (t === t.toUpperCase() && /[A-Z]/.test(t)); };
      // round 4: a listing's own filter or sort heading ("Popular filters", Target's) names no page
      const furniture = (b) => /^(popular |all |more |top )?(filters?|refine( by| results)?|sort( by)?|filter by .{1,30}|shop by .{1,30})\s*:?$/i.test(runText(b.c || []).trim());
      // and on a search's results (its query in the bar), a heading that doesn't name the query is a section's, not the page's
      const q = ((ctx.sh.bar.find((x) => (x[0] === 'in' || x[0] === 'ta') && x[2] && (x[2].v || '').trim().length > 1) || [])[2] || {}).v;
      const names = (b) => !q || runText(b.c || []).toLowerCase().includes(q.trim().toLowerCase());
      const first = hb.slice(0, 8).find((b) => b.k === 'h' && b.l <= 3 && runText(b.c || []).trim().length >= 3 && !label(b) && !furniture(b) && names(b));
      if (first) first.l = 1;   // the page's own first heading is its title ("Dropdown List")
    }
    if (![...head, ...body].some((b) => b.k === 'h' && b.l === 1)) {
      const og = QS(document, 'meta[property="og:title"]');
      const t = (facts && facts.name) || (og && og.content) || document.title.replace(/\s[|\-–—·•:]\s[^|\-–—·•:]{2,40}$/, '');
      if (t && t.trim() && (head.length || body.length)) head.unshift({ k: 'h', l: 1, c: [clip(t, 300)] });
    }
    let all = head.concat(facts && facts.type === 'Recipe' ? foldStory(body, facts) : body);
    // round 5: a front page's story reads once. A line that is only a link repeating the headline just after it (a story
    // card's covering link, the Guardian's) goes, and the headline becomes that link; a short heading right before a
    // headline at its own level is its kicker, one quiet line ("2026 ELECTIONS", "David Walliams"); and a lone number
    // linking off (a story's comment count, AP's "2315") says nothing on its own
    {
      const plain = (b) => norm(runText(b.c || []));
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        if (!b || !(b.k === 'li' || b.k === 'p') || !b.c || b.depth) continue;
        const ls = b.c.filter((x) => Array.isArray(x));
        if (ls.length !== 1 || ls[0][0] !== 'a' || b.c.some((x) => typeof x === 'string' && x.trim())) continue;
        const t = norm(runText(ls[0].slice(3)));
        if (t.length < 12) continue;
        for (let k = i + 1; k < Math.min(all.length, i + 5); k++) {
          const h = all[k];
          if (h.k === 'h' && plain(h) === t) {
            if (!h.c.some((x) => Array.isArray(x) && x[0] === 'a')) h.c = [['a', ls[0][1], ls[0][2], ...h.c]];
            all.splice(i, 1); i--;
            break;
          }
          if ((h.k === 'h' && plain(h).length > 24) || h.k === 'card' || (h.k === 'p' && plain(h).length > 40)) break;
        }
      }
      for (let i = 0; i + 1 < all.length; i++) {
        const a = all[i], b = all[i + 1];
        if (a.k !== 'h' || b.k !== 'h' || a.l !== b.l || a.l < 2 || a.fl || b.fl) continue;
        const ta = runText(a.c || []).trim(), tb = runText(b.c || []).trim();
        if (ta && ta.split(/\s+/).length <= 4 && ta.length <= 32 && tb.split(/\s+/).length >= 5) all[i] = { k: 'meta', c: a.c };
      }
      // (a list's lone "(22)" too, a rating's count; never a page number of a list's pages, "2")
      all = all.filter((b) => !((b.k === 'p' || b.k === 'li') && !b.depth && b.c && b.c.length === 1 && Array.isArray(b.c[0]) && b.c[0][0] === 'a' &&
        (b.k === 'p' ? /^\(?[\d.,]+[kKmM]?\)?( · [^·]{1,30})?$/ : /^\([\d.,]+[kKmM]?\)( · [^·]{1,30})?$/).test(runText(b.c[0].slice(3)).trim())));
    }
    // round 5: a post's reaction counts as buttons with no word ("189", "200", "11": Substack's likes, comments and
    // restacks) say nothing alone; a list's page numbers (with their Previous or Next, or in sequence) stay
    // (a count alone, "Like (189)", "View comments (200)", or a count with what it counts after it, R38's "189 · Like")
    const COUNT_BTN = /^([\d.,]+[kKmM]?( · .{1,30})?|((un)?like|view comments|comments?|restack|repost|share|clap|heart|love)\b[^()]{0,20}\(\s*[\d.,]+[kKmM]?\s*\))$/i;
    for (const b of all) {
      if (b.k !== 'p' || !b.c) continue;
      const btns = b.c.filter((x) => Array.isArray(x) && x[0] === 'btn');
      const nums = btns.filter((x) => COUNT_BTN.test((x[2] || '').trim()));
      if (nums.length < 2 || btns.some((x) => /^(previous|prev|next|more|‹|›|«|»)\b/i.test((x[2] || '').trim()))) continue;
      const v = nums.map((x) => /^[\d.,]+$/.test((x[2] || '').trim()) ? parseFloat((x[2] || '').replace(/,/g, '')) : NaN);
      if (v.every((n, i) => !Number.isNaN(n) && (!i || n === v[i - 1] + 1))) continue;
      b.c = b.c.filter((x) => !nums.includes(x));
    }
    // round 5: the site's own name as a heading over the page's title (Substack's masthead) is the site row's, not a title
    {
      const hs = all.map((b, i) => [b, i]).filter(([b]) => b.k === 'h' && b.l === 1);
      if (hs.length >= 2 && hs[1][1] - hs[0][1] <= 2) {
        const og = QS(document, 'meta[property="og:site_name"]');
        const site = norm((og && ATTR(og, 'content')) || ''), first = runText(hs[0][0].c || []).trim(), title = norm(document.title);
        // the site's name, or a short name the page's title leaves out over a heading the title starts with (Substack's)
        if ((site && norm(first) === site) || (first.split(/\s+/).length <= 5 && !title.includes(norm(first)) && title.startsWith(norm(runText(hs[1][0].c || [])).slice(0, 40)))) {
          all.splice(hs[0][1], 1);
        }
      }
    }
    // round 5: a row the page labels "Sponsored" (a shop's promoted carousel, eBay's): the label, its few lines and its
    // cards drop, and count as sponsored
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (!b || !(b.k === 'p' || b.k === 'meta') || !b.c || !/^(sponsored|ad|promoted)$/i.test(runText(b.c).trim())) continue;
      let j = i + 1;
      while (j < all.length && j - i <= 3 && all[j].k !== 'card' && all[j].k !== 'h' && runText(all[j].c || []).length <= 60) j++;
      if (!all[j] || all[j].k !== 'card') continue;
      let e = j; const g = all[j].g;
      while (e < all.length && all[e].k === 'card' && all[e].g === g) e++;
      let s0 = i;
      if (all[i - 1] && all[i - 1].k === 'p' && all[i - 1].c && all[i - 1].c.length === 1 && Array.isArray(all[i - 1].c[0]) && all[i - 1].c[0][0] === 'a') s0 = i - 1;   // its advertiser
      sh.dropped.sponsored = (sh.dropped.sponsored || 0) + (e - j);
      all.splice(s0, e - s0);
      i = s0 - 1;
    }
    // round 5: a listing's links that each apply a filter ("Wood - apply Popular Filters filter", eBay's) are its filters
    {
      // (round 6: by the link's whole name, its screen reader's words included: "Corded" reads "Corded - apply Popular
      // Filters filter" to a screen reader)
      const APPLY = /\b(apply|remove) .{0,40}\bfilters?$/i;
      const applies = (x) => { if (APPLY.test(runText(x.slice(3)).trim())) return true; const e = lookup(x[1]); return !!(e && (APPLY.test((ATTR(e, 'aria-label') || '').replace(/\s+/g, ' ').trim()) || APPLY.test((e.textContent || '').replace(/\s+/g, ' ').trim()))); };
      const fl = (b) => b && (b.k === 'li' || b.k === 'p') && b.c && b.c.length >= 1 && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'a' && applies(x));
      for (let i = 0; i < all.length; i++) {
        if (!fl(all[i])) continue;
        let j = i; while (j < all.length && fl(all[j])) j++;
        if (j - i >= 2) { sh.menu.push({ kind: 'filters', n: 'Filters', c: all.slice(i, j).flatMap((b) => b.c.filter((x) => Array.isArray(x))) }); all.splice(i, j - i); }
        if (i > 0 && all[i - 1] && all[i - 1].k === 'h' && /filters?$/i.test(runText(all[i - 1].c || []).trim()) && (!all[i] || all[i].k === 'h' || all[i].k === 'card')) { all.splice(i - 1, 1); i--; }
      }
    }
    // round 5: a sentence the page broke into lines of its own around an inline link ("The" / "[BenQ desk lamp]" / "is
    // widely ranked…", Google's AI overview) reads as one paragraph again
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i], b = all[i + 1];
      if (a.k !== 'p' || b.k !== 'p' || !a.c || !b.c || (a.depth || 0) !== (b.depth || 0) || (a.q || 0) !== (b.q || 0) || a.dlg || b.dlg) continue;
      const ta = runText(a.c).trim(), tb = runText(b.c).trim();
      if (!ta || !tb || /[.!?:;]$/.test(ta)) continue;
      const linkOnly = (c) => c.filter((x) => Array.isArray(x)).length === 1 && c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'a');
      // (a word or two of a sentence: never a count, "383", "36.4k", that a later rule may drop)
      const short = ta.split(/\s+/).length <= 3 && /\p{L}{2,}/u.test(ta) && a.c.every((x) => typeof x === 'string');
      if ((short && (linkOnly(b.c) || /^[a-z]/.test(tb))) || (linkOnly(a.c) && /^[a-z,;]/.test(tb) && /^[a-z]/i.test(ta))) {
        b.c = [...a.c, ' ', ...b.c];
        all.splice(i, 1);
        i = Math.max(-1, i - 2);
      }
    }
    // round 5: an engine's AI overview under its own heading, wherever it sits among the results, is its answer: one
    // block, its "Show more" and its source buttons left to the real page
    {
      const hi = all.findIndex((b) => b.k === 'h' && /^(ai overview|search assist|ai-generated answer)$/i.test(runText(b.c || []).trim()));
      if (hi >= 0 && all.some((b) => b.k === 'card')) {
        let j = hi + 1;
        while (j < all.length && all[j].k !== 'card' && !(all[j].k === 'h' && all[j].l <= all[hi].l) && j - hi <= 30) j++;
        const c = [];
        for (const b of all.slice(hi + 1, j)) {
          const runs = (b.c || []).filter((x) => !(Array.isArray(x) && x[0] === 'btn'));
          if (!runText(runs).trim()) continue;
          if (c.length) c.push(['br']);
          if (b.k === 'h') c.push(['b', ...runs]); else c.push(...runs);
        }
        if (runText(c).length >= 80) all.splice(hi, j - hi, { k: 'answer', n: clip(runText(all[hi].c).trim(), 40), c });
      }
    }
    // round 5: a docs page's callout title on a line of its own ("Tip", "Note", "Warning") leads the callout's first
    // paragraph, "Tip: Skip to the format codes.", never a bare word between paragraphs
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i], b = all[i + 1];
      if (a.k !== 'p' || b.k !== 'p' || a.depth || b.depth || !a.c || !b.c || (a.q || 0) !== (b.q || 0)) continue;
      const t = runText(a.c).trim();
      if (!/^(tip|note|notes|hint|warning|caution|important|attention|danger|deprecated|example|info|todo|remark)$/i.test(t)) continue;
      b.c = [['b', t + ':'], ' ', ...b.c];
      all.splice(i, 1);
    }
    // R62: a story's photo never stands apart from its headline: a picture linking to a story, followed within a few
    // blocks by a heading that is a link to the same story, becomes one card with it (and its dek and counts)
    {
      const key = (u) => (u || '').replace(/[#?].*$/, '').replace(/\/$/, '');
      for (let i = 0; i < all.length; i++) {
        const im = all[i];
        if (!im || im.k !== 'img' || !im.u) continue;
        const u = key(im.u);
        let j = -1;
        for (let k = i + 1; k < Math.min(all.length, i + 6); k++) {
          const h = all[k];
          if (h.k === 'card' || h.k === 'img') break;
          const links = (h.c || []).filter((x) => Array.isArray(x) && x[0] === 'a');
          if (h.k === 'h' && h.l >= 2 && links.length === 1 && key(links[0][2]) === u) { j = k; break; }
        }
        if (j < 0) continue;
        const h = all[j], L = (h.c || []).find((x) => Array.isArray(x) && x[0] === 'a');
        const title = runText(L.slice(3)).trim();
        const c = [['a', im.r || L[1], im.u, ['img', im.s, im.a || '', im.w, im.h]], ['a', L[1], L[2], title]];
        let e = j + 1;
        while (all[e] && all[e].k === 'p' && (all[e].c || []).every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'a' && key(x[2]) === u)) {
          const t = runText(all[e].c).trim();
          c.push(/^[\d.,]+[kKmM]?$/.test(t) ? ' · ' + t : ['br'], ...(/^[\d.,]+[kKmM]?$/.test(t) ? [] : [t]));
          e++;
        }
        const card = { k: 'card', g: 'story', lay: 'list', title, c, lead: 1 };
        all.splice(j, e - j, card);
        all.splice(i, 1);
        i = j - 1;
      }
    }
    // a run of three or more little pictures with no words (a thread's participants, a row of icons) says nothing
    {
      const tiny = (b) => b && b.k === 'p' && b.c && b.c.length && b.c.every((x) => typeof x === 'string' ? !x.trim() :
        (x[0] === 'img' && (x[3] || 99) <= 64 && x[5] !== 'g') || (x[0] === 'a' && x.slice(3).length && x.slice(3).every((y) => typeof y === 'string' ? !y.trim() : y[0] === 'img' && (y[3] || 99) <= 64)));
      const out2 = [];
      for (let i = 0; i < all.length;) {
        let j = i; while (j < all.length && tiny(all[j])) j++;
        const pics = all.slice(i, j).reduce((n, b) => n + JSON.stringify(b.c).split('["img"').length - 1, 0);
        if (j - i >= 3 || pics >= 3) { st.dropped_icons = (st.dropped_icons || 0) + (j - i); i = j; continue; }
        if (j > i) { out2.push(...all.slice(i, j)); i = j; continue; }
        out2.push(all[i]); i++;
      }
      all = out2;
    }
    // round 4: just before the title, two to four lines of one short link each (a docs page's "API Reference", "Hooks")
    // are its breadcrumbs: one quiet line of links
    {
      const h = all.findIndex((b) => b.k === 'h' && b.l === 1);
      const one = (b) => b && (b.k === 'p' || b.k === 'li') && !b.depth && b.c && b.c.filter((x) => Array.isArray(x)).length === 1 &&
        b.c.every((x) => typeof x === 'string' ? !x.replace(/[\s/›>»|·]+/g, '') : x[0] === 'a' && runText(x.slice(3)).trim().length >= 2 && runText(x.slice(3)).trim().length <= 30);
      // (a line of the page's own buttons may sit between them and the title: react.dev's "Copy page")
      const btns = (b) => b && b.k === 'p' && b.c && b.c.some((x) => Array.isArray(x) && x[0] === 'btn') && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'btn');
      let end = h - 1;
      while (end >= 0 && h - end <= 2 && btns(all[end])) end--;
      let i = end;
      while (i >= 0 && one(all[i])) i--;
      const n = end - i;
      const crumbs = (from, k) => {
        const c = [];
        all.slice(from, from + k).forEach((b, x) => { if (x) c.push(' › '); c.push(b.c.find((y) => Array.isArray(y))); });
        return { k: 'meta', c, crumbs: 1 };
      };
      const up = (b) => { const L = b.c.find((x) => Array.isArray(x)); try { const u = new URL(L[2], location.href); const p = u.pathname.replace(/\/$/, ''); return u.hostname === location.hostname && p.length > 1 && location.pathname.startsWith(p + '/'); } catch (e) { return false; } };
      // (round 6: never a row of the page's sibling pages, GitHub's "Views", "Milestones", "Labels" over its issues, none
      // leading up its path: that's its navigation, which joins the site menu below)
      const parent = (pth) => pth.replace(/\/$/, '').replace(/\/[^/]*$/, '');
      const sib = (b) => { const L = b.c.find((x) => Array.isArray(x)); try { const u = new URL(L[2], location.href); const pth = u.pathname.replace(/\/$/, ''); return u.hostname === location.hostname && pth !== location.pathname.replace(/\/$/, '') && parent(pth) === parent(location.pathname) && parent(pth).length > 1; } catch (e) { return false; } };
      const run0 = all.slice(i + 1, end + 1);
      if (h > 0 && n >= 2 && n <= 4 && !(run0.filter(sib).length >= 2 && !run0.some(up))) all.splice(i + 1, n, crumbs(i + 1, n));
      else if (h >= 0) {
        // or just after it, when one of them leads up the page's own path (the section it's in)
        let j = h + 1;
        while (j < all.length && j - h <= 4 && one(all[j])) j++;
        if (j - h - 1 >= 2 && j - h - 1 <= 4 && all.slice(h + 1, j).some(up)) all.splice(h + 1, j - h - 1, crumbs(h + 1, j - h - 1));
      }
    }
    // R1-R36: only the site row comes before the main heading. Navigation found before it (or between it and the
    // first card of a listing) joins the site menu; any reading content before it follows it.
    const h1i = all.findIndex((b) => b.k === 'h' && b.l === 1);
    const ci = all.findIndex((b) => b.k === 'card');
    const stop = Math.max(h1i, ci > h1i && ci - h1i <= 40 ? ci : -1);
    // R16: "8,750 results" is one quiet line
    for (const b of all) if (b.k === 'p' && b.c && b.c.length === 1 && typeof b.c[0] === 'string' && /^(about |over |showing |)?[\d,.]+\+?(\s*-\s*[\d,.]+)?( of (about |over )?[\d,.]+\+?)? (results|items|products)\b/i.test(b.c[0].trim())) b.k = 'meta';
    if (stop > 0) {
      const before = [], moved = [];
      all = all.filter((b, i) => {
        if (i >= stop || i === h1i || b.k === 'media' || b.k === 'consent' || (b.k === 'meta' && b.crumbs && i < h1i)) return true;
        // only the site's own nav and header landmarks join the menu (a lead story is never hoisted into it)
        if (navLike(b) && LANDMARK.has(b)) { sh.menu.push({ kind: 'nav', n: 'Site menu', c: b.c.filter((x) => Array.isArray(x)) }); st.moved_nav = (st.moved_nav || 0) + 1; return false; }
        if (i < h1i && b.k === 'img' && (b.rh || b.h || 0) < 150) return false;   // the site's logo: the site row already names it
        // round 6: a strip of the site's own promotion over its header ("Deals for every list. Start early, save early.
        // Shop now", Best Buy's) is an ad for the site, not the page's reading
        if (i < h1i && b.k === 'p' && b.c && runText(b.c).trim().length <= 140 && b.c.some((x) => Array.isArray(x) && x[0] === 'a' && /^(shop|see|browse|get|explore) (now|all|deals|more|details|the deals?)$|^learn more$/i.test(runText(x.slice(3)).trim()))) { dropCount(ctx, 'promo'); return false; }
        if (i < h1i && b.k !== 'meta' && b.k !== 'img') { moved.push(b); return false; }
        return true;
      });
      if (moved.length) { const hi = all.findIndex((b) => b.k === 'h' && b.l === 1); let at = hi + 1; while (all[at] && all[at].k === 'meta') at++; all.splice(at, 0, ...moved); }
    }
    // round 5: a site's header drawn without landmarks (Hacker News' table row). Before the page's first content, lines
    // of nothing but links (bold or not) between separators, one of them leading to the site's home (its logo or name)
    // and one a row of four or more short links, are the site's: they join the menu (where the site row finds its Sign
    // in), and the logo the site row already names drops
    {
      const flat = (runs, out) => { for (const x of runs || []) { if (Array.isArray(x) && FMT_RUN.has(x[0])) flat(x.slice(1), out); else out.push(x); } return out; };
      const linkLine = (b) => {
        if (!b || b.k !== 'p' || b.depth || b.q || !b.c) return null;
        const xs = flat(b.c, []), ls = [];
        for (const x of xs) {
          if (typeof x === 'string') { if (x.replace(/[\s|·•,\-–—/›»]+/g, '')) return null; }
          else if (Array.isArray(x) && x[0] === 'a') ls.push(x);
          else return null;
        }
        return ls.length ? ls : null;
      };
      const home = (x) => { try { const u = new URL(x[2], location.href); return u.hostname === location.hostname && /^\/?$/.test(u.pathname) && !u.search; } catch (e) { return false; } };
      const site = location.hostname.split('.').slice(-2).join('.');
      const own = (x) => { try { const u = new URL(x[2], location.href); return u.hostname === site || u.hostname.endsWith('.' + site); } catch (e) { return false; } };
      const lead = [];
      for (let i = 0; i < all.length && lead.length < 5; i++) {
        const b = all[i];
        if ((b.k === 'h' && b.l === 1) || (b.k === 'meta' && b.crumbs) || b.k === 'media') continue;
        const ls = linkLine(b);
        if (!ls || !ls.every(own)) break;   // (the site's header leads only to the site: a story's own link ends it)
        lead.push([i, ls]);
      }
      const homeAt = lead.find(([, ls]) => ls.some(home));
      const row = lead.some(([, ls]) => ls.length >= 4 && ls.every((x) => { const t = runText(x.slice(3)).trim(); return t.length >= 1 && t.length <= 24; }));
      if (homeAt && row) {
        const drop = new Set(lead.map(([i]) => i));
        for (const [, ls] of lead) {
          const named = ls.filter((x) => runText(x.slice(3)).trim());
          if (named.length) sh.menu.push({ kind: 'nav', n: 'Site menu', c: named });
        }
        st.moved_nav = (st.moved_nav || 0) + lead.length;
        all = all.filter((b, i) => !drop.has(i));
      }
      // and a list of five or more items just after the title, each one short link to another part of the same site
      // and nothing else (the Internet Archive's ABOUT, BLOG, EVENTS, JOBS), is the site's menu too
      const base = location.hostname.split('.').slice(-2).join('.');
      const ours = (x) => { try { const u = new URL(x[2], location.href); return (u.hostname === base || u.hostname.endsWith('.' + base)) && !(u.hash && u.pathname === location.pathname); } catch (e) { return false; } };
      const one = (b) => { if (!b || b.k !== 'li' || b.cont) return null; const ls = linkLine(Object.assign({}, b, { k: 'p', depth: 0 })); return ls && ls.length === 1 && ours(ls[0]) && runText(ls[0].slice(3)).trim().length <= 24 ? ls[0] : null; };
      let i = 0;
      while (i < all.length && i < 6 && ((all[i].k === 'h' && all[i].l === 1) || all[i].k === 'media' || (all[i].k === 'meta' && all[i].crumbs) || all[i].k === 'chrome')) i++;
      let j = i; while (j < all.length && one(all[j])) j++;
      if (j - i >= 5) {
        sh.menu.push({ kind: 'nav', n: 'Site menu', c: all.slice(i, j).map(one) });
        st.moved_nav = (st.moved_nav || 0) + (j - i);
        all.splice(i, j - i);
      }
    }
    // round 4: on a listing, a run of four or more lines of nothing but short links and buttons between its title and its
    // first result (an engine's own tabs, its sign-in and its "All Sites") is the site's navigation: it joins the menu
    {
      const h = all.findIndex((b) => b.k === 'h' && b.l === 1), c = all.findIndex((b) => b.k === 'card');
      // (never a list's own counts, "Open 1,024 · Closed 9,876", which say what the list is)
      // (round 6: a store's header lines may hold a number on a button, "Ship to 12345", or in its cart's link, "cart 0
      // items", never in a link of counts, "115 Following", nor a list's tab, "Open 22")
      const digits = (x) => typeof x === 'string' ? /\d/.test(x) : x[0] === 'a' ? /\d/.test(runText(x.slice(3))) && !/\b(cart|bag|basket)\b/i.test(runText(x.slice(3))) : false;
      const linky = (b) => b && (b.k === 'p' || b.k === 'li') && !b.depth && b.c && b.c.some((x) => Array.isArray(x) && (x[0] === 'a' || x[0] === 'btn')) && !b.c.some(digits) &&
        b.c.every((x) => typeof x === 'string' ? !x.replace(/[\s|·•]+/g, '') : (x[0] === 'a' || x[0] === 'btn') && runText([x]).trim().length <= 40) &&
        runText(b.c).trim().length <= 80;
      if (h >= 0 && c > h && c - h <= 40) {
        for (let i = h + 1; i < c; i++) {
          if (!linky(all[i])) continue;
          let j = i; while (j < c && linky(all[j])) j++;
          // (round 6: three, a store's "Ship to", "Account cart" and "All Categories", when one of them is its cart or account
          // and results or their count follow)
          const after = all[j];
          const store = all.slice(i, j).some((b) => b.c.some((x) => Array.isArray(x) && x[0] === 'a' && /^(account|my account|cart|bag|basket|sign in|log in)\b|\b(cart|bag|basket)\b/i.test(runText(x.slice(3)).trim())));
          if (j - i >= 4 || (j - i >= 3 && store && after && (after.k === 'card' || after.k === 'meta' || after.k === 'h' || /^(about |over )?[\d,.]+\+? (results|items|products)\b/i.test(runText(after.c || []).trim())))) {
            const moved = all.splice(i, j - i);
            sh.menu.push({ kind: 'nav', n: 'Site menu', c: moved.flatMap((b) => b.c.filter((x) => Array.isArray(x))) });
            st.moved_nav = (st.moved_nav || 0) + moved.length;
            break;
          }
          i = j;
        }
      }
    }
    // round 5: on a listing, a line of four or more buttons that each open a menu, and nothing else, between its title and
    // its first result (an issue list's Author, Labels, Projects, Milestones) is its filters
    {
      const h = all.findIndex((b) => b.k === 'h' && b.l === 1), c = all.findIndex((b) => b.k === 'card');
      // (between the title and the first result, or in the first few blocks after the title)
      if (h >= 0) {
        for (let i = h + 1; i < all.length && all[i].k !== 'card' && (i - h <= 4 || (c > h && c - h <= 40)); i++) {
          const b = all[i];
          if (b.k !== 'p' || b.depth || !b.c || b.c.some((x) => typeof x === 'string' && x.trim())) continue;
          const btns = b.c.filter((x) => Array.isArray(x));
          if (btns.length >= 4 && btns.every((x) => x[0] === 'btn' && x[3] && (x[3].e === 0 || x[3].e === 1))) {
            sh.menu.push({ kind: 'filters', n: 'Filters', c: btns });
            all.splice(i, 1); i--;
          }
        }
      }
    }
    // round 5: on a shop's listing, a run of three or more lines between its cards that are only a tile's leftovers
    // (delivery lines, "Add to cart", a rating's button, a count, "+2 other colors", a bare price), with no name of a
    // product among them (a carousel's tiles whose names the page hasn't drawn), says nothing: it goes
    {
      const DEBRIS = /deliver|join prime|non-members|add to (cart|bag|basket)|out of 5 stars|^\(?[\d,.]+[kK]?\)?$|other colou?rs|price, product page|view (next|previous) items|see (all )?options|^[$€£][\d.,]+|^(list|typical) price|^save \d+%|bought in past month|^sponsored\b|sponsored video|^shop$|^(small business|climate pledge)/i;
      const debris = (b) => b && (b.k === 'li' || b.k === 'p') && !b.depth && b.c && (() => {
        const t = runText(b.c).replace(/\s+/g, ' ').trim();
        if (!t || t.length > 140) return false;
        const named = b.c.some((x) => Array.isArray(x) && x[0] === 'a' && runText(x.slice(3)).trim().length >= 25 && !DEBRIS.test(runText(x.slice(3)).trim()));
        return !named && (DEBRIS.test(t) || b.c.every((x) => typeof x === 'string' ? !x.trim() || DEBRIS.test(x.trim()) : x[0] === 'btn' ? DEBRIS.test(x[2] || '') : x[0] === 'a' ? DEBRIS.test(runText(x.slice(3)).trim()) : false));
      })();
      // (on a listing: six cards or more on the page)
      if (all.filter((b) => b.k === 'card').length >= 6) {
        for (let i = 0; i < all.length; i++) {
          if (!debris(all[i])) continue;
          let j = i; while (j < all.length && debris(all[j])) j++;
          // (a run of two when one of them says it's sponsored: Amazon's "Shop" over its sponsored video's link)
          if (j - i >= 3 || (j - i >= 2 && all.slice(i, j).some((b) => /^\s*sponsored\b/i.test(runText(b.c))))) { st.dropped_debris = (st.dropped_debris || 0) + (j - i); all.splice(i, j - i); i--; }
          else i = j;
        }
      }
    }
    // round 5: a row of three or more choice buttons led by "All" (a results module's filter chips: DuckDuckGo's
    // subreddits), with a short label between two such rows ("More subreddits"), is filters, not reading
    {
      const chipRow = (b) => b && (b.k === 'p' || b.k === 'li') && !b.depth && b.c && b.c.filter((x) => Array.isArray(x)).length >= 3 &&
        b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'btn' && (x[2] || '').trim().length <= 30);
      const label = (b) => b && (b.k === 'p' || b.k === 'li') && b.c && b.c.every((x) => typeof x === 'string') && runText(b.c).trim().length <= 30;
      for (let i = 0; i < all.length; i++) {
        if (!chipRow(all[i]) || !all[i].c.some((x) => Array.isArray(x) && /^all$/i.test((x[2] || '').trim()))) continue;
        let j = i + 1;
        while (j < all.length && (chipRow(all[j]) || (label(all[j]) && chipRow(all[j + 1])))) j++;
        sh.menu.push({ kind: 'filters', n: 'Filters', c: all.slice(i, j).flatMap((b) => b.c.filter((x) => Array.isArray(x))) });
        all.splice(i, j - i); i--;
      }
    }
    // lead first: what floated beside the opening text (an infobox, thumbnails and their captions) and came before it
    // in the page's order follows the lead section, before its first heading (or after its first few paragraphs)
    {
      const h = all.findIndex((b) => b.k === 'h' && b.l === 1);
      const lead = all.findIndex((b, i) => i > h && b.k === 'p' && !b.fl && !b.dlg && b.c && runText(b.c).trim().length >= LEAD_CHARS);
      const floated = [];
      // round 5: only beside the opening text: a float with a section heading or a list of cards between it and the
      // first long paragraph (a forecast's current conditions, before its days and their details) stays where it is
      const apart = lead > h && all.slice(h + 1, lead).some((b) => !b.fl && (b.k === 'h' || b.k === 'card'));
      if (lead > h && !apart) for (let i = h + 1; i < lead; i++) if (all[i].fl) floated.push(i);
      if (floated.length) {
        let end = lead + 1, paras = 1;
        while (end < all.length && all[end].k !== 'h' && !all[end].fl && end - lead < 16 && !(all[end].k === 'p' && paras >= 6)) { if (all[end].k === 'p') paras++; end++; }
        const moved = floated.map((i) => all[i]);
        all.splice(end, 0, ...moved);
        for (let k = floated.length - 1; k >= 0; k--) all.splice(floated[k], 1);
      }
    }
    // R22: on a listing, the engine's own answer between the title and the first result is one block above the results
    {
      const h = all.findIndex((b) => b.k === 'h' && b.l === 1), c = all.findIndex((b) => b.k === 'card');
      // a search results page: the row's search field holds the query
      const query = sh.bar.some((x) => (x[0] === 'in' || x[0] === 'ta') && x[2] && (x[2].v || '').trim().length > 1);
      // an engine: its results lead to other sites (directly or through its redirect), not to its own pages
      const firstCards = all.filter((b) => b.k === 'card').slice(0, 6);
      const away = firstCards.filter((b) => { const u = (b.c || []).find((x) => Array.isArray(x) && x[0] === 'a'); if (!u || !u[2]) return false;
        try { const x = new URL(u[2], location.href); return x.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '') || /^\/(url|goto|ck|aclk|l)\b/.test(x.pathname); } catch (e) { return false; } }).length;
      if (query && away >= Math.max(2, firstCards.length / 2) && h >= 0 && c > h && c - h <= 25) {
        let a = h + 1; while (a < c && all[a].k === 'meta') a++;
        const mid = all.slice(a, c).filter((b) => b.k !== 'media');
        // an engine's answer is prose over web results (list cards); a shop's result count and notes over its grid are not
        const prose = mid.reduce((n, b) => n + (b.k === 'p' || b.k === 'li' ? runText(b.c || []).length : 0), 0);
        const counted = mid.some((b) => b.k === 'h' && /\b[\d,.]+ (results|items|products)\b/i.test(runText(b.c || [])));
        if (mid.length >= 3 && mid.length === c - a && all[c].lay !== 'grid' && prose >= 160 && !counted) {
          const hd = mid.find((b) => b.k === 'h');
          all.splice(a, c - a, { k: 'answer', n: hd ? clip(runText(hd.c || []), 80) : 'Answer', c: mid });
        }
      }
    }
    // R62: on a front page a section's topic links (one short link per line: "US Senate results", "Governor results")
    // are one line under the section's name
    if (st.why === 'link-heavy listing') {
      const one = (b) => b && b.k === 'p' && !b.depth && b.c && b.c.filter((x) => Array.isArray(x)).length === 1 && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'a') &&
        runText(b.c).trim().length <= 40;
      for (let i = 0; i < all.length; i++) {
        if (!one(all[i])) continue;
        let j = i + 1; while (j < all.length && one(all[j])) j++;
        if (j - i >= 3) {
          const seen = new Set(), c = [];
          for (const b of all.slice(i, j)) { const L = b.c.find((x) => Array.isArray(x)); if (seen.has(L[2])) continue; seen.add(L[2]); if (c.length) c.push(' · '); c.push(L); }
          all.splice(i, j - i, { k: 'p', c, topics: 1 });
        }
      }
    }
    // R61: on a front page the h1 that is only a link to a section is that section's heading; the page's title is
    // written as a hidden h1 ("AP News front page")
    {
      const hi = all.findIndex((b) => b.k === 'h' && b.l === 1);
      const hb = all[hi];
      const own = (u) => { try { const x = new URL(u, location.href); return x.hostname === location.hostname && x.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, ''); } catch (e) { return false; } };
      if (hb && st.why === 'link-heavy listing' && (hb.c || []).every((x) => typeof x === 'string' ? !x.trim() : Array.isArray(x) && x[0] === 'a' && !own(x[2]))) {
        hb.l = 2;
        const og = QS(document, 'meta[property="og:site_name"]');
        const site = (og && ATTR(og, 'content')) || location.hostname.replace(/^www\./, '');
        all.unshift({ k: 'h', l: 1, c: [site + ' front page'], sr: 1 });
      }
    }
    // round 6: a filter heading whose filters went to the Filters menu ("Popular Filters" over eBay's results) heads
    // nothing: it goes when results or another heading follow it
    for (let i = 0; i < all.length; i++) {
      const b = all[i], nx = all[i + 1];
      if (b.k === 'h' && b.l >= 2 && /^(popular |all |more |top )?(filters?|refine( by| results)?|filter by)\s*:?$/i.test(runText(b.c || []).trim()) && (!nx || nx.k === 'card' || nx.k === 'h' || nx.k === 'meta')) { all.splice(i, 1); i--; continue; }
      // and a sign-up for the shop's emails at the page's end (a heading or line, an email field, Sign up) is a newsletter
      const emailIn = (x) => x && x.k === 'p' && x.c && x.c.some((y) => Array.isArray(y) && y[0] === 'in' && y[2] && (y[2].t === 'email' || /e-?mail/i.test((y[2].l || '') + ' ' + (y[2].p || ''))));
      const signUp = (x) => x && x.k === 'p' && x.c && x.c.some((y) => Array.isArray(y) && y[0] === 'btn' && /^(sign ?up|subscribe|join|get (the )?(deals|emails?|updates))\b/i.test((y[2] || '').trim()));
      if ((b.k === 'h' || b.k === 'p') && runText(b.c || []).trim().length <= 120 && !emailIn(b) && emailIn(nx) && (signUp(nx) || signUp(all[i + 2]))) {
        const n = signUp(nx) ? 2 : 3;
        all.splice(i, n); dropCount(ctx, 'newsletter'); i--; continue;
      }
      // and a shop's promotion line between two runs of its results ("Holiday baking from $1", Target's), a few words, a
      // link and a price or an offer
      if (b.k === 'p' && !b.depth && b.c && all[i - 1] && all[i - 1].k === 'card' && nx && nx.k === 'card' && runText(b.c).trim().length <= 60 &&
          b.c.some((x) => Array.isArray(x) && x[0] === 'a') && (PRICE.test(runText(b.c)) || PROMO_TXT.test(runText(b.c)))) { all.splice(i, 1); dropCount(ctx, 'promo'); i--; continue; }
      // and a feedback ask of its own line ("Tell us about your search experience")
      { const ft = runText(b.c || []).replace(/\s*[-–]\s*opens in (a )?new (window|tab)( or tab)?\.?$/i, '').trim();
        if ((b.k === 'p' || b.k === 'li') && !b.depth && b.c && ft.length <= 60 && FEEDBACK_HEAD.test(ft)) { all.splice(i, 1); i--; continue; } }
      // and a list's own tabs, each a word and its count ("Open 22", "Closed 18,478" over GitHub's issues), are one line
      const tab = (x) => x && (x.k === 'li' || x.k === 'p') && !x.depth && x.c && x.c.filter((y) => Array.isArray(y)).length === 1 &&
        x.c.every((y) => typeof y === 'string' ? !y.trim() : y[0] === 'a' && /^[\p{L}][\p{L} ]{1,20}\s[\d.,]+[kKmM]?$/u.test(runText(y.slice(3)).trim()));
      if (tab(b) && tab(nx)) {
        let j = i; const c = [];
        while (j < all.length && tab(all[j])) { if (c.length) c.push(' · '); c.push(all[j].c.find((y) => Array.isArray(y))); j++; }
        all.splice(i, j - i, { k: 'p', c });
        continue;
      }
      // and a post's own "Table of Contents" button alone on its line (Substack's) opens a panel the view doesn't need
      if (b.k === 'p' && b.c && b.c.filter((x) => Array.isArray(x)).length === 1 && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'btn' && /^(table of )?contents$/i.test((x[2] || '').trim()))) { all.splice(i, 1); i--; continue; }
      // and a product's colour swatches as items of a small picture each (IKEA's) are one line of their names; the one
      // whose picture is the product's own (its alt a description, not a colour) is the colour already named above
      const sw = (x) => { if (!x || !(x.k === 'li' || x.k === 'p') || x.depth || !x.c) return null; const r = x.c.filter((y) => typeof y !== 'string' || y.trim()); if (r.length !== 1 || !Array.isArray(r[0])) return null;
        const im = r[0][0] === 'img' ? r[0] : r[0][0] === 'a' && r[0].length === 4 && Array.isArray(r[0][3]) && r[0][3][0] === 'img' ? r[0][3] : null;
        return im && (im[3] || 0) > 0 && (im[3] || 0) <= 80 ? [r[0], im] : null; };
      if (sw(b) && sw(nx)) {
        let j = i; const c = [];
        while (j < all.length && sw(all[j])) {
          const [run, im] = sw(all[j]); const nm = swatchName((im[2] || '').replace(/\s+/g, ' ').trim());
          if (nm && nm.length <= 32) { if (c.length) c.push(' · '); c.push(run[0] === 'a' ? ['a', run[1], run[2], nm] : nm); }
          j++;
        }
        if (c.length) { all.splice(i, j - i, { k: 'p', c }); continue; }
      }
      // and a list's "Next" or "Previous" set as a heading (Google's pages) is its link, not a section
      if (b.k === 'h' && b.l >= 2 && /^(next|previous|prev|more results)( page)?\s*[›»>→]*$/i.test(runText(b.c || []).trim()) && (b.c || []).some((x) => Array.isArray(x) && x[0] === 'a')) { b.k = 'p'; delete b.l; }
    }
    // round 6: a site's footer drawn without a landmark (Vimeo's: "Get started for free", "Pricing Contact sales", its
    // support line, "© 2026 Vimeo.com, Inc.", Terms, Privacy) is the site's: from its copyright line back to the page's
    // last reading, its short lines' links join the menu and its words go
    {
      let ci = -1;
      for (let i = all.length - 1; i >= 0 && i >= all.length - 15; i--) { const b = all[i]; if ((b.k === 'p' || b.k === 'li' || b.k === 'meta') && !b.depth && /^(©|\(c\)|copyright\b)|all rights reserved/i.test(runText(b.c || []).trim())) { ci = i; break; } }
      if (ci > 0) {
        const foot = (b) => b && (b.k === 'p' || b.k === 'li' || b.k === 'meta') && !b.depth && !b.q && b.c && runText(b.c).trim().length <= 200;
        let s0 = ci;
        while (s0 > 0 && ci - s0 < 12 && foot(all[s0 - 1])) s0--;
        let e = ci + 1;
        while (e < all.length && foot(all[e])) e++;
        if (e - s0 >= 3 && s0 > 0) {
          const moved = all.splice(s0, e - s0);
          const links = moved.flatMap((b) => (b.c || []).filter((x) => Array.isArray(x) && (x[0] === 'a' || x[0] === 'btn')));
          if (links.length) sh.menu.push({ kind: 'footer', n: 'Site menu', c: links });
        }
      }
    }
    // round 6: a post's byline drawn as lines of their own under its title (the author's picture, "SCOTT ALEXANDER",
    // "Nov 06, 2026": Substack's) is one quiet line, its picture left out
    {
      const h1x = all.findIndex((b) => b.k === 'h' && b.l === 1);
      const DATE = /^(\w{3,9}\.? \d{1,2},? \d{4}|\d{1,2} \w{3,9}\.? \d{4}|\d{4}-\d{2}-\d{2}|\d+\s?(m|h|d|w|mo|y|min|hr|hrs|days?|weeks?|months?|years?)( ago)?|(updated|published|posted) .{3,30})$/i;
      const small = (b) => b && b.k === 'p' && !b.depth && b.c && b.c.length && b.c.every((x) => typeof x === 'string' ? !x.trim() : Array.isArray(x) && ((x[0] === 'img' && (x[3] || 0) <= 80) || (x[0] === 'a' && x.length === 4 && Array.isArray(x[3]) && x[3][0] === 'img' && (x[3][3] || 0) <= 80)));
      const short = (b) => b && b.k === 'p' && !b.depth && b.c && !b.c.some((x) => Array.isArray(x) && (x[0] === 'btn' || x[0] === 'in' || x[0] === 'img')) && (() => { const t = runText(b.c).trim(); return t.length >= 2 && t.length <= 40 && !/[.!?]$/.test(t); })();
      let i = h1x + 1;
      if (h1x >= 0 && all[i] && ((all[i].k === 'h' && all[i].l >= 2) || all[i].k === 'meta')) i++;
      let j = i;
      while (j < all.length && j - i < 4 && (small(all[j]) || short(all[j]))) j++;
      const run = all.slice(i, j), texts = run.filter(short);
      if (h1x >= 0 && texts.length >= 2 && texts.length <= 3 && texts.some((b) => DATE.test(runText(b.c).trim())) && texts.some((b) => !DATE.test(runText(b.c).trim()))) {
        const c = [];
        for (const b of texts) { if (c.length) c.push(' · '); c.push(...b.c.filter((x) => typeof x !== 'string' || x.trim()).map((x) => typeof x === 'string' ? x.trim() : x)); }
        all.splice(i, j - i, { k: 'meta', c, by: 1 });
      }
    }
    const groups = [];
    const byName = new Map();
    for (const m of sh.menu) {
      let g = byName.get(m.n);
      if (!g) { g = { n: m.n, c: [] }; byName.set(m.n, g); groups.push(g); }
      for (const x of m.c) {
        const key = JSON.stringify(x.slice(2));
        if ((x[0] === 'in' || x[0] === 'sel' || x[0] === 'ta') && sh.bar.some((y) => y[0] === x[0] && JSON.stringify(y.slice(2)) === key)) continue;   // the same field as the row's
        if (!g.c.some((y) => JSON.stringify(y.slice(2)) === key) && g.c.length < 220) g.c.push(x);
      }
    }
    // Site menu first, then filters, then contents
    const order = (g) => g.n === 'Site menu' ? 0 : /filter/i.test(g.n) ? 1 : g.n === 'Contents' ? 2 : 3;
    groups.sort((a, b) => order(a) - order(b));
    // round 5: a "Filters" of one lone button (a recipe's reviews' "Filter") is no filter rail: the real page has it
    for (let i = groups.length - 1; i >= 0; i--) if (/^filters?$/i.test(groups[i].n) && groups[i].c.length < 2) groups.splice(i, 1);
    // no site row on an empty document (about:blank, a page still parsing): an empty view stays empty
    if (head.length || body.length || groups.length || sh.bar.length) out.push(siteRow(sh, groups));
    // T47X-2: the site's own security, session or payment notices, each as one small block with its buttons
    if (SCAN && SCAN.notices) for (const n of SCAN.notices) if (n.isConnected && vis(n)) { const nb = consentBlock(n, sh, true); nb.k = 'notice'; out.push(nb); }
    // a thin page behind a consent wall: the banner stays, as one small block with its own buttons
    const shown = body.reduce((n, b) => n + (b.c ? JSON.stringify(b.c).length : 0), 0);
    if (SCAN && shown < 300) for (const c of SCAN.consent) if (c.el.isConnected && vis(c.el)) { out.push(consentBlock(c.el, sh)); st.consent_shown = 1; break; }
    // the main video sits in place; when it lies outside the article the walk covered, it follows the headline
    const main = SCAN && SCAN.islands.find((c) => c.main);
    let hi = all.findIndex((b) => b.k === 'h' && b.l === 1);
    if (main && main.box.isConnected && !sh.used.has(main.box)) { sh.used.add(main.box); all.splice(hi + 1, 0, islandBlock(main)); }
    // the structured facts (times, rating, price) follow the headline and its byline
    if (facts) {
      hi = all.findIndex((b) => b.k === 'h' && b.l === 1);
      let at = hi + 1;
      while (all[at] && all[at].k === 'meta') at++;
      all.splice(at, 0, facts);
    }
    // a product page (its JSON-LD is a Product): the buy row (quantity and the primary Add to cart) follows the options,
    // high on the page, as spec §5 orders it, not after delivery notes, upsells and the site's own extras
    if (facts && facts.type === 'Product') {
      // the gallery comes first (spec §5, Product): its thumbnail row and "9 photos" line move above the name
      {
        const h0 = all.findIndex((b) => b.k === 'h' && b.l === 1);
        const gal = [];
        for (let i = h0 + 1; i < all.length && i < h0 + 12; i++) {
          const b = all[i];
          if (b.k === 'h') break;
          const thumbs = b.k === 'p' && b.c && b.c.length && b.c.every((x) => typeof x === 'string' ? !x.trim() : x[0] === 'img');
          const count = b.k === 'p' && b.c && b.c.length === 1 && typeof b.c[0] === 'string' && /^\d+ .{0,40}\b(images|photos|pictures|media)$/i.test(b.c[0].trim());
          if (thumbs || count) gal.push(i);
        }
        if (h0 >= 0 && gal.length) { const moved = gal.map((i) => all[i]); for (let k = gal.length - 1; k >= 0; k--) all.splice(gal[k], 1); all.splice(h0, 0, ...moved.filter((b) => !(b.c.length === 1 && typeof b.c[0] === 'string'))); }
      }
      const h1x = all.findIndex((b) => b.k === 'h' && b.l === 1);
      const buy = all.findIndex((b, i) => i > h1x && b.c && b.c.some((x) => Array.isArray(x) && x[0] === 'btn' && x[3] && x[3].pri && /add to (cart|bag|basket)|buy now|add to order/i.test(x[2] || '')));
      if (h1x >= 0 && buy - h1x > 8) {
        let from = buy;
        const prev = all[buy - 1];
        if (prev && prev.c && prev.c.some((x) => Array.isArray(x) && x[0] === 'in' && x[2] && (x[2].t === 'number' || /quantity|qty/i.test(x[2].l || '')))) from = buy - 1;
        const rows = all.splice(from, buy - from + 1);
        // after the first options section (a heading like "Choose color" or "Size", and what follows it), else after the facts
        let at = h1x + 1;
        while (all[at] && (all[at].k === 'facts' || all[at].k === 'meta')) at++;
        const oi = all.findIndex((b, i) => i > h1x && i < from && b.k === 'h' && /^(choose|select|pick)\b|\b(size|colou?r|style|option|finish)s?\b/i.test(runText(b.c || [])));
        if (oi > 0) { at = oi + 1; while (all[at] && all[at].k !== 'h') at++; }
        all.splice(at, 0, ...rows);
      }
    }
    profileCard(all);
    frontRows(all);
    // R17: on a video page (its JSON-LD is a VideoObject and the main player is large) the island leads, then the title
    const mi = all.findIndex((b) => b.k === 'media' && b.main);
    if (mi > 0 && facts && facts.type === 'VideoObject' && all[mi].w >= 500) { const [m] = all.splice(mi, 1); all.unshift(m); }
    out.push(...all);
    if (sh.related) out.push({ k: 'group', n: sh.related.n, rel: 1, c: sh.related.c.slice(0, 200) });
    // a paywall: the view ends where the real page stops showing, with one closing line (the renderer draws "The rest
    // is for subscribers · Subscribe or sign in on the real page", both links to the real page)
    const W = SCAN && SCAN.wall;
    if (W) st.wall = { kind: W.kind, how: W.how, covered: W.covered, locked: W.locked, text: W.text, frames: W.frames && W.frames.length ? W.frames : undefined };
    if (W && W.kind === 'paywall') out.push({ k: 'wall', kind: 'paywall', t: 'The rest is for subscribers' });
    // R72: a feed that stops for signed-out visitors ends with one line (its sign-in prompt was cut out, R71)
    if (!W && SCAN && SCAN.posts && SCAN.posts.size >= 2) {
      let signin = false;
      for (const [el, c] of SCAN.junk) if (c === 'popup' && el.isConnected && (SIGNIN_TXT.test((el.textContent || '').slice(0, 600)) || QS(el, 'a[href*="login" i],a[href*="onboarding" i],a[href*="signup" i],a[href*="/i/flow/" i]'))) { signin = true; break; }
      if (signin) {
        const og = QS(document, 'meta[property="og:site_name"]');
        const site = ((og && ATTR(og, 'content')) || location.hostname.replace(/^www\./, '')).replace(/\s*\(.*\)\s*$/, '');
        out.push({ k: 'wall', kind: 'signin', t: site + ' shows more posts after you sign in' });
      }
    }
    return out;
  }

  // R68: a profile (a stats line of Following and Followers links under its name) leads with its card: the banner, the
  // name with its verified mark, the handle and post count on one line, the bio, one facts line (place, site, born,
  // joined), the stats line, Follow and Mention, then the site's own tabs. The header's own back link, search button
  // and repeated name drop.
  const STAT_HREF = /\/(following|followers|verified_followers|follows|subscribers)\/?$/i;
  const runsOf = (b, k) => (b && b.c || []).filter((x) => Array.isArray(x) && x[0] === k);
  const plain = (b) => runText((b && b.c) || []).replace(/\s+/g, ' ').trim();
  function profileCard(all) {
    const si = all.findIndex((b) => b.k === 'p' && runsOf(b, 'a').filter((x) => STAT_HREF.test(x[2] || '')).length >= 2);
    const h1 = all.findIndex((b) => b.k === 'h' && b.l === 1);
    if (si < 0 || h1 < 0 || h1 > si || si - h1 > 24) return;
    const name = plain(all[h1]);
    let handle = null, count = null, bio = null;
    const facts = [], drop = new Set();
    for (let i = h1 + 1; i < si; i++) {
      const b = all[i], t = plain(b);
      if (b.k !== 'p' && b.k !== 'meta') continue;
      const only = (b.c || []).filter((x) => typeof x !== 'string' || x.trim());
      if (t === name || /^[\d.,]+\s?[KMB]?\s+(posts|tweets|toots|skeets|statuses)$/i.test(t)) { if (t !== name) count = t; drop.add(i); continue; }
      if (only.length === 1 && Array.isArray(only[0]) && (only[0][0] === 'btn' && /^(search|back|more)$/i.test(only[0][2] || '') ||
          only[0][0] === 'a' && (() => { try { return new URL(only[0][2], location.href).pathname === '/'; } catch (e) { return false; } })())) { drop.add(i); continue; }
      if (!handle && /^@[\w.\-]{1,40}$/.test(t)) { handle = t; drop.add(i); continue; }
      if (!handle) continue;
      if (!bio && !/^(born|joined)\b/i.test(t) && !(only.length === 1 && only[0][0] === 'a')) { bio = i; continue; }
      if (t && t.length <= 80) { facts.push(b); drop.add(i); }
    }
    if (!handle) return;
    // Follow and Mention, once each (Follow primary), then the tabs, from the rows right after the stats line
    const acts = [], tabs = [];
    let end = si;
    while (all[end + 1] && all[end + 1].k === 'p') {
      const rs = (all[end + 1].c || []).filter((x) => typeof x !== 'string' || x.trim());
      if (!rs.length || !rs.every((x) => Array.isArray(x) && (x[0] === 'btn' || (x[0] === 'a' && /^(mention|follow|message|subscribe)\b/i.test(runText(x.slice(3)).trim()))))) break;
      for (const x of rs) {
        const n = x[0] === 'btn' ? x[2] : runText(x.slice(3)).trim();
        if (x[0] === 'btn' && x[3] && x[3].r === 'tab') { tabs.push(x); continue; }
        if (acts.some((y) => (y[0] === 'btn' ? y[2] : runText(y.slice(3)).trim()) === n)) continue;
        const flags = Object.assign({}, x[0] === 'btn' && x[3] && typeof x[3] === 'object' ? x[3] : {});
        if (/^(follow|subscribe)\b/i.test(n)) flags.pri = 1; else delete flags.pri;
        acts.push(x[0] === 'btn' ? ['btn', x[1], x[2], Object.keys(flags).length ? flags : 0] : x);
      }
      end++;
    }
    acts.sort((a, b) => (/^(follow|subscribe)\b/i.test(b[0] === 'btn' ? b[2] : '') ? 1 : 0) - (/^(follow|subscribe)\b/i.test(a[0] === 'btn' ? a[2] : '') ? 1 : 0));
    const sep = (list) => list.flatMap((x, i) => (i ? [' · '] : []).concat(x));
    const head = all[h1];
    const ver = QS(document, '[aria-label="Verified account"],svg[aria-label*="erified"],[data-testid="icon-verified"]');
    if (ver && RECT(ver).top + scrollY < 900 && !/✓/.test(name)) head.c = (head.c || []).concat([' ✓']);
    const card = [head, { k: 'p', c: [handle].concat(count ? [' · ' + count] : []) }];
    if (bio !== null) card.push(all[bio]);
    if (facts.length) card.push({ k: 'p', c: sep(facts.map((b) => (b.c || []).filter((x) => typeof x !== 'string' || x.trim()))) });
    card.push(all[si]);
    if (acts.length) card.push({ k: 'p', c: acts.flatMap((x, i) => (i ? [' '] : []).concat([x])) });
    if (tabs.length) card.push({ k: 'p', c: tabs.flatMap((x, i) => (i ? [' '] : []).concat([x])) });
    const rest = all.slice(h1 + 1, si).filter((b, k) => !drop.has(h1 + 1 + k) && h1 + 1 + k !== bio);
    all.splice(h1, end - h1 + 1, ...card, ...rest);
  }
  // R62: on a front page (two or more stories already cards with their photos), a story headline that is a heading of
  // one link becomes a row card; its read time and its count join its card's line; "More coverage" labels drop
  function frontRows(all) {
    if (all.filter((b) => b.k === 'card' && b.g === 'story').length < 2) return;
    for (const b of all) if (b.k === 'card') b.c = b.c.map((x) => typeof x === 'string' ? x.replace(/\b(\d+)\s*MIN(UTE)?S? READ\b/g, '$1 min read') : x);
    const key = (u) => (u || '').replace(/[#?].*$/, '').replace(/\/$/, '');
    let sec = 0;
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (b.k === 'h' && b.l <= 2) { sec = i; continue; }
      if (b.k === 'h' && b.l >= 3) {
        const only = (b.c || []).filter((x) => typeof x !== 'string' || x.trim());
        if (only.length === 1 && Array.isArray(only[0]) && only[0][0] === 'a') {
          const title = runText(only[0].slice(3)).replace(/\s+/g, ' ').trim();
          if (title.length >= 25 && /\/(article|story|news|video)s?\//.test(only[0][2] || '')) {
            all[i] = { k: 'card', g: 'rows' + sec, lay: 'list', title, c: [['a', only[0][1], only[0][2], title]] };
          }
        }
        continue;
      }
      if (b.k !== 'p' || i === 0) continue;
      const prev = all[i - 1];
      const t = plain(b);
      if (/^(more coverage|related coverage|more stories|related stories|watch more)$/i.test(t) && !runsOf(b, 'a').length) { all.splice(i, 1); i--; continue; }
      if (!prev || prev.k !== 'card') continue;
      const pu = key((runsOf(prev, 'a').find((x) => !(Array.isArray(x[3]) && x[3][0] === 'img')) || [])[2]);
      const rt = /^(\d+)\s*min(ute)?s? read$/i.exec(t);
      if (rt && !runsOf(b, 'a').length) { prev.c.push(' · ' + rt[1] + ' min read'); all.splice(i, 1); i--; continue; }
      // a count linking to the same story ("148"), alone or ahead of the section's topic links
      const rs = (b.c || []).filter((x) => typeof x !== 'string' || x.trim() && x.trim() !== '·');
      if (rs.length && Array.isArray(rs[0]) && rs[0][0] === 'a' && key(rs[0][2]) === pu && /^[\d.,]+[kKmM]?$/.test(runText(rs[0].slice(3)).trim())) {
        prev.c.push(' · ' + runText(rs[0].slice(3)).trim());
        const left = rs.slice(1);
        if (left.length) { all[i] = Object.assign({}, b, { c: left.flatMap((x, k) => (k ? [' · '] : []).concat([x])) }); }
        else { all.splice(i, 1); i--; }
      }
    }
  }

  // ---------------------------------------------------------------- modes
  let forcedMode = null;
  function extractPage(st) {
    const ctx = newCtx((e) => e);
    ctx.pointerHeuristic = true;
    const t0 = performance.now();
    const dctx = newCtx((e) => e, ctx.sh);
    st.dialogs = hoistDialogs(dctx);
    if (document.body) { walk(document.body, ctx); flush(ctx); }
    st.ms_walk = performance.now() - t0;
    st.nodes = ctx.sh.nodes; st.refs = ctx.sh.refs; st.pointer_heuristic = ctx.sh.pointer; st.truncated = ctx.sh.truncated;
    return assemble(ctx, dctx.blocks, ctx.blocks, st);
  }
  // In article mode the walk covers only the article; the chrome regions and fields outside it go to the bar.
  function outsideChrome(ctx, root) {
    if (!SCAN) return;
    for (const [el, k] of SCAN.chrome) {
      if (CONTAINS(root, el) || CONTAINS(el, root) || !vis(el)) continue;
      if ([...SCAN.chrome.keys()].some((o) => o !== el && CONTAINS(o, el) && !CONTAINS(o, root))) continue;
      if (inJunk(SCAN, el)) continue;
      chromeInto(el, el, ctx, k);
    }
    // a search field anywhere outside the article
    if (!ctx.sh.bar.length) {
      for (const e of QSA(document, 'input[type=search],input[name=q],input[name=search],input[role=searchbox],input[role=combobox],[role=search] input')) {
        if (CONTAINS(root, e) || !vis(e) || inJunk(SCAN, e)) continue;
        const c = newCtx((x) => x, ctx.sh); control(e, e, role(e) || 'textbox', c); flush(c);
        if (c.blocks[0]) ctx.sh.bar.push(c.blocks[0].c[0]);
        break;
      }
    }
  }
  const ROOT_SEL = '[itemprop=articleBody],article,[role=main],main,.mw-parser-output,#mw-content-text,#content,#main-content,' +
    '.post-content,.entry-content,.article-body,.article-content,.story-body';
  // v1's article-mode classes; comments are no longer dropped here: they fold into one line (spec 5)
  const JUNK = /^(share|sharing|social|related|newsletter|promo|advert|ad|ads|ad-slot|sponsor|sponsored|outbrain|taboola|recirc|most-popular|navbox|vertical-navbox|mw-editsection|noprint|mw-jump-link|subscribe|paywall)$/i;
  function semanticRoot(st) {
    const score = new Map();
    let total = 0, anchor = 0;
    for (const p of BYTAG(document, 'p')) {
      const n = p.textContent.length;
      if (n < 40) continue;
      // a hidden box's paragraphs (a consent manager's modal waiting off screen) aren't the page's text
      if (!vis(p)) continue;
      total += n;
      for (let a = p.parentElement; a; a = a.parentElement) score.set(a, (score.get(a) || 0) + n);
    }
    for (const a of BYTAG(document, 'a')) anchor += a.textContent.length;
    st.p_chars = total; st.anchor_chars = anchor;
    if (total < 1200) return null;
    let best = null, bestN = 0;
    const cands = Array.from(QSA(document, ROOT_SEL)).filter((e) => (score.get(e) || 0) >= 0.6 * total);
    for (const e of cands) { const n = score.get(e); if (n > bestN) { best = e; bestN = n; } }
    if (!best) return null;
    let depthBest = -1, pick = best;
    for (const e of cands) {
      if (score.get(e) < 0.85 * bestN) continue;
      // a deeper root never leaves out the opening: paragraphs of the wider root that come before it, in its column
      // (a story's first paragraphs in a box of their own before the rest, Ars Technica's)
      if (e !== best && CONTAINS(best, e) && openingLeftOut(best, e)) continue;
      let d = 0; for (let a = e; a; a = a.parentElement) d++;
      if (d > depthBest) { depthBest = d; pick = e; }
    }
    return vis(pick) ? pick : null;
  }
  function openingLeftOut(wide, deep) {
    const r = RECT(deep);
    let left = 0;
    for (const p of QSA(wide, 'p')) {
      if (CONTAINS(deep, p)) break;   // document order: only what comes before the deeper root counts
      if (!(NP.compareDocumentPosition.call(p, deep) & 4)) continue;   // the deeper root follows this paragraph
      const n = (p.textContent || '').trim().length;
      if (n < 40 || !vis(p)) continue;
      const q = RECT(p);
      const overlap = Math.min(q.right, r.right) - Math.max(q.left, r.left);
      if (q.width > 0 && overlap >= 0.5 * q.width) left += n;
      if (left >= 150) return true;
    }
    return false;
  }
  function isJunk(el) {
    for (const c of CLISTOF(el)) if (JUNK.test(c)) return true;
    return IDOF(el) ? JUNK.test(IDOF(el)) : false;
  }
  function headOf(root) {
    const head = [];
    const h1 = SCAN && SCAN.h1;
    if (h1 && !CONTAINS(root, h1)) head.push({ k: 'h', l: 1, c: [clip(txt(h1), 300)] });
    return head;
  }
  // R34, round 4: a repo's About is its facts, not its whole side column: the description and website (what follows the
  // heading), up to six topics then "+N", and one line of its stars, watchers and forks. Its resource links (readme,
  // license, policies), activity and report links are the site's own furniture and stay on the real page.
  function aboutFacts(blocks, box) {
    const out = [];
    const isH = (b) => b.k === 'h';
    let i = blocks.findIndex((b) => isH(b) && /^\s*about\s*$/i.test(runText(b.c || [])));
    for (i = i + 1; i < blocks.length && !isH(blocks[i]); i++) out.push(blocks[i]);
    const ti = blocks.findIndex((b) => isH(b) && /^\s*topics\s*$/i.test(runText(b.c || [])));
    if (ti >= 0 && blocks[ti + 1] && !isH(blocks[ti + 1])) {
      const links = (blocks[ti + 1].c || []).filter((x) => Array.isArray(x) && x[0] === 'a');
      if (links.length) {
        const c = [];
        links.slice(0, 6).forEach((x, k) => { if (k) c.push(' · '); c.push(x); });
        if (links.length > 6) c.push(' +' + (links.length - 6));
        out.push({ k: 'p', c });
      }
    }
    const stats = [], STAT = /^[\d.,]+[kKmM]? (stars?|watching|watchers?|forks?)$/i;
    let n = 0;
    for (const e of QSA(box, '*')) {
      if (++n > 1500) break;
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (!STAT.test(t) || stats.includes(t) || Array.from(e.children).some((k) => STAT.test((k.innerText || '').replace(/\s+/g, ' ').trim())) || !vis(e)) continue;
      stats.push(t);
    }
    if (stats.length) out.push({ k: 'p', c: [stats.join(' · ')] });
    return out.length ? [{ k: 'h', l: 2, c: ['About'] }, ...out] : blocks;
  }
  function extractArticleFast(st, root) {
    const t0 = performance.now();
    const ctx = newCtx((e) => e);
    ctx.junk = true;
    const dctx = newCtx((e) => e, ctx.sh);
    st.dialogs = hoistDialogs(dctx);
    const head = headOf(root);
    walk(root, ctx); flush(ctx);
    // R34, R35, R8: inside the same main landmark, a list table (a repo's files) comes before the article, and a box
    // headed "About" (the page's own facts) follows the title
    const main = CLOSEST(root, 'main,[role=main]');
    const pre = [], about = [];
    if (main && main !== root) {
      for (const t of QSA(main, 'table,[role=grid],[role=table]')) {
        if (CONTAINS(root, t) || (t.parentElement && CLOSEST(t.parentElement, 'table,[role=grid],[role=table]')) || !vis(t) || (SCAN && (inJunk(SCAN, t) || [...SCAN.chrome.keys()].some((c) => CONTAINS(c, t))))) continue;
        const rows = QSA(t, 'tr,[role=row]').length;
        if (rows < 3 || pre.some((x) => CONTAINS(x.el, t))) continue;
        const g = newCtx((e) => e, ctx.sh); walk(t.parentElement && t.parentElement.childElementCount <= 3 ? t.parentElement : t, g); flush(g);
        // R35, round 4: ten rows, then the rest folded ("Show all 26 files"), so the README isn't pushed down a page
        for (let i = 0; i < g.blocks.length; i++) {
          const b = g.blocks[i];
          if (b.k !== 'tbl' || !b.rows || b.rows.length <= 12) continue;
          const head = b.rows[0] && b.rows[0].every((c) => c.h) ? 1 : 0;
          const rest = b.rows.slice(head + 10);
          b.rows = b.rows.slice(0, head + 10);
          g.blocks.splice(i + 1, 0, { k: 'group', n: 'Show all ' + (rest.length + 10) + ' files', fold: 1, c: [{ k: 'tbl', rows: rest }] });
          break;
        }
        if (g.blocks.length) pre.push({ el: t, blocks: g.blocks });
      }
      for (const h of QSA(main, 'h2,h3')) {
        if (CONTAINS(root, h) || !/^\s*about\s*$/i.test(h.textContent || '') || !vis(h)) continue;
        let box = h.parentElement;
        for (let i = 0; i < 3 && box && (box.textContent || '').length < (h.textContent || '').length + 40; i++) box = box.parentElement;
        if (!box || CONTAINS(box, root) || (box.innerText || '').length > 3000) continue;
        const g = newCtx((e) => e, ctx.sh); walk(box, g); flush(g);
        if (g.blocks.length) about.push(...aboutFacts(g.blocks, box));
        break;
      }
    }
    if (pre.length || about.length) ctx.blocks = [...about, ...pre.flatMap((x) => x.blocks), ...ctx.blocks];
    // a wiki's category links sit outside the article: they fold into the menu as "Categories", a tap away
    const cats = QS(document, '#catlinks,.catlinks');
    if (cats && !CONTAINS(root, cats) && vis(cats) && QSA(cats, 'a[href]').length >= 2) chromeInto(cats, cats, ctx, 'cats');
    const t1 = performance.now();
    st.ms_walk = t1 - t0;
    outsideChrome(ctx, root);
    st.ms_controls = performance.now() - t1;
    st.nodes = ctx.sh.nodes; st.refs = ctx.sh.refs; st.truncated = ctx.sh.truncated;
    st.root = LNOF(root) + (IDOF(root) ? '#' + IDOF(root) : '') + (CLISTOF(root).length ? '.' + Array.from(CLISTOF(root)).slice(0, 2).join('.') : '');
    return assemble(ctx, dctx.blocks.concat(head), ctx.blocks, st);
  }
  function extractArticle(st) {
    const t0 = performance.now();
    const liveAll = BYTAG(document, '*');
    const clone = document.cloneNode(true);
    const cloneAll = BYTAG(clone, '*');
    const n = liveAll.length;
    if (cloneAll.length !== n) { st.why = 'clone mismatch'; return null; }
    const liveArr = new Array(n);
    for (let i = 0; i < n; i++) { liveArr[i] = liveAll[i]; cloneAll[i].setAttribute('data-mi', i); }
    // drop what the scan dropped before Readability scores the page
    if (SCAN) {
      const cloneArr = Array.from(cloneAll);   // a snapshot: removing nodes shifts the live collection
      for (let i = 0; i < n; i++) { const j = SCAN.junk.get(liveArr[i]); if (j && cloneArr[i].isConnected) cloneArr[i].remove(); }
    }
    const t1 = performance.now();
    st.ms_clone = t1 - t0;
    let art;
    try {
      art = new R.Readability(clone, { charThreshold: 500, serializer: (e) => e }).parse();
    } catch (e) { st.why = 'readability error ' + e; return null; }
    const t2 = performance.now();
    st.ms_readability = t2 - t1;
    if (!art || !art.content || (art.length || 0) < 1000) { st.why = 'readability too short (' + (art ? art.length : 0) + ')'; return null; }
    const pageText = document.body ? (document.body.innerText || '').length : 0;
    const outside = pageText - (st.anchor_chars || 0) - art.length;
    if (pageText > 3000 && art.length < 0.3 * pageText && outside > 2 * art.length) {
      st.why = 'readability kept ' + Math.round(100 * art.length / pageText) + '% of the page text';
      return null;
    }
    const live = (e) => { const i = e.getAttribute && ATTR(e, 'data-mi'); return i != null ? liveArr[+i] : null; };
    const ctx = newCtx(live);
    const dctx = newCtx((e) => e, ctx.sh);
    st.dialogs = hoistDialogs(dctx);
    const head = [];
    if (art.title) head.push({ k: 'h', l: 1, c: [clip(art.title, 300)] });
    const meta = [art.byline, art.siteName, art.publishedTime && art.publishedTime.slice(0, 10)].filter(Boolean).map((s) => clip(s, 120));
    if (meta.length) head.push({ k: 'meta', c: [meta.join(' · ')] });
    walk(art.content, ctx); flush(ctx);
    if (ctx.blocks[0] && ctx.blocks[0].k === 'h' && JSON.stringify(ctx.blocks[0].c) === JSON.stringify([clip(art.title, 300)])) ctx.blocks.shift();
    const t3 = performance.now();
    st.ms_walk = t3 - t2;
    outsideChrome(ctx, QS(document.body, 'main,[role=main],article') || document.body.firstElementChild || document.body);
    st.ms_controls = performance.now() - t3;
    st.nodes = ctx.sh.nodes; st.refs = ctx.sh.refs; st.truncated = ctx.sh.truncated;
    st.article_chars = art.length;
    return assemble(ctx, dctx.blocks.concat(head), ctx.blocks, st);
  }
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  let lastHints = {};
  let SCAN_KEY = {};
  let userActed = false;   // the member has pressed something on this page (a pre-roll they started is theirs)
  let KEPT_RELATED = null;
  let BODY_BOX = null;
  function extractText(limit, hints) {
    const t0 = performance.now();
    if (hints && JSON.stringify(hints) !== JSON.stringify(lastHints)) lastHints = hints;
    maxBlocks = limit || 8000;
    const st = { url: location.href, title: document.title, epoch: EPOCH, ready: document.readyState, v: 2, rules: !!RULES,
      doc_h: document.documentElement ? document.documentElement.scrollHeight : 0 };
    KEPT_RELATED = null;
    LANDMARK = new WeakSet();
    BODY_BOX = document.body ? RECT(document.body) : null;
    // a live update that changed only text in place reuses the last scan (what drops, what is chrome, cards, islands);
    // anything structural, a new document, a scroll of more than a screen or new hints scans again
    const sy = scrollY;
    if (SCAN && SCAN_KEY.mut === structMut && SCAN_KEY.url === location.href && SCAN_KEY.hints === lastHints &&
        Math.abs(SCAN_KEY.y - sy) < innerHeight && SCAN_KEY.w === innerWidth && performance.now() - SCAN_KEY.at < 30000) {
      st.scan_reused = 1;
    } else {
      SCAN = null;
      try { SCAN = scanPage(lastHints); } catch (e) { st.scan_err = (String(e) + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/\(.*:(\d+):(\d+)\)/, ':$1')).join(' < ')).slice(0, 300); }
      SCAN_KEY = { mut: structMut, url: location.href, hints: lastHints, y: sy, w: innerWidth, at: performance.now() };
    }
    st.ms_scan = SCAN ? SCAN.stats.ms : null;
    if (SCAN) {   // the scan's stages, each its own share (ms): where a slow page spends its time
      const T = ['t_rules', 't_struct', 't_overlay', 't_share', 't_recirc', 't_chrome', 't_islands', 't_cards'];
      st.scan_t = {}; let prev = 0;
      for (const k of T) if (SCAN.stats[k] != null) { st.scan_t[k.slice(2)] = SCAN.stats[k] - prev; prev = SCAN.stats[k]; }
      st.scan_t.rest = Math.round(SCAN.stats.ms - prev);
      st.scan_sub = SCAN.stats.sub;
    }
    let blocks = null;
    try { TOPIC_POSTS = topicPosts(); } catch (e) { TOPIC_POSTS = new Map(); }
    if (TOPIC_POSTS.size) st.topic_posts = TOPIC_POSTS.size;
    let mode = forcedMode;
    // a discussion (threaded comments: Hacker News, Reddit) is the page itself, not an article with comments under it
    if (!mode && SCAN && SCAN.depth.size >= 5) { mode = 'page'; st.why = 'threaded discussion'; }
    if (!mode || mode === 'article') {
      const root = semanticRoot(st);
      // round 6: a search's results are a listing whatever their answer's paragraphs weigh (Brave's AI answer over its
      // results made the page read as an article)
      const search = searchPage();
      const listing = st.anchor_chars > 1.5 * st.p_chars || search;
      if (search) st.search = 1;
      if (root && (mode === 'article' || !listing)) { blocks = extractArticleFast(st, root); mode = 'article'; st.how = 'semantic-root'; }
      else if (!mode) {
        let readerable = false;
        try { readerable = !listing && R.isProbablyReaderable(document, { minContentLength: 140, minScore: 20 }); } catch (e) { /* ignore */ }
        mode = readerable ? 'article' : 'page';
        if (!readerable) st.why = listing ? 'link-heavy listing' : 'not readerable';
      }
    }
    if (mode === 'readability') mode = 'article';
    if (mode === 'article' && !blocks) {
      blocks = extractArticle(st);
      if (blocks) st.how = 'readability'; else mode = 'page';
    }
    if (!blocks) blocks = extractPage(st);
    st.mode = mode;
    if (SCAN) {
      // what was dropped, by kind (the client shows one quiet line); consent banners the server may settle
      // hidden: what the page showed that the view doesn't, by kind; the number is exactly the sum of the kinds
      const KIND = { ad: 'ads', sponsored: 'sponsored', consent: 'cookie', newsletter: 'newsletter', popup: 'popup', recirc: 'recommended', related: 'recommended', shorts: 'shorts' };
      const dropped = {}, hidden = {};
      for (const [el, c] of SCAN.junk) {
        if (!el.isConnected || !vis(el) || el === KEPT_RELATED) continue;
        let outer = true;
        for (let p = el.parentElement; p; p = p.parentElement) if (SCAN.junk.has(p)) { outer = false; break; }
        if (!outer) continue;
        dropped[c] = (dropped[c] || 0) + 1;
        if (KIND[c] && !(c === 'consent' && st.consent_shown)) hidden[KIND[c]] = (hidden[KIND[c]] || 0) + 1;
      }
      hidden.total = Object.values(hidden).reduce((a, b) => a + b, 0);
      if (hidden.cookie) hidden.cookie_done = 'hidden';
      st.hidden = hidden;
      if (SCAN.structured && SCAN.structured.length) st.structured = SCAN.structured.map((o) => [].concat(o['@type']).join(' ')).slice(0, 4);
      st.dropped = dropped;
      st.by = { list: SCAN.stats.list || 0, cookie: SCAN.stats.cookie || 0, heur: SCAN.stats.heur || 0 };
      st.consent = SCAN.consent.filter((c) => c.el.isConnected && vis(c.el)).map((c) => ({ ref: c.ref, id: IDOF(c), reject: c.reject })).slice(0, 4);
      if (SCAN.cmpFrames.length) st.cmp_frames = SCAN.cmpFrames.slice(0, 4);
      if (SCAN.challenge) st.challenge = SCAN.challenge;
      if (SCAN.app) st.app = 1;
      st.islands = SCAN.islands.length;
      st.cards = SCAN.cards.size;
    }
    const t1 = performance.now();
    const lines = new Array(blocks.length);
    let chars = 0;
    for (let i = 0; i < blocks.length; i++) {
      const j = JSON.stringify(blocks[i]);
      chars += j.length;
      lines[i] = hash(j) + '\t' + j;
    }
    st.blocks = blocks.length;
    st.chars = chars;
    st.ms_serialize = performance.now() - t1;
    st.ms = performance.now() - t0;
    for (const k of Object.keys(st)) if (k.startsWith('ms') && typeof st[k] === 'number') st[k] = Math.round(st[k] * 10) / 10;
    return JSON.stringify(st) + '\n' + lines.join('\n');
  }

  // round 6: a page of a search's results: the address's query is what the page's own search field holds
  function searchPage() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return false; }
    for (const k of ['q', 'query', 'p', 'search', 'searchTerm', 'k', '_nkw', 'st', 'text', 'wd', 'keyword', 'keywords']) {
      const v = (q.get(k) || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (v.length < 2) continue;
      for (const i of QSA(document, 'input[type=search],input[type=text],input:not([type]),textarea')) {
        if ((i.value || '').replace(/\s+/g, ' ').trim().toLowerCase() === v && vis(i)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- islands for deskd (and the run kit)
  // islands(): the current players with their rectangles in viewport coordinates and their play state
  function islands() {
    const S = scanPage(lastHints);
    return S.islands.map((c) => {
      const r = RECT(c.box);
      const vids = [];
      const walkV = (root) => { QSA(root, 'video').forEach((v) => vids.push(v)); QSA(root, '*').forEach((x) => { if (x.shadowRoot) walkV(x.shadowRoot); }); };
      walkV(c.box);
      const vv = vids.find((v) => RECT(v).width >= 100 && !adSrcVideo(v)) || vids.find((v) => RECT(v).width >= 100), vr = vv && RECT(vv);
      return { ref: ref(c.box), main: c.main, src: c.src, x: r.left, y: r.top, w: r.width, h: r.height, frame: c.inner && LNOF(c.inner) === 'iframe',
        vr: vr ? [vr.left, vr.top, vr.width, vr.height] : null,
        playing: vids.some((v) => !v.paused && v.currentTime > 0), pre: !!QS(c.box, PRE_ROLL_SEL) || vids.some((v) => adSrcVideo(v) && !v.paused && RECT(v).width > 0),
        ready: vids.reduce((m, v) => Math.max(m, v.readyState || 0), 0), hasVideo: vids.length > 0 };
    });
  }
  // clearOver(ref): an island streams the real page's pixels, so a promo or consent overlay laid over the player is
  // hidden on the real page (never answered or clicked); restoreHidden() puts everything back (e.g. on a switch to
  // the full stream, where the member sees the page as the site made it).
  const hiddenByUs = [];
  // clearOver(r): settle what covers an island before its crop is taken: the outermost dropped overlay over the
  // video's own rectangle (or, when nothing dropped covers it, the outermost fixed or sticky box laid over it: a
  // sign-up bar, a login wall) is hidden on the real page, checked at the centre and four inner corners
  function clearOver(r) {
    const box = lookup(r);
    if (!box) return { err: 'stale' };
    const v = LNOF(box) === 'video' ? box : box.querySelector && QS(box, 'video');
    const tgt = v && RECT(v).width >= 100 ? v : box;
    const S = SCAN || scanPage(lastHints);
    const out = [];
    for (let round = 0; round < 6; round++) {
      const rc = RECT(tgt);
      let hid = false;
      for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
        const x = rc.left + rc.width * fx, y = rc.top + rc.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const t = document.elementFromPoint(x, y);
        if (!t || CONTAINS(box, t) || CONTAINS(t, box)) continue;
        let top = null;
        for (let p = t; p && p !== document.body; p = p.parentElement) { if (CONTAINS(p, box)) break; const c = S.junk.get(p); if (c && c !== 'recirc' && c !== 'related') top = p; }
        if (!top) for (let p = t; p && p !== document.body; p = p.parentElement) { if (CONTAINS(p, box)) break; const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') top = p; }
        if (!top) { if (!out.some((o) => o.blocked_by)) out.push({ blocked_by: LNOF(t) + (IDOF(t) ? '#' + IDOF(t) : '') }); continue; }
        hiddenByUs.push([top, top.style.getPropertyValue('visibility'), top.style.getPropertyPriority('visibility')]);
        top.style.setProperty('visibility', 'hidden', 'important');
        out.push({ hid: LNOF(top) + (IDOF(top) ? '#' + IDOF(top) : ''), cat: S.junk.get(top) || 'fixed' });
        hid = true; break;
      }
      if (!hid) break;
    }
    return { cleared: out };
  }
  // adoptPopup(ref): some sites' in-page players have no source until a click opens the site's own pop-up player
  // (Wikipedia, Commons). The island stays the in-page player's rectangle: the pop-up's loaded source is given to the
  // in-page <video>, the pop-up is closed with its own close button, and the in-page video plays. Only when the source
  // is a plain URL (not a MediaSource blob, not DRM).
  function adoptPopup(r) {
    const box = lookup(r);
    if (!box) return { err: 'stale' };
    const inline = LNOF(box) === 'video' ? box : QS(box, 'video');
    if (!inline) return { err: 'no inline video' };
    let pop = null;
    for (const v of QSA(document, 'video')) if (v !== inline && !CONTAINS(box, v) && v.currentSrc && !v.currentSrc.startsWith('blob:') && !v.mediaKeys && !AD_VIDEO.test(v.currentSrc)) { pop = v; break; }
    if (!pop) return { err: 'no pop-up source' };
    const src = pop.currentSrc, t = pop.currentTime;
    try { pop.pause(); } catch (e) { /* */ }
    const dlg = CLOSEST(pop, '[role=dialog],dialog,.oo-ui-dialog,.oo-ui-window,[aria-modal=true]');
    const close = dlg && Array.from(QSA(dlg, 'button,[role=button],a')).find((b) => /close|×|✕/i.test((ATTR(b, 'aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '') + ' ' + CLSOF(b)));
    if (close) close.click();
    inline.src = src; inline.muted = true; inline.preload = 'auto';
    try { inline.currentTime = t; } catch (e) { /* */ }
    const p = inline.play();
    if (p && p.catch) p.catch(() => {});
    return { ok: true, closed: !!close, src: src.slice(0, 80) };
  }
  function restoreHidden() {
    for (const [el, v, p] of hiddenByUs.splice(0)) { if (v) el.style.setProperty('visibility', v, p); else el.style.removeProperty('visibility'); }
  }

  // for the run kit and debugging: what the scan decided, with sizes
  let DEBUG_SRC = false;
  // R46: a thread that draws posts only near the viewport (Discourse cloaks the rest to empty boxes that keep their id)
  // is read while the page is scrolled through: harvest() keeps each drawn post's blocks by its id, and the walk puts
  // them back where the cloaked box sits
  const POSTS = new Map();
  const POST_ID = /^(post|comment|reply)[-_]?\d+$/i;
  function harvest() {
    let n = 0;
    for (const el of QSA(document, '[id^=post_],[id^=post-],[id^=comment-],[id^=comment_]')) {
      const id = IDOF(el);
      if (!POST_ID.test(id) || (el.textContent || '').trim().length < 80 || !vis(el)) continue;
      const ctx = newCtx((e) => e);
      ctx.inPost = true;
      try { walk(el, ctx); flush(ctx); } catch (e) { continue; }
      if (ctx.blocks.length) { POSTS.set(id, ctx.blocks); n++; }
    }
    return n;
  }

  // round 4: Discourse cloaks a thread's posts away from the viewport to empty boxes (`post-stream--cloaked`, which keep
  // their id, number and height), so a member's tab, which nothing scrolls, shows the first few posts and a column of
  // "21 days later". The posts' own words are in the topic the page already loaded and keeps in its document (its
  // `script#data-preloaded`, application/json): each cloaked box whose post is there is read from it, parsed inert
  // (DOMParser: no script runs and nothing loads), and walked as content. Nothing is fetched or pressed. Only on a page
  // Discourse made (its generator), for the topic in the address, for a post shown to everyone (not hidden, deleted, a
  // whisper or a moderator's note) whose author the box itself names.
  let TOPIC_POSTS = new Map();
  let TOPIC_CACHE = { key: '', posts: new Map() };
  function topicDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? M + ' ' + d.getDate() : M + ' ' + d.getFullYear();
  }
  function topicPosts() {
    const out = new Map();
    const gen = QS(document, 'meta[name=generator]');
    if (!gen || !/^Discourse\b/.test(ATTR(gen, 'content') || '')) return out;
    const m = /^\/t\/(?:[^/]+\/)?(\d+)(\/|$)/.exec(location.pathname);
    if (!m) return out;
    const boxes = Array.from(QSA(document, '[id^=post_][data-post-number]')).filter((b) => POST_ID.test(IDOF(b)) && (b.textContent || '').trim().length < 80);
    if (!boxes.length) return out;
    const pre = QS(document, 'script#data-preloaded[type="application/json"]');
    if (!pre) return out;
    const text = pre.textContent || '';
    const key = m[1] + ':' + text.length;
    if (TOPIC_CACHE.key !== key) {
      TOPIC_CACHE = { key, posts: new Map() };
      try {
        const d = JSON.parse(text);
        const v = d && d['topic_' + m[1]];
        const t = typeof v === 'string' ? JSON.parse(v) : v;
        const ps = t && t.post_stream && Array.isArray(t.post_stream.posts) ? t.post_stream.posts : [];
        for (const p of ps.slice(0, 200)) if (p && typeof p.post_number === 'number') TOPIC_CACHE.posts.set(p.post_number, { p, blocks: null });
      } catch (e) { return out; }
    }
    for (const box of boxes) {
      const num = +(ATTR(box, 'data-post-number') || '0');
      const hit = TOPIC_CACHE.posts.get(num);
      if (!hit || IDOF(box) !== 'post_' + num) continue;
      const p = hit.p;
      const user = typeof p.username === 'string' ? p.username : '';
      if (p.post_type !== 1 || p.hidden || p.deleted_at || p.user_deleted || typeof p.cooked !== 'string' || !p.cooked.trim() || !user ||
          !(box.textContent || '').toLowerCase().includes(user.toLowerCase())) continue;
      if (hit.blocks === null) {
        hit.blocks = '';
        try {
          const doc = new DOMParser().parseFromString(p.cooked.slice(0, 100000), 'text/html');
          // a picture's file name and size show on hover only
          for (const x of Array.from(doc.querySelectorAll('.lightbox-wrapper .meta, .cooked-date, script, style'))) x.remove();
          const ctx = newCtx(() => null);
          ctx.inPost = true;
          walk(doc.body, ctx); flush(ctx);
          if (ctx.blocks.length) {
            const name = clip(String(p.name || '').trim() || user, 80);
            const head = [['b', name]];
            const when = topicDate(p.created_at);
            if (when) head.push(' · ' + when);
            hit.blocks = JSON.stringify([{ k: 'p', c: head }, ...ctx.blocks.slice(0, 400)]);
          }
        } catch (e) { hit.blocks = ''; }
      }
      if (hit.blocks) out.set(IDOF(box), hit.blocks);
    }
    return out;
  }

  // fateOf(el): why the view left this element out, when a rule of the spec did: the drop kind of its nearest dropped
  // ancestor in the scan behind the current view (ad, sponsored, recirc, shorts...), else null. The run kit's audit uses
  // it to tell a headline the spec drops from one the distiller lost.
  function fateOf(el) {
    const S = SCAN || scanPage(lastHints);
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p === KEPT_RELATED) return null;
      const c = S.junk.get(p);
      if (c) return c;
    }
    return null;
  }

  // wallScan: is the page covered by a wall the member has to answer, and how much of it can the member see?
  // Judged from what is on screen, not from the DOM: 7x7 points hit-tested, each counted for the fixed overlay on top
  // of it; the viewport's scroll lock; the overlay's own words and buttons.
  //   consent  a cookie banner with a reject choice: the consent rules (§8) as before
  //   nag      a dismissible pop-up (close, "No thanks"): hidden and counted as a pop-up
  //   paywall  the view keeps what the real page shows, then ends with one line (a 'wall' block)
  //   terms    a terms or consent wall that needs agreement and offers no other choice: the real page opens
  //   frame    the wall's words are in a cross-origin frame: the server reads them and decides
  // An in-flow paywall prompt ("Subscribe to continue reading") with no readable text after it is a paywall too.
  function wallScan(S, overlays, root, protectedEl) {
    const H = document.documentElement, B = document.body, VW = innerWidth, VH = innerHeight;
    const hcs = getComputedStyle(H), bcs = getComputedStyle(B);
    const hid = (v) => v === 'hidden' || v === 'clip';
    const locked = hid(hcs.overflowY) || (hcs.overflowY === 'visible' && hid(bcs.overflowY)) || bcs.position === 'fixed';
    const counts = new Map();
    let n = 0, covered = 0;
    const ovs = [...overlays].filter((o) => o.isConnected);
    // hit-testing is costly on big pages: only when the overlays' boxes could cover a quarter of the screen
    let ovArea = 0;
    for (const o of ovs) { const r = RECT(o); ovArea += Math.max(0, Math.min(r.right, VW) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, VH) - Math.max(r.top, 0)); }
    if (ovArea >= 0.2 * VW * VH) for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const e = document.elementFromPoint((i + 0.5) * VW / 7, (j + 0.5) * VH / 7);
      if (!e) continue;
      n++;
      let top = null;
      for (const o of ovs) if ((o === e || CONTAINS(o, e)) && (!top || CONTAINS(o, top))) top = o;
      if (top) { covered++; counts.set(top, (counts.get(top) || 0) + 1); }
    }
    const frac = n ? covered / n : 0;
    let w = null;
    if (frac >= 0.6 || (locked && frac >= 0.25)) {
      const group = [...counts.keys()];
      const text = group.map((g) => (g.innerText || '')).join(' ').replace(/\s+/g, ' ').trim();
      const btns = [];
      for (const g of group) for (const b of QSA(g, 'button,[role=button],a[href],input[type=button],input[type=submit]')) {
        if (!vis(b)) continue;
        const nm = (txt(b) || b.value || ATTR(b, 'aria-label') || ATTR(b, 'title') || '').replace(/\s+/g, ' ').trim();
        if (nm) btns.push(nm);
      }
      const frames = [];
      for (const g of group) for (const f of (LNOF(g) === 'iframe' ? [g] : QSA(g, 'iframe'))) {
        const r = RECT(f);
        if (r.width * r.height >= 0.08 * VW * VH && f.src) frames.push(f.src.slice(0, 300));
      }
      let kind;
      if (btns.some((t) => REJECT_TXT.test(t))) kind = 'consent';
      else if (PAYWALL_TXT.test(text)) kind = btns.some((t) => DISMISS_BTN.test(t)) ? 'nag' : 'paywall';
      else if (/\b(terms|agree|consent|cookies?|privacy)\b/i.test(text) && btns.some((t) => AGREE_BTN.test(t)) &&
               !btns.some((t) => DISMISS_BTN.test(t) || MANAGE_BTN.test(t))) kind = 'terms';
      else if (text.length < 40 && frames.length) kind = 'frame';
      else if (btns.some((t) => DISMISS_BTN.test(t))) kind = 'nag';
      else kind = 'other';
      w = { kind, how: 'overlay', locked, covered: Math.round(frac * 100), text: clip(text, 200), buttons: btns.slice(0, 6), frames: frames.slice(0, 3), els: group };
      if (kind === 'paywall') {
        // the member sees down to the top of the wall's opaque panel (a full-width sheet rising from the bottom), or the
        // bottom of the screen; what the locked page holds below that is out of reach
        let cutY = VH;
        for (const g of group) {
          const r = RECT(g), bg = getComputedStyle(g).backgroundColor;
          const opaque = !/rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) || /,\s*0\.(9\d*)\)$/.test(bg);
          if (opaque && r.width >= 0.8 * VW && r.bottom >= VH - 4 && r.top > 0.15 * VH) cutY = Math.min(cutY, r.top);
        }
        w.cutY = Math.round(cutY);
        if (locked || frac >= 0.6) w.cut = firstBelow(root || B, cutY);
        // a locked page shows the member only the screen it stopped on: what lies above it is out of reach too (the
        // page's title stays, as the view's heading)
        if (locked) {
          const above = [];
          for (const el of QSA(root || B, 'p,h2,h3,h4,h5,h6,li,figure,img,picture,video,pre,table,blockquote,dl,iframe')) {
            if (CLOSEST(el, 'header,nav,[role=banner],[role=navigation],h1') || (S.h1 && CONTAINS(el, S.h1))) continue;
            const r = RECT(el);
            if (r.height > 0 && (r.top + r.bottom) / 2 <= 0) above.push(el);   // more than half above the screen
          }
          for (const el of above) S.junk.set(el, 'cut');
          w.above = above.length;
        }
      }
      if (kind === 'nag') for (const g of group) if (!protectedEl(g)) { S.junk.set(g, 'popup'); }
      if (kind === 'paywall') for (const g of group) S.junk.set(g, 'paywall');
    }
    if (!w || w.kind === 'other') {
      // an in-flow prompt: a short box in the content saying the rest is for subscribers, and no readable text after it
      const scope = root || B;
      const twp = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let tn = twp.nextNode(); tn; tn = twp.nextNode()) {
        if (tn.data.length > 400 || !/subscri|continue reading|already a|unlock|free article|register|keep reading/i.test(tn.data)) continue;
        let el = tn.parentElement, t = '';
        for (let k = 0; el && k < 3; k++, el = el.parentElement) { t = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (t.length > 400 || PAYWALL_TXT.test(t)) break; }
        if (!el || t.length < 12 || t.length > 400 || !PAYWALL_TXT.test(t)) continue;
        if (CLOSEST(el, 'header,nav,footer,[role=banner],[role=navigation],[role=contentinfo]') || !vis(el)) continue;
        let p = el;   // the outermost box that is still just the prompt
        while (p.parentElement && p.parentElement !== scope && (p.parentElement.textContent || '').replace(/\s+/g, ' ').trim().length <= 400) p = p.parentElement;
        let after = 0;
        for (const q of QSA(scope, 'p,li,blockquote,pre')) {
          if (!(p.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING) || CONTAINS(p, q) || !vis(q)) continue;
          if (CLOSEST(q, 'footer,nav,aside,[role=contentinfo],[role=navigation],[role=complementary]')) continue;
          after += (q.textContent || '').length;
          if (after > 600) break;
        }
        if (after > 600) continue;   // the page goes on: a promo in the middle of the text, not a wall
        w = { kind: 'paywall', how: 'inline', locked, covered: Math.round(frac * 100), text: clip(t, 200), cut: p, els: [p] };
        S.junk.set(p, 'paywall');
        break;
      }
    }
    if (w && w.kind === 'paywall' && w.cut) {
      // everything from the cut on, in document order, is past what the real page shows: the cut element, then each
      // following sibling of it and of its ancestors (the site's header and nav stay: they are above it on the page)
      const cut = new Set();
      for (let x = w.cut; x && x !== B && x !== H; x = x.parentElement) {
        for (let s = x === w.cut ? x : x.nextElementSibling; s; s = s.nextElementSibling) {
          if (MATCHES(s, 'header,nav,[role=banner],[role=navigation]') || S.chrome.has(s) || [...overlays].some((o) => CONTAINS(s, o) && !w.els.includes(o))) continue;
          cut.add(s);
        }
      }
      w.past = cut;
      for (const x of cut) S.junk.set(x, 'cut');   // past the wall: left out, never counted as hidden
    }
    if (w && w.kind === 'terms') S.challenge = 'terms';
    return w;
  }
  // the first content element whose top is at or below y (viewport coordinates), in document order
  function firstBelow(scope, y) {
    for (const el of QSA(scope, 'p,h1,h2,h3,h4,h5,h6,li,figure,img,picture,video,pre,table,blockquote,dl')) {
      const r = RECT(el);
      if (r.height > 0 && (r.top + r.bottom) / 2 >= y) return el;   // more than half under the wall
    }
    return null;
  }

  function debugScan() {
    DEBUG_SRC = true;
    const S = scanPage(lastHints);
    DEBUG_SRC = false;
    const d = (e) => { const r = RECT(e); return (LNOF(e) + (IDOF(e) ? '#' + IDOF(e) : '') + (typeof CLSOF(e) === 'string' && CLSOF(e).trim() ? '.' + CLSOF(e).trim().split(/\s+/).slice(0, 2).join('.') : '')).slice(0, 80) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' t=' + (e.innerText || '').length; };
    const outer = (m) => [...m.keys()].filter((e) => { for (let p = e.parentElement; p; p = p.parentElement) if (m.has(p)) return false; return true; });
    return { junk: outer(S.junk).filter(vis).map((e) => S.junk.get(e) + ' ' + d(e) + (S.why.get(e) ? ' <' + S.why.get(e) + '>' : '')).slice(0, 120), chrome: outer(S.chrome).map((e) => S.chrome.get(e) + ' ' + d(e)),
      cards: [...S.cards.entries()].map(([p, it]) => it.length + ' ' + d(p)), islands: S.islands.map((c) => (c.main ? 'MAIN ' : '') + c.src + ' ' + d(c.box)),
      h1: S.h1 && d(S.h1), root: S.root && d(S.root), consent: S.consent.map((c) => IDOF(c) + ' ' + JSON.stringify(c.reject)), stats: S.stats };
  }

  function prepare(r) {
    const el = lookup(r);
    if (!el) return null;
    const a = el.closest && CLOSEST(el, 'a[target],form[target]');
    if (a && a.target && a.target !== '_self') a.target = '_self';
    return el;
  }

  // ---------------------------------------------------------------- fast, hit-tested actions ("zero wrong-target")
  let guard = null;
  const pathTarget = (e) => (e.composedPath ? e.composedPath()[0] : e.target);
  const owns = (el, t) => !!t && (t === el || CONTAINS(el, t) || (t.closest && (() => { const lab = CLOSEST(t, 'label'); return !!lab && lab.control === el; })()));
  function guardHandler(e) {
    if (!guard) return;
    if (e.type === 'pointerdown' || e.type === 'mousedown') {
      if (!owns(guard.el, pathTarget(e))) guard.tripped = String(pathTarget(e) && pathTarget(e).localName);
    }
    if (guard.tripped) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (e.type === 'click') guard.done = true;
  }
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(t, guardHandler, true);
  function deepHit(x, y) {
    let t = document.elementFromPoint(x, y);
    while (t && t.shadowRoot) { const u = t.shadowRoot.elementFromPoint(x, y); if (!u || u === t) break; t = u; }
    return t;
  }
  function hit(r) {
    userActed = true;
    const el = prepare(r);
    if (!el) return { err: 'stale' };
    let rects = el.getClientRects();
    if (!rects.length) return { err: 'no box' };
    let rc = rects[0];
    const vw = innerWidth, vh = innerHeight;
    let scrolled = false;
    if (rc.top < 0 || rc.bottom > vh || rc.left < 0 || rc.right > vw) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      rects = el.getClientRects(); rc = rects[0]; scrolled = true;
      if (!rc) return { err: 'no box' };
    }
    const x = Math.min(Math.max(rc.left + Math.min(rc.width / 2, 40), 1), vw - 1);
    const y = Math.min(Math.max(rc.top + rc.height / 2, 1), vh - 1);
    const t = deepHit(x, y);
    const ok = owns(el, t);
    if (ok) guard = { el, tripped: null, done: false };
    return { x, y, ok, scrolled, hit: t ? LNOF(t) + (IDOF(t) ? '#' + IDOF(t) : '') : null };
  }
  function guardResult() { const g = guard; guard = null; return g ? { tripped: g.tripped, done: g.done } : null; }
  function focusSelect(r, selectAll) {
    const el = prepare(r);
    if (!el) return 'stale';
    if (LNOF(el) === 'input' && /^(date|time|datetime-local|month|week|color|range|file)$/.test(el.type)) return 'special';
    if (document.activeElement !== el) el.focus();
    if (selectAll) {
      if (el.isContentEditable) { const s = getSelection(); const rg = document.createRange(); rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg); }
      else if (typeof el.select === 'function') el.select();
    }
    return document.activeElement === el || CONTAINS(el, document.activeElement) ? 'ok' : 'nofocus';
  }

  Object.defineProperty(window, '__mdoc', {
    value: Object.freeze({ extractText, lookup, prepare, quiet, hit, guardResult, focusSelect, epoch: EPOCH, setMode: (m) => { forcedMode = m || null; },
      setRules, hasRules: () => !!RULES, islands, clearOver, restoreHidden, debugScan, adoptPopup, fateOf, harvest, rescan: () => { SCAN_KEY = {}; } }),
    enumerable: false, configurable: false, writable: false,
  });
})();
