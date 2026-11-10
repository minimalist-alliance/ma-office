// "Move a desk to your own computer": a cloud desk and a desk on the member's own computer, a one-time code, and the one
// command that uses it. The cloud desk is never changed by a move (draft ADR "data export and transfer", section 9).
import { useEffect, useState } from 'react';
import { ApiError, type PlatformDesk } from '../platform/api';
import { formatClock, formatCode, formatDay } from './format';
import { cancellable, cancelMove, createMove, isSelfHosted, listMoves, removeMovedDesk, type Move, type MoveCode } from './moves';

const COMMAND = 'sudo ma-move';

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn xp-copy"
      aria-label={label}
      data-testid={testId}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const deskWord = (name: string): string => (/desk$/i.test(name) ? name : `${name} desk`);

function moveLine(m: Move, names: Map<string, string>): string | null {
  const to = m.targetName ?? (m.targetDeskId && names.get(m.targetDeskId)) ?? 'your own computer';
  const target = to === 'your own computer' ? to : deskWord(to);
  const day = formatDay(m.updatedAt ?? m.createdAt);
  switch (m.state) {
    case 'done':
      return day ? `Moved to ${target} on ${day}` : `Moved to ${target}`;
    case 'failed':
      return day ? `A move to ${target} didn't finish on ${day}` : `A move to ${target} didn't finish`;
    case 'cancelled':
      return day ? `A move to ${target} was cancelled on ${day}` : `A move to ${target} was cancelled`;
    case 'claimed':
    case 'copying':
    case 'checking':
      return `Moving to ${target}`;
    case 'created':
      return cancellable(m) ? `A move code for ${target} is waiting` : null;
    default:
      return null; // a code nobody used, or one that ran out
  }
}

