// The small context menu on a desk or an app (ADR 0062, 0064): right click, or `.` or the menu key on the keyboard.
import { useCallback, useEffect, useRef } from 'react';
import { camera } from '../canvas/controller';
import { stackOrder } from '../canvas/layout';
import { beginEdit } from '../shell/arrange';
import { canUndoCleanup, cleanUpDesk, needsCleanup, restack, undoCleanup } from '../shell/cleanup';
import { appLabel, focusBack, focusProxy } from '../shell/actions';
import { announce } from '../shell/announce';
import { kindTipFor, mayRename } from './rename';
import { stopsOnLine } from '../platform/billingNote';
import { deskStyles } from '../theme/deskStyles';
import { DeskStylePicker } from './DeskStylePicker';
import { useMyTier } from '../platform/useTiers';
import { openGuildSheet, useGuildStore } from '../guild/guildStore';
import { useDoor } from '../deskapps/door';
import { putAway } from '../guild/GuildWindow';
import { guildIdOfPanel, mayManageAgents, maySeeUsage } from '../guild/panel';
import { useDeskStore } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { setView, useViewStore, type DeskMenuAt } from '../state/viewStore';

const WIDTH = 220; // matches .desk-menu; wide enough for five swatches on one row
const ITEM_H = 40;
const HEAD_H = 28; // .desk-menu-head
const STOPS_H = 24; // .desk-menu-stops
const STYLE_H = 84; // .desk-style, with a row of swatches
const EDGE = 8;

function closeMenu(): void {
  setView({ deskMenu: null });
}

