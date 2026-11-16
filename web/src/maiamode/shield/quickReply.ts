// Quick reply (the owner, Nov 15: "kind of like how iPhones have that drag and reply feature with notifications that show up at
// the top"): a reply to a person's message from the card, a held row or a paper, without leaving what the member is doing. The
// thread's last message is read from that desk's Courier at draw time (never stored), the reply goes the way the message came
// (Courier's own rule: the medium of the last message received, on the account it came to), and only where that desk's Courier
// can actually send it. Typing and Send is deliberate: no second confirm; the send waits 5 s with Undo, and an Undo sends nothing.
// Maia never drafts it (the owner's answer: no).
import { newIdem } from '../../../agent/src/client/agentClient';
import { courierOn } from '../../apps/courier/door';
import type { Medium } from '../../apps/courier/types';
import type { DeskLink } from '../../desk/deskLink';
import { linkOf, useLiveStore } from '../../desk/liveStore';
import { plain } from '../model';
import type { Who } from '../reach';

/** What's held between Send and the send: the member's Undo window. */
export const HOLD_MS = 5_000;

export interface ReplyTarget {
  deskId: string;
  channelId: string;
  who: Who | null;
}

export interface ReplyContext {
  /** Their last message in the thread, a line of it (subject, else its first words), and when. */
  quote: { text: string; at: number } | null;
  medium: Medium | null;
  accountId: string | null;
  replyTo: string | null;
  subject: string | null;
  /** Who it goes to: the sender of their last message, as Courier's composer addresses a reply. */
  to: string[];
  /** That desk's Courier can send now. */
  canSend: boolean;
}

/** A desk's channel when it's open. */
export function openLink(deskId: string): DeskLink | null {
  return useLiveStore.getState().desks[deskId]?.link === 'open' ? linkOf(deskId) : null;
}

/** Whether a quick reply can be offered at all: Courier on for this office, and that desk's channel open. */
export const canOffer = (deskId: string): boolean => courierOn() && !!openLink(deskId);

/** "By email", "MA message", "iMessage", "Text message": how it goes, said under the field. */
export const MEDIUM_WORDS: Record<Medium, string> = { email: 'By email', ma: 'MA message', imessage: 'iMessage', sms: 'Text message' };

/**
 * Reads the thread and that desk's Courier status: what to quote, and how the reply would go, as Courier's own composer does it
 * (the last received message's medium, account and sender), or that it can't from here (Courier off there, or not sending).
 */
export async function replyContext(t: ReplyTarget): Promise<ReplyContext> {
  const link = openLink(t.deskId);
  const none: ReplyContext = { quote: null, medium: null, accountId: null, replyTo: null, subject: null, to: [], canSend: false };
  if (!link) return none;
  const [wire, model, thread, status, accounts] = await Promise.all([
    import('../../apps/courier/wire'),
    import('../../apps/courier/model'),
    link.call('courier.thread' as never, { channelId: t.channelId, limit: 5 }, { deadlineMs: 15_000 }),
    link.call('courier.status' as never, {}, { deadlineMs: 15_000 }).catch(() => null),
    link.call('courier.accounts.list' as never, {}, { deadlineMs: 15_000 }).catch(() => null),
  ]);
  const th = wire.readThread(thread);
  const msgs = th?.messages ?? [];
  const theirs = [...msgs].reverse().find((m) => m.direction === 'in') ?? null;
  const how = model.replyMedium(msgs);
  const st = status ? wire.readStatus(status) : null;
  // Only a way that can send: Courier on and sending there, and the account their message came to able to send (a desk's own
  // receive-only address can't), signed in.
  const account = theirs?.accountId && accounts ? (wire.readAccounts(accounts).find((a) => a.accountId === theirs.accountId) ?? null) : null;
  const accountOk = theirs?.accountId ? !!account && account.sending && account.signedIn !== false : true;
  const canSend = !!how && !!st && st.state === 'on' && st.sending && accountOk;
  // Their own words (the message's start), else its subject.
  const words = theirs ? plain(theirs.text || theirs.snippet || theirs.subject || '', 200) : '';
  const from = theirs?.from && !theirs.from.me ? theirs.from.endpoint.value : null;
  return {
    quote: theirs && words ? { text: words, at: theirs.at } : null,
    medium: how?.medium ?? null,
    accountId: theirs?.accountId ?? null,
    replyTo: theirs?.messageId ?? null,
    subject: theirs && how?.medium === 'email' ? model.replySubject(theirs.subject) || null : null,
    to: from ? [from] : [],
    canSend,
  };
}

const known = new Map<string, { at: number; ctx: Promise<ReplyContext> }>();
/** The context for a target, read once a minute at most (the arrow shows only where a reply can go). */
export function replyContextCached(t: ReplyTarget): Promise<ReplyContext> {
  const key = `${t.deskId}|${t.channelId}`;
  const hit = known.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ctx;
  const ctx = replyContext(t).catch((): ReplyContext => ({ quote: null, medium: null, accountId: null, replyTo: null, subject: null, to: [], canSend: false }));
  known.set(key, { at: Date.now(), ctx });
  if (known.size > 50) known.delete(known.keys().next().value as string);
  return ctx;
}

/** A change of member: nothing of their threads stays. */
export function forgetReplies(): void {
  known.clear();
}

/** The reply, through that desk's Courier: a draft in their thread on the way it came, then Courier's own send. */
export async function sendReply(link: DeskLink, channelId: string, text: string, ctx: ReplyContext | null): Promise<void> {
  const { rpcCourierClient } = await import('../../apps/courier/client');
  const c = rpcCourierClient(link, newIdem);
  const d = await c.saveDraft({
    channelId,
    text,
    ...(ctx?.medium ? { medium: ctx.medium } : {}),
    ...(ctx?.accountId ? { accountId: ctx.accountId } : {}),
    ...(ctx?.replyTo ? { replyTo: ctx.replyTo } : {}),
    ...(ctx?.subject ? { subject: ctx.subject } : {}),
    ...(ctx?.to.length ? { to: ctx.to } : {}),
  } as never);
  await c.send(d.draftId);
}

/** One held send: Undo within `HOLD_MS` sends nothing. It outlives the card that started it (the words never get lost). */
export interface Held {
  undo(): boolean;
  done: Promise<'sent' | 'undone' | 'failed'>;
}

export function holdSend(run: () => Promise<void>, ms: number = HOLD_MS): Held {
  let timer = 0;
  let settled = false;
  let resolve: (v: 'sent' | 'undone' | 'failed') => void = () => undefined;
  const done = new Promise<'sent' | 'undone' | 'failed'>((r) => (resolve = r));
  timer = window.setTimeout(() => {
    settled = true;
    run().then(
      () => resolve('sent'),
      () => resolve('failed'),
    );
  }, ms);
  return {
    undo: () => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(timer);
      resolve('undone');
      return true;
    },
    done,
  };
}
