package com.minimalistalliance.desk.deskd.browser;

/**
 * The phone view's scripts ({@link BrowserView}): constants, each run with {@code Runtime.callFunctionOn} in deskd's own
 * isolated world {@value #WORLD}, where a page can't redefine what they read or reach what they keep, with any argument
 * passed as a JSON number. Nothing a client sends is ever script. What leaves the page is a fixed word for a field's kind,
 * one of the enter-key hints, and four numbers for its box: never a value, a name, an id or a URL.
 */
final class ViewScripts {

    static final String WORLD = "ma-deskd-view";
    /** Added to deskd's world alone, by context id, so the page has no way to call it. */
    static final String BINDING = "maDeskdField";

    private ViewScripts() {}

    /**
     * Installs the view's helpers in the world once and returns them. {@code arm(binding)} watches the document's focus,
     * and its visibility, and tells the binding what's focused, at most once per 30 ms and only on a change. {@code at(x,
     * y)} says what a tap there would focus. Both say a field's kind in deskd's words (API.md section 10), or null where
     * no keyboard belongs: a field that's disabled or read-only, {@code inputmode=none}, a date, a checkbox or a select.
     * A focused frame of another origin is {@code unknown}, as nothing in it can be read.
     *
     * <p>Coordinates in are the view's own pixels, the visual viewport's at the page's zoom; a box out is the same, so
     * deskd needs only the screen's scale to place it.
     */
    private static final String LIB = """
            (() => {
              const g = globalThis;
              if (g.__maView) return g.__maView;
              const TYPES = {'': 'plain', text: 'plain', search: 'query', email: 'email_address', tel: 'phone_number',
                url: 'web_address', number: 'numeric', password: 'secret'};
              const MODES = {text: 'plain', search: 'query', email: 'email_address', tel: 'phone_number',
                url: 'web_address', numeric: 'numeric', decimal: 'decimal'};
              const HINTS = ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'];
              const DEPTH = 8;
              const attr = (el, name) => (el.getAttribute(name) || '').trim().toLowerCase();
              const kindOf = (el) => {
                if (!el || el.nodeType !== 1) return null;
                let kind = null;
                if (el.localName === 'textarea') {
                  kind = el.disabled || el.readOnly ? null : 'multiline';
                } else if (el.localName === 'input') {
                  const type = attr(el, 'type');
                  kind = el.disabled || el.readOnly || !Object.hasOwn(TYPES, type) ? null : TYPES[type];
                } else if (el.isContentEditable) {
                  kind = 'multiline';
                }
                if (!kind) return null;
                const mode = attr(el, 'inputmode');
                if (mode === 'none') return null;
                if (kind !== 'secret' && Object.hasOwn(MODES, mode)) kind = MODES[mode];
                const hint = attr(el, 'enterkeyhint');
                return {k: kind, e: HINTS.includes(hint) ? hint : null};
              };
              const viewport = () => {
                const v = g.visualViewport;
                return v ? [v.scale || 1, v.offsetLeft, v.offsetTop] : [1, 0, 0];
              };
              const box = (el, dx, dy) => {
                const r = el.getBoundingClientRect();
                const [s, ox, oy] = viewport();
                return [Math.round((r.left + dx - ox) * s), Math.round((r.top + dy - oy) * s),
                  Math.round(r.width * s), Math.round(r.height * s)];
              };
              const watched = new WeakSet();
              let send = null;
              let last = null;
              let timer = 0;
              const focused = () => {
                let doc = document;
                let dx = 0;
                let dy = 0;
                for (let depth = 0; depth <= DEPTH; depth++) {
                  let el = doc.activeElement;
                  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
                  if (!el) return null;
                  if (el.localName !== 'iframe' && el.localName !== 'frame') return {el, dx, dy, frame: false};
                  let inner = null;
                  try { inner = el.contentDocument; } catch (e) { inner = null; }
                  if (!inner) return {el, dx, dy, frame: true};
                  watch(inner);
                  const r = el.getBoundingClientRect();
                  dx += r.left + el.clientLeft;
                  dy += r.top + el.clientTop;
                  doc = inner;
                }
                return null;
              };
              const report = () => {
                timer = 0;
                if (!send) return;
                const out = {v: document.visibilityState === 'visible' ? 1 : 0, f: null};
                if (out.v) {
                  const found = focused();
                  const kind = !found ? null : found.frame ? {k: 'unknown', e: null} : kindOf(found.el);
                  if (kind) out.f = {k: kind.k, e: kind.e, b: box(found.el, found.dx, found.dy)};
                }
                const text = JSON.stringify(out);
                if (text !== last) {
                  last = text;
                  send(text);
                }
              };
              const later = () => {
                if (!timer) timer = setTimeout(report, 30);
              };
              const watch = (doc) => {
                if (watched.has(doc)) return;
                watched.add(doc);
                doc.addEventListener('focusin', later, true);
                doc.addEventListener('focusout', later, true);
                doc.addEventListener('visibilitychange', later, true);
              };
              const at = (px, py) => {
                const [s, ox, oy] = viewport();
                let x = ox + px / s;
                let y = oy + py / s;
                let el = document.elementFromPoint(x, y);
                for (let step = 0; el && step <= DEPTH * 4; step++) {
                  if (el.shadowRoot) {
                    const inner = el.shadowRoot.elementFromPoint(x, y);
                    if (inner && inner !== el) { el = inner; continue; }
                  }
                  if (el.localName === 'iframe' || el.localName === 'frame') {
                    let inner = null;
                    try { inner = el.contentDocument; } catch (e) { inner = null; }
                    if (!inner) return {k: 'unknown', e: null};
                    const r = el.getBoundingClientRect();
                    x -= r.left + el.clientLeft;
                    y -= r.top + el.clientTop;
                    el = inner.elementFromPoint(x, y);
                    continue;
                  }
                  break;
                }
                for (let n = el, up = 0; n && up < 64; up++) {
                  const kind = kindOf(n);
                  if (kind) return kind;
                  if (n.localName === 'label' && n.control) return kindOf(n.control);
                  n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
                }
                return null;
              };
              const view = {
                at,
                arm(binding) {
                  if (typeof binding !== 'function') return 'unbound';
                  send = binding;
                  watch(document);
                  last = null;
                  report();
                  return 'armed';
                },
              };
              g.__maView = view;
              return view;
            })()""";

