// Component tree of design 3.13: the signed-in app.
import { lazy, Suspense, useEffect, useState } from 'react';
import { LiveRegion } from '../a11y/LiveRegion';
import { ProxyLayer } from '../a11y/ProxyLayer';
import { BandwidthCircle } from '../bandwidth/BandwidthCircle';
import { useFree } from '../free/door';
import { camera } from '../canvas/controller';
import { isPhone } from '../canvas/phone';
import { fontsReady } from '../canvas/font';
import { etchRasters, glassLensStats, panelRasterCount, spriteBytes, spriteCount, tileRasterCount } from '../canvas/sprites';
import { textureLoads } from '../canvas/textureHub';
import { WorldStage } from '../canvas/WorldStage';
import { BottomBar } from '../chrome/BottomBar';
import { OfficeNotice } from '../chrome/DeskClosed';
import { useOfficeReady } from '../chrome/loadingOverlay';
import { isAccountClosed, useAccountClosed } from '../platform/accountClosed';
import { TopBar } from '../chrome/TopBar';
import { setOfficeShown } from '../desk/liveStore';
import { GuildLayer, GuildPrivacy, GuildRemovedNotices } from '../guild/GuildLayer';
import { SettingsLayer } from '../settings/SettingsLayer';
import { TourMount } from '../tour/door';
import { WelcomeMount } from '../welcome/door';
import { useWelcomeDoor } from '../welcome/store';
import { SetupMount } from '../setup/door';
import '../guild/guildStore';
import { MaiaMount } from '../maia/MaiaMount';
import { OpenNoticesDoor, OpenSheetDoor } from '../open/door';
import { prefetchNotebook } from '../notebook/prefetch';
import { freshTierNames, rereadMe, useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { watchFlatGround } from '../theme/ground';
import { WindowLayer } from '../windows/WindowLayer';
import { watchDeskInput } from './deskInput';
import { noDeskNotice } from './deskNotice';
import { startLayoutSync } from './layoutSync';
import { useLayoutPrefs } from './layoutPrefs';
import { watchAgentTiles } from '../agent/roster';
import { watchAppTiles } from '../apps/tiles';
import { setPlaceScale } from '../canvas/placeScale';
import { host, useDoor } from '../deskapps/door';
// An app's tile in the layout loads the desk app host's chunk (ADR 0054), from the first layout on.
import '../deskapps/watch';
import type { AppId } from '../canvas/layout';
import { useKeyboard } from './useKeyboard';
import { watchCarouselWindows } from '../carousel/actions';
import { deskScaleFor, watchOpenTiles } from './actions';
import { carouselOn } from '../carousel/model';
import { usePhoneCarousel } from '../carousel/phone';
import { useLayoutStore } from '../state/layoutStore';
import { loadOpenTiles, useOpenNeeded } from '../opentile/door';
import { maiaModeWanted, roomChunk, startMaiaMode, useMaiaMode } from '../maiamode/door';
import { onDemand, useOnDemand } from '../lib/onDemand';
import { withWindows } from '../apps/chunks';

// Three popups that draw nothing until a member opens them: their code loads beside the first paint, not before it.
const DeskMenu = lazy(() => import('../chrome/DeskMenu').then((m) => ({ default: m.DeskMenu })));
const HiddenList = lazy(() => import('../chrome/HiddenList').then((m) => ({ default: m.HiddenList })));
const EndedDeskPanel = lazy(() => import('../chrome/EndedDeskPanel').then((m) => ({ default: m.EndedDeskPanel })));
const RenameField = lazy(() => import('../chrome/RenameField').then((m) => ({ default: m.RenameField })));
// Carousel mode's stage: its own chunk, fetched when a desk is first switched to it, or on a load with one already on. A
// phone opens every app in it, so there it's fetched once the office is up, never waiting on the first tap. The stage draws
// its app from every app's window, so that chunk comes beside it (`withWindows`), never after it.
const loadCarousel = withWindows(() => import('../carousel/CarouselLayer'));
const CarouselLayer = lazy(loadCarousel);
const CAROUSEL_PREFETCH_MS = 1500;
// Open tiles (ADR 0053): an app enlarged on its desk is the live app there. Its own chunk, fetched when a tile first reaches
// `open` on the shown desk, or on a load with one; never with the kill switch off (`opentile/door.ts`).
const OpenTileLayer = lazy(loadOpenTiles);
// A request to close the account that its use stopped (`closehold/`, ma-platform contract auth.md section 2.7): its own
// chunk, fetched only while `/v1/me` carries that notice. Only its kind is read here; the chunk reads the rest.
const CloseHold = lazy(() => import('../closehold/Card'));
// The office's notice (`chrome/DeskNotice.tsx`: the membership cards, no desk yet, can't reach), its own chunk since
// `sub/mm-js-budget`: an office with desks never shows one. Fetched as the office mounts when this browser knows of no desks,
// since such an office ends in a card, so it's here before `/v1/me` answers; else once a notice is due. The loading
// overlay waits for it (or for it failing), as it does for the free tier's chunk.
const noticeChunk = onDemand(() => import('../chrome/DeskNotice'));
// A new release while the tab is open (`chrome/NewVersion.tsx`, the watch and its notice): its own chunk, fetched as the
// office mounts, since its first ask is a turn (15 minutes) away. A boot of a desk on the member's own computer
// (`chrome/BootNotices.tsx`): its own chunk, fetched once a desk in the list carries one.
const versionChunk = onDemand(() => import('../chrome/NewVersion'));
const bootsChunk = onDemand(() => import('../chrome/BootNotices'));

function markFirstPaint(then: () => void): void {
  requestAnimationFrame(() => {
    performance.mark('ma:first-canvas-paint');
    then();
    // The office background's layer (ADR 0094) comes after the first paint: its chunk, the manifest, then the picture.
    void import('../theme/backdrop').then((m) => m.mountBackdrop());
  });
}

export function Shell() {
  const [fonts, setFonts] = useState(false);
  const [notice, setNotice] = useState('');
  // The canvas's first paint, which the office tour waits for (ADR 0056).
  const [painted, setPainted] = useState(false);
  const status = useDeskStore((s) => s.status);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const anyEnded = useDeskStore((s) => s.desks.some((d) => d.ended));
  const me = useSession((s) => s.me);
  const closeHold = [me?.notices].flat().some((n) => n?.kind === 'close_hold_cancelled');
  const meFailed = useSession((s) => s.meFailed);
  // A closed account (`platform/accountClosed.ts`): its card, over its desks, and nothing that offers a way back in, a
  // tier or a trial (the free tier's lines, the setup circle, the usage circle, Maia, an ended Work desk's Move back up).
  const closedHeard = useAccountClosed((s) => s.heard);
  const closed = isAccountClosed(me, closedHeard);
  // The free tier (S-119): its own chunk, fetched only once `/v1/me` says free, does all of it (`free/door.ts`). Once a
  // page: it stays, so an upgrade plays its change from there.
  const free = me?.membership?.tier === 'free' && !closed;
  // The loading overlay waits for the free tier's chunk (ADR 0058), or for it failing, so its parts don't pop in after.
  const [freeFailed, setFreeFailed] = useState(false);
  useEffect(() => {
    // `npm run dev` has no network, so nothing is asked again there.
    if (free) void import('../free/office').then((m) => m.open(import.meta.env.DEV ? async () => {} : rereadMe), () => setFreeFailed(true));
  }, [free]);
  const { Office, Notices, free: freeIn } = useFree();
  const deskNotice = noDeskNotice({ list: status, me, meFailed, hasDesks, closedHeard });
  const DeskNotice = useOnDemand(noticeChunk, deskNotice ?? (!hasDesks && 'prefetch'))?.DeskNotice;
  const [noticeFailed, setNoticeFailed] = useState(false);
  useEffect(() => {
    if (!deskNotice) return undefined;
    // A chunk that didn't load is asked for again every 5 s while a notice is due (Security's JSB-I1): the overlay has let go
    // by then, and the card may be the one saying the office can't be reached.
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      noticeChunk.load().then(
        () => {
          if (live) setNoticeFailed(false);
        },
        () => {
          if (!live) return;
          setNoticeFailed(true);
          retry = setTimeout(ask, 5000);
        },
      );
    };
    ask();
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [deskNotice]);
  // The loader's overlay fades on the first frame drawn once the office's answers are in, or once a card stands in for
  // desks (ADR 0058).
  // Maia Mode (`maiamode/door.ts`): a page that started in the room mounts no canvas until the member leaves it, and the room
  // itself says when the office is ready; in the room the desks stay mounted underneath, hidden and inert, as they were.
  const room = useMaiaMode((s) => s.room);
  const roomBoot = useMaiaMode((s) => s.boot);
  const roomLayer = useMaiaMode((s) => s.layer);
  // Only a member `/v1/me` lists fetches the startup chunk (release 4's B4): the overlay waits for `/v1/me`, so it's still up
  // to be held. On, or an "off" still owed to the home desk, starts it whatever the gate says now: the off has to go
  // (Security's MR-M2).
  const maiaListed = me?.maiaMode?.enabled === true;
  const maiaKept = useLayoutPrefs((s) => maiaModeWanted(s['maiaMode']));
  const Room = useOnDemand(roomChunk, roomLayer && 'room')?.Room;
  useEffect(() => {
    if (maiaListed || maiaKept) startMaiaMode();
  }, [maiaListed, maiaKept]);
  useOfficeReady(
    fonts && !roomBoot,
    deskNotice !== null && (!!DeskNotice || noticeFailed),
    !free || freeIn === true || freeFailed,
    deskNotice !== null,
  );
  useKeyboard();
  // A desk in carousel mode, or an app a phone shows in its own (`carousel/phone.ts`).
  const anyCarousel = useLayoutStore((s) => Object.values(s.desks).some((d) => carouselOn(d)));
  const anyPhoneApp = usePhoneCarousel((s) => Object.values(s.shown).some((app) => app !== null));
  const openTiles = useOpenNeeded();

  useEffect(() => watchFlatGround(), []);
  useEffect(() => watchDeskInput(), []);
  useEffect(() => startLayoutSync(), []);
  const Boots = useOnDemand(bootsChunk, useDeskStore((s) => s.desks.some((d) => d.boot)) && 'boots');
  useEffect(() => Boots?.watchBoots(), [Boots]);
  useEffect(() => watchAgentTiles(), []);
  useEffect(() => {
    // The tiles the office places itself grow a full desk the way that keeps an open tile live on this screen.
    setPlaceScale(deskScaleFor);
    return () => setPlaceScale(null);
  }, []);
  useEffect(() => watchAppTiles(), []);
  // The Apps sheet's layer, once the desk app host's chunk is here (ADR 0054).
  const appsHost = useDoor((s) => s.host);
  useEffect(() => watchCarouselWindows(), []);
  useEffect(() => watchOpenTiles(), []);
  // The same ask brings the owner's tier names, so a tab left open picks up a rename of a tier.
  const Version = useOnDemand(versionChunk, 'version');
  useEffect(() => Version?.startVersionWatch((config) => freshTierNames(config.tierNames)), [Version]);
  useEffect(() => prefetchNotebook(), []);
  useEffect(() => {
    if (!isPhone()) return undefined;
    const timer = window.setTimeout(() => void loadCarousel().catch(() => {}), CAROUSEL_PREFETCH_MS);
    return () => window.clearTimeout(timer);
  }, []);
  // The office shows desks while this is mounted, so one of them can be looked at (task 46, `desk/attention.ts`).
  useEffect(() => {
    setOfficeShown(true);
    return () => setOfficeShown(false);
  }, []);
  useEffect(() => {
    void fontsReady().then(() => setFonts(true));
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const id = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Read-only hook for tests and perf runs. Not in a production bundle.
  useEffect(() => {
    if (import.meta.env.MODE === 'production') return;
    (window as unknown as Record<string, unknown>)['__maDesk'] = {
      camera, desksOpacity: () => camera.getStage()?.findOne('.desks')?.opacity() ?? null, spriteCount, spriteBytes, etchRasters, panelRasters: panelRasterCount, tileRasters: tileRasterCount, textureLoads, glassLensStats,
      // An installed app's tile widget as the canvas draws it (ADR 0054).
      appWidget: (deskId: string, app: AppId) => host?.summary(deskId, app)?.widget ?? null,
    };
  }, []);

  // Reading order: the banner, then the desks as the page's main landmark with their own controls and notices.
  // Windows and menus come after, on their own layers. Stacking is by z-index, so the order here moves nothing.
  // Maia's welcome (`welcome/door.tsx`): while it runs, the office waits behind her, hidden and inert, and the reveal lifts it.
  const welcome = useWelcomeDoor((s) => s.state === 'running' && !s.lifted);
  return (
    <div className={`ma-shell${room ? ' mm-on' : ''}${welcome ? ' wl-on' : ''}`}>
      {/* The office background (ADR 0094), under everything: painted by `theme/boot.ts` and then `theme/backdrop.ts`, outside React. */}
      <div className="ma-backdrop" aria-hidden="true" />
      <TopBar onNotice={setNotice} />
      <main className="desks-main" aria-label="Desks">
        {fonts && !roomBoot && <WorldStage onFirstPaint={() => markFirstPaint(() => setPainted(true))} />}
        {fonts && (anyCarousel || anyPhoneApp) && (
          <Suspense fallback={null}>
            <CarouselLayer />
          </Suspense>
        )}
        <ProxyLayer />
        {/* After the proxies, so a live tile's head (its stop) and its app follow the desk in the Tab order. */}
        {fonts && openTiles && (
          <Suspense fallback={null}>
            <OpenTileLayer />
          </Suspense>
        )}
        <BottomBar />
        {/* The setup circle (`setup/door.ts`): left of the usage circle on screen, so before it in the Tab order. */}
        {!closed && <SetupMount />}
        {!closed && <BandwidthCircle />}
        {Office && !closed && <Office />}
        {deskNotice && DeskNotice && <DeskNotice kind={deskNotice} />}
        {hasDesks && <OfficeNotice />}
        {/* A kept desk's panel; a membership card over the desks (C, D) already says what it would. */}
        {anyEnded && !closed && !deskNotice && (
          <Suspense fallback={null}>
            <EndedDeskPanel />
          </Suspense>
        )}
        {/* Notices stack up from just above the bottom bar, out of the flow, so no control moves for one. The one
            that stays longest is lowest, so the others come and go above it and it never moves either. */}
        <div className="notices">
          {Notices && !closed && <Notices />}
          {notice && <div className="notice ma-glass" role="status">{notice}</div>}
          <GuildRemovedNotices />
          <GuildPrivacy />
          {hasDesks && status === 'error' && (
            <div className="notice" role="status" data-testid="desks-stale">Can't reach Minimalist Alliance right now. Retrying.</div>
          )}
          <OpenNoticesDoor />
          {Boots && <Boots.BootNotices />}
          {closeHold && (
            <Suspense fallback={null}>
              <CloseHold />
            </Suspense>
          )}
          {Version && <Version.NewVersion />}
        </div>
        <LiveRegion />
      </main>
      {!closed && <MaiaMount />}
      <WindowLayer />
      <Suspense fallback={null}>
        <DeskMenu />
      </Suspense>
      <GuildLayer />
      {appsHost && <appsHost.AppsLayer />}
      <OpenSheetDoor />
      <SettingsLayer />
      {/* The office tour (ADR 0056): nothing here until a first visit or "Take the tour" fetches its chunk. A layer of the
          shell's own, as Account settings is, so it can hold the rest of the office inert. */}
      <TourMount closed={closed} painted={painted} onNotice={setNotice} />
      {/* Maia's welcome: nothing here unless this is a new member's first load, or "Set up my office with Maia". */}
      <WelcomeMount closed={closed} />
      <Suspense fallback={null}>
        <HiddenList />
        <RenameField />
      </Suspense>
      {Room && roomLayer && <Room />}
    </div>
  );
}
