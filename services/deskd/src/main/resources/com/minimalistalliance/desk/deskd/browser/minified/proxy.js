// deskd's half of the simplified view inside the page (task 47; services/deskd/docs/API.md section 14, ADR 0046).
//
// deskd injects this into its own isolated world, "ma-minify", in every frame of a tab it simplifies, OOPIFs included,
// with Page.addScriptToEvaluateOnNewDocument, so it runs before any of the page's scripts. In the top frame it follows
// the distiller (distiller.js), which it calls but never trusts. The page's scripts share the DOM with it and nothing
// else: they can't see, call, redefine or disarm anything here. deskd reaches it only through one fixed function,
// globalThis.__maProxy.run({op, ...}), with JSON values as the argument, and no client text ever becomes script.
//
// What it does that the distiller doesn't:
//  - The guard (Security T47-3). While deskd sends a click or keys, every frame cancels trusted input that isn't on the
//    one element deskd armed in the top frame, and that element says whether it got the press, the release and the
//    click. Typing trips the guard if the element loses focus.
//  - What the member saw (T47-2). A fingerprint of a control's role, type, name, visible text, link and row, taken with
//    each snapshot and taken again in the same call as the hit-test, so a reused row or node refuses rather than act on
//    something else. Nothing is ever found again by guessing.
//  - Sensitive fields (T47-1, T47-7). Password, one-time code, card and masked fields, and payment providers' frames:
//    deskd never sends these to the office as fields, and never types into them.
//  - Islands (T47-4's desk part). Video, audio, canvas and frames, with their boxes clamped to the viewport.
//  - The Agent's clicks and keys (S-14). The Agent's tabs are hidden targets, which trusted input never reaches on a
//    desk's Chromium, so deskd's ActionProxy for the Agent alone acts here instead: an untrusted el.click() or
//    KeyboardEvent from this world on the one element deskd names (agentClick, agentPress, agentClear).
// It writes nothing to the page's DOM, except a select's own selection when the member picks an option, and, for the
// Agent, a field's value on Backspace or when it empties one. It fetches nothing.
// Once per document it may scroll the page and put it back (the pre-scroll, below): never a press or a key.
(() => {
  'use strict';
  if (globalThis.__maProxy) return;
  const TOP = window.top === window;
  // A frame whose document isn't a web page's (a password manager's in-page menu is chrome-extension:, and so is any
  // about: or blob: document of its origin) gets nothing of deskd's: no guard, no listener, no reading. This half
  // answers every op there with a refusal, so deskd can't arm, walk or read it even if its world gets in by a race;
  // deskd's own side keeps out of such a frame too (MinifiedModule.onAttached, PageWorld.runIn). An opaque origin keeps
  // today's handling, as a sandboxed web frame has one.
  if (!TOP) {
    const origin = String(globalThis.origin || '');
    const scheme = String(location.protocol || '');
    const known = /^(https?|about|data|blob):$/.test(scheme);
    if (!known || !(/^https?:\/\/[^/]/.test(origin) || origin === 'null')) {
      const refuse = Object.freeze({ run: () => ({ error: 'foreign' }), element: () => null });
      Object.defineProperty(globalThis, '__maProxy', { value: refuse, enumerable: false, configurable: false, writable: false });
      return;
    }
  }
  const now = () => performance.now();

  // ------------------------------------------------------------------------------------------------ text and hashing
  const clip = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) : s;
  };
  // cyrb53, as the distiller uses: an integrity check against a page changing under the member, not against collisions
  // a page crafts, which would have to look the same to the member anyway.
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

  // ------------------------------------------------------------------------------------------------ the DOM, deeply
  function pathTarget(e) {
    const p = e.composedPath ? e.composedPath() : null;
    return p && p.length ? p[0] : e.target;
  }
  /** t is el, inside it (across shadow roots too), or in a label for it. */
  function owns(el, t) {
    if (!el || !t) return false;
    for (let n = t; n; n = n.parentNode || n.host) {
      if (n === el) return true;
    }
    const start = t.nodeType === 1 ? t : t.parentElement;
    const label = start && start.closest ? start.closest('label') : null;
    return !!label && label.control === el;
  }
  function deepHit(x, y) {
    let t = document.elementFromPoint(x, y);
    while (t && t.shadowRoot) {
      const u = t.shadowRoot.elementFromPoint(x, y);
      if (!u || u === t) break;
      t = u;
    }
    return t;
  }
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  /** Every element in the document and in its open shadow roots, until fn returns true or the cap is reached. */
  function forEachDeep(fn, cap) {
    let seen = 0;
    const roots = [document];
    while (roots.length) {
      const all = roots.shift().querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (++seen > cap) return;
        const el = all[i];
        if (fn(el)) return;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inView(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // ------------------------------------------------------------------------------------------------ fields
  const TEXT_INPUTS = /^(text|search|email|tel|url|number|date|time|datetime-local|month|week|password)$/;
  function isField(el) {
    const ln = el.localName;
    if (ln === 'textarea' || ln === 'select') return true;
    if (ln === 'input') return !/^(hidden|submit|button|reset|image|checkbox|radio|file|color|range)$/.test((el.type || '').toLowerCase());
    if (el.isContentEditable) return true;
    return /^(textbox|searchbox|combobox)$/.test(el.getAttribute('role') || '');
  }
  function isTextEntry(el) {
    const ln = el.localName;
    if (ln === 'textarea') return true;
    if (ln === 'input') return TEXT_INPUTS.test((el.type || 'text').toLowerCase());
    return el.isContentEditable || /^(textbox|searchbox|combobox)$/.test(el.getAttribute('role') || '');
  }
  function isChecky(el) {
    if (el.localName === 'input') return /^(checkbox|radio)$/.test((el.type || '').toLowerCase());
    return /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(el.getAttribute('role') || '');
  }
  function checkedOf(el) {
    if (el.localName === 'input') return !!el.checked;
    return el.getAttribute('aria-checked') === 'true';
  }
  function isDisabled(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
    // A field in a disabled fieldset is disabled too, with its own disabled false.
    try { return el.matches(':disabled'); } catch (e) { return false; }
  }
  // Security (Nov 11): a box the page made read-only takes no keys from here, as a person's would put nothing in it:
  // readonly, aria-readonly="true", or, for anything but a form field, rich text whose nearest contenteditable says false
  // (a mention or an embed inside an editor). A form field inside such rich text is still a person's to type in.
  function readOnly(el) {
    const ln = el.localName;
    if ((ln === 'input' || ln === 'textarea') && el.readOnly) return true;
    if (el.getAttribute('aria-readonly') === 'true') return true;
    if (ln === 'input' || ln === 'textarea' || ln === 'select') return false;
    const host = el.closest ? el.closest('[contenteditable]') : null;
    return !!host && String(host.getAttribute('contenteditable')).trim().toLowerCase() === 'false';
  }
  function valueOf(el) {
    if (el.localName === 'input' || el.localName === 'textarea') return el.value || '';
    return el.innerText || el.textContent || '';
  }
  // Security T47-1: what makes a field sensitive. Signals only ever add: deskd keeps a field it once saw as sensitive so.
  const PW_AUTO = /(^|\s)(current-password|new-password|webauthn)(\s|$)/;
  const OTP_AUTO = /(^|\s)one-time-code(\s|$)/;
  const CC_AUTO = /(^|\s)cc-[a-z-]+(\s|$)/;
  const CARD_NAME = /^(cc[-_]?(num(ber)?|csc|cvv|cvc|exp(iry)?([-_]?(month|year|date|mm|yy|yyyy))?|type|name)|card[-_]?(num(ber)?|cvc|cvv|code|exp(iry)?([-_]?(month|year|date))?|holder|type)|cardnumber|cvv2?|cvc2?|csc|security[-_]?code|exp(iry|iration)?[-_]?(month|year|date))$/i;
  const OTP_NAME = /^(otp|totp|one[-_]?time[-_]?(code|password)|(2fa|mfa|sms)[-_]?code|verification[-_]?code|passcode)$/i;
  function sensitiveKind(el) {
    if (!el || el.nodeType !== 1 || !isField(el)) return null;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (el.localName === 'select') {
      // A select holds no secret typed in, but a card's expiry or type is still the card's (T47-1).
      if (CC_AUTO.test(ac)) return 'card';
      for (const v of [el.getAttribute('name'), el.id]) if (v && CARD_NAME.test(v)) return 'card';
      return null;
    }
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'password') return 'password';
    if (PW_AUTO.test(ac)) return 'password';
    if (OTP_AUTO.test(ac)) return 'one_time_code';
    if (CC_AUTO.test(ac)) return 'card';
    try {
      const s = getComputedStyle(el);
      const masked = s.webkitTextSecurity || s.getPropertyValue('-webkit-text-security');
      if (masked && masked !== 'none') return 'masked';
    } catch (e) { /* a detached element has no style */ }
    for (const v of [el.getAttribute('name'), el.id]) {
      if (!v) continue;
      if (CARD_NAME.test(v)) return 'card';
      if (OTP_NAME.test(v)) return 'one_time_code';
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ what the member saw
  const ROW = 'li,tr,article,[role=row],[role=listitem],[role=option],[role=treeitem],[role=article],[role=gridcell]';
  function labelsOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' ');
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) return Array.from(el.labels, (l) => l.textContent).join(' ');
    return '';
  }
  function visibleText(el) {
    return el.innerText !== undefined ? el.innerText : el.textContent || '';
  }
  /**
   * The item a control belongs to: a list item, a table row or an article, or, for lists built of divs, the nearest
   * ancestor repeated beside siblings of its own tag and class (T47-2: what the member saw includes which item).
   */
  function rowOf(el) {
    const row = el.closest ? el.closest(ROW) : null;
    if (row) return row;
    let n = el.parentElement;
    for (let i = 0; n && i < 8 && n !== document.body; i++, n = n.parentElement) {
      const p = n.parentElement;
      if (!p || p.childElementCount < 3) continue;
      let alike = 0;
      for (const sib of p.children) {
        if (sib !== n && sib.localName === n.localName && sib.className === n.className && ++alike >= 2) return n;
      }
    }
    return null;
  }
  /** The row's text without el's own, so a field's value or a control's own label changing doesn't move it. */
  function rowText(row, el) {
    let out = '';
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 400; n = walker.nextNode()) {
      if (el.contains(n)) continue;
      out += n.data + ' ';
    }
    return clip(out, 300);
  }
  /** The fingerprint of what the member saw of a control. Leaves out values, checked and selected, which acting changes. */
  function see(el) {
    const role = (el.getAttribute('role') || el.localName || '').slice(0, 40);
    const type = el.localName === 'input' ? (el.type || '') : '';
    const name = clip(el.getAttribute('aria-label') || labelsOf(el) || el.getAttribute('title') ||
      el.getAttribute('placeholder') || el.getAttribute('alt') || '', 160);
    const text = isField(el) ? '' : clip(visibleText(el), 160);
    const link = el.closest ? el.closest('a[href]') : null;
    const href = link ? String(link.href).slice(0, 300) : '';
    const row = rowOf(el);
    const rt = row && row !== el ? rowText(row, el) : '';
    return hash([role, type, name, text, href, rt].join('\u0001'));
  }

  // ------------------------------------------------------------------------------------------------ the guard
  // armed: null, or {id, until, el, seen, tripped, typing, rect, data}. el null means nothing in this frame may get input.
  let armed = null;
  const GUARDED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
    'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'drop', 'dragstart', 'touchstart', 'touchend'];
  const POINTER = new Set(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  // T47D-1: a frame document starts armed, for its first 3 seconds, so one born after deskd's last look at the frames
  // (a new frame, or one that navigated) cancels trusted input as an armed one does, whichever process it's in.
  const BORN_UNTIL = TOP ? 0 : now() + 3000;
  function onGuarded(e) {
    if (!TOP && e.isTrusted && now() < BORN_UNTIL) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const g = armed;
    if (!g || !e.isTrusted) return;
    if (now() > g.until) { armed = null; return; }
    if (g.el && !g.tripped && owns(g.el, pathTarget(e))) {
      // Through the click itself: still what the member saw (T47-2), as a page can rebind a node as it's pressed, and
      // still not a field that must never be typed into (T47-1). A click is cancelled here, before the page hears of it.
      if (!g.typing && POINTER.has(e.type) && see(g.el) !== g.fp) g.tripped = 'changed';
      else if (g.typing && (e.type === 'keydown' || e.type === 'beforeinput') && sensitiveKind(g.el)) g.tripped = 'sensitive';
      if (g.tripped) {
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      g.seen[e.type] = (g.seen[e.type] || 0) + 1;
      if (e.type === 'beforeinput' && typeof e.data === 'string' && g.data.length < 70000) g.data += e.data;
      return;
    }
    if (!g.tripped) g.tripped = e.type;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }
  for (const type of GUARDED) addEventListener(type, onGuarded, { capture: true });
  addEventListener('focusout', (e) => {
    const g = armed;
    if (g && g.typing && g.el && !g.tripped && owns(g.el, pathTarget(e)) && now() <= g.until) g.tripped = 'blur';
  }, { capture: true });

  function arm(a) {
    armed = { id: String(a.id), until: now() + clamp(+a.ms || 0, 0, 60000), el: null, seen: {}, tripped: null, data: '' };
    return { ok: true };
  }
  function disarm(a) {
    const g = armed;
    if (!g || g.id !== String(a.id)) return { lost: true };
    armed = null;
    return { tripped: g.tripped };
  }

  // ------------------------------------------------------------------------------------------------ top frame only
  let M = null;
  // A site's own security and account notices, which deskd keeps whatever the distiller does with them (T47X-2): their
  // buttons get deskd's own refs, looked up here like the distiller's.
  const NOTICE_EPOCH = Math.floor(Math.random() * 60466176).toString(36);
  const noticeEls = new Map(), noticeRefOf = new WeakMap();
  let noticeNext = 1;
  function noticeRef(el) {
    let r = noticeRefOf.get(el);
    if (!r) { r = 'w' + NOTICE_EPOCH + '.' + (noticeNext++).toString(36); noticeRefOf.set(el, r); noticeEls.set(r, new WeakRef(el)); }
    return r;
  }
  const lookup = (ref) => {
    if (typeof ref === 'string' && noticeEls.has(ref)) {
      const el = noticeEls.get(ref).deref();
      return el && el.isConnected ? el : null;
    }
    M = globalThis.__mdoc || M;
    if (!M || typeof M.lookup !== 'function' || typeof ref !== 'string') return null;
    try {
      const el = M.lookup(ref);
      return el && el.nodeType === 1 && el.isConnected ? el : null;
    } catch (e) {
      return null;
    }
  };

  // Changes, for deskd's long poll: a count, and waiters resolved on the next change.
  let changes = 0;
  const waiters = new Set();
  function bump(n) {
    changes += n;
    for (const w of Array.from(waiters)) w(false);
  }
  if (TOP) {
    new MutationObserver((records) => bump(records.length)).observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
    // A value typed or a box ticked in the full view changes no DOM.
    for (const t of ['input', 'change', 'toggle']) addEventListener(t, () => bump(1), { capture: true });
    addEventListener('pagehide', () => { for (const w of Array.from(waiters)) w(true); });
  }
  /** Resolves on the first change past since, or after ms. At most four wait: a fifth ends the oldest. */
  function changed(a) {
    const since = +a.since || 0;
    if (changes > since) return { count: changes };
    return new Promise((resolve) => {
      let timer = 0;
      const done = (gone) => {
        if (!waiters.has(done)) return;
        waiters.delete(done);
        clearTimeout(timer);
        resolve({ count: changes, timeout: changes <= since, gone: !!gone });
      };
      if (waiters.size >= 4) waiters.values().next().value(false);
      waiters.add(done);
      timer = setTimeout(() => done(false), clamp(+a.ms || 0, 0, 60000));
    });
  }

  /** Ends every wait now, as if it had timed out: deskd has a reason of its own to look again (review 7). */
  function wake() {
    for (const w of Array.from(waiters)) w(false);
    return { ok: true };
  }

  // Islands: deskd's own ids for video, audio, canvas and frames.
  const EPOCH = Math.floor(Math.random() * 60466176).toString(36);
  let nextIsland = 1;
  const islandOf = new WeakMap();
  const islandEl = new Map();
  function islandId(el) {
    let id = islandOf.get(el);
    if (!id) {
      id = 'v' + EPOCH + '.' + (nextIsland++).toString(36);
      islandOf.set(el, id);
      islandEl.set(id, new WeakRef(el));
      if (islandEl.size > 2000) for (const [k, w] of islandEl) if (!w.deref()) islandEl.delete(k);
    }
    return id;
  }
  function islandLookup(id) {
    const w = typeof id === 'string' ? islandEl.get(id) : null;
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  }
  function hostOf(url) {
    try {
      const u = new URL(url, document.baseURI);
      return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }
  function originOf(url) {
    try {
      const u = new URL(url, document.baseURI);
      return /^https?:$/.test(u.protocol) ? u.origin : '';
    } catch (e) {
      return '';
    }
  }
  function onList(host, list) {
    if (!host || !Array.isArray(list)) return false;
    for (const d of list) if (host === d || host.endsWith('.' + d)) return true;
    return false;
  }
  /** A frame the size of a standard ad slot (IAB sizes, give or take 4 px) is an ad far more often than content. */
  const AD_SIZES = [[300, 250], [728, 90], [160, 600], [300, 600], [320, 50], [320, 100], [970, 250], [970, 90], [336, 280],
    [468, 60], [300, 50], [120, 600], [250, 250]];
  function adSized(r) {
    return AD_SIZES.some(([w, h]) => Math.abs(r.width - w) <= 4 && Math.abs(r.height - h) <= 4);
  }
  function overlaid(el) {
    for (let p = el, depth = 0; p && p !== document.body && depth < 12; p = p.parentElement, depth++) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }
  function srcOf(el) {
    if (el.localName === 'object') return el.data || '';
    return el.src || el.getAttribute('src') || '';
  }
  const MEDIA = new Set(['video', 'audio', 'canvas', 'iframe', 'embed', 'object']);
  const FOREIGN_SRC = /^\s*(chrome|chrome-extension|chrome-untrusted|devtools|extension|moz-extension|edge):/i;

  /**
   * A player that draws its poster itself, over a video with none of its own (a picture, or a box's background, in the
   * player and over most of the video): its address, for the island's still before it streams. Read only.
   */
  function drawnPoster(v) {
    const vr = v.getBoundingClientRect();
    if (vr.width < 100 || vr.height < 60) return null;
    const over = (r) => (Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left)) * Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top))) / (vr.width * vr.height);
    let box = v.parentElement;
    for (let d = 0; box && box.parentElement && d < 3; d++) {
      const r = box.parentElement.getBoundingClientRect();
      if (r.width > vr.width + 80 || r.height > vr.height + 120) break;
      box = box.parentElement;
    }
    if (!box) return null;
    const els = box.querySelectorAll('img,[class*=poster i],[class*=preview i],[class*=thumb i]');
    for (let i = 0; i < els.length && i < 24; i++) {
      const x = els[i];
      if (over(x.getBoundingClientRect()) < 0.6) continue;
      if (x.localName === 'img') { if (x.currentSrc && /^https?:/.test(x.currentSrc)) return x.currentSrc; continue; }
      const m = /url\(["']?(https?:[^"')]+)/.exec(getComputedStyle(x).backgroundImage || '');
      if (m) return m[1];
    }
    return null;
  }
  /** A media element's state, for the island's own controls (spec section 9: media). */
  function mediaFacts(el) {
    const f = { paused: !!el.paused };
    if (isFinite(el.duration)) f.dur = Math.round(el.duration * 10) / 10;
    if (isFinite(el.currentTime)) f.at = Math.round(el.currentTime * 10) / 10;
    if (el.poster) f.poster = String(el.poster).slice(0, 2048);
    else if (el.localName === 'video') { const still = drawnPoster(el); if (still) f.poster = still.slice(0, 2048); }
    if (el.mediaKeys) f.drm = 1;
    if (el.muted) f.muted = 1;
    f.vol = Math.round(el.volume * 100) / 100;
    // Buffered ahead: the end of the buffered range the playhead is in.
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= el.currentTime + 0.5 && el.buffered.end(i) >= el.currentTime) { f.buf = Math.round(el.buffered.end(i) * 10) / 10; break; }
    }
    const tracks = [];
    for (let i = 0; i < el.textTracks.length && tracks.length < 16; i++) {
      const t = el.textTracks[i];
      tracks.push({ kind: t.kind, label: clip(t.label, 60), lang: clip(t.language, 16), on: t.mode === 'showing' ? 1 : 0 });
      if (t.mode === 'showing' && (t.kind === 'captions' || t.kind === 'subtitles')) f.cc = 1;
    }
    if (tracks.length) f.tracks = tracks;
    return f;
  }
  /** What an island shows, so an action on a reused player refuses (T47-2, as for any node). */
  function islandFp(el) {
    let src = srcOf(el) || el.currentSrc || '';
    try { const u = new URL(src, document.baseURI); src = u.origin + u.pathname; } catch (e) { src = ''; }
    return hash([el.localName, src.slice(0, 300), clip(el.getAttribute('title') || el.getAttribute('aria-label') || '', 80)].join('\u0001'));
  }

  /** The site's name and icon, the page's JSON-LD and its article's facts: what the head shows (spec section 9). */
  function extras() {
    const meta = (sel) => { const e = document.querySelector(sel); return e ? clip(e.getAttribute('content'), 200) : ''; };
    const out = {};
    let name = meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]') || meta('meta[name="apple-mobile-web-app-title"]');
    if (!name) {
      const parts = String(document.title || '').split(/\s[|\u2013\u2014-]\s/);
      if (parts.length > 1) name = clip(parts[parts.length - 1], 80);
    }
    if (name) out.name = name;
    const theme = meta('meta[name="theme-color"]');
    if (theme) out.theme = theme;
    const icon = document.querySelector('link[rel~="icon" i][href],link[rel="apple-touch-icon" i][href]');
    if (icon) { try { out.icon = new URL(icon.getAttribute('href'), document.baseURI).href.slice(0, 2048); } catch (e) { /* none */ } }
    const ld = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json" i]');
    for (let i = 0; i < scripts.length && i < 20 && ld.length < 8; i++) {
      const text = scripts[i].textContent || '';
      if (text.length > 400000) continue;
      let v;
      try { v = JSON.parse(text); } catch (e) { continue; }
      const stack = [v];
      while (stack.length && ld.length < 8) {
        const o = stack.pop();
        if (Array.isArray(o)) { for (const x of o.slice(0, 50)) stack.push(x); continue; }
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o['@graph'])) for (const x of o['@graph'].slice(0, 50)) stack.push(x);
        const type = [].concat(o['@type'] || []).map(String);
        if (type.some((t) => /^(Recipe|Product|QAPage|VideoObject|NewsArticle|Article|BlogPosting|ReportageNewsArticle)$/.test(t))) ld.push(o);
      }
    }
    if (ld.length) out.ld = ld;
    const article = {};
    const published = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]');
    if (published) article.date = published;
    const section = meta('meta[property="article:section"]');
    if (section) article.kicker = section;
    const author = meta('meta[name="author"]') || meta('meta[property="article:author"]');
    if (author && !/^https?:/i.test(author)) article.byline = [author];
    if (Object.keys(article).length) out.article = article;
    return out;
  }

  /**
   * The policy (the Product Designer's round two, the owner's default): the view never shows more than the real page
   * shows this member. A wall is an overlay the member can't read past: one over most of the screen, or over a page
   * that won't scroll. Its words say which: a site's terms to agree to (the page falls back), or a subscription (the
   * view ends where the wall starts). Text the member can't see is keyed as deskd's builder keys a block: `covered`,
   * under the wall and past it; `hidden`, not drawn at all or clipped away by a box it's in. The builder drops a hidden
   * block, and ends the view at the first covered one, whatever the distiller sends.
   */
  const TERMS_WORDS = /\bterms\b|\bterms of (use|service)\b|\buser agreement\b/i;
  const AGREE_WORDS = /^\s*(i\s+)?(agree|accept|continue|ok|got it)\b/i;
  // A way to close it: then it's a nag the member can dismiss on the real page, which the distiller hides as a pop-up,
  // never a wall (the distiller's own DISMISS_BTN, and API.md section 14).
  const DISMISS_WORDS = /^\s*(close( (dialog|modal|this|window|pop-?up|banner|message))?|dismiss.{0,30}|collapse.{0,30}|minimi[sz]e.{0,30}|×|✕|✖|x|no,? thanks.{0,30}|not now|maybe later|skip.{0,20}|continue (reading|to (the )?(site|article|story))( for free)?|i['’]ll do it later|remind me later)\s*$/i;
  const PAY_WORDS = /\bsubscri(be|ber|bers|ption)\b|\bsign in to (continue|read|keep reading)\b|\blog ?in to (continue|read)\b|\bcreate a free account\b|\bregister to (continue|read)\b/i;
  const TEXT_TAGS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption,td,th';
  /** As deskd's builder keys a block: letters and digits, lower case, the first 48. */
  const textKey = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 48);
  function wallOf(vw, vh) {
    const locked = ['overflow', 'overflowY'].some((k) => /hidden|clip/.test(getComputedStyle(document.documentElement)[k] + ' ' + (document.body ? getComputedStyle(document.body)[k] : '')));
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.5, 0.75]]) {
      let el = deepHit(vw * fx, vh * fy);
      for (let depth = 0; el && el !== document.body && el !== document.documentElement && depth < 30; depth++) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky' || (cs.position === 'absolute' && parseInt(cs.zIndex, 10) >= 10)) {
          const r = el.getBoundingClientRect();
          const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
          if (cover >= 0.8 || (locked && cover >= 0.3)) {
            const words = (el.innerText || '').slice(0, 4000);
            // A wall is a box of a few words over the page, never the page's own content in a fixed shell.
            if (words.length > 1500 || el.querySelector('main,article,[role=main],h1')) break;
            const controls = Array.from(el.querySelectorAll('button,[role=button],a,input[type=submit]'));
            if (controls.some((b) => DISMISS_WORDS.test(b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || ''))) break;
            const agree = controls.some((b) => AGREE_WORDS.test(b.innerText || b.value || ''));
            const kind = TERMS_WORDS.test(words) && agree && !/\bcookies?\b/i.test(words.replace(TERMS_WORDS, '')) ? 'terms'
              : PAY_WORDS.test(words) ? 'paywall' : null;
            if (kind) return { kind, el, top: Math.max(0, r.top) + scrollY };
          }
          break;
        }
        el = el.parentElement || (el.getRootNode() && el.getRootNode().host) || null;
      }
    }
    return null;
  }
  function clippedAway(el, r) {
    for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 8; p = p.parentElement, depth++) {
      const o = getComputedStyle(p).overflowY;
      if (o === 'hidden' || o === 'clip') {
        const pr = p.getBoundingClientRect();
        if (r.top >= pr.bottom - 1 || r.bottom <= pr.top + 1) return true;
      }
    }
    return false;
  }
  function wallFacts(vw, vh) {
    const wall = wallOf(vw, vh);
    const covered = [], hidden = [], shown = [];
    const els = document.querySelectorAll(TEXT_TAGS);
    for (let i = 0; i < els.length && i < 4000 && covered.length + hidden.length < 2000; i++) {
      const el = els[i];
      if ((el.textContent || '').length < 24 || (wall && wall.el.contains(el))) continue;
      // Not drawn, or clipped away by a box it's in. A faded-out paragraph (opacity) is one the page shows on scroll.
      const r = el.getBoundingClientRect();
      const isHidden = !el.getClientRects().length || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))
        || clippedAway(el, r);
      const isCovered = !isHidden && !!wall && r.top + scrollY >= wall.top;
      if (!isHidden && !isCovered) {
        shown.push(el);
        continue;
      }
      const key = textKey(isHidden ? el.textContent : el.innerText);
      if (key.length >= 24) (isHidden ? hidden : covered).push(key);
    }
    if (hidden.length) {
      // Text the page also shows isn't hidden: a site's hidden copy of its own title (The Verge's second h1) would
      // otherwise take the shown one out of the view.
      const seen = new Set();
      for (const el of shown) seen.add(textKey(el.textContent));
      for (let i = hidden.length - 1; i >= 0; i--) if (seen.has(hidden[i])) hidden.splice(i, 1);
    }
    if (!wall && !hidden.length) return null;
    const out = { hidden };
    if (wall) { out.kind = wall.kind; out.covered = covered; }
    return out;
  }

  const NOTICE_WORDS = /\b(security|sign-?in activity|unusual|suspicious|session|expir(e|es|ed|ing|y)|verif(y|ied|ication)|payment (failed|declined)|failed payment|(card|payment) (was )?declined|update your payment|access your account|wants (to )?access|permission|approv(e|al))\b/i;
  const NOTICE_SEL = '[role=alert],[role=alertdialog],[role=dialog],dialog[open],[aria-modal=true],[class*=banner i],[class*=notice i],'
    + '[class*=alert i],[class*=toast i],[id*=banner i],[id*=notice i],[id*=alert i]';
  /**
   * The site's own alerts, and bars or dialogs naming security, a session, an expiry, a verification or a failed payment,
   * or asking for access: at most 3, each as its text and up to 3 of its buttons (T47X-2). An alert is always kept.
   */
  /**
   * Where a site's notice may be: the selector's matches, and any fixed or sticky box near the top of the tree, which is
   * where a bar with no telling class or role sits (the distiller's notice-bar page).
   */
  function noticeCandidates() {
    const found = new Set(document.querySelectorAll(NOTICE_SEL));
    let looked = 0;
    const walk = (el, depth) => {
      for (const c of el.children) {
        if (++looked > 600) return;
        const pos = getComputedStyle(c).position;
        if (pos === 'fixed' || pos === 'sticky') found.add(c);
        else if (depth < 3) walk(c, depth + 1);
      }
    };
    if (document.body) walk(document.body, 1);
    return found;
  }
  function notices() {
    const out = [], kept = [];
    for (const el of noticeCandidates()) {
      if (out.length >= 3) break;
      if (kept.some((k) => k.contains(el)) || !visible(el)) continue;
      if ((el.textContent || '').length > 3000) continue;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 600) continue;
      if (role !== 'alert' && role !== 'alertdialog') {
        if (!NOTICE_WORDS.test(text)) continue;
        const dialog = role === 'dialog' || el.localName === 'dialog' || el.getAttribute('aria-modal') === 'true';
        const pos = getComputedStyle(el).position;
        if (!dialog && pos !== 'fixed' && pos !== 'sticky') continue;
        if (/\bcookies?\b/i.test(text)) continue;
      }
      kept.push(el);
      const buttons = [];
      for (const b of el.querySelectorAll('button,[role=button],a[href]')) {
        if (buttons.length >= 3) break;
        const label = clip(visibleText(b), 60);
        if (label && visible(b) && !sensitiveKind(b)) buttons.push([noticeRef(b), label]);
      }
      out.push({ text: clip(text, 300), buttons });
    }
    return out;
  }

  /**
   * deskd's own look for a person check, beside the distiller's, which a variant can slip past (Stack Overflow's on a
   * desk's network; Cloudflare's newer interstitial). Facts only: MDocBuilder weighs them against how little the view
   * holds, and matches the words. `cf`: Cloudflare's interstitial script, its options inline or its orchestrator, which
   * no other page carries. `form`: a check's own form or Cloudflare's challenge boxes. `widget`: a visible check widget,
   * in an open shadow root too (a closed one hides it, and the other facts stand in). `heads`: the visible headings.
   */
  const CHECK_FORM = '#challenge-form,#challenge-stage,#challenge-body-text,#challenge-error-text,#challenge-running,'
    + '#challenge-success-text,#cf-challenge-running,#cf-please-wait,#turnstile-wrapper,'
    + 'form[action*="captcha" i],form[action*="/cdn-cgi/challenge-platform/" i]';
  const CHECK_BOX = '.cf-turnstile,.h-captcha,.g-recaptcha,#px-captcha,#captcha-container,#captcha-box';
  const CHECK_SRC = /^https:\/\/(challenges\.cloudflare\.com\/|([\w-]+\.)*hcaptcha\.com\/|www\.(google|recaptcha)\.(com|net)\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|([\w-]+\.)*(arkoselabs|funcaptcha|captcha-delivery)\.com\/)|\/turnstile\/|\/captcha\//i;
  function challengeFacts() {
    const out = {};
    const scripts = document.scripts;
    for (let i = 0; i < scripts.length && i < 80; i++) {
      const s = scripts[i];
      if (s.src ? /\/cdn-cgi\/challenge-platform\/h\/[^/]+\/orchestrate\//.test(s.src) : /\b_cf_chl_opt\b/.test((s.textContent || '').slice(0, 4000))) {
        out.cf = 1;
        break;
      }
    }
    if (document.querySelector(CHECK_FORM)) out.form = 1;
    const heads = [];
    for (const h of document.querySelectorAll('h1,h2,h3,[role=heading]')) {
      if (heads.length >= 6) break;
      const t = visible(h) ? clip(visibleText(h), 120) : '';
      if (t) heads.push(t);
    }
    if (heads.length) out.heads = heads;
    forEachDeep((el) => {
      const ln = el.localName;
      // An invisible check (reCAPTCHA's badge, a check bound to a form's button) is the site's business, not a wall.
      if (ln === 'iframe' ? CHECK_SRC.test(srcOf(el)) && !/[?&]size=invisible/.test(srcOf(el)) && visible(el)
        : ln !== 'button' && ln !== 'input' && el.matches(CHECK_BOX) && !/invisible/i.test(el.getAttribute('data-size') || '')
          && !el.closest('.grecaptcha-badge') && visible(el)) {
        out.widget = 1;
        return true;
      }
      return false;
    }, 20000);
    return out;
  }

  /** What the page holds beyond the distiller's text: media and frames, sensitive signals, and counts for confidence. */
  function scanPage(a) {
    const vw = innerWidth, vh = innerHeight, area = Math.max(1, vw * vh);
    const media = [], signals = [], seenSignal = new Set();
    let formControls = 0, fields = 0, textFields = 0, canvasCover = 0, frameCover = 0, elements = 0;
    const signal = (kind, origin) => {
      const k = kind + ' ' + origin;
      if (!seenSignal.has(k) && signals.length < 20) { seenSignal.add(k); signals.push({ kind, origin }); }
    };
    const cover = (r) => {
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      return (w * h) / area;
    };
    forEachDeep((el) => {
      elements++;
      const ln = el.localName;
      if (ln === 'input' || ln === 'textarea' || ln === 'select' || ln === 'button' || el.isContentEditable) {
        if (fields++ > 3000 || (ln === 'input' && (el.type || '').toLowerCase() === 'hidden')) return false;
        if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) return false;
        if (!visible(el)) return false;
        formControls++;
        // What a member types or picks in, as against buttons and boxes: what a form needs the view to keep.
        if (ln === 'textarea' || ln === 'select' || el.isContentEditable
            || (ln === 'input' && /^(|text|search|email|tel|url|number|password|date|datetime-local|month|week|time)$/.test((el.getAttribute('type') || '').toLowerCase()))) textFields++;
        const sk = sensitiveKind(el);
        if (sk) signal(sk, location.origin);
        return false;
      }
      if (!MEDIA.has(ln) || media.length >= a.maxMedia) return false;
      // A browser's or an extension's own frame (a password manager's menu) is never media, an island or content.
      if ((ln === 'iframe' || ln === 'embed' || ln === 'object') && FOREIGN_SRC.test(srcOf(el))) return false;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 120 * 60 || !visible(el)) return false;
      const m = {
        island: islandId(el), m: ln === 'object' ? 'embed' : ln, w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
        n: clip(el.getAttribute('title') || el.getAttribute('aria-label') || '', 80),
      };
      if (ln === 'iframe' || ln === 'embed' || ln === 'object') {
        const src = srcOf(el), host = hostOf(src), origin = originOf(src);
        m.cross = origin && origin !== location.origin ? 1 : 0;
        if (onList(host, a.payHosts)) { m.pay = 1; m.origin = origin; signal('payment', origin); }
        else if (onList(host, a.videoHosts)) m.video = 1;
        // An ad's or a consent manager's frame is never content, nor another site's frame over the page.
        else if (onList(host, a.adHosts) || onList(host, a.consentHosts) || adSized(r)) m.ad = 1;
        // A frame in a box fixed over the page is a pop-up or a wall, not the page's content: the distiller and the
        // wall rules see to those.
        else if (overlaid(el)) m.overlay = 1;
        else if (m.cross) frameCover = Math.max(frameCover, cover(r));
      }
      if (ln === 'canvas') canvasCover = Math.max(canvasCover, cover(r));
      if (ln === 'video' || ln === 'audio') Object.assign(m, mediaFacts(el));
      m.fp = islandFp(el);
      media.push(m);
      return false;
    }, a.maxElements);
    let status = 0;
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      status = nav && nav.responseStatus ? nav.responseStatus : 0;
    } catch (e) { /* not there */ }
    return {
      media, signals,
      stats: {
        formControls, textFields, canvasCover, frameCover, elements, status, ready: document.readyState, wall: wallFacts(vw, vh),
        challenge: challengeFacts(),
        url: location.href, origin: location.origin, vw, vh, dpr: devicePixelRatio,
        pageHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      },
    };
  }

  const NODE_TAGS = new Set(['a', 'btn', 'in', 'sel', 'ta']);
  const FMT_TAGS = new Set(['b', 'i', 'code', 'sup', 'sub', 's']);
  function snapshot(a) {
    M = globalThis.__mdoc || M;
    if (!M || typeof M.extractText !== 'function' || typeof M.lookup !== 'function') return { error: 'no_distiller' };
    const t0 = now();
    let text;
    try {
      // The prototype's server sent the hosts its blocklist called ads; deskd sends the frames' hosts on its own short list.
      const adHosts = [];
      for (const f of document.getElementsByTagName('iframe')) {
        const h = hostOf(srcOf(f));
        if (h && onList(h, a.adHosts) && adHosts.length < 400 && !adHosts.includes(h)) adHosts.push(h);
      }
      text = M.extractText(a.limit, { adHosts });
    } catch (e) {
      return { error: 'distiller' };
    }
    const t1 = now();
    if (typeof text !== 'string') return { error: 'distiller' };
    if (text.length > a.maxChars) return { tooLarge: true, chars: text.length };
    // The refs the distiller used, from its own lines, each looked at once.
    const nodes = {};
    let count = 0;
    // Every field the output names is judged for sensitivity, past the node cap too (T47-1).
    const sens = {};
    let judged = 0;
    const note = (ref) => {
      if (typeof ref !== 'string' || nodes[ref]) return;
      const el = lookup(ref);
      if (!el) return;
      if (count >= a.maxNodes) {
        if (judged++ < 20000 && !(ref in sens)) sens[ref] = sensitiveKind(el) || '';
        return;
      }
      const n = { fp: see(el) };
      const sk = sensitiveKind(el);
      if (sk) n.s = sk;
      if (!isField(el)) n.t = clip(visibleText(el), 160);
      if (el.localName === 'select') { n.si = el.selectedIndex; if (el.multiple) n.m = 1; }
      if (isChecky(el)) n.c = checkedOf(el) ? 1 : 0;
      nodes[ref] = n;
      count++;
    };
    const collect = (runs, depth) => {
      if (!Array.isArray(runs) || depth > 16) return;
      for (const r of runs) {
        if (!Array.isArray(r)) continue;
        if (NODE_TAGS.has(r[0])) note(r[1]);
        if (r[0] === 'a') collect(r.slice(3), depth + 1);
        else if (FMT_TAGS.has(r[0])) collect(r.slice(1), depth + 1);
      }
    };
    const lines = text.split('\n');
    // Refs the distiller's own heading line names: a consent banner's reject button, the site's essential actions.
    try {
      const head = JSON.parse(lines[0]);
      if (head && Array.isArray(head.consent)) {
        for (const c of head.consent) {
          if (!c || !c.reject) continue;
          note(c.reject.ref);
          // deskd's own word on the banner, never the distiller's (Security's Ask 1, T47X-1).
          const n = nodes[c.reject.ref], el = lookup(c.reject.ref);
          if (n && el) n.cb = consentBox(el) && !offSite(el) ? 1 : 0;
        }
      }
      if (head && head.site && Array.isArray(head.site.acts)) for (const x of head.site.acts) if (Array.isArray(x)) note(x[1]);
    } catch (e) { /* no heading line */ }
    for (let i = 1; i < lines.length; i++) {
      const tab = lines[i].indexOf('\t');
      if (tab < 0) continue;
      let block;
      try { block = JSON.parse(lines[i].slice(tab + 1)); } catch (e) { continue; }
      if (!block || typeof block !== 'object') continue;
      collect(block.c, 0);
      collect(block.f, 0);
      if (Array.isArray(block.g)) for (const g of block.g) if (g) collect(g.c, 0);
      if (Array.isArray(block.items)) for (const it of block.items) if (it) { note(it.r); collect(it.x, 0); }
      if (block.k === 'img' && block.r) note(block.r);
      if (block.k === 'group' && Array.isArray(block.c)) for (const b of block.c) if (b) collect(b.c, 0);
      if (Array.isArray(block.rows)) for (const row of block.rows) if (Array.isArray(row)) for (const cell of row) if (cell) collect(cell.c, 0);
    }
    const t2 = now();
    const page = scanPage(a);
    const kept = notices();
    for (const n of kept) for (const [r] of n.buttons) note(r);
    if (kept.length) page.stats.notices = kept;
    // deskd's reader cuts any one string at 4096 characters, so the text goes in pieces, never splitting a pair.
    const chunks = [];
    for (let i = 0; i < text.length;) {
      let end = Math.min(text.length, i + 4000);
      if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      chunks.push(text.slice(i, end));
      i = end;
    }
    page.stats.msDistill = Math.round(t1 - t0);
    page.stats.msNodes = Math.round(t2 - t1);
    page.stats.msScan = Math.round(now() - t2);
    let more = {};
    try { more = extras(); } catch (e) { /* a page can break what it shows of itself, not this */ }
    const out = { chunks, nodes, sens, media: page.media, signals: page.signals, stats: page.stats, extras: more, count: changes };
    // deskd drops a message from Chromium past 2 MB, which would read as a page that never answered.
    if (JSON.stringify(out).length > a.maxReply) return { tooLarge: true, chars: text.length };
    return out;
  }

  function fits(el, action) {
    switch (action) {
      case 'click': return true;
      case 'check': return isChecky(el);
      case 'fill': return isTextEntry(el) && !readOnly(el);
      case 'press': return (isTextEntry(el) || el.localName === 'select') && !readOnly(el);
      default: return false;
    }
  }
  /** Any frame's box within margin of the point: a page can slide one under a click (T47-3). */
  function selectAll(el) {
    if (el.localName === 'input' || el.localName === 'textarea') {
      try { el.select(); } catch (e) { /* types without a selection */ }
      return;
    }
    const s = getSelection(), range = document.createRange();
    range.selectNodeContents(el);
    s.removeAllRanges();
    s.addRange(range);
  }
  /** Checks what the member saw, hit-tests, and arms the guard on the one element. Never clicks. */
  function prepare(a) {
    const el = lookup(a.node);
    if (!el) return { refused: 'gone' };
    if (see(el) !== a.fp) return { refused: 'changed' };
    const sk = sensitiveKind(el);
    if (sk) return { refused: 'sensitive', kind: sk };
    if (!fits(el, a.action)) return { refused: 'kind' };
    if (isDisabled(el)) return { refused: 'disabled' };
    if (!visible(el)) return { refused: 'hidden' };
    if (a.action === 'check' && typeof a.checked === 'boolean' && checkedOf(el) === a.checked) return { noop: true };
    let r = el.getBoundingClientRect();
    if (!inView(r)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
      if (!inView(r)) return { refused: 'hidden' };
      // A virtualized list can rebind the node as it scrolls: it has to be what the member saw after the scroll too.
      if (see(el) !== a.fp) return { refused: 'changed' };
    }
    const typing = a.action === 'fill' || a.action === 'press';
    const out = { ok: true };
    if (!typing) {
      const x = clamp(r.left + Math.min(r.width / 2, 40), Math.max(r.left, 1), Math.min(r.right, innerWidth - 1));
      const y = clamp(r.top + r.height / 2, Math.max(r.top, 1), Math.min(r.bottom, innerHeight - 1));
      if (!owns(el, deepHit(x, y))) return { refused: 'covered' };
      // A frame near the point is deskd's check, from Chromium's own boxes (T47D-2): closed shadow roots count there.
      out.x = x;
      out.y = y;
    } else {
      const act = deepActive();
      if (!owns(el, act)) el.focus({ preventScroll: true });
      if (a.action === 'fill') selectAll(el);
      if (!owns(el, deepActive())) return { refused: 'focus' };
      // A page can turn a field into a password one as it gets focus, or a read-only one.
      const flipped = sensitiveKind(el);
      if (flipped) return { refused: 'sensitive', kind: flipped };
      if (!fits(el, a.action)) return { refused: 'kind' };
      if (see(el) !== a.fp) return { refused: 'changed' };
    }
    armed = {
      id: String(a.id), until: now() + clamp(+a.ms || 0, 0, 60000), el, fp: a.fp, seen: {}, tripped: null, typing, data: '',
      rect: [r.left, r.top, r.width, r.height],
    };
    return out;
  }
  /** What the armed element got, and lets go. */
  function result(a) {
    const g = armed;
    if (!g || g.id !== String(a.id) || !g.el) return { lost: true };
    armed = null;
    const out = { seen: g.seen, tripped: g.tripped };
    if (g.typing) {
      // A hash and a length, never the text: deskd's reader cuts a string at 4096, and a fill may be 65,536 (review 3).
      const value = String(valueOf(g.el));
      out.valueLen = value.length;
      out.valueHash = hash(value);
      out.dataLen = g.data.length;
      out.dataHash = hash(g.data);
      out.focused = owns(g.el, deepActive());
    }
    if (isChecky(g.el)) out.checked = checkedOf(g.el);
    return out;
  }
  /** A select by index, and only if that option still reads as the member saw it (T47-2). */
  function select(a) {
    const el = lookup(a.node);
    if (!el) return { refused: 'gone' };
    if (see(el) !== a.fp) return { refused: 'changed' };
    if (el.localName !== 'select' || el.multiple) return { refused: 'kind' };
    if (isDisabled(el) || !visible(el)) return { refused: isDisabled(el) ? 'disabled' : 'hidden' };
    const opt = el.options[a.index | 0];
    if (!opt || opt.disabled) return { refused: 'label' };
    const label = clip(opt.text, 80);
    if (a.check) return { label };
    if (label !== a.label) return { refused: 'label' };
    if (el.selectedIndex !== (a.index | 0)) {
      el.selectedIndex = a.index | 0;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, selected: el.selectedIndex };
  }
  function scroll(a) {
    const el = lookup(a.node) || islandLookup(a.node);
    if (!el) return { refused: 'gone' };
    el.scrollIntoView({ block: a.block === 'center' ? 'center' : 'start', behavior: 'instant' });
    return { ok: true };
  }
  // ------------------------------------------------------------------------------------------------ the pre-scroll
  // Once per document, after the view has the page and before the member acts, deskd has the page brought in what it
  // loads only as it's scrolled to (lazy pictures, a thread's later replies, a list's next items): the page goes down in
  // steps of a screen to its end or a cap, then back exactly where it was. It scrolls and nothing else: no press, no key,
  // no focus, no DOM write. It never starts with focus in a field, on a page with a password, card or code field, on a
  // page whose scrolling is locked (a modal open), or in a hidden tab, which loads nothing as it scrolls. An infinite feed
  // stops at the cap. deskd's stop ends it at the next step, and the way back is here, not deskd's, so a lost reply never
  // leaves the page scrolled.
  let prescrolling = false;
  let prescrollStopped = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * A password, card or code field the member can see: the view's own sensitive signal (scanPage's), never a hidden one. In
   * the document and its open shadow roots, as scanPage looks (Security's S-111 Low 3): a field a site draws in a component
   * counts as one in the page. The first 3000 fields.
   */
  function sensitiveOnPage() {
    let fields = 0, found = false;
    forEachDeep((el) => {
      const ln = el.localName;
      if (ln !== 'input' && ln !== 'select') return false;
      if (++fields > 3000) return true;
      found = !!sensitiveKind(el) && visible(el);
      return found;
    }, 50000);
    return found;
  }
  function locked() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.overflowY === 'hidden' || s.overflowY === 'clip' || s.position === 'fixed') return true;
    }
    return false;
  }
  function prescroll(a) {
    if (prescrolling) return { skipped: 'running' };
    if (document.visibilityState === 'hidden') return { skipped: 'hidden' };
    if (document.readyState === 'loading') return { skipped: 'loading' };
    const act = deepActive();
    if (act && act !== document.body && act !== document.documentElement
        && (isField(act) || act.localName === 'iframe' || act.localName === 'frame' || act.localName === 'object')) return { skipped: 'focus' };
    if (sensitiveOnPage()) return { skipped: 'sensitive' };
    const se = document.scrollingElement || document.documentElement;
    const vh = innerHeight;
    const x = scrollX, y = scrollY, h0 = se ? se.scrollHeight : 0;
    if (!se || vh < 100 || h0 - y <= vh * 1.25) return { skipped: 'short' };
    if (locked()) return { skipped: 'locked' };
    const screens = clamp(Math.floor(+a.screens || 12), 1, 30);
    const step = Math.max(100, Math.floor(vh * 0.9));
    const pause = clamp(+a.pause || 110, 20, 500);
    const t0 = now(), deadline = t0 + clamp(+a.ms || 1500, 100, 4000), settle = clamp(+a.settle || 600, 0, 2000);
    prescrolling = true;
    prescrollStopped = false;
    const back = () => { try { scrollTo({ left: x, top: y, behavior: 'instant' }); } catch (e) { /* scrollTo is the page's, maybe gone */ } };
    return (async () => {
      let steps = 0, end = false, capped = false, lowest = y;
      try {
        for (let i = 1; ; i++) {
          if (prescrollStopped) break;
          if (i > screens || now() >= deadline) { capped = true; break; }
          const max = Math.max(0, se.scrollHeight - innerHeight);
          const top = Math.min(y + i * step, max);
          scrollTo({ left: x, top, behavior: 'instant' });
          steps++;
          lowest = Math.max(lowest, top);
          await sleep(pause);
          // At the end, and the page didn't grow while it waited: done. A page that grows goes on, to the cap.
          if (top >= max && se.scrollHeight - innerHeight <= max + 2) { end = true; break; }
        }
      } finally {
        back();
      }
      // Scroll anchoring can move the page once more as what loaded above settles: back again, then exactly.
      await sleep(0);
      if (scrollX !== x || scrollY !== y) back();
      const restored = scrollX === x && scrollY === y;
      // What the steps started loading: a moment for the pictures they came near to arrive, back where the page was. A
      // lazy picture further down never started, and a stop skips the wait.
      const until = now() + settle, reached = lowest + innerHeight * 2.5;
      while (!prescrollStopped && now() < until) {
        let waiting = false;
        const images = document.images;
        for (let i = 0; i < images.length && i < 2000; i++) {
          const im = images[i];
          if (im.complete) continue;
          const r = im.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top + scrollY < reached) { waiting = true; break; }
        }
        if (!waiting) break;
        await sleep(50);
      }
      const stopped = prescrollStopped;
      prescrolling = false;
      prescrollStopped = false;
      return { steps, end, capped: capped && !stopped, stopped, restored, grew: se.scrollHeight > h0, ms: Math.round(now() - t0) };
    })();
  }
  function prescrollStop() {
    if (prescrolling) prescrollStopped = true;
    return { ok: true, running: prescrolling };
  }

  /** The island's box over what's drawn there, clamped to the viewport. */
  function playerOf(el) {
    const r = el.getBoundingClientRect();
    let p = el;
    for (let n = el.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
      const q = n.getBoundingClientRect();
      if (q.left < r.left - 16 || q.top < r.top - 16 || q.right > r.right + 16 || q.bottom > r.bottom + 16) break;
      p = n;
    }
    return p;
  }
  const OVERLAY_ASKS = /\bsign ?in\b|\blog ?in\b|\bcookies?\b|\bconsent\b|\bsubscribe\b|\bagree\b|\baccept\b|\bverify\b|\byour age\b/i;
  function island(a) {
    const el = islandLookup(a.island);
    if (!el) return { gone: true };
    let r = el.getBoundingClientRect();
    const whole = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (a.scroll && !whole) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    const vw = innerWidth, vh = innerHeight;
    const x0 = clamp(r.left, 0, vw), y0 = clamp(r.top, 0, vh), x1 = clamp(r.right, 0, vw), y1 = clamp(r.bottom, 0, vh);
    const out = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, vw, vh, dpr: devicePixelRatio };
    out.visible = visible(el) && x1 > x0 && y1 > y0;
    // Covered if anything but the player is over its middle or a quarter in, as a consent or sign-in box over it is;
    // and while the page has a wall up, nothing behind it is live (the round-two rating: overlays settled first).
    const player = playerOf(el);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    // A box inside the player that asks something of the member (sign in, cookies, age) covers it as much as one over it.
    const asks = (hit) => {
      let box = null;
      for (let n = hit; n && n !== player && n !== el && owns(player, n); n = n.parentElement) box = n;
      if (!box || owns(el, hit)) return false;
      const r = box.getBoundingClientRect();
      return r.width * r.height >= 0.1 * area && OVERLAY_ASKS.test((box.innerText || '').slice(0, 600));
    };
    out.covered = out.visible ? [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
      .some(([fx, fy]) => { const hit = deepHit(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy); return !owns(player, hit) || asks(hit); }) : false;
    if (out.visible && !out.covered && wallOf(vw, vh)) out.wall = true;
    out.fullscreen = !!document.fullscreenElement;
    if (el.localName === 'video' || el.localName === 'audio') { out.playing = !el.paused && !el.ended; out.muted = !!el.muted; }
    return out;
  }

  /**
   * The consent press's checks (the Security Analyst's Ask 1 and T47X-1, every condition): the reject sits in a fixed,
   * sticky or high z-index box covering under half the screen, whose own text names cookies, consent, partners, vendors
   * or tracking, and which has an accept-type button too; and it's no link or form submit leading off the page's site.
   * An OAuth "Deny" or a parent's approval is in no such box, so it's never pressed.
   */
  // Cookies, partners, vendors or tracking: never "consent" or "privacy policy" alone, which an app's access request or a
  // parent's approval also says (T47X-1, as the Security Analyst wrote it).
  const CONSENT_WORDS = /\b(cookies?|partners?|vendors?|tracking|trackers?)\b/i;
  const ACCEPT_WORDS = /^\s*(accept|agree|allow|ok|okay|got it|i agree|i accept|accept all|allow all|yes,? i agree)\b/i;
  function consentBox(el) {
    const vw = innerWidth, vh = innerHeight;
    for (let p = el.parentElement, depth = 0; p && p !== document.body && p !== document.documentElement && depth < 20; p = p.parentElement, depth++) {
      const cs = getComputedStyle(p);
      const z = parseInt(cs.zIndex, 10);
      if (cs.position === 'fixed' || cs.position === 'sticky' || (cs.position !== 'static' && z >= 100)) {
        const r = p.getBoundingClientRect();
        const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
        if (cover <= 0 || cover >= 0.5) return null;
        if (!CONSENT_WORDS.test((p.innerText || '').slice(0, 3000))) return null;
        const accept = Array.from(p.querySelectorAll('button,[role=button],a,input[type=submit],input[type=button]'))
          .some((b) => b !== el && !b.contains(el) && ACCEPT_WORDS.test(b.innerText || b.value || b.getAttribute('aria-label') || ''));
        return accept ? p : null;
      }
    }
    return null;
  }
  const siteOf = (host) => {
    const l = String(host || '').toLowerCase().split('.');
    const n = l.length;
    if (n <= 2) return l.join('.');
    return (l[n - 1].length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go)$/.test(l[n - 2]) ? l.slice(n - 3) : l.slice(n - 2)).join('.');
  };
  function offSite(el) {
    const here = siteOf(location.hostname);
    const a = el.closest('a[href]');
    if (a) { const h = hostOf(a.href); if (h && siteOf(h) !== here) return true; }
    const f = el.form || el.closest('form');
    const submits = el.localName === 'button' ? (el.getAttribute('type') || 'submit').toLowerCase() === 'submit' : el.localName === 'input' && /^(submit|image)$/i.test(el.type);
    if (f && submits) { const h = hostOf(f.action); if (h && siteOf(h) !== here) return true; }
    return false;
  }
  /** The press itself: an untrusted el.click() from this world on the element, so no frame can take it and the page gets no user activation. */
  function consent(a) {
    const el = lookup(a.node);
    if (!el) return { refused: 'gone' };
    if (see(el) !== a.fp) return { refused: 'changed' };
    if (sensitiveKind(el)) return { refused: 'sensitive' };
    if (!consentBox(el) || offSite(el)) return { refused: 'consent' };
    el.click();
    return { ok: true };
  }

  /**
   * A media verb on an island's own element (spec section 6; behind deskd's flag until Security says yes). No input
   * goes anywhere: the element is called directly, so no frame can take it. An island that's another site's frame has
   * no element here, and refuses.
   */
  function media(a) {
    const el = islandLookup(a.island);
    if (!el) return { refused: 'gone' };
    if (islandFp(el) !== a.fp) return { refused: 'changed' };
    if (el.localName !== 'video' && el.localName !== 'audio') return { refused: 'frame' };
    return verb(el, a);
  }
  /**
   * The five verbs, and nothing else (Security's Ask 2): native calls on the element with clamped arguments, no input
   * dispatched and no gesture claimed. A play() the page or its autoplay rule refuses says so, for "Play on the real page".
   */
  const VERBS = new Set(['play', 'pause', 'seek', 'volume', 'track']);
  function verb(el, a) {
    if (!VERBS.has(a.verb)) return { refused: 'kind' };
    switch (a.verb) {
      case 'play': {
        let p;
        try { p = el.play(); } catch (e) { return { refused: 'play' }; }
        if (!p || typeof p.then !== 'function') return Object.assign({ ok: true }, mediaFacts(el));
        return Promise.race([p.then(() => true, () => false), new Promise((r) => setTimeout(() => r(true), 1500))])
          .then((ok) => (ok ? Object.assign({ ok: true }, mediaFacts(el)) : { refused: 'play' }));
      }
      case 'pause': el.pause(); break;
      case 'seek': if (typeof a.time === 'number' && isFinite(a.time)) el.currentTime = clamp(a.time, 0, isFinite(el.duration) ? el.duration : a.time); break;
      case 'volume': if (typeof a.volume === 'number') el.volume = clamp(a.volume, 0, 1); if (typeof a.muted === 'boolean') el.muted = a.muted; break;
      case 'track': for (let i = 0; i < el.textTracks.length; i++) el.textTracks[i].mode = i === a.track ? 'showing' : 'disabled'; break;
      default: return { refused: 'kind' };
    }
    return Object.assign({ ok: true }, mediaFacts(el));
  }
  /**
   * A verb on a video in another site's frame (Security's Ask 2, cross-origin frames): run in this frame's own world, on
   * the media element this frame's half picks itself, the largest it shows, never one the parent names.
   */
  function frameMedia(a) {
    let best = null, area = 0;
    forEachDeep((el) => {
      if (el.localName !== 'video' && el.localName !== 'audio') return false;
      const r = el.getBoundingClientRect();
      if (visible(el) && r.width * r.height > area) { best = el; area = r.width * r.height; }
      return false;
    }, 20000);
    if (!best) return { refused: 'gone' };
    return verb(best, a);
  }

  /**
   * A wall drawn by this frame (a CMP's terms modal, from another site): its words and its buttons' names, for deskd to
   * tell a terms wall from a cookie banner or a nag, as the prototype's kit does. Read only; nothing of it reaches the view.
   */
  function wallText() {
    const b = document.body;
    if (!b) return { host: location.hostname, text: '', buttons: [] };
    const names = Array.from(b.querySelectorAll('button,[role=button],a[href],input[type=button],input[type=submit]'))
      .filter((e) => e.getClientRects().length)
      .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { host: location.hostname, text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000), buttons: names.slice(0, 30) };
  }

  // ------------------------------------------------------------------------------------------------ the Agent's acts
  // The Agent's tabs are hidden targets, which trusted input never reaches on a desk's Chromium (S-14). Its clicks and keys
  // are done here instead, for deskd's ActionProxy for the Agent and nothing else: an untrusted el.click() or KeyboardEvent
  // from this world, never the page's own, on the one element deskd names. No input is dispatched, so no frame can take
  // it, and the page gets no user activation (no pop-up, fullscreen or clipboard). Each act is two calls, each one
  // synchronous run, so the page has no turn between a call's checks and what it does: a look, which makes every check and
  // says where the act would navigate without doing anything; then the act, which makes every check again, refuses if it
  // would now go anywhere else or a payment provider's frame came, and only then clicks or presses. What deskd sends is
  // arguments, never script.
  const AGENT_KEYS = {
    Enter: [13, 'Enter'], Escape: [27, 'Escape'], Tab: [9, 'Tab'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], Backspace: [8, 'Backspace'],
  };
  // The fields whose Enter submits their form, as HTML's implicit submission has them.
  const IMPLICIT = /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/;
  function isSubmitter(el) {
    if (el.localName === 'button') return el.type === 'submit';
    return el.localName === 'input' && /^(submit|image)$/i.test(el.type || '');
  }
  /** Where a form goes when this submits it (null for none: the form's own button), or null for a dialog's form. */
  function formTarget(form, submitter) {
    const method = ((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return null;
    return String(submitter && submitter.getAttribute('formaction') ? submitter.formAction : form.action);
  }
  /** A payment provider's frame anywhere in this document, open shadow roots too, whatever its size (Security, S-14). */
  function payFrame(hosts) {
    if (!Array.isArray(hosts) || !hosts.length) return false;
    let found = false;
    forEachDeep((el) => {
      const ln = el.localName;
      if (ln === 'iframe' || ln === 'frame' || ln === 'embed' || ln === 'object') found = onList(hostOf(srcOf(el)), hosts);
      return found;
    }, 50000);
    return found;
  }
  /** What a click or a key checks of its element first, as prepare does: what the member saw, never sensitive, usable. */
  function agentTarget(a, keys) {
    const el = lookup(a.node);
    if (!el) return { refused: 'gone' };
    if (see(el) !== a.fp) return { refused: 'changed' };
    const sk = sensitiveKind(el);
    if (sk) return { refused: 'sensitive', kind: sk };
    if (keys && !fits(el, 'press')) return { refused: 'kind' };
    if (isDisabled(el)) return { refused: 'disabled' };
    if (!visible(el)) return { refused: 'hidden' };
    let r = el.getBoundingClientRect();
    if (!inView(r)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
      if (!inView(r)) return { refused: 'hidden' };
      // A virtualized list can rebind the node as it scrolls.
      if (see(el) !== a.fp) return { refused: 'changed' };
    }
    return { el, r };
  }
  const expected = (a) => (typeof a.url === 'string' ? a.url : null);
  /** A click: a link's or a submit control's own activation, or the page's click handlers, as an untrusted click. */
  function agentClick(a) {
    const t = agentTarget(a, false);
    if (!t.el) return t;
    const el = t.el, r = t.r;
    // Only what's on top there: what a member couldn't click (under a dialog, say) the Agent doesn't either.
    const x = clamp(r.left + Math.min(r.width / 2, 40), Math.max(r.left, 1), Math.min(r.right, innerWidth - 1));
    const y = clamp(r.top + r.height / 2, Math.max(r.top, 1), Math.min(r.bottom, innerHeight - 1));
    if (!owns(el, deepHit(x, y))) return { refused: 'covered' };
    const link = el.closest ? el.closest('a[href],area[href]') : null;
    const form = !link && isSubmitter(el) ? el.form : null;
    const nav = link ? 'link' : form ? 'submit' : null;
    const url = link ? String(link.href) : form ? formTarget(form, el) : null;
    const pay = payFrame(a.payHosts);
    if (a.look) return { ok: true, nav, url, pay };
    if (expected(a) !== url || (pay && !a.spend)) return { refused: 'changed' };
    el.click();
    return { ok: true, nav };
  }
  /** HTML's implicit submission for Enter in el: the form's default button to click, or the form alone, or nothing. */
  function implicitSubmission(el) {
    if (el.localName !== 'input' || !IMPLICIT.test((el.type || 'text').toLowerCase()) || !el.form) return null;
    const form = el.form;
    let button = null, blocking = 0;
    for (const c of Array.from(form.elements)) {
      if (!button && isSubmitter(c)) button = c;
      if (c.localName === 'input' && IMPLICIT.test((c.type || 'text').toLowerCase())) blocking++;
    }
    if (button) return button.disabled ? null : { form, button, url: formTarget(form, button) };
    return blocking > 1 ? null : { form, button: null, url: formTarget(form, null) };
  }
  function keyEvent(type, spec, extra) {
    return new KeyboardEvent(type, Object.assign({
      key: spec[1], code: spec[1], keyCode: spec[0], which: spec[0], bubbles: true, cancelable: true, composed: true,
    }, extra || {}));
  }
  /** Backspace's own edit of a plain field, after a beforeinput the page may cancel. A rich editor gets the events only. */
  function deleteBack(el) {
    if (el.localName !== 'input' && el.localName !== 'textarea') return;
    // The page's keydown ran just now, and can have made it read-only (Security, Nov 11).
    if (readOnly(el) || isDisabled(el)) return;
    const opts = { inputType: 'deleteContentBackward', bubbles: true, composed: true };
    if (!el.dispatchEvent(new InputEvent('beforeinput', Object.assign({ cancelable: true }, opts)))) return;
    const v = String(el.value);
    let s = null, e = null;
    try { s = el.selectionStart; e = el.selectionEnd; } catch (x) { /* a kind without a selection: from the end */ }
    if (s == null || e == null) s = e = v.length;
    if (s === e) {
      if (s === 0) return;
      s -= s > 1 && /[\udc00-\udfff]/.test(v[s - 1]) && /[\ud800-\udbff]/.test(v[s - 2]) ? 2 : 1;
    }
    el.value = v.slice(0, s) + v.slice(e);
    try { el.setSelectionRange(s, s); } catch (x) { /* none */ }
    el.dispatchEvent(new InputEvent('input', opts));
  }
  /**
   * A key on the focused element, as the page's own handlers would hear it: keydown, then for Enter keypress and, unless
   * the page cancelled either, implicit submission of the field's form; Backspace's edit; keyup. Escape, Tab and the
   * arrows are the events alone: Tab doesn't move focus.
   */
  function agentPress(a) {
    const spec = Object.prototype.hasOwnProperty.call(AGENT_KEYS, a.key) ? AGENT_KEYS[a.key] : null;
    if (!spec) return { refused: 'kind' };
    const t = agentTarget(a, true);
    if (!t.el) return t;
    const el = t.el;
    if (!owns(el, deepActive())) el.focus({ preventScroll: true });
    const target = deepActive();
    if (!owns(el, target)) return { refused: 'focus' };
    // A page can turn a field into a password one as it gets focus, or a read-only one.
    const flipped = sensitiveKind(el);
    if (flipped) return { refused: 'sensitive', kind: flipped };
    if (!fits(el, 'press')) return { refused: 'kind' };
    if (see(el) !== a.fp) return { refused: 'changed' };
    const sub = a.key === 'Enter' ? implicitSubmission(el) : null;
    const url = sub ? sub.url : null;
    const pay = payFrame(a.payHosts);
    if (a.look) return { ok: true, nav: sub ? 'submit' : null, url, pay };
    if (expected(a) !== url || (sub && pay && !a.spend)) return { refused: 'changed' };
    let submitted = false;
    if (target.dispatchEvent(keyEvent('keydown', spec))) {
      if (a.key === 'Enter') {
        if (target.dispatchEvent(keyEvent('keypress', spec, { charCode: 13 })) && sub && el.isConnected && el.form === sub.form) {
          if (!sub.button) {
            sub.form.requestSubmit();
            submitted = true;
          } else if (sub.button.isConnected && !sub.button.disabled && sub.button.form === sub.form) {
            sub.button.click();
            submitted = true;
          }
        }
      } else if (a.key === 'Backspace') {
        deleteBack(el);
      }
    }
    if (target.isConnected) target.dispatchEvent(keyEvent('keyup', spec));
    return { ok: true, submitted };
  }
  /** Empties the field prepare armed and selected, for the Agent's fill of nothing: no key is dispatched. */
  function agentClear(a) {
    const g = armed;
    if (!g || g.id !== String(a.id) || !g.el || !g.typing) return { lost: true };
    const el = g.el;
    const sk = sensitiveKind(el);
    if (sk) return { refused: 'sensitive', kind: sk };
    // What prepare checked, again: the page had a turn since, and a value set here would pass readonly by.
    if (!fits(el, 'fill') || isDisabled(el)) return { refused: 'kind' };
    if (el.localName === 'input' || el.localName === 'textarea') {
      const opts = { inputType: 'deleteContentBackward', bubbles: true, composed: true };
      if (el.dispatchEvent(new InputEvent('beforeinput', Object.assign({ cancelable: true }, opts)))) {
        el.value = '';
        el.dispatchEvent(new InputEvent('input', opts));
      }
    } else if (el.isContentEditable) {
      document.execCommand('delete');
    }
    return { ok: true };
  }
  function payFrames(a) {
    return { pay: payFrame(a.payHosts) };
  }

  const TOP_OPS = { snapshot, changed, wake, prepare, result, select, scroll, island, media, consent, arm, disarm,
    agentClick, agentPress, agentClear, payFrames, prescroll, prescrollStop };
  const FRAME_OPS = { arm, disarm, frameMedia, wallText };
  // This world's own random id, in every answer: deskd trusts a context id it keeps only with the same one (T47N-2).
  const WID = Math.random().toString(36).slice(2) + '.' + Date.now().toString(36);
  const withWid = (r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.assign(r, { wid: WID }) : r);
  function run(a) {
    if (!a || typeof a !== 'object' || typeof a.op !== 'string') return withWid({ error: 'args' });
    const ops = TOP ? TOP_OPS : FRAME_OPS;
    if (!Object.prototype.hasOwnProperty.call(ops, a.op)) return withWid({ error: 'op' });
    try {
      const r = ops[a.op](a);
      return r && typeof r.then === 'function' ? r.then(withWid, () => withWid({ error: 'threw' })) : withWid(r);
    } catch (e) {
      return withWid({ error: 'threw' });
    }
  }
  Object.defineProperty(globalThis, '__maProxy', {
    // element: an island's own element, for deskd to ask Chromium which frame an island's iframe holds (Ask 2).
    value: Object.freeze({ run, element: (a) => (TOP && a && typeof a.island === 'string' ? islandLookup(a.island) : null) }),
    enumerable: false, configurable: false, writable: false,
  });
})();
