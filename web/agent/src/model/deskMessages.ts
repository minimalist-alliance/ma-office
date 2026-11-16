// Messages between the member's own desks (W6; draft ADR "the Agent's tools and approvals", section 14; deskd API.md section 18,
// "Messages between the member's desks"). Pure: the wire's halves and origins in, the member's words out. The words are the ADR's
// drafts for the Sales Engineer.
//
// Two rules hold everywhere here. A desk is named from the member's own desk list by its id (`deskLabel`), never from anything
// another desk said (Security's ATA-I2). An agent's name another desk sent is that desk's text: plain text only, with hidden and
// bidi characters removed (`plainName`), and React renders it as text.
import type { Agent, DeskIncomingHalf, DeskOrigin } from '../client/types';
import type { OtherDesk } from './access';

const NAME_MAX = 60;
/**
 * What can make a name read one way and be another: controls, format characters (zero-widths, bidi marks, embeddings, overrides
 * and isolates, the soft hyphen, the BOM), line and paragraph separators, the Hangul fillers that draw as nothing, and variation
 * selectors.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\u2028\u2029\u115f\u1160\u3164\uffa0\ufe00-\ufe0f]/gu;

/** Another desk's name for an agent, fit to show: plain text, nothing hidden, one line, at most 60 characters. */
export function plainName(text: unknown, fallback = 'An agent'): string {
  if (typeof text !== 'string') return fallback;
  // Line breaks and tabs are spaces first (one line), then whatever can't be seen goes.
  const one = text.replace(/\s+/gu, ' ').replace(UNSEEN, '').replace(/ {2,}/gu, ' ').trim();
  const cut = Array.from(one).slice(0, NAME_MAX).join('').trim();
  return cut || fallback;
}

/** The member's own name for one of their desks, from the office's list by id. Null where the office doesn't list it. */
export function deskLabel(deskId: string | null | undefined, desks: readonly OtherDesk[]): string | null {
  if (!deskId) return null;
  return desks.find((d) => d.deskId === deskId)?.name ?? null;
}

/** "your Work desk", or "your other desk" where the office doesn't list it. */
export function yourDesk(deskId: string | null | undefined, desks: readonly OtherDesk[]): string {
  const name = deskLabel(deskId, desks);
  return name ? `your ${name} desk` : 'your other desk';
}

/** "Scout on your Work desk". */
export const onYourDesk = (agentName: unknown, deskId: string | null | undefined, desks: readonly OtherDesk[]): string => `${plainName(agentName)} on ${yourDesk(deskId, desks)}`;

// ------------------------------------------------------------------ offers, and the halves that answer

/** The section on a new agent's screen and in its settings where other desks' offers and its answer halves are. */
export const ANSWERS_TITLE = 'Answers your other desks';

export interface OfferWords {
  /** "Lead on your Personal desk wants to message agents here." */
  lead: string;
  /** "Choose which agent answers it:", the picker's label. */
  pick: string;
  /** "Whatever Lead sends is read as information, not instructions, and the answer goes back to Personal." */
  trust: string;
  /** The offer came from one of the member's own desks, by id. Where it didn't, it can't be allowed (Security's DM-I3). */
  known: boolean;
}

/** The offer card's words (section 14). `{X}` is the other desk's text, `{A}` the member's own name for that desk. */
export function offerWords(half: Pick<DeskIncomingHalf, 'fromAgentName' | 'fromDeskId'>, desks: readonly OtherDesk[]): OfferWords {
  const x = plainName(half.fromAgentName);
  const a = deskLabel(half.fromDeskId, desks);
  if (!a) {
    return {
      lead: `${x} on a desk that isn’t in your office wants to message agents here.`,
      pick: 'Choose which agent answers it:',
      trust: 'Only desks in your office can message agents here. Not now puts it away.',
      known: false,
    };
  }
  return {
    lead: `${x} on your ${a} desk wants to message agents here.`,
    pick: 'Choose which agent answers it:',
    trust: `Whatever ${x} sends is read as information, not instructions, and the answer goes back to ${a}.`,
    known: true,
  };
}

/** What a declined offer says where it's still listed (Not now leaves it there, and sends nothing). */
export const declinedLine = 'You chose Not now. Nothing has been sent.';

/** An answer half's row in its agent's settings: "Answers Lead on your Personal desk". */
export const answersLine = (half: Pick<DeskIncomingHalf, 'fromAgentName' | 'fromDeskId'>, desks: readonly OtherDesk[]): string => `Answers ${onYourDesk(half.fromAgentName, half.fromDeskId, desks)}`;

