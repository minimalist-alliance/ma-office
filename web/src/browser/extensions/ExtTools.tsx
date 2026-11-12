// The Browser bar's sign-in tools (#11, spec sections 1, 7 and 8): the key, the Extensions menu with its pins, and the
// rows More folds in under 720 px of bar. The menus are the quality menu's look and keys (`.qm-menu`): arrows, Home and
// End move, Esc gives focus back, Tab closes, and a click away only dismisses. Our glyphs only, never an extension's icon;
// names as plain text. In the Browser window's chunk; the panel is its own (`PasswordsPanel.tsx`).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../chrome/icons';
import type { DeskLink } from '../../desk/deskLink';
import { useSession } from '../../platform/session';
import { useLayoutPrefs } from '../../shell/layoutPrefs';
import { setLayoutPref } from '../../shell/layoutSync';
import { LinkIcon } from '../linkIcons';
import { firstPin, keyExtension, keyName, pinned, pinsFor, PINS_PREF, SignIns, signInsOn, withDeskPins, type DeskExtension, type SignInsView } from './signIns';
import './extensions.css';

/** Where the panel opens: at its top, or at the list of managers to add ("Add a password manager"). */
export type PanelAt = 'top' | 'add';

/** Everything the bar, More and the panel share, for one Browser window. */
export interface SignInsUi {
  store: SignIns;
  view: SignInsView;
  pins: string[] | null;
  key: DeskExtension | null;
  installed: DeskExtension[];
  /** One on the allowlist isn't installed, so "Add a password manager" is offered. */
  canAdd: boolean;
  panel: PanelAt | null;
  openPanel(at: PanelAt): void;
  /** `giveBack`: focus goes to the key, as Esc and ✕ do. */
  closePanel(giveBack: boolean): void;
  togglePin(id: string, on: boolean): void;
  /** A manager's page on the desk (spec section 8). From the key it toggles; from a menu row it comes to the front. */
  openExtension(id: string): void;
  keyRef: RefObject<HTMLButtonElement | null>;
}

/**
 * `platform/age.ts` `ageBandOf`'s rule, read here so the Browser's chunk doesn't split that module out of the first load:
 * no band is as today, `adult` is an adult, and anything else is read the careful way, as a teen.
 */
const teen = (band: unknown): boolean => band !== undefined && band !== null && band !== 'adult';

export const MENU_NOTE = 'Only extensions on our list can be added here. Each one can read and change the pages you open on this desk.';

/**
 * One window's sign-ins, or null while none of it may show: the kill switch, a teen (their desk's policy blocks every
 * extension, and the spec gives them none of #11), a desk that doesn't answer `browser.extensions.list`, or no session.
 */
export function useSignInsUi(deskId: string, link: DeskLink | null, connected: boolean, tabs: unknown, picture: boolean): SignInsUi | null {
  const [store] = useState(() => new SignIns());
  const allowed = useSession((s) => signInsOn(s.config) && !teen(s.me?.membership?.ageBand));
  const view = useSyncExternalStore(store.subscribe, store.get);
  const rawPins = useLayoutPrefs((s) => s[PINS_PREF]);
  const pins = useMemo(() => pinsFor(rawPins, deskId), [rawPins, deskId]);
  const [panel, setPanel] = useState<PanelAt | null>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => store.dispose(), [store]);
  useLayoutEffect(() => store.setLink(allowed ? link : null), [store, allowed, link]);
  // A new session asks at once; each change of the desk's tabs (an install's welcome page, the member closing a manager's
  // tab on the keyboard) asks again, soon. Only while there's a picture: deskd needs Chromium running.
  useEffect(() => {
    if (allowed && connected && picture) store.refresh();
  }, [store, allowed, connected, picture, tabs]);
  useEffect(() => {
    if (allowed && connected && picture) store.newSession();
  }, [store, allowed, connected, picture]);

  // The first manager installed is pinned, on a desk where the member never pinned or unpinned one (spec section 7).
  useEffect(() => {
    const first = firstPin(pins, view.exts);
    if (first) setLayoutPref({ [PINS_PREF]: withDeskPins(useLayoutPrefs.getState()[PINS_PREF], deskId, first) });
  }, [pins, view.exts, deskId]);

  const served = allowed && view.served;
  useEffect(() => {
    if (!served || !picture) setPanel(null);
  }, [served, picture]);

  const closePanel = useCallback((giveBack: boolean) => {
    setPanel(null);
    if (giveBack) keyRef.current?.focus({ preventScroll: true });
  }, []);
  const openPanel = useCallback(
    (at: PanelAt) => {
      setPanel(at);
      store.refresh(true);
    },
    [store],
  );
  const togglePin = useCallback(
    (id: string, on: boolean) => {
      const raw = useLayoutPrefs.getState()[PINS_PREF];
      setLayoutPref({ [PINS_PREF]: withDeskPins(raw, deskId, pinned(pinsFor(raw, deskId), id, on, store.get().exts)) });
    },
    [deskId, store],
  );
  const openExtension = useCallback(
    (id: string) => {
      // The manager's page fills the picture: the panel would only cover it.
      setPanel(null);
      void store.open(id).catch(() => undefined);
    },
    [store],
  );

  if (!served) return null;
  const installed = view.exts.filter((e) => e.state === 'installed');
  return {
    store,
    view,
    pins,
    key: keyExtension(view.exts, pins),
    installed,
    canAdd: view.exts.some((e) => e.state === 'missing'),
    panel,
    openPanel,
    closePanel,
    togglePin,
    openExtension,
    keyRef,
  };
}

