// The held line (the focus shield; CONCEPT.md §5.6 and §7, deskd API.md §23 `reach.line`): one still line beside the account menu,
// top right, DOM only ("6 held · nothing urgent", "Your 1:00 catch-up is ready", "Back to Q3 plan"). The accent dot only when the
// desk says so, never motion, never a warning colour. A tap does the line's action (Back, a pick-up, the catch-up) or opens To-do as
// a sheet; its menu holds everything, clears the stated task and opens What reaches you. Under it, in the desk view and on the
// device the desk names: the card, the catch-up panel, and after Back the ready-to-resume line for 5 s.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMaiaMode } from '../door';
import { reachCall, useReach } from '../focusSource';
import { readGo, shownHere, type Reach, type ReachGo } from '../reach';
import { R } from '../words';
import { answerCatchup, clearWorking, hold, keepSnapshot, restoreBack, runGo } from './actions';
import { Card } from './Card';
import { CatchUpPanel } from './CatchUp';
import { Settings } from './Settings';
import { Sheet } from './Sheet';
import { Dot, splitLine } from './Maia';
import { lastBack, useShieldUi } from './state';
import { carryWaiting, watchWaiting } from './trayActions';

/** A pick-up item's `back` go in the room's list, if the list carries it. */
function pickupGo(room: Record<string, unknown> | null, itemId: string): Extract<ReachGo, { kind: 'back' }> | null {
  const items = (room?.['todo'] as { items?: unknown[] } | undefined)?.items ?? [];
  for (const i of Array.isArray(items) ? items : []) {
    const o = i as { id?: unknown; action?: unknown };
    if (o.id !== itemId) continue;
    const go = readGo(o.action);
    return go.kind === 'back' ? go : null;
  }
  return null;
}

/** The line's tap: Back, a pick-up, the catch-up, or To-do. */
export function lineAction(reach: Reach): void {
  const a = reach.line.action;
  if (a?.kind === 'back') {
    const back = reach.back && reach.back.cardId === a.cardId ? reach.back : { cardId: a.cardId, label: '', resume: '', deskId: null, app: null, item: null, surface: null, until: null };
    restoreBack(back);
  } else if (a?.kind === 'heads_up') {
    // "Not yet" (the chip beside the line): the card waits for the next coarse break, if its deadline allows.
    void reachCall('agent.maia.reach.answer', { cardId: a.cardId, answer: 'not_yet' }).catch(() => undefined);
  } else if (a?.kind === 'pickup') {
    // The pick-up's own card (the desk names it), else its `back` go from the list, else the Back this page last saw.
    void reachCall('agent.maia.reach.answer', { itemId: a.itemId, answer: 'go' }).catch(() => undefined);
    const go = pickupGo(useReach.getState().room, a.itemId);
    const cardId = a.cardId ?? go?.cardId ?? lastBack.back?.cardId ?? null;
    if (!cardId) useShieldUi.setState({ sheet: 'todo' });
    else if (lastBack.back?.cardId === cardId) restoreBack(lastBack.back);
    else restoreBack({ cardId, label: '', resume: '', deskId: go?.deskId ?? null, app: go?.app ?? null, item: go?.item ?? null, surface: null, until: null });
  } else if (a?.kind === 'catchup' && reach.catchup) {
    useShieldUi.setState({ catchup: true });
    void answerCatchup(reach.catchup, 'open').catch(() => undefined);
  } else useShieldUi.setState({ sheet: 'todo' });
}

/** The menu's line glyphs (the office's 18 px strokes): an hourglass, the catch-up's clock (the Lounge's), the night, a pause's end, the settings. */
const GLYPH: Record<string, string> = {
  timer: 'M7.5 4h9M7.5 20h9M8.5 4c0 4.2 7 4.6 7 8s-7 3.8-7 8M15.5 4c0 4.2-7 4.6-7 8s7 3.8 7 8',
  catchup: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.4l2.8 1.8',
  night: 'M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9Z',
  stop: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM9.5 9.5v5M14.5 9.5v5',
  reach: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
};

function Glyph({ g }: { g: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
      <path d={GLYPH[g]} />
    </svg>
  );
}

function Menu({ reach, close }: { reach: Reach; close: (focusBack: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent): void => {
      if (!box.current?.parentElement?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [close]);
  const item = (label: string, run: () => void, testid?: string, glyph?: string, cls = '') => (
    <button
      type="button"
      role="menuitem"
      className={`menu-item sh-menu-item${cls}`}
      data-testid={testid}
      onClick={() => {
        run();
        close(true);
      }}
    >
      {glyph && <Glyph g={glyph} />}
      <span>{label}</span>
    </button>
  );
  return (
    <div
      ref={box}
      className="menu sh-menu"
      role="menu"
      aria-label={R.menu}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }
      }}
    >
      {reach.hold ? (
        item(R.holdStop, () => void hold({ clear: true }).catch(() => undefined), undefined, 'stop')
      ) : (
        <>
          <p className="menu-label sh-menu-label">{R.holdAll}</p>
          {item(R.hold30, () => void hold({ minutes: 30 }).catch(() => undefined), 'shield-hold-30', 'timer')}
          {item(R.holdCatchup, () => void hold({ until: 'catchup' }).catch(() => undefined), undefined, 'catchup')}
          {item(R.holdTomorrow, () => void hold({ until: 'tomorrow' }).catch(() => undefined), undefined, 'night')}
        </>
      )}
      {reach.working && (
        <div className="sh-working">
          <p className="sh-working-text">{R.workingOn(reach.working.label)}</p>
          {item(R.clear, () => void clearWorking().catch(() => undefined), undefined, undefined, ' sh-working-clear')}
        </div>
      )}
      <div className="menu-sep" />
      {item(R.settings, () => useShieldUi.setState({ settings: true }), 'shield-settings-open', 'reach')}
    </div>
  );
}