    /** Watches focus in this document from now on, and says what's focused at once. Returns {@code armed}. */
    static final String ARM = "function () { return " + LIB + ".arm(globalThis." + BINDING + "); }";

    /** What a tap at the view's pixels {@code (x, y)} would focus: {@code {k, e}}, or null. */
    static final String AT = "function (x, y) { return " + LIB + ".at(x, y); }";

    /** The page's own zoom, which Input's coordinates are divided by. */
    static final String PAGE_SCALE = "function () { const v = globalThis.visualViewport; return v && v.scale > 0 ? v.scale : 1; }";

    /**
     * Before the viewport changes: the element nearest the top of what's shown that's no taller than half of it, and where
     * it is, so {@link #RESTORE} can put it back there. Chromium keeps the scroll offset in pixels across the change, not
     * what's at it (Chrome for Testing 158). Nothing to keep at the very top of a page.
     */
    static final String SAVE = """
            function () {
              const se = document.scrollingElement || document.documentElement;
              const anchor = {w: innerWidth, el: null, top: 0, frac: 0};
              globalThis.__maAnchor = anchor;
              if (!se || se.scrollTop <= 0) return false;
              for (const f of [0.02, 0.15, 0.3, 0.5]) {
                const c = document.elementFromPoint(innerWidth / 2, innerHeight * f);
                if (c && c !== document.body && c !== document.documentElement
                    && c.getBoundingClientRect().height < innerHeight / 2) {
                  anchor.el = c;
                  anchor.top = c.getBoundingClientRect().top;
                  break;
                }
              }
              const room = se.scrollHeight - se.clientHeight;
              anchor.frac = room > 0 ? se.scrollTop / room : 0;
              return true;
            }""";

    /**
     * After it: once the page has its new width (up to 0.5 s), the element {@link #SAVE} kept goes back to where it was
     * from the top, or the page to the same share of its length if it's gone. Says {@code anchor}, {@code fraction},
     * {@code top} or {@code none}.
     */
    static final String RESTORE = """
            function () {
              const a = globalThis.__maAnchor;
              globalThis.__maAnchor = undefined;
              if (!a) return 'none';
              return new Promise((done) => {
                let tries = 0;
                const go = () => {
                  if (innerWidth === a.w && tries++ < 20) { setTimeout(go, 25); return; }
                  const se = document.scrollingElement || document.documentElement;
                  if (!se || (!a.el && !a.frac)) { done('top'); return; }
                  if (a.el && a.el.isConnected) {
                    const off = a.el.getBoundingClientRect().top - Math.min(a.top, innerHeight / 2);
                    if (Math.abs(off) > 2) se.scrollTop += off;
                    done('anchor');
                    return;
                  }
                  se.scrollTop = a.frac * (se.scrollHeight - se.clientHeight);
                  done('fraction');
                };
                go();
              });
            }""";
}
