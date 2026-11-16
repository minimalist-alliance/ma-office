// The account menu's panel (`AccountMenu.tsx` is its button). Never taller than 60 % of the page, at any size (the owner,
// Nov 16: "Vertically, that menu should never extend more than 60% of the page. Configs and options should be tucked in
// expansions or modals."). Its first view is the member and what they reach for: the theme, Account settings, sign out.
// Everything else is one level down, one section open at a time: Appearance (the system-dark choice, the blue and contrast
// sliders with their Reset, the background, the setup circle's switch), Maia (her rows, `maiamode/menu.tsx`, unchanged),
// About this desk (the owner only). Keyboard shortcuts is a modal
// (`ShortcutsDialog.tsx`), the install offer at its foot. A short screen that's wide enough (a phone on its side) lays the
// first view out in two columns, so it fits there too. No "Plain background" and nothing of the office tour (the owner,
// Nov 13): the tour lives in the logo's menu only. When what's open makes it scroll, the member's header stays pinned at the
// top and the scroll lands on whole lines, so nothing at the top is ever cut mid-line; a short screen's two columns are each
// sticky, so only the one with a section open scrolls. Sign out is one plain row at the foot, past the divider, as the rows
// above it are (the owner, Nov 16, on 6.10's split button: "This is weird and unnecessary. Just let me sign out"; release
// 6.11): one press signs out. Sign out everywhere is the account's own, in Account settings (the Platform app's Account
// menu). It's glass, as the office's other menus (release 6.10, `office-glass.md`): a plate,
// `.account-glass`, wears the recipe and holds the menu, which scrolls inside it, since a glass element never scrolls.
// Shut, it draws nothing, so it's in the top bar's popovers chunk (`popoversChunk.ts`), fetched once the page is idle.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import type { Me } from '../platform/api';
import type { BadgeId } from '../platform/tiers';
import { refreshDeskStatus, useAbout, useLive } from '../desk/liveStore';
import { formatUptime, reducedMotion } from '../lib/util';
import { accountUrl, billingUrl, reportUrl } from '../platform/clientConfig';
import { PAY_NOW, UPDATE_CARD, menuNoteOf } from '../platform/billingNote';
import { isAccountClosed, useAccountClosed } from '../platform/accountClosed';
import { signOut, useSession } from '../platform/session';
import { openSettings } from '../settings/settingsStore';
import { useViewStore } from '../state/viewStore';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import type { ThemeMode } from '../theme/resolve';
import { setThemePref, useTheme } from '../theme/themeStore';
import { THEME_IDS, THEME_LABELS } from '../theme/tokens';
import type { SetupMenuPart } from '../setup/door';
import { aboutOpen, keepAboutOpen } from './aboutOpen';
import { Avatar } from './Avatar';
import { builtRecipeOf, pictureOf } from './avatar';
import { Icon } from './icons';
import { Segmented, Switch } from './Segmented';
import { MaiaModeRows } from '../maiamode/menu';
import { allowedFor, currentPrefs, isOn } from '../maiamode/prefs';
import { ShortcutsDialog } from './ShortcutsDialog';
import { ThemeSliders, ThemeTuneReset } from './ThemeSliders';

declare const __MA_VERSION__: string;

// "Background" (ADR 0094): its own chunk beside the layer's, fetched when Appearance opens. Nothing shows until it's here.
const BackgroundPicker = lazy(() => import('./BackgroundPicker').then((m) => ({ default: m.BackgroundPicker })));

// The themes' names come from `THEME_LABELS`, the one place they live (the `dusk` id reads "Zen").
const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  ...THEME_IDS.map((id) => ({ value: id, label: THEME_LABELS[id] })),
];

/** The menu's tucked sections. One is open at a time, so opening one never makes the menu scroll for the last. */
type Section = 'appearance' | 'maia' | 'about';

/** What the cut check counts as one line: a control, never looked inside, or an element with nothing inside it. */
const LINE = 'button, a, input, select, textarea, [role="radiogroup"], [role="switch"], [role="slider"]';

/** Every line in the menu but the member's header, which is pinned. */
function linesOf(menu: HTMLElement, head: Element | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (c === head || !(c instanceof HTMLElement)) continue;
      if (c.matches(LINE) || c.childElementCount === 0) out.push(c);
      else walk(c);
    }
  };
  walk(menu);
  return out;
}

/** The column a section's row is in, which takes any room `landing` adds at its foot; one column: the menu's last part. */
function roomFor(menu: HTMLElement, row: HTMLElement): HTMLElement | null {
  const col = row.closest<HTMLElement>('.acct-left, .acct-account');
  return col && getComputedStyle(col).display !== 'contents' ? col : menu.querySelector<HTMLElement>('.acct-account');
}

