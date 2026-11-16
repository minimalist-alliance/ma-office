// What reaches you (the focus shield's settings; CONCEPT.md §8 "Settings rows", §9, §10; deskd API.md §23 `agent.maia.reach.get`
// and `.set`): what always gets through (at most 5: Family, My boss or clients, Anything due today, Bills and things to sign, Waiting
// on my reply, Someone by name…), the catch-ups, focus hours, evenings and weekends, quiet hours, how much she writes, what she's
// learned (each with Undo, and Reset), and "Show everything as it comes", the member's own off switch. Opened from the held line's
// menu and the account menu's Maia rows. A name typed under "Someone by name…" goes straight to the home desk and nowhere else.
// Its look is the brand pass's (`design-drafts/maia-shield-brand/DIRECTION.md`): Maia at the head, each section's rows in one sunken
// group, the office's switches, choices of three or more as a list with a check (two stay the office's switcher).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Segmented, Switch } from '../../chrome/Segmented';
import { reachCall } from '../focusSource';
import { plain } from '../model';
import { CATCH_UPS, clockWords, FOCUS_SPANS, LIST_MAX, readSettings, type Group, type Match, type ReachView, type Rule, type Span } from '../reach';
import { R } from '../words';
import { nameOf } from './actions';
import { MaiaHalo } from './Maia';
import { useShieldUi } from './state';

type Patch = Partial<Pick<ReachView, 'letThrough' | 'holdAll' | 'catchUps' | 'focusHours' | 'quietHours' | 'evenings' | 'detail' | 'showAll'>>;

const GROUP_ROWS: { key: string; label: string; groups: Group[] }[] = [
  { key: 'family', label: R.family, groups: ['family'] },
  { key: 'boss', label: R.bossClients, groups: ['boss_clients'] },
];
const MATCH_ROWS: { match: Match; label: string }[] = [
  { match: 'due_today', label: R.dueToday },
  { match: 'money', label: R.money },
  { match: 'waiting_reply', label: R.waiting },
];

type CatchKind = 'three' | 'two' | 'often' | 'ask' | 'own';
const catchKind = (times: readonly string[]): CatchKind => (Object.entries(CATCH_UPS).find(([, t]) => t.join() === times.join())?.[0] as CatchKind | undefined) ?? 'own';
const sameSpan = (a: Span, b: Span): boolean => a.from === b.from && a.to === b.to;
/** A rule as the wire takes it back: its id kept, so the desk keeps its age and source. */
const wire = (r: Rule): Rule => r;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sh-set">
      <h3 className="sh-set-title">{title}</h3>
      {hint && <p className="sh-set-hint">{hint}</p>}
      <div className="sh-set-box">{children}</div>
    </section>
  );
}

