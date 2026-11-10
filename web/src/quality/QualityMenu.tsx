// The picture quality menu at the end of a streaming app's bar (ADR 0039 section 2): this desk's own level for the
// app, or the account's ("Use my default"). A choice here is that desk's alone (the owner's rule, `HANDOFF.md`
// section 4), kept in this browser (`store.ts`). A menu button with radio items, after `chrome/DeskMenu.tsx`: arrows,
// Home and End, Enter or Space, and Esc gives focus back where it was, the stream included. A click away only
// dismisses, so it never lands on the page underneath.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { openSettings } from '../settings/settingsStore';
import { accountUrl } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { deskOverrideFor, LEVEL_INFO, LEVELS, levelFor, levelOnDesk, streams, upTo, type Level } from './levels';
import { useDeskQuality } from './link';
import { setDeskLevel, useStreamQuality } from './store';
import './quality.css';

/** Room kept between the menu and the window's edges. */
const EDGE = 8;
const WIDTH = 320;

const ITEMS = '[role="menuitemradio"], [role="menuitem"]';

function SlidersIcon() {
  return (
    <svg className="icon" width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 8h9M17.5 8h2M4.5 16h2M10.5 16h9" />
      <circle cx="15.5" cy="8" r="2" />
      <circle cx="8.5" cy="16" r="2" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="qm-check" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5.5 12.5 4.2 4.2 8.8-9.2" />
    </svg>
  );
}

/** Where focus goes as the menu opens. */
type Opening = 'checked' | 'last';

