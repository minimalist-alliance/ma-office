// Courier's small pieces: its icons (monochrome strokes in `currentColor`, never a medium's brand colour: SMS is never green),
// a medium's mark, a menu, and the one quiet line at the foot that says what just happened, with Undo. Every control is a real
// button whose name holds its visible words.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Medium } from './types';
import { MEDIUM_WORDS, W } from './words';

const P: Record<string, ReactNode> = {
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>
  ),
  /** A sealed bubble: private between desks. */
  sealed: (
    <>
      <path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5H4.5z" />
      <rect x="9.5" y="9.5" width="5" height="3.6" rx=".6" />
      <path d="M10.6 9.5V8.4a1.4 1.4 0 0 1 2.8 0v1.1" />
    </>
  ),
  bubble: <path d="M12 5c4.4 0 8 2.7 8 6s-3.6 6-8 6c-.9 0-1.8-.1-2.6-.3L5.5 18.5l1.1-3.1C5 14.3 4 12.7 4 11c0-3.3 3.6-6 8-6z" />,
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M15.5 6.5a3 3 0 0 1 0 5.6M17 14.8c1.8.5 3 1.9 3.5 4.2" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5 6.5 5.5h11l2.5 8v5H4z" />
      <path d="M4 13.5h4.5l1 2h5l1-2H20" />
    </>
  ),
  updates: (
    <>
      <path d="M5 5.5h14v13H5z" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </>
  ),
  other: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" />
    </>
  ),
  spam: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  more: (
    <>
      <circle cx="6" cy="12" r=".9" />
      <circle cx="12" cy="12" r=".9" />
      <circle cx="18" cy="12" r=".9" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  /** Accounts, in the lanes' foot (the Designer's call 4): an @, not a plus. */
  at: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M15.6 9v4.2a2.4 2.4 0 0 0 4.4 1.3A8.5 8.5 0 1 0 16.4 19" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  clip: <path d="M17.5 11.5l-6 6a4 4 0 0 1-5.7-5.7l7-7a2.7 2.7 0 0 1 3.8 3.8l-7 7a1.3 1.3 0 0 1-1.9-1.9l6-6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.1" />
    </>
  ),
  keys: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10h.1M10.5 10h.1M14 10h.1M17 10h.1M8 14h8" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.8" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  open: <path d="M9 5h10v10M19 5L8 16" />,
  reply: <path d="M10 7L5 12l5 5M5 12h9a5 5 0 0 1 5 5" />,
  shield: <path d="M12 4 5.5 6.5v5c0 4.2 2.7 7 6.5 8.5 3.8-1.5 6.5-4.3 6.5-8.5v-5Z" />,
  /** A desk's key (a contact's key changed). */
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5 19 4M15.5 7.5l2.5 2.5M17.5 5.5 20 8" />
    </>
  ),
  /** Held: nothing goes or comes until the member checks. */
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9" rx="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  /** Save to Files: a tray with an arrow into it. */
  save: <path d="M12 4v10M8 10.5l4 4 4-4M5 15.5V19h14v-3.5" />,
  /** Download, to this device: an arrow down onto a line. */
  download: <path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`courier-i${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}

const MEDIUM_ICON: Record<Medium, IconName> = { email: 'mail', ma: 'sealed', imessage: 'bubble', sms: 'phone' };

/** A medium's small mark, with its name for screen readers and as its tooltip. */
export function MediumMark({ medium }: { medium: Medium }) {
  return (
    <span className="courier-medium" title={MEDIUM_WORDS[medium]}>
      <Icon name={MEDIUM_ICON[medium]} />
      <span className="courier-sr">{MEDIUM_WORDS[medium]}</span>
    </span>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  /** A second, quieter line under the label ("Its messages go back to their own conversation."). */
  line?: string;
  onPick(): void;
}

/** A small menu under its button: arrows, Home and End move; Esc closes it and the keyboard goes back to the button. */
export function Menu({ items, anchor, label, onClose }: { items: MenuItem[]; anchor: HTMLElement; label: string; onClose(): void }) {
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
    const left = Math.max(8, Math.min(a.right - h.left - w, h.width - w - 8));
    let top = a.bottom - h.top + 4;
    if (top + mh > h.height - 8) top = Math.max(8, a.top - h.top - mh - 4);
    setPos({ top, left });
  }, [anchor]);
  const shut = useRef(onClose);
  shut.current = onClose;
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
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
    <div ref={ref} className="courier-menu" role="menu" aria-label={label} style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }} onKeyDown={onKeyDown}>
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          role="menuitem"
          className="courier-menu-item"
          tabIndex={-1}
          onClick={() => {
            close();
            i.onPick();
          }}
        >
          {i.line ? (
            <span className="courier-menu-two">
              <span>{i.label}</span>
              <span className="courier-quiet">{i.line}</span>
            </span>
          ) : (
            i.label
          )}
        </button>
      ))}
    </div>
  );
}

/** The menu's button and its menu, together. */
export function MenuButton({ label, items, className, icon = 'more', text }: { label: string; items: MenuItem[]; className?: string; icon?: IconName; text?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className ?? 'courier-icon-btn'}
        aria-label={text ? undefined : label}
        title={text ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Icon name={icon} />
        {text && <span>{text}</span>}
      </button>
      {anchor && <Menu items={items} anchor={anchor} label={label} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** A button for something that can't be undone: it asks first, in place, and the keyboard goes to the answer. */
export function ConfirmButton({ label, ask, onConfirm }: { label: string; ask: string; onConfirm(): void }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) yes.current?.focus();
    else if (asked.current) opener.current?.focus();
    asked.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <button ref={opener} type="button" className="courier-btn quiet" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="courier-ask" role="group" aria-label={ask}>
      <span>{ask}</span>
      <button
        ref={yes}
        type="button"
        className="courier-btn"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {label}
      </button>
      <button type="button" className="courier-btn quiet" onClick={() => setAsking(false)}>
        {W.cancel}
      </button>
    </span>
  );
}

export interface Foot {
  text: string;
  /** The pane that acted, where the line shows (the Designer's call 3): the list, or the pane beside it (the default). */
  where?: 'list' | 'side';
  undo?: () => void;
  /** How long it stays, in ms (default 8 s; a send's Undo lasts its own window). */
  ms?: number;
  /** A line the member reads whole, such as a number to compare: it wraps instead of being cut. */
  wrap?: boolean;
}

/** One quiet line at the foot after a change, with Undo; said once through the shell's live region by whoever set it. */
export function FootLine({ foot, onGone }: { foot: Foot; onGone(): void }) {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const t = window.setTimeout(() => gone.current(), foot.ms ?? 8000);
    return () => window.clearTimeout(t);
  }, [foot]);
  return (
    <div className={foot.wrap ? 'courier-foot wrap' : 'courier-foot'} data-testid="courier-foot">
      <span>{foot.text}</span>
      {foot.undo && (
        <button
          type="button"
          className="courier-foot-undo"
          onClick={() => {
            foot.undo?.();
            onGone();
          }}
        >
          {W.undo}
        </button>
      )}
    </div>
  );
}
