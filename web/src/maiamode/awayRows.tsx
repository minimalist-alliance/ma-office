// "While you're away" in the account menu's Maia Mode rows (Maia Mode Phase 2; ma-platform contract desks.md "Maia while you're
// away", ADR 0141). The member's own choices, kept on the Platform so it can hold them on its own facts: whether Maia keeps going
// while the office is closed, whether she may email when she needs them, the most hours a day she may keep desks awake, and the
// desks she may wake to brief their agents. Nothing shows for a member the Platform doesn't list (`enabled` false).
import { useEffect, useState } from 'react';
import { Segmented, Switch } from '../chrome/Segmented';
import { api } from '../platform/api';
import { useDeskStore } from '../state/deskStore';
import { plain } from './model';
import { W } from './words';

interface Away {
  enabled: boolean;
  on?: boolean;
  email?: boolean;
  hoursPerDay?: number;
  wake?: string[];
  home?: string | null;
}

const HOURS: { value: '2' | '4' | '8'; label: string }[] = [
  { value: '2', label: W.awayHours(2) },
  { value: '4', label: W.awayHours(4) },
  { value: '8', label: W.awayHours(8) },
];

const PATH = '/v1/desks/maia-away';

export function AwayRows() {
  const [away, setAway] = useState<Away | null>(null);
  const [failed, setFailed] = useState(false);
  const desks = useDeskStore((s) => s.desks);
  useEffect(() => {
    let live = true;
    void api<Away>(PATH).then(
      (r) => live && setAway(r.data),
      () => live && setAway(null),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!away?.enabled) return null;
  const save = (patch: Partial<Away>): void => {
    const before = away;
    setAway({ ...away, ...patch });
    setFailed(false);
    void api<Away>(PATH, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(
      (r) => (r.data ? setAway(r.data) : (setAway(before), setFailed(true))),
      () => (setAway(before), setFailed(true)),
    );
  };
  const wake = away.wake ?? [];
  const others = desks.filter((d) => d.kind !== 'guild' && d.id !== away.home).slice(0, 10);
  const hours = String(away.hoursPerDay ?? 4) as '2' | '4' | '8';
  return (
    <div className="mm-away" data-testid="maia-away">
      <Switch id="pref-maia-away" label={W.awayLabel} hint={W.awayHint} checked={away.on !== false} onChange={(on) => save({ on })} />
      {away.on !== false && (
        <>
          <Switch id="pref-maia-away-email" label={W.awayEmail} hint={W.awayEmailHint} checked={away.email === true} onChange={(email) => save({ email })} />
          <p className="menu-label" id="mm-away-hours">{W.awayHoursLabel}</p>
          <Segmented label={W.awayHoursLabel} options={HOURS} value={HOURS.some((h) => h.value === hours) ? hours : '4'} onChange={(v) => save({ hoursPerDay: Number(v) })} className="theme-switch mm-away-hours" />
          {others.length > 0 && <p className="menu-label">{W.awayWake}</p>}
          {others.map((d) => (
            <Switch
              key={d.id}
              id={`pref-maia-wake-${d.id}`}
              label={plain(d.name, 40) || W.awayDesk}
              checked={wake.includes(d.id)}
              onChange={(on) => save({ wake: on ? [...wake, d.id] : wake.filter((x) => x !== d.id) })}
            />
          ))}
        </>
      )}
      {failed && (
        <p className="about-line" role="status">
          {W.awayFailed}
        </p>
      )}
    </div>
  );
}
