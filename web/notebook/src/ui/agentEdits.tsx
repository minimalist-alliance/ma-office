// "Edited by {agent}" (draft ADR "the Agent's tools and approvals" §2 and §15): a page's last agent edit in its foot, with
// Undo, and the agent's name on the version before it in History. The desk keeps the edits (`notebook.page.agentEdits`)
// and undoes one exactly while it's as the agent left it (`notebook.page.agentUndo`); a backend without agents (the
// local demo) has none, and nothing here shows. Names come from the host, by the agent's id: an agent that's gone, or a
// host that doesn't say, reads "an agent".
import { useCallback, useEffect, useState } from 'react';
import type { NotebookBackend } from '../model/backend.ts';
import { formatWhen } from '../model/days.ts';
import type { AgentEdit, PageRec } from '../model/types.ts';

/** The host's names for agents, by id; null for one it doesn't know. */
export type AgentNames = (agentId: string) => string | null;

/** An agent's name as a member reads it, plain text on one line, or null for one the host doesn't name. */
export function agentName(agentId: string | undefined, names?: AgentNames): string | null {
  if (!agentId) return null;
  const name = names?.(agentId)?.replace(/\s+/g, ' ').trim();
  return name || null;
}

/** The foot's line: "Edited by Inbox, Today 2:14 PM". */
export function editedByLine(edit: Pick<AgentEdit, 'agent' | 'at'>, names?: AgentNames, now = Date.now()): string {
  return `Edited by ${agentName(edit.agent, names) ?? 'an agent'}, ${formatWhen(edit.at, now)}`;
}

/** History's label for the version before an agent's edit. */
export function beforeEditLabel(agentId: string | undefined, names?: AgentNames): string {
  const name = agentName(agentId, names);
  return name ? `Before ${name}'s edit` : 'Before an agent edit';
}

/** The undo button's words: "Undo Inbox's edit". */
export function undoLabel(agentId: string | undefined, names?: AgentNames): string {
  const name = agentName(agentId, names);
  return name ? `Undo ${name}'s edit` : "Undo the agent's edit";
}

/** What an undo that was refused says. Fixed words: the desk's reason, never its text. */
export function undoRefusal(err: unknown): string {
  const reason = (err as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (reason === 'changed') return "It's been changed since. History has the page from before.";
  if (reason === 'undone') return 'That was undone already.';
  if (reason === 'trashed') return 'The page is in the Trash.';
  if (reason === 'newer') return 'An agent edited it again since. Undo that edit first.';
  return "That didn't undo. Try again in a moment.";
}

/** Whether an undo was refused for a newer agent edit on the page, which goes first. */
export function newerFirst(err: unknown): boolean {
  return (err as { details?: { reason?: unknown } } | null)?.details?.reason === 'newer';
}

/** The page's newest agent edit not undone, read again when the page changes. Null when there's none, or no agents. */
export function useLastAgentEdit(backend: NotebookBackend, page: PageRec | null): { edit: AgentEdit | null; refresh: () => void } {
  const [edit, setEdit] = useState<AgentEdit | null>(null);
  const [asked, setAsked] = useState(0);
  const pageId = page?.id ?? null;
  const updatedAt = page?.updatedAt ?? 0;
  useEffect(() => {
    let live = true;
    if (!pageId || !backend.agentEdits) {
      setEdit(null);
      return undefined;
    }
    backend.agentEdits(pageId).then(
      (edits) => {
        if (live) setEdit(edits.find((e) => !e.undone) ?? null);
      },
      () => {
        if (live) setEdit(null); // the host says why
      },
    );
    return () => {
      live = false;
    };
  }, [backend, pageId, updatedAt, asked]);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);
  return { edit, refresh };
}

/** In the page's foot: who edited it last of the agents, and Undo. */
export function AgentEditLine({ backend, edit, names, onDone }: { backend: NotebookBackend; edit: AgentEdit; names?: AgentNames; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ editId: string; text: string } | null>(null);
  const undo = async () => {
    if (!backend.undoAgentEdit) return;
    setBusy(true);
    try {
      await backend.undoAgentEdit(edit.editId);
      setSaid(null);
      onDone();
    } catch (err) {
      // A newer edit than the one on show (the foot read before it): the foot reads again and shows that one, whose
      // Undo goes first. The words stay with it.
      if (newerFirst(err)) {
        const editId = (err as { details?: { editId?: unknown } }).details?.editId;
        setSaid(typeof editId === 'string' ? { editId, text: undoRefusal(err) } : null);
        onDone();
      } else setSaid({ editId: edit.editId, text: undoRefusal(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="nb-foot-agent" data-testid="agent-edit">
      <span>{editedByLine(edit, names)}</span>
      {backend.undoAgentEdit && (
        <button type="button" className="nb-text-btn" disabled={busy} onClick={() => void undo()} aria-label={undoLabel(edit.agent, names)}>
          Undo
        </button>
      )}
      {said?.editId === edit.editId && (
        <span className="nb-foot-said" role="status">
          {said.text}
        </span>
      )}
    </span>
  );
}
