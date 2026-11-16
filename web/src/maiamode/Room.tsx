// The room (CONCEPT.md Part 1 "What you see", Part 2 §2; the owner's pick A2, `pick-sheet-A2.png`): Maia in the middle, bigger
// and moving, hovering over the chat whose oldest lines fade into her; the To-do column on the right, collapsible to a slim
// edge; "Show my desks" and the member's avatar top right; the viewport over the right side when she shows something. No
// canvas, no desks, no bars. The office stays mounted underneath, hidden and `inert`, and comes back exactly as it was.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';
import { AccountMenu } from '../chrome/AccountMenu';
import { loadingDone } from '../chrome/loadingOverlay';
import { meAnswered, useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { useDeskStore } from '../state/deskStore';
import { wakeDesk } from '../desk/liveStore';
import { useMaiaMode } from './door';
import { Chat } from './Chat';
import { Edge, NowSaid, OpenColumn, Pills, StatusLine, TodoSheet } from './Column';
import { Disclosure } from './Disclosure';
import { Field, type FieldHandle } from './Field';
import { arrange, fromAttention, layoutFor, maiaSize, openCount, type ColumnItem } from './model';
import { allowedFor, currentPrefs, savePrefs } from './prefs';
import { viewApp, waitingSource, type RoomSource } from './source';
import { makeSource } from './sources';
import { useTodoColumn } from './todoFeed';
import { closeViewport, leave, openViewport, reset, showDisclosure, useRoomUi } from './ui';
import type { ReachGo } from './reach';
import { appOfGo, restoreBack, runGo } from './shield/actions';
import { RoomReach } from './shield/RoomReach';
import { snapshots } from './shield/state';
import { reachCall } from './focusSource';
import { Viewport } from './Viewport';
import { setRoomDocOpener } from '../apps/documents/target';
import { W } from './words';

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = (): void => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function DesksGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
      <rect x="3" y="5" width="8" height="14" rx="2" />
      <rect x="13" y="5" width="8" height="14" rx="2" />
    </svg>
  );
}

