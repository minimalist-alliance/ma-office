// One to-do, whole: its title and note to change, its date, Snooze and "Keep in Needs you", where it came from with Open, who
// made and changed it, the untrusted line, and its History with Undo on every change. A real dialog, modal inside the window:
// labelled, Tab kept within it, Escape closes it and the keyboard goes back to where it came from. On a phone it's a sheet.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { reasonOf, toTodoError, type Item, type TodoClient } from './client';
import { addDays, dayIn, whenOf } from './model';
import { Icon, sourceIcon, type Ctx } from './parts';
import type { TodoEvent } from './types';
import { dateFrom, eventWords, openWhere, sourceNoun, W } from './words';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ title, onClose, children, testId }: { title: ReactNode; onClose(): void; children: ReactNode; testId: string }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const returnTo = back.current;
    const root = el?.closest('.todo-root');
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
      else root?.querySelector<HTMLElement>('.todo-views [aria-selected="true"]')?.focus({ preventScroll: true });
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="todo-scrim" onKeyDown={onKeyDown} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="todo-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
        <div className="todo-sheet-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="todo-icon-btn" onClick={onClose} aria-label={W.close}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const timeAt = (ms: number, tz: string): string => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms).toLowerCase();

export interface SheetActions {
  done(item: Item, as: 'done' | 'not_needed'): void;
  reopen(item: Item): void;
  trash(item: Item): void;
  restore(item: Item): void;
  snooze(item: Item, at: HTMLElement): void;
  unsnooze(item: Item): void;
  pin(item: Item, on: boolean): void;
  answer(item: Item, accept: boolean): void;
  openSource(item: Item): void;
  /** A change failed: one line, said politely. */
  say(text: string): void;
}

