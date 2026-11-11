// The picture quality menu at the end of a streaming app's bar (ADR 0039 section 2, S-83). Two layers, both this desk's
// alone (the owner's rule, `HANDOFF.md` section 4: the account sets a default, a desk overrides it, an app on the desk
// overrides the desk): first the app's own level on this desk, or "Use this desk's level" / "Use my default"; then, on
// its own page under "This desk", the desk's own level for every app on it, or "Use my default". Saved to Platform
// (`store.ts`); against a Platform without the desk layer, the app's level stays in this browser and "This desk" isn't
// offered. A menu button with radio items, after `chrome/DeskMenu.tsx`: arrows, Home and End, Enter or Space, Right
// into "This desk" and Left or Esc back out of it, and Esc gives focus back where it was, the stream included. A
// click away only dismisses, so it never lands on the page underneath.
//
// Under 720 px of bar the Browser folds it into More (#9's spec, section 7): the same menu, opened from the More button,
// starts on a page of its own with "Picture quality" and the level at its end, which turns to the quality pages, with
// Back. Extensions (#11) come into that first page with their own feature.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { openSettings } from '../settings/settingsStore';
import { accountUrl } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { deskLevelFor, deskOverrideFor, deskOwnLevel, LEVEL_INFO, LEVELS, levelFor, levelOnDesk, streams, upTo, type Level } from './levels';
import { useDeskQuality } from './link';
import { setDeskLevel, setDeskOwnLevel, useStreamQuality } from './store';
import { LinkIcon } from '../browser/linkIcons';
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

function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg className="qm-chevron" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={back ? 'm14.5 6-6 6 6 6' : 'm9.5 6 6 6-6 6'} />
    </svg>
  );
}

/** Where focus goes as the menu opens, or as it turns to a page: its chosen item, its last, "This desk", or More's quality row. */
type Opening = 'checked' | 'last' | 'desk-row' | 'more-row';

/** The app's own level on this desk, or the desk's own for every app on it; under More, More's own first page. */
type Page = 'app' | 'desk' | 'more';

/** The menu's way in: its own sliders button, or the Browser's More (under 720 px of bar). */
export type QualityVariant = 'button' | 'more';

