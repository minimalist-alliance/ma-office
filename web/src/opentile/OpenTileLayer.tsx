// Open tiles (ADR 0053, the owner, Nov 11): "All apps should be able to be 'opened' by expansion." A tile at the `open`
// level is the app itself, live, docked to the tile as DOM over the canvas: the same component its window holds
// (`appDef(app).Window`, through `windows/LiveWindow.tsx`), so what it shows carries over between tile and window. Its own
// chunk, with everything open tiles do but the level (`canvas/layout.ts`) and the way in (`door.ts`): it loads when a tile
// first reaches `open` on the shown desk, or on a load with one (`shell/Shell.tsx`). The rules are `model.ts`.
//
// It follows the camera as the carousel's stage does (`canvas/useCameraRest.ts`): laid out in screen pixels for the camera at
// rest, moved by one transform on the layer during a pan or zoom, laid out again at rest, never remounted for either. A desk's
// drag, push or glide, and a tile's own glide, move it through their Konva nodes. While a tile is live its Konva node is
// hidden, so the canvas paints nothing under it, and the frame's ground is opaque.
//
// Each tile has a slim head (the app's glyph and name, as a window's title bar but quieter) that moves it, a grip at every
// corner and edge that resizes it, and one button, "Open in its window". Pointer and wheel events in the app are the app's:
// the canvas is under the DOM, so it never sees them, and a pinch there is no zoom (`canvas/pinch.ts`). The tile's stop on
// the desk is its proxy, as any app's: the frame draws its ring, Tab, Enter or Space there go into the app, and an Esc the
// app doesn't use comes back to it (the office's own keys leave everything in a tile alone: `shell/useKeyboard.ts`).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type Konva from 'konva/lib/Core.js';
import { camera } from '../canvas/controller';
import { clampMove, G, workArea, type LayoutDesk, type LayoutItem, type Rect } from '../canvas/layout';
import { useIsPhone } from '../canvas/phone';
import { useCameraRest, type RestCam } from '../canvas/useCameraRest';
import { carouselOn } from '../carousel/model';
import { AppGlyph, Icon } from '../chrome/icons';
import { shownDesk } from '../desk/attention';
import { appLabel, focusProxy, inScopeDesks } from '../shell/actions';
import { announce } from '../shell/announce';
import { restack } from '../shell/cleanup';
import { useDeskStore } from '../state/deskStore';
import { placeItem, useLayoutStore } from '../state/layoutStore';
import { getView, setView, useViewStore } from '../state/viewStore';
import { openWindow, useWindowStore } from '../state/windowStore';
import { LiveWindow } from '../windows/LiveWindow';
import { liveTiles, tileOnScreen } from './model';
import { EDGES, resizeFrom, type Edge } from './resize';
import './opentile.css';

/** A drag shorter than this, in CSS pixels, is a press on the head, not a move. */
const DRAG_PX = 3;
/** The head's one button: a lone square reads as "maximize", so it says where the app goes (the Designer, S-145). */
const IN_ITS_WINDOW = 'Open in its window';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** For tests: how many times each tile's app has been mounted on this page, by item id. Not in a production bundle. */
function countMount(itemId: string): void {
  if (import.meta.env.MODE === 'production') return;
  const w = window as unknown as { __maOpenTileMounts?: Record<string, number> };
  w.__maOpenTileMounts ??= {};
  w.__maOpenTileMounts[itemId] = (w.__maOpenTileMounts[itemId] ?? 0) + 1;
}

const nodeOf = (id: string): Konva.Node | undefined => camera.getStage()?.findOne<Konva.Node>(`#${id}`);

/** Where a tile is now: its desk's node and its own, which a drag, push or glide moves before the layout hears of it. */
function placeNow(deskId: string, desk: Pick<LayoutDesk, 'x' | 'y'>, item: LayoutItem): { desk: { x: number; y: number }; item: Rect } {
  const d = nodeOf(`desk-${deskId}`);
  const t = nodeOf(`tile-${item.id}`);
  return { desk: d ? { x: d.x(), y: d.y() } : desk, item: t ? { ...item, x: t.x(), y: t.y() } : item };
}

