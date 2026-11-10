// A page's versions (design 5.3): a list by day, a read-only preview, and a restore that never loses
// text (the backend versions what's on the page first, then writes the restore as a new edit).
import { useEffect, useState } from 'react';
import type { NotebookBackend } from '../model/backend.ts';
import { dayKey, formatDayShort, formatTime, formatWhen } from '../model/days.ts';
import { REASON_LABELS } from '../model/history.ts';
import type { PageRec, Version, VersionMeta } from '../model/types.ts';
import { ReadOnlyDoc } from './Editor.tsx';
import { Icon } from './icons.tsx';

export function HistoryPane({ backend, page, onClose }: { backend: NotebookBackend; page: PageRec; onClose: () => void }) {
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    backend.versions(page.id).then(
      (vs) => {
        if (!live) return;
        setList(vs);
        setPicked((p) => p ?? vs[0]?.id ?? null);
      },
      () => {}, // the host says why
    );
    return () => {
      live = false;
    };
  }, [backend, page.id]);

  useEffect(() => {
    let live = true;
    if (!picked) {
      setShown(null);
      return undefined;
    }
    backend.version(picked).then(
      (v) => {
        if (live) setShown(v);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [backend, picked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const restore = async () => {
    if (!shown) return;
    setBusy(true);
    try {
      await backend.restoreVersion(page.id, shown.id);
      onClose();
    } catch {
      // Still here, with the version on show. The host says why.
    } finally {
      setBusy(false);
    }
  };

  let lastDay = '';
  return (
    <div className="nb-history" data-testid="history">
      <div className="nb-history-bar">
        <span className="nb-history-title">
          {shown ? (
            <>
              <strong>{formatWhen(shown.createdAt)}</strong> · {REASON_LABELS[shown.reason]} · {shown.wordCount} words
            </>
          ) : (
            <strong>History</strong>
          )}
        </span>
        <span className="nb-history-actions">
          {shown && (
            <button type="button" className="nb-btn primary" disabled={busy} onClick={() => void restore()}>
              <Icon name="restore" size={16} /> Restore this version
            </button>
          )}
          <button type="button" className="nb-btn" onClick={onClose}>
            Back to the page
          </button>
        </span>
      </div>
      <div className="nb-history-body">
        <div className="nb-history-preview">
          {shown ? (
            <ReadOnlyDoc doc={shown.doc} />
          ) : (
            <div className="nb-paper-empty">
              <p>{list && !list.length ? 'No versions yet.' : ''}</p>
              {list && !list.length && <p className="nb-muted">A version is kept when you leave a page, every 30 minutes while you write, at midnight, and when you save one.</p>}
            </div>
          )}
        </div>
        <ol className="nb-history-list" aria-label="Versions">
          {(list ?? []).map((v) => {
            const day = dayKey(v.createdAt);
            const head = day !== lastDay ? formatDayShort(day) : null;
            lastDay = day;
            return (
              <li key={v.id}>
                {head && <div className="nb-history-day">{head}</div>}
                <button type="button" className={`nb-history-item${v.id === picked ? ' on' : ''}`} aria-current={v.id === picked || undefined} onClick={() => setPicked(v.id)}>
                  <span className="nb-history-time">{formatTime(v.createdAt)}</span>
                  <span className="nb-history-why">{REASON_LABELS[v.reason]}</span>
                  <span className="nb-history-words">{v.title || 'New note'} · {v.wordCount} words</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
