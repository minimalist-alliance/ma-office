// The mock's side of messages between the member's desks (W6; deskd API.md section 18), two mock desks and a carrier loop in the
// test standing in for the office's: the pairing (offer, Allow, accept), a message and its answer, Not now, Stop on either side,
// and each refusal the contract names, so the shell spec and the demo see what two desks do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError, newIdem } from '../client/agentClient';
import type { DeskOrigin, Message } from '../client/types';
import { MockAgentClient } from './mockAgentClient';

const m = () => ({ idem: newIdem() });
const LEAD = 'manager';

async function refusal(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('not refused');
}

/** What the office does for one ordered pair, once: take, deliver each in order, then `done` with every outcome. */
async function carry(from: MockAgentClient, to: MockAgentClient): Promise<{ id: string; outcome: string; reason?: string }[]> {
  const taken = await from.takeOutbox(to.deskId);
  const results: { id: string; outcome: string; reason?: string }[] = [];
  for (const e of taken.envelopes) {
    try {
      results.push({ id: e.id, outcome: (await to.deliverEnvelope(e.envelope)).outcome });
    } catch (err) {
      if (!(err instanceof AgentError) || !err.reason) throw err;
      results.push({ id: e.id, outcome: 'refused', reason: err.reason });
    }
  }
  if (results.length) await from.doneOutbox(results);
  return results;
}

const deskMsgs = (t: { messages: Message[] }): (Message & { origin: DeskOrigin })[] => t.messages.filter((x): x is Message & { origin: DeskOrigin } => x.origin?.kind === 'desk');

let A: MockAgentClient;
let B: MockAgentClient;

beforeEach(() => {
  vi.useFakeTimers();
  A = new MockAgentClient({ fixture: 'ready', deskId: 'd-personal', deskName: 'Personal', latencyMs: 0, streamMs: 1 });
  B = new MockAgentClient({ fixture: 'ready', deskId: 'd-work', deskName: 'Work', latencyMs: 0, streamMs: 1 });
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = async (ms = 50): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
/** A call, with the mock's timers run until it settles: its answer, or its refusal thrown. */
const run = async <T>(p: Promise<T>): Promise<T> => {
  const settled = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await settle(5);
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
};

/** A's lead offers B; B's member allows it with `answerer`; the accept comes back. Answers the grant. */
async function pair(answerer = LEAD): Promise<string> {
  await run(A.setAccess(LEAD, { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }] }, m()));
  await run(carry(A, B));
  const offer = (await run(B.listDeskHalves())).offers[0]!;
  await run(B.answerDeskOffer(offer.grantId, { allow: true, agentId: answerer }, m()));
  await run(carry(B, A));
  return offer.grantId;
}

describe('mock: pairing two desks', () => {
  it('offers, shows the offer on the other desk, and allows it with the agent that answers', async () => {
    const seen: (number | null)[] = [];
    B.watchAgents((_a, _c, desk) => seen.push(desk?.deskOffers ?? null));
    const access = await run(A.setAccess(LEAD, { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }] }, m()));
    expect(access.desks.map((d) => [d.toDeskId, d.state])).toEqual([['d-work', 'offered']]);
    const outbox: unknown[] = [];
    A.watchOutbox((e) => outbox.push(e.pending));
    await settle();
    expect(outbox.at(-1)).toEqual([{ toDeskId: 'd-work', count: 1, oldestAt: expect.any(Number) }]);

    expect((await run(carry(A, B))).map((r) => r.outcome)).toEqual(['delivered']);
    await settle();
    expect(seen.at(-1)).toBe(1);
    const list = await run(B.listDeskHalves());
    expect(list.offers.map((h) => [h.fromDeskId, h.fromAgentName, h.state, h.agentId])).toEqual([['d-personal', 'Lead', 'offered', null]]);
    // Every agent's screen on B sees the offer waiting (`incoming`).
    expect((await run(B.getAccess('researcher'))).incoming.map((h) => h.state)).toEqual(['offered']);

    const half = await run(B.answerDeskOffer(list.offers[0]!.grantId, { allow: true, agentId: 'researcher' }, m()));
    expect([half.state, half.agentId]).toEqual(['active', 'researcher']);
    await settle();
    expect(seen.at(-1)).toBe(0);
    expect((await run(B.getAccess('researcher'))).incoming.map((h) => [h.state, h.agentId])).toEqual([['active', 'researcher']]);
    expect((await run(B.getAccess(LEAD))).incoming).toEqual([]);

    await run(carry(B, A));
    const after = await run(A.getAccess(LEAD));
    expect(after.desks.map((d) => [d.state, d.toAgentName])).toEqual([['active', 'Researcher']]);
    // Once A has it, nothing more waits either way.
    expect(await run(carry(A, B))).toEqual([]);
    expect(await run(carry(B, A))).toEqual([]);
  });

  it('Not now leaves the offer declined, still listed, and sends nothing', async () => {
    await run(A.setAccess(LEAD, { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }] }, m()));
    await run(carry(A, B));
    const offer = (await run(B.listDeskHalves())).offers[0]!;
    const half = await run(B.answerDeskOffer(offer.grantId, { allow: false }, m()));
    expect(half.state).toBe('declined');
    expect((await run(B.listDeskHalves())).offers.map((h) => h.state)).toEqual(['declined']);
    expect(await run(carry(B, A))).toEqual([]);
    expect((await run(A.getAccess(LEAD))).desks[0]!.state).toBe('offered');
    // Allowed later after all, from an agent's screen or settings.
    await run(B.answerDeskOffer(offer.grantId, { allow: true, agentId: LEAD }, m()));
    await run(carry(B, A));
    expect((await run(A.getAccess(LEAD))).desks[0]!.state).toBe('active');
  });
});