/**
 * Where the menu's scroll should land for a section that's just opened: no further than its foot needs to come into view,
 * never past its row reaching the top of what shows (the pinned header's foot where the header is above it, else the menu's
 * own top edge), and on whole lines, so nothing at the top is cut mid-line: a line the edge would cut goes wholly under it
 * (with room added at the column's foot, `--acct-room`, if the menu ends first), or, if that would take the row, comes back
 * wholly into view. Worked out by trying each place (a short screen's columns are sticky, so only measuring says where
 * things land) and put back before anything paints. Null: no scroll.
 */
function landing(menu: HTMLElement, row: HTMLElement, panel: HTMLElement, room: HTMLElement | null): number | null {
  const start = menu.scrollTop;
  room?.style.removeProperty('--acct-room');
  const base = menu.scrollHeight - menu.clientHeight;
  const head = menu.querySelector<HTMLElement>('.menu-me');
  const at = (s: number): void => {
    menu.scrollTop = s;
  };
  const top = (): number => menu.getBoundingClientRect().top + menu.clientTop;
  const foot = top() + menu.clientHeight - (parseFloat(getComputedStyle(menu).paddingBottom) || 0);
  const over = panel.getBoundingClientRect().bottom + (menu.scrollTop - start) - foot;
  if (base <= 0 || over <= 0.5) {
    at(start);
    return null;
  }
  const lines = linesOf(menu, head);
  // The top of what shows over a line: the pinned header's foot if it's above it, else the menu's edge.
  const clipFor = (r: DOMRect): number => {
    const h = head?.getBoundingClientRect();
    return h && h.height > 0 && r.left < h.right - 0.5 && r.right > h.left + 0.5 ? h.bottom : top();
  };
  const rowWhole = (): boolean => {
    const r = row.getBoundingClientRect();
    return r.top >= clipFor(r) - 0.5;
  };
  at(start);
  let s = Math.min(base, start + over);
  at(s);
  // No further than the row reaching its clip (twice: a sticky column can move under it).
  for (let i = 0; i < 2 && !rowWhole(); i++) {
    const r = row.getBoundingClientRect();
    s = Math.max(0, s - (clipFor(r) - r.top));
    at(s);
  }
  // Then onto whole lines: under the edge if the row stays whole, else back into view. While trying, room enough at the foot.
  room?.style.setProperty('--acct-room', `${menu.clientHeight}px`);
  let back = false;
  for (let i = 0; i < 12; i++) {
    at(s);
    let up = 0;
    let down = 0;
    for (const l of lines) {
      const r = l.getBoundingClientRect();
      if (r.height < 2) continue;
      const clip = clipFor(r);
      if (r.top < clip - 0.5 && r.bottom > clip + 0.5) {
        up = Math.max(up, r.bottom - clip);
        down = Math.max(down, clip - r.top);
      }
    }
    if (!up) break;
    if (!back && room) {
      at(s + up);
      if (rowWhole()) {
        s += up;
        continue;
      }
    }
    back = true;
    s = Math.max(0, s - down);
  }
  // Only the room the landing needs stays, while the section is open.
  const need = Math.ceil(s - base);
  if (room) {
    if (need > 0) room.style.setProperty('--acct-room', `${need}px`);
    else room.style.removeProperty('--acct-room');
  }
  at(start);
  return Math.round(s) === Math.round(start) ? null : s;
}

/**
 * Keeps a section's contents in view as it opens: the menu scrolls only as far as needed (`landing`), smoothly, or at once
 * under reduced motion. What arrives after it opens (the sliders' engine, the background's chunk) grows it, so for a moment
 * it follows, until the member scrolls the menu themselves.
 */
function useInView(open: boolean, row: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const p = panel.current;
    const r = row.current;
    const menu = r?.closest<HTMLElement>('.menu');
    if (!open || !p || !r || !menu) return undefined;
    // The glide starts on the next frame: started in the same task as `landing`'s tries, Chromium let it go when it was
    // already gliding (a section that grew as it opened).
    let frame = 0;
    const room = roomFor(menu, r);
    const go = (): void => {
      const to = landing(menu, r, p, room);
      cancelAnimationFrame(frame);
      if (to === null) return;
      if (reducedMotion()) menu.scrollTop = to;
      else frame = requestAnimationFrame(() => menu.scrollTo({ top: to, behavior: 'smooth' }));
    };
    go();
    let follow = true;
    const stop = (): void => {
      follow = false;
    };
    const until = window.setTimeout(stop, 1500);
    let last = p.getBoundingClientRect().height;
    const grew = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const h = p.getBoundingClientRect().height;
      if (!follow || Math.abs(h - last) < 0.5) return;
      last = h;
      go();
    });
    grew?.observe(p);
    const own = ['wheel', 'touchstart', 'keydown'] as const;
    for (const e of own) menu.addEventListener(e, stop, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      room?.style.removeProperty('--acct-room');
      window.clearTimeout(until);
      grew?.disconnect();
      for (const e of own) menu.removeEventListener(e, stop);
    };
  }, [open, row, panel]);
}

