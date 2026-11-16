// The To-do column on the room's right (CONCEPT.md §2, §3; the owner named it "To-do", Nov 12): her status line on top, at
// most three things with only one "Now", the rest waiting under Later, and one line at its foot. It collapses with a chevron to
// a slim edge with the count and the "Now" dot, and the member's choice follows them (`prefs.trackerCollapsed`). With the
// viewport open it folds into a strip of pills, "Now" first; on a phone it's a pill in the top bar that opens a sheet.
// "Now" is the accent blue and weight, never a warning colour (the owner's rule).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { countWords, dollars, edgeName, statusWords, W } from './words';
import { allowanceLines, laterLine, openCount, type Column as Arranged, type ColumnItem } from './model';
import type { RoomState } from './source';

export interface ColumnProps {
  col: Arranged;
  state: RoomState;
  desks: number;
  onShow: (item: ColumnItem) => void;
  onSnooze: (item: ColumnItem) => void;
  /** What reaches the member (the focus shield): the held line at the column's head, its card and catch-up under it. */
  reach?: ReactNode;
}

export function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
      <path d={dir === 'right' ? 'm9.5 6 6 6-6 6' : 'M14.5 6 8.5 12l6 6'} />
    </svg>
  );
}

export function StatusLine({ state, desks }: { state: RoomState; desks: number }) {
  const [lead, rest] = statusWords(state.status ?? { desks, agents: null, working: null });
  return (
    <p className="mm-status">
      <b>{lead}</b>
      {rest}
    </p>
  );
}