describe('mock: a message and its answer', () => {
  it('runs the answering agent on the other desk, and the answer lands in the sender’s thread, untrusted', async () => {
    await pair('researcher');
    const envelopeId = A.deskMessage(LEAD, 'd-work', 'What did the landlord say about Tuesday?');
    // The run ends at once with the tool's "Sent.", and its chip.
    const sent = (await run(A.getThread(LEAD))).messages.at(-1)!;
    expect(sent.text).toBe('Sent. It reaches Work when your office is open and Work is running, and the answer will come to this thread.');
    expect(sent.tools?.map((t) => t.name)).toEqual(['desk_message']);

    expect((await run(carry(A, B))).map((r) => r.id)).toEqual([envelopeId]);
    const there = deskMsgs(await run(B.getThread('researcher')));
    expect(there.map((x) => [x.origin.role, x.origin.agentName, x.origin.deskId, x.text])).toEqual([['message', 'Lead', 'd-personal', 'What did the landlord say about Tuesday?']]);
    await settle(2_000); // the Researcher's run streams its answer
    expect((await run(carry(B, A))).map((r) => r.outcome)).toEqual(['delivered']);
    const back = deskMsgs(await run(A.getThread(LEAD)));
    expect(back.map((x) => [x.origin.role, x.origin.agentName, x.origin.deskId, x.origin.replyTo, x.untrusted])).toEqual([['answer', 'Researcher', 'd-work', envelopeId, true]]);
    expect(back[0]!.text).toMatch(/^Researcher here, on your Work desk\./);
    // Both halves count it.
    expect((await run(A.getAccess(LEAD))).desks[0]!.count).toBe(1);
    expect((await run(B.getAccess('researcher'))).incoming[0]!.count).toBe(1);
  });

  it('with a wait, the run is calm (`waiting_desk`) until the answer, which is then its result', async () => {
    await pair();
    const states: (string | null | undefined)[] = [];
    A.watchAgents((agents) => states.push(agents.find((a) => a.id === LEAD)?.statusDetail));
    A.deskMessage(LEAD, 'Work', 'Is the Tuesday meeting still on?', { wait: true, waitMs: 60_000 });
    await settle();
    expect(states.at(-1)).toBe('waiting_desk');
    await run(carry(A, B));
    await settle(2_000);
    await run(carry(B, A));
    await settle();
    expect(states.at(-1)).toBeNull();
    const last = (await run(A.getThread(LEAD))).messages.at(-1)!;
    expect([last.state, last.untrusted, last.text.startsWith('Lead on your Work desk answered: Lead here')]).toEqual(['done', true, true]);
    // No answer landed as a thread message: it was the tool's result.
    expect(deskMsgs(await run(A.getThread(LEAD)))).toEqual([]);
  });

  it('refuses before anything goes: no active grant, more than 20 a day, no text', async () => {
    expect((await refusal(Promise.resolve().then(() => A.deskMessage(LEAD, 'd-work', 'hi')))).reason).toBe('no_grant');
    await pair();
    expect((await refusal(Promise.resolve().then(() => A.deskMessage(LEAD, 'd-work', '')))).reason).toBe('input');
    for (let i = 0; i < 20; i += 1) A.deskMessage(LEAD, 'd-work', `n${i}`);
    expect((await refusal(Promise.resolve().then(() => A.deskMessage(LEAD, 'd-work', 'one more')))).reason).toBe('rate');
  });
});

