// A catch-up (the focus shield; CONCEPT.md §6, deskd API.md §23 `catchup`): a calm panel under the held line in the desk view, and
// in the To-do column in her room. Its head, the groups in code's order (Needs you · Working on · Read later · Records · Done for
// you) with their items, each with its one thing and its chips (Not important · Sooner next time), the summary lines, one question
// with 2 to 4 choices, and "That's all for now." Later puts it away; it stays in To-do.
// Its look is the brand pass's (`design-drafts/maia-shield-brand/DIRECTION.md`): a short letter from Maia. Her still at the head with
// the head's words split at " · " into a title and a quieter line; item rows with one pill each (the first thing that needs the
// member is the one filled pill) and their chips as quiet words; the groups that only count things folded into one sunken tally;
// her question in the accent tray; the end line under a short rule.
import { useEffect, useState } from 'react';
import { useReach } from '../focusSource';
import { fillWho, type CatchUp, type ReachGo } from '../reach';
import { R } from '../words';
import { answerCatchup, answerItem, answerQuestion, nameOf } from './actions';
import { MaiaHalo, splitLine } from './Maia';
import { Stack } from './Tray';

export interface CatchUpProps {
  catchup: CatchUp;
  onGo: (go: ReachGo, deskId: string | null) => void;
  onClose: () => void;
  className?: string;
}

export function CatchUpPanel({ catchup, onGo, onClose, className = '' }: CatchUpProps) {
  const [name, setName] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    void nameOf(catchup.question?.who ?? null).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [catchup.catchupId, catchup.question?.who]);
  const chip = (itemId: string, answer: string): void => {
    setDone((d) => new Set(d).add(`${itemId}|${answer}`));
    void answerItem(itemId, answer).catch(() => undefined);
  };
  const tray = useReach((s) => s.reach?.tray ?? null);
  const [title, sub] = splitLine(catchup.head || R.catchup);
  // The decision tray: Needs you *is* the stack, papers answered in place; what has no paper (a stuck desk, a limit) stays a row.
  const stacked = !!tray && (tray.papers.length > 0 || tray.filed.length > 0);
  const paperItems = new Set((tray?.papers ?? []).map((p) => p.itemId).filter((x): x is string => !!x));
  const groups = catchup.groups.map((g) => (stacked && g.id === 'needs_you' ? { ...g, items: g.items.filter((i) => !paperItems.has(i.itemId)) } : g));
  const listed = groups.filter((g) => g.items.length > 0 || (stacked && g.id === 'needs_you'));
  const tally = groups.filter((g) => g.items.length === 0 && g.summary && !(stacked && g.id === 'needs_you'));
  // The one filled pill: the first thing that needs the member, else none (every other one thing is a soft pill). With the stack,
  // the paper's own pick is the one.
  const firstNeed = stacked ? null : (groups.find((g) => g.id === 'needs_you')?.items.find((i) => i.go.kind !== 'none')?.itemId ?? null);
  return (
    <section className={`sh-catchup ${className}`} aria-label={catchup.head || R.catchup} data-testid="shield-catchup">
      <span className="sr-only" role="status" aria-live="polite">
        {catchup.head}
      </span>
      <header className="sh-catchup-head">
        <MaiaHalo size="md" />
        <div className="sh-catchup-words">
          <h2 className="sh-catchup-title">{title}</h2>
          {sub && <p className="sh-catchup-sub">{sub}</p>}
        </div>
        <button
          type="button"
          className="sh-btn quiet"
          aria-label={R.laterName}
          onClick={() => {
            void answerCatchup(catchup, 'dismiss').catch(() => undefined);
            onClose();
          }}
        >
          {R.later}
        </button>
      </header>
      {listed.map((g) => (
        <div key={g.id} className={`sh-group${stacked && g.id === 'needs_you' ? ' sh-group-stack' : ''}`}>
          {stacked && g.id === 'needs_you' && tray ? <Stack tray={tray} /> : <h3 className="sh-group-label">{g.label}</h3>}
          {g.items.length > 0 && (
          <ul className="sh-group-items">
            {g.items.map((i) => (
              <li key={i.itemId} className="sh-group-item">
                <div className="sh-item-main">
                  <p className="sh-item-line">{fillWho(i.line, null)}</p>
                  {i.go.kind !== 'none' && (
                    <button
                      type="button"
                      className={i.itemId === firstNeed ? 'sh-chip primary' : 'sh-chip soft'}
                      aria-label={`${i.goLabel}: ${fillWho(i.line, null)}`}
                      onClick={() => {
                        void answerItem(i.itemId, 'go').catch(() => undefined);
                        onGo(i.go, null);
                      }}
                    >
                      {i.goLabel}
                    </button>
                  )}
                </div>
                {i.choices.length > 0 && (
                  <div className="sh-chips">
                    {i.choices.map((c) => (
                      <button key={c.id} type="button" className="sh-chip quiet" aria-pressed={done.has(`${i.itemId}|${c.id}`)} disabled={done.has(`${i.itemId}|${c.id}`)} onClick={() => chip(i.itemId, c.id)}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          )}
          {g.summary && !(stacked && g.id === 'needs_you') && <p className="sh-summary">{g.summary}</p>}
        </div>
      ))}
      {(tally.length > 0 || catchup.lines.length > 0) && (
        <ul className="sh-inset sh-tally">
          {tally.map((g) => (
            <li key={g.id} className="sh-tally-row">
              <span className="sh-tally-label">{g.label}</span>
              <span className="sh-summary">{g.summary}</span>
            </li>
          ))}
          {catchup.lines.map((l) => {
            // "Cleared without you: 3" reads as the rows above it, its label and its count.
            const at = l.lastIndexOf(': ');
            return (
              <li key={l} className="sh-tally-row">
                {at > 0 ? (
                  <>
                    <span className="sh-tally-label">{l.slice(0, at)}</span>
                    <span className="sh-summary">{l.slice(at + 2)}</span>
                  </>
                ) : (
                  <span className="sh-summary">{l}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {catchup.question && (
        <div className="sh-question" role="group" aria-label={fillWho(catchup.question.text, name)}>
          <p>{fillWho(catchup.question.text, name)}</p>
          <div className="sh-chips">
            {catchup.question.choices.map((c) => (
              <button key={c.id} type="button" className="sh-chip soft" onClick={() => void answerQuestion(catchup, catchup.question!.questionId, c.id).catch(() => undefined)}>
                {fillWho(c.label, name)}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="sh-end">{catchup.end}</p>
    </section>
  );
}
