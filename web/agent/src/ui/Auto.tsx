// What an agent did without asking, under the member's setting for it (draft ADR "the Agent's tools and approvals", section 15;
// deskd API.md section 18, "Done without asking"): the chip's "Done without asking · Undo", and the line under a finished reply,
// "Did 3 things without asking: 2 notes and a file in Research · Undo all · See them". Undo is `agent.approval.undo`, one call
// per row; what it answered is said in plain words, by the reply. Rows done without asking are never cards.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Approval, AutoDone, Message, ToolChip } from '../client/types';
import {
  AUTO_CHIP,
  MAYBE_CHIP,
  MAYBE_ROW,
  autoLineOf,
  autoRowsOf,
  autoWord,
  chipStateWord,
  HIDE_THEM,
  mayUndo,
  retryName,
  rowSaid,
  rowStateOf,
  rowTarget,
  SEE_THEM,
  SEE_THEM_LABEL,
  tabLabel,
  TRIED_CHIP,
  TRY_AGAIN,
  UNDO,
  UNDO_ALL,
  undoAllText,
  undoName,
  undoOrder,
  undoOutcomeOf,
  undoSentence,
  type AutoRowView,
  type LocalUndo,
  type NotebookTab,
  type UndoResult,
} from '../model/auto';
import { Icon } from './icons';

/** What a thread's chips and lines share: the rows' approvals, each undo's state here, and what was said under each reply. */
export interface AutoUndo {
  approvals: ReadonlyMap<string, Approval>;
  local: Readonly<Record<string, LocalUndo>>;
  /** By reply id: the last thing an undo there answered, in words. */
  said: Readonly<Record<string, string>>;
  tabName: (tabId: string) => string | null;
  /** One row's Undo: answers whether it's undone. */
  undo: (row: AutoDone, messageId: string) => Promise<boolean>;
  /** Undo all: one call per row, in order. Answers whether any couldn't be undone. */
  undoAll: (rows: readonly AutoDone[], messageId: string) => Promise<boolean>;
}

export const AutoUndoContext = createContext<AutoUndo | null>(null);

/** The thread's undo state. Null without a client (the agents aren't read yet): chips then show no Undo. */
export function useAutoUndo(ctx: { client: AgentClient; announce: (text: string) => void } | null, approvals: readonly Approval[], tabs: readonly NotebookTab[] | null | undefined): AutoUndo | null {
  const [local, setLocal] = useState<Record<string, LocalUndo>>({});
  const [said, setSaid] = useState<Record<string, string>>({});
  // One member action keeps one key across a retry after a lost answer, so the desk gives the first answer back.
  const keys = useRef(new Map<string, string>());
  const byId = useMemo(() => new Map(approvals.filter((a) => a.decidedBy === 'auto').map((a) => [a.id, a])), [approvals]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const tabName = useCallback((id: string): string | null => tabLabel(tabs ?? [], id), [tabs]);
  const client = ctx?.client ?? null;
  const announce = ctx?.announce;

  const run = useCallback(
    async (row: AutoDone): Promise<UndoResult> => {
      if (!client) return { outcome: 'failed' };
      const id = row.approvalId;
      const idem = keys.current.get(id) ?? newIdem();
      keys.current.set(id, idem);
      setLocal((l) => ({ ...l, [id]: { kind: 'working' } }));
      let result: UndoResult;
      try {
        await client.undoApproval(id, { idem });
        keys.current.delete(id);
        result = { outcome: 'undone' };
      } catch (err) {
        result = undoOutcomeOf(err);
        const e = err instanceof AgentError ? err : null;
        if (e && !e.mayHaveApplied && e.code !== 'unavailable' && e.code !== 'deadline_exceeded') keys.current.delete(id);
      }
      setLocal((l) => ({ ...l, [id]: { kind: 'answered', result } }));
      return result;
    },
    [client],
  );

  const viewOf = useCallback((row: AutoDone): Pick<AutoRowView, 'word' | 'target'> => ({ word: autoWord(row, byIdRef.current.get(row.approvalId)), target: rowTarget(row.target) }), []);

  const undo = useCallback(
    async (row: AutoDone, messageId: string): Promise<boolean> => {
      const r = await run(row);
      const text = rowSaid(viewOf(row), undoSentence(row, r, byIdRef.current.get(row.approvalId)));
      setSaid((s) => ({ ...s, [messageId]: text }));
      announce?.(text);
      return r.outcome === 'undone' || r.outcome === 'already';
    },
    [run, viewOf, announce],
  );

  const undoAll = useCallback(
    async (rows: readonly AutoDone[], messageId: string): Promise<boolean> => {
      const results: { view: Pick<AutoRowView, 'word' | 'target'>; ok: boolean; sentence: string }[] = [];
      // One at a time, the newest first: Undo all is one call per row (API.md section 18), and a page's later agent edit
      // is undone before its earlier one.
      for (const row of undoOrder(rows)) {
        const r = await run(row);
        results.push({ view: viewOf(row), ok: r.outcome === 'undone' || r.outcome === 'already', sentence: undoSentence(row, r, byIdRef.current.get(row.approvalId)) });
      }
      const text = undoAllText(results);
      setSaid((s) => ({ ...s, [messageId]: text }));
      announce?.(text);
      return results.some((r) => !r.ok);
    },
    [run, viewOf, announce],
  );

  return useMemo(() => (client ? { approvals: byId, local, said, tabName, undo, undoAll } : null), [client, byId, local, said, tabName, undo, undoAll]);
}

/** The keyboard was on a control that's gone: it goes to what took its place, never left on the page. */
const focusLost = (): boolean => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
};