/** The app's first place for the keyboard. */
const firstIn = (frame: Element | null): HTMLElement | undefined =>
  [...(frame?.querySelector('.open-tile-app')?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((n) => n.offsetParent !== null);

function OpenTile({ deskId, deskName, desk, item, rest, ring }: { deskId: string; deskName: string; desk: LayoutDesk; item: LayoutItem; rest: RestCam; ring: boolean }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const label = appLabel(item.app, deskId);
  const editing = useViewStore((s) => !!s.kbEdit && s.kbFocus === item.id);
  const at = placeNow(deskId, desk, item);
  const box = tileOnScreen(at.desk, at.item, rest);

  // Mounted once per time it goes live: a pan or a zoom never remounts it.
  useEffect(() => countMount(item.id), [item.id]);

  // While it's live the canvas paints nothing under it: its Konva node is hidden (`ItemTile` passes no `visible`, so no
  // render of it shows it again), and shown again as it goes. Going away with the keyboard inside, the keyboard goes to the
  // tile's proxy, unless something else took it (its window, opening).
  useLayoutEffect(() => {
    const node = nodeOf(`tile-${item.id}`);
    node?.visible(false);
    node?.getLayer()?.batchDraw();
    const frame = frameRef.current;
    return () => {
      node?.visible(true);
      node?.getLayer()?.batchDraw();
      if (!frame?.contains(document.activeElement)) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement) focusProxy(item.id);
      });
    };
  }, [item.id]);

  // A desk's drag, push or glide, and the tile's own glide (cleanup), move their Konva nodes before the layout hears of
  // it; the tile goes with them.
  useEffect(() => {
    const frame = frameRef.current;
    const nodes = [nodeOf(`desk-${deskId}`), nodeOf(`tile-${item.id}`)].filter((n): n is Konva.Node => !!n);
    if (!frame || !nodes.length) return undefined;
    const place = (): void => {
      const now = placeNow(deskId, desk, item);
      const b = tileOnScreen(now.desk, now.item, rest);
      frame.style.left = `${b.left}px`;
      frame.style.top = `${b.top}px`;
    };
    for (const n of nodes) n.on('xChange yChange', place);
    return () => {
      for (const n of nodes) {
        n.off('xChange', place);
        n.off('yChange', place);
      }
    };
  }, [deskId, desk, item, rest]);

  /** Put the frame where the layout has it again: a drag the desk refused. */
  const putBack = (): void => {
    const frame = frameRef.current;
    const b = tileOnScreen(desk, item, rest);
    if (frame) Object.assign(frame.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    nodeOf(`tile-${item.id}`)?.position({ x: item.x, y: item.y });
  };

  /**
   * A drag from the head moves the tile, one from the grip resizes it: written straight to the frame and to the tile's
   * Konva node as the pointer goes, and to the layout at the drop, as a tile's drag on the canvas is (`ItemTile`).
   */
  const drag = (e: ReactPointerEvent<HTMLElement>, edge: Edge | null): void => {
    const frame = frameRef.current;
    const layout = useLayoutStore.getState().desks[deskId];
    const start = layout?.items.find((i) => i.id === item.id);
    if (!frame || !layout || !start || e.button !== 0) return;
    e.stopPropagation();
    restack(deskId, item.id, 'front');
    const area = workArea(layout.w, layout.h);
    const from = { x: e.clientX, y: e.clientY };
    // The layer is laid out for the camera at rest, which is where the camera is while a tile is dragged.
    const { s } = rest;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let rect: Rect = { x: start.x, y: start.y, w: start.w, h: start.h };
    let moved = false;
    const move = (ev: PointerEvent): void => {
      const px = { x: ev.clientX - from.x, y: ev.clientY - from.y };
      if (!moved && Math.hypot(px.x, px.y) < DRAG_PX) return;
      moved = true;
      const dx = px.x / s;
      const dy = px.y / s;
      rect = edge ? resizeFrom(start, edge, dx, dy, area) : { ...rect, ...clampMove(start, { x: start.x + dx, y: start.y + dy }, area) };
      nodeOf(`tile-${item.id}`)?.position({ x: rect.x, y: rect.y });
      const d = nodeOf(`desk-${deskId}`);
      const b = tileOnScreen(d ? { x: d.x(), y: d.y() } : layout, rect, rest);
      Object.assign(frame.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (moved && !placeItem(deskId, item.id, rect)) putBack();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const asWindow = (): void => {
    openWindow(deskId, item.app, item.id);
    announce(`${label} window opened`);
  };

  return (
    <div
      ref={frameRef}
      className={`open-tile${ring ? ' ring' : ''}${ring && editing ? ' editing' : ''}`}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: G.widgetRadius * rest.s }}
      data-testid={`open-tile-${item.app.startsWith('agent:') ? 'agent' : item.app}`}
      data-desk={deskId}
      data-item={item.id}
      data-app={item.app}
    >
      <div
        className="open-tile-head"
        onPointerDown={(e) => drag(e, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setView({ deskMenu: { deskId, itemId: item.id, x: e.clientX, y: e.clientY, fromKeyboard: false } });
        }}
      >
        <AppGlyph app={item.app} deskId={deskId} size={16} />
        {/* A heading, as a window's title is: the app's own headings follow it. */}
        <h2 className="open-tile-name">{label}</h2>
      </div>
      <LiveWindow deskId={deskId} deskName={deskName} app={item.app} className="open-tile-app" role="group" aria-label={label} />
      <button type="button" className="icon-btn sm open-tile-expand" onClick={asWindow} aria-label={IN_ITS_WINDOW} title={IN_ITS_WINDOW}>
        <Icon name="windowFull" />
      </button>
      {EDGES.map((edge) => (
        <div key={edge} className={`window-edge ${edge}`} aria-hidden="true" onPointerDown={(e) => drag(e, edge)} />
      ))}
    </div>
  );
}

/** The live tile whose proxy (its stop on the desk) this is, if any. */
const liveOf = (el: Element | null): HTMLElement | null => {
  const id = el instanceof HTMLElement && el.classList.contains('proxy') ? el.id.slice('proxy-'.length) : '';
  return id ? document.querySelector<HTMLElement>(`.open-tile[data-item="${CSS.escape(id)}"]`) : null;
};

/**
 * The keys for live tiles, after the office's own (`useKeyboard` leaves everything in a tile alone, and ran first) and after
 * the app's, which had the key first: on a live tile's proxy, Tab, Enter or Space go into its app (and Enter opens no window:
 * it's open); in the app, an Esc it didn't use (ProseMirror marks every one used), or Shift+Esc, goes back to the proxy. Plain
 * Esc on the Browser's picture is the page's.
 */
function useTileKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = document.activeElement;
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter' || e.key === ' ') {
        // Not the Enter that kept a move or resize from the keyboard (`m`, `r`): that one was used.
        const frame = e.defaultPrevented || getView().kbEdit ? null : liveOf(el);
        const first = firstIn(frame);
        if (!first) return;
        e.preventDefault();
        first.focus();
        return;
      }
      const tile = e.key === 'Escape' ? el?.closest<HTMLElement>('.open-tile') : null;
      if (!tile || (e.defaultPrevented && !el?.closest('.ProseMirror')) || (!e.shiftKey && el?.closest('.br-surface'))) return;
      e.preventDefault();
      focusProxy(tile.dataset['item']!);
    };
    // A button presses on Space's keyup: not a live tile's proxy, whose Space went into the app.
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === ' ' && liveOf(document.activeElement)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, []);
}