function Menu({ app, deskId }: { app: string; deskId: string }) {
  const { doc, desks, notice } = useStreamQuality();
  const reply = useDeskQuality(deskId);
  const config = useSession((s) => s.config);
  const [open, setOpen] = useState<Opening | null>(null);
  const [box, setBox] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** What had focus before the menu took it: the stream, if the member was typing into the page. */
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();

  const level = levelOnDesk(doc, desks, deskId, app);
  const own = deskOverrideFor(desks, deskId, app);
  /** What this desk follows without its own: the account's level for the app. */
  const account = levelFor(doc, app);
  const name = `Picture quality: ${LEVEL_INFO[level].name}`;
  // The desk's own word, only when it isn't streaming what was chosen (stream-quality.md section 3).
  const reason = !reply || reply.level === level ? null
    : reply.raisedByOther ? `Showing ${LEVEL_INFO[reply.level].name} while another device watches this desk.`
    : reply.heldByLimit ? `This desk is held at ${LEVEL_INFO[reply.level].name} for now.`
    : null;
  const accountHref = config && accountUrl(config);

  const close = useCallback((giveBack: boolean): void => {
    setOpen(null);
    const to = returnTo.current;
    returnTo.current = null;
    if (giveBack) (to?.isConnected ? to : btnRef.current)?.focus({ preventScroll: true });
  }, []);

  /** `from` had focus before: the stream, typically, which gets it back. Anything outside this window gives the button instead. */
  const openMenu = (how: Opening, from: Element | null): void => {
    const btn = btnRef.current;
    returnTo.current = from instanceof HTMLElement && from !== document.body && btn?.closest('.ma-window')?.contains(from) ? from : btn;
    setOpen(how);
  };

  // Placed inside the window, which clips: as wide as fits, and no taller than the room under the bar, then it scrolls.
  useLayoutEffect(() => {
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!open || !btn || !menu) return;
    const room = (btn.closest('.ma-window') ?? document.documentElement).getBoundingClientRect();
    const at = btn.getBoundingClientRect();
    setBox({ width: Math.min(WIDTH, room.width - 2 * EDGE), maxHeight: Math.max(120, room.bottom - at.bottom - 6 - EDGE) });
    const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)];
    const target = open === 'last' ? items[items.length - 1] : (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]);
    target?.focus({ preventScroll: true });
  }, [open]);

  // A press anywhere this window doesn't cover dismisses and goes on to what it pressed. A resize moves the bar.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    const onResize = (): void => close(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const choose = (to: Level | null): void => {
    close(true);
    if (to !== own) setDeskLevel(deskId, app, to);
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number): void => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1);
        break;
      case 'ArrowUp':
        go(i < 0 ? -1 : i - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(-1);
        break;
      case 'Escape':
        // The shell's own Esc (leaving the desk) never hears it.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        returnTo.current = null;
        close(true);
        break;
      case ' ':
        // A link has no Space of its own.
        if ((e.target as HTMLElement).tagName === 'A') {
          e.preventDefault();
          (e.target as HTMLElement).click();
        }
        break;
      default:
        break;
    }
  };

  const item = (to: Level | null) => {
    const key = to ?? 'default';
    const checked = own === to;
    return (
      <button
        key={key}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className="qm-item"
        aria-labelledby={`${id}-${key}-n`}
        aria-describedby={to ? `${id}-${key}-w ${id}-${key}-d` : undefined}
        data-level={key}
        onClick={() => choose(to)}
      >
        <Check />
        {to ? (
          <span className="qm-text">
            <span className="qm-row">
              <span id={`${id}-${key}-n`} className="qm-name">{LEVEL_INFO[to].name}</span>
              <span id={`${id}-${key}-d`} className="qm-data">{upTo(to)}</span>
            </span>
            <span id={`${id}-${key}-w`} className="qm-words">{LEVEL_INFO[to].words}</span>
          </span>
        ) : (
          <span className="qm-text">
            <span id={`${id}-${key}-n`} className="qm-name">Use my default ({LEVEL_INFO[account].name})</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* There before it has anything to say, so a screen reader hears it arrive. */}
      <span className="br-note qm-notice" role="status" title={notice ?? undefined} data-testid="quality-notice">{notice}</span>
      <div ref={wrapRef} className="qm-wrap">
        <button
          ref={btnRef}
          type="button"
          className={`icon-btn sm qm-btn${open ? ' on' : ''}`}
          aria-label={name}
          title={name}
          aria-haspopup="menu"
          aria-expanded={!!open}
          aria-controls={open ? `${id}-menu` : undefined}
          data-testid="quality-button"
          onPointerDown={() => {
            if (!open) returnTo.current = document.activeElement as HTMLElement | null;
          }}
          onClick={(e) => {
            if (open) close(true);
            // A click from a key (detail 0) gives the button back on Esc; a press gives back what it took focus from.
            else openMenu('checked', e.detail === 0 ? btnRef.current : returnTo.current);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              openMenu(e.key === 'ArrowUp' ? 'last' : 'checked', btnRef.current);
            }
          }}
        >
          <SlidersIcon />
        </button>
        {open && (
          <>
            {/* A click away only dismisses: this takes it, so the page under it never hears of it. */}
            <div
              className="qm-away"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => close(true)}
              onWheel={() => close(false)}
              onContextMenu={(e) => {
                e.preventDefault();
                close(true);
              }}
            />
            <div
              ref={menuRef}
              id={`${id}-menu`}
              className="qm-menu"
              role="menu"
              aria-label="Picture quality"
              aria-describedby={reason ? `${id}-note ${id}-reason` : `${id}-note`}
              tabIndex={-1}
              style={box}
              data-testid="quality-menu"
              onKeyDown={onMenuKey}
              onBlur={(e) => {
                // Focus gone elsewhere by any way out (Ctrl+L to the address bar, say): nothing to give back.
                if (e.relatedTarget && !wrapRef.current?.contains(e.relatedTarget as Node)) close(false);
              }}
            >
              <p className="qm-title" role="none" aria-hidden="true">Picture quality</p>
              {item(null)}
              <div role="separator" className="qm-sep" />
              {LEVELS.map(item)}
              <div role="separator" className="qm-sep" />
              <p id={`${id}-note`} className="qm-note" role="none">Every level is just as smooth and quick.</p>
              {reason && <p id={`${id}-reason`} className="qm-note" role="none" data-testid="quality-reason">{reason}</p>}
              {accountHref && (
                // Account settings, over the office (ADR 0052), as the account menu opens it: never in place of it.
                <button
                  type="button"
                  role="menuitem"
                  className="qm-link"
                  aria-haspopup="dialog"
                  onClick={() => {
                    const to = btnRef.current;
                    close(false);
                    openSettings('account', to);
                  }}
                >
                  Change your default
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Nothing for an app that doesn't stream, or outside a desk, since a choice here is a desk's. */
export function QualityMenu({ app, deskId }: { app: string; deskId: string | undefined }) {
  return streams(app) && deskId !== undefined ? <Menu app={app} deskId={deskId} /> : null;
}
