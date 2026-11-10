// The list the hidden count opens (ADR 0064): a small menu above the icon, in the normal menu style and not etched.
// Each row is an app's icon and name. Choosing one brings it to the front. Enter opens, arrows move, Enter chooses, Esc closes.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { camera } from '../canvas/controller';
import { useGlyph } from '../agent/roster';
import { drawGlyph } from '../canvas/glyphs';
import type { AppId } from '../canvas/layout';
import { useIsPhone } from '../canvas/phone';
import { appLabel, focusBack } from '../shell/actions';
import { chooseHidden, closeHiddenList, hiddenOn, hiddenProxyId } from '../shell/hidden';
import { useDeskStore } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { useViewStore, type ViewState } from '../state/viewStore';
import { useTheme } from '../theme/themeStore';

const WIDTH = 188; // matches .desk-menu
const ROW_H = 40;
const MAX_ROWS = 6;
const CHROME = 14; // the menu's padding and border
const ABOVE = 6;
const EDGE = 8;

/** Esc, Tab or a click away: nothing changes, and the keyboard goes back to the icon. */
function dismiss(at: NonNullable<ViewState['hiddenList']>): void {
  closeHiddenList();
  if (at.fromKeyboard) focusBack(hiddenProxyId(at.deskId));
}

function RowGlyph({ app, deskId }: { app: AppId; deskId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = useTheme((s) => s.t);
  const glyph = useGlyph(deskId, app);
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const q = window.devicePixelRatio || 1;
    const size = 24;
    canvas.width = Math.round(size * q);
    canvas.height = Math.round(size * q);
    ctx.scale(q, q);
    drawGlyph(ctx, glyph, t, size);
  }, [glyph, t]);
  return <canvas ref={ref} className="hidden-list-glyph" aria-hidden="true" />;
}

function ListBody({ at }: { at: NonNullable<ViewState['hiddenList']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const desk = useLayoutStore((s) => s.desks[at.deskId]);
  const name = useDeskStore((s) => s.desks.find((d) => d.id === at.deskId)?.name) ?? '';
  const phone = useIsPhone();
  const rows = desk && !phone ? hiddenOn(desk) : [];
  // Where the icon is, as its proxy has it, once: any camera move closes this.
  const [icon] = useState(() => document.getElementById(`proxy-${hiddenProxyId(at.deskId)}`)?.getBoundingClientRect() ?? null);
  const gone = !rows.length || !icon;

  useEffect(() => {
    if (gone) closeHiddenList();
  }, [gone]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const items = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    // From a click, the list itself takes focus, so the arrows and Esc still reach it.
    if (at.fromKeyboard) items()[0]?.focus();
    else el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss(at);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[i <= 0 ? list.length - 1 : i - 1]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        dismiss(at);
      }
    };
    el.addEventListener('keydown', onKey);
    const offMove = camera.onMove(closeHiddenList);
    return () => {
      el.removeEventListener('keydown', onKey);
      offMove();
    };
  }, [at]);

  if (gone) return null;
  const away = (): void => dismiss(at);
  const height = Math.min(rows.length, MAX_ROWS) * ROW_H + CHROME;
  const style = {
    left: Math.max(EDGE, Math.min(icon.right - WIDTH, window.innerWidth - WIDTH - EDGE)),
    top: Math.max(EDGE, Math.min(icon.top - ABOVE - height, window.innerHeight - height - EDGE)),
  };

  return (
    <>
      {/* A click away only dismisses, like the desk's menu: the canvas and the chrome under it never hear of it. */}
      <div className="desk-menu-away" onClick={away} onWheel={away} onContextMenu={(e) => { e.preventDefault(); away(); }} />
      <div ref={ref} className="menu desk-menu hidden-list" role="menu" tabIndex={-1} aria-label={`Hidden apps on the ${name} desk`} style={style}>
        {rows.map((item) => (
          <button key={item.id} type="button" role="menuitem" className="menu-item hidden-list-item" data-item={item.id} onClick={() => chooseHidden(at.deskId, item, at.fromKeyboard)}>
            <RowGlyph app={item.app} deskId={at.deskId} />
            <span>{appLabel(item.app, at.deskId)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function HiddenList() {
  const at = useViewStore((s) => s.hiddenList);
  return at ? <div className="menu-wrap"><ListBody key={at.deskId} at={at} /></div> : null;
}
