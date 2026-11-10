// Agent status and provider badges, as rules the UI and the tests share (design 9.1, 9.4).
import type { Agent, AgentErrorReason, AgentStatus, KeyMeta } from '../client/types';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  no_key: 'no key',
  online: 'online',
  working: 'working',
  needs_you: 'needs you',
  limit_reached: 'limit reached',
  error: 'error',
  paused: 'paused',
};

/** The status word, which for an agent whose key went (a restart, a lost file) says so, not that there never was one. */
export function statusWord(agent: Pick<Agent, 'status' | 'binding'>): string {
  return agent.status === 'no_key' && agent.binding ? 'add key again' : STATUS_LABEL[agent.status];
}

/**
 * Says the key's limit, once, before a member types one and in the Keys tab, on a desk whose keys don't last (`keysLast`).
 */
export const KEY_RESTART_LINE = 'For now, your key stays only until this desk restarts. You’d add it again after that.';

/**
 * Whether this desk keeps its keys through a restart (the key store, ADR 0042), for the restart line and Activity. Null: not
 * known yet, so the line waits and Activity hides nothing.
 *
 * A stopgap, until the Desk Engineer offers an explicit field. `desk-agent` 2026.11.07-0e1fb6c brought the store together
 * with `available` on each key and `timeZone` on `agent.limits.get` (ADR 0043), so either one says the store is there: a key
 * carrying `available` either way, or `limits` having a `timeZone` property, even a null one. That's how a desk with no keys
 * yet, which has nothing in `agent.key.list` to say it with, still knows. A desk with neither is an older `desk-agent`,
 * which keeps keys in memory, and gets the line.
 *
 * `limits` is what `agent.limits.get` answered: undefined while it hasn't, null where it failed or there's no agent.
 */
export function keysLast(keys: readonly Pick<KeyMeta, 'available'>[] | null, limits: object | null | undefined): boolean | null {
  if (keys?.some((k) => typeof k.available === 'boolean')) return true;
  if (limits && 'timeZone' in limits) return true;
  if (keys === null || limits === undefined) return null;
  return false;
}

/**
 * The desk can't use this key any more, and the member should add it again. `available: false` says so outright. A desk that
 * doesn't say shows it another way: an agent still bound to the key has gone back to `no_key`.
 */
export function keyLost(key: Pick<KeyMeta, 'keyId' | 'available'>, agents: readonly Pick<Agent, 'status' | 'binding'>[]): boolean {
  if (typeof key.available === 'boolean') return !key.available;
  return agents.some((a) => a.status === 'no_key' && a.binding?.keyId === key.keyId);
}

/** How long a read that failed because desk-agent isn't running waits before it asks again. Never a storm. */
const RETRY_MS = [5_000, 10_000, 20_000, 30_000];
export function retryDelayMs(attempt: number): number {
  return RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] as number;
}

/** The dot beside a status word. The word is always there too, so color is never the only signal. */
export type Dot = 'hollow' | 'online' | 'working' | 'warn' | 'error';

export const STATUS_DOT: Record<AgentStatus, Dot> = {
  no_key: 'hollow',
  online: 'online',
  working: 'working',
  needs_you: 'warn',
  limit_reached: 'warn',
  error: 'error',
  paused: 'warn',
};

/**
 * Whether an agent's provider badge shows: on unless the member hid it, globally (a layout-doc pref) or on this
 * agent (a desk setting). A provider change brings it back until dismissed (design 9.4).
 */
export function badgeShown(agent: Pick<Agent, 'binding' | 'badgeHidden' | 'badgeNotice'>, showBadges: boolean): boolean {
  if (!agent.binding) return false;
  return agent.badgeNotice || (showBadges && !agent.badgeHidden);
}

/** The badge is showing only because the provider changed, so it gets a way to dismiss it. */
export function badgeDismissable(agent: Pick<Agent, 'binding' | 'badgeHidden' | 'badgeNotice'>, showBadges: boolean): boolean {
  return !!agent.binding && agent.badgeNotice && (!showBadges || agent.badgeHidden);
}

