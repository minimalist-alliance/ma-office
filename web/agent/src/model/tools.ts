// Tool calls as the member sees them (the Product Designer's spec, section 2): the strip of what runs now, and the chips a reply
// keeps after. Pure. Running calls come from topic `agent.tools` (the spec's section 2.8, not served by a desk yet); chips from a
// reply's `tools` (deskd API.md section 18). Targets are untrusted text.
import type { Agent, ApprovalTarget, RunningCall, ToolChip } from '../client/types';
import { doingWord, doneWord, elapsed, hostOf, isWarnLevel, levelOf, shortAddress, shown, type Level } from './approvals';

export { elapsed };

/** A target in a few words: a file's path, a page's title, an element's label, a site's host. */
export function wordTarget(t: ApprovalTarget | null | undefined): string | null {
  if (!t) return null;
  switch (t.kind) {
    case 'file':
      return shown(t.to ? `${t.path} → ${t.to}` : t.path);
    case 'page':
      return shown(`“${t.title || 'Untitled'}”`);
    case 'element':
      return shown(`“${t.label}” on ${hostOf(t.origin)}`);
    case 'site':
      return shown(t.site ?? (t.origin ? hostOf(t.origin) : ''));
    case 'memory':
      return null;
    case 'timer':
      return null;
    default:
      return null;
  }
}

export interface StripView {
  /** This agent's calls, oldest first. */
  mine: RunningCall[];
  /** Other agents with calls running, in the order their first call started. */
  others: { agentId: string; name: string; count: number }[];
}

/** What the strip shows for `agentId` (spec 2.4): its own calls first, then the other agents, each on one line. */
export function stripOf(calls: readonly RunningCall[], agentId: string, agents: readonly Pick<Agent, 'id' | 'name'>[]): StripView {
  const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt);
  const mine = sorted.filter((c) => c.agentId === agentId);
  const others: StripView['others'] = [];
  for (const c of sorted) {
    if (c.agentId === agentId) continue;
    const row = others.find((o) => o.agentId === c.agentId);
    if (row) row.count += 1;
    else others.push({ agentId: c.agentId, name: agents.find((a) => a.id === c.agentId)?.name ?? 'Another agent', count: 1 });
  }
  return { mine, others };
}

/** "Also running: Writer, 1 tool". */
export const alsoText = (name: string, count: number): string => `Also running: ${name}, ${count} ${count === 1 ? 'tool' : 'tools'}`;

/** A call's label and target for the strip. The desk's `doing`, else this app's word for the tool. */
export function callWords(c: RunningCall): { label: string; target: string; level: Level } {
  return { label: shown(c.doing || doingWord(c.tool)), target: shown(c.target ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(c.target) ? shortAddress(c.target) : c.target) : ''), level: levelOf(c.risk) };
}

/** How long a call has run, by the desk's clock: `offset` is the desk's time minus this page's (`serverNow`). */
export const runningFor = (c: Pick<RunningCall, 'startedAt'>, now: number, offset: number): number => Math.max(0, now + offset - c.startedAt);

/** The phone's one line: "3 tools running". */
export const toolsRunningText = (n: number): string => `${n} ${n === 1 ? 'tool' : 'tools'} running`;

export interface ChipView {
  level: Level;
  warn: boolean;
  word: string;
  target: string | null;
  time: string | null;
  result: 'done' | 'failed' | 'stopped';
  /** The desk's reason, for a failed one: in its title and accessible name. */
  why: string | null;
}

/**
 * A reply's chip for one call (spec 2.5). A call that asked and was declined or expired has none: its card says so. Null for those.
 */
export function chipOf(chip: ToolChip): ChipView | null {
  const decision = chip.approval?.decision;
  if (decision === 'declined' || decision === 'expired') return null;
  const level = levelOf(chip.risk ?? 'read');
  const result: ChipView['result'] = chip.stopped ? 'stopped' : chip.ok ? 'done' : 'failed';
  const known = doneWord(chip.name);
  const word = result === 'failed' ? 'Didn’t finish' : result === 'stopped' ? 'Stopped' : known === 'Used a tool' ? shown(chip.summary || known) : known;
  const target = wordTarget(chip.target) ?? (chip.path ? shown(chip.path) : null);
  return {
    level,
    warn: isWarnLevel(level),
    word,
    target: target && /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? shortAddress(target) : target,
    // A call under a second still took time: it reads 0:01, never 0:00.
    time: typeof chip.durationMs === 'number' ? elapsed(Math.max(1000, chip.durationMs)) : null,
    result,
    why: result === 'failed' ? shown(chip.reason ?? chip.summary ?? '') || null : null,
  };
}
