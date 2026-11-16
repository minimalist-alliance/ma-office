// Messages between the member's own desks, on the desk that answers (W6; draft ADR "the Agent's tools and approvals", section 14;
// deskd API.md section 18). An offer from an agent on another of the member's desks waits here until the member allows it,
// choosing which agent answers, or says Not now: in the desk team's window as a card, on a new agent's screen and in each agent's
// settings under "Answers your other desks", where an agent's answer halves are listed with their use and a Stop. Calm and plain,
// as the setup screen is: neutral surfaces, no status colours. The other desk is named from the member's own desk list by id;
// the other agent's name is that desk's text, shown as plain text (`model/deskMessages.ts`).
import { useId, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, DeskIncomingHalf } from '../client/types';
import type { OtherDesk } from '../model/access';
import { answerErrorText, answerers, answersBy, ANSWERS_TITLE, answersLine, declinedLine, offersOf, offerWords, plainName, usedLine } from '../model/deskMessages';
import { useRead } from './hooks';

const errorOf = (err: unknown): string => (err instanceof AgentError ? answerErrorText(err.code, err.reason) : answerErrorText(null, null));

/**
 * One offer, in the desk team's window: who wants to message agents here, which agent answers (the lead first), and that
 * whatever comes is untrusted. Allow and Not now go to the desk at once; nothing else answers it.
 */
