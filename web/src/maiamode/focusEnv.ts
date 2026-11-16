// The page's half of the observer in every view (the focus shield; deskd API.md §23 `focus`): what's in front and what the member
// is doing, read from the office's own stores and from passive, capture-phase input listeners. Installed once by the office's
// start while Desk Maia is on (`shieldStart.ts`), and read by the one sender (`focusSource.ts`).
//
// A call or a screen share (`dnd.ts`: Commons voice, the Privacy shield, any later source) is `call` / `share`: on or off only.
//
// Cheap by design (the six-desks-per-host frame budget): passive listeners that each cost a time check, no canvas work, no per-key
// timer (one timeout for the next edge, rescheduled only when it fires), nothing at all on a timer while the tab is hidden, and a
// pointer move counted at most once a second. **Never** a URL, a title, a tab, a key, any text or the clipboard: a key press is
// only a time.
import { isPhone } from '../canvas/phone';
import { phoneApp, usePhoneCarousel } from '../carousel/phone';
import { useDeskStore } from '../state/deskStore';
import { focusEntryOf, watchFocusItems } from '../state/focusItems';
import { useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';
import { takeSnapshot, type Snapshot } from './back';
import { callOn, onDnd, shareOn } from './dnd';
import { useMaiaMode } from './door';
import { deviceId, folderRef, FocusEvents, InputClock, type FocusFacts, type FocusRef } from './focus';
import type { FocusEnv } from './focusSource';
import { roomViewport, watchRoomViewport } from './roomView';


/** The Files folders this page has hashed (path → `h-…`): the path never leaves the browser. */
const folders = new Map<string, string>();

/** What's in front: the desk, its kind, the app and its item, its people (pure reads of the stores). */
function front(): Pick<FocusFacts, 'surface' | 'scope' | 'deskId' | 'deskKind' | 'app' | 'item' | 'people'> & { path: string | null } {
  const view = useViewStore.getState();
  const room = useMaiaMode.getState().room;
  const surface: FocusFacts['surface'] = room ? 'room' : isPhone() ? 'phone' : view.mode === 'overview' ? 'overview' : 'desk';
  let deskId: string | null = null;
  let app: string | null = null;
  if (room) {
    const roomView = roomViewport();
    deskId = roomView?.deskId ?? null;
    app = roomView?.app ?? 'maia';
  } else if (view.mode !== 'overview') {
    deskId = view.activeDesk;
    const { windows, active } = useWindowStore.getState();
    const win = active ? windows[active] : undefined;
    if (win && !win.closing && win.deskId === deskId) app = win.app;
    else if (deskId) {
      const desk = useLayoutStore.getState().desks[deskId];
      if (desk && isPhone()) app = phoneApp(desk, usePhoneCarousel.getState().shown);
      else if (desk?.carousel?.on) app = desk.carousel.app ?? null;
    }
  }
  const deskKind = deskId ? (useDeskStore.getState().desks.find((d) => d.id === deskId)?.kind ?? null) : null;
  const entry = deskId && app ? focusEntryOf(deskId, app) : undefined;
  let item: FocusRef | null = null;
  let path: string | null = null;
  if (entry?.item) {
    if (entry.item.kind === 'folder') {
      path = entry.item.path;
      const ref = folders.get(path);
      item = ref ? { kind: 'folder', id: ref } : null;
    } else item = { kind: entry.item.kind, id: entry.item.id };
  }
  return { surface, scope: view.scope, deskId, deskKind, app, item, people: entry?.people ?? [], path };
}

/** A call or a screen share is on (`dnd.ts`); the Privacy shield counts as a share: someone else can see the screen. */
const callNow = (): boolean => callOn();
const shareNow = (): boolean => shareOn() || useViewStore.getState().privacyShield;

const visibleNow = (): boolean => document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus());

