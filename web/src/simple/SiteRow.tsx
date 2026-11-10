// The site row (the Product Designer's spec, section 4): who you're reading, the site's few essential actions, and what
// was hidden. The only thing before the content. Everything here is the site's own words, as text (T47-6).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { hiddenTotal, rowSlots, type Block, type Hidden, type HiddenKind, type Inline, type MenuGroup, type PageMeta, type SiteAction } from './mdoc';
import { DeskImage, Run, Runs, usePage } from './blocks';

type BarBlock = Extract<Block, { t: 'bar' }>;

const ICONS = {
  search: <path d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.25 15.25 20 20" />,
  sections: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  signin: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20a7.5 7.5 0 0 1 15 0" />,
  cart: <path d="M6.5 8.5h11l-1 11h-9ZM9 8.5V7a3 3 0 0 1 6 0v1.5" />,
  globe: <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z" />,
  hidden: <path d="M4 4l16 16M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9 6-.3.9-1.4 2.6-3.1 4M6.3 7.8C4.7 9 3.4 10.8 3 12c.6 1.7 4 6 9 6 1.4 0 2.6-.3 3.7-.8M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  ads: <path d="M4.5 10v4h2.5l6 4.5v-13L7 10ZM16.5 9a4 4 0 0 1 0 6M19 7a7 7 0 0 1 0 10" />,
  cookie: <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.6 3 3 0 0 1-3.4-3 3 3 0 0 1-3-3.4A3 3 0 0 1 12 3.5ZM9 10.5h.01M8.5 15h.01M13 14.5h.01" />,
  mail: <path d="M4.5 6.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM4 7.5l8 6 8-6" />,
  popup: <path d="M5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM8.5 9h7M8.5 12.5h5" />,
  recommended: <path d="M12 4 20 8.5 12 13 4 8.5ZM4 12.5l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" />,
  trackers: <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12h.01" />,
  screen: <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM9 20h6M12 16.5V20" />,
} satisfies Record<string, ReactNode>;

