// Accessible mirror of the canvas (design 3.11): transparent, focusable DOM buttons at each desk's
// and tile's position, in a world-space container that takes the camera transform. It follows the
// camera at rest, and during a move only while one of its buttons holds focus, because the ring is
// drawn on it. Screen readers, voice control and Playwright getByRole all work through it.
import { memo, useEffect, useRef, useState } from 'react';
import { coveredTiles } from './covered';
import { useWindowStore } from '../state/windowStore';
import { shownDesk } from '../desk/attention';
import { camera } from '../canvas/controller';
import { countSlotW, deskGeometry, isAgentApp, slotRight, STRIP, stripTarget, switchFits, type LayoutDesk } from '../canvas/layout';
import { host, useDoor } from '../deskapps/door';
import { rosterAgent, teamWaiting, useRosterStore } from '../agent/roster';
import { stripControlSize } from '../canvas/etch';
import { isPhone, useIsPhone, useIsTouch } from '../canvas/phone';
import { statusLine } from '../desk/agentStatus';
import { trafficHold } from '../desk/trafficStop';
import { liveStatusInput, useLive } from '../desk/liveStore';
import { useFree } from '../free/door';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView, useViewStore } from '../state/viewStore';
import { appFocused, appLabel, focusDesk, focusProxy, openItem } from '../shell/actions';
import { cleanUpDesk, cleanupProxyId, needsCleanup, undoCleanup, useCleanup } from '../shell/cleanup';
import { hiddenLabel, hiddenOn, hiddenProxyId, noHiddenLabel, openHiddenList, RING_MS, useRing } from '../shell/hidden';
import { announce } from '../shell/announce';
import { useDesksStopped } from '../canvas/stopped';
import { appsInOrder } from '../shell/order';
import { carouselProxyId, switchLabel, toggleCarousel } from '../carousel/actions';
import { carouselOn } from '../carousel/model';

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
const DeskProxies = memo(function DeskProxies({ desk, layout, stop, covered }: { desk: DeskInfo; layout: LayoutDesk; stop: string | null; covered: string }) {
  const live = useLive(desk.id);
  // Agents' names label their own tiles (task 49): a rename on the desk is a new label here. So do installed apps' (ADR 0054).
  useRosterStore((s) => s.desks[desk.id]);
  useDoor((s) => s.rev);
  const phone = useIsPhone();
  const touch = useIsTouch();
  const geo = deskGeometry(layout, phone);
  const editing = useViewStore((s) => (s.kbEdit ? s.kbFocus : null));
  const proxyClass = (id: string): string => (editing === id ? 'proxy editing' : 'proxy');
  // Carousel mode (`carousel/`): the apps aren't on the desk to press, they're on its stage, so their buttons go.
  const carousel = !phone && carouselOn(layout);
  const switchId = carouselProxyId(desk.id);
  const switchEnd = slotRight('carousel', touch);
  // The icons scale with the desk, so whether the switch is in its row is the desk's own size, whatever the zoom.
  const sw = switchFits(geo.w, geo.h);
  // The buttons' order comes from where the apps are, never from the stack (ADR 0064). They hold still during
  // a keyboard edit: moving the focused button in the DOM would drop its focus.
  const order = useRef<readonly string[]>([]);
  if (!editing || !layout.items.some((i) => i.id === editing)) order.current = appsInOrder(layout.items, phone).map((i) => i.id);
  const byId = new Map(layout.items.map((i) => [i.id, i]));
  const keys = phone ? undefined : 'm r .';
  // The strip's control, for the keyboard and screen readers whether or not the canvas shows it just now.
  const undo = useCleanup((s) => s[desk.id]);
  const offering = !phone && !carousel && undo?.after === layout && undo.offered;
  const control = offering || (!phone && !carousel && needsCleanup(layout));
  const controlId = cleanupProxyId(desk.id);
  const size = stripControlSize(offering, touch);
  const end = slotRight('cleanup', touch, 0, sw);
  // The hidden count, for the keyboard and screen readers. Phones keep their grid, so nothing's hidden there.
  const stopped = useDesksStopped();
  const hiddenCount = phone || carousel || stopped ? 0 : hiddenOn(layout).length;
  const hiddenId = hiddenProxyId(desk.id);
  // Where the canvas draws it: past cleanup's slot while that's held (DeskPanel), and on touch it's held only on the active desk.
  const active = useViewStore((s) => s.activeDesk === desk.id);
  const held = offering || (control && (active || !touch));
  const countEnd = slotRight('count', touch, held ? size.w : 0, sw);
  const countW = countSlotW(touch);
  const target = stripTarget(touch);
  const saidCount = useRef(hiddenCount);
  useEffect(() => {
    // Behind card C or D the count isn't there to be said (the card is what's announced).
    if (stopped || saidCount.current === hiddenCount) {
      if (stopped) saidCount.current = hiddenCount;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      saidCount.current = hiddenCount;
      announce(hiddenCount ? hiddenLabel(hiddenCount, desk.name) : noHiddenLabel(desk.name));
    }, SAY_COUNT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hiddenCount, desk.name, stopped]);
  useEffect(() => {
    if (!hiddenCount && getView().kbFocus === hiddenId) focusProxy(desk.id);
  }, [hiddenCount, hiddenId, desk.id]);
  // When it goes away while it holds the keyboard, the desk takes the keyboard.
  useEffect(() => {
    if (!control && getView().kbFocus === controlId) focusProxy(desk.id);
  }, [control, controlId, desk.id]);
  const status = statusLine({
    vm: desk.vm, phase: desk.phase, queuePosition: desk.queuePosition, givebackUntil: desk.givebackUntil, stopReason: desk.stopReason, trafficStop: !!trafficHold(desk.stopDetail),
    ...liveStatusInput(live),
  }).label;
  return (
    <div role="group" aria-label={`${desk.name} desk`}>
      <button
        type="button"
        id={`proxy-${desk.id}`}
        className={proxyClass(desk.id)}
        data-desk={desk.id}
        data-kind={desk.kind}
        tabIndex={stop === desk.id ? 0 : -1}
        aria-keyshortcuts={keys}
        aria-label={`${desk.name} desk, ${layout.items.length} apps, ${status}`}
        style={{ left: layout.x, top: layout.y, width: geo.w, height: geo.h }}
        onFocus={() => setView({ kbFocus: desk.id })}
        onClick={() => focusDesk(desk.id)}
      />
      {!carousel && order.current.map((id) => {
        const it = byId.get(id);
        const slot = geo.slots[id];
        if (!it || !slot) return null;
        // An installed app's (`app:` ids, none of the desk's `summary`) comes from the desk app host.
        const sum = live.apps[it.app] ?? host?.summary(desk.id, it.app);
        const deskCount = sum?.badge ?? desk.badges[it.app] ?? 0;
        // An installed app that's stopped by a problem says so in its name, in the contract's words (section 2.6).
        const problem = (sum as { problem?: string } | undefined)?.problem;
        // The lead's tile counts the team's waiting requests where the desk's own word says fewer (S-14), as the canvas does.
        const count = (isAgentApp(it.app) ? rosterAgent(it.app, desk.id)?.unseen : undefined) ?? (it.app === 'agent' ? Math.max(deskCount, teamWaiting(desk.id)) : deskCount);
        // The lead's tile speaks for the team's approvals; an agent's own counts its unseen replies.
        // An agent's own tile: its waiting requests first (S-14), then its unseen replies. A stopped desk says neither (main).
        const ownWaiting = isAgentApp(it.app) ? (rosterAgent(it.app, desk.id)?.waiting ?? 0) : 0;
        const suffix =
          count <= 0 || stopped
            ? ''
            : it.app === 'agent'
              ? `, ${count} need you`
              : ownWaiting > 0
                ? `, ${ownWaiting} ${ownWaiting === 1 ? 'request' : 'requests'} waiting${count > ownWaiting ? `, ${count - ownWaiting} unread` : ''}`
                : `, ${count} unread`;
        return (
          <button
            key={it.id}
            type="button"
            id={`proxy-${it.id}`}
            className={proxyClass(it.id)}
            tabIndex={stop === it.id && !covered.split(',').includes(it.id) ? 0 : -1}
            aria-keyshortcuts={keys}
            aria-label={`${appLabel(it.app, desk.id)}${problem ? `, ${problem}` : ''}${suffix}`}
            style={{ left: layout.x + slot.x, top: layout.y + slot.y, width: slot.w, height: slot.h }}
            onFocus={() => appFocused(desk.id, it.id)}
            onClick={() => openItem(desk.id, it.id)}
          />
        );
      })}
      {!phone && (
        <button
          type="button"
          id={`proxy-${switchId}`}
          className={`${proxyClass(switchId)} proxy-strip`}
          tabIndex={stop === switchId ? 0 : -1}
          aria-label={switchLabel(carousel)}
          aria-pressed={carousel}
          style={{
            left: layout.x + geo.w - switchEnd - target,
            top: layout.y + geo.h - STRIP.iconUp - target / 2,
            width: target,
            height: target,
          }}
          onFocus={() => setView({ kbFocus: switchId })}
          onClick={() => toggleCarousel(desk.id)}
        />
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          id={`proxy-${hiddenId}`}
          className={`${proxyClass(hiddenId)} proxy-strip`}
          tabIndex={stop === hiddenId ? 0 : -1}
          aria-label={hiddenLabel(hiddenCount, desk.name)}
          aria-haspopup="menu"
          style={{
            left: layout.x + geo.w - countEnd - countW,
            top: layout.y + geo.h - STRIP.iconUp - target / 2,
            width: countW,
            height: target,
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
          // The same size as what's drawn, which scales with the desk: this layer is in world units, and scales.
          style={{
            left: layout.x + geo.w - end - size.w,
            top: layout.y + geo.h - STRIP.iconUp - size.h / 2,
            width: size.w,
            height: size.h,
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
  // The free tier's empty desk spot (`free/door.ts`): one button, after the desks.
  const FreeSpot = useFree((s) => s.Proxy);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const write = (): void => {
      const el = ref.current;
      if (!el) return;
      const c = camera.cam;
      el.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
      el.style.setProperty('--ma-cam-s', String(c.s));
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
  const firstApp = activeDesk && layout[activeDesk] && !(carouselOn(layout[activeDesk]) && !isPhone()) ? appsInOrder(layout[activeDesk].items, isPhone())[0]?.id : undefined;
  const first = activeDesk ? (mode === 'overview' ? activeDesk : firstApp ?? activeDesk) : desks[0]?.id;
  // A tile its own open window covers is no Tab stop (O3): the desk's next uncovered place takes it.
  const windows = useWindowStore((s) => s.windows);
  const shown = useViewStore((s) => shownDesk(s));
  const [, settled] = useState(0);
  useEffect(() => camera.onSettle(() => settled((n) => n + 1)), []);
  const forceFull = typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
  const coveredOn = (id: string): string[] => {
    const l = layout[id];
    if (!l || id !== shown || isPhone()) return [];
    const g = deskGeometry(l, false);
    const tiles = l.items.flatMap((i) => {
      const sl = g.slots[i.id];
      return sl ? [{ id: i.id, rect: { x: l.x + sl.x, y: l.y + sl.y, w: sl.w, h: sl.h } }] : [];
    });
    return coveredTiles(id, tiles, Object.values(windows), camera.cam, { w: window.innerWidth, h: window.innerHeight }, forceFull);
  };
  const hiddenIds = new Map(desks.map((d) => [d.id, coveredOn(d.id)]));
  let tabStop = kbFocus ?? first ?? null;
  if (tabStop && [...hiddenIds.values()].some((ids) => ids.includes(tabStop as string))) {
    const own = [...hiddenIds.entries()].find(([, ids]) => ids.includes(tabStop as string))![0];
    const l = layout[own];
    const free = l ? appsInOrder(l.items, isPhone()).find((i) => !hiddenIds.get(own)!.includes(i.id)) : undefined;
    tabStop = free?.id ?? own;
  }

  return (
    // The main landmark around this layer names it "Desks" (Shell), so it needs no name of its own.
    <div ref={ref} className="proxy-layer" onContextMenu={(e) => e.preventDefault()}>
      {desks.map((d) => {
        const l = layout[d.id];
        if (!l) return null;
        const holds = tabStop === d.id || tabStop === cleanupProxyId(d.id) || tabStop === hiddenProxyId(d.id) || tabStop === carouselProxyId(d.id) || !!l.items.some((i) => i.id === tabStop);
        return <DeskProxies key={d.id} desk={d} layout={l} stop={holds ? tabStop : null} covered={(hiddenIds.get(d.id) ?? []).join(',')} />;
      })}
      {FreeSpot && <FreeSpot />}
      <HiddenRing />
    </div>
  );
}