/** The key (spec sections 1 and 8): the pinned manager's page, or, with none, Passwords and sign-ins. */
export function KeyButton({ ui }: { ui: SignInsUi }) {
  const { key } = ui;
  const name = keyName(key);
  // Pressed while its manager's page is up, or while Passwords and sign-ins is open, however it was opened (still 39).
  const on = (key?.open ?? false) || ui.panel !== null;
  return (
    <button
      ref={ui.keyRef}
      type="button"
      className={`icon-btn sm br-key${on ? ' on' : ''}`}
      aria-label={name}
      title={name}
      aria-pressed={on}
      data-testid="browser-key"
      onClick={() => {
        if (ui.view.busy) return;
        if (!key) {
          if (ui.panel) ui.closePanel(false);
          else ui.openPanel('top');
        } else if (key.open) void ui.store.close(key.id).catch(() => undefined);
        else ui.openExtension(key.id);
      }}
    >
      <LinkIcon name="key" />
    </button>
  );
}

/**
 * A phone on its side keeps the Browser bar to one row (LS-40), with the address at 160 px at least and the simplified
 * view's Undo at 44; under 700 px wide there's no room for the key as well (it pushed Undo out by up to 26 px, the fonts'
 * widths deciding). There the key folds into More. The same query as `app.css`'s, where the line's words go.
 */
const SIDEWAYS = '(max-width: 699px) and (max-height: 480px)';
const sidewaysQuery = (): MediaQueryList | null => (typeof window.matchMedia === 'function' ? window.matchMedia(SIDEWAYS) : null);
const onSideways = (fn: () => void): (() => void) => {
  const q = sidewaysQuery();
  q?.addEventListener('change', fn);
  return () => q?.removeEventListener('change', fn);
};
export const useSideways = (): boolean => useSyncExternalStore(onSideways, () => sidewaysQuery()?.matches ?? false);

/**
 * The menu's rows (spec section 7), in the Extensions menu and in More. `close(true)` gives focus back where it was. With no
 * manager installed (More on a phone on its side only: the Extensions button shows once one is), just "Passwords and
 * sign-ins", which is where the key is there.
 */
