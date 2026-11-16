// One person across channels (the Designer's flow 11, stills 15 to 18 and p12 to p14): a person holds endpoints (a member
// address, emails, numbers), and has one conversation. Linking moves an endpoint onto a person; unlinking moves it back to a
// person of its own. **A link is never made without the member's press:** a suggestion only asks, and a drop or a pick is the
// member's own act. Suggestions come from contact cards (the Mac's, a card the member added, a mailbox's address book), a
// signature on mail that passed DMARC, or a name alone; never from Requests' bodies, an unconfirmed sender or an agent.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toCourierError, type CourierClient } from './client';
import { endpointMedium, firstName, parseEndpoint, sourcesPhrase, waysLine, whyLine } from './model';
import { SafetyNumber } from './Keys';
import { Icon, MenuButton, type Foot, type MenuItem } from './parts';
import type { Endpoint, Lookup, MemberKey, Person, PersonEndpoint, Suggestion } from './types';
import { MEDIUM_WORDS, W } from './words';

export const sameEndpoint = (a: Pick<Endpoint, 'kind' | 'value'>, b: Pick<Endpoint, 'kind' | 'value'>): boolean => a.kind === b.kind && a.value.toLowerCase() === b.value.toLowerCase();

/** The suggestion for one endpoint, the strongest first, or null. */
export const suggestionFor = (list: readonly Suggestion[] | null, e: Pick<Endpoint, 'kind' | 'value'> | null | undefined): Suggestion | null => (list && e ? (list.find((s) => sameEndpoint(s.endpoint, e)) ?? null) : null);