/** The tile whose proxy has the keyboard's ring, which the frame draws (the proxy's own is under the frame). */
function useRinged(): string | null {
  const [ringed, setRinged] = useState<string | null>(null);
  useEffect(() => {
    const check = (): void => {
      const el = document.activeElement;
      setRinged(el?.matches('.proxy:focus-visible') ? liveOf(el)?.dataset['item'] ?? null : null);
    };
    window.addEventListener('focusin', check);
    window.addEventListener('focusout', check);
    check();
    return () => {
      window.removeEventListener('focusin', check);
      window.removeEventListener('focusout', check);
    };
  }, []);
  return ringed;
}

export default function OpenTileLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const rest = useCameraRest(ref);
  const desks = useDeskStore((s) => s.desks);
  const layouts = useLayoutStore((s) => s.desks);
  const shown = useViewStore((s) => shownDesk(s));
  const shield = useViewStore((s) => s.privacyShield);
  useViewStore((s) => s.scope);
  const phone = useIsPhone();
  const windows = useWindowStore((s) => s.windows);
  useTileKeys();
  const ringed = useRinged();
  const d = shown ? desks.find((x) => x.id === shown) : undefined;
  const l = d ? layouts[d.id] : undefined;
  // Its window wins (one place per app), closing ones included: the tile comes back live once the window has gone into it.
  const windowApps = useMemo(() => new Set(Object.values(windows).filter((w) => w.deskId === shown).map((w) => w.app)), [windows, shown]);
  const inScope = !!d && inScopeDesks().some((x) => x.id === d.id);
  const chosen = d && l && !phone && inScope && !carouselOn(l) ? liveTiles(l, rest, { w: window.innerWidth, h: window.innerHeight }, windowApps) : [];
  // In the desk's own order, so a change of which is largest never moves one in the DOM (a moved frame reloads what's in it).
  const live = l ? l.items.filter((i) => chosen.includes(i.id)) : [];

  return (
    <div ref={ref} className={`open-layer${shield ? ' shielded' : ''}`} data-testid="open-layer">
      {d && l && live.map((item) => <OpenTile key={item.id} deskId={d.id} deskName={d.name} desk={l} item={item} rest={rest} ring={ringed === item.id} />)}
    </div>
  );
}