function MenuBody({ at }: { at: DeskMenuAt }) {
  const ref = useRef<HTMLDivElement>(null);
  const desk = useLayoutStore((s) => s.desks[at.deskId]);
  const info = useDeskStore((s) => s.desks.find((d) => d.id === at.deskId));
  const tier = useMyTier();
  // The Apps row (ADR 0054): the desk app host is here (a desk has said apps are available), and it says this desk has them.
  const appsHost = useDoor((s) => s.host);
  useDoor((s) => s.rev);
  const apps = !!appsHost && !at.itemId && appsHost.appsRowShows(at.deskId);
  const guildId = at.itemId ? null : guildIdOfPanel(at.deskId);
  const hello = useGuildStore((s) => (guildId ? s.hello[guildId] : undefined));
  const target = at.itemId ?? at.deskId;
  const fromKeyboard = at.fromKeyboard;
  const dismiss = useCallback((): void => {
    closeMenu();
    if (fromKeyboard) focusBack(target);
  }, [fromKeyboard, target]);

  // Keys and focus. Esc belongs to the menu here, and takes the keyboard back where it was.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // The style row is one stop, on its swatch last focused (`DeskStylePicker`), which has the row's own keys.
    const items = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"][data-current]'));
    // From a right click, the menu itself takes focus, so the arrows and Esc still reach it.
    if (at.fromKeyboard) items()[0]?.focus();
    else el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && (e.target as HTMLElement | null)?.closest?.('.desk-style-row')) return;
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        dismiss();
      }
    };
    el.addEventListener('keydown', onKey);
    const offMove = camera.onMove(closeMenu);
    return () => {
      el.removeEventListener('keydown', onKey);
      offMove();
    };
  }, [at, dismiss]);

  if (!desk) return null;
  const edit = (kind: 'move' | 'resize'): void => {
    closeMenu();
    focusProxy(target);
    beginEdit(kind);
  };
  const run = (fn: () => void): void => {
    closeMenu();
    fn();
    if (at.fromKeyboard) focusBack(target);
  };
  const item = at.itemId ? desk.items.find((i) => i.id === at.itemId) : undefined;
  const order = stackOrder(desk);
  const stack = (to: 'front' | 'back', said: string): void => {
    if (!item) return;
    run(() => {
      restack(at.deskId, item.id, to);
      announce(`${appLabel(item.app)} ${said}`);
    });
  };
  const undoable = !at.itemId && canUndoCleanup(desk);
  // Renaming is a desk's, for its owner with a tier that renames, where Platform says it would succeed (task 45).
  const renamable = !at.itemId && mayRename(info, tier);
  // A Guild Desk's own items (task 48): its agents' limits and usage for those the guild lets see them, or putting it away.
  const role = hello?.role ?? info?.guild?.role;
  const grants = hello?.grants ?? info?.guild?.grants;
  const limits = !!guildId && !info?.removed && mayManageAgents(role, grants);
  const usage = !!guildId && !info?.removed && maySeeUsage(role);
  const away = !!guildId && info?.removed === true;
  const count = (at.itemId || undoable ? 4 : 3) + (renamable ? 1 : 0) + (limits ? 1 : 0) + (usage ? 1 : 0) + (away ? 1 : 0) + (apps ? 1 : 0);
  // A desk's style, once there's more than one to choose from.
  const styled = !at.itemId && deskStyles().length > 1;
  // The desk's kind, whatever its name: "Personal desk", once it's been named something else.
  const kind = at.itemId || !info ? null : kindTipFor(info.name, info.kind);
  // A desk a step down ends at renewal (the billing launch features, still 14): a second head line, said with the first.
  const stops = at.itemId || !info ? null : stopsOnLine(info.endsAt);
  const head = (kind ? HEAD_H : 0) + (stops ? STOPS_H : 0);
  const style = {
    left: Math.max(EDGE, Math.min(at.x, window.innerWidth - WIDTH - EDGE)),
    top: Math.max(EDGE, Math.min(at.y, window.innerHeight - count * ITEM_H - head - (styled ? STYLE_H : 0) - 2 * EDGE)),
  };
  const rename = (): void => {
    closeMenu();
    setView({ renaming: { deskId: at.deskId, fromKeyboard: at.fromKeyboard } });
  };
  const headId = `desk-menu-kind-${at.deskId}`;
  const stopsId = `desk-menu-stops-${at.deskId}`;
  const described = [kind ? headId : null, stops ? stopsId : null].filter(Boolean).join(' ');

  return (
    <>
      {/* A click away only dismisses: this takes it, so the canvas and the chrome under it never hear of it.
          It closes on the click, not the press, or the rest of the click would land on what's underneath. */}
      <div className="desk-menu-away" onClick={dismiss} onWheel={dismiss} onContextMenu={(e) => { e.preventDefault(); dismiss(); }} />
      <div ref={ref} className="menu desk-menu" role="menu" tabIndex={-1} aria-label={at.itemId ? 'App' : 'Desk'} {...(described ? { 'aria-describedby': described } : {})} style={style}>
        {/* Said as the menu's description, so it isn't a stray item among the menu's own. */}
        {kind && <p id={headId} className="desk-menu-head" aria-hidden="true" title={kind}>{kind}</p>}
        {stops && <p id={stopsId} className="desk-menu-stops" aria-hidden="true" data-testid="desk-menu-stops">{stops}</p>}
        {!at.itemId && (
          <button type="button" role="menuitem" className="menu-item" disabled={!needsCleanup(desk)} onClick={() => run(() => cleanUpDesk(at.deskId))}>Clean up</button>
        )}
        {undoable && (
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => undoCleanup(at.deskId))}>Undo clean up</button>
        )}
        {item && (
          <>
            <button type="button" role="menuitem" className="menu-item" disabled={order[order.length - 1] === item.id} onClick={() => stack('front', 'brought to front')}>Bring to front</button>
            <button type="button" role="menuitem" className="menu-item" disabled={order[0] === item.id} onClick={() => stack('back', 'sent to back')}>Send to back</button>
          </>
        )}
        <button type="button" role="menuitem" className="menu-item" onClick={() => edit('move')}>Move</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => edit('resize')}>Resize</button>
        {renamable && (
          <button type="button" role="menuitem" className="menu-item" onClick={rename}>Rename</button>
        )}
        {apps && (
          <button type="button" role="menuitem" className="menu-item" data-testid="desk-menu-apps" onClick={() => run(() => appsHost?.openAppsSheet(at.deskId))}>Apps</button>
        )}
        {styled && <DeskStylePicker deskId={at.deskId} stored={desk.style} />}
        {limits && guildId && (
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => openGuildSheet(guildId, 'limits'))}>Guild limits</button>
        )}
        {usage && guildId && (
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => openGuildSheet(guildId, 'usage'))}>Agent usage</button>
        )}
        {away && (
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => putAway(at.deskId))}>Put it away</button>
        )}
      </div>
    </>
  );
}

export function DeskMenu() {
  const at = useViewStore((s) => s.deskMenu);
  return at ? <div className="menu-wrap"><MenuBody key={`${at.deskId}|${at.itemId ?? ''}|${at.x}|${at.y}`} at={at} /></div> : null;
}