/**
 * After a press of Undo, whose button gives way to the row's state ("Undoing…", "Undone", "Kept"), or comes back as "Try again":
 * the keyboard follows to whichever is there, once each time the state changes, until the undo has answered.
 */
function useFollowFocus(state: string): { pressed: () => void; stateRef: RefObject<HTMLSpanElement | null>; buttonRef: RefObject<HTMLButtonElement | null> } {
  const stateRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const armed = useRef(false);
  useEffect(() => {
    if (!armed.current) return;
    if (focusLost()) (buttonRef.current ?? stateRef.current)?.focus({ preventScroll: true });
    if (state !== 'working') armed.current = false;
  }, [state]);
  const pressed = useCallback(() => {
    armed.current = true;
  }, []);
  return { pressed, stateRef, buttonRef };
}

/**
 * A chip for a call done without asking, in two lines so its target has room at any width: what it did and on what, then "Done
 * without asking · Undo", and once undone, how that went.
 */
export function AutoChip({ chip, row, messageId, time }: { chip: ToolChip; row: AutoDone; messageId: string; time: string | null }) {
  const auto = useContext(AutoUndoContext);
  const approval = auto?.approvals.get(row.approvalId);
  const state = rowStateOf(row, approval, auto?.local[row.approvalId]);
  const { pressed, stateRef, buttonRef } = useFollowFocus(state);
  const word = autoWord(row, approval);
  const target = rowTarget(row.target ?? chip.target);
  const stateWord = chipStateWord(state);
  const failed = state === 'not_done';
  return (
    <li className="ag-tool-chip" data-auto="" data-result={failed ? 'failed' : 'done'} data-level="change" data-state={state} data-testid="tool-chip">
      <Icon name="pencil" size={14} />
      <span className="ag-tool-word">{failed ? 'Didn’t finish' : word}</span>
      {target && <span className="ag-tool-target">{target}</span>}
      {time && <span className="ag-tool-time">{time}</span>}
      <span className="ag-tool-auto" data-testid="auto-chip">
        {state === 'maybe' ? MAYBE_CHIP : failed ? TRIED_CHIP : AUTO_CHIP}
        {auto && mayUndo(state) ? (
          <>
            {' '}
            <span aria-hidden="true">·</span>{' '}
            <button
              type="button"
              ref={buttonRef}
              className="ag-chip-btn"
              aria-label={state === 'retry' ? retryName({ word, target }) : undoName({ word, target })}
              onClick={() => {
                pressed();
                void auto.undo(row, messageId);
              }}
              data-testid="auto-chip-undo"
            >
              {state === 'retry' ? TRY_AGAIN : UNDO}
            </button>
          </>
        ) : (
          stateWord &&
          !failed && (
            <>
              {' '}
              <span aria-hidden="true">·</span>{' '}
              <span className="ag-tool-auto-state" ref={stateRef} tabIndex={-1} data-testid="auto-chip-state">
                {stateWord}
              </span>
            </>
          )
        )}
      </span>
    </li>
  );
}

/** A reply's chips that were done without asking, as rows for `AutoChip`, by their approval id. */
export function autoRowFor(m: Pick<Message, 'auto' | 'tools'>, chip: ToolChip): AutoDone | null {
  if (!chip.auto || chip.approval?.decision !== 'auto' || !chip.approval.id) return null;
  const id = chip.approval.id;
  return autoRowsOf(m).find((r) => r.approvalId === id) ?? { approvalId: id, tool: chip.name, target: chip.target ?? null, group: chip.auto, state: chip.ok ? 'done' : 'failed', undoneAt: null };
}