export function MovePanel({ desks, guideUrl }: { desks: readonly PlatformDesk[]; guideUrl: string | null }) {
  const cloud = desks.filter((d) => !isSelfHosted(d));
  const targets = desks.filter(isSelfHosted);
  const [source, setSource] = useState(cloud[0]?.deskId ?? '');
  const [target, setTarget] = useState(targets[0]?.deskId ?? '');
  const [code, setCode] = useState<MoveCode | null>(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [stopping, setStopping] = useState(false); // the cloud desk is being stopped first, as it must before it can be removed
  const [removed, setRemoved] = useState<Record<string, string | null>>({}); // move id to when its data goes, once removed
  const [moveError, setMoveError] = useState<string | null>(null);
  const names = new Map(desks.map((d) => [d.deskId, d.name]));

  useEffect(() => {
    listMoves().then(setMoves, () => {}); // the list is a courtesy: nothing waits on it
  }, [code, cancelling, removed]);

  const left = code ? Date.parse(code.expiresAt) - now : 0;
  useEffect(() => {
    if (!code) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [code]);

  const ask = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const c = await createMove(source, target);
      setNow(Date.now());
      setCode(c);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "Moving a desk isn't available right now." : "A move code couldn't be made. Check the two desks and try again.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (moveId: string): Promise<void> => {
    setCancelling(moveId);
    setMoveError(null);
    try {
      await cancelMove(moveId);
      if (code?.moveId === moveId) setCode(null);
    } catch (err) {
      setMoveError(err instanceof ApiError && err.status === 409 ? "That move has already finished, so there's nothing to cancel." : "The move couldn't be cancelled just now. Try again in a moment.");
    } finally {
      setCancelling(null);
    }
  };

  const remove = async (m: Move): Promise<void> => {
    setRemoving(true);
    setMoveError(null);
    try {
      const r = await removeMovedDesk(m.moveId, m.sourceDeskId ?? '', () => setStopping(true));
      setRemoved((x) => ({ ...x, [m.moveId]: r.retainedUntil ?? null }));
      setConfirmRemove(null);
    } catch {
      setMoveError("The cloud desk couldn't be removed just now. It's untouched. Try again in a moment.");
    } finally {
      setRemoving(false);
      setStopping(false);
    }
  };

  const history = moves
    .map((m) => ({ m, line: moveLine(m, names) }))
    .filter((x): x is { m: Move; line: string } => x.line !== null)
    .slice(0, 5);

  return (
    <section className="xp-card" aria-labelledby="xp-move-title" data-testid="move-panel">
      <h2 id="xp-move-title">Move a desk to your own computer</h2>
      <p className="xp-text">
        Copy a cloud desk onto a desk running on your own computer: its files, its apps, and the Browser with its sign-ins. The cloud desk stays exactly as it is until you choose to remove it.
      </p>
      {!cloud.length ? (
        <p className="xp-text" data-testid="move-no-cloud">There's no cloud desk to move.</p>
      ) : !targets.length ? (
        <p className="xp-text" data-testid="move-no-target">
          Set up a desk on your own computer first.
          {guideUrl && (
            <>
              {' '}
              <a className="xp-link" href={guideUrl} target="_blank" rel="noopener" data-testid="move-guide">How to set one up</a>
            </>
          )}
        </p>
      ) : code && left > 0 ? (
        <div className="xp-code-block" data-testid="move-code-screen">
          <p className="xp-label" id="xp-code-label">Your move code</p>
          <div className="xp-code-row">
            <output className="xp-code" aria-labelledby="xp-code-label" data-testid="move-code">{formatCode(code.code)}</output>
            <CopyButton text={formatCode(code.code)} label="Copy the move code" testId="copy-code" />
          </div>
          <p className="xp-fine" data-testid="move-expires">Expires in <span className="xp-num">{formatClock(left)}</span>. It works once.</p>
          <p className="xp-text">On your own computer, run this command, and enter the code when it asks:</p>
          <div className="xp-code-row">
            <code className="xp-command" data-testid="move-command">{COMMAND}</code>
            <CopyButton text={COMMAND} label="Copy the command" testId="copy-command" />
          </div>
          {moveError && <p className="xp-text xp-warn" role="alert">{moveError}</p>}
          <div className="xp-actions">
            <button type="button" className="btn" onClick={() => setCode(null)}>Done</button>
            <button type="button" className="btn" disabled={cancelling !== null} onClick={() => void cancel(code.moveId)} data-testid="move-cancel-code">
              Cancel this move
            </button>
          </div>
        </div>
      ) : (
        <>
          {code && <p className="xp-text" role="status" data-testid="move-expired">That code has expired. Get a new one when you're ready.</p>}
          <div className="xp-pickers">
            <label className="xp-field">
              <span className="xp-label">From</span>
              <select className="xp-select" value={source} onChange={(e) => setSource(e.target.value)} data-testid="move-from">
                {cloud.map((d) => (
                  <option key={d.deskId} value={d.deskId}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="xp-field">
              <span className="xp-label">To</span>
              <select className="xp-select" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="move-to">
                {targets.map((d) => (
                  <option key={d.deskId} value={d.deskId}>{d.name}</option>
                ))}
              </select>
            </label>
          </div>
          {error && <p className="xp-text xp-warn" role="alert">{error}</p>}
          <div className="xp-actions">
            <button type="button" className="btn" disabled={busy || !source || !target} onClick={() => void ask()} data-testid="move-get-code">
              {busy ? 'Getting a code…' : code ? 'Get a new code' : 'Get a move code'}
            </button>
          </div>
        </>
      )}
      {moveError && !(code && left > 0) && <p className="xp-text xp-warn" role="alert" data-testid="move-error">{moveError}</p>}
      {history.length > 0 && (
        <ul className="xp-moves" aria-label="Your moves" data-testid="move-history">
          {history.map(({ m, line }) => {
            const sourceStillThere = m.state === 'done' && !!m.sourceDeskId && desks.some((d) => d.deskId === m.sourceDeskId && !isSelfHosted(d));
            const sourceName = m.sourceName ?? (m.sourceDeskId && names.get(m.sourceDeskId)) ?? 'the cloud desk';
            return (
              <li key={m.moveId} className="xp-move-item">
                <div className="xp-move-row">
                  <span>
                    {cloud.length > 1 && <span className="xp-muted">{m.sourceName ?? (m.sourceDeskId && names.get(m.sourceDeskId)) ?? 'A desk'} · </span>}
                    {line}
                  </span>
                  {cancellable(m) && (
                    <button type="button" className="btn xp-copy" disabled={cancelling !== null} onClick={() => void cancel(m.moveId)} data-testid={`move-cancel-${m.moveId}`}>
                      Cancel
                    </button>
                  )}
                  {sourceStillThere && removed[m.moveId] === undefined && confirmRemove !== m.moveId && (
                    <button type="button" className="btn xp-copy" onClick={() => setConfirmRemove(m.moveId)} data-testid={`move-remove-${m.moveId}`}>
                      Remove the cloud desk
                    </button>
                  )}
                </div>
                {sourceStillThere && removed[m.moveId] === undefined && confirmRemove === m.moveId && (
                  <div className="xp-confirm" role="group" aria-label={`Remove ${sourceName}`} data-testid="move-remove-confirm">
                    <p className="xp-text">
                      Remove {sourceName} from the cloud? Everything on it was copied to your own computer, and the Browser's sign-ins and history came with it. We keep {sourceName}'s data for 30 days in case you change your mind, and then it's gone for good.
                    </p>
                    <div className="xp-actions">
                      <button type="button" className="btn" disabled={removing} onClick={() => void remove(m)} data-testid="move-remove-yes">
                        {removing ? (stopping ? 'Stopping it first…' : 'Removing…') : 'Remove the cloud desk'}
                      </button>
                      <button type="button" className="btn" disabled={removing} onClick={() => setConfirmRemove(null)} data-testid="move-remove-no">
                        Keep it
                      </button>
                    </div>
                  </div>
                )}
                {removed[m.moveId] !== undefined && (
                  <p className="xp-fine" role="status" data-testid="move-removed">
                    {sourceName} is removed. Its data is kept for 30 days{removed[m.moveId] && formatDay(removed[m.moveId] ?? undefined) ? `, until ${formatDay(removed[m.moveId] ?? undefined)}` : ''}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
