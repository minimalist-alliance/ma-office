// An installed app's window body (contract 3.2, ADR 0054), once the desk can answer. A stopped app says why in the contract's words, with Restart (`apps.start`). Otherwise: the view's files from
// `apps.view.get`, checked (`verify.ts`) before anything is built; the sandboxed `srcdoc` frame (`frame.ts`); once its boot says
// the view runs, the bridge (`bridge.ts`) on a `MessagePort` with the theme's tokens; and the frame budget (`budget.ts`). A view
// that fails its checks, or navigates its frame away, gets the calm "couldn't be opened safely" and nothing more.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppWindowProps } from '../../apps/registry';
import type { AppId } from '../../canvas/layout';
import { noteDeskInput, useDeskLink, useLive } from '../../desk/liveStore';
import { useDeskStore } from '../../state/deskStore';
import { shared } from './deps';
import { deskApp, deskAppIdOf } from './ids';
import { useTheme } from '../../theme/themeStore';
import { appOpenable, installedApp, useDeskAppsStore, type AppRecord } from './store';
import { problemWords } from './widget';
import bootUrl from './boot.js?url';
import { ViewBridge } from './bridge';
import { watchFrames } from './budget';
import { fontBytes, forgetView, viewFor } from './cache';
import { FRAME_ALLOW, SANDBOX, viewSrcdoc } from './frame';
import { liveDeskLink } from './link';
import { VIEW_FONT_FAMILY, viewTokens } from './tokens';
import type { VerifiedView } from './verify';
import { codeOf } from './wire';
import { START_FAILED, W } from './words';

/** The boot has this long to say the view runs before the window says it couldn't start. */
const BOOT_TIMEOUT_MS = 8000;

function Panel({ title, line, children, kind }: { title?: string; line?: string; children?: ReactNode; kind: string }) {
  return (
    <div className="br-panel" role="status" data-testid="deskapp-panel" data-panel={kind}>
      <div className="br-panel-body">
        {title && <h3>{title}</h3>}
        {line && <p>{line}</p>}
        {children}
      </div>
    </div>
  );
}

/** A stopped app: the contract's words, and Restart where starting it again can help. */
function Stopped({ deskId, rec, words }: { deskId: string; rec: AppRecord; words: string }) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const restartable = rec.state === 'failed' && rec.problem !== 'needs_update' && rec.problem !== 'revoked';
  const restart = (): void => {
    const link = liveDeskLink(deskId);
    if (!link) return;
    setBusy(true);
    setLine(null);
    link.call('apps.start', { id: rec.id }).then(
      () => setBusy(false),
      () => {
        setBusy(false);
        setLine(START_FAILED);
      },
    );
  };
  return (
    <Panel title={words} kind="stopped">
      {line && <p>{line}</p>}
      {restartable && (
        <button type="button" className="btn primary" disabled={busy} aria-busy={busy} onClick={restart} data-testid="deskapp-restart">
          {busy ? W.starting : W.restart}
        </button>
      )}
    </Panel>
  );
}

type Phase = 'checking' | 'booting' | 'ready' | 'unsafe' | 'failed' | 'noWindow';