const ENDED = (m: Message): boolean => m.state === 'done' || m.state === 'stopped' || m.state === 'failed' || m.state === undefined;

/**
 * Under a finished reply whose run did anything without asking: the line, Undo all for what's still there, and See them, which
 * lists each row with its own Undo. What an undo answered is said under it.
 */
export function AutoLine({ m }: { m: Message }) {
  const auto = useContext(AutoUndoContext);
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const saidRef = useRef<HTMLParagraphElement>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  const pressedAll = useRef(false);
  const rows = useMemo(() => autoRowsOf(m), [m]);
  const view = useMemo(() => (auto && rows.length ? autoLineOf(rows, auto.approvals, auto.local, auto.tabName) : null), [auto, rows]);
  const said = auto?.said[m.id] ?? null;
  // Undo all is gone once nothing is left to undo: the keyboard goes to what it said.
  useEffect(() => {
    if (!pressedAll.current || busy) return;
    pressedAll.current = false;
    if (focusLost()) (allRef.current ?? saidRef.current)?.focus({ preventScroll: true });
  }, [busy, said]);
  if (!auto || !view?.text || !ENDED(m)) return null;
  const toUndo = view.rows.filter((v) => view.undoable.includes(v.row.approvalId)).map((v) => v.row);
  const undoAll = async (): Promise<void> => {
    if (busy) return;
    pressedAll.current = true;
    setBusy(true);
    const kept = await auto.undoAll(toUndo, m.id);
    // What couldn't be undone says why in the list.
    if (kept) setOpen(true);
    setBusy(false);
  };
  return (
    <div className="ag-auto" data-testid="auto-line">
      <p className="ag-auto-line">
        <span id={`${ids}-text`} data-testid="auto-line-text">
          {view.text}
        </span>
        {toUndo.length > 0 && (
          <>
            {' '}
            <span className="ag-run-part">
              <span aria-hidden="true">· </span>
              <button type="button" ref={allRef} className="ag-line-btn" onClick={() => void undoAll()} aria-disabled={busy || undefined} aria-describedby={`${ids}-text`} data-testid="auto-undo-all">
                {toUndo.length === 1 ? UNDO : UNDO_ALL}
              </button>
            </span>
          </>
        )}{' '}
        <span className="ag-run-part">
          <span aria-hidden="true">· </span>
          <button type="button" className="ag-line-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${ids}-rows`} data-testid="auto-see">
            {open ? HIDE_THEM : SEE_THEM}
          </button>
        </span>
      </p>
      {said && (
        <p className="ag-auto-said" ref={saidRef} tabIndex={-1} data-testid="auto-said">
          {said}
        </p>
      )}
      <ul id={`${ids}-rows`} className="ag-auto-rows" aria-label={SEE_THEM_LABEL} hidden={!open} data-testid="auto-rows">
        {view.rows.map((v) => (
          <AutoRow key={v.row.approvalId} v={v} messageId={m.id} />
        ))}
      </ul>
    </div>
  );
}

function AutoRow({ v, messageId }: { v: AutoRowView; messageId: string }) {
  const auto = useContext(AutoUndoContext);
  const { pressed, stateRef, buttonRef } = useFollowFocus(v.state);
  const stateWord = chipStateWord(v.state);
  return (
    <li className="ag-auto-row" data-state={v.state} data-testid="auto-row">
      <span className="ag-auto-what">
        <span className="ag-tool-word">{v.word}</span>
        {v.target && <span className="ag-auto-target">{v.target}</span>}
      </span>
      {auto && mayUndo(v.state) ? (
        <button
          type="button"
          ref={buttonRef}
          className="ag-line-btn"
          aria-label={v.state === 'retry' ? retryName(v) : undoName(v)}
          onClick={() => {
            pressed();
            void auto.undo(v.row, messageId);
          }}
          data-testid="auto-row-undo"
        >
          {v.state === 'retry' ? TRY_AGAIN : UNDO}
        </button>
      ) : (
        stateWord && (
          <span className="ag-auto-state" ref={stateRef} tabIndex={-1} data-testid="auto-row-state">
            {stateWord}
          </span>
        )
      )}
      {(v.said ?? (v.state === 'maybe' ? MAYBE_ROW : null)) && (
        <span className="ag-auto-why" data-testid="auto-row-said">
          {v.said ?? MAYBE_ROW}
        </span>
      )}
    </li>
  );
}
