// Messages between the member's desks (W6): the words, the names and the cards, as the member reads them.
import { describe, expect, it } from 'vitest';
import type { Approval, DeskIncomingHalf, ToolChip } from '../client/types';
import { statusDot, statusWord } from './agents';
import { cardOf, doneWord } from './approvals';
import {
  answerers,
  answersBy,
  answersLine,
  deskLabel,
  deskLine,
  grantUse,
  isWaitingDesk,
  offersOf,
  offerWords,
  plainName,
  usedLine,
  yourDesk,
} from './deskMessages';
import { chipOf } from './tools';

const DESKS = [
  { deskId: 'd-personal', name: 'Personal' },
  { deskId: 'd-work', name: 'Work' },
];

const half = (over: Partial<DeskIncomingHalf> = {}): DeskIncomingHalf => ({
  grantId: 'dg-1',
  fromDeskId: 'd-personal',
  fromAgentId: 'manager',
  fromAgentName: 'Lead',
  agentId: null,
  state: 'offered',
  createdAt: 1,
  lastUsedAt: null,
  count: 0,
  ...over,
});

describe('names from another desk', () => {
  it('are plain text: no bidi override, zero-width, control or filler, one line, at most 60 characters', () => {
    expect(plainName('Le\u202Ead')).toBe('Lead');
    expect(plainName('\u200BScout\u2066\u2069')).toBe('Scout');
    expect(plainName('Wri\u0000ter\n\tTwo')).toBe('Writer Two');
    expect(plainName('A\u3164B\u115F')).toBe('AB');
    expect(plainName('  ')).toBe('An agent');
    expect(plainName(undefined, 'its agent')).toBe('its agent');
    expect(plainName('x'.repeat(80))).toHaveLength(60);
    expect(plainName('😀'.repeat(61))).toBe('😀'.repeat(60));
  });

  it('name a desk from the member’s own list by id, never from what the other desk said', () => {
    expect(deskLabel('d-work', DESKS)).toBe('Work');
    expect(deskLabel('d-gone', DESKS)).toBeNull();
    expect(yourDesk('d-work', DESKS)).toBe('your Work desk');
    expect(yourDesk('d-gone', DESKS)).toBe('your other desk');
  });
});

describe('the offer and the halves that answer', () => {
  it('says the ADR’s words, with {X} the other desk’s text and {A} the member’s name for that desk', () => {
    expect(offerWords(half(), DESKS)).toEqual({
      lead: 'Lead on your Personal desk wants to message agents here.',
      pick: 'Choose which agent answers it:',
      trust: 'Whatever Lead sends is read as information, not instructions, and the answer goes back to Personal.',
      known: true,
    });
    // A desk the member's list doesn't have: said so, and it can't be allowed (Security's DM-I3).
    const odd = offerWords(half({ fromAgentName: 'Le\u202Ead', fromDeskId: 'd-gone' }), DESKS);
    expect(odd.lead).toBe('Lead on a desk that isn’t in your office wants to message agents here.');
    expect(odd.trust).toBe('Only desks in your office can message agents here. Not now puts it away.');
    expect(odd.known).toBe(false);
  });

  it('lists offers (Not now’s too) and an agent’s own answer halves, oldest first', () => {
    const list = [
      half({ grantId: 'a', createdAt: 3 }),
      half({ grantId: 'b', state: 'declined', createdAt: 2 }),
      half({ grantId: 'c', state: 'active', agentId: 'scout', createdAt: 1 }),
      half({ grantId: 'd', state: 'active', agentId: 'manager' }),
      half({ grantId: 'e', state: 'revoked', agentId: 'scout' }),
    ];
    expect(offersOf(list).map((h) => h.grantId)).toEqual(['b', 'a']);
    expect(answersBy(list, 'scout').map((h) => h.grantId)).toEqual(['c']);
    expect(answersLine(half(), DESKS)).toBe('Answers Lead on your Personal desk');
  });

  it('says how much a grant has been used, and that it’s allowed once the other desk says so', () => {
    expect(usedLine(0, null)).toBe('Not used yet.');
    expect(usedLine(1, Date.UTC(2026, 10, 12, 12))).toMatch(/^Used once, last on .+\.$/);
    expect(usedLine(3, Date.UTC(2026, 10, 12, 12))).toMatch(/^Used 3 times, last on .+\.$/);
    expect(grantUse(0, null)).toBe('Allowed. Not used yet.');
    expect(grantUse(0, null, 'Sc\u200Bout')).toBe('Allowed. Scout answers there. Not used yet.');
  });

  it('offers this desk’s agents to answer, the lead first', () => {
    const agents = [
      { id: 'scout', name: 'Scout', role: 'staff' },
      { id: 'manager', name: 'Lead', role: 'manager', lead: true },
    ] as never;
    expect(answerers(agents).map((a) => a.id)).toEqual(['manager', 'scout']);
  });
});

