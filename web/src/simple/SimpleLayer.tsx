// The Browser's simple view (task 47, design 7.4, ADR 0030): the page on the desk, rendered here from its structure,
// so scrolling, selection and find never leave this browser and the desk sends no picture. A lazy chunk: the main
// bundle only has the switch and the stream's half (`ui.ts`, `decide.ts`).
import { Fragment, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';
import type { BrowserTab, DeskLink } from '../desk/deskLink';
import type { BrowserDriver } from '../browser/driver';
import { addressShown } from '../browser/address';
import { noteDeskInput } from '../desk/liveStore';
import { BlockView, cardKind, Chevron, DeskImage, DialogFrame, Page, posterOf, type PageContext } from './blocks';
import { SimpleController, type SimpleViewState } from './controller';
import type { KeyedBlock } from './docStore';
import { Island, IslandChip } from './Island';
import { foldsDeep, plainText, shownDate, type Article, type Block } from './mdoc';
import { filtersOf, FilterRow, SiteRow } from './SiteRow';
import { isFront, outline } from './outline';
import { linkSource, type SimpleSource } from './source';
import type { SimpleUi } from './ui';
import '@fontsource-variable/nunito';
import simpleCssUrl from './simple.css?url';

// The bar's switch and line ride in this chunk (`BrowserBar.tsx` loads them from here).
export { BarSwitch } from './BarSwitch';

/** Blocks in the first paint (design 7.4: the first viewport within 50 ms); the rest follow in a transition. */
const FIRST_BLOCKS = 60;

export interface SimpleLayerProps {
  deskId: string;
  link: DeskLink;
  driver: BrowserDriver;
  ui: SimpleUi;
  tabs: BrowserTab[];
  /** Tests only: another source than the link's. */
  source?: SimpleSource;
}

/**
 * Runs of blocks: a dialog the page put over itself stays together, in its own frame; replies deeper than three levels
 * fold together under "More replies"; a run of list items is one real list (the spec's section 12).
 */
type Group =
  | { kind: 'one'; kb: KeyedBlock }
  | { kind: 'dialog' | 'fold'; key: string; blocks: KeyedBlock[] }
  | { kind: 'list'; key: string; ordered: boolean; blocks: KeyedBlock[] };


function group(blocks: KeyedBlock[]): Group[] {
  const out: Group[] = [];
  for (const kb of blocks) {
    const last = out[out.length - 1];
    const b = kb.block;
    const kind = b.dialog ? 'dialog' : foldsDeep(b) ? 'fold' : b.t === 'item' ? 'list' : 'one';
    if (kind === 'one') out.push({ kind, kb });
    else if (last && last.kind === kind) last.blocks.push(kb);
    else if (kind === 'list') out.push({ kind, key: `l:${kb.key}`, ordered: b.t === 'item' && b.marker !== null, blocks: [kb] });
    else out.push({ kind, key: `${kind[0]}:${kb.key}`, blocks: [kb] });
  }
  return out;
}

/**
 * The line over replies deeper than three levels (R43): "N more replies" where each is one `comment` block, which the wire
 * counts; "More replies" where the replies are paragraphs, which don't say where one reply ends.
 */
function moreReplies(blocks: readonly KeyedBlock[]): string {
  if (!blocks.every((kb) => kb.block.t === 'comment')) return 'More replies';
  return blocks.length === 1 ? '1 more reply' : `${blocks.length} more replies`;
}

/** "A and B", "A, B and C". */
const names = (list: readonly string[]): string => (list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1) as string}`);

/**
 * An article's own facts around its title (section 14's `article`, the spec's section 4): the kicker above it; then, where
 * the page has no byline of its own, who wrote it, when and how long it takes; and the lead photo with its caption and
 * credit kept apart, where the page has no photo of its own up top.
 */
function ArticleTitle({ kb, a, blocks }: { kb: KeyedBlock; a: Article; blocks: readonly KeyedBlock[] }) {
  const at = blocks.indexOf(kb);
  const after = blocks.slice(at + 1, at + 4).map((x) => x.block);
  const facts = [a.byline.length ? `By ${names(a.byline)}` : '', shownDate(a.date), a.readMinutes ? `${a.readMinutes} min read` : ''].filter(Boolean).join(' · ');
  const lead = a.lead && !after.some((b) => b.t === 'figure') ? a.lead : null;
  return (
    <>
      {a.kicker && <p className="sv-block sv-kicker">{a.kicker}</p>}
      <BlockView kb={kb} level={1} />
      {facts && !after.some((b) => b.t === 'byline') && <p className="sv-block sv-byline">{facts}</p>}
      {lead && (
        <figure className="sv-block sv-figure sv-wide">
          <DeskImage img={lead.img} inline={false} />
          {(lead.caption || lead.credit) && (
            <figcaption className="sv-caption">
              {lead.caption}
              {lead.credit && <span className="sv-credit">{lead.credit}</span>}
            </figcaption>
          )}
        </figure>
      )}
    </>
  );
}

/** The site row reads the distiller's bar, which is the page's first block when it has one. */
function barOf(blocks: readonly KeyedBlock[] | undefined): Extract<Block, { t: 'bar' }> | null {
  const b = blocks?.find((kb) => kb.block.t === 'bar')?.block;
  return b?.t === 'bar' ? b : null;
}

/** An origin's host, lower case and in its `xn--` form (the head's `origin`, section 14), or empty. */
function originHost(origin: string | null | undefined): string {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A link's destination host, as the address bar would show it, or empty. */
function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return addressShown(new URL(url).host);
  } catch {
    return '';
  }
}

/**
 * R58: a docs page's "In this article", as a rail from 1100 px (the spec's section 4): the page's own sections, which
 * scroll this view, never the real page; sticky, marking the section in view. Under 1100 px it isn't drawn, and the
 * site's own contents stay in the site row's Menu.
 */
function ArticleRail({ heads, scroller }: { heads: { key: string; text: string }[]; scroller: () => HTMLElement | null }) {
  const [current, setCurrent] = useState<string | null>(heads[0]?.key ?? null);
  useEffect(() => {
    const box = scroller();
    if (!box || typeof IntersectionObserver !== 'function') return undefined;
    const els = heads.flatMap((h) => {
      const el = box.querySelector<HTMLElement>(`[data-head="${CSS.escape(h.key)}"]`);
      return el ? [el] : [];
    });
    const seen = new Set<string>();
    // A section is current from when its heading reaches the top quarter: the last heading above that line wins.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset['head'] ?? '';
          if (e.isIntersecting) seen.add(key);
          else seen.delete(key);
        }
        const top = box.getBoundingClientRect().top + box.clientHeight * 0.25;
        let at: string | null = null;
        for (const el of els) if (el.getBoundingClientRect().top <= top) at = el.dataset['head'] ?? at;
        setCurrent(at ?? heads[0]?.key ?? null);
      },
      { root: box, threshold: [0, 1], rootMargin: '0px 0px -60% 0px' },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [heads, scroller]);
  return (
    <nav className="sv-rail" aria-label="In this article" data-testid="simple-rail">
      <p className="sv-rail-h" aria-hidden="true">
        In this article
      </p>
      <ul>
        {heads.map((h) => (
          <li key={h.key}>
            <button
              type="button"
              aria-current={current === h.key ? 'location' : undefined}
              onClick={() => {
                const el = scroller()?.querySelector<HTMLElement>(`[data-head="${CSS.escape(h.key)}"]`);
                const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                el?.scrollIntoView({ block: 'start', behavior: still ? 'instant' : 'smooth' });
                el?.focus({ preventScroll: true });
                setCurrent(h.key);
              }}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Copy link": the menu a link's right click or menu key opens, since a link here has no `href` (the Designer's section 13). */
function LinkMenu({ at, url, onClose }: { at: { x: number; y: number }; url: string; onClose: () => void }) {
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    item.current?.focus();
    const away = (e: Event): void => {
      if (!item.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div className="sv-menu" role="menu" aria-label="Link" style={{ left: at.x, top: at.y }} data-testid="simple-link-menu" onKeyDown={(e) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }}>
      <button
        ref={item}
        type="button"
        role="menuitem"
        onClick={() => {
          // The member's own clipboard, here: the link's checked http(s) address, nothing sent anywhere.
          void navigator.clipboard?.writeText(url).catch(() => undefined);
          onClose();
        }}
      >
        Copy link
      </button>
    </div>
  );
}

function SimplePage({ view, controller, driver, deskId, ui }: { view: SimpleViewState; controller: SimpleController; driver: BrowserDriver; deskId: string; ui: SimpleUi }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; url: string } | null>(null);
  const menuFrom = useRef<HTMLElement | null>(null);
  // Closed, the focus goes back to the link it came from, if it went nowhere else.
  const closeMenu = useCallback(() => {
    setMenu(null);
    const from = menuFrom.current;
    menuFrom.current = null;
    requestAnimationFrame(() => {
      if (from?.isConnected && (!document.activeElement || document.activeElement === document.body)) from.focus({ preventScroll: true });
    });
  }, []);
  const sentinel = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const doc = view.doc;
  const blocks = doc?.blocks;
  const [limit, setLimit] = useState(FIRST_BLOCKS);

  // A different page starts at its top, and at its first viewport.
  useLayoutEffect(() => {
    scroller.current?.scrollTo(0, 0);
    setLimit(FIRST_BLOCKS);
  }, [view.pageSerial]);
  useEffect(() => {
    if (blocks && limit < blocks.length) {
      const id = requestAnimationFrame(() => startTransition(() => setLimit(Infinity)));
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [blocks, limit]);

  // Where the member is reading, for the full page to open at the same place (design 7.4, "Switching keeps your place").
  useEffect(() => {
    controller.topRef = () => {
      const box = scroller.current;
      if (!box) return null;
      const top = box.getBoundingClientRect().top;
      for (const el of box.querySelectorAll<HTMLElement>('[data-ref]')) {
        if (el.getBoundingClientRect().bottom > top + 1) return el.dataset['ref'] ?? null;
      }
      return null;
    };
    return () => {
      controller.topRef = () => null;
    };
  }, [controller]);

  // Near the end of a long list, the real page is asked for more, two viewports early (design 7.3). Two observers and no
  // scroll listener: the end coming into reach once the member has scrolled, or the member scrolling off the top of a
  // page short enough that its end was in reach from the start.
  useEffect(() => {
    const end = sentinel.current;
    const start = top.current;
    const box = scroller.current;
    if (!end || !start || !box || typeof IntersectionObserver !== 'function') return undefined;
    let endNear = false;
    let scrolled = false;
    const check = (): void => {
      if (endNear && scrolled) controller.more();
    };
    const ioEnd = new IntersectionObserver((entries) => {
      endNear = entries.some((e) => e.isIntersecting);
      check();
    }, { root: box, rootMargin: '0px 0px 200% 0px' });
    const ioStart = new IntersectionObserver((entries) => {
      scrolled = entries.every((e) => !e.isIntersecting);
      check();
    }, { root: box });
    ioEnd.observe(end);
    ioStart.observe(start);
    return () => {
      ioEnd.disconnect();
      ioStart.disconnect();
    };
  }, [controller]);

  const getScroller = useCallback(() => scroller.current, []);
  const renderIsland = useCallback<PageContext['renderIsland']>(
    (b) => <Island b={b} live={view.liveIsland === b.key} filled={view.filled === b.key} controller={controller} scroller={getScroller} />,
    [view.liveIsland, view.filled, controller, getScroller],
  );
  const site = addressShown(view.site ?? '');
  // The site by its registrable domain, as the desk keys it, from the head's own origin (security review T47O-3). Until
  // the desk has said, the host itself, which names the site no less surely.
  const host = originHost(doc?.meta.origin) || (view.site ?? '');
  const known = useSyncExternalStore(controller.memory.subscribe, () => controller.memory.domain(host));
  const domain = known ?? host.replace(/^www\./, '');
  const op = useMemo(() => posterOf(blocks?.map((kb) => kb.block) ?? [], doc?.meta.article?.byline ?? []), [blocks, doc?.meta.article]);
  const context = useMemo<PageContext>(() => ({ controller, site, domain, op, renderIsland }), [controller, site, domain, op, renderIsland]);
  const groups = useMemo(() => group(blocks ? blocks.slice(0, limit) : []), [blocks, limit]);
  // R61: a site's front page (its address is the site's root) with no h1 of its own gets a hidden one, "{site} front
  // page", and its sections stay h2.
  const front = useMemo(() => isFront(doc?.meta.url ?? null, blocks ?? []), [doc?.meta.url, blocks]);
  const levels = useMemo(() => outline(blocks ?? [], front), [blocks, front]);
  const { filters, bar } = useMemo(() => filtersOf(blocks?.map((kb) => kb.block) ?? [], barOf(blocks)), [blocks]);
  const chip = view.chip ? controller.islandBlock(view.chip) : null;

  // ----- the member's input, delegated: one listener for the whole page

  // The nearest control pressed, if it's the page's. A control of this office's own, with no `data-ref` ("Sign in on" or
  // "Use the real page", drawn inside a link), is never the link: the press stays its own (security review T47V-1).
  const target = (e: { target: EventTarget }): HTMLElement | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ref], button, input, select, textarea');
    return el?.dataset['ref'] ? el : null;
  };

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const el = target(e);
    const ref = el?.dataset['ref'];
    if (!el || !ref) return;
    noteDeskInput(deskId, false);
    // Ctrl or Cmd and a click on a link opens it in a new tab on the desk, as a browser would, never in this one.
    const url = el.dataset['url'];
    if ((e.ctrlKey || e.metaKey) && url && el.getAttribute('role') === 'link') {
      e.preventDefault();
      driver.openTabAt(url);
      return;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      // Flips at once, confirmed by the page's echo; a refusal puts it back (design 7.4, "Optimistic where it is safe").
      const was = !el.checked;
      controller.act({ act: 'check', ref, checked: el.checked }, () => {
        el.checked = was;
      });
      return;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
    e.preventDefault();
    // Links and buttons are never optimistic: pressed now, and the page answers (design 7.4).
    el.classList.add('sv-pressed');
    window.setTimeout(() => el.classList.remove('sv-pressed'), 600);
    controller.act({ act: 'click', ref });
  };

  // A middle click on a link opens it in a new tab on the desk, as it would in a browser, never in this one (T47-6).
  const onAuxClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 1) return;
    const url = target(e)?.dataset['url'];
    if (!url) return;
    e.preventDefault();
    driver.openTabAt(url);
  };

  const onInput = (e: React.FormEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    const ref = el.dataset['ref'];
    if (!ref) return;
    if ((el instanceof HTMLInputElement && el.type === 'text') || el instanceof HTMLTextAreaElement) controller.fill(ref, el.value);
  };

  const onChange = (e: React.ChangeEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    const ref = el.dataset['ref'];
    if (!ref || !(el instanceof HTMLSelectElement)) return;
    // By index, with the label the member saw, which the desk checks against the page's own (section 14).
    const index = Number(el.value);
    const label = el.selectedOptions[0]?.textContent ?? '';
    if (Number.isInteger(index) && index >= 0) controller.act({ act: 'select', ref, index, label });
  };

  // A link's menu: "Copy link" (the Designer's section 13), from a right click or the keyboard's menu key.
  const onContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="link"][data-url]');
    const url = el?.dataset['url'];
    // Text the member selected keeps the browser's own menu, with its Copy.
    if (!el || !url || (window.getSelection()?.toString() ?? '') !== '') return;
    e.preventDefault();
    const box = scroller.current?.parentElement?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = e.clientX || r.left;
    const y = e.clientY || r.bottom;
    menuFrom.current = el;
    setMenu({ x: x - (box?.left ?? 0), y: y - (box?.top ?? 0), url });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    const ref = el.dataset['ref'];
    if (!ref) return;
    if (el instanceof HTMLAnchorElement && e.key === 'Enter') {
      e.preventDefault();
      // Ctrl or Cmd and Enter opens it in a new tab on the desk, as a browser would (the Designer's section 13).
      const url = el.dataset['url'];
      if ((e.ctrlKey || e.metaKey) && url && el.getAttribute('role') === 'link') driver.openTabAt(url);
      else el.click();
      return;
    }
    if (el instanceof HTMLInputElement && el.type === 'text' && el.dataset['enter'] === '1' && e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      controller.flushFills();
      controller.act({ act: 'press', ref, key: 'Enter' });
    }
  };

  // Where a link goes, as its host, in the bar's note slot while it's pointed at or focused (the Designer's section 13).
  const showHost = (e: { target: EventTarget }): void => {
    ui.set({ linkHost: hostOf((e.target as HTMLElement).closest<HTMLElement>('[data-url]')?.dataset['url']) });
  };
  useEffect(() => () => ui.set({ linkHost: '' }), [ui]);

  const empty = !doc || doc.blocks.length === 0;
  const listing = doc?.meta.mode === 'page' && Boolean(blocks?.some((kb) => kb.block.t === 'cards'));
  const shop = listing && Boolean(blocks?.some((kb) => kb.block.t === 'cards' && cardKind(kb.block.layout, kb.block.items, false) === 'product'));
  // A video's own page runs at 880 (the spec's section 3, the Designer's brand review).
  const watching = Boolean(blocks?.some((kb) => kb.block.t === 'island' && kb.block.main));
  // A docs page (the site's chrome has its own contents) gets "In this article" from its sections (R58).
  const docs = Boolean(bar?.groups.some((g) => g.kind === 'contents'));
  const heads = useMemo(
    () => (docs && blocks ? blocks.filter((kb) => levels.get(kb.key) === 2 && kb.block.t === 'heading').map((kb) => ({ key: kb.key, text: kb.block.t === 'heading' ? plainText(kb.block.c).slice(0, 120) : '' })) : []),
    [docs, blocks, levels],
  );
  const railed = heads.length >= 3;
  const page = (
    <article className={`sv-page${view.stale ? ' stale' : ''}${doc?.meta.mode === 'article' ? ' sv-article' : ''}${listing ? ' sv-listing' : ''}${shop ? ' sv-shop' : ''}${watching ? ' sv-watch' : ''}${railed ? ' sv-docs' : ''}`} data-testid="simple-page" data-page={doc?.meta.url ?? undefined} data-blocks={doc?.blocks.length ?? 0}>
      <div ref={top} className="sv-start" aria-hidden="true" />
      {doc && <SiteRow key={view.pageSerial} meta={doc.meta} bar={bar} host={site} domain={domain} />}
      {front && <h1 className="sv-sr">{`${domain} front page`}</h1>}
      {filters && <FilterRow key={`f${view.pageSerial}`} f={filters} />}
      {!empty &&
        groups.map((g) =>
          g.kind === 'one' ? (
            doc?.meta.article && levels.get(g.kb.key) === 1 ? (
              <Fragment key={g.kb.key}>
                <ArticleTitle kb={g.kb} a={doc.meta.article} blocks={blocks ?? []} />
              </Fragment>
            ) : (
              <BlockView key={g.kb.key} kb={g.kb} level={levels.get(g.kb.key)} />
            )
          ) : g.kind === 'list' ? (
            g.ordered ? (
              <ol key={g.key} className="sv-block sv-list" role="list">
                {g.blocks.map((kb) => (
                  <BlockView key={kb.key} kb={kb} li />
                ))}
              </ol>
            ) : (
              <ul key={g.key} className="sv-block sv-list" role="list">
                {g.blocks.map((kb) => (
                  <BlockView key={kb.key} kb={kb} li />
                ))}
              </ul>
            )
          ) : g.kind === 'dialog' ? (
            <DialogFrame key={g.key} blocks={g.blocks} site={site} />
          ) : (
            <details key={g.key} className="sv-block sv-more-replies">
              <summary>
                {moreReplies(g.blocks)}
                <Chevron />
              </summary>
              {g.blocks.map((kb) => (
                <BlockView key={kb.key} kb={kb} />
              ))}
            </details>
          ),
        )}
      <div ref={sentinel} className="sv-end" aria-hidden="true" />
    </article>
  );
  return (
    <Page.Provider value={context}>
      <div
        ref={scroller}
        className="sv-scroll"
        tabIndex={0}
        aria-label={site ? `Simplified view of ${site}` : 'Simplified view'}
        role="region"
        data-testid="simple-scroll"
        onClick={onClick}
        onAuxClick={onAuxClick}
        onInput={onInput}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onPointerOver={showHost}
        onPointerLeave={() => ui.set({ linkHost: '' })}
        onFocus={showHost}
        onBlur={() => ui.set({ linkHost: '' })}
      >
        {railed ? (
          <div className="sv-docs-grid">
            {page}
            <ArticleRail heads={heads} scroller={getScroller} />
          </div>
        ) : (
          page
        )}
      </div>
      {menu && <LinkMenu at={menu} url={menu.url} onClose={closeMenu} />}
      {(view.busy || (view.stale && view.status.kind === 'waiting')) && <div className="sv-progress" role="progressbar" aria-label="Loading" data-testid="simple-progress" />}
      {chip && (
        <IslandChip
          b={chip}
          host={domain}
          controller={controller}
          onBack={() => {
            // Back to the video moves the focus there too; under reduced motion it jumps (the spec's section 12).
            const el = scroller.current?.querySelector<HTMLElement>(`[data-island="${CSS.escape(chip.key)}"]`);
            const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            el?.scrollIntoView({ block: 'center', behavior: still ? 'instant' : 'smooth' });
            el?.focus({ preventScroll: true });
          }}
        />
      )}
    </Page.Provider>
  );
}

/**
 * The view's styles are a file of their own, fetched as the chunk arrives and never for a member whose flag is off (the
 * app's one stylesheet stays as it was). A failed load rejects, like a failed chunk, and the window steps aside to the real
 * page (`SimpleUnavailable` in `BrowserApp.tsx`).
 */
let sheet: Promise<void> | undefined;
function loadSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = simpleCssUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      sheet = undefined;
      reject(new Error('The simplified view stylesheet did not load'));
    };
    document.head.appendChild(link);
  });
  return sheet;
}

/** This chunk, once its stylesheet has loaded: what the Browser window's lazy import waits for. */
export const ready = (): Promise<{ default: typeof SimpleLayer }> => loadSheet().then(() => ({ default: SimpleLayer }));

export default function SimpleLayer({ deskId, link, driver, ui, tabs, source }: SimpleLayerProps) {
  const [controller] = useState(() => new SimpleController(ui, driver, source ?? linkSource(link), link));
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const covering = useSyncExternalStore(ui.subscribe, () => ui.get().covering);

  useLayoutEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  useLayoutEffect(() => controller.setTabs(tabs), [controller, tabs]);

  if (!covering) return null;
  return (
    <div className={`sv${view.decision.view === 'full' ? ' leaving' : ''}`} data-testid="simple-view" data-view={view.decision.view}>
      <SimplePage view={view} controller={controller} driver={driver} deskId={deskId} ui={ui} />
    </div>
  );
}