/** The neutral text monogram, until each provider's official mark is cleared for use (design 9.4). */
export function monogram(providerName: string): string {
  return (providerName.trim()[0] ?? '?').toUpperCase();
}

/** Why an agent is paused, for its window: the desk has more agents than its plan allows (`agent_cap`), or the account can't run agents now. */
export function pausedText(detail: string | null | undefined): string {
  return detail === 'agent_cap'
    ? 'Paused: this desk has more agents than its plan allows. Remove one to start the rest again.'
    : 'Paused: agents can’t run on this account right now.';
}

/** A failed reply or a refused send, in words. Never the provider's own message, which could quote the prompt. */
export function errorText(reason: AgentErrorReason | null | undefined, detail?: string | null): string {
  switch (reason) {
    case 'no_key':
      return 'This agent’s key needs adding.';
    case 'busy':
      return 'This agent is still answering. Wait for it, or stop it.';
    case 'limit_reached':
      return 'A usage limit is reached.';
    case 'key_refused':
      return 'The provider refused this key. Check it in the provider’s console, then paste it again.';
    case 'key_malformed':
      return 'That doesn’t look like a key from this provider.';
    case 'storage':
      return 'Your desk couldn’t save that. Try again.';
    case 'agent_cap':
      return 'This desk has as many agents as it can hold. Delete one to add another.';
    case 'workspace_full':
      return 'That workspace already holds more than that.';
    case 'timer_cap':
      return 'This agent has as many timers as it can have.';
    case 'name_taken':
      return 'Another agent on this desk has that name.';
    case 'disk_low':
      return 'This desk is low on storage, so workspaces can’t save files right now. Free some space first.';
    case 'disk_budget':
      return 'Workspaces already take their share of this desk’s storage. Make another agent’s workspace smaller or delete files first.';
    case 'too_many_folders':
      return 'This workspace has as many folders as it can hold. Delete some first.';
    case 'hidden_chars':
      return 'That has hidden characters in it. Remove them and try again.';
    case 'cut_off':
      return 'The reply was cut off at its length limit.';
    case 'refused':
      return 'The model declined to answer.';
    case 'provider_error':
      switch (detail) {
        case 'auth':
          return 'The provider refused the key. It may have been revoked.';
        case 'rate_limited':
          return 'The provider’s rate limit or quota stopped this reply. Try again shortly.';
        case 'timeout':
          return 'The provider didn’t answer in time.';
        case 'bad_request':
          return 'The provider refused the request, perhaps the model or the length.';
        case 'cancelled':
          return 'Stopped.';
        default:
          return 'The provider couldn’t answer just now. Try again shortly.';
      }
    case 'unavailable':
    default:
      return 'The desk couldn’t do that just now. Try again shortly.';
  }
}

/** Look-alike letters from Cyrillic and Greek, as the Latin letter they pass for. The desk keeps a longer list; this is the common ones. */
const LOOK_ALIKES: Record<string, string> = Object.fromEntries(
  [...'а=a е=e о=o р=p с=c у=y х=x і=i ј=j ѕ=s ԁ=d ɡ=g һ=h ο=o ν=v ι=i κ=k ρ=p τ=t υ=u χ=x α=a ε=e η=n μ=u'.split(' ')].map((pair) => [pair[0] as string, pair[2] as string]),
);

/**
 * A name as the desk compares it for "already taken": NFKC, case folded, trimmed, format characters removed, and common
 * Cyrillic and Greek look-alikes read as Latin. Two names with the same key are the same name.
 */
export function nameKey(name: string): string {
  const folded = name.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
  return [...folded].map((c) => LOOK_ALIKES[c] ?? c).join('');
}

/** Whether text holds Unicode format or bidi control characters, which the desk refuses (`hidden_chars`). */
export const hasHiddenChars = (text: string): boolean => /\p{Cf}/u.test(text);