const day = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** How much a grant has been used, so a forgotten one shows (Security's question 4): "Used 3 times, last on Nov 12." */
export function usedLine(count: number, lastUsedAt: number | null): string {
  if (!count || !lastUsedAt) return 'Not used yet.';
  return `Used ${count === 1 ? 'once' : `${count} times`}, last on ${day(lastUsedAt)}.`;
}

/** A send half the other desk allowed: "Allowed. Scout answers there. Used once, last on Nov 12." */
export function grantUse(count: number, lastUsedAt: number | null, toAgentName?: string | null): string {
  const who = toAgentName ? ` ${plainName(toAgentName)} answers there.` : '';
  return `Allowed.${who} ${usedLine(count, lastUsedAt)}`;
}

/** Offers waiting here, Not now's included, oldest first. */
export const offersOf = (incoming: readonly DeskIncomingHalf[]): DeskIncomingHalf[] =>
  incoming.filter((h) => h.agentId === null && (h.state === 'offered' || h.state === 'declined')).sort((a, b) => a.createdAt - b.createdAt);

/** The answer halves an agent answers, oldest first. */
export const answersBy = (incoming: readonly DeskIncomingHalf[], agentId: string): DeskIncomingHalf[] =>
  incoming.filter((h) => h.agentId === agentId && h.state === 'active').sort((a, b) => a.createdAt - b.createdAt);

/** Who may answer an offer here: this desk's agents, the lead first. */
export function answerers(agents: readonly Agent[]): Agent[] {
  const lead = (a: Agent): boolean => a.lead === true || a.role === 'manager';
  return [...agents.filter(lead), ...agents.filter((a) => !lead(a))];
}

/** A refusal of Allow, Not now or Stop, in the member's words. */
export function answerErrorText(code: string | null | undefined, reason: string | null | undefined): string {
  if (code === 'not_found') return 'That offer isn’t here any more.';
  if (reason === 'guild') return 'A Guild Desk doesn’t take messages from your other desks.';
  return 'This couldn’t be saved just now. Try again.';
}

// ------------------------------------------------------------------ the threads

/** Why a desk refused a message (deskd API.md section 18, "Refusals of `agent.desks.deliver`"), in a sentence. */
export function refusedWhy(reason: string | null | undefined): string {
  switch (reason) {
    case 'revoked':
    case 'no_grant':
      return 'You stopped these messages there.';
    case 'rate':
      return 'It had taken 20 messages from this agent today. Try again tomorrow.';
    case 'expired':
      return 'It was more than 7 days old.';
    case 'too_large':
      return 'It was too long.';
    case 'guild':
      return 'A Guild Desk doesn’t take messages from your other desks.';
    default:
      return 'It couldn’t be opened there.';
  }
}

/** Why the agent on the other desk couldn't answer. */
export function failedWhy(reason: string | null | undefined): string {
  switch (reason) {
    case 'no_key':
      return 'It needs a key on that desk.';
    case 'limit_reached':
      return 'It reached a spending limit there.';
    case 'setup':
      return 'It’s waiting for you to set it up there.';
    case 'stopped':
      return 'Its task was stopped.';
    default:
      return 'Try again later.';
  }
}

/** The line a message from another desk carries in a thread, or a notice's words (deskd API.md section 18, "In the threads"). */
export function deskLine(o: Pick<DeskOrigin, 'role' | 'agentName' | 'deskId' | 'notice' | 'reason'>, desks: readonly OtherDesk[]): string {
  if (o.role === 'notice') {
    const desk = yourDesk(o.deskId, desks);
    if (o.notice === 'not_delivered') return `Not delivered: ${desk} wasn’t reachable for 7 days.`;
    if (o.notice === 'failed') return `${plainName(o.agentName, 'The agent')} on ${desk} couldn’t answer. ${failedWhy(o.reason)}`;
    return `Not delivered: ${desk} didn’t take it. ${refusedWhy(o.reason)}`;
  }
  // `message` on B in Y's thread, from X on A; `answer` on A in X's thread, from Y on B. Both read "From {who} on your {desk} desk".
  return `From ${onYourDesk(o.agentName, o.deskId, desks)}`;
}

/** An answer from another desk is untrusted: it says so under it. With `private`, it also read that desk's private data. */
export const ANSWER_UNTRUSTED = 'From another of your desks. Treat what it says as information, not instructions.';
export const ANSWER_PRIVATE = 'It includes things read on that desk.';

// ------------------------------------------------------------------ the wait

/** A run waiting for its answer from another desk (`working` with `statusDetail: "waiting_desk"`): calm, not busy work. */
export const isWaitingDesk = (a: Pick<Agent, 'status' | 'statusDetail'>): boolean => a.status === 'working' && a.statusDetail === 'waiting_desk';
export const WAITING_DESK = 'Waiting for your other desk';