export function ExtRows({ ui, close }: { ui: SignInsUi; close: (giveBack: boolean) => void }) {
  const any = ui.installed.length > 0;
  return (
    <>
      {any && <p className="qm-title" role="none" aria-hidden="true">Extensions on this desk</p>}
      {ui.installed.map((e) => {
        const on = (ui.pins ?? []).includes(e.id);
        return (
          <div key={e.id} className="xm-row" role="none" data-testid="ext-row">
            <span className="xm-chip" aria-hidden="true">
              <LinkIcon name="key" />
            </span>
            <button
              type="button"
              role="menuitem"
              className="xm-open"
              onClick={() => {
                close(true);
                ui.openExtension(e.id);
              }}
            >
              <span className="xm-name">{e.name}</span>
              {e.maker && <span className="xm-by">by {e.maker}</span>}
            </button>
            <button type="button" role="menuitemcheckbox" aria-checked={on} className="xm-pin" aria-label={`Show ${e.name} in the bar`} title={`Show ${e.name} in the bar`} onClick={() => ui.togglePin(e.id, !on)}>
              <LinkIcon name="pin" />
            </button>
          </div>
        );
      })}
      {any && ui.canAdd && (
        <button
          type="button"
          role="menuitem"
          className="xm-item"
          aria-haspopup="dialog"
          onClick={() => {
            close(false);
            ui.openPanel('add');
          }}
        >
          <Icon name="plus" size={17} />
          <span>Add a password manager</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="xm-item"
        aria-haspopup="dialog"
        onClick={() => {
          close(false);
          ui.openPanel('top');
        }}
      >
        <LinkIcon name="key" />
        <span>Passwords and sign-ins</span>
        <span className="xm-end">
          <Icon name="chevronRight" size={14} />
        </span>
      </button>
    </>
  );
}

/** Room kept between the menu and the window's edges, and its width, as the quality menu's. */
const EDGE = 8;
const WIDTH = 320;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';

/** The Extensions button and its menu (spec section 7). Hidden under 720 px of bar, where More holds the same rows. */
export function ExtMenu({ ui, className = '' }: { ui: SignInsUi; className?: string }) {
  const [open, setOpen] = useState<'first' | 'last' | null>(null);
  const [box, setBox] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();
  const { store } = ui;

  const close = useCallback((giveBack: boolean): void => {
    setOpen(null);
    const to = returnTo.current;
    returnTo.current = null;
    if (giveBack) (to?.isConnected ? to : btnRef.current)?.focus({ preventScroll: true });
  }, []);

  const openMenu = (how: 'first' | 'last', from: Element | null): void => {
    const btn = btnRef.current;
    returnTo.current = from instanceof HTMLElement && from !== document.body && btn?.closest('.ma-window')?.contains(from) ? from : btn;
    setOpen(how);
    store.refresh(true);
  };

  useLayoutEffect(() => {
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!open || !btn || !menu) return;
    const room = (btn.closest('.ma-window') ?? document.documentElement).getBoundingClientRect();
    const at = btn.getBoundingClientRect();
    setBox({ width: Math.min(WIDTH, room.width - 2 * EDGE), maxHeight: Math.max(120, room.bottom - at.bottom - 6 - EDGE) });
    const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)];
    (open === 'last' ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
  }, [open]);

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

  return (
    <div ref={wrapRef} className={`qm-wrap${className ? ` ${className}` : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn sm${open ? ' on' : ''}`}
        aria-label="Extensions"
        title="Extensions"
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? `${id}-menu` : undefined}
        data-testid="browser-extensions"
        onPointerDown={() => {
          if (!open) returnTo.current = document.activeElement as HTMLElement | null;
        }}
        onClick={(e) => {
          if (open) close(true);
          else openMenu('first', e.detail === 0 ? btnRef.current : returnTo.current);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu(e.key === 'ArrowUp' ? 'last' : 'first', btnRef.current);
          }
        }}
      >
        <LinkIcon name="puzzle" />
      </button>
      {open && (
        <>
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
          <MenuBody menuRef={menuRef} id={`${id}-menu`} label="Extensions on this desk" style={box} onClose={close}>
            <ExtRows ui={ui} close={close} />
            <div role="separator" className="qm-sep" />
            <p className="qm-note" role="none">{MENU_NOTE}</p>
          </MenuBody>
        </>
      )}
    </div>
  );
}

/** The menu's box and its keys. */
function MenuBody({ menuRef, id, label, style, onClose, children }: { menuRef: RefObject<HTMLDivElement | null>; id: string; label: string; style: CSSProperties; onClose: (giveBack: boolean) => void; children: ReactNode }) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (to: number): void => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
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
        onClose(true);
        break;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        break;
      default:
        break;
    }
  };
  return (
    <div
      ref={menuRef}
      id={id}
      className="qm-menu xm-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={style}
      data-testid="extensions-menu"
      onKeyDown={onKey}
      onBlur={(e) => {
        if (e.relatedTarget && !menuRef.current?.parentElement?.contains(e.relatedTarget as Node)) onClose(false);
      }}
    >
      {children}
    </div>
  );
}