/**
 * The menu's size, as `--acct-w` and `--acct-h`, for the pinned header's ground: on glass it's the plate's own body and sheen,
 * sized and placed as the plate's (`.account-glass .menu-me`), so it's opaque and shows no seam.
 */
function usePlateSize(menu: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const m = menu.current;
    if (!m || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => {
      const box = e?.borderBoxSize?.[0];
      m.style.setProperty('--acct-w', `${box ? box.inlineSize : m.offsetWidth}px`);
      m.style.setProperty('--acct-h', `${box ? box.blockSize : m.offsetHeight}px`);
    });
    ro.observe(m);
    return () => ro.disconnect();
  }, [menu]);
}

/**
 * The member's header stays pinned at the menu's top (sticky, in the menu's own ground) while what's open scrolls under it:
 * a hairline at its foot only while something is under it, and the menu's `scroll-padding-top` its height, so the keyboard's
 * focus is never brought into view under it.
 */
function usePinnedHead(menu: RefObject<HTMLElement | null>, head: RefObject<HTMLElement | null>, shown: boolean): void {
  useLayoutEffect(() => {
    const m = menu.current;
    const h = head.current;
    if (!shown || !m || !h) return undefined;
    const next = h.nextElementSibling;
    const mark = (): void => {
      const under = !!next && next.getBoundingClientRect().top < h.getBoundingClientRect().bottom - 0.5;
      if (h.hasAttribute('data-over') !== under) h.toggleAttribute('data-over', under);
    };
    const size = (): void => {
      m.style.setProperty('--acct-head', `${h.offsetHeight}px`);
      mark();
    };
    size();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    ro?.observe(h);
    m.addEventListener('scroll', mark, { passive: true });
    return () => {
      ro?.disconnect();
      m.removeEventListener('scroll', mark);
    };
  }, [menu, head, shown]);
}

/**
 * A section's row and, open, what it holds, right under it: a disclosure (`aria-expanded`, `aria-controls`), the panel a
 * group named by its row. Opening one that runs past the menu's foot scrolls the menu just enough (`useInView`).
 */