function Menu({ app, deskId, variant, notice: showNotice, className }: { app: string; deskId: string; variant: QualityVariant; notice: boolean; className: string }) {
  const more = variant === 'more';
  const top: Page = more ? 'more' : 'app';
  const { doc, layered, notice } = useStreamQuality();
  const reply = useDeskQuality(deskId);
  const config = useSession((s) => s.config);
  const [open, setOpen] = useState<Opening | null>(null);
  const [page, setPage] = useState<Page>(top);
  const [box, setBox] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** What had focus before the menu took it: the stream, if the member was typing into the page. */
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();

  const level = levelOnDesk(doc, deskId, app);
  /** The app's own on this desk, or null when it follows the desk. */
  const own = deskOverrideFor(doc, deskId, app);
  /** The desk's own for every app, or null when it follows the account. */
  const deskOwn = deskOwnLevel(doc, deskId);
  /** What the app follows without its own here: the desk's own, else the account's. */
  const follows = deskLevelFor(doc, deskId, app);
  /** What the desk follows without its own: the account's level for the app. */
  const account = levelFor(doc, app);
  /** Platform keeps a desk's own level (contract 0.3.70); without it, only the app's is offered, in this browser. */
  const deskLayer = layered === true;
  const name = `Picture quality: ${LEVEL_INFO[level].name}`;
  // The desk's own word, only when it isn't streaming what was chosen (stream-quality.md section 3).
  const reason = !reply || reply.level === level ? null
    : reply.raisedByOther ? `Showing ${LEVEL_INFO[reply.level].name} while another device watches this desk.`
    : reply.heldByLimit ? `This desk is held at ${LEVEL_INFO[reply.level].name} for now.`
    : null;
  const accountHref = config && accountUrl(config);

  const close = useCallback((giveBack: boolean): void => {
    setOpen(null);
    setPage(top);
    const to = returnTo.current;
    returnTo.current = null;
    if (giveBack) (to?.isConnected ? to : btnRef.current)?.focus({ preventScroll: true });
  }, [top]);

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
    const target =
      open === 'last' ? items[items.length - 1]
      : open === 'desk-row' ? (menu.querySelector<HTMLElement>('[data-testid="quality-desk-row"]') ?? items[0])
      : open === 'more-row' ? (menu.querySelector<HTMLElement>('[data-testid="more-quality"]') ?? items[0])
      : (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]);
    target?.focus({ preventScroll: true });
  }, [open, page]);

  /** Turns the menu to a page, with focus on its chosen item, or on the row that led there coming back. */
  const turn = (to: Page): void => {
    const from = page;
    setPage(to);
    setOpen(to === 'more' ? 'more-row' : to === 'desk' || from === 'more' ? 'checked' : 'desk-row');
  };

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
    if (page === 'desk') {
      if (to !== deskOwn) setDeskOwnLevel(deskId, to);
    } else if (to !== own) setDeskLevel(deskId, app, to);
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
      case 'ArrowRight':
        if (page === 'app' && (e.target as HTMLElement).dataset['testid'] === 'quality-desk-row') {
          e.preventDefault();
          turn('desk');
        } else if (page === 'more' && (e.target as HTMLElement).dataset['testid'] === 'more-quality') {
          e.preventDefault();
          turn('app');
        }
        break;
      case 'ArrowLeft':
        if (page === 'desk') {
          e.preventDefault();
          turn('app');
        } else if (page === 'app' && more) {
          e.preventDefault();
          turn('more');
        }
        break;
      case 'Escape':
        // The shell's own Esc (leaving the desk) never hears it. On a page further in, back a page first.
        e.preventDefault();
        e.stopPropagation();
        if (page === 'desk') turn('app');
        else if (page === 'app' && more) turn('more');
        else close(true);
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

  /** The page's own choice: the app's on this desk, or the desk's. */
  const chosen = page === 'desk' ? deskOwn : own;
  /** What "not its own" follows on this page, and its words. */
  const unsetName = page === 'desk' || deskOwn === null ? `Use my default (${LEVEL_INFO[page === 'desk' ? account : follows].name})` : `Use this desk's level (${LEVEL_INFO[follows].name})`;

  const item = (to: Level | null) => {
    const key = to ?? 'default';
    const checked = chosen === to;
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
            <span id={`${id}-${key}-n`} className="qm-name">{unsetName}</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {showNotice && <QualityNoticeLine notice={notice} />}
      <div ref={wrapRef} className={`qm-wrap${className ? ` ${className}` : ''}`}>
        <button
          ref={btnRef}
          type="button"
          className={`icon-btn sm qm-btn${open ? ' on' : ''}`}
          aria-label={more ? 'More' : name}
          title={more ? 'More' : name}
          aria-haspopup="menu"
          aria-expanded={!!open}
          aria-controls={open ? `${id}-menu` : undefined}
          data-testid={more ? 'browser-more' : 'quality-button'}
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
          {more ? <LinkIcon name="more" /> : <SlidersIcon />}
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
              aria-label={page === 'more' ? 'More' : page === 'desk' ? 'Picture quality for this desk' : 'Picture quality'}
              aria-describedby={page === 'more' ? undefined : page === 'desk' ? `${id}-desk-note` : reason ? `${id}-note ${id}-reason` : `${id}-note`}
              data-page={page}
              tabIndex={-1}
              style={box}
              data-testid="quality-menu"
              onKeyDown={onMenuKey}
              onBlur={(e) => {
                // Focus gone elsewhere by any way out (Ctrl+L to the address bar, say): nothing to give back.
                if (e.relatedTarget && !wrapRef.current?.contains(e.relatedTarget as Node)) close(false);
              }}
            >
              {page === 'more' ? (
                <button type="button" role="menuitem" className="xm-item" aria-haspopup="menu" aria-label={`Picture quality: ${LEVEL_INFO[level].name}`} data-testid="more-quality" onClick={() => turn('app')}>
                  <SlidersIcon />
                  <span>Picture quality</span>
                  <span className="xm-end">
                    {LEVEL_INFO[level].name}
                    <Chevron />
                  </span>
                </button>
              ) : page === 'desk' ? (
                <>
                  <button type="button" role="menuitem" className="qm-back" data-testid="quality-back" onClick={() => turn('app')}>
                    <Chevron back />
                    <span>Back</span>
                  </button>
                  <p className="qm-title" role="none" aria-hidden="true">This desk</p>
                  {item(null)}
                  <div role="separator" className="qm-sep" />
                  {LEVELS.map(item)}
                  <div role="separator" className="qm-sep" />
                  <p id={`${id}-desk-note`} className="qm-note" role="none">For every app on this desk, unless the app has its own level.</p>
                </>
              ) : (
                <>
                  {more && (
                    <button type="button" role="menuitem" className="qm-back" data-testid="quality-back" onClick={() => turn('more')}>
                      <Chevron back />
                      <span>Back</span>
                    </button>
                  )}
                  <p className="qm-title" role="none" aria-hidden="true">Picture quality</p>
                  {item(null)}
                  <div role="separator" className="qm-sep" />
                  {LEVELS.map(item)}
                  <div role="separator" className="qm-sep" />
                  {deskLayer && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="qm-item qm-desk"
                        aria-haspopup="menu"
                        aria-label={`This desk: ${deskOwn ? LEVEL_INFO[deskOwn].name : 'My default'}`}
                        data-testid="quality-desk-row"
                        onClick={() => turn('desk')}
                      >
                        <span className="qm-text">
                          <span className="qm-row">
                            <span className="qm-name">This desk</span>
                            <span className="qm-data">{deskOwn ? LEVEL_INFO[deskOwn].name : 'My default'}</span>
                          </span>
                        </span>
                        <Chevron />
                      </button>
                      <div role="separator" className="qm-sep" />
                    </>
                  )}
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
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function QualityNoticeLine({ notice }: { notice: string | null }) {
  // There before it has anything to say, so a screen reader hears it arrive.
  return <span className="br-note qm-notice" role="status" title={notice ?? undefined} data-testid="quality-notice">{notice}</span>;
}

/** The menu's notice on its own, where a bar holds the menu twice (the Browser's own button and its More). */
export function QualityNotice() {
  const { notice } = useStreamQuality();
  return <QualityNoticeLine notice={notice} />;
}

/**
 * Nothing for an app that doesn't stream, or outside a desk, since a choice here is a desk's. `notice: false` leaves the
 * notice out, for a bar that shows `QualityNotice` once itself; `className` goes on the menu's wrapper.
 */
export function QualityMenu({ app, deskId, variant = 'button', notice = true, className = '' }: { app: string; deskId: string | undefined; variant?: QualityVariant; notice?: boolean; className?: string }) {
  return streams(app) && deskId !== undefined ? <Menu app={app} deskId={deskId} variant={variant} notice={notice} className={className} /> : null;
}