/** The view itself, once the desk can answer: checked, framed and bridged. */
function ViewFrame({ deskId, rec, parked }: { deskId: string; rec: AppRecord; parked: boolean }) {
  const [view, setView] = useState<VerifiedView | null>(null);
  const [font, setFont] = useState<Uint8Array | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ViewBridge | null>(null);
  const theme = useTheme((s) => s.resolved);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // The files, checked, and the font, both before the frame is made.
  useEffect(() => {
    let gone = false;
    setPhase('checking');
    setView(null);
    Promise.all([viewFor(deskId, rec.id, rec.version), fontBytes()]).then(
      ([verdict, bytes]) => {
        if (gone) return;
        setFont(bytes);
        if (verdict.ok) {
          setView(verdict.view);
          setPhase('booting');
        } else setPhase('unsafe');
      },
      (err: unknown) => {
        if (!gone) setPhase(codeOf(err).code === 'not_found' ? 'noWindow' : 'failed');
      },
    );
    return () => {
      gone = true;
    };
  }, [deskId, rec.id, rec.version, attempt]);

  // The frame: its boot says whether the view runs, then the view gets its bridge. A second load is the view navigating away.
  useEffect(() => {
    const el = frame.current;
    if (!view || !el || paused) return undefined;
    let loads = 0;
    let done = false;
    const end = (next: Phase): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      bridge.current?.close();
      bridge.current = null;
      setPhase(next);
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== el.contentWindow || bridge.current || done) return;
      const d = e.data as { t?: unknown; ok?: unknown } | null;
      if (!d || d.t !== 'ma.boot') return;
      if (d.ok !== true) {
        end('failed');
        return;
      }
      window.clearTimeout(timer);
      const ch = new MessageChannel();
      bridge.current = new ViewBridge({ appId: rec.id, methods: view.methods, topics: view.topics }, () => liveDeskLink(deskId), ch.port1);
      // The frame's origin is opaque, so "*" is the only target: the port is what makes the channel private.
      el.contentWindow?.postMessage({ t: 'ma.bridge', appApi: '1.0', tokens: viewTokens(themeRef.current, el) }, '*', [ch.port2]);
      setPhase('ready');
    };
    const onLoad = (): void => {
      loads += 1;
      if (loads > 1) {
        // Its frame went somewhere else, which a view may never do: whatever's there now goes.
        forgetView(deskId, rec.id, rec.version);
        end('unsafe');
      }
    };
    window.addEventListener('message', onMessage);
    el.addEventListener('load', onLoad);
    const timer = window.setTimeout(() => end('failed'), BOOT_TIMEOUT_MS);
    setPhase('booting');
    el.srcdoc = viewSrcdoc(view, {
      bootUrl: new URL(bootUrl, document.baseURI).href,
      font: font ? { family: VIEW_FONT_FAMILY, bytes: font } : null,
      lang: document.documentElement.lang || 'en',
    });
    return () => {
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      el.removeEventListener('load', onLoad);
      bridge.current?.close();
      bridge.current = null;
    };
  }, [view, font, deskId, rec.id, rec.version, paused]);

  // A theme switch reaches the view as it does the office: after this task, once the theme's `data-theme` is on the page
  // (`theme/themeStore.ts` sets it after the render), so its window's ink is the new theme's.
  useEffect(() => {
    let gone = false;
    queueMicrotask(() => {
      if (!gone) bridge.current?.theme(viewTokens(theme, frame.current));
    });
    return () => {
      gone = true;
    };
  }, [theme, rec.id]);

  // The frame budget, while the view shows: over it, the view is unloaded until the member says Resume.
  useEffect(() => (phase === 'ready' && !paused && !parked ? watchFrames(() => setPaused(true)) : undefined), [phase, paused, parked]);

  if (phase === 'unsafe') return <Panel title={W.unsafe} kind="unsafe" />;
  if (phase === 'noWindow') return <Panel title={W.noWindow} kind="no-window" />;
  if (phase === 'failed') {
    return (
      <Panel title={W.frameFailed} kind="failed">
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>{W.tryAgain}</button>
      </Panel>
    );
  }
  if (paused) {
    return (
      <Panel title={W.paused} kind="paused">
        <button type="button" className="btn primary" onClick={() => setPaused(false)} data-testid="deskapp-resume">{W.resume}</button>
      </Panel>
    );
  }
  return (
    <iframe
      ref={frame}
      className="dapp-frame"
      title={rec.name}
      sandbox={SANDBOX}
      allow={FRAME_ALLOW}
      referrerPolicy="no-referrer"
      data-testid="deskapp-frame"
      data-state={phase}
      hidden={!view}
    />
  );
}

/** The body once the desk can answer (`../DeskAppWindow.tsx` shows the desk's own states until then). */
export function AppView({ deskId, appId, parked }: { deskId: string; appId: string; parked: boolean }) {
  const openable = useDeskAppsStore((s) => appOpenable(deskId, s));
  const rec = useDeskAppsStore((s) => installedApp(deskId, deskApp(appId), s));
  const heard = useDeskAppsStore((s) => !!s.desks[deskId]);
  if (!openable) {
    return (
      <div className="empty-app" data-testid="deskapp-off">
        <p>{W.off}</p>
      </div>
    );
  }
  if (!rec) return heard ? <Panel title={W.gone} kind="gone" /> : null;
  const words = problemWords(rec);
  return words ? <Stopped deskId={deskId} rec={rec} words={words} /> : <ViewFrame key={`${rec.id}|${rec.version}`} deskId={deskId} rec={rec} parked={parked} />;
}

/**
 * An installed app's whole window body, in a window, a carousel's slide or an open tile alike (`../DeskAppWindow.tsx` is its
 * first-load door): while the desk can't answer, the house's own desk states, as the Notebook's window shows them (borrowed from
 * the first load, `deps.ts`); then `AppView`.
 */
export function AppWindowBody({ deskId, app, parked }: AppWindowProps & { app?: AppId }) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === deskId));
  const id = app ? deskAppIdOf(app) : null;
  if (!id) return null;
  const { PanelBody, deskPanel, windowVm } = shared;
  const panel = deskPanel({
    vm: windowVm(desk?.vm, link),
    phase: desk?.phase ?? null,
    queuePosition: desk?.queuePosition ?? null,
    link: live.link,
    unreachable: live.lostForSec >= 30,
    refusal: live.refusal,
    busy: live.busy,
  });
  return (
    <div
      className="dapp-view"
      data-testid="deskapp-view"
      data-app={id}
      // Pressing here is the member being at this desk, as far as the idle rule goes. Inside the frame it can't be heard.
      onPointerDownCapture={() => noteDeskInput(deskId, true)}
      onKeyDownCapture={() => noteDeskInput(deskId, true)}
    >
      {panel.kind !== 'playing' || !link ? (
        <div className="br-panel" role="status" data-testid="deskapp-panel" data-panel={panel.kind}>
          <div className="br-panel-body">
            <PanelBody panel={panel} deskId={deskId} asleepLine="Everything in it is safe, and comes back when it wakes." />
          </div>
        </div>
      ) : (
        <AppView deskId={deskId} appId={id} parked={parked === true} />
      )}
    </div>
  );
}
