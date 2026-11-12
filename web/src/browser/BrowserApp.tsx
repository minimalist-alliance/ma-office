// The Browser app's window itself: the driver, the address bar and the picture (design 6, docs/interfaces/desk-runtime.md 8).
// Everything that changes often stays out of React: see `driver.ts`. It is a chunk of its own, which `apps/registry.tsx`
// fetches once the office is idle, so none of it is part of the first paint. The calm states that Notebook, Agent and
// Commons borrow stay in `BrowserWindow.tsx`.
import { lazy, memo, Suspense, type ComponentType, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { AppWindowProps } from '../apps/registry';
import { Icon } from '../chrome/icons';
import { noteDeskInput, useDeskLink, useFrozen, useLive, useResuming } from '../desk/liveStore';
import { windowVm } from '../desk/windowVm';
import { useDeskStore } from '../state/deskStore';
import { deskSaysPaused } from '../bandwidth/store';
import { useFree } from '../free/door';
import { keyAction } from '../desk/rtc/input';
import { BrowserBar } from './BrowserBar';
import { CLOSED_PANELS, PanelBody } from './BrowserWindow';
import { BrowserDriver } from './driver';
import { DownloadNote } from './DownloadNote';
import { useSignInsUi } from './extensions/ExtTools';
import type { PasswordsPanelProps } from './extensions/PasswordsPanel';
import { noteStreamInput } from './handoff';
import { HandoffNote } from './HandoffNote';
import { SEEN_PREF } from './openOnDevice';
import { ProtectedNote } from './ProtectedNote';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { setLayoutPref } from '../shell/layoutSync';
import { browserPanel } from './panel';
import { bindStreamInput, isMacPlatform } from './streamInput';
import { isPhoneScreen } from './phoneView';
import { TouchHint, TouchRow } from './TouchRow';
import { useSession } from '../platform/session';
import { simpleViewOn } from '../simple/flag';
import { SimpleUi } from '../simple/ui';
import type { SimpleLayerProps } from '../simple/SimpleLayer';

/**
 * The simple view (task 47) is its own chunk, asked for as a window opens, unless client-config's kill switch is set. It
 * resolves once its own stylesheet has loaded (`ready` in `SimpleLayer.tsx`), so the view never draws unstyled. It's
 * fetched from this window's own chunk, after the stream has started, so the window never waits on it.
 */
const loadSimple = () => import('../simple/SimpleLayer').then((chunk) => chunk.ready());

/**
 * The chunk or its stylesheet didn't load (a network blip): the window steps aside to the real page, as a desk without
 * the view would, and the stream starts `live`. Never a held stream or a broken window for want of the view.
 */
function SimpleUnavailable({ ui }: SimpleLayerProps) {
  useLayoutEffect(() => {
    ui.set({ available: false, covering: false, stream: 'off', line: null, decision: { view: 'full', canSwitch: false, why: 'unsupported' } });
  }, [ui]);
  return null;
}
const SimpleLayer = lazy(() => loadSimple().catch(() => ({ default: SimpleUnavailable })));

/** Passwords and sign-ins (#11, spec section 9): its own chunk, fetched the first time the panel opens. None if it can't load. */
const PasswordsPanel = lazy((): Promise<{ default: ComponentType<PasswordsPanelProps> }> => import('./extensions/PasswordsPanel').catch(() => ({ default: () => null })));

/** Open on this device's first-use card stays this long, and the bar's note after it this long (#9). */
const OPENED_CARD_MS = 8_000;
const OPENED_NOTE_MS = 3_000;
const OPENED_FIRST_WORDS = "Opened on this device, where you may need to sign in. Your desk's sign-ins stay on your desk.";

/** The first time for the account, a card in the picture says what happened; each later time, the bar's note does. */
function useOpenedOnDevice(): { opened: 'card' | 'note' | null; onOpened: () => void; dismiss: () => void } {
  const [opened, setOpened] = useState<{ kind: 'card' | 'note'; n: number } | null>(null);
  const onOpened = useCallback(() => {
    const first = useLayoutPrefs.getState()[SEEN_PREF] !== true;
    if (first) setLayoutPref({ [SEEN_PREF]: true });
    setOpened((was) => ({ kind: first ? 'card' : 'note', n: (was?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (!opened) return undefined;
    const timer = window.setTimeout(() => setOpened(null), opened.kind === 'card' ? OPENED_CARD_MS : OPENED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [opened]);
  const dismiss = useCallback(() => setOpened(null), []);
  return { opened: opened?.kind ?? null, onOpened, dismiss };
}

/** The picture. It renders once: what changes after that goes straight to the element. */
const StreamVideo = memo(function StreamVideo({ driver, deskId, keysRef, onAddress, covered, describedBy, keysDescribedBy }: { driver: BrowserDriver; deskId: string; keysRef: RefObject<HTMLTextAreaElement | null>; onAddress: () => void; covered: boolean; describedBy: string; keysDescribedBy: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const heldRef = useRef<HTMLCanvasElement>(null);
  // A layout effect, so it runs in the task of the click that opened the window (desk-runtime.md 8.5's `play()`).
  useLayoutEffect(() => {
    const video = ref.current;
    return video ? driver.attachVideo(video, heldRef.current) : undefined;
  }, [driver]);
  useLayoutEffect(() => {
    const video = ref.current;
    const keys = keysRef.current;
    if (!video || !keys) return undefined;
    return bindStreamInput({
      video,
      keys,
      input: driver.input,
      isMac: isMacPlatform(),
      onAddress,
      onText: driver.insertText,
      onPaste: driver.paste,
      onCopyGesture: driver.copyGesture,
      onFocusChange: driver.setStreamFocused,
      onInput: () => {
        noteDeskInput(deskId, false);
        noteStreamInput(deskId); // the device the member clicks from is the one a hand-off shows on (#9)
      },
      onTouch: () => driver.noteTouch(useSession.getState().me?.userId ?? null),
      onTouchGesture: driver.noteTouchGesture,
      onZoom: driver.setZoom,
      onTouchControl: driver.setTouchControl,
      region: driver.region,
      onSoftKeyboard: driver.setSoftKeyboard,
      onSoftState: driver.setSoftState,
    });
  }, [driver, deskId, keysRef, onAddress]);
  // On a phone, the box the picture fills is what the desk lays the page out for (`phoneView.ts`).
  useLayoutEffect(() => {
    const surface = ref.current?.parentElement;
    if (!surface || typeof ResizeObserver === 'undefined') return undefined;
    const tell = (): void => {
      const r = surface.getBoundingClientRect();
      driver.setPhoneBox(isPhoneScreen() ? { width: r.width, height: r.height } : null);
    };
    const observer = new ResizeObserver(tell);
    observer.observe(surface);
    tell();
    return () => {
      observer.disconnect();
      driver.setPhoneBox(null);
    };
  }, [driver]);
  // Under the simple view the surface is inert: nothing in it takes focus or a pointer (security review T47O-2).
  return (
    <div className="br-surface" inert={covered}>
      <video ref={ref} className="br-video" playsInline disablePictureInPicture disableRemotePlayback tabIndex={-1} aria-label="The page in this desk's browser" aria-describedby={describedBy} data-testid="browser-video" />
      <canvas ref={heldRef} className="br-held" hidden data-testid="browser-held" />
      <textarea ref={keysRef} className="br-keys" aria-label="Keyboard for the page in this desk's browser" aria-describedby={keysDescribedBy} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="browser-keys" />
      <div className="br-touch-layer" aria-hidden="true" />
    </div>
  );
});

export default function BrowserApp({ deskId, parked = false }: AppWindowProps) {
  const [driver] = useState(() => new BrowserDriver());
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const frozen = useFrozen(deskId);
  const resuming = useResuming(deskId) && !parked;
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === deskId));
  const freeDesk = useFree((s) => s.free === true);
  const view = useSyncExternalStore(driver.subscribe, driver.getView);
  const rootRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [isMac] = useState(isMacPlatform);
  const { opened, onOpened, dismiss: dismissOpened } = useOpenedOnDevice();
  // One card in the picture at a time: the desk's hand-off, then Open on this device's first use, then TD-225's note.
  const [handoffShown, setHandoffShown] = useState(false);

  const focusAddress = useCallback(() => addressRef.current?.focus(), []);
  const coversRef = useRef(false);
  /** The view's own scroll region, where reading goes on with the keyboard while the simple view covers the stream. */
  const focusView = useCallback(() => rootRef.current?.querySelector<HTMLElement>('[data-testid="simple-scroll"]')?.focus({ preventScroll: true }), []);
  // Leaving the address bar goes to what's on screen: the stream, or the simple view over it, never the stream under it
  // (security review T47O-2). With the view not drawn yet, the focus just leaves the address.
  const focusStream = useCallback(() => {
    if (!coversRef.current) {
      keysRef.current?.focus({ preventScroll: true });
      return;
    }
    focusView();
    if (document.activeElement === addressRef.current) addressRef.current?.blur();
  }, [focusView]);

  // The simple view, on unless client-config's kill switch says `enabled: false`: off, nothing of it runs and the window is
  // as it was.
  const simpleFlag = useSession((s) => simpleViewOn(s.config));
  const [simple] = useState(() => new SimpleUi());
  const simpleState = useSyncExternalStore(simple.subscribe, simple.get);
  useEffect(() => {
    if (simpleFlag) void loadSimple().catch(() => undefined);
  }, [simpleFlag]);
  useLayoutEffect(() => driver.setSimple(simpleFlag ? simpleState.stream : 'off'), [driver, simpleFlag, simpleState.stream]);
  const simpleCovers = simpleFlag && simpleState.covering;
  coversRef.current = simpleCovers;
  useLayoutEffect(() => driver.setCovered(simpleCovers), [driver, simpleCovers]);
  // The view came over the stream while it had the keyboard: the keyboard comes to the view.
  const streamHadKeys = view.streamFocused;
  useLayoutEffect(() => {
    if (simpleCovers && streamHadKeys) focusView();
    // Only as it starts covering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simpleCovers, focusView]);
  // And back: the view steps aside while it has the keyboard, which would fall to the office as the view goes, so the
  // keyboard comes to the stream, on screen again. Only from the view: a keyboard the member took elsewhere stays there.
  const viewHadKeys = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target;
      viewHadKeys.current = t instanceof Element && rootRef.current?.contains(t) === true && t.closest('[data-testid="simple-view"]') !== null;
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);
  useLayoutEffect(() => {
    if (simpleCovers || !viewHadKeys.current) return;
    viewHadKeys.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || now.closest('[data-testid="simple-view"]')) keysRef.current?.focus({ preventScroll: true });
  }, [simpleCovers]);

  // The address-bar keys work anywhere in this window, not only from the stream.
  useEffect(() => {
    const win = rootRef.current?.closest<HTMLElement>('.ma-window');
    if (!win) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (keyAction(e, isMac) !== 'address') return;
      e.preventDefault();
      focusAddress();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener('keydown', onKeyDown);
  }, [focusAddress, isMac]);

  useLayoutEffect(() => {
    driver.mount();
    return () => driver.unmount();
  }, [driver]);
  useLayoutEffect(() => driver.setLink(link), [driver, link]);
  useLayoutEffect(() => driver.setParked(parked), [driver, parked]);
  useLayoutEffect(() => driver.setFrozen(frozen), [driver, frozen]);
  // The desk's own bandwidth pause: `bandwidth/StreamPause.tsx` shows it in this window's place, before a paint.
  useLayoutEffect(() => {
    if (view.bandwidthPaused) deskSaysPaused(deskId, view.bandwidthResumesAt);
  }, [deskId, view.bandwidthPaused, view.bandwidthResumesAt]);
  // A free desk keeps it too: it stops after 30 minutes idle, so it often wakes (`free/door.ts`).
  const keepsScreen = desk?.startsWithOffice === true || freeDesk;
  useLayoutEffect(() => driver.setLastScreen(keepsScreen ? deskId : null), [driver, deskId, keepsScreen]);

  const panel = browserPanel({
    vm: windowVm(desk?.vm, link),
    phase: desk?.phase ?? null,
    queuePosition: desk?.queuePosition ?? null,
    link: live.link,
    unreachable: live.lostForSec >= 30,
    canPlayVideo: view.canPlayVideo,
    refused: view.refused,
    trying: view.trying,
    hasFrame: view.hasFrame,
    refusal: live.refusal,
    busy: live.busy,
    simple: simpleCovers,
    resuming,
  });
  // Over a picture a state is a scrim, so the last frame holds. With nothing to hold, it's the whole view. The last screen
  // kept in this browser (ma-platform ADR 0097) also holds while the desk sleeps and wakes, which is when it's shown.
  const overPicture =
    view.hadFrame &&
    (panel.kind === 'reconnecting' || panel.kind === 'unreachable' || panel.kind === 'stopping' || panel.kind === 'starting' || panel.kind === 'opening' || panel.kind === 'resting' ||
      panel.kind === 'resuming' ||
      (view.lastScreen && (panel.kind === 'asleep' || panel.kind === 'waking' || panel.kind === 'queued')));
  // A thaw takes about a tenth of a second, and the still covers it: "Resuming…" only past the same delay as starting.
  const delayed = panel.kind === 'starting' || panel.kind === 'opening' || panel.kind === 'resuming';
  // Touch control's page row, on a finger's screen (`(pointer: coarse)`, in CSS) while the real page shows with a picture.
  const touchRow = panel.kind === 'playing' && !simpleCovers;
  // Site sign-ins (#11): the key, Extensions and the panel, once the desk says it serves them, never for a teen.
  const simpleShown = simpleFlag && simpleState.available === true && simpleState.decision.view === 'simple';
  const signIns = useSignInsUi(deskId, link, live.link === 'open', view.tabs, panel.kind === 'playing' && !simpleShown);
  // What a screen reader hears of the picture (spec (f) section 7): it can't read it, and the simplified view can, if it can.
  const simplifies = simpleFlag && simpleState.decision.why !== 'fallback' && simpleState.decision.why !== 'unsupported';

  return (
    <div ref={rootRef} className={`br${view.soft.typing ? ' typing' : ''}`} data-testid="browser-app">
      <BrowserBar driver={driver} view={view} connected={live.link === 'open'} ready={panel.kind === 'playing'} closed={CLOSED_PANELS.has(panel.kind)} addressRef={addressRef} isMac={isMac} onLeaveAddress={focusStream} deskId={deskId} simple={simpleFlag ? simple : null} covered={simpleCovers} simpleShown={simpleShown} openedNote={opened === 'note'} onOpenedOnDevice={onOpened} signIns={signIns} />
      <div className={`br-view${touchRow ? ' with-row' : ''}`}>
        <span id={`${deskId}-picture-about`} className="sr-only">
          {simplifies ? "A picture of the page, which a screen reader can't read. Simplified shows it as text." : "A picture of the page, which a screen reader can't read. This page can't be simplified."}
        </span>
        {/* The keys box keeps Tab for the page, so a screen reader hears the way out the bar shows sighted members (WCAG 2.1.2). */}
        <span id={`${deskId}-keys-about`} className="sr-only">{`Typing goes to the page. ${isMac ? '⌘L' : 'Ctrl+L'} to leave.`}</span>
        {/* First in the picture, so its buttons come right after the bar's in the Tab order. */}
        <HandoffNote deskId={deskId} link={link} hidden={panel.kind !== 'playing'} onShown={setHandoffShown} />
        {opened === 'card' && !handoffShown && panel.kind === 'playing' && (
          <div className="br-card first-use" role="status" data-testid="browser-opened">
            <span className="br-card-one">{OPENED_FIRST_WORDS}</span>
            <button type="button" className="br-card-x" aria-label="Dismiss" title="Dismiss" onClick={dismissOpened}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        )}
        {view.canPlayVideo && <StreamVideo driver={driver} deskId={deskId} keysRef={keysRef} onAddress={focusAddress} covered={simpleCovers} describedBy={`${deskId}-picture-about`} keysDescribedBy={`${deskId}-keys-about`} />}
        {simpleFlag && link && live.link === 'open' && (
          <Suspense fallback={null}>
            <SimpleLayer deskId={deskId} link={link} driver={driver} ui={simple} tabs={view.tabs} />
          </Suspense>
        )}
        {panel.kind !== 'playing' && (
          <div className={`br-panel${overPicture ? ' over-picture' : ''}${delayed ? ' delayed' : ''}`} role="status" data-testid="browser-panel" data-panel={panel.kind}>
            <div className="br-panel-body">
              <PanelBody panel={panel} deskId={deskId} driver={driver} />
            </div>
          </div>
        )}
        <DownloadNote deskId={deskId} link={link} hidden={panel.kind !== 'playing'} />
        {view.touchHint && touchRow && <TouchHint onDismiss={driver.dismissTouchHint} phone={view.phone.mine} />}
        {touchRow && <TouchRow driver={driver} zoom={view.zoom} soft={view.soft} desktopSite={view.phone.served && isPhoneScreen() ? view.desktopSite : null} notice={view.notice} />}
        <ProtectedNote deskId={deskId} tabs={view.tabs} hidden={panel.kind !== 'playing' || handoffShown || opened === 'card'} />
        {signIns?.panel && (
          <Suspense fallback={null}>
            <PasswordsPanel ui={signIns} link={link} at={signIns.panel} />
          </Suspense>
        )}
        {view.muted && panel.kind === 'playing' && (!simpleCovers || simpleState.stream === 'island') && (
          <span className="br-muted" data-testid="browser-muted" title="Sound comes on with your first click or key">
            <Icon name="soundOff" size={16} />
          </span>
        )}
      </div>
    </div>
  );
}
