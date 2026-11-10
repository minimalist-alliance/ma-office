// The Konva stage. The camera lives in controller.ts; this component only owns the stage node, its
// size and pointer input. The `<canvas>` is aria-hidden: the proxy layer is the accessible mirror.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva/lib/Core.js';
import 'konva/lib/shapes/Rect.js';
import 'konva/lib/shapes/Text.js';
import 'konva/lib/shapes/Circle.js';
import { Layer, Stage } from 'react-konva/lib/ReactKonvaCore.js';
import { clamp, onContrastChange } from '../lib/util';
import { onThemeApplied } from '../theme/themeStore';
import { useDeskStore } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView, useViewStore } from '../state/viewStore';
import { cycleDesk, emptyCanvasClicked, inScopeDesks, refit } from '../shell/actions';
import { wheelDeltaY, wheelZoomFactor } from './camera';
import { camera } from './controller';
import { DeskPanel } from './DeskPanel';
import { onEtchFont } from './etch';
import { onTextureReady } from './textureHub';
import { listenForPinches } from './pinch';
import { isPhone, useIsPhone, useIsTouch } from './phone';
import { invalidateSprites } from './sprites';

Konva.dragDistance = 4; // small jitter is a click, not a drag

const SWIPE_PX = 80;
const GESTURE_END_MS = 200;

