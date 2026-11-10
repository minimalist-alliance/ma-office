// Accessible mirror of the canvas (design 3.11): transparent, focusable DOM buttons at each desk's
// and tile's position, in a world-space container that takes the camera transform. It follows the
// camera at rest, and during a move only while one of its buttons holds focus, because the ring is
// drawn on it. Screen readers, voice control and Playwright getByRole all work through it.
import { memo, useEffect, useRef } from 'react';
import { camera } from '../canvas/controller';
import { cornerInset, countSlotW, deskGeometry, isAgentApp, slotRight, STRIP, stripTarget, type LayoutDesk } from '../canvas/layout';
import { rosterAgent, useRosterStore } from '../agent/roster';
import { stripControlSize } from '../canvas/etch';
import { isPhone, useIsPhone, useIsTouch } from '../canvas/phone';
import { statusLine } from '../desk/agentStatus';
import { liveStatusInput, useLive } from '../desk/liveStore';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView, useViewStore } from '../state/viewStore';
import { appFocused, appLabel, focusDesk, focusProxy, openItem } from '../shell/actions';
import { cleanUpDesk, cleanupProxyId, needsCleanup, undoCleanup, useCleanup } from '../shell/cleanup';
import { hiddenLabel, hiddenOn, hiddenProxyId, noHiddenLabel, openHiddenList, RING_MS, useRing } from '../shell/hidden';
import { announce } from '../shell/announce';
import { appsInOrder } from '../shell/order';

// After whatever said why it changed ("Desk cleaned up"), so it doesn't cut that off. Quick changes come out as the last.
const SAY_COUNT_AFTER_MS = 800;

/** The ring on an app chosen from the hidden list: on the app's place, over the canvas, so it's the compositor's and draws no frames there. */
function HiddenRing() {
  const ring = useRing((s) => s.ring);
  const desk = useLayoutStore((s) => (ring ? s.desks[ring.deskId] : undefined));
  const item = desk?.items.find((i) => i.id === ring?.itemId);
  if (!ring || !desk || !item) return null;
  return (
    <div
      key={ring.n}
      className="hidden-ring"
      data-item={item.id}
      aria-hidden="true"
      style={{ left: desk.x + item.x, top: desk.y + item.y, width: item.w, height: item.h, animationDuration: `${RING_MS}ms` }}
    />
  );
}

