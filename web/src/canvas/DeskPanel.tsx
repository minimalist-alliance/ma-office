// A desk panel on the canvas: the panel, its tiles, and the strip along its bottom edge (ADR 0064): the etched
// name and icons, at a constant size whatever the zoom, and a status line only when there's a problem. Live
// drag and resize state stays local, so only the desk being changed re-renders while the pointer moves. Neighbours
// it pushes aside move on their Konva nodes (deskPushLive.ts), and nothing renders until the drop.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type Konva from 'konva/lib/Core.js';
import type { Circle as KCircle } from 'konva/lib/shapes/Circle.js';
import type { Text as KonvaText } from 'konva/lib/shapes/Text.js';
import { Circle, Group, Shape, Text } from 'react-konva/lib/ReactKonvaCore.js';
import { getTheme, useTheme } from '../theme/themeStore';
import { deskLook } from '../theme/deskStyles';
import { moreContrast, moveBefore, reducedMotion } from '../lib/util';
import { statusLine, type StatusDot } from '../desk/agentStatus';
import { liveStatusInput, useLive } from '../desk/liveStore';
import type { DeskInfo } from '../state/deskStore';
import { moveDesk, raiseDesk, reorderItems, resizeDesk, setItemLevel } from '../state/layoutStore';
import { beginPush, cancelPush, dropPush, pushTo } from './deskPushLive';
import { useViewStore } from '../state/viewStore';
import { useWindowStore, windowKey } from '../state/windowStore';
import { focusDesk, refit, tileActivated } from '../shell/actions';
import { CLEANUP_MS, cleanUpDesk, isTidying, needsCleanup, undoCleanup, useCleanup } from '../shell/cleanup';
import { hiddenOn, openHiddenList } from '../shell/hidden';
import { kindTipFor } from '../chrome/rename';
import { easeCamera, edgePan } from './camera';
import { camera } from './controller';
import { etchEpoch, fitName, statusTextWidth, stripControlSize, type NameFit } from './etch';
import { CANVAS_FONT } from './font';
import { drawMark } from './glyphs';
import { ItemTile } from './ItemTile';
import {
  cornerInset, countSlotW, deskBounds, deskGeometry, ETCH_BASELINE, ETCH_ICON, fitDeskSize, G, iconsFit, iconsLeft, nameRoom, overOthers, roundUnit, slotRight, stackOrder, statusClear, statusRoom, STRIP, stripTarget,
  type DetailLevel, type LayoutDesk,
} from './layout';
import { blitPanel, blitPanelLive, blitPinned, etchCountSprite, etchIconSprite, etchSprite, newEtchHold, panelSprite, undoSprite, whenIdle } from './sprites';
import { preloadDeskStyle } from './textureHub';

const T = { fontFamily: CANVAS_FONT, listening: false, perfectDrawEnabled: false } as const;
const NONE: ReadonlySet<string> = new Set();

/** True once `ms` has passed since it was last set. Lands after a camera move, never during one. */
function useWaited(ms: number | undefined): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (!ms) return undefined;
    let off = (): void => {};
    const timer = window.setTimeout(() => {
      if (camera.isMoving()) off = camera.onSettle(() => setWaited(true));
      else setWaited(true);
    }, ms);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [ms]);
  return waited;
}

