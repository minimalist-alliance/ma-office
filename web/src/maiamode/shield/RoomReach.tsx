// What reaches the member, in her room (the focus shield; CONCEPT.md §5.6): the held line at the To-do column's head, and under it,
// on the device the desk names, the card (with her `noticing` beat, which the desk's `notice` already plays) and the catch-up.
// Its one things open in the room's viewport (`Room.tsx` passes how).
import { useCallback, useEffect, useState } from 'react';
import { useReach } from '../focusSource';
import { shownHere, type Reach, type ReachGo } from '../reach';
import { R } from '../words';
import { answerCatchup, keepSnapshot } from './actions';
import { Card } from './Card';
import { CatchUpPanel } from './CatchUp';
import { useShieldUi } from './state';
import { Stack } from './Tray';

export interface RoomReachProps {
  onGo: (go: ReachGo, deskId: string | null) => void;
}

/** The line's tap in her room: Back and a pick-up through the room's own go, the catch-up under it, else To-do as it is. */
function roomLine(reach: Reach, onGo: RoomReachProps['onGo']): void {
  const a = reach.line.action;
  if (a?.kind === 'back') {
    const b = reach.back;
    onGo({ kind: 'back', cardId: a.cardId, deskId: b?.deskId ?? null, app: b?.app ?? null, item: b?.item ?? null }, null);
    if (b?.resume) useShieldUi.setState({ resume: { text: b.resume, at: Date.now() } });
  } else if (a?.kind === 'catchup' && reach.catchup) {
    useShieldUi.setState({ catchup: true });
    void answerCatchup(reach.catchup, 'open').catch(() => undefined);
  } else if (a?.kind === 'pickup') {
    useShieldUi.setState({ sheet: 'todo' });
  }
}

export function RoomReach({ onGo }: RoomReachProps) {
  const reach = useReach((s) => s.reach);
  const device = useReach((s) => s.device);
  const catchupOpen = useShieldUi((s) => s.catchup);
  const gone = useShieldUi((s) => s.gone);
  const resume = useShieldUi((s) => s.resume);
  const here = shownHere(reach, device ?? '');
  const card = here && reach?.card && reach.card.cardId !== gone ? reach.card : null;
  const catchup = here ? (reach?.catchup ?? null) : null;
  useEffect(() => {
    if (card) keepSnapshot(card);
  }, [card]);
  useEffect(() => {
    if (!resume) return undefined;
    const t = window.setTimeout(() => useShieldUi.setState({ resume: null }), 5_000);
    return () => window.clearTimeout(t);
  }, [resume]);
  const onGone = useCallback((cardId: string) => useShieldUi.setState({ gone: cardId }), []);
  const openSettings = useCallback(() => useShieldUi.setState({ settings: true }), []);
  const [going, setGoing] = useState(false);
  if (!reach?.on) return null;
  const tray = reach.tray;
  const waiting = !card && !(catchup && (catchupOpen || !catchup.waiting)) && !!tray && tray.papers.length > 0;
  return (
    <div className="sh-room" data-testid="shield-room">
      <button type="button" className={`sh-room-line${reach.line.dot === 'accent' ? ' accent' : ''}`} aria-label={`${R.lineName}: ${reach.line.text}`} onClick={() => roomLine(reach, onGo)}>
        {reach.line.dot === 'accent' && <span className="sh-dot" aria-hidden="true" />}
        <span>{reach.line.text}</span>
      </button>
      {resume && (
        <p className="sh-room-resume" role="status">
          {resume.text}
        </p>
      )}
      {card && <Card card={card} onGo={onGo} onChange={openSettings} onGone={onGone} />}
      {!card && catchup && (catchupOpen || !catchup.waiting) && <CatchUpPanel catchup={catchup} onGo={onGo} onClose={() => useShieldUi.setState({ catchup: false })} />}
      {waiting && tray && !going && (
        <button type="button" className="sh-room-needs" data-testid="tray-go" onClick={() => setGoing(true)}>
          <span>{R.needN(tray.papers.length)}</span>
          <span className="sh-room-needs-go">{R.goThrough}</span>
        </button>
      )}
      {waiting && tray && going && (
        <div className="sh-room-stack">
          <Stack tray={tray} />
          <button type="button" className="sh-btn quiet" onClick={() => setGoing(false)}>
            {R.close}
          </button>
        </div>
      )}
    </div>
  );
}
