// What a paper's answers do (the decision tray; deskd API.md §23 "The tray"). The member's tap goes to the home desk first
// (`agent.maia.tray.answer`), which records it and keeps the answer until it's gone, so a closed office loses nothing. Then this
// device carries it straight back to whoever asked, on that desk's own channel with the member's own token, through methods that
// exist today: an approval's decision (with the hash of the payload the paper showed), a document's place, a Courier reply, a
// to-do's Done or new day. A report's answer goes from the home desk itself, as her brief's follow-up. The home desk then hears
// how it went (`delivered`). Nothing here is decided by a model; she has no way to answer for the member.
import { newIdem } from '../../../agent/src/client/agentClient';
import { RpcAgentClient } from '../../../agent/src/client/rpcAgentClient';
import type { Approval } from '../../../agent/src/client/types';
import { linkOf, useLiveStore } from '../../desk/liveStore';
import type { DeskLink } from '../../desk/deskLink';
import { reachCall, useReach } from '../focusSource';
import { readPaper, readTrayGet, type OutAnswer, type Paper, type PaperAnswer } from '../tray';

export type Delivered = 'sent' | 'queued' | 'failed' | 'gone' | 'changed' | 'expired';
export interface Answered {
  delivered: Delivered | 'none';
  /** "Remind me": when it comes back. */
  until?: number | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const codeOf = (e: unknown): string => String(obj(e)['code'] ?? '');

/** This browser's device id (the focus block's), for the home desk's record of where an answer came from. */
const device = (): string | null => useReach.getState().device;

/** The asking desk's channel, when it's open; null when it's asleep or closed (the answer waits on the home desk). */
function openLink(deskId: string): DeskLink | null {
  return useLiveStore.getState().desks[deskId]?.link === 'open' ? linkOf(deskId) : null;
}

const agentClient = (link: DeskLink): RpcAgentClient =>
  new RpcAgentClient({ call: (m, p, o) => link.call(m as never, p, o), subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r) });

/** An approval as the asking desk has it now, with its whole payload (the paper shows it; the hash is checked on it). */
export async function approvalOf(deskId: string, approvalId: string): Promise<Approval | null> {
  const link = openLink(deskId);
  if (!link) return null;
  try {
    return await agentClient(link).getApproval(approvalId);
  } catch {
    return null;
  }
}

/**
 * Carries one answer to its desk, from the queued answer's own ids (as the paper had them when the member answered), never a
 * paper rebuilt since. The words go only here, from the home desk's queue, and only to that desk.
 */
async function carry(out: OutAnswer): Promise<Delivered> {
  const link = openLink(out.deskId);
  if (!link) return 'queued';
  const text = out.text ?? '';
  const ids = out.reply;
  try {
    switch (out.replyKind) {
      case 'approval': {
        const approvalId = ids.approvalId;
        if (!approvalId) return 'failed';
        const client = agentClient(link);
        const a = await client.getApproval(approvalId);
        if (a.state !== 'pending') return a.state === 'expired' ? 'expired' : 'gone';
        const approve = out.does === 'approve';
        if (approve) {
          const { approvalChecks } = await import('../../../agent/src/model/approvals');
          // Approve is for the payload the member saw: the hash they approved, still what the desk asks about, and still true.
          if (!out.sha256 || a.sha256 !== out.sha256 || !(await approvalChecks(a))) return 'changed';
        }
        const note = out.does === 'not_now' ? 'Not now' : approve ? '' : text.slice(0, 500);
        await client.decideApproval(approvalId, { approve, sha256: a.sha256, ...(note ? { note } : {}) }, { idem: newIdem() });
        return 'sent';
      }
      case 'todo': {
        const todoId = ids.todoId;
        if (!todoId) return 'failed';
        const { rpcTodoClient } = await import('../../apps/todo/client');
        const todo = rpcTodoClient(link, newIdem);
        if (out.does === 'done') {
          await todo.close(todoId, 'done');
          return 'sent';
        }
        if (out.does === 'move' && out.value) {
          const got = await todo.get(todoId);
          if (!got.item) return 'gone';
          const day = new Date(Number(out.value));
          const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
          await todo.update(got.item, { due: { date, time: got.item.due?.time ?? null } } as never);
          return 'sent';
        }
        return 'failed';
      }
      case 'doc': {
        const docId = ids.docId;
        if (out.does === 'done' && docId) {
          await link.call('docs.tap' as never, { id: docId, chip: 'done' }, { idem: newIdem(), deadlineMs: 15_000 });
          return 'sent';
        }
        if (text && ids.channelId) return courierReply(link, ids.channelId, text);
        if (text && ids.agentId) {
          await link.call('agent.message.send' as never, { agentId: ids.agentId, text, origin: 'tray' }, { idem: newIdem(), deadlineMs: 15_000 });
          return 'sent';
        }
        return 'failed';
      }
      case 'courier': {
        const channelId = ids.channelId;
        if (!channelId || !text) return 'failed';
        return courierReply(link, channelId, text);
      }
      default:
        return 'failed';
    }
  } catch (e) {
    const code = codeOf(e);
    if (code === 'conflict') return 'gone';
    if (code === 'bad_request' && String(obj(e)['detail'] ?? '') === 'sha256') return 'changed';
    if (code === 'not_found') return 'gone';
    if (code === 'unavailable' || code === 'timeout' || code === 'closed') return 'queued';
    return 'failed';
  }
}