function Ic({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="sv-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const ACTION_WORDS: Record<SiteAction['kind'], string> = { search: 'Search', sections: 'Sections', signin: 'Sign in', cart: 'Cart' };

/** A folded group's name, as the site row says it: the distiller's "Site menu" is just Menu here. */
const groupName = (g: MenuGroup): string => (g.name === 'Site menu' ? 'Menu' : g.name);

type Open = { kind: 'search' } | { kind: 'group'; i: number } | null;

/**
 * The popover's rows: every kind section 14's `hidden.counts` has, in one row or another, so the rows always add up to the
 * control's number. A site's suggested rows (`shelves`) are its "Recommended for you" too, and Other comes last (the
 * Designer's brand review). A row shows only when it isn't zero.
 */
const HIDDEN_ROWS: { key: string; kinds: HiddenKind[]; name: string; icon: keyof typeof ICONS }[] = [
  { key: 'ads', kinds: ['ads'], name: 'Ads', icon: 'ads' },
  { key: 'sponsored', kinds: ['sponsored'], name: 'Sponsored', icon: 'ads' },
  { key: 'cookie', kinds: ['cookie'], name: 'Cookie banner', icon: 'cookie' },
  { key: 'newsletter', kinds: ['newsletter'], name: 'Newsletter pop-up', icon: 'mail' },
  { key: 'popup', kinds: ['popup'], name: 'Pop-up', icon: 'popup' },
  { key: 'signin', kinds: ['signin'], name: 'Sign-in prompts', icon: 'popup' },
  { key: 'recommended', kinds: ['recommended', 'shelves'], name: '“Recommended for you”', icon: 'recommended' },
  { key: 'shorts', kinds: ['shorts'], name: 'Shorts', icon: 'recommended' },
  { key: 'other', kinds: ['other'], name: 'Other', icon: 'hidden' },
];
const rowCount = (h: Hidden, kinds: readonly HiddenKind[]): number => kinds.reduce((n, k) => n + h.counts[k], 0);

/**
 * "8 hidden", and its popover: each kind with a count that adds up, trackers apart, the per-site switch, the real page.
 * A site the member turned blocking off for keeps the control with nothing hidden ("Blocking off"), so it can go back on.
 */
function HiddenControl({ hidden, host }: { hidden: Hidden; host: string }) {
  const { controller } = usePage();
  const [open, setOpen] = useState(false);
  const [blocking, setBlocking] = useState(hidden.blocking);
  /** The desk has no switch (a `deskd` before section 14's `browser.adblock.site.set`): never a control that does nothing. */
  const [noSwitch, setNoSwitch] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // A non-modal dialog (the spec's section 12): focus moves into it, Esc gives it back to the control, and tabbing out
  // closes it.
  useEffect(() => {
    if (open) dialog.current?.focus();
  }, [open]);
  const total = hiddenTotal(hidden);
  useEffect(() => setBlocking(hidden.blocking), [hidden.blocking]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  if (!total && hidden.blocking) return null;
  return (
    <span
      ref={box}
      className="sv-hid-box"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          control.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button ref={control} type="button" className={`sv-hid${open ? ' open' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-testid="simple-hidden" onClick={() => setOpen(!open)}>
        <Ic name={total ? 'hidden' : 'ads'} size={15} />
        {total ? (
          <span>
            {total}
            <span className="sv-wordy"> hidden</span>
          </span>
        ) : (
          <span className="sv-wordy">Blocking off</span>
        )}
      </button>
      {open && (
        <div ref={dialog} id={id} className="sv-pop" role="dialog" aria-label="Hidden on this page" tabIndex={-1} data-testid="simple-hidden-popover">
          {/* Nothing hidden (blocking off on this site): no empty list, just the switch and the real page. */}
          {(total > 0 || hidden.trackers > 0) && (
            <>
              <h3>Hidden on this page</h3>
              <ul>
                {HIDDEN_ROWS.filter((r) => rowCount(hidden, r.kinds) > 0).map((r) => (
                  <li key={r.key}>
                    <Ic name={r.icon} />
                    <span className="sv-pop-lt">
                      {r.name}
                      {/* What the desk pressed, by the banner's own label (section 14's `done.label`), as text. */}
                      {r.key === 'cookie' && hidden.cookie === 'rejected' && <span className="sv-pop-sub">Answered &ldquo;{hidden.cookieLabel || 'Reject all'}&rdquo; for you</span>}
                    </span>
                    <span className="sv-pop-n">{rowCount(hidden, r.kinds)}</span>
                  </li>
                ))}
              </ul>
              {hidden.trackers > 0 && (
                <p className="sv-pop-also">
                  <Ic name="trackers" />
                  Also blocked: {hidden.trackers} trackers
                </p>
              )}
              <hr />
            </>
          )}
          {/* ADR 0073's per-site switch (section 14's `browser.adblock.site.set`): the desk keeps the site's choice, and
              the page loads again under it, so the counts above follow. */}
          {!noSwitch && (
            <div className="sv-pop-row">
              <span className="sv-pop-lt">
                Block ads and trackers
                <span className="sv-pop-sub">On {host}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={blocking}
                aria-label="Block ads and trackers"
                className="sv-tog"
                data-testid="simple-blocking"
                onClick={() => {
                  const next = !blocking;
                  setBlocking(next);
                  void controller.source.blocking(host, next).catch((err: unknown) => {
                    setBlocking(!next);
                    if ((err as { code?: unknown } | null)?.code === 'not_found') setNoSwitch(true);
                  });
                }}
              />
            </div>
          )}
          <div className="sv-pop-foot">
            <button type="button" className="sv-btn sv-btn-wide" onClick={controller.showFull}>
              <Ic name="screen" size={17} />
              Show the real page
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * On a search page the field is the page (the Designer's brand review): it shows under the row, open, with a clear ×, and
 * Enter searches. No second Search button, and no Search in the row.
 */
function SearchField({ fields }: { fields: Inline[] }) {
  const { controller } = usePage();
  const box = useRef<HTMLDivElement>(null);
  const field = fields.find((r): r is Extract<Inline, { t: 'field' }> => r.t === 'field' && r.kind === 'line');
  if (!field) return null;
  return (
    <div ref={box} className="sv-site-panel sv-site-search sv-search-page" role="search">
      <span className="sv-search-box">
        <Run r={field} />
        {field.ref && !field.disabled && (
          <button
            type="button"
            className="sv-search-clear"
            aria-label="Clear"
            onClick={() => {
              const input = box.current?.querySelector<HTMLInputElement>('input.sv-field');
              if (!input || !field.ref) return;
              input.value = '';
              controller.fill(field.ref, '');
              input.focus();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
            </svg>
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The site row. `bar` is the distiller's collapsed chrome: its search field and its folded groups. The site is named by
 * `domain`, its registrable domain from the head's origin, since this row is the office's own chrome and a page can call
 * itself anything (security review T47O-3); the page's own name for itself comes second, quieter, when it differs.
 */
export function SiteRow({ meta, bar, host, domain }: { meta: PageMeta | null; bar: BarBlock | null; host: string; domain: string }) {
  const site = meta?.site ?? null;
  const fields = bar?.fields ?? [];
  const groups = bar?.groups ?? [];
  // On a results page the query is already there: the field is the page, open under the row.
  const searchPage = fields.some((r) => r.t === 'field' && r.kind === 'line' && r.value);
  const [open, setOpen] = useState<Open>(null);
  const id = useId();
  const own = site?.name ?? '';
  const also = own && own.toLowerCase().replace(/\s+/g, '') !== domain.toLowerCase() ? own : '';
  const actions: ReactNode[] = [];
  // A site action: a press on the real page, in the site's own words.
  const press = (a: SiteAction): ReactNode => (
    <button key={a.ref} type="button" className="sv-sact" data-ref={a.ref} aria-label={`${a.label || ACTION_WORDS[a.kind]}${a.kind === 'cart' && a.count ? ` ${a.count}` : ''}`}>
      <Ic name={a.kind} />
      <span className="sv-wordy">{a.label || ACTION_WORDS[a.kind]}</span>
      {a.kind === 'cart' && a.count !== null && a.count > 0 && (
        <>
          {' '}
          <span className="sv-sact-count">{a.count}</span>
        </>
      )}
    </button>
  );
  // Section 4's order, at most three, built from both sources (`rowSlots`).
  const menu = (g: MenuGroup, i: number): ReactNode => {
    const on = open?.kind === 'group' && open.i === i;
    return (
      <button key={`g${i}`} type="button" className={`sv-sact${on ? ' on' : ''}`} data-kind={g.kind} aria-expanded={on} aria-controls={on ? id : undefined} aria-label={groupName(g)} onClick={() => setOpen(on ? null : { kind: 'group', i })}>
        {i === 0 && <Ic name="sections" />}
        <span className={i === 0 ? 'sv-wordy' : undefined}>{groupName(g)}</span>
      </button>
    );
  };
  // A press the row shows isn't repeated in a menu (finding 2): the head's sign-in or cart, as the bar's own already aren't.
  const inRow = new Set<string>();
  for (const slot of rowSlots(site, bar, searchPage)) {
    if (slot.t === 'action') inRow.add(slot.a.ref);
    if (slot.t === 'action') actions.push(press(slot.a));
    else if (slot.t === 'menu') actions.push(menu(groups[slot.i]!, slot.i));
    else {
      const on = open?.kind === 'search';
      actions.push(
        <button key="search" type="button" className={`sv-sact${on ? ' on' : ''}`} aria-expanded={on} aria-controls={on ? id : undefined} aria-label="Search" onClick={() => setOpen(on ? null : { kind: 'search' })}>
          <Ic name="search" />
          <span className="sv-wordy">Search</span>
        </button>,
      );
    }
  }
  const hidden = meta?.hidden ?? null;
  const shown = open?.kind === 'group' ? groups[open.i] : undefined;
  return (
    <nav className="sv-site" aria-label="Site" data-testid="simple-site">
      <div className="sv-site-row">
        <span className="sv-fav">{site?.icon ? <DeskImage img={{ src: site.icon, alt: '', w: 20, h: 20 }} inline fallback={<Ic name="globe" size={18} />} /> : <Ic name="globe" size={18} />}</span>
        <span className="sv-site-name" data-testid="simple-site-name">
          {domain || host}
        </span>
        {also && <span className="sv-site-also">{also}</span>}
        <span className="sv-grow" />
        {actions}
        {hidden && (hiddenTotal(hidden) > 0 || !hidden.blocking) && (
          <>
            <span className="sv-sep" aria-hidden="true" />
            <HiddenControl hidden={hidden} host={domain || host} />
          </>
        )}
      </div>
      {searchPage && <SearchField fields={fields} />}
      {open?.kind === 'search' && fields.length > 0 && (
        <div id={id} className="sv-site-panel sv-site-search">
          <Runs c={fields} />
        </div>
      )}
      {shown && (
        <div id={id} className="sv-site-panel sv-site-list" role="group" aria-label={groupName(shown)}>
          {shown.c.filter((r) => !('ref' in r && typeof r.ref === 'string' && inRow.has(r.ref))).map((r, i) => (
            <span key={i} className="sv-site-item">
              <Run r={r} />
            </span>
          ))}
        </div>
      )}
    </nav>
  );
}

type FiltersBlock = Extract<Block, { t: 'filters' }>;

/**
 * A listing's filter rail as one row under the query (the spec's R10): All filters (N), then the rail's first controls
 * as chips that scroll sideways, then Sort. All filters opens the whole rail, grouped, as the site's real controls.
 * An applied filter is a pressed chip with ×, and a press takes it off on the real page.
 */
export function FilterRow({ f }: { f: FiltersBlock }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="sv-filters" data-testid="simple-filters">
      <div className="sv-filters-row">
        {f.groups.length > 0 && (
          <button type="button" className="sv-fall" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h2M10.5 16.5h9M15.5 5.5v4M8.5 14.5v4" />
            </svg>
            All filters
            {f.count !== null && f.count > 0 && <span className="sv-fall-n">{f.count}</span>}
          </button>
        )}
        <span className="sv-filters-chips">
          {f.chips.map((r, i) => (
            <span key={i} className="sv-fchip">
              <Run r={r} />
            </span>
          ))}
        </span>
        {f.sort && (
          <span className="sv-filters-sort">
            <Run r={f.sort} />
          </span>
        )}
      </div>
      {open && (
        <div id={id} className="sv-filters-all" role="group" aria-label="All filters">
          {f.groups.map((g, i) => (
            <div key={i} className="sv-filters-group">
              {g.name && <h3>{g.name}</h3>}
              <div className="sv-site-list">
                {g.c.map((r, j) => (
                  <span key={j} className="sv-site-item">
                    <Run r={r} />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const FILTER_GROUP = /filter|refine/i;
const SORT = /^sort\b/i;

/**
 * The page's filter row: the distiller's own `filters` block, else one made from the bar's groups named for filtering
 * (distiller v2 names them "Filters"), with a Sort control among them moved to the end. Those groups leave the site row.
 */
export function filtersOf(blocks: readonly Block[], bar: BarBlock | null): { filters: FiltersBlock | null; bar: BarBlock | null } {
  const own = blocks.find((b): b is FiltersBlock => b.t === 'filters');
  if (own || !bar) return { filters: own ?? null, bar };
  const groups = bar.groups.filter((g) => FILTER_GROUP.test(g.name));
  if (!groups.length) return { filters: null, bar };
  const controls = groups.flatMap((g) => g.c).filter((r) => r.t === 'button' || r.t === 'link' || r.t === 'select' || (r.t === 'field' && (r.kind === 'checkbox' || r.kind === 'radio')));
  const sortAt = controls.findIndex((r) => (r.t === 'select' || r.t === 'button') && SORT.test(r.label));
  const filters: FiltersBlock = {
    t: 'filters',
    count: null,
    chips: controls.filter((_, i) => i !== sortAt).slice(0, 6),
    sort: sortAt >= 0 ? (controls[sortAt] as FiltersBlock['sort']) : null,
    groups,
    dialog: false,
  };
  return { filters, bar: { ...bar, groups: bar.groups.filter((g) => !groups.includes(g)) } };
}
