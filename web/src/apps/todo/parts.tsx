// To-do's pieces: the cards of Needs you, the All view's rows, the source line, the maker, the add row, a small menu and the
// Undo line. Desk text (titles, labels, an agent's reason) is rendered as text only. Every control is a real button with a
// name that holds its visible words, so keyboard and screen-reader members get the same app.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Item } from './client';
import { whenOf } from './model';
import type { SourceKind } from './types';
import { openWhere, sourceNoun, W } from './words';

const P: Record<string, ReactNode> = {
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>
  ),
  note: (
    <>
      <path d="M6 3.5h9l3.5 3.5v13.5H6z" />
      <path d="M9 11h6.5M9 15h4.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5z" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
    </>
  ),
  chat: <path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5H4.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="M7 10l5 5 5-5" />,
  out: <path d="M9 5h10v10M19 5L8 16" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  pin: <path d="M12 3.5l2.4 5 5.4.6-4 3.8 1.1 5.4L12 15.6l-4.9 2.7 1.1-5.4-4-3.8 5.4-.6z" />,
  more: (
    <>
      <circle cx="6" cy="12" r=".9" />
      <circle cx="12" cy="12" r=".9" />
      <circle cx="18" cy="12" r=".9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  undo: <path d="M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-3" />,
  shield: <path d="M12 4 5.5 6.5v5c0 4.2 2.7 7 6.5 8.5 3.8-1.5 6.5-4.3 6.5-8.5v-5Z" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`todo-i${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}

export const sourceIcon = (kind: SourceKind): IconName => (kind === 'courier' ? 'mail' : kind === 'notebook' ? 'note' : kind === 'browser' ? 'globe' : kind === 'files' ? 'file' : 'chat');

/** What each item needs from the window to show and act. */
export interface Ctx {
  today: (deskId: string) => string;
  now: number;
  tz: (deskId: string) => string;
  /** The desk's name, shown on each item only in All desks. */
  deskLabel: (deskId: string) => string | null;
  maker: (deskId: string, item: Item) => string;
  /** Who `actor` is on this item: its maker's name where it's the maker, else as the desk knows them. */
  who: (deskId: string, item: Item, actor: string) => string;
  /** Unseen when this window first showed it. */
  isNew: (id: string) => boolean;
  closing: ReadonlySet<string>;
  onDone(deskId: string, item: Item): void;
  onOpen(deskId: string, item: Item): void;
  onOpenSource(deskId: string, item: Item): void;
  onSnooze(deskId: string, item: Item, at: HTMLElement): void;
  onAnswer(deskId: string, item: Item, accept: boolean): void;
  phone: boolean;
}

export type Located = Item & { deskId: string };

export function Maker({ name }: { name: string }) {
  return (
    <span className="todo-maker">
      <span className={`todo-av${name === 'You' ? ' me' : ''}`} aria-hidden="true">
        {[...name][0] ?? '·'}
      </span>
      <span className="todo-maker-name">{name}</span>
    </span>
  );
}

export function SourceLine({ item, deskId, ctx, withOpen = true }: { item: Item; deskId: string; ctx: Ctx; withOpen?: boolean }) {
  if (item.source.kind === 'member' || !item.source.label) return null;
  const where = openWhere(item.source.kind);
  return (
    <span className="todo-src">
      <Icon name={sourceIcon(item.source.kind)} />
      <span className="todo-src-label">{item.source.label}</span>
      {item.untrusted && (
        <span className="todo-untrusted-mark" title={W.untrusted(sourceNoun(item.source.kind))}>
          <Icon name="shield" />
          <span className="sr-only">{W.untrusted(sourceNoun(item.source.kind))}</span>
        </span>
      )}
      {withOpen && where && (
        <button type="button" className="todo-go" onClick={() => ctx.onOpenSource(deskId, item)} aria-label={`${W.open} in ${where}: ${item.source.label}`}>
          {W.open}
          <Icon name="out" />
        </button>
      )}
    </span>
  );
}

/** The round check: one press marks it done, with Undo in the line at the foot. */
export function Check({ item, deskId, ctx, small }: { item: Item; deskId: string; ctx: Ctx; small?: boolean }) {
  const done = ctx.closing.has(item.id);
  return (
    <button type="button" className={`todo-check${small ? ' sm' : ''}`} aria-label={`${W.markDone}: ${item.title}`} data-closing={done || undefined} onClick={() => ctx.onDone(deskId, item)}>
      <Icon name="check" />
    </button>
  );
}

/** A long press opens the item; on a finger's screen a swipe right marks it done and a swipe left snoozes it. */
function useGestures(item: Item, deskId: string, ctx: Ctx) {
  const start = useRef<{ x: number; y: number; id: number; t: number } | null>(null);
  const timer = useRef<number | null>(null);
  const [dx, setDx] = useState(0);
  const el = useRef<HTMLLIElement | null>(null);
  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>): void => {
    if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now() };
    clear();
    timer.current = window.setTimeout(() => {
      start.current = null;
      setDx(0);
      ctx.onOpen(deskId, item);
    }, 500);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLLIElement>): void => {
    const s = start.current;
    if (!s || e.pointerId !== s.id) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clear();
    if (Math.abs(my) > Math.abs(mx) && Math.abs(dx) < 4) {
      start.current = null;
      return;
    }
    setDx(Math.max(-120, Math.min(120, mx)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLLIElement>): void => {
    clear();
    const s = start.current;
    start.current = null;
    if (!s || e.pointerId !== s.id) return;
    const mx = e.clientX - s.x;
    setDx(0);
    if (mx > 80) ctx.onDone(deskId, item);
    else if (mx < -80 && el.current) ctx.onSnooze(deskId, item, el.current);
  };
  const onPointerCancel = (): void => {
    clear();
    start.current = null;
    setDx(0);
  };
  return { ref: el, dx, handlers: ctx.phone ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } : {} };
}

/** A Needs you card (look A, Focus): when, the desk, the title, where it came from with Open, and who made it. */
export function Card({ item, deskId, ctx }: { item: Item; deskId: string; ctx: Ctx }) {
  const when = whenOf(item, ctx.today(deskId), ctx.now, ctx.tz(deskId));
  const desk = ctx.deskLabel(deskId);
  const g = useGestures(item, deskId, ctx);
  const maker = <Maker name={ctx.maker(deskId, item)} />;
  return (
    <li ref={g.ref} className={`todo-card${ctx.closing.has(item.id) ? ' closing' : ''}`} data-id={item.id} data-swipe={g.dx > 40 ? 'done' : g.dx < -40 ? 'snooze' : undefined} {...g.handlers}>
      <div className="todo-card-in" style={g.dx ? { transform: `translateX(${g.dx}px)` } : undefined}>
        <Check item={item} deskId={deskId} ctx={ctx} />
        <div className="todo-main">
          <div className="todo-r1">
            {when.text && <span className={`todo-when${when.hot ? ' hot' : ''}`}>{when.text}</span>}
            {desk && <span className="todo-desk">{desk}</span>}
            {ctx.isNew(item.id) && <span className="todo-new">New</span>}
            {ctx.phone && <span className="todo-r1-end">{maker}</span>}
          </div>
          <button type="button" className="todo-title" aria-haspopup="dialog" onClick={() => ctx.onOpen(deskId, item)}>
            {item.title}
          </button>
          <div className="todo-r3">
            <SourceLine item={item} deskId={deskId} ctx={ctx} />
            {!ctx.phone && maker}
          </div>
          {item.suggestion && <Suggestion item={item} deskId={deskId} ctx={ctx} />}
        </div>
      </div>
    </li>
  );
}

/** A compact row: the All view, To confirm and Done. */
export function Row({ item, deskId, ctx, right }: { item: Item; deskId: string; ctx: Ctx; right?: ReactNode }) {
  const when = whenOf(item, ctx.today(deskId), ctx.now, ctx.tz(deskId));
  const desk = ctx.deskLabel(deskId);
  const g = useGestures(item, deskId, ctx);
  const closed = item.state !== 'open';
  return (
    <li ref={g.ref} className={`todo-row${ctx.closing.has(item.id) ? ' closing' : ''}${closed ? ' closed' : ''}`} data-id={item.id} data-swipe={g.dx > 40 ? 'done' : g.dx < -40 ? 'snooze' : undefined} {...(closed ? {} : g.handlers)}>
      <div className="todo-row-in" style={g.dx ? { transform: `translateX(${g.dx}px)` } : undefined}>
        {!closed && <Check item={item} deskId={deskId} ctx={ctx} small />}
        <div className="todo-row-main">
          <div className="todo-row-top">
            <button type="button" className="todo-title sm" aria-haspopup="dialog" onClick={() => ctx.onOpen(deskId, item)}>
              {item.title}
            </button>
            {ctx.isNew(item.id) && <span className="todo-new">New</span>}
          </div>
          <div className="todo-row-meta">
            {!closed && when.text && <span className={`todo-when${when.hot ? ' hot' : ''}`}>{when.text}</span>}
            {desk && <span className="todo-desk">{desk}</span>}
            <SourceLine item={item} deskId={deskId} ctx={ctx} withOpen={false} />
            <Maker name={ctx.maker(deskId, item)} />
          </div>
          {item.suggestion && !closed && <Suggestion item={item} deskId={deskId} ctx={ctx} />}
        </div>
        {right}
      </div>
    </li>
  );
}

/** "Looks done? Inbox found a receipt from City Water", with Done and Not yet. The reason is the agent's, as text. */
export function Suggestion({ item, deskId, ctx }: { item: Item; deskId: string; ctx: Ctx }) {
  const s = item.suggestion!;
  const who = ctx.who(deskId, item, s.by);
  return (
    <div className="todo-sug">
      <span className="todo-sug-text">
        {s.untrusted && (
          <span className="todo-untrusted-mark" title={W.suggestUntrusted}>
            <Icon name="shield" />
            <span className="sr-only">{W.suggestUntrusted} </span>
          </span>
        )}
        {s.as === 'done' ? 'Looks done?' : 'Not needed any more?'} <b>{who}</b> {s.reason}
      </span>
      <span className="todo-sug-acts">
        <button type="button" className="todo-btn primary" onClick={() => ctx.onAnswer(deskId, item, true)} aria-label={`${s.as === 'done' ? 'Done' : 'Not needed'}: ${item.title}`}>
          <Icon name="check" />
          {s.as === 'done' ? 'Done' : 'Not needed'}
        </button>
        <button type="button" className="todo-btn" onClick={() => ctx.onAnswer(deskId, item, false)} aria-label={`${W.notYet}: ${item.title}`}>
          {W.notYet}
        </button>
      </span>
    </div>
  );
}

/** The add row: type, give it a day if you like, Enter. In All desks it says which desk it goes to. */
export function AddRow({ onAdd, desks, deskId, onDesk, busy }: { onAdd(title: string, day: 'today' | 'tomorrow' | null): Promise<boolean>; desks: { id: string; name: string }[]; deskId: string; onDesk(id: string): void; busy: boolean }) {
  const [text, setText] = useState('');
  const [day, setDay] = useState<'today' | 'tomorrow' | null>(null);
  const id = useId();
  const submit = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    if (await onAdd(text, day)) {
      setText('');
      setDay(null);
    }
  };
  return (
    <form
      className="todo-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {W.addLabel}
      </label>
      <Icon name="plus" className="todo-add-plus" />
      <input
        id={id}
        className="todo-add-input"
        value={text}
        maxLength={200}
        placeholder={W.add}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // A half-typed to-do: the first Escape clears it, so it never closes the window over the words.
          if (e.key === 'Escape' && text) {
            e.preventDefault();
            setText('');
          }
        }}
      />
      <span className="todo-add-chips" role="group" aria-label="Due">
        {(['today', 'tomorrow'] as const).map((d) => (
          <button key={d} type="button" className="todo-chip" aria-pressed={day === d} onClick={() => setDay(day === d ? null : d)}>
            {d === 'today' ? W.today : W.tomorrow}
          </button>
        ))}
        {desks.length > 1 && (
          <select className="todo-chip todo-chip-select" aria-label="Add to desk" value={deskId} onChange={(e) => onDesk(e.target.value)}>
            {desks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </span>
      <button type="submit" className="todo-btn primary todo-add-go" disabled={!text.trim() || busy}>
        Add
      </button>
    </form>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  checked?: boolean;
  onPick(): void;
}

/** A small menu, the office's way (`role="menu"`, arrows wrap, Home and End, Esc and Tab close, focus goes back). */
export function Menu({ items, anchor, label, onClose, extra }: { items: MenuItem[]; anchor: HTMLElement; label: string; onClose(): void; extra?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const host = ref.current?.offsetParent as HTMLElement | null;
    const menu = ref.current;
    if (!host || !menu) return;
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const w = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(a.right - h.left - w, h.width - w - 8);
    left = Math.max(8, left);
    let top = a.bottom - h.top + 4;
    if (top + mh > h.height - 8) top = Math.max(8, a.top - h.top - mh - 4);
    setPos({ top, left });
  }, [anchor]);
  const shut = useRef(onClose);
  shut.current = onClose;
  // The first item takes the keyboard once the menu is placed (a hidden one can't take focus).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [placed]);
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) shut.current();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [anchor]);
  const close = (): void => {
    onClose();
    if (anchor.isConnected) anchor.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number): void => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div ref={ref} className="todo-menu" role="menu" aria-label={label} style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }} onKeyDown={onKeyDown}>
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          role={i.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={i.checked}
          className="todo-menu-item"
          tabIndex={-1}
          onClick={() => {
            i.onPick();
            close();
          }}
        >
          {i.checked !== undefined && <span className="todo-menu-check">{i.checked && <Icon name="check" />}</span>}
          {i.label}
        </button>
      ))}
      {extra}
    </div>
  );
}

/** The one line at the foot after a change: what happened, with Undo, for 8 seconds. Said once through the shell's live region. */
export function UndoLine({ text, onUndo, onGone }: { text: string; onUndo?: () => void; onGone(): void }) {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const t = window.setTimeout(() => gone.current(), 8000);
    return () => window.clearTimeout(t);
  }, [text]);
  return (
    <div className="todo-toast" data-testid="todo-toast">
      <span>{text}</span>
      {onUndo && (
        <button
          type="button"
          className="todo-toast-undo"
          onClick={() => {
            onUndo();
            onGone();
          }}
        >
          {W.undo}
        </button>
      )}
    </div>
  );
}