/** "You were on Q3 plan in Notebook, Work. Last change 3 min ago." over the item for 5 s, then it fades. */
function Resume() {
  const resume = useShieldUi((s) => s.resume);
  useEffect(() => {
    if (!resume) return undefined;
    const t = window.setTimeout(() => useShieldUi.setState({ resume: null }), 5_000);
    return () => window.clearTimeout(t);
  }, [resume]);
  if (!resume) return null;
  return (
    <div className="sh-resume" role="status" aria-label={R.resumeName} key={resume.at} data-testid="shield-resume">
      {resume.text}
    </div>
  );
}

export function HeldLine() {
  const reach = useReach((s) => s.reach);
  const device = useReach((s) => s.device);
  const room = useMaiaMode((s) => s.room);
  const { menu, sheet, settings, catchup: catchupOpen, gone } = useShieldUi();
  const lineBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState('');

  const here = shownHere(reach, device ?? '');
  const card = here && reach?.card && reach.card.cardId !== gone ? reach.card : null;
  const catchup = here ? (reach?.catchup ?? null) : null;

  // Answers waiting for a desk that was asleep go when its channel opens (the decision tray §7).
  useEffect(() => {
    const stop = watchWaiting();
    const t = window.setTimeout(() => {
      if (useReach.getState().reach?.tray) void carryWaiting();
    }, 3_000);
    return () => {
      stop();
      window.clearTimeout(t);
    };
  }, []);
  // The working set when a card first shows here, kept for its Back; a Back nobody took, kept for a pick-up.
  useEffect(() => {
    if (card) keepSnapshot(card);
  }, [card]);
  useEffect(() => {
    if (reach?.back) lastBack.back = reach.back;
  }, [reach?.back]);
  // A catch-up the desk says is ready opens under the line when the member taps it; a new one shows its panel at once.
  const lastCatchup = useRef<string | null>(null);
  useEffect(() => {
    const id = catchup?.catchupId ?? null;
    if (id && id !== lastCatchup.current && !catchup?.waiting) useShieldUi.setState({ catchup: true });
    if (!id) useShieldUi.setState({ catchup: false });
    lastCatchup.current = id;
  }, [catchup?.catchupId, catchup?.waiting]);
  // The line's words, said politely when they change (never `alert`).
  useEffect(() => {
    if (reach?.on && reach.line.text) setSaid(reach.line.text);
  }, [reach?.on, reach?.line.text]);

  const closeMenu = useCallback((focusBack: boolean) => {
    useShieldUi.setState({ menu: false });
    if (focusBack) moreBtn.current?.focus({ preventScroll: true });
  }, []);
  const onGo = useCallback((go: ReachGo, deskId: string | null) => runGo(go, deskId), []);
  const onGone = useCallback((cardId: string) => useShieldUi.setState({ gone: cardId }), []);
  const openSettings = useCallback(() => useShieldUi.setState({ settings: true }), []);

  const on = !!reach?.on;
  return (
    <>
      {on && reach && (
        <div className={`sh-wrap ma-glass${reach.line.dot === 'accent' ? ' accent' : ''}`} data-testid="shield-line" data-kind={reach.line.kind}>
          <button ref={lineBtn} type="button" className="sh-line" aria-label={`${R.lineName}: ${reach.line.text}`} title={reach.line.text} onClick={() => lineAction(reach)}>
            {reach.line.dot === 'accent' && <Dot />}
            <span className="sh-line-text">
              <span className="sh-line-lead">{splitLine(reach.line.text)[0]}</span>
              {splitLine(reach.line.text)[1] && <span className="sh-line-rest">{` · ${splitLine(reach.line.text)[1]}`}</span>}
            </span>
            <span className="sh-line-short" aria-hidden="true">
              {reach.line.kind === 'held' ? `${reach.held.count} held` : reach.line.text}
            </span>
          </button>
          {reach.line.action?.kind === 'heads_up' && (
            <button type="button" className="sh-chip" data-testid="shield-not-yet" onClick={() => lineAction(reach)}>
              {R.notYet}
            </button>
          )}
          <span className="sh-rule" aria-hidden="true" />
          <button ref={moreBtn} type="button" className="sh-more" aria-label={R.menu} aria-haspopup="menu" aria-expanded={menu} onClick={() => useShieldUi.setState({ menu: !menu })}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
          {menu && <Menu reach={reach} close={closeMenu} />}
          {!room && (card || (catchup && catchupOpen)) && (
            <div className="sh-under">
              {card && <Card card={card} onGo={onGo} onChange={openSettings} onGone={onGone} />}
              {!card && catchup && catchupOpen && <CatchUpPanel catchup={catchup} onGo={onGo} onClose={() => useShieldUi.setState({ catchup: false })} />}
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {said}
          </span>
        </div>
      )}
      {!room && <Resume />}
      {sheet && on && <Sheet back={() => lineBtn.current?.focus({ preventScroll: true })} />}
      {settings && <Settings />}
    </>
  );
}