/** "Is this also Dana Ortiz?", at the top of that endpoint's conversation (15, p12) and on its Requests card (08). */
export function SuggestAsk({ s, onLink, onNot, card }: { s: Suggestion; onLink(): void; onNot(): void; card?: boolean }) {
  const first = firstName(s.into.name);
  const id = useId();
  return (
    <div className={card ? 'courier-suggest in-card' : 'courier-suggest'} role="group" aria-labelledby={id} data-testid="courier-suggest">
      <Icon name="link" />
      <div className="courier-suggest-main">
        <strong id={id}>{W.linkAsk(s.into.name)}</strong>
        <span>{whyLine(s)}</span>
        <div className="courier-decide-btns">
          <button type="button" className="courier-btn primary" onClick={onLink}>
            {W.linkYes(first)}
          </button>
          <button type="button" className="courier-btn" onClick={onNot}>
            {W.linkNo(first)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One note at the top of People after contacts arrive: "{n} people may be someone you already have." with Review. */
export function LinkNote({ n, onReview }: { n: number; onReview(): void }) {
  return (
    <div className="courier-linknote" role="note" data-testid="courier-linknote">
      <Icon name="link" />
      <div>
        <p>{W.linkNote(n)}</p>
        <button type="button" className="courier-btn" onClick={onReview}>
          {W.review}
        </button>
      </div>
    </div>
  );
}

function PaneHead({ title, onBack, headRef, children }: { title: string; onBack(): void; headRef?: React.RefObject<HTMLHeadingElement | null>; children?: ReactNode }) {
  return (
    <div className="courier-setup-head">
      <button type="button" className="courier-icon-btn" onClick={onBack} aria-label={W.back} title={W.back}>
        <Icon name="back" />
      </button>
      <h2 ref={headRef} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </div>
  );
}

/**
 * Link people (18): one row per suggestion, each with Link and Not them, and one button for the rows a contact card backs.
 * Name-only rows never get a filled button: the member checks those.
 */
export function LinkReview({ list, onLink, onNot, onLinkCards, onBack, foot }: { list: Suggestion[]; onLink(s: Suggestion): void; onNot(s: Suggestion): void; onLinkCards(list: Suggestion[]): void; onBack(): void; foot: ReactNode }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  const cards = list.filter((s) => s.strength === 'card');
  return (
    <div className="courier-setup courier-review" data-testid="courier-review">
      <PaneHead title={W.linkTitle} onBack={onBack} headRef={head} />
      <div className="courier-setup-scroll">
        <p className="courier-quiet">{list.length ? W.linkLead(sourcesPhrase(list)) : W.linkNoDone}</p>
        {cards.length > 0 && (
          <div>
            <button type="button" className="courier-btn" onClick={() => onLinkCards(cards)}>
              <Icon name="link" />
              <span>{W.linkAllCards(cards.length)}</span>
            </button>
          </div>
        )}
        <ul className="courier-review-rows" aria-label={W.linkTitle}>
          {list.map((s) => (
            <li key={`${s.endpoint.kind}:${s.endpoint.value}|${s.into.contactId}`} className="courier-review-row">
              <div className="courier-review-pair">
                <EndpointMark e={s.endpoint} />
                <span className="courier-review-ep">{s.endpoint.value}</span>
                <span aria-hidden="true">›</span>
                <span className="courier-sr">{W.linkTo}</span>
                <strong>{s.into.name}</strong>
              </div>
              <p className="courier-quiet">{whyLine(s)}</p>
              <div className="courier-decide-btns">
                <button type="button" className={`courier-btn${s.strength === 'name' ? '' : ' primary'}`} onClick={() => onLink(s)} aria-label={`${W.linkRowYes}: ${s.endpoint.value}, ${s.into.name}`}>
                  {W.linkRowYes}
                </button>
                <button type="button" className="courier-btn" onClick={() => onNot(s)} aria-label={`${W.linkRowNo}: ${s.endpoint.value}, ${s.into.name}`}>
                  {W.linkRowNo}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {foot}
    </div>
  );
}

function EndpointMark({ e }: { e: Pick<Endpoint, 'kind'> }) {
  const m = endpointMedium(e);
  return <Icon name={m === 'ma' ? 'sealed' : m === 'imessage' ? 'bubble' : 'mail'} />;
}

function sourceWords(e: PersonEndpoint): string | null {
  if (!e.source) return null;
  if (e.source === 'provider') return W.epSource.provider(e.provider ?? 'mail');
  return W.epSource[e.source];
}

type AddState = { kind: 'idle' } | { kind: 'brings'; n: number } | { kind: 'move'; other: string } | { kind: 'new' } | { kind: 'mine' };

/**
 * The person view (16): every way to reach them, each with Copy and Unlink; "Add an email or number". Pressing the name in a
 * conversation's header opens it. Unlink is one press, with Undo at the foot (p13); nothing is deleted.
 */
export function PersonPane({ client, contactId, domain, reload, linksOn, now, onBack, onAdd, onUnlink, onKeys, copy, foot }: { client: CourierClient; contactId: string; domain: string | null; reload: number; linksOn: boolean; now: number; onBack(): void; onAdd(person: Person, e: Endpoint): Promise<boolean>; onUnlink(person: Person, e: Endpoint): void; onKeys(foot: Foot): void; copy(text: string): void; foot: ReactNode }) {
  const [person, setPerson] = useState<Person | null | undefined>(undefined);
  const [keys, setKeys] = useState<MemberKey[]>([]);
  const [typed, setTyped] = useState('');
  const [add, setAdd] = useState<AddState>({ kind: 'idle' });
  const head = useRef<HTMLHeadingElement>(null);
  const ids = { add: useId(), line: useId() };
  useEffect(() => {
    let gone = false;
    client.person(contactId).then(
      (p) => !gone && setPerson(p),
      () => !gone && setPerson(null),
    );
    // A person with a member address: its safety number (flow 5), or its changed key (flow 6).
    client.memberKeys(contactId).then(
      (k) => !gone && setKeys(k),
      () => !gone && setKeys([]),
    );
    return () => {
      gone = true;
    };
  }, [client, contactId, reload]);
  const shown = person !== undefined;
  useEffect(() => {
    if (shown) head.current?.focus();
  }, [shown]);

  const endpoint = parseEndpoint(typed, domain);
  // What the typed email or number already is, 300 ms after the last key.
  useEffect(() => {
    if (!endpoint || !person) {
      setAdd({ kind: 'idle' });
      return;
    }
    if (person.endpoints.some((e) => e.kind === endpoint.kind && e.value.toLowerCase() === endpoint.value.toLowerCase())) {
      setAdd({ kind: 'mine' });
      return;
    }
    let gone = false;
    const t = window.setTimeout(() => {
      void client.lookup(endpoint).then(
        (l: Lookup | null) => {
          if (gone) return;
          if (!l || !l.contactId) return setAdd({ kind: 'new' });
          // On someone else (a named person, or one with other ways to reach them): ask in place. Else its messages come in.
          if (l.contactId !== person.contactId && (l.endpoints > 1 || l.name.trim())) return setAdd({ kind: 'move', other: l.name.trim() || endpoint.value });
          setAdd(l.messages > 0 ? { kind: 'brings', n: l.messages } : { kind: 'new' });
        },
        () => !gone && setAdd({ kind: 'new' }),
      );
    }, 300);
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
    // The typed value decides; the parsed object is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, typed, domain, person]);

  if (person === undefined) {
    return (
      <div className="courier-setup courier-center" data-testid="courier-person" aria-busy="true">
        <p className="courier-quiet">{W.loading}</p>
      </div>
    );
  }
  if (person === null) {
    return (
      <div className="courier-setup" data-testid="courier-person">
        <PaneHead title={W.back} onBack={onBack} headRef={head} />
        <p className="courier-note">{W.failed}</p>
      </div>
    );
  }
  const name = person.name.trim() || person.endpoints[0]?.value || '';
  const first = firstName(name);
  const submit = async (): Promise<void> => {
    if (!endpoint || add.kind === 'idle' || add.kind === 'mine' || add.kind === 'move') return;
    if (await onAdd(person, endpoint)) setTyped('');
  };
  return (
    <div className="courier-setup courier-person" data-testid="courier-person">
      <PaneHead title={name} onBack={onBack} headRef={head} />
      <div className="courier-setup-scroll">
        <section aria-labelledby="courier-ways-h">
          <h3 id="courier-ways-h">{W.personWays(first)}</h3>
          <ul className="courier-ways">
            {person.endpoints.map((e) => {
              const medium = endpointMedium(e);
              const source = sourceWords(e);
              const items: MenuItem[] = [{ key: 'copy', label: e.kind === 'phone' ? W.copyNumber : W.copyAddress, onPick: () => copy(e.value) }];
              if (linksOn && person.endpoints.length > 1) items.push({ key: 'unlink', label: W.unlink, line: W.unlinkLine, onPick: () => onUnlink(person, e) });
              return (
                <li key={`${e.kind}:${e.value}`} className="courier-way">
                  <EndpointMark e={e} />
                  <div className="courier-way-main">
                    <span className="courier-way-value">{e.value}</span>
                    <span className="courier-quiet">{source ? `${MEDIUM_WORDS[medium]} · ${source}` : MEDIUM_WORDS[medium]}</span>
                  </div>
                  <MenuButton label={`${W.moreActions}: ${e.value}`} items={items} />
                </li>
              );
            })}
          </ul>
        </section>
        {linksOn && (
          <form
            className="courier-way-add"
            onSubmit={(ev) => {
              ev.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={ids.add}>{W.personAdd}</label>
            <div className="courier-way-add-row">
              <input id={ids.add} type="text" inputMode="email" autoComplete="off" spellCheck={false} maxLength={320} value={typed} onChange={(e) => setTyped(e.target.value)} aria-describedby={ids.line} />
              <button type="submit" className="courier-btn primary" disabled={!endpoint || (add.kind !== 'new' && add.kind !== 'brings')}>
                {W.add}
              </button>
            </div>
            <div id={ids.line} role="status" className="courier-way-add-line">
              {endpoint && add.kind === 'brings' && <p className="courier-quiet">{W.personAddBrings(add.n, endpoint.value)}</p>}
              {endpoint && add.kind === 'move' && (
                <div className="courier-ask" role="group" aria-label={W.personMove(endpoint.value, add.other, first)}>
                  <span>{W.personMove(endpoint.value, add.other, first)}</span>
                  <button
                    type="button"
                    className="courier-btn"
                    onClick={() =>
                      void onAdd(person, endpoint).then((ok) => {
                        if (ok) setTyped('');
                      })
                    }
                  >
                    {W.personMoveYes}
                  </button>
                  <button type="button" className="courier-btn quiet" onClick={() => setTyped('')}>
                    {W.cancel}
                  </button>
                </div>
              )}
            </div>
          </form>
        )}
        {keys.map((k) => (
          <SafetyNumber key={k.address} client={client} k={k} first={first} now={now} copy={copy} onChanged={onKeys} />
        ))}
      </div>
      {foot}
    </div>
  );
}

/**
 * "Link to someone…" (p14): the keyboard's and screen reader's way to do what a drag does. A sheet with search and the person
 * list; Link to {first name} only once someone is picked. Takes focus on open, gives it back on close, and closes on Esc.
 */
export function LinkSheet({ client, title, exclude, narrow, onPick, onClose }: { client: CourierClient; title: string; exclude: string; narrow: boolean; onPick(p: Person): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [chosen, setChosen] = useState<Person | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const ids = { title: useId(), list: useId() };
  useEffect(() => {
    search.current?.focus();
    const was = back.current;
    return () => (was as HTMLElement | null)?.focus?.();
  }, []);
  useEffect(() => {
    let gone = false;
    const t = window.setTimeout(() => {
      client.people(q).then(
        (list) => {
          if (gone) return;
          setFailed(false);
          setPeople(list.filter((p) => p.contactId !== exclude && (p.name.trim() || p.endpoints.length)));
        },
        (e) => {
          if (gone) return;
          setFailed(true);
          setPeople([]);
          void toCourierError(e);
        },
      );
    }, 200);
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
  }, [client, q, exclude]);
  const first = chosen ? firstName(chosen.name.trim() || chosen.endpoints[0]?.value || '') : '';
  return (
    <div className={`courier-scrim${narrow ? ' sheet' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`courier-dialog courier-linksheet${narrow ? ' sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        data-testid="courier-linksheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Tab') {
            // The keyboard stays in the sheet.
            const all = [...(ref.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
            const at = all.indexOf(document.activeElement as HTMLElement);
            const next = all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length];
            if (next) {
              e.preventDefault();
              next.focus();
            }
          }
        }}
      >
        <h2 id={ids.title}>{W.linkToTitle(title)}</h2>
        <div className="courier-search">
          <Icon name="search" />
          <input ref={search} type="search" aria-label={W.linkToSearch} placeholder={W.linkToSearch} value={q} onChange={(e) => setQ(e.target.value)} aria-controls={ids.list} />
        </div>
        <ul className="courier-pick" id={ids.list} aria-label={W.linkToSearch}>
          {people?.map((p) => {
            const name = p.name.trim() || p.endpoints[0]?.value || '';
            const on = chosen?.contactId === p.contactId;
            return (
              <li key={p.contactId}>
                <button type="button" className="courier-pick-row" aria-pressed={on} onClick={() => setChosen(on ? null : p)}>
                  <span className="courier-pick-name">{name}</span>
                  <span className="courier-quiet">{waysLine(p)}</span>
                  {on && <Icon name="check" />}
                </button>
              </li>
            );
          })}
        </ul>
        {people && people.length === 0 && <p className="courier-quiet">{failed ? W.failed : W.linkToNone}</p>}
        {chosen && <p className="courier-quiet">{W.linkToLine(first)}</p>}
        <div className="courier-linksheet-btns">
          <button type="button" className="courier-btn quiet" onClick={onClose}>
            {W.cancel}
          </button>
          <button type="button" className="courier-btn primary" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {chosen ? W.linkYes(first) : W.linkTo}
          </button>
        </div>
      </div>
    </div>
  );
}