function RoomBody({ source }: { source: RoomSource }) {
  const state = useSyncExternalStore(source.subscribe, source.get);
  const desks = useDeskStore((s) => s.desks);
  const listStatus = useDeskStore((s) => s.status);
  const me = useSession(meAnswered);
  const phase = useRoomUi((s) => s.phase);
  const viewport = useRoomUi((s) => s.viewport);
  const sheet = useRoomUi((s) => s.sheet);
  const width = useWidth();
  const layout = layoutFor(width);
  const phone = layout === 'phone';
  const field = useRef<FieldHandle | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The member's own choice, from the document (Platform's wins) or this browser's copy; set here at once.
  const docCollapsed = useLayoutPrefs(() => currentPrefs().trackerCollapsed);
  const [collapsed, setCollapsed] = useState(docCollapsed);
  useEffect(() => setCollapsed(docCollapsed), [docCollapsed]);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      savePrefs({ trackerCollapsed: !c });
      return !c;
    });
  }, []);

  const deskName = useCallback((id: string) => desks.find((d) => d.id === id && d.kind !== 'guild')?.name ?? null, [desks]);
  // Where the home desk counts the list itself (§23, `todo.later` given), its To-do lines are already in it, from what the office
  // observes; otherwise the room reads each desk's To-do here.
  const todo = useTodoColumn(state.later === null);
  const col = useMemo(() => arrange([...fromAttention(state.attention, deskName), ...todo.items], 3), [state.attention, deskName, todo.items]);

  // The home desk says Maia Mode is off and this page isn't turning it on (another device turned it off, or this browser's prefs
  // were never the desk's): the room follows the desk, never the other way (Security's MR-M1). And a member the gate no longer
  // allows (the flag off, a tier that lapsed), once `/v1/me` has really answered, goes back to their desks.
  const gone = useSession((s) => !s.meFailed && meAnswered(s) && s.me !== null && !allowedFor(s.me, s.config));
  useEffect(() => {
    if (gone) return reset();
    if (!state.deskOff) return;
    savePrefs({ on: false });
    leave();
  }, [state.deskOff, gone]);

  // The home desk holds an older disclosure than this page's (a send refused `disclosure`): the current one over the room, which
  // stays mounted underneath and out of reach. Accepting goes back to it as it was; "Not now" leaves it (`ui.ts`). Only a new
  // ask opens it: one still standing as the room mounts is the one just accepted, on its way to the desk.
  const asked = useRef(state.disclosure);
  useEffect(() => {
    if (state.disclosure && !asked.current) showDisclosure();
    asked.current = state.disclosure;
  }, [state.disclosure]);
  const lastPhase = useRef(phase);
  useEffect(() => {
    const el = root.current;
    el?.toggleAttribute('inert', phase === 'disclosure');
    if (lastPhase.current === 'disclosure' && phase === 'in') el?.querySelector<HTMLElement>('.mm-composer textarea')?.focus({ preventScroll: true });
    lastPhase.current = phase;
  }, [phase]);

  // A Now arriving: one glance from her (her `noticing` beat, once per notice), one soft pulse of the dot, and it never reopens
  // a collapsed column by itself.
  const lastNotice = useRef(state.noticeAt);
  useEffect(() => {
    if (state.noticeAt !== null && state.noticeAt !== lastNotice.current) field.current?.notice();
    lastNotice.current = state.noticeAt;
  }, [state.noticeAt]);

  // The member looks at the list as the room opens, and comes back after five minutes away (the batch is due).
  useEffect(() => {
    source.seen(false);
    let hiddenAt = 0;
    const on = (): void => {
      if (document.hidden) hiddenAt = Date.now();
      else source.seen(hiddenAt > 0 && Date.now() - hiddenAt >= 5 * 60_000);
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [source]);

  // What she shows (`office_show`): a closed enum and a desk this office lists, never anything else.
  const shownSeq = useRef(state.show?.seq ?? 0);
  useEffect(() => {
    const s = state.show;
    if (!s || s.seq === shownSeq.current) return;
    shownSeq.current = s.seq;
    const app = viewApp(s.app);
    if (app && deskName(s.deskId) !== null) openViewport({ deskId: s.deskId, app, ref: s.ref }, 'maia');
  }, [state.show, deskName]);

  // Documents asked for from inside the room (her handover card, Files' View in her viewport) opens in her viewport.
  useEffect(() => {
    setRoomDocOpener((deskId) => {
      if (!useMaiaMode.getState().room || deskName(deskId) === null) return false;
      openViewport({ deskId, app: 'documents', ref: null }, 'member');
      return true;
    });
    return () => setRoomDocOpener(null);
  }, [deskName]);

  const onShow = useCallback((item: ColumnItem) => {
    const go = item.go;
    if (go.kind === 'view') openViewport({ deskId: item.deskId, app: go.app, ref: go.ref }, 'member');
    else if (go.kind === 'wake') wakeDesk(item.deskId);
    else if (go.kind === 'chat') document.querySelector(`.mm-log [data-mid="${CSS.escape(go.messageId)}"]`)?.scrollIntoView({ block: 'center' });
    useRoomUi.setState({ sheet: false });
  }, []);
  const onSnooze = useCallback((item: ColumnItem) => source.snooze(item.id.replace(/^a:/, '')), [source]);
  // A card's or a catch-up's one thing, in the room: the viewport, as her own items; Back puts back the viewport it saw. An app
  // the viewport doesn't show (Courier) opens on the desk, and the room steps aside for it.
  const onReachGo = useCallback((go: ReachGo, deskId: string | null) => {
    if (go.kind === 'back') {
      const snap = snapshots.get(go.cardId);
      if (snap && snap.surface === 'room') {
        if (snap.viewport && viewApp(snap.viewport.app)) openViewport({ deskId: snap.viewport.deskId, app: viewApp(snap.viewport.app)!, ref: null }, 'member');
        else closeViewport();
        snapshots.drop(go.cardId);
        void reachCall('agent.maia.reach.back', { cardId: go.cardId, taken: true }).catch(() => undefined);
      } else {
        leave();
        restoreBack({ cardId: go.cardId, deskId: go.deskId, app: go.app, item: go.item, label: '', resume: '', surface: null, until: null });
      }
      return;
    }
    if (go.kind === 'result') {
      document.querySelector(`.mm-log [data-mid="${CSS.escape(go.messageId)}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    if (go.kind === 'wake') {
      const id = go.deskId ?? deskId;
      if (id) wakeDesk(id);
      return;
    }
    const at = appOfGo(go);
    const app = at ? viewApp(at.app) : null;
    if (at && app) openViewport({ deskId: at.deskId, app, ref: go.kind === 'show' ? go.ref : null }, 'member');
    else if (at) {
      leave();
      runGo(go, deskId);
    }
    useRoomUi.setState({ sheet: false });
  }, []);
  const reachSlot = useMemo(() => <RoomReach onGo={onReachGo} />, [onReachGo]);
  const onBusy = useCallback((b: boolean) => field.current?.thinking(b), []);

  // Ready: the room's first frame, once the member and the desk list have answered (§2: the home desk's link isn't waited for).
  const settled = me && listStatus !== 'loading';
  useEffect(() => {
    if (!settled) return undefined;
    const f = requestAnimationFrame(() => {
      root.current?.setAttribute('data-ready', '');
      // The office's ready, when the page opened in the room (a no-op once the overlay has gone).
      loadingDone('maia');
      void import('../theme/backdrop').then((m) => m.mountBackdrop());
    });
    return () => cancelAnimationFrame(f);
  }, [settled]);

  // Alt+Shift+T collapses and expands the column; Esc closes the viewport (only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT' && !e.repeat) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && !e.defaultPrevented && useRoomUi.getState().viewport && !document.querySelector('.mm-layer .menu')) {
        closeViewport();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const vp = viewport && deskName(viewport.deskId) !== null ? viewport : null;
  const count = openCount(col);
  const mark = (
    <span className="mm-mark" role="img" aria-label="Minimalist Alliance">
      <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
      <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
      <img className="home-mark-img on-zen" src={markZen} alt="" width={45} height={28} />
    </span>
  );

  return (
    <div
      ref={root}
      className={`mm-room ${layout}${vp ? ' viewing' : ''}${collapsed ? ' collapsed' : ''} ${phase}`}
      data-collapsed={collapsed || undefined}
    >
      {todo.feeds}
      <header className="mm-top">
        <h1 className="mm-h1">
          {mark}
          <span className="sr-only">{W.room}</span>
        </h1>
        <div className="mm-top-right">
          {phone && (
            <button type="button" className={`mm-chip mm-todo-pill${collapsed ? ' short' : ''}`} aria-haspopup="dialog" aria-expanded={sheet} aria-label={`${W.todo}, ${count} ${count === 1 ? 'item' : 'items'}${col.now ? ', 1 now' : ''}`} onClick={() => useRoomUi.setState({ sheet: true })}>
              {col.now && <span key={col.now.id} className="mm-now-dot pulse" aria-hidden="true" />}
              {!collapsed && <span aria-hidden="true">{W.todo} · </span>}
              <span aria-hidden="true">{count}</span>
            </button>
          )}
          <button type="button" className="mm-chip" onClick={leave} title={`${W.showDesks} (Alt+Shift+M)`}>
            <DesksGlyph />
            {phone ? W.showDesksShort : W.showDesks}
          </button>
          <AccountMenu />
        </div>
      </header>
      {phone && (
        <div className="mm-phone-status">
          <StatusLine state={state} desks={desks.length} />
        </div>
      )}
      <main className="mm-center" aria-label={W.room}>
        <div className="mm-stack">
          <div className="mm-hover">
            <Field key={phone ? 'p' : 'd'} size={phone ? 150 : 214} scale={maiaSize(layout, !!vp) / (phone ? 150 : 214)} handle={field} />
          </div>
          <Chat state={state} source={source} phone={phone} deskName={deskName} onBusy={onBusy} />
        </div>
      </main>
      {!phone && !vp && (collapsed ? <Edge col={col} onExpand={toggle} /> : <OpenColumn col={col} state={state} desks={desks.length} onShow={onShow} onSnooze={onSnooze} onCollapse={toggle} reach={reachSlot} />)}
      {vp && !phone && <Pills col={col} state={state} onShow={onShow} />}
      {vp && (
        <div className={phone ? 'mm-vp-sheet' : 'mm-vp-wrap'}>
          <Viewport shown={vp} deskName={deskName(vp.deskId) ?? ''} phone={phone} />
        </div>
      )}
      {phone && sheet && <TodoSheet col={col} state={state} desks={desks.length} onShow={onShow} onSnooze={onSnooze} onClose={() => useRoomUi.setState({ sheet: false })} reach={reachSlot} />}
      <NowSaid col={col} />
    </div>
  );
}

export function Room() {
  const phase = useRoomUi((s) => s.phase);
  const room = useMaiaMode((s) => s.room);
  const [source, setSource] = useState<RoomSource | null>(null);
  const wanted = room || phase === 'entering' || phase === 'in' || phase === 'leaving';

  // A page that opens in the room (the startup chunk) arrives here with the room already on.
  useEffect(() => {
    if (room && useRoomUi.getState().phase === 'off') useRoomUi.setState({ phase: 'in' });
  }, [room]);

  useEffect(() => {
    if (!wanted || source) return undefined;
    let live = true;
    makeSource().then(
      (s) => {
        if (!live) return s.close();
        // Maia Mode was just turned on, before her source was here: the home desk hears it now.
        if (useRoomUi.getState().announce) s.setOn(true);
        useRoomUi.setState({ source: s, announce: false });
        setSource(s);
      },
      () => live && setSource(waitingSource('offline')),
    );
    return () => {
      live = false;
    };
  }, [wanted, source]);
  useEffect(() => () => {
    source?.close();
    useRoomUi.setState({ source: null });
  }, [source]);

  return (
    <div className={`mm-layer ${phase}`}>
      {wanted && source && <RoomBody source={source} />}
      {phase === 'disclosure' && <Disclosure />}
    </div>
  );
}
