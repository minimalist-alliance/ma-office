// The mark (a button with its menu of the Alliance's other pages, `HomeMark`), scope switcher (only with more than one desk,
// design 3.2; folded into one menu button beside the mark, `BarMenus.tsx`, in short-viewport mode and wherever the whole
// switch doesn't fit one row, `useScopeFolds`), privacy shield, full screen, the bell and the account menu. The canvas keeps all pointer input outside these controls. Nothing else goes
// in here: notices, such as a new version, go in the shell's stack above the bottom bar, so these never move for one.
// A closed account (`platform/accountClosed.ts`) has no scope switch and no way home: its desks only wake for the download.
// The bell is the one exception, and it isn't a notice: it holds the member's own notifications (ADR 0125), which
// arrive from every app they use, not the desk's word about itself. So is the held line beside the account menu (the focus
// shield, `maiamode/shield/HeldLine.tsx`), while Desk Maia is on: one still line of what's held, never a notice.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';
import { useIsShort } from '../canvas/phone';
import { useOnDemand } from '../lib/onDemand';
import { useShieldSlot } from '../maiamode/door';
import { goOverview, inScopeDesks, setScope, togglePrivacy } from '../shell/actions';
import { useSession } from '../platform/session';
import { useClosed } from '../platform/useClosed';
import { useDeskStore } from '../state/deskStore';
import { useViewStore, type Scope } from '../state/viewStore';
import { AccountMenu } from './AccountMenu';
import { BarMenu } from './BarMenus';
import { Bell } from './Bell';
import { Icon } from './icons';
import { popovers } from './popoversChunk';
import { Segmented } from './Segmented';

const SCOPE_LABELS: Record<Scope, string> = { personal: 'Personal', work: 'Work', guild: 'Guild', all: 'All' };

/** The brand kit's mark for the active theme (ADR 0060); files are exact copies, never recolored. CSS picks by theme: primary on Light, on-dark on Dark, and on Zen the on-dark mark with a soft blue right ribbon (`ma-mark-zen.svg`, the owner OK'd it on Nov 11, ADR 0066 and 0093). */
function Mark() {
  return (
    <>
      <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
      <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
      <img className="home-mark-img on-zen" src={markZen} alt="" width={45} height={28} />
    </>
  );
}

/**
 * The mark, always a button for a signed-in member, and its menu of the Alliance's other pages (the Product Designer's mark
 * menu spec, Nov 12, from the owner's ask). With a mouse or pen, resting on it for 120 ms opens the menu, and a click shows
 * all desks wherever there's an overview to go to (`home`, the old mark's test), else toggles the menu pinned; a tap, Enter
 * or Space toggles it pinned, and "All desks" is then its first row. Focus alone never opens it. Only this is in the first
 * load: the menu itself (`MarkPanel.tsx`: its rows, the hover close, the keys, the exit) is the popovers chunk's, fetched at
 * idle, or as the pointer or the keyboard reaches the mark. `open`: 0 shut, 1 opened by hover, 2 pinned, 3 closing (the
 * panel plays the exit, then sets 0). Client-config's `markMenu: {enabled: false}` is its kill switch: the mark as it was.
 * `data-home` marks the button while a click goes home, for the fleet's `office.home` (`public/fleet-map.json`).
 */
function HomeMark({ home }: { home: boolean }) {
  const on = useSession((s) => s.config?.markMenu?.enabled !== false);
  const [open, setOpen] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  const fine = useRef(false);
  const Panel = useOnDemand(popovers, !!open && 'open')?.MarkPanel;
  const clear = (): void => clearTimeout(timer.current);
  if (!on) {
    return (
      <div className="home-mark">
        <h1>
          {home ? (
            <button type="button" className="home-mark-btn" aria-label="Your office, show all desks" title="All desks" data-home onClick={() => goOverview()}>
              <Mark />
            </button>
          ) : (
            <span role="img" aria-label="Minimalist Alliance">
              <Mark />
            </span>
          )}
        </h1>
      </div>
    );
  }
  return (
    <div
      className="home-mark"
      onPointerEnter={(e) => {
        popovers.prefetch();
        if (e.pointerType !== 'touch') timer.current = window.setTimeout(() => setOpen((o) => o % 3 || 1), 120);
      }}
      onPointerLeave={clear}
    >
      <h1>
        <button
          ref={btn}
          type="button"
          className="home-mark-btn"
          aria-label="Minimalist Alliance"
          aria-expanded={!!(open % 3)}
          aria-controls="mark-menu"
          data-home={home || undefined}
          onFocus={popovers.prefetch}
          onPointerDown={(e) => {
            clear();
            fine.current = e.pointerType !== 'touch';
          }}
          onClick={(e) => {
            // A click with no press of a fine pointer before it (Enter, Space, a screen reader, voice control, a tap) toggles.
            if (fine.current && e.detail && home) {
              setOpen(0);
              goOverview();
            } else setOpen((o) => (o === 2 ? 3 : 2));
            fine.current = false;
          }}
        >
          <Mark />
        </button>
      </h1>
      {!!open && Panel && <Panel btn={btn} open={open} home={home} set={setOpen} />}
    </div>
  );
}

