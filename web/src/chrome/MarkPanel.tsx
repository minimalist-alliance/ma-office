// The mark's menu: the way from the office to the Alliance's other pages (the owner's ask, Nov 12: "navigate to forums,
// help, privacy, and other non-office pages"; the Product Designer's mark menu spec, concept 1). The mark's button and its
// open state are `TopBar.tsx`'s `HomeMark`, the first load's only part; this, in the popovers chunk, is the rest: the rows
// and their links, the hover close, the pin, the keys, a press outside and the exit. It's a disclosure that shows a `nav`
// of plain links, never `role="menu"`: they're ways to other sites, so they keep a link's semantics (open in a new tab,
// copy link) and the screen reader's browse mode. Every link opens a new tab, since leaving the office's tab would close
// the member's windows and anything unsent in them. Its look and motion are `markMenu.css`.
import { Fragment, useEffect, useRef, type CSSProperties, type Dispatch, type MouseEvent, type RefObject, type SetStateAction } from 'react';
import { accountUrl, billingUrl, type ClientConfig } from '../platform/clientConfig';
import { siblingUrl } from '../platform/hosts';
import { useSession } from '../platform/session';
import { useClosed } from '../platform/useClosed';
import { goOverview } from '../shell/actions';
import { ownDesk, prefetchTour, startTour, tourOn } from '../tour/door';
import { startWelcome, useWelcomeDoor } from '../welcome/store';
import { welcomeOn } from '../welcome/seams';
import { useDeskStore } from '../state/deskStore';
import './markMenu.css';

/** One row: a page of the Alliance's (`href`), or an in-office action (`href` null, `act`): "All desks", its way home, or "Take the tour". */
export interface MarkRow {
  label: string;
  href: string | null;
  act?: 'home' | 'tour' | 'welcome';
}

/** A group of rows, with its name for a screen reader; the policies are one footer line (`foot`). */
export interface MarkGroup {
  name: string | null;
  rows: MarkRow[];
  foot?: true;
}

/**
 * `raw` as a URL if it's a page on this site's apex (`minimalistalliance.com`, or `staging.minimalistalliance.com` on
 * staging): https, no port, no credentials. `siblingUrl` refuses the apex by design, and takes exactly one label in front
 * of the site, so a made-up `a.<host>` passes it only when `<host>` is the site itself. Here, not in `hosts.ts`, so the
 * first load doesn't grow.
 */
export function apexUrl(raw: unknown, hostname: string): URL | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return siblingUrl(`https://a.${url.hostname}/`, hostname) ? url : null;
}

/** A link from client-config this menu may show: a page on another host of this site, or on its apex. Never a guess. */
const good = (raw: unknown, hostname: string): string | null => (siblingUrl(raw, hostname) ?? apexUrl(raw, hostname))?.href ?? null;

/**
 * The menu's rows, in order, and only the groups that have one: All desks (only where `home`) and Take the tour (only where
 * `tour`: the office tour is on for this member, ADR 0056); Forums and Help; Account
 * and Billing; Privacy, Terms and Guidelines. A link that isn't good gets no row. Until Platform sends `links.help` and the
 * policies' own keys, Help is `links.support` (the Contact page) and the policies are those paths on its origin, but only
 * where it's this site's apex. A closed account has Help and the policies only: no way home, no billing.
 */
