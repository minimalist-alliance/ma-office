// A question handed to one of a desk's agents from elsewhere in the office (Documents' "Ask Lead" and "Ask Lead about this",
// the owner, Nov 15: "it should really be ask desk agent, which should default to the primary agent"). The words, and for a
// document its text as a file, wait in that agent's composer for the member to finish and send: never sent by themselves, as
// Maia's room does with its own (`maiamode/ask.ts`). The agent answers in its own thread, on its own key or the member's
// credits, as any message to it. Tiny and outside the Agent's chunk, so whoever hands a question over needn't load it.
import { create } from 'zustand';
import { agentApp, type AppId } from '../canvas/layout';
import { useLayoutStore } from '../state/layoutStore';
import { openWindow } from '../state/windowStore';
import { useRosterStore, type RosterAgent } from './roster';

export interface AgentAsk {
  deskId: string;
  agentId: string;
  /** The window it was opened in: the agent's own (`agent:<id>`), or the lead's, with the whole team (`agent`). */
  app: AppId;
  text: string;
  /** The document's text, attached in the composer as a file the member sees and can remove. */
  file: File | null;
  seq: number;
}

export const useAgentAsk = create<{ ask: AgentAsk | null }>(() => ({ ask: null }));
let seq = 0;

/**
 * An agent's own window on this desk (task 49): its tile's, or the `agent` tile's for the lead. Null where it has none, as just
 * after it was made.
 */
function windowFor(deskId: string, agentId: string): { app: AppId; id: string } | null {
  const items = useLayoutStore.getState().desks[deskId]?.items ?? [];
  const lead = useRosterStore.getState().desks[deskId]?.find((a) => a.id === agentId)?.lead === true;
  const item = items.find((i) => i.app === (lead ? 'agent' : agentApp(agentId)));
  return item ? { app: item.app, id: item.id } : null;
}

/** Opens an agent's own window on this desk, and says whether it did. */
export function openAgentWindow(deskId: string, agentId: string): boolean {
  const w = windowFor(deskId, agentId);
  if (!w) return false;
  openWindow(deskId, w.app, w.id);
  return true;
}

/**
 * Hands `text` (and `file`) to this agent's composer and opens its window: its own, or the lead's with the whole team when it
 * has no tile of its own yet. False when the desk has neither (its Agent tile was taken off): nothing is handed over.
 */
export function askAgent(deskId: string, agentId: string, text: string, file: File | null = null): boolean {
  const w = windowFor(deskId, agentId) ?? (() => {
    const lead = useLayoutStore.getState().desks[deskId]?.items.find((i) => i.app === 'agent');
    return lead ? { app: lead.app, id: lead.id } : null;
  })();
  if (!w) return false;
  seq += 1;
  useAgentAsk.setState({ ask: { deskId, agentId, app: w.app, text: text.slice(0, 500), file, seq } });
  openWindow(deskId, w.app, w.id);
  return true;
}

/** The window took it. */
export function takeAgentAsk(n: number): void {
  if (useAgentAsk.getState().ask?.seq === n) useAgentAsk.setState({ ask: null });
}

/** This desk's agents a question can go to, the lead first: what its desk last said (`roster.ts`), or none. */
export function askableAgents(deskId: string, state = useRosterStore.getState()): RosterAgent[] {
  const list = state.desks[deskId] ?? [];
  return [...list.filter((a) => a.lead), ...list.filter((a) => !a.lead)];
}

export function useAskableAgents(deskId: string): RosterAgent[] {
  const list = useRosterStore((s) => s.desks[deskId]);
  return list ? askableAgents(deskId) : [];
}

/** A document's text as the file the agent reads: its pages (or sections) as plain text, under its title. */
export function docTextFile(title: string, text: { pages: { n: number; text: string }[]; sections: { text: string }[] }): File | null {
  const body = text.pages.length
    ? text.pages.map((p) => (text.pages.length > 1 ? `Page ${p.n}\n${p.text}` : p.text)).join('\n\n')
    : text.sections.map((s) => s.text).join('\n\n');
  if (!body.trim()) return null;
  // A plain name: the title's letters, digits and a few marks, never a path.
  const name = (title.replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Document') + '.txt';
  return new File([body], name, { type: 'text/plain' });
}