export function WorldStage({ onFirstPaint }: { onFirstPaint?: () => void }) {
  const desks = useDeskStore((s) => s.desks);
  const layout = useLayoutStore((s) => s.desks);
  const z = useLayoutStore((s) => s.z);
  const scope = useViewStore((s) => s.scope);
  const touchUI = useIsTouch();
  const phone = useIsPhone();

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const pinch = useRef<{ center: { x: number; y: number }; dist: number } | null>(null);
  const swipe = useRef({ acc: 0, used: false, timer: 0 });
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const layer = layerRef.current;
    if (!stage || !layer) return undefined;
    camera.attach(stage, layer);
    let painted = false;
    layer.on('draw.first', () => {
      if (painted) return;
      painted = true;
      layer.off('draw.first');
      onFirstPaint?.();
    });
    return () => camera.detach();
    // The stage mounts once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    camera.setViewport(size.w, size.h);
    refit(false);
  }, [size.w, size.h]);

  // Re-fit when the set of desks or the scope changes (the first list arriving, or a desk added).
  const deskIds = desks.map((d) => d.id).join();
  const hasLayout = desks.every((d) => layout[d.id]);
  // The list answering counts too, even with the same desks as last visit: it's what arriving waits for.
  const answered = useDeskStore((s) => s.status === 'ready');
  useEffect(() => {
    if (hasLayout) refit(false);
  }, [deskIds, hasLayout, answered]);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const onChange = (): void => {
      const dpr = camera.dpr();
      Konva.pixelRatio = dpr;
      stageRef.current?.getLayers().forEach((l) => l.getCanvas().setPixelRatio(dpr));
      stageRef.current?.batchDraw();
      listen();
    };
    const listen = (): void => {
      mq?.removeEventListener('change', onChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onChange);
    };
    listen();
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  // Theme: drop the chrome bitmaps and redraw synchronously, inside the view transition's update.
  useEffect(() => onThemeApplied(() => {
    invalidateSprites();
    layerRef.current?.draw();
  }), []);

  // The etched name reads these when it draws, so a change only needs a draw.
  useEffect(() => onEtchFont(() => layerRef.current?.batchDraw()), []);
  // A desk style's texture arrived: the desks wearing it draw it on the next frame, in a new bitmap each.
  useEffect(() => onTextureReady(() => layerRef.current?.batchDraw()), []);
  useEffect(() => onContrastChange(() => layerRef.current?.batchDraw()), []);

  // Stacking: applied imperatively. React keeps the children in a fixed order and never has to
  // re-parent a Konva node, which would cancel a drag in progress.
  useLayoutEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    z.forEach((id) => st.findOne(`#desk-${id}`)?.moveToTop());
    st.batchDraw();
  }, [z, deskIds]);

  // ----- input
  const onWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    camera.stop();
    const st = stageRef.current;
    const p = st?.getPointerPosition();
    if (!st || !p) return;
    const ev = e.evt;
    let dx = ev.deltaX;
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    }
    if (ev.deltaMode === 2) {
      dx *= camera.vp.w;
      dy *= camera.vp.h;
    }
    const mostlyHorizontal = !ev.ctrlKey && Math.abs(dx) > Math.abs(dy) * 1.2;
    if (mostlyHorizontal) {
      const v = getView();
      if (v.mode === 'desk' && inScopeDesks().length > 1) {
        // A horizontal swipe of 80 px or more goes to the next desk, one step per gesture.
        // A gesture ends after 200 ms without wheel events, which absorbs trackpad inertia.
        const s = swipe.current;
        window.clearTimeout(s.timer);
        s.timer = window.setTimeout(() => {
          s.acc = 0;
          s.used = false;
        }, GESTURE_END_MS);
        s.acc += dx;
        if (!s.used && Math.abs(s.acc) >= SWIPE_PX) {
          s.used = true;
          cycleDesk(s.acc > 0 ? 1 : -1);
        }
        return;
      }
      if (v.mode !== 'free') setView({ mode: 'free' });
      camera.panBy(dx, dy);
      return;
    }
    if (getView().mode !== 'free') setView({ mode: 'free' });
    camera.zoomAt(p, wheelZoomFactor(dy, ev.ctrlKey));
  }, []);

  // A pinch that starts anywhere else on the office, and Safari's, which never sends a wheel (`pinch.ts`).
  useEffect(() => listenForPinches({
    stageBox: () => stageRef.current?.container().getBoundingClientRect() ?? null,
    begin: () => {
      camera.stop();
      if (getView().mode !== 'free') setView({ mode: 'free' });
    },
    zoomAt: (p, factor) => camera.zoomAt(p, factor),
    wheelFactor: (e) => wheelZoomFactor(wheelDeltaY(e.deltaY, e.deltaMode, camera.vp.h), true),
  }), []);

  const onTouchMove = useCallback((e: Konva.KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    if (touches.length !== 2) return;
    e.evt.preventDefault();
    camera.stop();
    const st = stageRef.current;
    if (!st) return;
    if (st.isDragging()) st.stopDrag();
    const r = st.container().getBoundingClientRect();
    const t0 = touches[0]!;
    const t1 = touches[1]!;
    const a = { x: t0.clientX - r.left, y: t0.clientY - r.top };
    const b = { x: t1.clientX - r.left, y: t1.clientY - r.top };
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const prev = pinch.current;
    pinch.current = { center, dist };
    if (!prev) return;
    if (getView().mode !== 'free') setView({ mode: 'free' });
    const c = camera.cam;
    const s = clamp(c.s * (dist / prev.dist), 0.2, 3);
    const wx = (prev.center.x - c.x) / c.s;
    const wy = (prev.center.y - c.y) / c.s;
    camera.set({ s, x: center.x - wx * s, y: center.y - wy * s });
  }, []);

  // Right click on a desk or an app: its small menu. The empty canvas keeps the browser's own, and a phone has none.
  const onContextMenu = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    if (isPhone()) return;
    const deskNode = e.target.findAncestor('.desk', true);
    if (!deskNode) return;
    e.evt.preventDefault();
    const tile = e.target.findAncestor('.app-tile', true);
    setView({
      deskMenu: {
        deskId: deskNode.id().slice('desk-'.length),
        itemId: tile ? tile.id().slice('tile-'.length) : null,
        x: e.evt.clientX,
        y: e.evt.clientY,
        fromKeyboard: false,
      },
    });
  }, []);

  const onTouchEnd = useCallback(() => {
    pinch.current = null;
  }, []);

  const onStageDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (e.target !== stageRef.current) return;
    camera.stop();
    if (getView().mode !== 'free') setView({ mode: 'free' });
    stageRef.current.container().style.cursor = 'grabbing';
  }, []);
  const onStageDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (e.target !== stageRef.current) return;
    camera.fromStageDrag(e.target.x(), e.target.y());
  }, []);
  const onStageDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (e.target !== stageRef.current) return;
    camera.fromStageDrag(e.target.x(), e.target.y());
    stageRef.current.container().style.cursor = '';
  }, []);

  // A click outside the desks. Konva sends no click once a press has become a drag (Konva.dragDistance),
  // so a pan never gets here. Three presses it would still report as empty canvas don't count: one made
  // while the camera moves, when the hit graph is off and even a tile looks empty; one that began on a
  // desk; and any finger of a pinch, each of which ends in a tap of its own.
  const emptyPress = useRef(false);
  const onPointerDown = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const fingers = 'touches' in e.evt ? e.evt.touches.length : 1;
    // A second finger has to reach onTouchMove while the first is dragging. A mouse drag needs no events
    // at all: with them, every app it passes over would take hover, and a React render with it.
    Konva.hitOnDragEnabled = 'touches' in e.evt;
    emptyPress.current = e.target === stageRef.current && fingers === 1 && !camera.isMoving();
    camera.stop();
  }, []);
  const onStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button === 0 && e.target === stageRef.current && emptyPress.current) emptyCanvasClicked();
  }, []);
  const onStageTap = useCallback((e: Konva.KonvaEventObject<unknown>) => {
    if (e.target === stageRef.current && emptyPress.current) emptyCanvasClicked();
  }, []);

  const inScopeIds = useMemo(() => new Set(inScopeDesks(scope).map((d) => d.id)), [scope, desks]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Focusable, but not a Tab stop: a press on the canvas gives it the keyboard, so the canvas's single keys
    // (`useKeyboard`) work after a click, as they always have. The proxy layer is what the keyboard and screen
    // readers use; this stays hidden from them.
    <div ref={wrapRef} className="canvas-wrap" data-testid="canvas" aria-hidden="true" tabIndex={-1}>
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        draggable
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onStageClick}
        onTap={onStageTap}
        onContextMenu={onContextMenu}
        onDragStart={onStageDragStart}
        onDragMove={onStageDragMove}
        onDragEnd={onStageDragEnd}
      >
        <Layer ref={layerRef}>
          {desks.map((d) => {
            const l = layout[d.id];
            return l ? <DeskPanel key={d.id} desk={d} layout={l} hidden={!inScopeIds.has(d.id)} touchUI={touchUI} phone={phone} /> : null;
          })}
        </Layer>
      </Stage>
    </div>
  );
}
