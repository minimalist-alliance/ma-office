// One app on a desk. Below 168 x 168 it's an icon; from there it's a widget, with more detail as it
// grows (ADR 0062), and a widget with nothing to read at this zoom wears the icon's look, its glyph centred
// (`tileFace` in layout.ts: never a blank card). Chrome and glyph come from a shared sprite. Pressing brings it to the front of its
// desk's stack (ADR 0064): DeskPanel draws in the stack's order, so React puts the node there, once, and
// the drag that follows never touches the order. Moving and resizing write to Konva only: geometry comes
// from layout.ts, React hears about it at the drop, and the only renders during a drag are the one as
// it starts, to take the hover away, and the one at a detail threshold. No hover reaches any app during
// a drag: Konva sends none (WorldStage). On phones it keeps the grid: a drag reorders, and a chip resizes.
// Over another app, or in hand, it wears the stacked look (ADR 0064): another bitmap, read at draw time.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva/lib/Core.js';
import type { Text as KonvaText } from 'konva/lib/shapes/Text.js';
import { Circle, Group, Rect as KRect, Shape, Text } from 'react-konva/lib/ReactKonvaCore.js';
import { getTheme } from '../theme/themeStore';
import { deskLook } from '../theme/deskStyles';
import { glassFace, glassOn } from '../theme/tileGlass';
import type { ThemeId, Tokens } from '../theme/tokens';
import { moreContrast, reducedMotion } from '../lib/util';
import { placeItem, useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { easeCamera } from './camera';
import { camera } from './controller';
import { drawGrip, drawMark, drawSizeToggle } from './glyphs';
import { clampMove, clampResize, comingLater, detailLevel, faceGlyphSize, G, LATER, laterShows, readableWidget, tileFace, workArea, type DetailLevel, type LayoutItem, type Point, type Rect, type Slot } from './layout';
import { drawFrostUnder, frostUnder, type FrostUnder } from './frost';
import { blit, blitBackdrop, blitTileLive, glassBackdropSprite, glyphSprite, tileSprite, whenIdle } from './sprites';
import { CANVAS_FONT } from './font';
import type { AppSummary } from '../desk/deskLink';
import { appLabel } from '../shell/actions';
import { useGlyph, useRosterAgent, useTeamWaiting } from '../agent/roster';
import { CLEANUP_MS, isTidying, restack } from '../shell/cleanup';
import { badgeLook, countFree, useTileCalm } from '../state/tileCalm';

const T = { fontFamily: CANVAS_FONT, listening: false, perfectDrawEnabled: false } as const;
/** An open tile whose app is open in its window says so in its foot (ADR 0053). */
const IN_WINDOW_NOTE = 'Open in its window';

interface Props {
  deskId: string;
  item: LayoutItem;
  slot: Slot;
  /** Larger screens: free moving and resizing. Phones: the grid. */
  free: boolean;
  /** It overlaps an app below it. DeskPanel works this out when the layout changes. */
  stacked: boolean;
  touchUI: boolean;
  t: Tokens;
  summary: AppSummary | undefined;
  badge: number;
  windowOpen: boolean;
  shield: boolean;
  /** Touch has no hover, so the controls show while the desk has focus. */
  showControls: boolean;
  onOpen: (itemId: string) => void;
  onToggleSize: (itemId: string, level: DetailLevel) => void;
  onDragStart: (itemId: string) => void;
  onDragMove: (itemId: string, c: { x: number; y: number }) => void;
  onDragEnd: (itemId: string) => void;
}

/** A drag in progress: how far it can go, and where the app is. */
interface Drag {
  kind: 'move' | 'resize';
  area: Rect;
  rect: Rect;
}

// Konva's easing signature, around the camera's curve.
const EASE_STANDARD = (t: number, begin: number, change: number, duration: number): number => begin + change * easeCamera(t / duration);

/** Whether the desk a tile rests on wears a texture in this theme (`elevation.tileTextured`). */
function onTexture(deskId: string, theme: ThemeId): boolean {
  return !!deskLook(useLayoutStore.getState().desks[deskId]?.style, theme, moreContrast()).texture;
}

/**
 * The "Coming later" chip centred at (x, y): the landing's pill, neutral (the accent means counts), in the canvas's chip colours
 * with the size toggle's edge, since Light's chip is the tile's own white.
 */
function drawLater(ctx: CanvasRenderingContext2D, x: number, y: number, t: Tokens): void {
  ctx.font = `600 11px ${CANVAS_FONT}`;
  const w = Math.ceil(ctx.measureText(LATER).width) + 20;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
  ctx.fillStyle = t.surface.chip;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.border.default;
  ctx.stroke();
  ctx.fillStyle = t.text.secondary;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(LATER, x, y + 0.5);
}

function setCursor(e: Konva.KonvaEventObject<MouseEvent>, cursor: string): void {
  const stage = e.target.getStage();
  if (stage) stage.container().style.cursor = cursor;
}

export const ItemTile = memo(function ItemTile({
  deskId, item, slot, free, stacked, touchUI, t, summary, badge: appBadge, windowOpen, shield, showControls, onOpen, onToggleSize, onDragStart, onDragMove, onDragEnd,
}: Props) {
  const ref = useRef<Konva.Group>(null);
  const gripRef = useRef<Konva.Group>(null);
  const labelRef = useRef<KonvaText>(null);
  const titleRef = useRef<KonvaText>(null);
  const bodyRef = useRef<KonvaText>(null);
  const footRef = useRef<KonvaText>(null);
  const dragging = useRef(false);
  const drag = useRef<Drag | null>(null);
  // In hand, its glass shows its desk frosted (`frost.ts`): made in idle time from the press, dropped at the drop.
  const frost = useRef<FrostUnder | null>(null);
  const frostCancel = useRef<(() => void) | null>(null);
  const dropFrost = (): void => {
    frostCancel.current?.();
    frostCancel.current = null;
    frost.current = null;
  };
  // The size while the corner is dragged. It goes straight to Konva: no render, and no new bitmap.
  const liveSize = useRef<{ w: number; h: number } | null>(null);
  const liveLevelNow = useRef<DetailLevel>(slot.level);
  const placed = useRef(false);
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const [hover, setHover] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Its name would peek out from under its own menu.
  const menuOpen = useViewStore((s) => s.deskMenu?.itemId === item.id);
  const [liveLevel, setLiveLevel] = useState<DetailLevel | null>(null);
  const level = liveLevel ?? slot.level;
  const isWidget = level !== 'icon';
  const { w, h } = slot;
  const radius = isWidget ? G.widgetRadius : G.tileRadius;
  const handle = touchUI ? G.appHandleTouch : G.appHandle;
  // An agent's own tile draws its mark and wears its name (task 49); every other app, its glyph and its name.
  const glyph = useGlyph(deskId, item.app);
  const label = appLabel(item.app, deskId);
  // An agent's own tile counts that agent's unseen replies; the lead's `agent` tile keeps the desk's word.
  const own = useRosterAgent(deskId, item.app);
  // The lead's tile counts the team's requests waiting for the member, where the desk's own word says fewer (S-14).
  const teamWaiting = useTeamWaiting(deskId);
  const badge = own ? own.unseen : item.app === 'agent' && teamWaiting > appBadge ? teamWaiting : appBadge;
  // Under the focus shield the badge is still and neutral (Courier's a dot, no count); the accent stays only where something
  // may break through (`state/tileCalm.ts`).
  const tone = useTileCalm((s) => badgeLook(s, deskId, item.app));
  // Courier comes later (`comingLater`): no words to show, so its glyph and, where it can be read, a "Coming later" chip under it.
  const later = comingLater(item.app);
  // Words the widget can show: a title or text, and never under the privacy shield. Without them, it's the icon's look.
  const readable = !shield && !later && readableWidget(summary?.widget);

  // Glide to the slot whenever the layout moves it (others reflow in 120 ms, design 3.7).
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g || dragging.current) return;
    if (!placed.current || reducedMotion()) {
      g.position({ x: slot.x, y: slot.y });
      placed.current = true;
      return;
    }
    if (g.x() !== slot.x || g.y() !== slot.y) {
      if (isTidying(deskId)) g.to({ x: slot.x, y: slot.y, duration: CLEANUP_MS / 1000, easing: EASE_STANDARD });
      else g.to({ x: slot.x, y: slot.y, duration: 0.12, easing: Konva.Easings.EaseOut });
    }
  }, [slot.x, slot.y, deskId]);

  // A small settle when a phone's chip switches between icon and widget. A resize already moved there.
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    const g = ref.current;
    if (free || !g || reducedMotion()) return;
    g.scale({ x: 0.96, y: 0.96 });
    g.to({ scaleX: 1, scaleY: 1, duration: 0.2, easing: Konva.Easings.EaseOut });
  }, [slot.level, free]);

  // Everything in one sceneFunc, reading the theme and level of detail at draw time, so a camera
  // move or a theme change needs no React work per tile.
  const scene = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const ctx = context._context;
    const { t: tokens, resolved } = getTheme();
    const lod = camera.lod;
    // Read at draw time, as the text's visibility is (`controller.applyLod`), so a zoom past a threshold swaps the two at once.
    const face = tileFace(level, lod, readable);
    const app = face === 'glyph' ? glyph : null;
    const size = liveSize.current;
    const dw = size?.w ?? w;
    const dh = size?.h ?? h;
    // A drag's own flags are read here, so starting one changes the look with no render. A corner in hand is always stacked.
    const look = stacked || dragging.current || !!size;
    // A bitmap holds no look for a test to read.
    shape.attrs.stacked = look;
    shape.attrs.face = face;
    shape.attrs.glyphSize = app ? faceGlyphSize(dw, dh) : 0;
    if (size) blitTileLive(ctx, dw, dh, app, tokens, radius);
    else {
      // An icon's glyph is part of its bitmap. A larger tile's chrome is the plain card every app of its size shares, as its
      // widget is, and its glyph a small sprite of its own over it: a bitmap per app and size would raster far more at a zoom's
      // settle, most at the farthest zoom where many show (docs/sub-status/tile-icon-fallback.md has the numbers).
      // An icon's tile wears its app's accent (APP-TILES) at every face; a widget's card is the plain tile, and under glass the
      // office blue's (`words`), keeping its words at 4.5:1.
      // A tile under glass tells it where it sits on its desk and the desk's look, so it can keep its inks on the desk's colour
      // and show and bend its texture.
      const at = glassOn() ? { x: slotRef.current.x, y: slotRef.current.y, look: deskLook(useLayoutStore.getState().desks[deskId]?.style, resolved, moreContrast()) } : undefined;
      const spec = { w, h, app: isWidget ? null : app, glyphSize: faceGlyphSize(w, h), radius, stacked: look, textured: onTexture(deskId, resolved), tint: isWidget ? undefined : glyph, words: isWidget || undefined, at };
      const under = at ? glassBackdropSprite(spec, tokens) : null;
      if (under) blitBackdrop(ctx, under);
      // In hand, the desk under it frosted, from the copy made after the press: one blit a frame.
      else if (dragging.current && frost.current) drawFrostUnder(ctx, frost.current, shape.getAbsoluteTransform().getMatrix(), w, h, radius);
      blit(ctx, tileSprite(spec, tokens));
      if (isWidget && app) {
        const g = faceGlyphSize(w, h);
        blit(ctx, glyphSprite(app, tokens, g), (w - g) / 2, (h - g) / 2);
      }
    }
    if (face === 'widget') {
      // The widget's head glyph, from its own small sprite so it stays crisp and cheap.
      ctx.save();
      ctx.translate(16, 15);
      blit(ctx, glyphSprite(glyph, tokens));
      ctx.restore();
    }
    // Under the glyph, by the widget words' rule (`laterShows`); above "Open in its window" when that's said there too.
    const chip = later && laterShows(level, lod);
    shape.attrs.later = chip;
    if (chip) drawLater(ctx, dw / 2, level === 'open' && windowOpen && !shield ? dh - 46 : dh - 20, tokens);
    // How its badge shows, for a test to read (a bitmap holds no look): `plain`, `calm` or `accent`, null with no badge.
    shape.attrs.badgeTone = badge > 0 && lod !== 'card' ? tone : null;
    if (badge > 0 && lod !== 'card' && tone === 'calm') {
      // The focus shield's still count: the neutral chip's colours, never the accent; Courier's a dot with no number.
      const x = dw - 12;
      const y = 10;
      if (lod === 'glyph' || shield || countFree(item.app)) {
        // The count's own ink, so the dot reads at 3:1 or better on every theme (the brand review's note).
        ctx.fillStyle = tokens.text.secondary;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = tokens.surface.chip;
        ctx.strokeStyle = tokens.border.default;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 11.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tokens.text.secondary;
        ctx.font = `600 12px ${CANVAS_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge > 99 ? '99+' : String(badge), x, y + 0.5);
      }
    } else if (badge > 0 && lod !== 'card') {
      const x = dw - 12;
      const y = 10;
      ctx.fillStyle = tokens.badge.bg;
      if (lod === 'glyph' || shield || (tone === 'accent' && countFree(item.app))) {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = tokens.badge.fg;
        ctx.font = `600 13px ${CANVAS_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge > 99 ? '99+' : String(badge), x, y + 0.5);
      }
    }
    // The resize corner takes this spot while the pointer is on the app.
    const marks = !isWidget && !shield && lod === 'full' && !(free && (hover || size)) ? summary?.marks : undefined;
    if (marks?.[0]) drawMark(ctx, dw - 12, dh - 12, 10, marks[0], tokens);
    if (windowOpen) {
      ctx.fillStyle = tokens.glyph.soft;
      ctx.beginPath();
      ctx.arc(dw / 2, dh + 6, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [w, h, level, readable, later, isWidget, radius, glyph, stacked, badge, tone, shield, summary?.marks, windowOpen, free, hover, deskId, item.app]);

  const hit = useCallback((context: Konva.Context, shape: Konva.Shape) => {
    const size = liveSize.current;
    context.beginPath();
    context.rect(0, 0, size?.w ?? w, size?.h ?? h);
    context.closePath();
    context.fillStrokeShape(shape);
  }, [w, h]);

  const chipScene = useMemo(() => {
    const toSmall = !isWidget;
    return (context: Konva.Context) => drawSizeToggle(context._context, toSmall, getTheme().t.text.primary);
  }, [isWidget]);

  const gripScene = useCallback((context: Konva.Context) => {
    const ctx = context._context;
    ctx.save();
    ctx.translate(handle - 22, handle - 22);
    ctx.scale(0.7, 0.7);
    drawGrip(ctx, getTheme().t.text.tertiary);
    ctx.restore();
  }, [handle]);

  const startDrag = (kind: Drag['kind']): void => {
    const desk = useLayoutStore.getState().desks[deskId];
    if (!desk) return;
    const s = desk.items.find((i) => i.id === item.id) ?? slotRef.current;
    drag.current = {
      kind,
      area: workArea(desk.w, desk.h),
      rect: { x: s.x, y: s.y, w: s.w, h: s.h },
    };
  };

  // A pointer event, written straight to Konva: exactly under the pointer, as far as the desk's edges allow.
  const follow = (d: Drag, wanted: Point): void => {
    if (d.kind === 'move') {
      const to = clampMove(d.rect, wanted, d.area);
      d.rect = { ...d.rect, ...to };
      ref.current?.position(to);
      return;
    }
    const to = clampResize(d.rect, wanted.x, wanted.y, d.area);
    d.rect = { ...d.rect, ...to };
    liveSize.current = to;
    gripRef.current?.position({ x: to.w - handle, y: to.h - handle });
    const inner = to.w - 32;
    labelRef.current?.width(inner - 30);
    titleRef.current?.width(inner);
    bodyRef.current?.width(inner);
    bodyRef.current?.height(to.h - 76 - 34);
    footRef.current?.width(inner);
    footRef.current?.y(to.h - 28);
    const next = detailLevel(to.w, to.h, item.app);
    if (next !== liveLevelNow.current) {
      liveLevelNow.current = next;
      setLiveLevel(next);
    }
  };

  // The drop. Hover was off for the drag, and the pointer may or may not still be on this app.
  const finish = (d: Drag): void => {
    drag.current = null;
    dragging.current = false;
    dropFrost();
    const kept = placeItem(deskId, item.id, d.rect);
    if (!kept) ref.current?.position({ x: slotRef.current.x, y: slotRef.current.y });
    if (d.kind === 'resize') {
      liveSize.current = null;
      setLiveLevel(null);
      if (!kept) gripRef.current?.position({ x: slotRef.current.w - handle, y: slotRef.current.h - handle });
    }
    ref.current?.getLayer()?.batchDraw();
    const size = kept ? d.rect : slotRef.current;
    const p = ref.current?.getRelativePointerPosition();
    setHover(!touchUI && !!p && p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h);
  };

  // Pressing brings it to the front, on the press and before any drag, so what's grabbed is what moves. Not a
  // right press, which opens the menu that can send it to the back, and not a second finger, which is a pinch.
  const press = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const menu = 'button' in e.evt && e.evt.button === 2;
    const pinch = 'touches' in e.evt && e.evt.touches.length > 1;
    if (free && !menu && !pinch) restack(deskId, item.id, 'front');
    // The look a drag will want, made now if it isn't cached, so the drag's first frame has no bitmap to make.
    // The same spec the scene will draw in hand (its key has the desk's look and texture), so the bitmap made here is the one used.
    const { t: tokens, resolved } = getTheme();
    const at = glassOn() ? { x: slotRef.current.x, y: slotRef.current.y, look: deskLook(useLayoutStore.getState().desks[deskId]?.style, resolved, moreContrast()) } : undefined;
    tileSprite({ w, h, app: !isWidget && tileFace(level, camera.lod, readable) === 'glyph' ? glyph : null, glyphSize: faceGlyphSize(w, h), radius, stacked: true, textured: onTexture(deskId, resolved), tint: isWidget ? undefined : glyph, words: isWidget || undefined, at }, tokens);
    // And what its glass will show in hand: the desk without it, frosted, made when the page is next idle (a click wastes only
    // idle time). Only where a tile moves freely, since nothing else on the desk moves then; a phone's grid reflows.
    dropFrost();
    const g = glassFace(resolved);
    if (free && !menu && !pinch && g) {
      frostCancel.current = whenIdle(() => {
        frostCancel.current = null;
        const node = ref.current;
        const desk = node?.getStage()?.findOne(`#desk-${deskId}`);
        const size = useLayoutStore.getState().desks[deskId];
        if (node && desk && size) frost.current = frostUnder(desk, node, size, g.frost);
      });
    }
  };

  // The corner must outlive the hover from the press on. A quick first move leaves the app before the
  // drag has started, and if the corner unmounted then, the drag would never start at all.
  const holdGrip = (): void => {
    setResizing(true);
    const release = (): void => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('touchend', release);
      setResizing(false);
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);
  };

  const isMine = (e: Konva.KonvaEventObject<unknown>): boolean => (e.target as unknown) === ref.current;
  const isGrip = (e: Konva.KonvaEventObject<unknown>): boolean => (e.target as unknown) === gripRef.current;
  const showChip = !free && (hover || showControls);
  const showGrip = free && !shield && (hover || resizing || showControls);
  const inner = w - 32;
  // The widget's words, shown at the zoom that shows text. With none to show, the icon's look and no label row.
  const showText = isWidget && readable;
  const textVisible = camera.lod === 'full';
  const widget = summary?.widget;
  // An open tile whose window is open says so in its foot (ADR 0053): one place per app. It's said under the centred glyph too.
  const note = level === 'open' && windowOpen && !shield;
  const foot = note ? IN_WINDOW_NOTE : showText ? widget?.foot : undefined;

  return (
    <Group
      ref={ref}
      name="app-tile"
      id={`tile-${item.id}`}
      draggable
      onMouseEnter={(e) => { setHover(true); setCursor(e, 'pointer'); }}
      onMouseLeave={(e) => { setHover(false); setCursor(e, ''); }}
      // Konva hears nothing during a drag, so it can think the pointer never left, and send no enter.
      onMouseMove={(e) => { if (!hover) { setHover(true); setCursor(e, 'pointer'); } }}
      onMouseDown={press}
      onTouchStart={press}
      onClick={(e) => { e.cancelBubble = true; if (e.evt.button === 0) onOpen(item.id); }}
      onTap={(e) => { e.cancelBubble = true; onOpen(item.id); }}
      onDragStart={(e) => {
        if (!isMine(e)) return;
        dragging.current = true;
        setHover(false);
        if (free) {
          startDrag('move');
          return;
        }
        onDragStart(item.id);
      }}
      onDragMove={(e) => {
        const node = ref.current;
        if (!isMine(e) || !node) return;
        const d = drag.current;
        if (free && d) {
          // Konva has just put the node under the pointer. `follow` keeps it on the desk.
          follow(d, { x: node.x(), y: node.y() });
          return;
        }
        onDragMove(item.id, { x: node.x() + w / 2, y: node.y() + h / 2 });
      }}
      onDragEnd={(e) => {
        if (!isMine(e)) return;
        const d = drag.current;
        if (free && d) {
          finish(d);
          return;
        }
        dragging.current = false;
        dropFrost();
        onDragEnd(item.id);
        const s = slotRef.current;
        ref.current?.to({ x: s.x, y: s.y, duration: reducedMotion() ? 0.01 : 0.2, easing: Konva.Easings.EaseOut });
      }}
    >
      <Shape sceneFunc={scene} hitFunc={hit} perfectDrawEnabled={false} />
      {showText && (
        <>
          <Text {...T} ref={labelRef} name="lod-text" visible={textVisible} x={46} y={19} width={inner - 30} text={label} fontSize={13} fill={t.text.secondary} />
          {widget?.title && (
            <Text {...T} ref={titleRef} name="lod-text" visible={textVisible} x={16} y={52} width={inner} text={widget.title} fontSize={14} fontStyle="600" fill={t.text.primary} wrap="none" ellipsis />
          )}
          {widget?.text && (
            <Text {...T} ref={bodyRef} name="lod-text" visible={textVisible} x={16} y={76} width={inner} height={h - 76 - 34} text={widget.text} fontSize={13} lineHeight={1.38} fill={t.text.secondary} wrap="word" ellipsis />
          )}
        </>
      )}
      {foot && (
        <Text {...T} ref={footRef} name={note ? 'lod-text open-tile-note' : 'lod-text'} visible={textVisible} x={16} y={h - 28} width={inner} text={foot} fontSize={13} fill={note ? t.text.secondary : t.text.tertiary} wrap="none" ellipsis align={note && !showText ? 'center' : 'left'} />
      )}
      {!isWidget && hover && !resizing && !menuOpen && (
        // Close to the app: one right above the strip has the etched name 17 units below it.
        <Text {...T} x={-20} y={h + 2} width={w + 40} text={label} fontSize={12} fill={t.text.secondary} align="center" wrap="none" ellipsis />
      )}
      {showChip && (
        <Group
          x={2}
          y={2}
          name="size-toggle"
          onClick={(e) => { e.cancelBubble = true; onToggleSize(item.id, slot.level); }}
          onTap={(e) => { e.cancelBubble = true; onToggleSize(item.id, slot.level); }}
        >
          <Circle radius={12} fill={t.surface.chip} stroke={t.border.default} strokeWidth={1} perfectDrawEnabled={false} />
          <Shape sceneFunc={chipScene} listening={false} perfectDrawEnabled={false} />
        </Group>
      )}
      {showGrip && (
        <Group
          ref={gripRef}
          name="app-resize"
          x={w - handle}
          y={h - handle}
          draggable
          onClick={(e) => { e.cancelBubble = true; }}
          onTap={(e) => { e.cancelBubble = true; }}
          onMouseEnter={(e) => setCursor(e, 'nwse-resize')}
          onMouseLeave={(e) => setCursor(e, 'pointer')}
          onMouseDown={holdGrip}
          onTouchStart={holdGrip}
          onDragStart={(e) => {
            if (!isGrip(e)) return;
            liveSize.current = { w: slotRef.current.w, h: slotRef.current.h };
            liveLevelNow.current = slotRef.current.level;
            startDrag('resize');
          }}
          onDragMove={(e) => {
            const node = gripRef.current;
            const d = drag.current;
            if (!isGrip(e) || !node || !d) return;
            follow(d, { x: node.x() + handle, y: node.y() + handle });
          }}
          onDragEnd={(e) => {
            const d = drag.current;
            if (isGrip(e) && d) finish(d);
          }}
        >
          <KRect width={handle} height={handle} fill="transparent" />
          <Shape sceneFunc={gripScene} listening={false} perfectDrawEnabled={false} />
        </Group>
      )}
    </Group>
  );
});