// Her day summary: what she has on, what's done, and what her briefs cost today against the member's day budget for them. Those
// briefs run on the member's own keys, so they're dollars (their provider's bill); the briefs' line opens the same figures per
// desk, today and this month. Then Maia's own usage, in credits only (the owner, Nov 15): what's left of the month's and when
// they renew, where she's drawing from or the lighter model, and a day cap the member set on her. Never a dollar figure for her
// own usage, and never a countdown.
function Foot({ state }: { state: RoomState }) {
  const [open, setOpen] = useState(false);
  const f = state.foot;
  const a = allowanceLines(state.allowance, Date.now());
  if (!f && !a.left && !a.detail && !a.note && !a.cap) return null;
  const b = f?.briefs ?? null;
  return (
    <div className="mm-foot-wrap">
      {f && (
        <p className="mm-foot">
          <span>
            {f.onIt > 0 && <span className="mm-dot" aria-hidden="true" />}
            On it: <b>{f.onIt}</b>
          </span>
          <span>
            Done today: <b>{f.doneToday}</b>
          </span>
          {b && (
            <button type="button" className="mm-foot-briefs" aria-expanded={open} aria-controls="mm-briefs-by-desk" onClick={() => setOpen(!open)}>
              {W.briefsToday} <b>{dollars(b.todayUsd)}</b> {W.briefsOf} {dollars(b.budgetUsd)} · {W.yourKeys}
            </button>
          )}
          {a.cap && <span>{a.cap}</span>}
        </p>
      )}
      {b && open && (
        <ul id="mm-briefs-by-desk" className="mm-foot-desks" aria-label={W.briefsByDesk}>
          {b.desks.map((d) => (
            <li key={d.deskId}>
              <span className="mm-foot-desk">{d.name}</span>
              <span>
                <b>{dollars(d.todayUsd)}</b> {W.briefsTodayShort} · {dollars(d.monthUsd)} {W.briefsMonth}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(a.left || a.detail || a.note) && (
        <p className="mm-credits">
          {a.left && <span className="mm-credits-left">{a.left}</span>}
          {a.detail && <span className="mm-credits-detail">{a.detail}</span>}
          {a.note && <span className="mm-credits-note">{a.note}</span>}
        </p>
      )}
    </div>
  );
}

function Item({ item, onShow, onSnooze, compact }: { item: ColumnItem; onShow: ColumnProps['onShow']; onSnooze: ColumnProps['onSnooze']; compact: boolean }) {
  const now = item.urgency === 'now';
  return (
    <li className={`mm-item${now ? ' now' : ''}${compact ? ' compact' : ''}`}>
      <p className="mm-item-row">
        <span className="mm-when">{now ? W.now : W.next}</span>
        <span className="mm-desk">{item.deskName}</span>
      </p>
      <p className="mm-item-title">{item.title}</p>
      {!compact && item.meta && <p className="mm-item-meta">{item.meta}</p>}
      <div className="mm-acts">
        {item.label && (
          <button type="button" className={`mm-btn${now ? ' primary' : ''}`} aria-label={`${item.label}: ${item.title}`} onClick={() => onShow(item)}>
            {item.label}
          </button>
        )}
        {now && (
          <button type="button" className="mm-btn quiet" aria-label={`${W.notNow}: ${item.title}`} onClick={() => onSnooze(item)}>
            {W.notNow}
          </button>
        )}
      </div>
    </li>
  );
}

/** One polite line when a new Now arrives: never an alert, and nothing for the rest. */
export function NowSaid({ col }: { col: Arranged }) {
  const [said, setSaid] = useState('');
  const last = useRef<string | null>(null);
  useEffect(() => {
    const id = col.now?.id ?? null;
    if (id && id !== last.current) setSaid(`${W.now}: ${col.now?.title ?? ''}`);
    last.current = id;
  }, [col.now]);
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {said}
    </span>
  );
}

export function TodoList({ col, state, onShow, onSnooze }: Pick<ColumnProps, 'col' | 'state' | 'onShow' | 'onSnooze'>) {
  const later = laterLine(col, state.later);
  return (
    <>
      {col.now || col.next.length ? (
        <ul className="mm-items" aria-label={W.todo}>
          {col.now && <Item item={col.now} onShow={onShow} onSnooze={onSnooze} compact={false} />}
          {col.next.map((i) => (
            <Item key={i.id} item={i} onShow={onShow} onSnooze={onSnooze} compact />
          ))}
        </ul>
      ) : (
        <p className="mm-empty">{W.nothing}</p>
      )}
      {later && (
        <p className="mm-later">
          <b>{later.count}</b>
          {later.lines.length ? ` · ${later.lines.join(' · ')}` : ''}
        </p>
      )}
    </>
  );
}

/** The column, open. The chevron collapses it (and Alt+Shift+T, the shortcut). */
export function OpenColumn({ col, state, desks, onShow, onSnooze, onCollapse, reach }: ColumnProps & { onCollapse: () => void }) {
  const counts = countWords(col.now ? 1 : 0, col.next.length);
  return (
    <aside className="mm-col" aria-label={W.todo}>
      <StatusLine state={state} desks={desks} />
      <div className="mm-col-head">
        <h2 className="mm-col-title">{W.todo}</h2>
        {counts && <span className="mm-col-counts">{counts}</span>}
        <button type="button" className="mm-icon-btn mm-collapse" aria-label={W.collapse} aria-expanded={true} aria-controls="mm-col-list" title={`${W.collapse} (Alt+Shift+T)`} onClick={onCollapse}>
          <Chevron dir="right" />
        </button>
      </div>
      {reach}
      <div id="mm-col-list" className="mm-col-list">
        <TodoList col={col} state={state} onShow={onShow} onSnooze={onSnooze} />
      </div>
      <Foot state={state} />
    </aside>
  );
}

/** Collapsed: a slim edge with the count and the "Now" dot, one button, and nothing else to read. */
export function Edge({ col, onExpand }: { col: Arranged; onExpand: () => void }) {
  const count = openCount(col);
  const now = col.now ? 1 : 0;
  return (
    <button type="button" className="mm-edge" aria-label={edgeName(count, now)} aria-expanded={false} title={`${W.expand} (Alt+Shift+T)`} onClick={onExpand}>
      <Chevron dir="left" />
      <span className="mm-edge-n" aria-hidden="true">{count}</span>
      {col.now && <span key={col.now.id} className="mm-now-dot pulse" aria-hidden="true" />}
    </button>
  );
}

/** With the viewport open: the column as a strip of pills over it, "Now" first, then the next, then "Later · n". */
export function Pills({ col, state, onShow }: { col: Arranged; state: ColumnProps['state']; onShow: ColumnProps['onShow'] }) {
  const items = [col.now, ...col.next].filter((i): i is ColumnItem => !!i);
  const later = laterLine(col, state.later)?.count ?? null;
  return (
    <nav className="mm-pills" aria-label={W.todo}>
      {items.map((i) => (
        <button key={i.id} type="button" className={`mm-pill${i.urgency === 'now' ? ' now' : ''}`} disabled={!i.label} onClick={() => onShow(i)}>
          {i.urgency === 'now' && <span className="mm-when">{W.now}</span>}
          <span className="mm-pill-t">{i.title}</span>
        </button>
      ))}
      {later && <span className="mm-pills-later">{later}</span>}
    </nav>
  );
}

/** The phone's sheet: the whole list, under the thumb. */
export function TodoSheet({ col, state, desks, onShow, onSnooze, onClose, reach }: ColumnProps & { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div className="mm-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} className="mm-sheet" role="dialog" aria-modal="true" aria-label={W.todo} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
        <div className="mm-sheet-head">
          <h2 className="mm-col-title">{W.todo}</h2>
          <button type="button" className="mm-icon-btn" aria-label="Close To-do" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
              <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
            </svg>
          </button>
        </div>
        <StatusLine state={state} desks={desks} />
        {reach}
        <TodoList col={col} state={state} onShow={onShow} onSnooze={onSnooze} />
        <Foot state={state} />
      </div>
    </>
  );
}