export function markGroups(cfg: ClientConfig | null, { home, closed, billingFromMe, tour = false, welcome = false }: { home: boolean; closed: boolean; billingFromMe?: string | null | undefined; tour?: boolean; welcome?: boolean }, hostname: string = window.location.hostname): MarkGroup[] {
  const links = cfg?.links ?? {};
  const support = apexUrl(links['support'], hostname);
  const policy = (key: string): string | null => good(links[key], hostname) ?? (support ? new URL(`/${key}`, support).href : null);
  const rows = (pairs: [string, string | null | false][]): MarkRow[] => pairs.flatMap(([label, href]) => (href ? [{ label, href }] : []));
  const groups: MarkGroup[] = [
    {
      name: null,
      rows: closed
        ? []
        : [
            ...(home ? [{ label: 'All desks', href: null, act: 'home' as const }] : []),
            ...(tour ? [{ label: 'Take the tour', href: null, act: 'tour' as const }] : []),
            // Maia's welcome again, any time (welcome CONCEPT.md §12.7): a redo at Q1 with the threshold skipped.
            ...(welcome ? [{ label: 'Set up my office with Maia', href: null, act: 'welcome' as const }] : []),
          ],
    },
    { name: 'Community', rows: rows([['Forums', !closed && good(links['forums'], hostname)], ['Help', good(links['help'], hostname) ?? support?.href ?? null]]) },
    { name: 'Your account', rows: closed ? [] : rows([['Account', !!cfg && accountUrl(cfg, hostname)], ['Billing', billingUrl(cfg, billingFromMe, hostname)]]) },
    { name: 'Policies', foot: true, rows: rows([['Privacy', policy('privacy')], ['Terms', policy('terms')], ['Guidelines', policy('guidelines')]]) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** Each row's place in reading order, for its stagger (`--i`); a separator takes the row above it's, the footer is one row. */
const at = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties;

export interface MarkPanelProps {
  btn: RefObject<HTMLButtonElement | null>;
  /** 1 opened by hover, 2 pinned, 3 closing. */
  open: number;
  home: boolean;
  set: Dispatch<SetStateAction<number>>;
}

export function MarkPanel({ btn, open, home, set }: MarkPanelProps) {
  const config = useSession((s) => s.config);
  const billingFromMe = useSession((s) => s.me?.membership?.billingUrl);
  const closed = useClosed();
  // The office tour (ADR 0056): its row wherever the tour is on for this member, and its chunk fetched as the menu opens, so
  // the tour starts in the same frame as the choice.
  const hasOwnDesk = useDeskStore((s) => s.desks.some(ownDesk));
  const tour = tourOn(config) && !closed && hasOwnDesk;
  // Maia's welcome again (welcome/door.tsx): on with its kill switch, for a member with a desk of their own, never mid-welcome.
  const welcomeIdle = useWelcomeDoor((s) => s.state !== 'running');
  const welcome = welcomeOn(config) && !closed && hasOwnDesk && welcomeIdle;
  useEffect(() => {
    if (tour) prefetchTour();
  }, [tour]);
  const pop = useRef<HTMLDivElement>(null);
  const now = useRef(open);
  now.current = open;

  useEffect(() => {
    const wrap = btn.current?.closest<HTMLElement>('.home-mark');
    const box = pop.current;
    if (!wrap || !box) return undefined;
    // One popover at a time: an open account, bell or scope menu is shut by its own button, as the member would. (Their own
    // press outside shuts this one.)
    for (const other of document.querySelectorAll<HTMLElement>('.topbar .menu-wrap > button[aria-expanded="true"]')) other.click();
    // Opened by hover, but the chunk came after the pointer had gone: it shuts at once.
    if (now.current === 1 && !wrap.matches(':hover')) set(0);
    let timer = 0;
    const shut = (): void => set((o) => (o ? 3 : 0));
    // Opened by hover, it shuts 300 ms after the pointer leaves the mark, the panel and the bridge between them; coming back
    // keeps it. Pinned, it stays.
    const leave = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return;
      clearTimeout(timer);
      timer = window.setTimeout(() => set((o) => (o === 1 ? 3 : o)), 300);
    };
    const enter = (): void => clearTimeout(timer);
    // A press in the panel, or the keyboard entering it, pins it open.
    const pin = (e: Event): void => {
      if (box.contains(e.target as Node)) set((o) => (o === 1 ? 2 : o));
    };
    // A press outside (or a click there, which is how the keyboard presses another button) shuts it and leaves focus alone.
    const away = (e: Event): void => {
      if (!wrap.contains(e.target as Node)) shut();
    };
    const out = (e: FocusEvent): void => {
      if (e.relatedTarget && !wrap.contains(e.relatedTarget as Node)) shut();
    };
    // On the document, so Esc reaches it wherever the keyboard is while it's open, before the office's own Esc (show all
    // desks) on the window, which never hears it. From inside, the keyboard goes back to the mark.
    const keys = (e: KeyboardEvent): void => {
      const inside = wrap.contains(document.activeElement);
      if (now.current === 3 || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        shut();
        if (inside) btn.current?.focus();
        return;
      }
      if (!inside) return;
      // Up and Down through every link in reading order, the footer's included, with no wrap; Home and End; Down from the mark.
      const items = Array.from(box.querySelectorAll<HTMLElement>('a[href], button'));
      const i = items.indexOf(document.activeElement as HTMLElement);
      const last = items.length - 1;
      const to = i < 0 ? (e.key === 'ArrowDown' ? 0 : null) : e.key === 'ArrowDown' ? Math.min(i + 1, last) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
      if (to === null) return;
      e.preventDefault();
      items[to]?.focus();
    };
    wrap.addEventListener('pointerleave', leave);
    wrap.addEventListener('pointerenter', enter);
    wrap.addEventListener('pointerdown', pin);
    wrap.addEventListener('focusin', pin);
    wrap.addEventListener('focusout', out);
    document.addEventListener('keydown', keys);
    document.addEventListener('pointerdown', away);
    document.addEventListener('click', away);
    return () => {
      clearTimeout(timer);
      wrap.removeEventListener('pointerleave', leave);
      wrap.removeEventListener('pointerenter', enter);
      wrap.removeEventListener('pointerdown', pin);
      wrap.removeEventListener('focusin', pin);
      wrap.removeEventListener('focusout', out);
      document.removeEventListener('keydown', keys);
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('click', away);
    };
  }, [btn, set]);

  // The exit: the rows fade and the surface folds back into the mark (`.shut`), then it's gone. At once under reduced motion.
  useEffect(() => {
    if (open !== 3) return undefined;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      set(0);
      return undefined;
    }
    const t = window.setTimeout(() => set((o) => (o === 3 ? 0 : o)), 160);
    return () => clearTimeout(t);
  }, [open, set]);

  // Choosing a row shuts it at once; from the keyboard, the keyboard goes back to the mark (All desks leaves it wherever
  // the overview puts it).
  const chose = (e: MouseEvent): void => {
    if (!e.detail) btn.current?.focus();
    set(0);
  };

  let i = -1;
  return (
    <div ref={pop} className={open === 3 ? 'mark-pop shut' : 'mark-pop'}>
      <span className="mark-surface ma-glass" aria-hidden="true" />
      <nav id="mark-menu" className="mark-menu" aria-label="Minimalist Alliance">
        {markGroups(config, { home, closed, billingFromMe, tour, welcome }).map((g, n) => {
          const above = i;
          const rows = g.rows.map((r) => (
            <li key={r.label} style={at(g.foot ? above + 1 : ++i)}>
              {r.href === null ? (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    // Both shut the menu at once, with no exit motion. The tour starts now, whatever the setting, and gives
                    // focus back to the mark at its end.
                    set(0);
                    if (r.act === 'tour') startTour(btn.current);
                    else if (r.act === 'welcome') startWelcome();
                    else goOverview();
                  }}
                >
                  {r.label}
                </button>
              ) : (
                <a className={g.foot ? undefined : 'menu-item'} href={r.href} target="_blank" rel="noopener" aria-description="Opens in a new tab" onClick={chose}>
                  {r.label}
                </a>
              )}
            </li>
          ));
          if (g.foot) i += 1;
          return (
            <Fragment key={g.name ?? 'home'}>
              {n > 0 && <div className="menu-sep" style={at(above)} />}
              <ul aria-label={g.name ?? undefined} className={g.foot ? 'mark-foot' : undefined}>
                {rows}
              </ul>
            </Fragment>
          );
        })}
      </nav>
    </div>
  );
}