function PersonName({ rule }: { rule: Extract<Rule, { kind: 'person' }> }) {
  const [name, setName] = useState<string | null>('pendingName' in rule.person ? rule.person.pendingName : null);
  useEffect(() => {
    if ('pendingName' in rule.person) return undefined;
    let live = true;
    void nameOf(rule.person).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [rule]);
  return <>{name ?? 'Someone'}</>;
}

function Times({ times, onChange }: { times: string[]; onChange: (t: string[]) => void }) {
  return (
    <ul className="sh-times">
      {times.map((t, n) => (
        <li key={`${n}-${t}`} className="sh-time-row">
          <label>
            <span className="sr-only">{`${R.time} ${n + 1}`}</span>
            <input type="time" value={t} onChange={(e) => e.target.value && onChange(times.map((x, i) => (i === n ? e.target.value : x)))} />
          </label>
          <button type="button" className="sh-btn quiet" aria-label={R.remove(clockWords(t))} onClick={() => onChange(times.filter((_, i) => i !== n))}>
            {R.removeShort}
          </button>
        </li>
      ))}
      {times.length < 8 && (
        <li>
          <button type="button" className="sh-btn soft" onClick={() => onChange([...times, '12:00'].sort())}>
            {R.addTime}
          </button>
        </li>
      )}
    </ul>
  );
}

function SpanRow({ span, onChange, onRemove }: { span: Span; onChange: (s: Span) => void; onRemove?: () => void }) {
  return (
    <div className="sh-time-row">
      <label>
        <span>{R.from}</span>
        <input type="time" value={span.from} onChange={(e) => e.target.value && onChange({ ...span, from: e.target.value })} />
      </label>
      <label>
        <span>{R.to}</span>
        <input type="time" value={span.to} onChange={(e) => e.target.value && onChange({ ...span, to: e.target.value })} />
      </label>
      {onRemove && (
        <button type="button" className="sh-btn quiet" onClick={onRemove}>
          {R.removeShort}
        </button>
      )}
    </div>
  );
}

export function Settings() {
  const [view, setView] = useState<ReachView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [asking, setAsking] = useState(false);
  const [own, setOwn] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = (): void => useShieldUi.setState({ settings: false });

  useEffect(() => {
    let live = true;
    void reachCall('agent.maia.reach.get', {}, true).then(
      (r) => {
        if (!live) return;
        const v = readSettings(r);
        setView(v);
        setOwn(catchKind(v.catchUps) === 'own');
      },
      () => live && setProblem(R.unreachable),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, []);

  /** One change, shown at once and put back if the desk refuses it. */
  const save = (patch: Patch): void => {
    if (!view) return;
    const before = view;
    setView({ ...view, ...patch });
    setProblem(null);
    void reachCall('agent.maia.reach.set', patch as Record<string, unknown>).then(
      (r) => {
        const next = readSettings(r);
        // A `set` answers the settings; what's learned and the counts stay as read when it leaves them out.
        const sent = (r as { reach?: Record<string, unknown> } | null)?.reach ?? {};
        setView((v) => ({ ...next, learned: 'learned' in sent ? next.learned : (v?.learned ?? []), counts: 'counts' in sent ? next.counts : (v?.counts ?? next.counts) }));
      },
      (e: unknown) => {
        setView(before);
        const reason = (e as { details?: { reason?: unknown } } | null)?.details?.reason;
        setProblem(reason === 'too_many' ? R.full : R.saveFailed);
      },
    );
  };
  const learned = (method: 'agent.maia.reach.learned.undo' | 'agent.maia.reach.learned.reset', params: Record<string, unknown>): void => {
    void reachCall(method, params).then(
      (r) => setView((v) => (v ? { ...v, learned: readSettings(r).learned } : v)),
      () => setProblem(R.saveFailed),
    );
  };

  const list = view?.letThrough ?? [];
  const full = list.length >= LIST_MAX;
  // "My boss or clients" is one entry; a list from before (boss and clients apart) reads as on too.
  const hasGroup = (g: Group[]): boolean =>
    g.every((x) => list.some((r) => r.kind === 'group' && (r.group === x || (x === 'boss_clients' && (r.group === 'boss' || r.group === 'clients')))));
  const hasMatch = (m: Match): boolean => list.some((r) => r.kind === 'match' && r.match === m);
  const toggleGroups = (groups: Group[], on: boolean): void => {
    const rest = list.filter((r) => !(r.kind === 'group' && (groups.includes(r.group) || (groups.includes('boss_clients') && (r.group === 'boss' || r.group === 'clients')))));
    const next = on ? [...rest, ...groups.map((group): Rule => ({ kind: 'group', group, anyTime: group === 'family', source: 'settings' }))] : rest;
    if (next.length > LIST_MAX) return setProblem(R.full);
    save({ letThrough: next.map(wire), holdAll: false });
  };
  const toggleMatch = (match: Match, on: boolean): void => {
    const rest = list.filter((r) => !(r.kind === 'match' && r.match === match));
    const next = on ? [...rest, { kind: 'match', match, anyTime: false, source: 'settings' } as Rule] : rest;
    if (next.length > LIST_MAX) return setProblem(R.full);
    save({ letThrough: next.map(wire), holdAll: false });
  };
  const addName = (): void => {
    const n = plain(name, 60);
    if (!n) return;
    if (full) return setProblem(R.full);
    save({ letThrough: [...list, { kind: 'person', person: { pendingName: n }, anyTime: false, source: 'settings' }], holdAll: false });
    setName('');
  };

  const body = !view ? (
    <p className="sh-empty" role="status">
      {problem ?? R.loading}
    </p>
  ) : (
    <>
      <Section title={R.always} hint={R.alwaysHint}>
        {GROUP_ROWS.map((g) => (
          <Switch key={g.key} id={`sh-g-${g.key}`} label={g.label} checked={hasGroup(g.groups)} onChange={(on) => toggleGroups(g.groups, on)} />
        ))}
        {MATCH_ROWS.map((m) => (
          <Switch key={m.match} id={`sh-m-${m.match}`} label={m.label} checked={hasMatch(m.match)} onChange={(on) => toggleMatch(m.match, on)} />
        ))}
        {list.filter((r): r is Extract<Rule, { kind: 'person' }> => r.kind === 'person').length > 0 && (
          <ul className="sh-people">
            {list.map((r, n) =>
              r.kind === 'person' ? (
                <li key={r.ruleId ?? `p-${n}`} className="sh-person">
                  <span>
                    <PersonName rule={r} />
                  </span>
                  <button type="button" className="sh-btn quiet" aria-label={R.remove('pendingName' in r.person ? r.person.pendingName : 'this person')} onClick={() => save({ letThrough: list.filter((x) => x !== r) })}>
                    {R.removeShort}
                  </button>
                </li>
              ) : null,
            )}
          </ul>
        )}
        <form
          className="sh-name"
          onSubmit={(e) => {
            e.preventDefault();
            addName();
          }}
        >
          <label htmlFor="sh-name">{R.byName}</label>
          <div className="sh-name-row">
            <input id="sh-name" type="text" maxLength={60} autoComplete="off" spellCheck={false} placeholder={R.byNameField} value={name} onChange={(e) => setName(e.target.value)} aria-describedby="sh-name-hint" />
            <button type="submit" className="sh-btn soft" disabled={!plain(name, 60) || full}>
              {R.add}
            </button>
          </div>
          <small id="sh-name-hint">{R.byNameHint}</small>
        </form>
        <Switch id="sh-hold-all" label={R.holdAllRow} checked={view.holdAll} onChange={(on) => save(on ? { holdAll: true, letThrough: [] } : { holdAll: false })} />
      </Section>

      <Section title={R.catchUps}>
        <Segmented
          label={R.catchUps}
          className="sh-radios"
          value={own ? 'own' : catchKind(view.catchUps)}
          options={[
            { value: 'three', label: R.catchThree },
            { value: 'two', label: R.catchTwo },
            { value: 'often', label: R.catchOften },
            { value: 'ask', label: R.catchAsk },
            { value: 'own', label: R.catchCustom },
          ]}
          onChange={(k) => {
            setOwn(k === 'own');
            if (k !== 'own') save({ catchUps: [...CATCH_UPS[k]!] });
          }}
        />
        {own && <Times times={view.catchUps} onChange={(t) => save({ catchUps: [...new Set(t)].sort() })} />}
      </Section>

      <Section title={R.focus} hint={R.focusHint}>
        {(['mornings', 'afternoons'] as const).map((k) => (
          <Switch
            key={k}
            id={`sh-f-${k}`}
            label={`${k === 'mornings' ? R.mornings : R.afternoons} · ${clockWords(FOCUS_SPANS[k]!.from)}–${clockWords(FOCUS_SPANS[k]!.to)}`}
            checked={view.focusHours.some((s) => sameSpan(s, FOCUS_SPANS[k]!))}
            onChange={(on) => save({ focusHours: on ? [...view.focusHours, { ...FOCUS_SPANS[k]! }].slice(0, 3) : view.focusHours.filter((s) => !sameSpan(s, FOCUS_SPANS[k]!)) })}
          />
        ))}
        {view.focusHours
          .map((s, n) => ({ s, n }))
          .filter(({ s }) => !Object.values(FOCUS_SPANS).some((p) => sameSpan(p, s)))
          .map(({ s, n }) => (
            <SpanRow key={`${n}-${s.from}`} span={s} onChange={(x) => save({ focusHours: view.focusHours.map((y, i) => (i === n ? x : y)) })} onRemove={() => save({ focusHours: view.focusHours.filter((_, i) => i !== n) })} />
          ))}
        {view.focusHours.length < 3 && (
          <button type="button" className="sh-btn soft sh-add" onClick={() => save({ focusHours: [...view.focusHours, { from: '10:00', to: '11:00' }] })}>
            {R.addSpan}
          </button>
        )}
      </Section>

      <Section title={R.evenings}>
        <Segmented label={R.evenings} className="theme-switch sh-seg" value={view.evenings} options={[{ value: 'hold', label: R.holdWork }, { value: 'let', label: R.letWork }]} onChange={(evenings) => save({ evenings })} />
      </Section>

      <Section title={R.quiet}>
        <Segmented label={R.quiet} className="sh-radios" value={view.quietHours ? 'own' : 'auto'} options={[{ value: 'auto', label: R.quietAuto }, { value: 'own', label: R.quietOwn }]} onChange={(k) => save({ quietHours: k === 'own' ? { from: '22:00', to: '07:00' } : null })} />
        {view.quietHours && <SpanRow span={view.quietHours} onChange={(quietHours) => save({ quietHours })} />}
      </Section>

      <Section title={R.detail} hint={R.detailHint}>
        <Segmented label={R.detail} className="sh-radios" value={view.detail} options={[{ value: 'line', label: R.line }, { value: 'paragraph', label: R.paragraph }, { value: 'full', label: R.fullPicture }]} onChange={(detail) => save({ detail })} />
      </Section>

      <Section title={R.learned}>
        {view.learned.length ? (
          <ul className="sh-learned">
            {view.learned.map((l) => (
              <li key={l.ruleId} className="sh-person">
                <span>{l.line.replace(/\{who\}/g, 'someone')}</span>
                <button type="button" className="sh-btn quiet" onClick={() => learned('agent.maia.reach.learned.undo', { ruleId: l.ruleId })}>
                  {R.undo}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sh-set-hint">{R.learnedNone}</p>
        )}
        {asking ? (
          <div className="sh-ask" role="group" aria-label={R.reset}>
            <p>{R.resetAsk}</p>
            <div className="sh-acts">
              <button type="button" className="sh-btn soft" onClick={() => setAsking(false)}>
                {R.close}
              </button>
              <button
                type="button"
                className="sh-btn soft"
                onClick={() => {
                  setAsking(false);
                  learned('agent.maia.reach.learned.reset', {});
                }}
              >
                {R.reset}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="sh-btn quiet sh-reset" onClick={() => setAsking(true)}>
            {R.reset}
          </button>
        )}
      </Section>

      <Section title={R.showAll}>
        <Switch id="sh-show-all" label={R.showAll} hint={R.showAllHint} checked={view.showAll} onChange={(showAll) => save({ showAll })} />
      </Section>
    </>
  );

  return createPortal(
    <div className="sh-layer sh-layer-top">
      <div className="sh-scrim" onClick={close} aria-hidden="true" />
      <div
        ref={box}
        className="sh-sheet sh-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sh-settings-title"
        data-testid="shield-settings"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <span className="sh-grab" aria-hidden="true" />
        <div className="sh-sheet-head">
          <MaiaHalo size="md" />
          <h2 id="sh-settings-title" className="sh-sheet-title" tabIndex={-1}>
            {R.settings}
          </h2>
          <button type="button" className="sh-icon-btn" aria-label={R.close} onClick={close}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
              <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
            </svg>
          </button>
        </div>
        {problem && view && (
          <p className="sh-problem" role="status">
            {problem}
          </p>
        )}
        <div className="sh-sheet-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
