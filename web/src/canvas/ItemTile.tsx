// One app on a desk. Below 168 x 168 it's an icon; from there it's a widget, with more detail as it
// grows (ADR 0062). Chrome and glyph come from a shared sprite. Pressing brings it to the front of its
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
import type { ThemeId, Tokens } from '../theme/tokens';
import { moreContrast, reducedMotion } from '../lib/util';
import { placeItem, useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { easeCamera } from './camera';
import { camera } from './controller';
import { drawGrip, drawMark, drawSizeToggle } from './glyphs';
import { clampMove, clampResize, detailLevel, G, iconGlyphSize, workArea, type DetailLevel, type LayoutItem, type Point, type Rect, type Slot } from './layout';
import { blit, blitTileLive, glyphSprite, tileSprite } from './sprites';
import { CANVAS_FONT } from './font';
import type { AppSummary } from '../desk/deskLink';
import { appLabel } from '../shell/actions';
import { useGlyph, useRosterAgent } from '../agent/roster';
import { CLEANUP_MS, isTidying, restack } from '../shell/cleanup';

const T = { fontFamily: CANVAS_FONT, listening: false, perfectDrawEnabled: false } as const;

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
  const badge = own ? own.unseen : appBadge;

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
    const { t: tokens, rev, resolved } = getTheme();
    const lod = camera.lod;
    const app = lod === 'card' || isWidget ? null : glyph;
    const size = liveSize.current;
    const dw = size?.w ?? w;
    const dh = size?.h ?? h;
    // A drag's own flags are read here, so starting one changes the look with no render. A corner in hand is always stacked.
    const look = stacked || dragging.current || !!size;
    // A bitmap holds no look for a test to read.
    shape.attrs.stacked = look;
    if (size) blitTileLive(ctx, dw, dh, app, tokens, rev, radius);
    else blit(ctx, tileSprite({ w, h, app, glyphSize: iconGlyphSize(w, h), radius, stacked: look, textured: onTexture(deskId, resolved) }, tokens, rev));
    if (isWidget && lod !== 'card') {
      // The widget's head glyph, from its own small sprite so it stays crisp and cheap.
      ctx.save();
      ctx.translate(16, 15);
      blit(ctx, glyphSprite(glyph, tokens, rev));
      ctx.restore();
    }
    if (badge > 0 && lod !== 'card') {
      const x = dw - 12;
      const y = 10;
      ctx.fillStyle = tokens.badge.bg;
      if (lod === 'glyph' || shield) {
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
  }, [w, h, isWidget, radius, glyph, stacked, badge, shield, summary?.marks, windowOpen, free, hover, deskId]);

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
    const next = detailLevel(to.w, to.h);
    if (next !== liveLevelNow.current) {
      liveLevelNow.current = next;
      setLiveLevel(next);
    }
  };

  // The drop. Hover was off for the drag, and the pointer may or may not still be on this app.
  const finish = (d: Drag): void => {
    drag.current = null;
    dragging.current = false;
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
    const { t: tokens, rev } = getTheme();
    tileSprite({ w, h, app: camera.lod === 'card' || isWidget ? null : glyph, glyphSize: iconGlyphSize(w, h), radius, stacked: true }, tokens, rev);
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
  const showText = isWidget && !shield;
  const textVisible = camera.lod === 'full';
  const widget = summary?.widget;

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
          {widget?.foot && (
            <Text {...T} ref={footRef} name="lod-text" visible={textVisible} x={16} y={h - 28} width={inner} text={widget.foot} fontSize={13} fill={t.text.tertiary} wrap="none" ellipsis />
          )}
        </>
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
