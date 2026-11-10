// Component tree of design 3.13: the signed-in app.
import { lazy, Suspense, useEffect, useState } from 'react';
import { LiveRegion } from '../a11y/LiveRegion';
import { ProxyLayer } from '../a11y/ProxyLayer';
import { BandwidthCircle } from '../bandwidth/BandwidthCircle';
import { camera } from '../canvas/controller';
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
import '../guild/guildStore';
import { MaiaMount } from '../maia/MaiaMount';
import { prefetchNotebook } from '../notebook/NotebookWindow';
import { startVersionWatch } from '../platform/newVersion';
import { freshTierNames, useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { watchFlatGround } from '../theme/ground';
import { WindowLayer } from '../windows/WindowLayer';
import { watchDeskInput } from './deskInput';
import { noDeskNotice } from './deskNotice';
import { startLayoutSync } from './layoutSync';
import { watchAgentTiles } from '../agent/roster';
import { watchFilesTiles } from '../apps/files/tiles';
import { useKeyboard } from './useKeyboard';

// Three popups that draw nothing until a member opens them: their code loads beside the first paint, not before it.
const DeskMenu = lazy(() => import('../chrome/DeskMenu').then((m) => ({ default: m.DeskMenu })));
const HiddenList = lazy(() => import('../chrome/HiddenList').then((m) => ({ default: m.HiddenList })));
const RenameField = lazy(() => import('../chrome/RenameField').then((m) => ({ default: m.RenameField })));

function markFirstPaint(): void {
  requestAnimationFrame(() => {
    performance.mark('ma:first-canvas-paint');
  });
}

export function Shell() {
  const [fonts, setFonts] = useState(false);
  const [notice, setNotice] = useState('');
  const status = useDeskStore((s) => s.status);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const me = useSession((s) => s.me);
  const meFailed = useSession((s) => s.meFailed);
  const deskNotice = hasDesks ? null : noDeskNotice({ list: status, me, meFailed });
  useKeyboard();

  useEffect(() => watchFlatGround(), []);
  useEffect(() => watchDeskInput(), []);
  useEffect(() => startLayoutSync(), []);
  useEffect(() => watchBoots(), []);
  useEffect(() => watchAgentTiles(), []);
  useEffect(() => watchFilesTiles(), []);
  // The same ask brings the owner's tier names, so a tab left open picks up a rename of a tier.
  useEffect(() => startVersionWatch((config) => freshTierNames(config.tierNames)), []);
  useEffect(() => prefetchNotebook(), []);
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
    (window as unknown as Record<string, unknown>)['__maDesk'] = { camera, spriteCount, etchRasters, panelRasters: panelRasterCount, textureLoads };
  }, []);

  // Reading order: the banner, then the desks as the page's main landmark with their own controls and notices.
  // Windows and menus come after, on their own layers. Stacking is by z-index, so the order here moves nothing.
  return (
    <div className="ma-shell">
      <TopBar onNotice={setNotice} />
      <main className="desks-main" aria-label="Desks">
        {fonts && <WorldStage onFirstPaint={markFirstPaint} />}
        <ProxyLayer />
        <BottomBar />
        <BandwidthCircle />
        {deskNotice && <DeskNotice kind={deskNotice} />}
        {hasDesks && <OfficeNotice />}
        {/* Notices stack up from just above the bottom bar, out of the flow, so no control moves for one. The one
            that stays longest is lowest, so the others come and go above it and it never moves either. */}
        <div className="notices">
          {notice && <div className="notice" role="status">{notice}</div>}
          <GuildRemovedNotices />
          <GuildPrivacy />
          {hasDesks && status === 'error' && (
            <div className="notice" role="status" data-testid="desks-stale">Can't reach Minimalist Alliance right now. Retrying.</div>
          )}
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
      <SettingsLayer />
      <Suspense fallback={null}>
        <HiddenList />
        <RenameField />
      </Suspense>
    </div>
  );
}