/**
 * Whether the scope switch folds into one menu button, as it does in short-viewport mode: where the whole switch and the
 * buttons on its right don't fit one row beside the mark (at 390 px with two desks the bar took three rows). Measured, not
 * guessed: a hidden copy of the switch (`.scope-ghost`, every label at the chosen one's weight, so a pick never flips it)
 * says how wide it would be, and the bar, its mark and its other buttons say how much room it has; none of those changes
 * size as it folds (`app.css`), so it can't flip back and forth. Decided before the first paint and before the paint after
 * a resize, a font landing or a change of desks; the bell coming or going (`.top-actions` changes size) decides it again
 * a frame later.
 */
function useScopeFolds(bar: RefObject<HTMLElement | null>, key: string): boolean {
  const [folds, setFolds] = useState(false);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!key || !el) return undefined;
    const decide = (): boolean => {
      const ghost = el.querySelector('.scope-ghost');
      const actions = el.querySelector('.top-actions');
      const mark = el.querySelector('.home-mark');
      if (!ghost || !actions || !mark) return false;
      const s = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      const gap = parseFloat(getComputedStyle(actions).columnGap) || 0;
      const m = getComputedStyle(mark);
      let need = mark.getBoundingClientRect().width + parseFloat(m.marginLeft) + parseFloat(m.marginRight) + (parseFloat(s.columnGap) || 0) + ghost.getBoundingClientRect().width;
      for (const c of actions.children) if (!c.classList.contains('scope')) need += gap + c.getBoundingClientRect().width;
      return need > room - 0.5;
    };
    const now = (): void => flushSync(() => setFolds(decide()));
    const later = (): void => setFolds(decide());
    setFolds(decide());
    window.addEventListener('resize', now);
    document.fonts?.addEventListener('loadingdone', now);
    const watch = new ResizeObserver(later);
    const actions = el.querySelector('.top-actions');
    if (actions) watch.observe(actions);
    return () => {
      window.removeEventListener('resize', now);
      document.fonts?.removeEventListener('loadingdone', now);
      watch.disconnect();
    };
  }, [bar, key]);
  return folds;
}

export function TopBar({ onNotice }: { onNotice: (text: string) => void }) {
  const desks = useDeskStore((s) => s.desks);
  const scope = useViewStore((s) => s.scope);
  const mode = useViewStore((s) => s.mode);
  const shield = useViewStore((s) => s.privacyShield);
  const [isFs, setIsFs] = useState(() => !!document.fullscreenElement);
  const short = useIsShort();
  const closed = useClosed();
  const bar = useRef<HTMLElement>(null);
  // What's held for the member (the focus shield, `maiamode/shield/`): only while Desk Maia is on and its chunk is here.
  const HeldLine = useShieldSlot((s) => s.Line);

  useEffect(() => {
    const on = (): void => {
      setIsFs(!!document.fullscreenElement);
      // The habit keys stay in the office while it's full screen (`shell/keyLock.ts`), in a chunk of its own.
      void import('../shell/keyLock').then((m) => m.followFullscreen(), () => undefined);
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      onNotice('Full screen is not available here.');
    }
  };

  const canGoHome = !closed && mode !== 'overview' && inScopeDesks().length > 1;
  const scoped = !closed && desks.length > 1;
  const scopes = (['personal', 'work', 'guild'] as const).filter((k) => desks.some((d) => d.kind === k));
  const options = [...scopes.map((value) => ({ value, label: SCOPE_LABELS[value] })), { value: 'all' as const, label: SCOPE_LABELS.all }];
  const tight = useScopeFolds(bar, scoped ? `${scopes.join()}|${short}` : '');
  const folded = scoped && (short || tight);

  return (
    <header ref={bar} className={`topbar${scoped ? ' has-scope' : ''}${folded ? ' folded' : ''}`}>
      <HomeMark home={canGoHome} />
      {folded && (
        <BarMenu panel="ScopeList" options={options} value={scope}>
          <span className="sr-only">Scope: </span>
          <span className="chip-text">{SCOPE_LABELS[scope]}</span>
          <Icon name="chevronDown" size={16} />
        </BarMenu>
      )}
      <div className="top-actions">
        {scoped && !folded && <Segmented label="Scope" options={options} value={scope} onChange={setScope} className="scope ma-glass" />}
        <button
          type="button"
          className={`icon-btn chrome ma-glass${shield ? ' on' : ''}`}
          aria-pressed={shield}
          aria-label="Privacy shield"
          title="Privacy shield ( \ )"
          onClick={togglePrivacy}
        >
          <Icon name={shield ? 'shieldOn' : 'shield'} />
        </button>
        <button
          type="button"
          className="icon-btn chrome ma-glass"
          aria-label={isFs ? 'Exit full screen' : 'Full screen'}
          title={isFs ? 'Exit full screen' : 'Full screen'}
          onClick={() => void toggleFullscreen()}
        >
          <Icon name={isFs ? 'exitFullscreen' : 'fullscreen'} />
        </button>
        <Bell />
        {HeldLine && !closed && <HeldLine />}
        <AccountMenu />
      </div>
      {scoped && (
        <div className="segmented scope scope-ghost" aria-hidden="true">
          {options.map((o) => <span key={o.value}>{o.label}</span>)}
        </div>
      )}
    </header>
  );
}