describe('the threads', () => {
  const o = { agentName: 'Scout', deskId: 'd-work', grantId: 'g', envelopeId: 'e', agentId: 'scout', kind: 'desk' as const };
  it('says who a message or an answer is from, on which of the member’s desks', () => {
    expect(deskLine({ ...o, role: 'message' }, DESKS)).toBe('From Scout on your Work desk');
    expect(deskLine({ ...o, role: 'answer', agentName: 'Sc\u202Eout' }, DESKS)).toBe('From Scout on your Work desk');
  });

  it('says the contract’s notices: not delivered in 7 days, refused there and why, and couldn’t answer', () => {
    expect(deskLine({ ...o, role: 'notice', notice: 'not_delivered' }, DESKS)).toBe('Not delivered: your Work desk wasn’t reachable for 7 days.');
    expect(deskLine({ ...o, role: 'notice', notice: 'refused', reason: 'revoked' }, DESKS)).toBe('Not delivered: your Work desk didn’t take it. You stopped these messages there.');
    expect(deskLine({ ...o, role: 'notice', notice: 'refused', reason: 'rate' }, DESKS)).toBe('Not delivered: your Work desk didn’t take it. It had taken 20 messages from this agent today. Try again tomorrow.');
    expect(deskLine({ ...o, role: 'notice', notice: 'refused', reason: 'bad_signature' }, DESKS)).toBe('Not delivered: your Work desk didn’t take it. It couldn’t be opened there.');
    expect(deskLine({ ...o, role: 'notice', notice: 'failed', reason: 'no_key' }, DESKS)).toBe('Scout on your Work desk couldn’t answer. It needs a key on that desk.');
  });

  it('reads a run waiting for its other desk as calm, not busy work', () => {
    const waiting = { status: 'working' as const, statusDetail: 'waiting_desk', binding: null };
    expect(isWaitingDesk(waiting)).toBe(true);
    expect(statusWord(waiting)).toBe('waiting for your other desk');
    expect(statusDot(waiting)).toBe('online');
    expect(statusWord({ status: 'working', statusDetail: null, binding: null })).toBe('working');
  });
});

describe('the cards', () => {
  const base: Approval = {
    id: 'ap-1',
    agentId: 'manager',
    runId: 'run-1',
    messageId: 'msg-1',
    tool: 'desk_message',
    risk: 'send',
    title: 'Send a message to your other desk',
    context: 'agent',
    target: { kind: 'desk', deskId: 'd-work', deskName: 'Somewhere else', agentName: 'Sc\u202Eout' },
    payload: { desk: 'd-work', text: 'What did the landlord say?\nAnd when?' },
    before: null,
    sha256: '00',
    untrusted: false,
    origin: { kind: 'member' },
    state: 'pending',
    detail: null,
    createdAt: 1,
    expiresAt: 2,
    decidedAt: null,
    decidedBy: null,
    note: null,
    result: null,
  };
  const agents = [{ id: 'manager', name: 'Lead' }];

  it('desk_message: the contract’s words, the desk by the member’s own name, and the exact text as data', () => {
    const v = cardOf(base, agents, DESKS);
    expect(v.title).toBe('Send this to Scout on your Work desk?');
    expect(v.note).toEqual({ icon: 'out', text: 'It may include things Lead read on this desk.' });
    expect(v.fields).toEqual([
      { label: 'Tool', value: 'Agent · Message your other desk' },
      { label: 'To', value: 'Scout on your Work desk' },
      { label: 'Text', value: 'What did the landlord say?\nAnd when?', long: true },
    ]);
    expect(v.asked).toBe('send this to Scout on your Work desk');
    expect(v.level).toBe('send');
    // Hidden characters in the text show as what they are.
    expect(cardOf({ ...base, payload: { desk: 'd-work', text: 'pay\u202Eme' } }, agents, DESKS).fields[2]!.value).toBe('pay⟨U+202E⟩me');
  });

  it('desk_answer: the answer’s words on the desk that answers', () => {
    const v = cardOf({ ...base, tool: 'desk_answer', agentId: 'scout', target: { kind: 'desk', deskId: 'd-personal', agentName: 'Lead' }, payload: { grantId: 'g', replyTo: 'e', text: 'Tuesday.' } }, [{ id: 'scout', name: 'Scout' }], DESKS);
    expect(v.title).toBe('Send this answer to Lead on your Personal desk?');
    expect(v.note?.text).toBe('It includes things Scout read here.');
    expect(v.fields.map((f) => [f.label, f.value])).toEqual([
      ['Tool', 'Agent · Answer your other desk'],
      ['To', 'Lead on your Personal desk'],
      ['Answer', 'Tuesday.'],
    ]);
  });

  it('desk_message’s chip says what it did, in a few words', () => {
    expect(doneWord('desk_message')).toBe('Messaged an agent on your other desk');
    const chip: ToolChip = { name: 'desk_message', summary: 'whatever the desk says', ok: true, risk: 'own', target: { kind: 'desk', deskId: 'd-work' } };
    expect(chipOf(chip)?.word).toBe('Messaged an agent on your other desk');
  });
});
