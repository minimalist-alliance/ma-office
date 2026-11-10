// The composer's staged files (ADR 0049). A file goes up as it is added, a chunk at a time, and waits on the desk, in its memory
// only, for 10 minutes. This hook keeps a name, a size and an upload id for each: never the bytes, and nothing in any storage.
// Leaving the thread removes what's staged.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import { newUploadId } from '../client/attachUpload';
import type { AttachCapsView } from '../client/types';
import { attachErrorText, FILES_CLEARED, planAdd, stagedReducer, type Staged } from '../model/attachments';

export interface StagedFiles {
  /** Null: the desk offers no files (an older desk, or the call failed), so the composer shows nothing for them. */
  view: AttachCapsView | null;
  files: readonly Staged[];
  /** One line for a status region: what was left out and why, or what went wrong. */
  line: string | null;
  add(incoming: readonly File[]): void;
  remove(id: number): void;
  /** The send took them: forget them without telling the desk to remove them. */
  taken(): void;
  /** The desk no longer has the staged files (a refusal after it read them, or `missing`): forget them and say so. */
  lost(): void;
  say(line: string | null): void;
}

export function useStagedFiles(client: AgentClient, agentId: string, model: string | undefined): StagedFiles {
  const [view, setView] = useState<AttachCapsView | null>(null);
  const [files, dispatch] = useReducer(stagedReducer, [] as Staged[]);
  const [line, say] = useState<string | null>(null);
  const live = useRef<Staged[]>([]);
  live.current = files as Staged[];
  const controllers = useRef(new Map<number, AbortController>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const next = useRef(1);

  useEffect(() => {
    let on = true;
    client.attachCaps(agentId).then(
      (v) => on && setView(v),
      () => on && setView(null),
    );
    return () => {
      on = false;
    };
  }, [client, agentId, model]);

  const drop = useCallback(
    (uploadId: string): void => {
      client.removeAttachment(agentId, uploadId, { idem: newIdem() }).catch(() => undefined);
    },
    [client, agentId],
  );

  useEffect(() => {
    const held = controllers.current;
    return () => {
      // Leaving the thread: stop what's going up and tell the desk to zero what's there.
      for (const c of held.values()) c.abort();
      held.clear();
      for (const f of live.current) drop(f.uploadId);
    };
  }, [drop]);

  const add = useCallback(
    (incoming: readonly File[]): void => {
      if (!view || !incoming.length) return;
      const plan = planAdd(live.current, incoming.map((f) => ({ name: f.name, size: f.size, type: f.type })), view);
      say(plan.messages.length ? plan.messages.join(' ') : null);
      for (const i of plan.accepted) {
        const file = incoming[i]!;
        const id = next.current;
        next.current += 1;
        const staged: Staged = { id, uploadId: newUploadId(), name: file.name.slice(0, 255), size: file.size, state: 'uploading', progress: 0 };
        live.current = [...live.current, staged];
        dispatch({ type: 'add', file: staged });
        const ctl = new AbortController();
        controllers.current.set(id, ctl);
        // One at a time: the desk holds only so much at once, and the browser reads one file at a time.
        queue.current = queue.current.then(async () => {
          if (ctl.signal.aborted) return;
          try {
            await client.attachFile(agentId, staged.uploadId, file, { signal: ctl.signal, onProgress: (p) => dispatch({ type: 'progress', id, progress: p }) });
            if (ctl.signal.aborted) return;
            dispatch({ type: 'ready', id });
          } catch (err) {
            if (!ctl.signal.aborted) {
              live.current = live.current.filter((f) => f.id !== id);
              dispatch({ type: 'remove', id });
              drop(staged.uploadId);
              say(`${staged.name} couldn’t be attached. ${(err instanceof AgentError ? attachErrorText(err) : null) ?? 'Try again.'}`);
            }
          } finally {
            controllers.current.delete(id);
          }
        });
      }
    },
    [client, agentId, view, drop],
  );

  const remove = useCallback(
    (id: number): void => {
      const f = live.current.find((x) => x.id === id);
      if (!f) return;
      controllers.current.get(id)?.abort();
      live.current = live.current.filter((x) => x.id !== id);
      dispatch({ type: 'remove', id });
      drop(f.uploadId);
      say(`Removed ${f.name}.`);
    },
    [drop],
  );

  const taken = useCallback((): void => {
    live.current = [];
    dispatch({ type: 'clear' });
    say(null);
  }, []);

  const lost = useCallback((): void => {
    live.current = [];
    dispatch({ type: 'clear' });
    say(FILES_CLEARED);
  }, []);

  return { view, files, line, add, remove, taken, lost, say };
}