/** A reply to a person, through that desk's Courier: a draft in their thread, then Courier's own send. */
async function courierReply(link: DeskLink, channelId: string, text: string): Promise<Delivered> {
  // The way it came: the thread's last received message's medium and account (Courier's own rule), as quick reply sends.
  const { replyContext, sendReply } = await import('./quickReply');
  const ctx = await replyContext({ deskId: deskOf(link), channelId, who: null }).catch(() => null);
  await sendReply(link, channelId, text, ctx);
  return 'sent';
}

/** The desk a link is for (the live store's own map). */
function deskOf(link: DeskLink): string {
  for (const [id, d] of Object.entries(useLiveStore.getState().desks)) if (d.link === 'open' && linkOf(id) === link) return id;
  return '';
}

/** The home desk hears how carrying went: sent wipes the words; queued keeps them for when the desk wakes. */
function report(paperId: string, outId: string, delivered: Delivered): Promise<unknown> {
  return reachCall('agent.maia.tray.answer', { paperId, outId, delivered }).catch(() => undefined);
}

/**
 * The member's answer to a paper: recorded on the home desk, then carried. `answer` is one the paper offers, or `custom` with the
 * member's words (an approval's note, a reply). Approve carries `sha256`, the hash of the payload the paper showed. Throws the home
 * desk's refusal (an answer already given elsewhere is `conflict`).
 */
export async function answerPaper(paper: Paper, answer: PaperAnswer | 'custom', text?: string, sha256?: string | null): Promise<Answered> {
  const answerId = answer === 'custom' ? 'custom' : answer.id;
  const words = text?.trim() ? text.trim() : undefined;
  const hash = answer !== 'custom' && answer.does === 'approve' ? (sha256 ?? null) : null;
  const r = obj(await reachCall('agent.maia.tray.answer', { paperId: paper.paperId, answerId, ...(words ? { text: words } : {}), ...(hash ? { sha256: hash } : {}), ...(device() ? { device: device() } : {}) }));
  const deliver = r['deliver'];
  const outId = typeof r['outId'] === 'string' ? r['outId'] : null;
  if (deliver !== 'office' || !outId) return { delivered: 'none', until: typeof r['until'] === 'number' ? r['until'] : null };
  const a = answer === 'custom' ? null : answer;
  const out: OutAnswer = {
    outId,
    paperId: paper.paperId,
    deskId: paper.reply.deskId,
    replyKind: paper.reply.kind,
    answerId,
    does: a ? a.does : paper.kind === 'approval' ? 'decline' : 'reply',
    value: a?.value ?? null,
    text: words ?? null,
    at: Date.now(),
    expiresAt: paper.expiresAt,
    reply: paper.reply,
    sha256: hash,
  };
  const delivered = await carry(out);
  void report(paper.paperId, outId, delivered);
  return { delivered };
}

/** Later: to the next catch-up (or in 20 minutes), only while the deadline allows it. */
export function laterPaper(paper: Paper): Promise<unknown> {
  return reachCall('agent.maia.tray.later', { paperId: paper.paperId });
}

/** One paper again from the home desk (after "This changed", or a paper named in her chat). */
export async function paperAgain(paperId: string): Promise<Paper | null> {
  try {
    return readPaper(obj(await reachCall('agent.maia.tray.get', { paperId }, true))['paper']);
  } catch {
    return null;
  }
}

let carrying = false;
/**
 * Answers waiting for a desk that was asleep: when a desk's channel opens, this device carries what waits for it. Each goes once;
 * a desk still closed keeps them on the home desk.
 */
export async function carryWaiting(deskId?: string): Promise<void> {
  if (carrying) return;
  carrying = true;
  try {
    const got = readTrayGet(await reachCall('agent.maia.tray.get', {}, true));
    for (const out of got.out) {
      if (out.replyKind === 'maia_brief' || (deskId && out.deskId !== deskId) || !openLink(out.deskId)) continue;
      const delivered = await carry(out);
      if (delivered !== 'queued') await report(out.paperId, out.outId, delivered);
    }
  } catch {
    // The home desk didn't answer: the next channel that opens asks again.
  } finally {
    carrying = false;
  }
}

/** Watches the member's desks' channels: one that opens has its waiting answers carried. @return the stop */
export function watchWaiting(): () => void {
  let before: Record<string, string> = {};
  return useLiveStore.subscribe((s) => {
    const now: Record<string, string> = {};
    for (const [id, d] of Object.entries(s.desks)) now[id] = d.link;
    for (const [id, link] of Object.entries(now)) {
      // Only once the room's state has a tray (the desk sends one): a desk that comes back carries what waited for it.
      if (link === 'open' && before[id] !== 'open' && before[id] !== undefined && useReach.getState().reach?.tray) void carryWaiting(id);
    }
    before = now;
  });
}
