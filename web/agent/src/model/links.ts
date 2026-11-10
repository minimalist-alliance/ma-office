// Messages between agents (multi-agent.md section 4): the member's links as a form checks them, and the log's states in
// words. Pure, and tested in multiAgent.test.ts.
import type { A2aMessage, Agent, AgentLink } from '../client/types';

export type LinkProblem = 'self' | 'unknown' | 'duplicate' | 'empty' | 'long';

/** Every link the desk would refuse (`bad_request`, `detail: links`), with why. Empty: all of them would go. */
export function linkProblems(agentId: string, links: readonly AgentLink[], agents: readonly Pick<Agent, 'id'>[], rulesMax: number): { to: string; problem: LinkProblem }[] {
  const out: { to: string; problem: LinkProblem }[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const rules = (l.rules ?? '').trim();
    if (l.to === agentId) out.push({ to: l.to, problem: 'self' });
    else if (!agents.some((a) => a.id === l.to)) out.push({ to: l.to, problem: 'unknown' });
    else if (seen.has(l.to)) out.push({ to: l.to, problem: 'duplicate' });
    else if (!rules) out.push({ to: l.to, problem: 'empty' });
    else if (rules.length > rulesMax) out.push({ to: l.to, problem: 'long' });
    seen.add(l.to);
  }
  return out;
}

const REASON: Record<string, string> = {
  rate: 'the most messages an hour between these two',
  desk_rate: 'the most messages an hour on this desk',
  depth: 'agents passed it on as many times as allowed',
  loop: 'it would go back to an agent already in this exchange',
  spend: 'it has used its share of today’s limit for messages',
  desk_spend: 'agents have used this desk’s share of today’s limit for messages',
  busy: 'it was busy',
  no_key: 'it has no key',
  limit_reached: 'a limit was reached',
  solo: 'the sender is solo',
  no_link: 'no link allows it',
};

/** A logged message's outcome in words: "Replied", "Delivered", "Stopped: the most messages an hour between these two". */
export function a2aStateText(m: Pick<A2aMessage, 'state' | 'reason'>): string {
  const why = m.reason ? (REASON[m.reason] ?? m.reason.replace(/_/g, ' ')) : null;
  switch (m.state) {
    case 'replied':
      return 'Replied';
    case 'delivered':
      return 'Delivered';
    case 'refused':
      // A limit doing its job isn't an error: "Stopped", not "Refused".
      return why ? `Stopped: ${why}` : 'Stopped';
    case 'failed':
      return why ? `Failed: ${why}` : 'Failed';
    default:
      return String(m.state);
  }
}

/**
 * Characters as the desk counts them, for a counter that agrees with its limit: UTF-16 units, as Java's `String.length()`
 * and a field's `maxLength` count them, so an emoji is two.
 */
export const charCount = (text: string): number => text.length;