/** A render a second while `on`, for a countdown. A tick that lands during a camera move is skipped. */
function useSeconds(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const timer = window.setInterval(() => {
      if (!camera.isMoving()) setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [on]);
}

function PulseDot({ x, y, color, pulse }: { x: number; y: number; color: string; pulse: boolean }) {
  const ref = useRef<KCircle>(null);
  useEffect(() => {
    const c = ref.current;
    if (!pulse || !c || reducedMotion()) {
      c?.opacity(1);
      return undefined;
    }
    // 2 s pulse at a calm 10 Hz: this redraws the layer, so never run it at the display rate.
    const start = performance.now();
    const id = window.setInterval(() => {
      if (camera.isAnimating()) return;
      c.opacity(0.55 + 0.45 * Math.cos(((performance.now() - start) / 2000) * Math.PI * 2));
      c.getLayer()?.batchDraw();
    }, 100);
    return () => {
      window.clearInterval(id);
      c.opacity(1);
    };
  }, [pulse]);
  return (
    <Circle
      ref={ref}
      name="desk-status-dot"
      x={x}
      y={y}
      radius={4}
      fill={color}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}

interface Props {
  desk: DeskInfo;
  layout: LayoutDesk;
  hidden: boolean;
  touchUI: boolean;
  phone: boolean;
}

export const DeskPanel = memo(function DeskPanel({ desk, layout, hidden, touchUI, phone }: Props) {
  const t = useTheme((s) => s.t);
  const resolvedTheme = useTheme((s) => s.resolved);
  // Text on the desk (the status line) is the style's own ink, which holds 4.5:1 on its texture.
  const deskText = deskLook(layout.style, resolvedTheme, moreContrast()).deskText;
  const active = useViewStore((s) => s.activeDesk === desk.id);
  const shield = useViewStore((s) => s.privacyShield);
  // While its name is a field (task 45), the etched name gives it room.
  const renaming = useViewStore((s) => s.renaming?.deskId === desk.id);
  // A renamed desk says its kind on hover over its name, "Personal desk"; one named for its kind has nothing to add.
  const kindTip = kindTipFor(desk.name, desk.kind);
  const live = useLive(desk.id);
  const openApps = useWindowStore((s) => s.windows);

  const groupRef = useRef<Konva.Group>(null);
  const handleRef = useRef<Konva.Group>(null);
  const statusRef = useRef<Konva.Group>(null);
  const statusTextRef = useRef<KonvaText>(null);
  const controlRef = useRef<Konva.Group>(null);
  const countRef = useRef<Konva.Group>(null);
  const sizeFrame = useRef(0);
  // The size while the corner is dragged. It goes straight to Konva: no render, and no new bitmap.
  const liveSize = useRef<{ w: number; h: number } | null>(null);
  const edgeFrame = useRef(0);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const nameFit = useRef<NameFit | null>(null);
  const [nameHold] = useState(newEtchHold);
  const [countHold] = useState(newEtchHold);
  // What's in the strip, for the draws and writes that happen outside a render.
  const stripNow = useRef({ dot: false, textX: STRIP.textX as number, labelW: 0, control: null as 'sparkle' | 'undo' | null, controlW: 0, controlH: 0, heldW: 0, count: false });
  // Which icon has the pointer: it's only a draw, so it isn't a render.
  const overIcon = useRef<'grip' | 'control' | 'count' | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  // A phone's tile being dragged: drawn last, so it passes over the others, and back in its place at the drop.
  const [lifted, setLifted] = useState<string | null>(null);
  const [hover, setHover] = useState(false);

  useEffect(() => setPreview(null), [layout.items]);

  const byId = useMemo(() => new Map(layout.items.map((i) => [i.id, i])), [layout.items]);
  const order = preview ?? layout.items.map((i) => i.id);
  const items = order.flatMap((id) => {
    const it = byId.get(id);
    return it ? [it] : [];
  });
  const geo = deskGeometry({ ...layout, items }, phone);
  // Bottom to top, once per render: React puts the nodes in this order, so a move or a drag sorts nothing. Larger
  // screens go by the stack. Phones go by the grid's list, and nothing stacks there.
  const drawn = phone ? (lifted ? [...order.filter((id) => id !== lifted), lifted] : order) : stackOrder(layout);
  // Which apps wear the stacked look, once per change of the layout, so a drop or a raise updates them and a move costs nothing.
  const over = useMemo(() => (phone ? NONE : overOthers(layout)), [layout, phone]);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const orderRef = useRef(order);
  orderRef.current = order;
  const lastSwap = useRef<{ id: string | null; t: number }>({ id: null, t: 0 });

  // Culling needs the node and its world box.
  useEffect(() => {
    const node = groupRef.current;
    if (!node) return undefined;
    return camera.registerDesk(desk.id, node, deskBounds(layout, phone));
    // Registered once per node; the rect is kept current below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.id]);
  useEffect(() => camera.updateDeskRect(desk.id, deskBounds(layout, phone)), [desk.id, layout, phone]);

  // A scope filter: out-of-scope desks fade out over 160 ms and stop rendering (design 3.2).
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    if (hidden) {
      if (reducedMotion()) {
        g.opacity(0);
        g.listening(false);
      } else {
        g.listening(false);
        g.to({ opacity: 0, duration: 0.16 });
      }
    } else {
      g.listening(true);
      if (reducedMotion()) g.opacity(1);
      else g.to({ opacity: 1, duration: 0.16 });
    }
    g.getLayer()?.batchDraw();
  }, [hidden]);

  const onTileDragStart = useCallback((id: string) => {
    setLifted(id);
    setPreview(orderRef.current.slice());
    lastSwap.current = { id: null, t: 0 };
  }, []);

  const onTileDragMove = useCallback((id: string, c: { x: number; y: number }) => {
    const { slots } = geoRef.current;
    for (const other of orderRef.current) {
      if (other === id) continue;
      const s = slots[other];
      if (!s) continue;
      const ix = s.w * 0.22;
      const iy = s.h * 0.22;
      if (c.x > s.x + ix && c.x < s.x + s.w - ix && c.y > s.y + iy && c.y < s.y + s.h - iy) {
        const now = performance.now();
        if (lastSwap.current.id === other && now - lastSwap.current.t < 400) return;
        lastSwap.current = { id: other, t: now };
        setPreview(moveBefore(orderRef.current, id, other));
        return;
      }
    }
  }, []);

  const onTileDragEnd = useCallback(() => {
    setLifted(null);
    if (orderRef.current.join() === layout.items.map((i) => i.id).join()) setPreview(null);
    else reorderItems(desk.id, orderRef.current);
  }, [desk.id, layout.items]);

  const onOpen = useCallback((itemId: string) => tileActivated(desk.id, itemId), [desk.id]);
  const onToggleSize = useCallback((itemId: string, level: DetailLevel) => {
    setItemLevel(desk.id, itemId, level === 'icon' ? 'small' : 'icon');
    refit(true); // the desk may have grown
  }, [desk.id]);

  // Resize corner: any size that still holds the apps (ADR 0062). Every frame writes to Konva only.
  // Dropping it leaves the camera alone, so the corner stays under the pointer. Fit and `0` refit on
  // request. At the viewport's edge the camera pans, and the corner keeps growing under a still pointer.
  // The handle and the control stand on the desk's corner, and what's in them is measured from there in CSS
  // pixels. So a drag's position is the corner, at any zoom.
  const isHandle = (e: Konva.KonvaEventObject<unknown>): boolean => (e.target as unknown) === handleRef.current;
  const statusWidth = useCallback((w: number, h: number): number => {
    const { s } = camera.cam;
    const { textX, heldW, count } = stripNow.current;
    return statusRoom(w, textX, s, !phone && iconsFit(w * s, h * s) ? statusClear(touchUI, cornerInset(s), heldW, count) : STRIP.clear);
  }, [phone, touchUI]);
  const showSize = (size: { w: number; h: number }): void => {
    liveSize.current = size;
    handleRef.current?.position({ x: size.w, y: size.h });
    statusRef.current?.y(size.h - G.strip / 2);
    statusTextRef.current?.width(statusWidth(size.w, size.h));
    controlRef.current?.position({ x: size.w, y: size.h });
    countRef.current?.position({ x: size.w, y: size.h });
  };
  const growTo = (x: number, y: number): void => {
    const size = fitDeskSize(layout.items, x, y);
    showSize(size);
    pushTo(desk.id, { x: layout.x, y: layout.y, ...size });
  };
  // The status line scales with the camera and the icons don't, so how much of the strip it has depends on the
  // zoom. Konva lays out its text again for a new width, so that waits for the camera to stop.
  useEffect(() => camera.onSettle(() => {
    const size = liveSize.current ?? geoRef.current;
    statusTextRef.current?.width(statusWidth(size.w, size.h));
  }), [statusWidth]);
  const onHandleStart = (e: Konva.KonvaEventObject<DragEvent>): void => {
    if (!isHandle(e)) return;
    cancelAnimationFrame(sizeFrame.current);
    groupRef.current?.moveToTop();
    raiseDesk(desk.id);
    beginPush(desk.id);
    liveSize.current = { w: geo.w, h: geo.h };
    pointerAt.current = camera.getStage()?.getPointerPosition() ?? null;
    let last = performance.now();
    const push = (now: number): void => {
      edgeFrame.current = requestAnimationFrame(push);
      const handle = handleRef.current;
      const pointer = pointerAt.current;
      const dt = now - last;
      last = now;
      if (!handle || !pointer) return;
      const { dx, dy } = edgePan(pointer, camera.vp, dt);
      if (!dx && !dy) return;
      camera.panBy(dx, dy);
      growTo(handle.x() + dx / camera.cam.s, handle.y() + dy / camera.cam.s);
    };
    edgeFrame.current = requestAnimationFrame(push);
  };
  const onHandleMove = (e: Konva.KonvaEventObject<DragEvent>): void => {
    const handle = handleRef.current;
    if (!isHandle(e) || !handle) return;
    // Kept here: the stage forgets the pointer while it's over the chrome, and the camera may be moving.
    pointerAt.current = camera.getStage()?.getPointerPosition() ?? pointerAt.current;
    growTo(handle.x(), handle.y());
  };
  const onHandleEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    cancelAnimationFrame(edgeFrame.current);
    const size = liveSize.current;
    if (!isHandle(e) || !size) return;
    if (!dropPush(desk.id, { x: layout.x, y: layout.y, w: size.w, h: size.h })) resizeDesk(desk.id, size.w, size.h);
    liveSize.current = null;
  };
  useEffect(() => () => {
    cancelAnimationFrame(edgeFrame.current);
    cancelAnimationFrame(sizeFrame.current);
    cancelPush(desk.id);
  }, [desk.id]);

  // A neighbour that cleanup or its undo moves goes with it over the same time, on its node alone. Instant under reduced motion.
  const shownAt = useRef({ x: layout.x, y: layout.y });
  useLayoutEffect(() => {
    const from = shownAt.current;
    const to = { x: layout.x, y: layout.y };
    shownAt.current = to;
    if ((from.x !== to.x || from.y !== to.y) && isTidying(desk.id) && !reducedMotion()) camera.glideDesk(desk.id, from, to, CLEANUP_MS);
  }, [layout.x, layout.y, desk.id]);

  // A cleanup that changes the desk's size moves it along with its apps, on the corner's stretched bitmap.
  const shownSize = useRef({ w: geo.w, h: geo.h });
  useLayoutEffect(() => {
    const from = shownSize.current;
    const to = { w: geo.w, h: geo.h };
    shownSize.current = to;
    if ((from.w === to.w && from.h === to.h) || !isTidying(desk.id) || reducedMotion()) return;
    cancelAnimationFrame(sizeFrame.current);
    const start = performance.now();
    const layer = groupRef.current?.getLayer();
    const step = (now: number): void => {
      const p = Math.min(1, (now - start) / CLEANUP_MS);
      if (p < 1) {
        const k = easeCamera(p);
        showSize({ w: from.w + (to.w - from.w) * k, h: from.h + (to.h - from.h) * k });
        sizeFrame.current = requestAnimationFrame(step);
      } else {
        showSize(to);
        liveSize.current = null;
      }
      layer?.batchDraw();
    };
    showSize(from);
    sizeFrame.current = requestAnimationFrame(step);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showSize is a new function each render, and this runs on a change of size alone.
  }, [geo.w, geo.h, desk.id]);

  // The desk's style (`theme/deskStyles.ts`) in this theme: its surface under everything, and the etch's colors. The
  // look is the same object every time, so a draw builds nothing for it, and a theme change is the next draw.
  const style = layout.style;
  const panelScene = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const { t: tokens, rev, resolved } = getTheme();
    const look = deskLook(style, resolved, moreContrast());
    const size = liveSize.current;
    // For tests: which look the panel drew.
    shape.attrs.drawnLook = look.key;
    if (size) blitPanelLive(context._context, size.w, size.h, active, tokens, rev, G.panelRadius, look);
    else blitPanel(context._context, panelSprite({ w: geo.w, h: geo.h, active, look }, tokens, rev, G.panelRadius), geo.w, geo.h, G.panelRadius + 2, look.base, !!look.texture);
  }, [geo.w, geo.h, active, style]);

  // Render the other focus state while idle, so a focus change never spends its first animation
  // frame on a bitmap. Again whenever the raster scale, the theme or the style changes.
  useEffect(() => {
    let cancelIdle = (): void => {};
    const warm = (): void => {
      cancelIdle();
      cancelIdle = whenIdle(() => {
        // A move rasters nothing (the next settle warms it again).
        if (camera.isMoving()) return;
        const { t: tokens, rev, resolved } = getTheme();
        panelSprite({ w: geo.w, h: geo.h, active: !active, look: deskLook(style, resolved, moreContrast()) }, tokens, rev, G.panelRadius);
      });
    };
    warm();
    const off = camera.onSettle(warm);
    return () => {
      off();
      cancelIdle();
    };
  }, [geo.w, geo.h, active, t, style]);

  // A style's other themes, at idle, so switching theme finds its texture ready. This theme's comes with the first draw.
  useEffect(() => whenIdle(() => {
    if (!moreContrast()) preloadDeskStyle(style);
  }), [style]);

  const panelHit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const size = liveSize.current;
    context.beginPath();
    context.rect(0, 0, size?.w ?? geo.w, size?.h ?? geo.h);
    context.closePath();
    context.fillStrokeShape(shape);
  }, [geo.w, geo.h]);

  useSeconds(desk.vm === 'stopping' && desk.stopAt !== null);
  const stopLeft = desk.stopAt ? Math.ceil((Date.parse(desk.stopAt) - Date.now()) / 1000) : 0;
  const line = statusLine({
    vm: desk.vm,
    phase: desk.phase,
    queuePosition: desk.queuePosition,
    stopInSec: stopLeft > 0 ? stopLeft : null, // past the announced time, it just says it's going
    stopReason: desk.stopReason,
    givebackUntil: desk.givebackUntil,
    ...liveStatusInput(live),
  });
  const dotColor: Record<StatusDot, string> = {
    pulse: t.status.offline,
    warn: t.status.warn,
    error: t.status.error,
  };
  const waited = useWaited(line.showAfterMs);
  const dot = line.showAfterMs && !waited ? null : line.dot;
  const textVisible = camera.lod === 'full';
  const mark = dot && line.fromAgent && !shield ? live.apps['agent']?.marks?.[0] : undefined;
  const markScene = useCallback((context: Konva.Context) => {
    if (mark) drawMark(context._context, STRIP.textX + 8, 0, 8, mark, getTheme().t);
  }, [mark]);
  const textX = mark ? STRIP.textX + STRIP.markW : STRIP.textX;
  // The strip's control. "Undo" stays for its 10 s. The sparkle shows while the pointer's on this desk or it
  // has focus, on touch only with focus, and only if there's something to clean up. Its slot is held whenever
  // it could show without a tap, so the count beside it doesn't move when the pointer comes (`slotRight`).
  const undo = useCleanup((s) => s[desk.id]);
  const offering = !phone && undo?.after === layout && undo.offered;
  const held = offering || (!phone && (active || !touchUI) && needsCleanup(layout));
  const sparkle = held && !offering && (active || (hover && !touchUI));
  const control = offering ? 'undo' : sparkle ? 'sparkle' : null;
  const controlSize = stripControlSize(offering, touchUI);
  const controlH = controlSize.h;
  const controlW = control ? controlSize.w : 0;
  const heldW = held ? controlSize.w : 0;
  // Once per version of the layout, however many things ask, so a drop or a raise works it out and a move doesn't.
  const hiddenCount = phone ? 0 : hiddenOn(layout).length;
  const countText = hiddenCount ? String(Math.min(hiddenCount, 99)) : '';
  stripNow.current = { dot: !!dot, textX, labelW: dot ? statusTextWidth(line.label) : 0, control, controlW, controlH, heldW, count: hiddenCount > 0 };
  const gripShows = hover || active || touchUI;

  // It went while the pointer was on it, so no leave will come.
  useEffect(() => {
    if (control || overIcon.current !== 'control') return;
    overIcon.current = null;
    const box = camera.getStage()?.container();
    if (box) {
      box.style.cursor = '';
      box.title = '';
    }
  }, [control]);

  // The same for the hidden count, and if it only changed, the tooltip says the new number.
  useEffect(() => {
    if (overIcon.current !== 'count') return;
    const box = camera.getStage()?.container();
    if (hiddenCount) {
      if (box) box.title = `${hiddenCount} hidden`;
      return;
    }
    overIcon.current = null;
    if (box) {
      box.style.cursor = '';
      box.title = '';
    }
  }, [hiddenCount]);

  // The name and the icons, from their own small bitmaps, so a move or a corner drag draws no text. Everything
  // is worked out here as the desk draws, in screen pixels, reading the camera: nothing renders, a desk that's
  // culled costs nothing, and at rest this is arithmetic and a comparison. They draw between the panel and the
  // tiles, so an app draws over them. A new cut of the name is a new bitmap, so it's fit at rest and held during
  // a camera move. A corner drag does fit it as it goes: one desk, and a new bitmap only when a letter comes or goes.
  const stripScene = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const g = groupRef.current;
    if (!g) return;
    const { t: tokens, rev, resolved } = getTheme();
    const { s, x: camX, y: camY } = camera.cam;
    const size = liveSize.current;
    const dw = size?.w ?? geo.w;
    const dh = size?.h ?? geo.h;
    const deskPx = dw * s;
    const n = stripNow.current;
    const inset = cornerInset(s);
    const icons = !phone && iconsFit(deskPx, dh * s);
    let fit = nameFit.current;
    if (!fit || fit.name !== desk.name || fit.epoch !== etchEpoch() || !camera.holdsNameFit()) {
      // Zoomed out, the status text is hidden, and its dot is all that's left to keep clear of.
      const textEnd = n.textX + Math.min(n.labelW, statusRoom(dw, n.textX, s, icons ? statusClear(touchUI, inset, heldW, !!countText) : STRIP.clear));
      const leftEnd = !n.dot ? 0 : (camera.lod === 'full' ? textEnd : STRIP.dotX + 4) * s;
      fit = fitName(fit, desk.name, nameRoom(deskPx, leftEnd, icons ? iconsLeft(touchUI, inset, heldW, !!countText) : 0));
      nameFit.current = fit;
    }
    const ctx = context._context;
    const plain = moreContrast();
    const ink = deskLook(style, resolved, plain);
    const q = camera.dpr();
    camera.pinToScreen(ctx);
    const right = (g.x() + dw) * s + camX;
    const bottom = (g.y() + dh) * s + camY;
    // The etch is cut into the desk, so none of it is ever off the desk: a fit held through a zoom out, or a desk shorter
    // on screen than the name, is cut at the panel's edges until the fit at rest ellipsizes or hides it (ADR 0064).
    // Konva restores the context after the draw, so this clips nothing else.
    ctx.beginPath();
    ctx.rect(right - deskPx, bottom - dh * s, deskPx, dh * s);
    ctx.clip();
    // A bitmap holds no text for a test to read.
    shape.attrs.drawn = fit.text;
    shape.attrs.drawnCount = icons ? countText : '';
    if (fit.text && !renaming) {
      const x = camera.pinned(right - deskPx / 2 - fit.width / 2);
      const y = camera.pinned(bottom - ETCH_BASELINE);
      shape.attrs.drawnX = x;
      shape.attrs.drawnY = y;
      blitPinned(ctx, etchSprite(nameHold, fit.text, plain, tokens, rev, q, ink), x, y);
    }
    if (!icons) return;
    const edge = right - inset;
    const mid = bottom - STRIP.iconUp;
    if (control) {
      const end = edge - slotRight('cleanup', touchUI);
      if (overIcon.current === 'control') {
        ctx.fillStyle = tokens.surface.fill;
        ctx.beginPath();
        ctx.roundRect(camera.pinned(end - controlW), camera.pinned(mid - controlH / 2), controlW, controlH, STRIP.padRadius);
        ctx.fill();
      }
      if (control === 'undo') {
        blitPinned(ctx, undoSprite(tokens, rev, q, ink.deskText), camera.pinned(end - controlW / 2 - statusTextWidth('Undo') / 2), camera.pinned(mid + 5));
      } else {
        blitPinned(ctx, etchIconSprite('sparkle', plain, tokens, rev, q, ink), camera.pinned(end - (controlW + ETCH_ICON) / 2), camera.pinned(mid - ETCH_ICON / 2));
      }
    }
    if (countText) {
      const end = edge - slotRight('count', touchUI, heldW);
      const w = countSlotW(touchUI);
      if (overIcon.current === 'count') {
        const target = stripTarget(touchUI);
        ctx.fillStyle = tokens.surface.fill;
        ctx.beginPath();
        ctx.roundRect(camera.pinned(end - w), camera.pinned(mid - target / 2), w, target, STRIP.padRadius);
        ctx.fill();
      }
      const cutCount = etchCountSprite(countHold, countText, plain, tokens, rev, q, ink);
      blitPinned(ctx, cutCount, camera.pinned(end - (w + cutCount.width + 2 * cutCount.x) / 2), camera.pinned(mid - ETCH_ICON / 2));
    }
    if (gripShows) {
      const target = stripTarget(touchUI);
      const end = edge - slotRight('grip', touchUI);
      if (overIcon.current === 'grip') {
        ctx.fillStyle = tokens.surface.fill;
        ctx.beginPath();
        ctx.roundRect(camera.pinned(end - target), camera.pinned(mid - target / 2), target, target, STRIP.padRadius);
        ctx.fill();
      }
      blitPinned(ctx, etchIconSprite('grip', plain, tokens, rev, q, ink), camera.pinned(end - (target + ETCH_ICON) / 2), camera.pinned(mid - ETCH_ICON / 2));
    }
  }, [geo.w, geo.h, desk.name, nameHold, countHold, countText, touchUI, phone, gripShows, control, controlW, controlH, heldW, renaming, style]);

  // Where the etched name is, for its tooltip: its fitted width, about its cap height, in desk units at this zoom.
  const nameHit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const fit = nameFit.current;
    if (!fit?.text) return;
    const { s } = camera.cam;
    const size = liveSize.current ?? geoRef.current;
    context.beginPath();
    context.rect(size.w / 2 - fit.width / 2 / s, size.h - (ETCH_BASELINE + 12) / s, fit.width / s, 16 / s);
    context.closePath();
    context.fillStrokeShape(shape);
  }, []);

  // Where a press goes: the same boxes, in CSS pixels, so it's the same size at every zoom. Under the tiles, like
  // what they cover, so a press on an app that's over an icon is the app's. The grip's also runs on into the
  // desk's corner, since that's where a pointer aims for it. It isn't there when the icons aren't.
  const controlHit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const { s } = camera.cam;
    const size = liveSize.current ?? geoRef.current;
    if (!iconsFit(size.w * s, size.h * s)) return;
    const { controlW: w, controlH: h } = stripNow.current;
    context.beginPath();
    context.rect(-(slotRight('cleanup', touchUI) + cornerInset(s) + w) / s, -(STRIP.iconUp + h / 2) / s, w / s, h / s);
    context.closePath();
    context.fillStrokeShape(shape);
  }, [touchUI]);
  const countHit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const { s } = camera.cam;
    const size = liveSize.current ?? geoRef.current;
    if (!iconsFit(size.w * s, size.h * s)) return;
    const h = stripTarget(touchUI);
    const w = countSlotW(touchUI);
    context.beginPath();
    context.rect(-(slotRight('count', touchUI, stripNow.current.heldW) + cornerInset(s) + w) / s, -(STRIP.iconUp + h / 2) / s, w / s, h / s);
    context.closePath();
    context.fillStrokeShape(shape);
  }, [touchUI]);
  const gripHit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const { s } = camera.cam;
    const size = liveSize.current ?? geoRef.current;
    if (!iconsFit(size.w * s, size.h * s)) return;
    const target = stripTarget(touchUI);
    const w = (slotRight('grip', touchUI) + cornerInset(s) + target) / s;
    const h = (STRIP.iconUp + target / 2) / s;
    context.beginPath();
    context.rect(-w, -h, w, h);
    context.closePath();
    context.fillStrokeShape(shape);
  }, [touchUI]);

  const onIcon = (e: Konva.KonvaEventObject<MouseEvent>, icon: 'grip' | 'control' | 'count' | null, cursor: string, title: string): void => {
    overIcon.current = icon;
    const stage = e.target.getStage();
    if (stage) {
      stage.container().style.cursor = cursor;
      stage.container().title = title;
    }
    groupRef.current?.getLayer()?.batchDraw();
  };
  // Its press isn't the desk's: not a drag, and not a focus.
  const stopPress = (e: Konva.KonvaEventObject<unknown>): void => {
    e.cancelBubble = true;
  };
  const pressControl = (): void => (offering ? undoCleanup(desk.id) : cleanUpDesk(desk.id));
  const isMine = (e: Konva.KonvaEventObject<unknown>): boolean => (e.target as unknown) === groupRef.current;

  return (
    <Group
      ref={groupRef}
      name="desk"
      id={`desk-${desk.id}`}
      x={layout.x}
      y={layout.y}
      draggable
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => { if (e.evt.button === 0) focusDesk(desk.id); }}
      onTap={() => focusDesk(desk.id)}
      onDragStart={(e) => { if (isMine(e)) { groupRef.current?.moveToTop(); raiseDesk(desk.id); beginPush(desk.id); } }}
      onDragMove={(e) => { if (isMine(e)) pushTo(desk.id, { x: e.target.x(), y: e.target.y(), w: layout.w, h: layout.h }); }}
      onDragEnd={(e) => {
        if (!isMine(e)) return;
        const x = roundUnit(e.target.x());
        const y = roundUnit(e.target.y());
        if (!dropPush(desk.id, { x, y, w: layout.w, h: layout.h })) moveDesk(desk.id, x, y);
      }}
    >
      <Shape sceneFunc={panelScene} hitFunc={panelHit} perfectDrawEnabled={false} name="desk-panel" />
      <Shape sceneFunc={stripScene} listening={false} perfectDrawEnabled={false} name="desk-name" />
      {kindTip && !renaming && (
        // Only a tooltip: a press goes on to the desk, as it does anywhere on its panel.
        <Shape hitFunc={nameHit} perfectDrawEnabled={false} name="desk-kind-tip" onMouseEnter={(e) => onIcon(e, null, '', kindTip)} onMouseLeave={(e) => onIcon(e, null, '', '')} />
      )}
      {control && (
        <Group
          ref={controlRef}
          name={offering ? 'desk-undo' : 'desk-cleanup'}
          x={geo.w}
          y={geo.h}
          onMouseEnter={(e) => onIcon(e, 'control', 'pointer', offering ? 'Undo clean up' : 'Clean up')}
          onMouseLeave={(e) => onIcon(e, null, '', '')}
          onMouseDown={stopPress}
          onTouchStart={stopPress}
          onClick={(e) => { e.cancelBubble = true; if (e.evt.button === 0) pressControl(); }}
          onTap={(e) => { e.cancelBubble = true; pressControl(); }}
        >
          <Shape hitFunc={controlHit} perfectDrawEnabled={false} />
        </Group>
      )}
      {countText && (
        <Group
          ref={countRef}
          name="desk-hidden"
          x={geo.w}
          y={geo.h}
          onMouseEnter={(e) => onIcon(e, 'count', 'pointer', `${hiddenCount} hidden`)}
          onMouseLeave={(e) => onIcon(e, null, '', '')}
          onMouseDown={stopPress}
          onTouchStart={stopPress}
          onClick={(e) => { e.cancelBubble = true; if (e.evt.button === 0) openHiddenList(desk.id, false); }}
          onTap={(e) => { e.cancelBubble = true; openHiddenList(desk.id, false); }}
        >
          <Shape hitFunc={countHit} perfectDrawEnabled={false} />
        </Group>
      )}
      {!phone && (
        <Group
          ref={handleRef}
          name="resize-handle"
          x={geo.w}
          y={geo.h}
          draggable
          onDragStart={onHandleStart}
          onDragMove={onHandleMove}
          onDragEnd={onHandleEnd}
          onClick={(e) => { e.cancelBubble = true; }}
          onMouseEnter={(e) => onIcon(e, 'grip', 'nwse-resize', '')}
          onMouseLeave={(e) => onIcon(e, null, '', '')}
        >
          <Shape hitFunc={gripHit} perfectDrawEnabled={false} />
        </Group>
      )}
      {/* Under the tiles, like the name: none rests in the strip, and a phone's tile in hand passes over it. */}
      {dot && (
        <Group ref={statusRef} y={geo.h - G.strip / 2} listening={false}>
          <PulseDot x={STRIP.dotX} y={0} color={dotColor[dot]} pulse={dot === 'pulse'} />
          {mark && <Shape name="lod-text desk-status-mark" visible={textVisible} sceneFunc={markScene} listening={false} perfectDrawEnabled={false} />}
          <Text
            {...T}
            ref={statusTextRef}
            name="lod-text desk-status"
            visible={textVisible}
            x={textX}
            y={-7}
            width={statusWidth(geo.w, geo.h)}
            text={line.label}
            fontSize={13}
            fill={deskText}
            wrap="none"
            ellipsis
          />
        </Group>
      )}
      {drawn.map((id) => {
        const item = byId.get(id);
        const slot = geo.slots[id];
        if (!item || !slot) return null;
        const summary = live.apps[item.app];
        return (
          <ItemTile
            key={item.id}
            deskId={desk.id}
            item={item}
            slot={slot}
            free={!phone}
            stacked={over.has(id)}
            touchUI={touchUI}
            t={t}
            summary={summary}
            badge={summary?.badge ?? desk.badges[item.app] ?? 0}
            windowOpen={!!openApps[windowKey(desk.id, item.app)]}
            shield={shield}
            showControls={touchUI && active}
            onOpen={onOpen}
            onToggleSize={onToggleSize}
            onDragStart={onTileDragStart}
            onDragMove={onTileDragMove}
            onDragEnd={onTileDragEnd}
          />
        );
      })}
    </Group>
  );
});
