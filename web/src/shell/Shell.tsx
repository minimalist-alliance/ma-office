// Component tree of design 3.13: the signed-in app.
import { lazy, Suspense, useEffect, useState } from 'react';
import { LiveRegion } from '../a11y/LiveRegion';
import { ProxyLayer } from '../a11y/ProxyLayer';
import { BandwidthCircle } from '../bandwidth/BandwidthCircle';
import { useFree } from '../free/door';
import { camera } from '../canvas/controller';
import { isPhone } from '../canvas/phone';
import { fontsReady } from '../canvas/font';
import { etchRasters, panelRasterCount, spriteCount } from '../canvas/sprites';
import { textureLoads } from '../canvas/textureHub';
import { WorldStage } from '../canvas/WorldStage';
import { BottomBar } from '../chrome/BottomBar';
import { DeskNotice } from '../chrome/CalmScreen';
import { OfficeNotice } from '../chrome/DeskClosed';
import { NewVersion } from '../chrome/NewVersion';
import { BootNotices } from '../chrome/BootNotices';
import { watchBoots } from '../platform/bootNotice';
import { TopBar } from '../chrome/TopBar';
import { setOfficeShown } from '../desk/liveStore';
import { GuildLayer, GuildPrivacy, GuildRemovedNotices } from '../guild/GuildLayer';
import { SettingsLayer } from '../settings/SettingsLayer';
import { SetupMount } from '../setup/door';
import '../guild/guildStore';
import { MaiaMount } from '../maia/MaiaMount';
import { OpenNoticesDoor, OpenSheetDoor } from '../open/door';
import { prefetchNotebook } from '../notebook/prefetch';
import { startVersionWatch } from '../platform/newVersion';
import { freshTierNames, rereadMe, useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { watchFlatGround } from '../theme/ground';
import { WindowLayer } from '../windows/WindowLayer';
import { watchDeskInput } from './deskInput';
import { noDeskNotice } from './deskNotice';
import { startLayoutSync } from './layoutSync';
import { watchAgentTiles } from '../agent/roster';
import { watchFilesTiles } from '../apps/files/tiles';
import { useKeyboard } from './useKeyboard';
import { watchCarouselWindows } from '../carousel/actions';
import { carouselOn } from '../carousel/model';
import { usePhoneCarousel } from '../carousel/phone';
import { useLayoutStore } from '../state/layoutStore';
import { loadOpenTiles, useOpenNeeded } from '../opentile/door';

// Three popups that draw nothing until a member opens them: their code loads beside the first paint, not before it.
const DeskMenu = lazy(() => import('../chrome/DeskMenu').then((m) => ({ default: m.DeskMenu })));
const HiddenList = lazy(() => import('../chrome/HiddenList').then((m) => ({ default: m.HiddenList })));
const EndedDeskPanel = lazy(() => import('../chrome/EndedDeskPanel').then((m) => ({ default: m.EndedDeskPanel })));
const RenameField = lazy(() => import('../chrome/RenameField').then((m) => ({ default: m.RenameField })));
// Carousel mode's stage: its own chunk, fetched when a desk is first switched to it, or on a load with one already on. A
// phone opens every app in it, so there it's fetched once the office is up, never waiting on the first tap.
const loadCarousel = () => import('../carousel/CarouselLayer');
const CarouselLayer = lazy(loadCarousel);
const CAROUSEL_PREFETCH_MS = 1500;
// Open tiles (ADR 0053): an app enlarged on its desk is the live app there. Its own chunk, fetched when a tile first reaches
// `open` on the shown desk, or on a load with one; never with the kill switch off (`opentile/door.ts`).
const OpenTileLayer = lazy(loadOpenTiles);

function markFirstPaint(): void {
  requestAnimationFrame(() => {
    performance.mark('ma:first-canvas-paint');
    // The office background's layer (ADR 0094) comes after the first paint: its chunk, the manifest, then the picture.
    void import('../theme/backdrop').then((m) => m.mountBackdrop());
  });
}

export function Shell() {
  const [fonts, setFonts] = useState(false);
  const [notice, setNotice] = useState('');
  const status = useDeskStore((s) => s.status);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const anyEnded = useDeskStore((s) => s.desks.some((d) => d.ended));
  const me = useSession((s) => s.me);
  const meFailed = useSession((s) => s.meFailed);
  // The free tier (S-119): its own chunk, fetched only once `/v1/me` says free, does all of it (`free/door.ts`). Once a
  // page: it stays, so an upgrade plays its change from there.
  const free = me?.membership?.tier === 'free';
  useEffect(() => {
    // `npm run dev` has no network, so nothing is asked again there.
    if (free) void import('../free/office').then((m) => m.open(import.meta.env.DEV ? async () => {} : rereadMe));
  }, [free]);
  const { Office, Notices } = useFree();
  const deskNotice = noDeskNotice({ list: status, me, meFailed, hasDesks });
  useKeyboard();
  // A desk in carousel mode, or an app a phone shows in its own (`carousel/phone.ts`).
  const anyCarousel = useLayoutStore((s) => Object.values(s.desks).some((d) => carouselOn(d)));
  const anyPhoneApp = usePhoneCarousel((s) => Object.values(s.shown).some((app) => app !== null));
  const openTiles = useOpenNeeded();

  useEffect(() => watchFlatGround(), []);
  useEffect(() => watchDeskInput(), []);
  useEffect(() => startLayoutSync(), []);
  useEffect(() => watchBoots(), []);
  useEffect(() => watchAgentTiles(), []);
  useEffect(() => watchFilesTiles(), []);
  useEffect(() => watchCarouselWindows(), []);
  // The same ask brings the owner's tier names, so a tab left open picks up a rename of a tier.
  useEffect(() => startVersionWatch((config) => freshTierNames(config.tierNames)), []);
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
    (window as unknown as Record<string, unknown>)['__maDesk'] = { camera, desksOpacity: () => camera.getStage()?.findOne('.desks')?.opacity() ?? null, spriteCount, etchRasters, panelRasters: panelRasterCount, textureLoads };
  }, []);

  // Reading order: the banner, then the desks as the page's main landmark with their own controls and notices.
  // Windows and menus come after, on their own layers. Stacking is by z-index, so the order here moves nothing.
  return (
    <div className="ma-shell">
      {/* The office background (ADR 0094), under everything: painted by `theme/boot.ts` and then `theme/backdrop.ts`, outside React. */}
      <div className="ma-backdrop" aria-hidden="true" />
      <TopBar onNotice={setNotice} />
      <main className="desks-main" aria-label="Desks">
        {fonts && <WorldStage onFirstPaint={markFirstPaint} />}
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
        <SetupMount />
        <BandwidthCircle />
        {Office && <Office />}
        {deskNotice && <DeskNotice kind={deskNotice} />}
        {hasDesks && <OfficeNotice />}
        {anyEnded && (
          <Suspense fallback={null}>
            <EndedDeskPanel />
          </Suspense>
        )}
        {/* Notices stack up from just above the bottom bar, out of the flow, so no control moves for one. The one
            that stays longest is lowest, so the others come and go above it and it never moves either. */}
        <div className="notices">
          {Notices && <Notices />}
          {notice && <div className="notice" role="status">{notice}</div>}
          <GuildRemovedNotices />
          <GuildPrivacy />
          {hasDesks && status === 'error' && (
            <div className="notice" role="status" data-testid="desks-stale">Can't reach Minimalist Alliance right now. Retrying.</div>
          )}
          <OpenNoticesDoor />
          <BootNotices />
          <NewVersion />
        </div>
        <LiveRegion />
      </main>
      <MaiaMount />
      <WindowLayer />
      <Suspense fallback={null}>
        <DeskMenu />
      </Suspense>
      <GuildLayer />
      <OpenSheetDoor />
      <SettingsLayer />
      <Suspense fallback={null}>
        <HiddenList />
        <RenameField />
      </Suspense>
    </div>
  );
}