export function OfferCard({ client, offer, agents, otherDesks, onAnswered, announce }: {
  client: AgentClient;
  offer: DeskIncomingHalf;
  /** This desk's agents. */
  agents: readonly Agent[];
  otherDesks: readonly OtherDesk[];
  onAnswered: (half: DeskIncomingHalf) => void;
  announce?: (text: string) => void;
}) {
  const ids = useId();
  const choices = answerers(agents);
  const [agentId, setAgentId] = useState(choices[0]?.id ?? '');
  const [busy, setBusy] = useState<'allow' | 'later' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = offerWords(offer, otherDesks);
  const answer = async (allow: boolean): Promise<void> => {
    if (busy || (allow && (!agentId || !words.known))) return;
    setBusy(allow ? 'allow' : 'later');
    setError(null);
    try {
      const half = await client.answerDeskOffer(offer.grantId, allow ? { allow: true, agentId } : { allow: false }, { idem: newIdem() });
      const who = choices.find((a) => a.id === agentId)?.name ?? 'Your agent';
      announce?.(allow ? `Allowed. ${who} answers ${plainName(offer.fromAgentName)}.` : 'Not now.');
      onAnswered(half);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ag-offer" role="group" aria-labelledby={`${ids}-lead`} data-testid="desk-offer" data-grant={offer.grantId}>
      <p id={`${ids}-lead`} className="ag-offer-lead">
        {words.lead}
      </p>
      {words.known && (
        <label className="ag-offer-pick" htmlFor={`${ids}-pick`}>
          <span>{words.pick}</span>
          <select id={`${ids}-pick`} value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={busy !== null} data-testid="desk-offer-pick">
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="ag-offer-trust">{words.trust}</p>
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
      <div className="ag-row-end ag-offer-actions">
        <button type="button" className="ag-text-btn" onClick={() => void answer(false)} disabled={busy !== null} data-testid="desk-offer-later">
          Not now
        </button>
        {words.known && (
          <button type="button" className="ag-btn sm primary" onClick={() => void answer(true)} disabled={busy !== null || !agentId} data-testid="desk-offer-allow">
            Allow
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The offers waiting on this desk, in the desk team's window: read with `agent.desks.list`, again whenever `agent.state`'s count of
 * them changes (`version`) and after each answer. Only `offered` ones: Not now puts one away, to the screens' and settings' lists.
 */
export function DeskOfferCards({ client, agents, otherDesks, version, announce }: {
  client: AgentClient;
  agents: readonly Agent[];
  otherDesks: readonly OtherDesk[];
  /** `agent.state`'s `deskOffers`: a change reads the list again. */
  version: unknown;
  announce?: (text: string) => void;
}) {
  const [answered, setAnswered] = useState(0);
  const list = useRead(() => client.listDeskHalves(), [client, version, answered]);
  const offers = (list.value?.offers ?? []).filter((h) => h.state === 'offered' && h.agentId === null);
  if (!offers.length) return null;
  return (
    <div className="ag-offers" data-testid="desk-offers">
      {offers.map((o) => (
        <OfferCard key={o.grantId} client={client} offer={o} agents={agents} otherDesks={otherDesks} onAnswered={() => setAnswered((n) => n + 1)} {...(announce ? { announce } : {})} />
      ))}
    </div>
  );
}

/**
 * "Answers your other desks", in an agent's setup screen and its settings, from `agent.access.get`'s `incoming`: offers waiting
 * here, which this agent can be the one to answer, and the halves it answers, each with its use and a Stop. Every button goes to
 * the desk at once, as the Other desks' Stop does; the form's Save is for the rest.
 */
export function AnswersSection({ client, agent, incoming, otherDesks, onChange, announce, disabled = false }: {
  client: AgentClient;
  agent: Agent;
  incoming: readonly DeskIncomingHalf[];
  otherDesks: readonly OtherDesk[];
  onChange: (incoming: DeskIncomingHalf[]) => void;
  announce?: (text: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offers = offersOf(incoming);
  // On the setup screen too, so an offer allowed there shows as answered, with its Stop.
  const answers = answersBy(incoming, agent.id);
  if (!offers.length && !answers.length) return null;

  const run = async (grantId: string, act: () => Promise<DeskIncomingHalf[]>, said: string): Promise<void> => {
    if (busy) return;
    setBusy(grantId);
    setError(null);
    try {
      onChange(await act());
      announce?.(said);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(null);
    }
  };
  const replace = (half: DeskIncomingHalf): DeskIncomingHalf[] => incoming.map((h) => (h.grantId === half.grantId ? half : h));
  const allow = (h: DeskIncomingHalf): Promise<void> =>
    run(h.grantId, async () => replace(await client.answerDeskOffer(h.grantId, { allow: true, agentId: agent.id }, { idem: newIdem() })), `Allowed. ${agent.name} answers ${plainName(h.fromAgentName)}.`);
  const later = (h: DeskIncomingHalf): Promise<void> => run(h.grantId, async () => replace(await client.answerDeskOffer(h.grantId, { allow: false }, { idem: newIdem() })), 'Not now.');
  const stop = (h: DeskIncomingHalf): Promise<void> => run(h.grantId, async () => (await client.revokeDeskGrant(h.grantId, { idem: newIdem() })).access.incoming ?? [], 'Stopped');

  return (
    <fieldset className="ag-access-section" data-testid="access-answers">
      <legend>{ANSWERS_TITLE}</legend>
      {answers.map((h) => (
        <div key={h.grantId} className="ag-answer-row" data-testid="access-answer">
          <span className="ag-answer-text">
            <span>{answersLine(h, otherDesks)}</span>
            <small>{usedLine(h.count, h.lastUsedAt)}</small>
          </span>
          <button type="button" className="ag-text-btn sm" onClick={() => void stop(h)} disabled={disabled || busy !== null} data-testid="access-answer-stop">
            Stop
          </button>
        </div>
      ))}
      {offers.map((h) => {
        const words = offerWords(h, otherDesks);
        // An offer from a desk that isn't the member's, once put away, has nothing left to do here.
        if (!words.known && h.state === 'declined') return null;
        return (
          <div key={h.grantId} className="ag-answer-row ag-answer-offer" data-testid="access-offer" data-state={h.state}>
            <span className="ag-answer-text">
              <span>{words.lead}</span>
              <small>{h.state === 'declined' ? `${declinedLine} ${words.trust}` : words.trust}</small>
            </span>
            <span className="ag-answer-actions">
              {h.state === 'offered' && (
                <button type="button" className="ag-text-btn sm" onClick={() => void later(h)} disabled={disabled || busy !== null} data-testid="access-offer-later">
                  Not now
                </button>
              )}
              {words.known && (
                <button type="button" className="ag-btn sm" onClick={() => void allow(h)} disabled={disabled || busy !== null} data-testid="access-offer-allow" aria-label={`Allow, and ${agent.name} answers`}>
                  Allow
                </button>
              )}
            </span>
          </div>
        );
      })}
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