describe('mock: Stop, and what each desk refuses', () => {
  it('Stop on the answering desk refuses the very next message, and the sender’s thread says so', async () => {
    const grantId = await pair('researcher');
    A.deskMessage(LEAD, 'd-work', 'Sent before the stop reached here');
    const stopped = await run(B.revokeDeskGrant(grantId, m()));
    expect(stopped.agentId).toBe('researcher');
    expect(stopped.access.incoming).toEqual([]);
    const outcomes = await run(carry(A, B));
    expect(outcomes.map((r) => [r.outcome, r.reason])).toEqual([['refused', 'revoked']]);
    const notice = deskMsgs(await run(A.getThread(LEAD))).at(-1)!;
    expect([notice.origin.role, notice.origin.notice, notice.origin.reason, notice.origin.deskId]).toEqual(['notice', 'refused', 'revoked', 'd-work']);
    // The `revoke` reaches A: its half goes, and its agent can't message that desk any more.
    expect((await run(carry(B, A))).map((r) => r.outcome)).toEqual(['delivered']);
    expect((await run(A.getAccess(LEAD))).desks).toEqual([]);
    expect((await refusal(Promise.resolve().then(() => A.deskMessage(LEAD, 'd-work', 'again')))).reason).toBe('no_grant');
  });

  it('Stop on the sending desk tells the other, which then refuses anything of that grant', async () => {
    const grantId = await pair('researcher');
    await run(A.revokeDeskGrant(grantId, m()));
    await run(carry(A, B));
    expect((await run(B.listDeskHalves())).answers).toEqual([]);
  });

  it('drops an envelope it has by id, and refuses one stale, expired, another desk’s or another member’s', async () => {
    await pair();
    const id = A.deskMessage(LEAD, 'd-work', 'once');
    const env = (await run(A.takeOutbox('d-work'))).envelopes.find((e) => e.id === id)!.envelope;
    expect((await run(B.deliverEnvelope(env))).outcome).toBe('delivered');
    expect((await run(B.deliverEnvelope(env))).outcome).toBe('duplicate');
    const tamper = (fn: (p: Record<string, unknown>) => void, newId = true): string => {
      const outer = JSON.parse(env) as { id: string; p: string };
      const p = JSON.parse(outer.p) as Record<string, unknown>;
      fn(p);
      if (newId) {
        p['id'] = `${outer.id}-x`;
        outer.id = `${outer.id}-x`;
      }
      return JSON.stringify({ ...outer, p: JSON.stringify(p) });
    };
    expect((await refusal(run(B.deliverEnvelope(tamper(() => undefined))))).reason).toBe('stale');
    expect((await refusal(run(B.deliverEnvelope(tamper((p) => (p['to'] = 'd-other')))))).reason).toBe('not_for_me');
    expect((await refusal(run(B.deliverEnvelope(tamper((p) => (p['account'] = 'someone-else')))))).reason).toBe('account');
    expect((await refusal(run(B.deliverEnvelope(tamper((p) => ((p['seq'] = 99), (p['sentAt'] = Date.now() - 8 * 86_400_000))))))).reason).toBe('expired');
    expect((await refusal(run(B.deliverEnvelope('not an envelope')))).code).toBe('bad_request');
  });

  it('deleting an agent revokes its halves, and each other desk hears of it', async () => {
    await run(A.setAccess(LEAD, { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }] }, m()));
    await run(carry(A, B));
    const offer = (await run(B.listDeskHalves())).offers[0]!;
    await run(B.answerDeskOffer(offer.grantId, { allow: true, agentId: 'researcher' }, m()));
    await run(carry(B, A));
    await run(B.deleteAgent('researcher', m()));
    await run(carry(B, A));
    expect((await run(A.getAccess(LEAD))).desks).toEqual([]);
  });
});