export function makeFocusEnv(): FocusEnv {
  const device = deviceId();
  const clock = new InputClock(Date.now());
  const events = new FocusEvents();
  return {
    facts() {
      const f = front();
      return { surface: f.surface, scope: f.scope, deskId: f.deskId, deskKind: f.deskKind, app: f.app, item: f.item, people: f.people, input: clock.state, call: callNow(), share: shareNow(), visible: visibleNow(), device };
    },
    start(changed, event) {
      let timer = 0;
      let timerAt = Number.POSITIVE_INFINITY;
      let moveAt = 0;
      const flush = (): void => {
        for (const e of events.take()) event(e.kind, e.at);
      };
      /** One timeout, at the next edge (typing's end, idle, an action's 5 s), and only while the tab can be seen. */
      const plan = (): void => {
        const next = Math.min(clock.nextAt() ?? Number.POSITIVE_INFINITY, events.nextAt() ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(next) || document.visibilityState === 'hidden') {
          window.clearTimeout(timer);
          timerAt = Number.POSITIVE_INFINITY;
          return;
        }
        if (next >= timerAt) return;
        window.clearTimeout(timer);
        timerAt = next;
        timer = window.setTimeout(fire, Math.max(0, next - Date.now()) + 5);
      };
      const fire = (): void => {
        timerAt = Number.POSITIVE_INFINITY;
        const t = Date.now();
        if (clock.tick(t)) changed();
        if (events.tick(t)) flush();
        plan();
      };
      const onKey = (): void => {
        const t = Date.now();
        events.input(t);
        if (clock.key(t)) changed();
        plan();
      };
      const onPress = (): void => {
        const t = Date.now();
        events.input(t);
        if (clock.input(t)) changed();
        plan();
      };
      const onMove = (): void => {
        const t = Date.now();
        if (t - moveAt < 1_000) return;
        moveAt = t;
        if (clock.input(t)) changed();
        plan();
      };
      const onSeen = (): void => {
        if (document.visibilityState === 'hidden' && clock.hidden()) changed();
        else if (document.visibilityState === 'visible') fire();
        changed();
        plan();
      };
      const opts: AddEventListenerOptions = { capture: true, passive: true };
      window.addEventListener('keydown', onKey, opts);
      for (const type of ['pointerdown', 'wheel', 'touchstart'] as const) window.addEventListener(type, onPress, opts);
      window.addEventListener('pointermove', onMove, opts);
      document.addEventListener('visibilitychange', onSeen);
      window.addEventListener('focus', onSeen);
      window.addEventListener('blur', onSeen);

      // What's in front: the stores, the apps' own items (a folder is hashed here first), her room's viewport.
      let last = '';
      const look = (): void => {
        const f = front();
        if (f.path && !folders.has(f.path)) {
          const path = f.path;
          void folderRef(path).then(
            (ref) => {
              folders.set(path, ref);
              look();
            },
            () => undefined,
          );
        }
        const key = JSON.stringify([f.surface, f.scope, f.deskId, f.app, f.item, f.people]);
        if (key === last) return;
        last = key;
        changed();
      };
      // A window that closes is a coarse break, said at once.
      let open = new Set(Object.values(useWindowStore.getState().windows).filter((w) => !w.closing).map((w) => w.key));
      const offWindows = useWindowStore.subscribe((s) => {
        const now = new Set(Object.values(s.windows).filter((w) => !w.closing).map((w) => w.key));
        for (const k of open) if (!now.has(k) && events.add('window_closed', Date.now())) flush();
        open = now;
        look();
      });
      const offView = useViewStore.subscribe((s, was) => {
        if (s.mode !== was.mode || s.activeDesk !== was.activeDesk || s.scope !== was.scope) look();
        if (s.privacyShield !== was.privacyShield) changed();
      });
      // A call or a share starting or ending: the desk holds cards while it's on, and its end is a coarse break.
      const offDnd = onDnd(changed);
      const offRoom = useMaiaMode.subscribe((s, was) => {
        if (s.room !== was.room) look();
      });
      const offLayout = useLayoutStore.subscribe((s, was) => {
        const id = useViewStore.getState().activeDesk;
        if (id && s.desks[id]?.carousel !== was.desks[id]?.carousel) look();
      });
      const offPhone = usePhoneCarousel.subscribe(() => look());
      const offItems = watchFocusItems(look, (kind) => {
        events.add(kind, Date.now());
        plan();
      });
      const offRoomView = watchRoomViewport(look);
      look();
      plan();
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener('keydown', onKey, opts);
        for (const type of ['pointerdown', 'wheel', 'touchstart'] as const) window.removeEventListener(type, onPress, opts);
        window.removeEventListener('pointermove', onMove, opts);
        document.removeEventListener('visibilitychange', onSeen);
        window.removeEventListener('focus', onSeen);
        window.removeEventListener('blur', onSeen);
        offWindows();
        offView();
        offDnd();
        offRoom();
        offLayout();
        offPhone();
        offItems();
        offRoomView();
      };
    },
  };
}

/** This browser's working set now, for Back: kept in memory under the card that just appeared (`back.ts`). */
export function snapshotNow(cardId: string): Snapshot {
  const view = useViewStore.getState();
  const { windows, active } = useWindowStore.getState();
  const f = front();
  return takeSnapshot({
    cardId,
    at: Date.now(),
    surface: f.surface,
    camera: view.mode,
    deskId: view.activeDesk,
    windows: Object.values(windows),
    active,
    item: f.item,
    viewport: useMaiaMode.getState().room ? roomViewport() : null,
  });
}