/** Memoized per desk, so moving the focus or the active desk re-renders only the desks it touches. */
const DeskProxies = memo(function DeskProxies({ desk, layout, stop }: { desk: DeskInfo; layout: LayoutDesk; stop: string | null }) {
  const live = useLive(desk.id);
  // Agents' names label their own tiles (task 49): a rename on the desk is a new label here.
  useRosterStore((s) => s.desks[desk.id]);
  const phone = useIsPhone();
  const touch = useIsTouch();
  const geo = deskGeometry(layout, phone);
  const editing = useViewStore((s) => (s.kbEdit ? s.kbFocus : null));
  const proxyClass = (id: string): string => (editing === id ? 'proxy editing' : 'proxy');
  // The buttons' order comes from where the apps are, never from the stack (ADR 0064). They hold still during
  // a keyboard edit: moving the focused button in the DOM would drop its focus.
  const order = useRef<readonly string[]>([]);
  if (!editing || !layout.items.some((i) => i.id === editing)) order.current = appsInOrder(layout.items, phone).map((i) => i.id);
  const byId = new Map(layout.items.map((i) => [i.id, i]));
  const keys = phone ? undefined : 'm r .';
  // The strip's control, for the keyboard and screen readers whether or not the canvas shows it just now.
  const undo = useCleanup((s) => s[desk.id]);
  const offering = !phone && undo?.after === layout && undo.offered;
  const control = offering || (!phone && needsCleanup(layout));
  const controlId = cleanupProxyId(desk.id);
  const size = stripControlSize(offering, touch);
  const end = slotRight('cleanup', touch);
  // The hidden count, for the keyboard and screen readers. Phones keep their grid, so nothing's hidden there.
  const hiddenCount = phone ? 0 : hiddenOn(layout).length;
  const hiddenId = hiddenProxyId(desk.id);
  // Where the canvas draws it: past cleanup's slot while that's held (DeskPanel), and on touch it's held only on the active desk.
  const active = useViewStore((s) => s.activeDesk === desk.id);
  const held = offering || (control && (active || !touch));
  const countEnd = slotRight('count', touch, held ? size.w : 0);
  const countW = countSlotW(touch);
  const target = stripTarget(touch);
  const saidCount = useRef(hiddenCount);
  useEffect(() => {
    if (saidCount.current === hiddenCount) return undefined;
    const timer = window.setTimeout(() => {
      saidCount.current = hiddenCount;
      announce(hiddenCount ? hiddenLabel(hiddenCount, desk.name) : noHiddenLabel(desk.name));
    }, SAY_COUNT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hiddenCount, desk.name]);
  useEffect(() => {
    if (!hiddenCount && getView().kbFocus === hiddenId) focusProxy(desk.id);
  }, [hiddenCount, hiddenId, desk.id]);
  // When it goes away while it holds the keyboard, the desk takes the keyboard.
  useEffect(() => {
    if (!control && getView().kbFocus === controlId) focusProxy(desk.id);
  }, [control, controlId, desk.id]);
  const status = statusLine({
    vm: desk.vm, phase: desk.phase, queuePosition: desk.queuePosition, givebackUntil: desk.givebackUntil, stopReason: desk.stopReason,
    ...liveStatusInput(live),
  }).label;
  return (
    <div role="group" aria-label={`${desk.name} desk`}>
      <button
        type="button"
        id={`proxy-${desk.id}`}
        className={proxyClass(desk.id)}
        tabIndex={stop === desk.id ? 0 : -1}
        aria-keyshortcuts={keys}
        aria-label={`${desk.name} desk, ${layout.items.length} apps, ${status}`}
        style={{ left: layout.x, top: layout.y, width: geo.w, height: geo.h }}
        onFocus={() => setView({ kbFocus: desk.id })}
        onClick={() => focusDesk(desk.id)}
      />
      {order.current.map((id) => {
        const it = byId.get(id);
        const slot = geo.slots[id];
        if (!it || !slot) return null;
        const count = (isAgentApp(it.app) ? rosterAgent(it.app, desk.id)?.unseen : undefined) ?? live.apps[it.app]?.badge ?? desk.badges[it.app] ?? 0;
        // The lead's tile speaks for the team's approvals; an agent's own counts its unseen replies.
        const suffix = count > 0 ? (it.app === 'agent' ? `, ${count} need you` : `, ${count} unread`) : '';
        return (
          <button
            key={it.id}
            type="button"
            id={`proxy-${it.id}`}
            className={proxyClass(it.id)}
            tabIndex={stop === it.id ? 0 : -1}
            aria-keyshortcuts={keys}
            aria-label={`${appLabel(it.app, desk.id)}${suffix}`}
            style={{ left: layout.x + slot.x, top: layout.y + slot.y, width: slot.w, height: slot.h }}
            onFocus={() => appFocused(desk.id, it.id)}
            onClick={() => openItem(desk.id, it.id)}
          />
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          id={`proxy-${hiddenId}`}
          className={`${proxyClass(hiddenId)} proxy-strip`}
          tabIndex={stop === hiddenId ? 0 : -1}
          aria-label={hiddenLabel(hiddenCount, desk.name)}
          aria-haspopup="menu"
          style={{
            left: `calc(${layout.x + geo.w}px - (${countEnd + countW}px + var(--ma-strip-inset)) / var(--ma-cam-s))`,
            top: `calc(${layout.y + geo.h}px - ${STRIP.iconUp + target / 2}px / var(--ma-cam-s))`,
            width: `calc(${countW}px / var(--ma-cam-s))`,
            height: `calc(${target}px / var(--ma-cam-s))`,
          }}
          onFocus={() => setView({ kbFocus: hiddenId })}
          onClick={() => openHiddenList(desk.id, true)}
        />
      )}
      {control && (
        <button
          type="button"
          id={`proxy-${controlId}`}
          className={`${proxyClass(controlId)} proxy-strip`}
          tabIndex={stop === controlId ? 0 : -1}
          aria-label={offering ? `Undo clean up ${desk.name} desk` : `Clean up ${desk.name} desk`}
          // The same size on screen as what's drawn, at any zoom: this layer is in world units, and scales.
          style={{
            left: `calc(${layout.x + geo.w}px - (${end + size.w}px + var(--ma-strip-inset)) / var(--ma-cam-s))`,
            top: `calc(${layout.y + geo.h}px - ${STRIP.iconUp + size.h / 2}px / var(--ma-cam-s))`,
            width: `calc(${size.w}px / var(--ma-cam-s))`,
            height: `calc(${size.h}px / var(--ma-cam-s))`,
          }}
          onFocus={() => setView({ kbFocus: controlId })}
          onClick={() => (offering ? undoCleanup(desk.id) : cleanUpDesk(desk.id))}
        />
      )}
    </div>
  );
});

export function ProxyLayer() {
  const desks = useDeskStore((s) => s.desks);
  const layout = useLayoutStore((s) => s.desks);
  const kbFocus = useViewStore((s) => s.kbFocus);
  const activeDesk = useViewStore((s) => s.activeDesk);
  const mode = useViewStore((s) => s.mode);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const write = (): void => {
      const el = ref.current;
      if (!el) return;
      const c = camera.cam;
      el.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
      el.style.setProperty('--ma-cam-s', String(c.s));
      el.style.setProperty('--ma-strip-inset', `${cornerInset(c.s)}px`);
    };
    write();
    const offSettle = camera.onSettle(write);
    const offMove = camera.onMove(() => {
      if (ref.current?.contains(document.activeElement)) {
        const c = camera.cam;
        ref.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
      }
    });
    return () => {
      offSettle();
      offMove();
    };
  }, []);

  // One tab stop, arrows inside (design 3.11).
  const firstApp = activeDesk && layout[activeDesk] ? appsInOrder(layout[activeDesk].items, isPhone())[0]?.id : undefined;
  const first = activeDesk ? (mode === 'overview' ? activeDesk : firstApp ?? activeDesk) : desks[0]?.id;
  const tabStop = kbFocus ?? first ?? null;

  return (
    // The main landmark around this layer names it "Desks" (Shell), so it needs no name of its own.
    <div ref={ref} className="proxy-layer" onContextMenu={(e) => e.preventDefault()}>
      {desks.map((d) => {
        const l = layout[d.id];
        if (!l) return null;
        const holds = tabStop === d.id || tabStop === cleanupProxyId(d.id) || tabStop === hiddenProxyId(d.id) || !!l.items.some((i) => i.id === tabStop);
        return <DeskProxies key={d.id} desk={d} layout={l} stop={holds ? tabStop : null} />;
      })}
      <HiddenRing />
    </div>
  );
}