export function ItemSheet({ deskId, id, initial, client, ctx, actions, onClose }: { deskId: string; id: string; initial: Item | null; client: TodoClient | null; ctx: Ctx; actions: SheetActions; onClose(): void }) {
  const [item, setItem] = useState<Item | null>(initial);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [gone, setGone] = useState(false);
  // "Keep in Needs you" moves at the press; the desk's answer then holds it (or puts it back, with the line saying why).
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  useEffect(() => {
    if (item) setPinned(item.pinned);
  }, [item]);
  const tz = ctx.tz(deskId);
  const today = ctx.today(deskId);
  const ids = { title: useId(), note: useId(), date: useId(), time: useId() };

  const read = useCallback(async (): Promise<void> => {
    if (!client) return;
    try {
      const got = await client.get(id);
      if (!got.item) {
        setGone(true);
        return;
      }
      setItem(got.item);
      setEvents(got.events);
    } catch (e) {
      if (toTodoError(e).code === 'not_found') setGone(true);
    }
  }, [client, id]);

  useEffect(() => {
    void read();
  }, [read]);

  // A change from anywhere (another device, an agent, a button here) comes back as the item the list now holds: read it again.
  const rev = initial?.rev;
  useEffect(() => {
    if (rev !== undefined && item && rev !== item.rev) void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // The fields follow the desk's copy unless the member is mid-edit.
  const editing = useRef<'title' | 'note' | null>(null);
  useEffect(() => {
    if (!item) return;
    if (editing.current !== 'title') setTitle(item.title);
    if (editing.current !== 'note') setNote(item.note ?? '');
  }, [item]);

  /** What's been sent of the title and note, so closing doesn't send them twice. */
  const sent = useRef<{ title?: string; note?: string | null }>({});
  const save = async (patch: { title?: string; note?: string | null; due?: { date: string; time?: string | null } | null }): Promise<void> => {
    if (!client || !item) return;
    if (patch.title !== undefined) sent.current.title = patch.title;
    if (patch.note !== undefined) sent.current.note = patch.note;
    setError(null);
    try {
      const next = await client.update(item, patch);
      setItem(next);
      void read();
    } catch (e) {
      const x = toTodoError(e);
      setError(x.code === 'bad_request' && (reasonOf(x) === 'title' || reasonOf(x) === 'note') ? W.tooLong : x.code === 'not_found' ? W.gone : x.code === 'conflict' && reasonOf(x) === 'closed' ? W.closedNow : W.failed);
      void read();
    }
  };

  if (gone || (!item && !initial)) {
    return (
      <Sheet title={W.name} onClose={onClose} testId="todo-sheet">
        <p className="todo-sheet-line">{gone ? W.gone : W.readFailed}</p>
      </Sheet>
    );
  }
  const it = item ?? initial!;
  // Closing (Escape, the close button, a press outside) keeps what was typed: a field taken away mid-edit has no blur.
  const close = (): void => {
    const patch: { title?: string; note?: string | null } = {};
    const t = title.replace(/[\r\n]+/g, ' ').trim();
    const n = note.trim() || null;
    if (t && t !== it.title && t !== sent.current.title && it.trashedAt === null) patch.title = t;
    if (n !== (it.note ?? null) && n !== sent.current.note && it.trashedAt === null) patch.note = n;
    if (Object.keys(patch).length && client && it.state === 'open') {
      void client.update(it, patch).catch(() => actions.say(W.failed));
    }
    onClose();
  };
  const closed = it.state !== 'open';
  const trashed = it.trashedAt !== null;
  const when = whenOf(it, today, ctx.now, tz);
  const maker = ctx.maker(deskId, it);
  // "Changed by Inbox, 11:02": the newest edit by someone other than its maker, from its History.
  const lastEdit = events.find((e) => (e.op === 'edit' || e.op === 'merge') && e.actor !== it.by);
  const changer = lastEdit ? ctx.who(deskId, it, lastEdit.actor) : null;
  const dueDate = it.due?.date ?? '';
  const dueTime = it.due?.time ?? '';
  const setDue = (date: string, time: string): void => void save({ due: date ? { date, time: time || null } : null });
  const where = openWhere(it.source.kind);

  return (
    <Sheet title={<span className="sr-only">{it.title}</span>} onClose={close} testId="todo-sheet">
      <div className="todo-sheet-body">
        <label htmlFor={ids.title} className="todo-field-label">
          {W.title}
        </label>
        <textarea
          id={ids.title}
          className="todo-field todo-field-title"
          rows={2}
          maxLength={200}
          value={title}
          data-autofocus
          readOnly={trashed}
          onFocus={() => (editing.current = 'title')}
          onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, ' '))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
          onBlur={() => {
            editing.current = null;
            const t = title.trim();
            if (t && t !== it.title) void save({ title: t });
            else if (!t) setTitle(it.title);
          }}
        />
        <div className="todo-sheet-meta">
          {when.text && !closed && <span className={`todo-when${when.hot ? ' hot' : ''}`}>{when.text}</span>}
          {closed && <span className="todo-when">{it.state === 'done' ? 'Done' : 'Not needed'}{it.closed ? ` · ${timeAt(it.closed.at, tz)}` : ''}</span>}
          {ctx.deskLabel(deskId) && <span className="todo-desk">{ctx.deskLabel(deskId)}</span>}
          <span className="todo-meta-text">
            Made by {maker}
            {it.createdAt ? `, ${dayIn(it.createdAt, tz) === today ? timeAt(it.createdAt, tz) : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(it.createdAt)}` : ''}
            {changer && lastEdit ? ` · Changed by ${changer}, ${timeAt(lastEdit.at, tz)}` : ''}
          </span>
        </div>
        {it.untrusted && (
          <p className="todo-untrusted">
            <Icon name="shield" />
            {W.untrusted(sourceNoun(it.source.kind))}
          </p>
        )}
        {error && (
          <p className="todo-sheet-error" role="alert">
            {error}
          </p>
        )}

        {!trashed && (
          <div className="todo-sheet-acts">
            {!closed ? (
              <>
                <button type="button" className="todo-btn primary" onClick={() => actions.done(it, 'done')}>
                  <Icon name="check" />
                  {W.markDone}
                </button>
                <button type="button" className="todo-btn" onClick={() => actions.done(it, 'not_needed')}>
                  {W.notNeeded}
                </button>
                {it.snoozedUntil && it.snoozedUntil > ctx.now ? (
                  <button type="button" className="todo-btn" onClick={() => actions.unsnooze(it)}>
                    {W.unsnooze}
                  </button>
                ) : (
                  <button type="button" className="todo-btn" aria-haspopup="menu" onClick={(e) => actions.snooze(it, e.currentTarget)}>
                    <Icon name="moon" />
                    {W.snooze}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="todo-btn" onClick={() => actions.reopen(it)}>
                {W.reopen}
              </button>
            )}
            <button type="button" className="todo-btn quiet" onClick={() => actions.trash(it)}>
              <Icon name="trash" />
              {W.delete}
            </button>
          </div>
        )}
        {trashed && (
          <div className="todo-sheet-acts">
            <button type="button" className="todo-btn primary" onClick={() => actions.restore(it)}>
              {W.restore}
            </button>
          </div>
        )}
        {it.suggestion && !closed && it.suggestion.untrusted && (
          <p className="todo-untrusted">
            <Icon name="shield" />
            {W.suggestUntrusted}
          </p>
        )}
        {it.suggestion && !closed && (
          <div className="todo-sheet-sug">
            <span>
              {it.suggestion.as === 'done' ? 'Looks done?' : 'Not needed any more?'} <b>{ctx.who(deskId, it, it.suggestion.by)}</b> {it.suggestion.reason}
            </span>
            <span className="todo-sug-acts">
              <button type="button" className="todo-btn primary" onClick={() => actions.answer(it, true)}>
                {it.suggestion.as === 'done' ? 'Done' : 'Not needed'}
              </button>
              <button type="button" className="todo-btn" onClick={() => actions.answer(it, false)}>
                {W.notYet}
              </button>
            </span>
          </div>
        )}

        {!closed && !trashed && (
          <>
            <label className="todo-switch">
              <input
                type="checkbox"
                role="switch"
                checked={pinned}
                onChange={(e) => {
                  setPinned(e.target.checked);
                  actions.pin(it, e.target.checked);
                }}
              />
              <span className="todo-switch-track" aria-hidden="true" />
              {W.keep}
            </label>
            <fieldset className="todo-due">
              <legend className="todo-field-label">{W.due}</legend>
              <span className="todo-due-row">
                <label htmlFor={ids.date} className="sr-only">
                  Due date
                </label>
                <input id={ids.date} type="date" className="todo-field todo-date" value={dueDate} onChange={(e) => setDue(e.target.value, dueTime)} />
                <label htmlFor={ids.time} className="sr-only">
                  {W.time}
                </label>
                <input id={ids.time} type="time" className="todo-field todo-time" value={dueTime} disabled={!dueDate} onChange={(e) => setDue(dueDate, e.target.value)} />
              </span>
              <span className="todo-due-row">
                <button type="button" className="todo-chip" aria-pressed={dueDate === today} onClick={() => setDue(today, '')}>
                  {W.today}
                </button>
                <button type="button" className="todo-chip" aria-pressed={dueDate === addDays(today, 1)} onClick={() => setDue(addDays(today, 1), '')}>
                  {W.tomorrow}
                </button>
                {dueDate && (
                  <button type="button" className="todo-chip" onClick={() => setDue('', '')}>
                    {W.clearDate}
                  </button>
                )}
              </span>
              {it.due && it.due.by !== 'member' && <span className="todo-meta-text">{dateFrom(it.source.kind)}</span>}
            </fieldset>
          </>
        )}

        <label htmlFor={ids.note} className="todo-field-label">
          {W.note}
        </label>
        <textarea
          id={ids.note}
          className="todo-field todo-field-note"
          rows={3}
          maxLength={2000}
          value={note}
          readOnly={trashed}
          onFocus={() => (editing.current = 'note')}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            editing.current = null;
            if ((note.trim() || null) !== (it.note ?? null)) void save({ note: note.trim() || null });
          }}
        />

        {it.source.kind !== 'member' && it.source.label && (
          <section className="todo-from" aria-label={W.whereFrom}>
            <h4>{W.whereFrom}</h4>
            <p className="todo-from-who">
              <Icon name={sourceIcon(it.source.kind)} />
              {it.source.label}
            </p>
            {it.mergeCount > 0 && <p className="todo-meta-text">{it.mergeCount === 1 ? 'A reminder was merged in, not added twice.' : `${it.mergeCount} reminders were merged in, not added twice.`}</p>}
            {it.alsoFrom.length > 0 && (
              <ul className="todo-also">
                {it.alsoFrom.map((s, n) => (
                  <li key={n}>{s.label}</li>
                ))}
              </ul>
            )}
            {where && (
              <button type="button" className="todo-btn" onClick={() => actions.openSource(it)}>
                {W.open} in {where}
                <Icon name="out" />
              </button>
            )}
          </section>
        )}

        {events.length > 0 && (
          <section className="todo-hist" aria-label={W.history}>
            <h4>{W.history}</h4>
            <ul>
              {events.map((e) => {
                const who = ctx.who(deskId, it, e.actor);
                const undoable = !trashed && e.op !== 'seen' && e.op !== 'remove' && e.op !== 'undo';
                return (
                  <li key={e.id}>
                    <span className="todo-hist-what">{eventWords(e.op, who, e.after, e.before)}</span>
                    <span className="todo-hist-at">{dayIn(e.at, tz) === today ? timeAt(e.at, tz) : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(e.at)}</span>
                    {undoable && (
                      <button
                        type="button"
                        className="todo-link"
                        aria-label={`${W.undo}: ${eventWords(e.op, who, e.after, e.before)}`}
                        onClick={() => {
                          if (!client) return;
                          void client.undo(e.id).then(
                            () => read(),
                            (err) => {
                              const x = toTodoError(err);
                              actions.say(x.code === 'conflict' && reasonOf(x) === 'changed' ? W.changedSince : W.failed);
                              void read();
                            },
                          );
                        }}
                      >
                        {W.undo}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}
