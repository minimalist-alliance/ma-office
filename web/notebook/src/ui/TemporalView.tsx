// Temporal view (design 5.3): a month calendar with activity dots, the pages created or edited on
// the chosen day with their time ranges, a day list, search, ←/→ between active days, and each
// page "as of this day", read-only, with Restore.
import { useEffect, useMemo, useState } from 'react';
import type { NotebookBackend } from '../model/backend.ts';
import { dateFromKey, dayKey, formatDayLong, formatDayShort, formatTime, monthCells, stepActiveDay } from '../model/days.ts';
import { locate } from '../model/tree.ts';
import type { ActivityRow, Tree, Version } from '../model/types.ts';
import { ReadOnlyDoc } from './Editor.tsx';
import { Icon } from './icons.tsx';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function useAllActivity(backend: NotebookBackend, tree: Tree): ActivityRow[] {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  useEffect(() => {
    let live = true;
    backend.activity('0000-01-01', '9999-12-31').then(
      (r) => {
        if (live) setRows(r);
      },
      () => {}, // the last rows stand, and the host says why
    );
    return () => {
      live = false;
    };
    // The tree changes whenever the store records an edit, so activity is read again then.
  }, [backend, tree]);
  return rows;
}

function AsOf({ backend, tree, pageId, day, onBack, onOpen }: { backend: NotebookBackend; tree: Tree; pageId: string; day: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [v, setV] = useState<Version | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    backend.versionAsOf(pageId, day).then(
      (x) => {
        if (live) setV(x);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [backend, pageId, day]);
  const title = tree.byId[pageId]?.title || 'New note';
  const restore = async () => {
    if (!v) return;
    setBusy(true);
    try {
      await backend.restoreVersion(pageId, v.id);
      onOpen(pageId);
    } catch {
      // Still here, with the version on show. The host says why.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nb-asof" data-testid="as-of">
      <div className="nb-history-bar">
        <span className="nb-history-title">
          <strong>{title}</strong> as of {formatDayLong(day)}
          {v && <span className="nb-muted"> · saved {formatTime(v.createdAt)}</span>}
        </span>
        <span className="nb-history-actions">
          {v && (
            <button type="button" className="nb-btn primary" disabled={busy} onClick={() => void restore()}>
              <Icon name="restore" size={16} /> Restore
            </button>
          )}
          <button type="button" className="nb-btn" onClick={() => onOpen(pageId)}>Open page</button>
          <button type="button" className="nb-btn" onClick={onBack}>Back</button>
        </span>
      </div>
      <div className="nb-asof-body">
        {v === undefined ? null : v ? (
          <div className="nb-paper nb-asof-paper">
            <ReadOnlyDoc doc={v.doc} />
          </div>
        ) : (
          <div className="nb-tl-empty">
            <p>No version of this page was kept by the end of that day.</p>
            <p className="nb-muted">Versions are kept when you leave a page, while you write, and at midnight.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function TemporalView({ backend, tree, onOpen }: { backend: NotebookBackend; tree: Tree; onOpen: (pageId: string) => void }) {
  const today = dayKey(Date.now());
  const [day, setDay] = useState(today);
  const [ym, setYm] = useState(() => ({ y: dateFromKey(today).getFullYear(), m: dateFromKey(today).getMonth() }));
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [asOf, setAsOf] = useState<{ pageId: string; day: string } | null>(null);
  const rows = useAllActivity(backend, tree);

  const byDay = useMemo(() => {
    const m = new Map<string, ActivityRow[]>();
    for (const r of rows) {
      if (matches && !matches.has(r.pageId)) continue;
      const list = m.get(r.day);
      if (list) list.push(r);
      else m.set(r.day, [r]);
    }
    for (const list of m.values()) list.sort((a, b) => b.lastAt - a.lastAt);
    return m;
  }, [rows, matches]);
  const days = useMemo(() => [...byDay.keys()].sort().reverse(), [byDay]);

  const pick = (key: string) => {
    setDay(key);
    const d = dateFromKey(key);
    setYm({ y: d.getFullYear(), m: d.getMonth() });
  };

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches(null);
      return undefined;
    }
    let live = true;
    backend.search(q, { limit: 10_000 }).then(
      (hits) => {
        if (live) setMatches(new Set(hits.map((h) => h.pageId)));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [backend, query, tree]);

  // Typing a search jumps to the newest day with a match when the chosen day has none (as the prototype does).
  useEffect(() => {
    if (matches && days.length && !byDay.has(day)) pick(days[0] ?? day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const step = (dir: -1 | 1) => {
    const next = stepActiveDay(days, day, dir);
    if (next) pick(next);
  };

  if (asOf) return <AsOf backend={backend} tree={tree} pageId={asOf.pageId} day={asOf.day} onBack={() => setAsOf(null)} onOpen={onOpen} />;

  const entries = (byDay.get(day) ?? []).filter((r) => tree.byId[r.pageId]);
  const monthLabel = new Date(ym.y, ym.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shiftMonth = (n: number) =>
    setYm(({ y, m }) => {
      const d = new Date(y, m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const q = query.trim();

  return (
    <div
      className="nb-temporal"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || e.altKey || e.metaKey || e.ctrlKey) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          step(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
    >
      <aside className="nb-side nb-tl-side">
        <div className="nb-cal" aria-label="Calendar">
          <div className="nb-cal-head">
            <button type="button" className="nb-icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><Icon name="chevronLeft" size={16} /></button>
            <span className="nb-cal-month" aria-live="polite">{monthLabel}</span>
            <button type="button" className="nb-icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><Icon name="chevronRight" size={16} /></button>
            <button type="button" className="nb-text-btn" onClick={() => pick(today)}>Today</button>
          </div>
          {/* Each day's button says its whole date, so the weekday letters are only for the eye. */}
          <div className="nb-cal-grid" role="group" aria-label={monthLabel}>
            {WEEKDAYS.map((w) => (
              <span key={w} className="nb-cal-dow" aria-hidden="true">{w}</span>
            ))}
            {monthCells(ym.y, ym.m).map((k) => {
              const n = byDay.get(k)?.length ?? 0;
              const out = dateFromKey(k).getMonth() !== ym.m;
              return (
                <button
                  key={k}
                  type="button"
                  className={`nb-cal-day${out ? ' out' : ''}${k === day ? ' on' : ''}${k === today ? ' today' : ''}`}
                  onClick={() => pick(k)}
                  aria-label={`${formatDayLong(k)}${n ? `, ${n} ${n === 1 ? 'page' : 'pages'}` : ''}`}
                  aria-pressed={k === day}
                >
                  <span>{dateFromKey(k).getDate()}</span>
                  <i className="nb-cal-dots" aria-hidden="true">
                    {Array.from({ length: Math.min(n, 3) }, (_, i) => (
                      <b key={i} />
                    ))}
                  </i>
                </button>
              );
            })}
          </div>
        </div>
        <label className="nb-field">
          <span>Jump to a date</span>
          <input type="date" value={day} onChange={(e) => e.target.value && pick(e.target.value)} />
        </label>
        <label className="nb-field">
          <span>Search notes</span>
          <input type="search" placeholder="Words in any note" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="temporal-search" />
        </label>
        <div className="nb-side-head"><h3>{q ? 'Days with matches' : 'Days with notes'}</h3></div>
        <ul className="nb-list nb-day-list">
          {days.slice(0, 60).map((k) => (
            <li key={k}>
              <button type="button" className={`nb-list-btn${k === day ? ' on' : ''}`} aria-current={k === day || undefined} onClick={() => pick(k)}>
                <span>{formatDayShort(k)}</span>
                <span className="nb-count">{byDay.get(k)?.length ?? 0}</span>
              </button>
            </li>
          ))}
          {!days.length && <li className="nb-hint">{q ? `No notes match “${q}”.` : 'No notes yet.'}</li>}
        </ul>
      </aside>
      <section className="nb-tl-main" aria-live="polite" tabIndex={-1}>
        <div className="nb-tl-head">
          <h3 className="nb-tl-day">{formatDayLong(day)}</h3>
          <span className="nb-tl-step">
            <button type="button" className="nb-icon-btn" disabled={!stepActiveDay(days, day, -1)} onClick={() => step(-1)} aria-label="Previous day with notes" title="Previous day with notes (←)">
              <Icon name="chevronLeft" size={16} />
            </button>
            <button type="button" className="nb-icon-btn" disabled={!stepActiveDay(days, day, 1)} onClick={() => step(1)} aria-label="Next day with notes" title="Next day with notes (→)">
              <Icon name="chevronRight" size={16} />
            </button>
          </span>
        </div>
        {entries.length ? (
          <ol className="nb-tl-entries">
            {entries.map((r) => {
              const page = tree.byId[r.pageId];
              if (!page) return null;
              const loc = locate(tree, r.pageId);
              const range = r.firstAt === r.lastAt || r.edits === 0 ? formatTime(r.firstAt) : `${formatTime(r.firstAt)} – ${formatTime(r.lastAt)}`;
              return (
                <li key={r.pageId} className="nb-tl-entry">
                  <button type="button" className="nb-tl-open" onClick={() => onOpen(r.pageId)}>
                    <span className={`nb-tl-kind${r.created ? ' created' : ''}`}>
                      {r.created ? (r.edits ? 'Created and edited' : 'Created') : 'Edited'} · {range}
                    </span>
                    <span className="nb-tl-title">{page.title || 'New note'}</span>
                    {loc && <span className="nb-tl-path">{loc.notebook.title} › {loc.tab.title}</span>}
                    <span className="nb-tl-snip">{page.snippet}</span>
                  </button>
                  {day !== today && (
                    <button type="button" className="nb-text-btn nb-tl-asof" onClick={() => setAsOf({ pageId: r.pageId, day })}>
                      As of this day
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="nb-tl-empty">
            <Icon name="calendar" size={28} />
            {q ? (
              <>
                <p>No note from this day matches “{q}”.</p>
                <p className="nb-muted">{days.length ? 'Pick a day under Days with matches.' : 'Try other words.'}</p>
              </>
            ) : (
              <>
                <p>No notes were written or edited on this day.</p>
                <p className="nb-muted">Days with notes have dots in the calendar. ← and → step between them.</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