function Disclosure({ id, label, state, open, onToggle, testId, children }: {
  id: string;
  label: string;
  /** A word on the row's right while shut or open, such as Maia's "On". */
  state?: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: ReactNode;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useInView(open, row, panel);
  return (
    <>
      <button ref={row} type="button" id={`${id}-row`} className="menu-item menu-disclosure" aria-expanded={open} aria-controls={id} onClick={onToggle} data-testid={testId}>
        <span className="menu-disclosure-label">{label}</span>
        {state && <span className="menu-state">{state}</span>}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      </button>
      {open && (
        <div ref={panel} id={id} className="menu-section" role="group" aria-labelledby={`${id}-row`}>
          {children}
        </div>
      )}
    </>
  );
}

/**
 * "About this desk", for the owner only ("Only me", Nov 9): `roles` from `/v1/me` (contract desks.md). Members see none
 * of it. A disclosure, shut until he opens it ("Let me shrink it though"), remembered in this browser as he leaves it
 * (`aboutOpen.ts`), and the desk's status is only asked for while it's open.
 */
function About({ deskId, open, onToggle }: { deskId: string | null; open: boolean; onToggle: () => void }) {
  return (
    <Disclosure id="about-desk-panel" label="About this desk" open={open} onToggle={onToggle} testId="about-toggle">
      <div className="about-panel">
        {deskId ? <AboutDesk deskId={deskId} /> : <p className="about-line" data-testid="about-desk">No desk yet.</p>}
        <p className="about-line about-version">App {__MA_VERSION__}</p>
      </div>
    </Disclosure>
  );
}

function AboutDesk({ deskId }: { deskId: string }) {
  const live = useLive(deskId);
  const about = useAbout(deskId);
  const s = live.linkAvailable && live.link === 'open' ? about.status : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => refreshDeskStatus(deskId), [deskId]);
  // Uptime ticks here between fetches, and only while this panel is open.
  useEffect(() => {
    if (!s) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [s]);
  const rtt = about.rttMs === null ? null : `${Math.max(1, Math.round(about.rttMs))} ms`;
  if (!s) {
    const lost = live.linkAvailable && (live.link === 'resuming' || live.link === 'retrying');
    if (!lost) return <p className="about-line" data-testid="about-desk">This desk isn't connected yet.</p>;
    const last = [about.path && `Last path ${about.path}`, rtt && `last round trip ${rtt}`].filter(Boolean).join(', ');
    return (
      <p className="about-line" data-testid="about-desk">
        {live.lostForSec >= 30 ? "Can't reach this desk." : 'Reconnecting to this desk.'}{last && ` ${last}.`}
      </p>
    );
  }
  return (
    <dl className="about" data-testid="about-desk">
      <dt>Service</dt><dd>deskd {s.deskdVersion}</dd>
      <dt>Streaming</dt><dd>desk-rtc {s.rtcVersion ?? 'not reported yet'}</dd>
      <dt>Uptime</dt><dd>{formatUptime(s.uptimeSec + Math.max(0, now - about.fetchedAt) / 1000)}</dd>
      <dt>Instance</dt><dd>{s.instanceType ?? 'not reported yet'}</dd>
      <dt>Java</dt><dd>{s.javaVersion}</dd>
      <dt>Desk</dt><dd>{s.deskId ?? deskId}</dd>
      <dt>Boot</dt><dd>{s.bootId}</dd>
      <dt>Connection</dt><dd>{[about.path, rtt].filter(Boolean).join(' · ') || 'measuring…'}</dd>
    </dl>
  );
}

export interface AccountPanelProps {
  me: Me | null;
  who: string | undefined;
  said: string | undefined;
  tierName: string | null | undefined;
  badge: BadgeId | null;
  /** A free member's tier line, the free tier's (`free/door.ts`), read by `AccountMenu` so this chunk doesn't import the door. */
  FreeTier: ComponentType | undefined;
  /** The setup circle's parts (`setup/door.ts`), read by `AccountMenu`: that import's place in the first load keeps the stylesheet's order. */
  SetupMenuSlot: ComponentType<{ part: SetupMenuPart }>;
  /** The menu's own state, which outlives the panel: it's kept by `AccountMenu`, as it was before the panel had a chunk. */
  /** Sign out is on its way ("Signing out…"). */
  leaving: boolean;
  setLeaving: Dispatch<SetStateAction<boolean>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  leave: () => void;
  btnRef: RefObject<HTMLButtonElement | null>;
}

export function AccountPanel({ me, who, said, tierName, badge, FreeTier, SetupMenuSlot, leaving, setLeaving, setOpen, leave, btnRef }: AccountPanelProps) {
  const pref = useTheme((s) => s.pref);
  const config = useSession((s) => s.config);
  const activeDesk = useViewStore((s) => s.activeDesk);
  const account = config && accountUrl(config);
  const report = config && reportUrl(config);
  // Account settings holds the account page and, where export is on, "Your data".
  const settings = !!account || config?.export?.enabled === true;
  const owner = me?.roles?.includes('owner') === true;
  // The billing launch features (still 32, option C2): one quiet line under the tier while the card expires before the next
  // charge, or, first, while a payment has failed. Only while Platform sends it; its link is the billing page, in its own tab.
  // Never for a closed account (`platform/accountClosed.ts`): billing answers it `account_closed`, and nothing is offered.
  const closed = isAccountClosed(me, useAccountClosed((s) => s.heard));
  const note = closed ? null : menuNoteOf(me?.membership, billingUrl(config, me?.membership?.billingUrl));
  // Maia's row, for a member her gate allows, says whether she's on before it's opened.
  const maia = allowedFor(me, config);
  useLayoutPrefs((s) => s['maiaMode']); // renders again when the document's value changes
  const maiaOn = maia && isOn(currentPrefs());

  // One section open at a time. The owner's About opens as he left it; the others start shut every time.
  const [section, setSection] = useState<Section | null>(() => (owner && aboutOpen() ? 'about' : null));
  const toggle = (which: Section): void => {
    const opening = section !== which;
    if (which === 'about') keepAboutOpen(opening);
    setSection(opening ? which : null);
  };
  const menu = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  usePinnedHead(menu, head, !!(me && who));
  usePlateSize(menu);
  const [shortcuts, setShortcuts] = useState(false);
  const shortcutsBtn = useRef<HTMLButtonElement>(null);
  const closeShortcuts = useCallback(() => setShortcuts(false), []);

  return (
    // The glass plate (`styles/app.css`, "the office's chrome in glass"): the menu's place, size, edge and light. The menu is
    // the scroller inside it, as it was before the glass.
    <div className="account-glass ma-glass">
      <div ref={menu} className="menu account-menu" id="account-panel" role="dialog" aria-label="Account">
        {/* The member and their choices: no box of its own in one column, so the header is pinned over the whole menu; a short
            screen's left column, sticky like the right. */}
        <div className="acct-left">
          {me && who && (
            <div ref={head} className="menu-me">
              <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={40} picture={pictureOf(me)} built={builtRecipeOf(me)} title={said ?? undefined} />
              <div className="menu-me-text">
                <p className="menu-who">{who}</p>
                {tierName ? <p className="menu-tier" data-testid="menu-tier">{tierName}</p> : FreeTier && <FreeTier />}
                {note && (
                  <p className={`menu-note${note.kind === 'payment' ? ' menu-note-failed' : ''}`} data-testid="menu-billing-note">
                    {note.text}{' '}
                    <a href={note.link} target="_blank" rel="noopener noreferrer" aria-description="Opens in a new tab" onClick={leave}>
                      {note.kind === 'payment' ? PAY_NOW : UPDATE_CARD}
                    </a>
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="acct-prefs">
            <div className="menu-theme">
              <p className="menu-label" id="theme-label">Theme</p>
              <Segmented label="Theme" options={THEME_OPTIONS} value={pref.mode} onChange={(mode) => setThemePref({ mode })} className="theme-switch" />
            </div>
            <Disclosure id="menu-appearance" label="Appearance" open={section === 'appearance'} onToggle={() => toggle('appearance')} testId="menu-appearance">
              {pref.mode === 'system' && (
                <Switch
                  id="pref-system-dusk"
                  label={`Use ${THEME_LABELS.dusk} when the system is dark`}
                  checked={pref.systemDark === 'dusk'}
                  onChange={(v) => setThemePref({ systemDark: v ? 'dusk' : 'dark' })}
                />
              )}
              {/* The theme's two sliders (the owner, Nov 14), for every theme: how blue its greys are, and its contrast. "Reset" on
                  their label's line, so nothing below it moves when it comes. */}
              <div className="menu-label-row">
                <p className="menu-label">Blue and contrast</p>
                <ThemeTuneReset />
              </div>
              <ThemeSliders />
              <Suspense fallback={null}>
                <BackgroundPicker />
              </Suspense>
              {/* The setup circle's switch, on by default. */}
              <SetupMenuSlot part="switch" />
            </Disclosure>
            {/* Maia Mode (CONCEPT.md §2): her switch and rows, apart from the themes, for a member the gate allows. */}
            {maia && (
              <Disclosure id="menu-maia" label="Maia" state={maiaOn ? 'On' : 'Off'} open={section === 'maia'} onToggle={() => toggle('maia')} testId="menu-maia">
                <MaiaModeRows close={(back) => (back ? leave() : setOpen(false))} />
              </Disclosure>
            )}
            {/* On a phone too narrow for the setup circle, its row (S-121). */}
            <SetupMenuSlot part="row" />
            <button
              ref={shortcutsBtn}
              type="button"
              className="menu-item"
              aria-haspopup="dialog"
              aria-expanded={shortcuts}
              onClick={() => setShortcuts(true)}
              data-testid="menu-shortcuts"
            >
              Keyboard shortcuts
            </button>
          </div>
        </div>
        <div className="menu-sep acct-sep-cols" />
        <div className="acct-account">
          {owner && <About deskId={activeDesk} open={section === 'about'} onToggle={() => toggle('about')} />}
          {settings && (
            // Over the office, never in place of it: leaving this tab would close the member's windows and anything
            // unsent in them. "Your data" is in there too.
            <button
              type="button"
              className="menu-item"
              aria-haspopup="dialog"
              onClick={() => {
                setOpen(false);
                openSettings(undefined, btnRef.current);
              }}
              data-testid="menu-account-settings"
            >
              Account settings
            </button>
          )}
          {report && (
            // Its own tab, for the same reason. The note is for screen readers only.
            <a className="menu-item" href={report} target="_blank" rel="noopener" aria-description="Opens in a new tab" onClick={leave}>
              Report a safety concern
            </a>
          )}
          {(owner || settings || report) && <div className="menu-sep" />}
          {/* Sign out: one plain row, one press, no confirm (the owner, Nov 16: "Just let me sign out"). */}
          <button
            type="button"
            className="menu-item"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
            data-testid="menu-sign-out"
          >
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        {shortcuts && <ShortcutsDialog onClose={closeShortcuts} back={shortcutsBtn} />}
      </div>
    </div>
  );
}
