// Courier's window, the lazy chunk (the launch plan §5; deskd API.md §21). Calm first: lanes on the left (People, Requests with
// its count, Updates, Other, Spam, Trash), the conversations in the middle, one per person or group, and the conversation on the
// right with the reply under it. Narrower, the lanes go above the list; on a phone (and in any window under 700 px) it's one
// column: the list, then the conversation full width with Back. Everything is the desk's: read and unread, lanes and drafts are
// the same on every device the member opens their office on, and two offices open at once both hear `courier.changed`.
// Nothing here wakes a desk by itself.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { HostedBodyProps } from '../../agent/AgentWindow';
import { openInDeskBrowser } from '../../notebook/openLink';
import { getMe } from '../../platform/api';
import { useDeskStore } from '../../state/deskStore';
import { useLayoutStore } from '../../state/layoutStore';
import { ChooseAddress, copyText, InviteCard, ShareAddress, type InviteProblem } from './Address';
import { loadRegistry, type DeskAddress, type Registry } from './address';
import { pendingInvite, type Invite } from './invite';
import { rpcCourierClient, toCourierError, type CourierClient, type CourierError, type Linked } from './client';
import { highlight, rowLine, rowTitle, senderName, step, whenShort } from './model';
import { ConfirmButton, FootLine, Icon, MediumMark, type Foot, type IconName } from './parts';
import { LinkNote, LinkReview, LinkSheet, PersonPane, SuggestAsk, suggestionFor } from './People';
import { Setup } from './Setup';
import { ThreadPane } from './Thread';
import { LANES, type Account, type Endpoint, type Hit, type Lane, type MailLink, type Person, type Row, type Status, type Suggestion } from './types';
import { EMPTY, KEYS, LANE_LINE, LANE_WORDS, W } from './words';
import './courier.css';

const LANE_ICON: Record<Lane, IconName> = { people: 'people', requests: 'inbox', updates: 'updates', other: 'other', spam: 'spam', trash: 'trash' };
const count = (n: number): string => (n > 9 ? '9+' : String(n));
const zone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

/** How many columns fit: 3 from 960 px, 2 from 700, else 1 (a phone, a narrow window, an open tile). */
function useColumns(ref: RefObject<HTMLDivElement | null>): 1 | 2 | 3 {
  const [cols, setCols] = useState<1 | 2 | 3>(3);
  // The root element changes as the body goes from loading to the address card to the window, so it's watched afresh each time.
  const seen = useRef<{ el: HTMLDivElement | null; ro: ResizeObserver | null }>({ el: null, ro: null });
  useEffect(() => {
    const el = ref.current;
    if (el === seen.current.el) return;
    seen.current.ro?.disconnect();
    seen.current = { el, ro: null };
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setCols(w >= 960 ? 3 : w >= 700 ? 2 : 1);
    });
    ro.observe(el);
    seen.current.ro = ro;
  });
  useEffect(() => () => seen.current.ro?.disconnect(), []);
  return cols;
}

interface Selected {
  channelId: string;
  lane: Lane;
  focus: string | null;
}

/** What the pane beside the list shows instead of a conversation. */
type Side = { kind: 'share'; after: boolean } | { kind: 'person'; contactId: string } | { kind: 'review' } | { kind: 'invite'; invite: Invite; problem?: InviteProblem; displayName?: string };

/** A conversation's one person, when it has one: a direct conversation whose endpoints are all one contact's. */
export function personOf(row: Pick<Row, 'kind' | 'contacts'>): { contactId: string; endpoint: Endpoint } | null {
  const first = row.contacts[0];
  if (row.kind !== 'direct' || !first?.contactId || row.contacts.some((c) => c.contactId !== first.contactId)) return null;
  return { contactId: first.contactId, endpoint: first.endpoint };
}

/** "Later" on the address card, per desk, on this device: a convenience only, never desk content. */
const LATER_KEY = (deskId: string): string => `ma.courier.addressLater.${deskId}`;
function laterSaid(deskId: string): boolean {
  try {
    return window.localStorage.getItem(LATER_KEY(deskId)) === '1';
  } catch {
    return false;
  }
}
function sayLater(deskId: string): void {
  try {
    window.localStorage.setItem(LATER_KEY(deskId), '1');
  } catch {
    // A private window: the card asks again next time.
  }
}

/** Long press on a touch screen: "Link to someone…" for that row (p14). */
function useLongPress(onLong: () => void) {
  const t = useRef<number | null>(null);
  const at = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const stop = (): void => {
    if (t.current) window.clearTimeout(t.current);
    t.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        if (e.pointerType !== 'touch') return;
        at.current = { x: e.clientX, y: e.clientY };
        stop();
        t.current = window.setTimeout(() => {
          fired.current = true;
          onLong();
        }, 550);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (at.current && Math.hypot(e.clientX - at.current.x, e.clientY - at.current.y) > 8) stop();
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onContextMenu: (e: React.MouseEvent) => {
        if (fired.current) e.preventDefault();
      },
    },
  };
}

/** Why Courier can't open on this desk, in its own words, or null when it can. */
function stateWords(status: Status | null, error: CourierError | null): string | null {
  if (error) {
    if (error.code === 'old') return W.oldDesk;
    if (error.code === 'forbidden' && error.reason === 'teen') return W.teen;
    if (error.code === 'unavailable' && error.reason === 'age_band') return W.ageBand;
    if (error.code === 'unavailable' && error.reason === 'store') return W.storeMissing;
    if (error.code === 'unavailable' && error.reason === 'switched_off') return W.switchedOff;
    if (error.code === 'offline') return W.offline;
    return W.cantOpen;
  }
  if (!status) return null;
  if (status.state === 'off') return W.switchedOff;
  if (status.state === 'unavailable') return status.reason === 'switched_off' ? W.switchedOff : status.reason === 'age_band' ? W.ageBand : W.storeMissing;
  return null;
}

interface DragProps {
  /** This row can be dragged onto a person, and taken a drop: one person's conversation. */
  linkable: boolean;
  dropOn: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(e: React.DragEvent): void;
  onDragLeave(): void;
  onDrop(e: React.DragEvent): void;
  onLong(): void;
}

function RowButton({ row, now, selected, onOpen, drag }: { row: Row; now: number; selected: boolean; onOpen(): void; drag?: DragProps }) {
  const title = rowTitle(row);
  const line = rowLine(row);
  const long = useLongPress(() => drag?.onLong());
  return (
    <li className="courier-row-li" onDragOver={drag?.linkable ? drag.onDragOver : undefined} onDragLeave={drag?.linkable ? drag.onDragLeave : undefined} onDrop={drag?.linkable ? drag.onDrop : undefined}>
      <button
        type="button"
        className={`courier-row${row.unread ? ' unread' : ''}`}
        aria-current={selected || undefined}
        data-channel={row.channelId}
        data-drop={drag?.dropOn || undefined}
        draggable={drag?.linkable || undefined}
        onDragStart={
          drag?.linkable
            ? (e) => {
                e.dataTransfer.effectAllowed = 'link';
                e.dataTransfer.setData('text/plain', title);
                drag.onDragStart();
              }
            : undefined
        }
        onDragEnd={drag?.linkable ? drag.onDragEnd : undefined}
        {...(drag?.linkable ? long.handlers : {})}
        onClick={() => {
          if (long.fired.current) return void (long.fired.current = false);
          onOpen();
        }}
      >
        {drag?.dropOn && <span className="courier-drop-line">{W.dropTo(title)}</span>}
        <span className="courier-row-top">
          {row.unread > 0 && <span className="courier-dot" aria-hidden="true" />}
          <span className="courier-row-name">
            {title}
            {row.unread > 0 && <span className="courier-sr">unread</span>}
          </span>
          <time className="courier-row-time" dateTime={new Date(row.lastAt).toISOString()}>
            {whenShort(row.lastAt, now)}
          </time>
        </span>
        <span className="courier-row-bottom">
          {row.medium && <MediumMark medium={row.medium} />}
          {row.last?.warned && (
            <span className="courier-row-warned" title={W.warnedRow}>
              <Icon name="shield" />
              <span className="courier-sr">{W.warnedRow}</span>
            </span>
          )}
          <span className="courier-row-line">{line}</span>
          {row.count > 1 && <span className="courier-row-count">{row.count}</span>}
        </span>
      </button>
    </li>
  );
}

function RequestCard({ row, now, onOpen, onDecide, selected, suggestion, onLink, onNot, onReport }: { row: Row; now: number; selected: boolean; onOpen(): void; onDecide(d: 'let_in' | 'not_now' | 'block'): void; suggestion: Suggestion | null; onLink(s: Suggestion): void; onNot(s: Suggestion): void; onReport(): void }) {
  const who = rowTitle(row);
  // A known contact's mail whose sender check failed (the coordinator's call, Nov 14): no Block, which would block the real
  // contact; Report spam instead, and the card says why it's here.
  const forged = row.kind === 'direct' && !!row.contacts[0]?.known;
  const address = row.contacts[0]?.endpoint.value ?? '';
  const member = !forged && row.kind === 'direct' && row.contacts[0]?.endpoint.kind === 'ma';
  const id = useId();
  return (
    <li className="courier-request" aria-labelledby={id}>
      <button type="button" className="courier-request-open" aria-current={selected || undefined} data-channel={row.channelId} onClick={onOpen}>
        <span className="courier-row-top">
          <span className="courier-row-name" id={id}>
            {who}
          </span>
          <time className="courier-row-time" dateTime={new Date(row.lastAt).toISOString()}>
            {whenShort(row.lastAt, now)}
          </time>
        </span>
        {address && address !== who && <span className="courier-address">{address}</span>}
        {member && (
          // A member's desk you haven't added (flow 7): the address and the sealed mark.
          <span className="courier-request-member" data-testid="courier-request-member">
            <MediumMark medium="ma" />
            <span>{W.memberRequestHead}</span>
          </span>
        )}
        {row.last?.subject && <span className="courier-request-subject">{row.last.subject}</span>}
        {row.last?.snippet && <span className="courier-row-line">{row.last.snippet}</span>}
      </button>
      {/* A card links this number or address to someone: Link and Not take Let in's place, and linking lets them in. */}
      {suggestion && <SuggestAsk s={suggestion} card onLink={() => onLink(suggestion)} onNot={() => onNot(suggestion)} />}
      {forged && (
        <div className="courier-note" role="note" data-testid="courier-forged">
          <Icon name="shield" />
          <div>
            <strong>{W.forgedHead}</strong>
            <span>{W.forgedLine(who)}</span>
          </div>
        </div>
      )}
      <div className="courier-decide-btns">
        {!suggestion && (
          <button type="button" className={`courier-btn${forged ? '' : ' primary'}`} onClick={() => onDecide('let_in')} aria-label={`${W.letIn}: ${who}`}>
            {W.letIn}
          </button>
        )}
        <button type="button" className="courier-btn" onClick={() => onDecide('not_now')} aria-label={`${W.notNow}: ${who}`}>
          {W.notNow}
        </button>
        {forged ? (
          <button type="button" className="courier-btn" onClick={onReport} aria-label={`${W.reportSpam}: ${who}`}>
            {W.reportSpam}
          </button>
        ) : (
          <button type="button" className="courier-btn" onClick={() => onDecide('block')} aria-label={`${W.block}: ${who}`}>
            {W.block}
          </button>
        )}
      </div>
    </li>
  );
}

function HitButton({ hit, now, selected, onOpen }: { hit: Hit; now: number; selected: boolean; onOpen(): void }) {
  return (
    <li className="courier-row-li">
      <button type="button" className={`courier-row${hit.read ? '' : ' unread'}`} aria-current={selected || undefined} data-message={hit.messageId} onClick={onOpen}>
        <span className="courier-row-top">
          <span className="courier-row-name">{senderName(hit.from)}</span>
          <span className="courier-row-lane">{LANE_WORDS[hit.lane]}</span>
          <time className="courier-row-time" dateTime={new Date(hit.at).toISOString()}>
            {whenShort(hit.at, now)}
          </time>
        </span>
        {hit.subject && <span className="courier-request-subject">{hit.subject}</span>}
        <span className="courier-row-line">
          {highlight(hit.snippet, hit.matches).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
        </span>
      </button>
    </li>
  );
}

function KeysHelp({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const was = back.current;
    return () => (was as HTMLElement | null)?.focus?.();
  }, []);
  return (
    <div className="courier-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="courier-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="courier-keys-h"
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
          }
        }}
      >
        <h2 id="courier-keys-h">{W.keys}</h2>
        <dl className="courier-keys">
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="courier-btn" onClick={onClose}>
          {W.close}
        </button>
      </div>
    </div>
  );
}

export default function CourierBody({ deskId, link, session, offline, shell }: HostedBodyProps) {
  const client: CourierClient = useMemo(() => rpcCourierClient(link, shell.idem), [link, shell.idem]);
  const { announce } = shell;
  const root = useRef<HTMLDivElement>(null);
  const cols = useColumns(root);
  const narrow = cols === 1;
  const now = useNow(60_000);

  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<CourierError | null>(null);
  const [lane, setLane] = useState<Lane>('people');
  const [account, setAccount] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rows, setRows] = useState<{ lane: Lane; rows: Row[]; next: string | null } | null>(null);
  const [sel, setSel] = useState<Selected | null>(null);
  const [setup, setSetup] = useState(false);
  const [keys, setKeys] = useState(false);
  const [foot, setFoot] = useState<Foot | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState<{ q: string; hits: Hit[]; next: string | null; error: string | null; busy: boolean } | null>(null);
  const [ticks, setTicks] = useState({ status: 0, list: 0, thread: 0, accounts: 0 });
  // This desk's address (Platform's registry): undefined while asked, null where there's none to ask (an older platform).
  const [registry, setRegistry] = useState<Registry | null | undefined>(undefined);
  const [later, setLater] = useState(() => laterSaid(deskId));
  const [choosing, setChoosing] = useState(false);
  const [side, setSide] = useState<Side | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  // One person across channels: the open suggestions (null where the desk doesn't make them), a drag, the sheet.
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [dragFrom, setDragFrom] = useState<Row | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ title: string; contactId: string; channelId: string | null } | null>(null);
  const [justLinked, setJustLinked] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<{ focus(): void } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows?.rows ?? [];
  const selRef = useRef<Selected | null>(null);
  selRef.current = sel;

  const say = useCallback(
    (f: Foot | null, where: 'list' | 'side' = 'side') => {
      setFoot(f ? { ...f, where: f.where ?? where } : null);
      if (f) announce(f.text);
    },
    [announce],
  );
  const bump = useCallback((k: keyof typeof ticks | 'all') => setTicks((t) => (k === 'all' ? { status: t.status + 1, list: t.list + 1, thread: t.thread + 1, accounts: t.accounts + 1 } : { ...t, [k]: t[k] + 1 })), []);

  // The desk's word on Courier: whether it can, and the lanes' counts. Asked on each new session and after every change.
  useEffect(() => {
    let gone = false;
    client.status().then(
      (s) => {
        if (gone) return;
        setStatus(s);
        setError(null);
      },
      (e) => !gone && setError(toCourierError(e)),
    );
    return () => {
      gone = true;
    };
  }, [client, session, ticks.status]);

  const on = status?.state === 'on' && !error;

  useEffect(() => {
    if (!on) return;
    let gone = false;
    client.accounts().then(
      (a) => !gone && setAccounts(a),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [client, on, session, ticks.accounts]);

  // The registry, once Courier is on here: whether this desk has its address yet, and the member's other desks' (the stem note).
  useEffect(() => {
    if (!on) return;
    let gone = false;
    void loadRegistry().then((r) => !gone && setRegistry(r));
    return () => {
      gone = true;
    };
  }, [on, session]);

  // An invite link's Add for this desk (the account site's `/c/<name>`): asked here before anything is added (Security's CU-L1),
  // then the desk adds them, pinned to the link's fingerprint, and their conversation opens. Read once, then dropped.
  useEffect(() => {
    if (!on) return;
    const inv = pendingInvite(deskId, true);
    if (!inv) return;
    setSetup(false);
    setSel(null);
    setSide({ kind: 'invite', invite: inv });
  }, [on, deskId]);
  const addInvited = (inv: Invite, displayName: string): void => {
    void client.addMember({ ...inv, displayName }).then(
      (r) => {
        setSide(null);
        if (r.channelId) {
          setLane('people');
          setSetup(false);
          setSel({ channelId: r.channelId, lane: 'people', focus: null });
        }
        bump('all');
      },
      (e) => {
        // What the desk couldn't add stays on the card, said in place (CT-I7): a fingerprint that doesn't match, a checked key
        // that changed (its new safety number to compare), a closed address. Nothing was added for any of them.
        const err = toCourierError(e);
        const problem: InviteProblem | null =
          err.code === 'conflict' && err.reason === 'key_changed' && err.newSafetyNumber
            ? { kind: 'changed', number: err.newSafetyNumber }
            : err.code === 'conflict' && (err.reason === 'fingerprint' || err.reason === 'key_changed')
              ? { kind: 'mismatch', pinned: err.pinned || err.reason === 'key_changed' }
              : err.code === 'not_found' && err.reason === 'address_closed'
                ? { kind: 'closed' }
                : null;
        if (problem) return setSide({ kind: 'invite', invite: inv, problem, displayName });
        setSide(null);
        say({ text: err.code === 'old' || (err.code === 'not_found' && err.reason === 'method') ? W.oldDesk : err.code === 'offline' ? W.offline : W.failed }, 'list');
      },
    );
  };
  // "Compare safety numbers" on a link that doesn't match a desk already pinned: that person's view, where the number is.
  const compareInvited = (address: string): void =>
    void client.lookup({ kind: 'ma', value: address }).then(
      (l) => (l?.contactId ? setSide({ kind: 'person', contactId: l.contactId }) : say({ text: W.failed })),
      () => say({ text: W.failed }),
    );

  // Suggestions ("Is this also …?"): asked again after every change, as contacts arriving or a link change them.
  useEffect(() => {
    if (!on) return;
    let gone = false;
    client.suggestions().then(
      (list) => !gone && setSuggestions(list),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [client, on, session, ticks.list]);

  // Share needs this desk's fingerprint (its keys) and the member's name for the link's `n`.
  const sharing = side?.kind === 'share';
  useEffect(() => {
    if (!sharing) return;
    let gone = false;
    void client.keys().then((k) => !gone && setFingerprint(k.fingerprint));
    getMe().then(
      (r) => !gone && setDisplayName(typeof r.data?.displayName === 'string' ? r.data.displayName : null),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [client, sharing]);

  useEffect(() => {
    if (!on) return;
    let gone = false;
    client.list({ lane, accountId: account }).then(
      (r) => !gone && setRows({ lane, rows: r.rows, next: r.next }),
      (e) => !gone && say({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed }),
    );
    return () => {
      gone = true;
    };
  }, [client, on, lane, account, session, ticks.list, say]);

  // What changed on the desk, by any session, a transport or the sweep: ids and lanes only, so each part asks again for itself.
  useEffect(() => {
    if (!on) return;
    return client.watch((c) => {
      if (c.type === 'snapshot') return bump('all');
      const mine = rowsRef.current.map((r) => r.channelId);
      const s = selRef.current;
      setTicks((t) => ({
        status: t.status + 1,
        list: c.channels === null || c.lanes.includes(lane) || c.channels.some((id) => mine.includes(id)) ? t.list + 1 : t.list,
        thread: s && (c.channels === null || c.channels.includes(s.channelId)) ? t.thread + 1 : t.thread,
        accounts: c.accounts ? t.accounts + 1 : t.accounts,
      }));
    });
  }, [client, on, lane, bump]);

  // Search: as the member types (a quarter second after the last key), across People, Requests, Updates and Other unless
  // `in:` says otherwise; Esc or the clear button goes back to the lane.
  useEffect(() => {
    const term = q.trim();
    if (!on || term.length === 0) {
      setSearch(null);
      return;
    }
    setSearch((s) => ({ q: term, hits: s?.q === term ? s.hits : [], next: null, error: null, busy: true }));
    let gone = false;
    const t = window.setTimeout(() => {
      client.search({ q: term, zone: zone() }).then(
        (r) => !gone && setSearch({ q: term, hits: r.hits, next: r.next, error: null, busy: false }),
        (e) => {
          if (gone) return;
          const err = toCourierError(e);
          const why = err.code === 'bad_request' ? (err.reason === 'date' ? 'Dates are written 2026-11-01.' : err.reason === 'in' ? 'in: takes people, requests, updates, other, spam or trash.' : err.reason === 'has' ? 'has: takes attachment.' : err.reason === 'too_long' || err.reason === 'too_many_terms' ? 'That search is too long.' : W.searchHint) : err.code === 'offline' ? W.offline : W.failed;
          setSearch({ q: term, hits: [], next: null, error: why, busy: false });
        },
      );
    }, 250);
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
  }, [client, on, q]);

  const open = useCallback((s: Selected) => {
    setSetup(false);
    setSide(null);
    setSel(s);
  }, []);

  const pickLane = (l: Lane): void => {
    setLane(l);
    setSel(null);
    setQ('');
    setSetup(false);
    setSide(null);
    setRows((r) => (r && r.lane === l ? r : null));
  };

  const decide = (row: Row, d: 'let_in' | 'not_now' | 'block'): void => {
    const who = rowTitle(row);
    void client.decide(row.channelId, d).then(
      () => {
        say({ text: d === 'let_in' ? W.letInDone(who) : d === 'not_now' ? W.notNowDone(who) : W.blockedDone(who) }, 'list');
        if (sel?.channelId === row.channelId) setSel(null);
        bump('list');
        bump('status');
      },
      (e) => say({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed }, 'list'),
    );
  };

  /** Report spam on a Request (its messages in Requests), with Undo back to Requests. */
  const reportRequest = (row: Row): void => {
    const who = rowTitle(row);
    void client
      .thread(row.channelId, 'requests')
      .then((t) => {
        const ids = (t?.messages ?? []).filter((m) => m.direction === 'in').map((m) => m.messageId);
        return client.report(ids).then(() => ids);
      })
      .then(
        (ids) => {
          say({ text: `${LANE_WORDS.spam}: ${who}`, undo: () => void client.moveMessages(ids, 'restore').then(() => bump('all')) }, 'list');
          if (sel?.channelId === row.channelId) setSel(null);
          bump('all');
        },
        (e) => say({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed }, 'list'),
      );
  };

  // ---------------------------------------------------------------- linking: only ever on the member's press

  /** After a link: the line at the foot with Undo, and the person's conversation open where the linked one was. */
  const afterLink = (r: Linked, name: string, fromChannel: string | null, where: 'list' | 'side'): void => {
    const into = r.channelId;
    say({ text: W.linkDone(name), ...(r.linkId ? { undo: () => void client.undoLink(r.linkId!).then(() => bump('all'), () => say({ text: W.failed })) } : {}) }, where);
    if (into) setJustLinked((s) => new Set(s).add(into));
    if (into && sel && (sel.channelId === fromChannel || sel.channelId === into)) open({ channelId: into, lane: sel.lane === 'requests' ? 'people' : sel.lane, focus: null });
    else if (sel && sel.channelId === fromChannel) setSel(null);
    bump('all');
  };
  const failLink = (e: unknown, where: 'list' | 'side' = 'side'): void => {
    const code = toCourierError(e).code;
    // A deskd before links never merges in its place (never a silent merge): it says it needs an update.
    say({ text: code === 'offline' ? W.offline : code === 'old' ? W.oldDesk : W.failed }, where);
  };

  const linkSuggestion = (sg: Suggestion, where: 'list' | 'side' = 'side'): Promise<void> =>
    client.link({ into: sg.into.contactId, endpoint: sg.endpoint }).then(
      (r) => afterLink(r, sg.into.name, sg.channelId, where),
      (e) => failLink(e, where),
    );
  const notThem = (sg: Suggestion, where: 'list' | 'side' = 'side'): void =>
    void client.dismiss(sg.endpoint, sg.into.contactId).then(
      () => {
        say({ text: W.linkNoDone }, where);
        bump('list');
      },
      (e) => failLink(e, where),
    );
  /** A whole conversation's person onto another (a drop, "Link to someone…"). */
  const linkPerson = (from: { contactId: string; channelId: string | null }, into: { contactId: string; name: string }, where: 'list' | 'side'): void =>
    void client.link({ into: into.contactId, from: from.contactId }).then(
      (r) => afterLink(r, into.name, from.channelId, where),
      (e) => failLink(e, where),
    );

  const dragFor = (row: Row): DragProps | undefined => {
    const me = personOf(row);
    if (!me || lane === 'spam' || lane === 'trash' || lane === 'requests') return undefined;
    return {
      linkable: true,
      dropOn: dropOn === row.channelId,
      onDragStart: () => setDragFrom(row),
      onDragEnd: () => {
        setDragFrom(null);
        setDropOn(null);
      },
      onDragOver: (e) => {
        const from = dragFrom ? personOf(dragFrom) : null;
        if (!from || from.contactId === me.contactId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        if (dropOn !== row.channelId) setDropOn(row.channelId);
      },
      onDragLeave: () => setDropOn((d) => (d === row.channelId ? null : d)),
      onDrop: (e) => {
        e.preventDefault();
        const from = dragFrom ? personOf(dragFrom) : null;
        setDragFrom(null);
        setDropOn(null);
        if (!from || from.contactId === me.contactId || !dragFrom) return;
        // Dragging is deliberate, so a drop links at once, with Undo.
        linkPerson({ contactId: from.contactId, channelId: dragFrom.channelId }, { contactId: me.contactId, name: rowTitle(row) }, 'list');
      },
      onLong: () => setSheet({ title: rowTitle(row), contactId: me.contactId, channelId: row.channelId }),
    };
  };

  const links = useMemo(
    () => ({
      openLink: (l: MailLink) => {
        const browser = useLayoutStore.getState().desks[deskId]?.items.some((i) => i.app === 'browser');
        if (!browser) return say({ text: W.noBrowser });
        openInDeskBrowser(deskId, l.href);
        say({ text: W.opened(l.host) });
      },
      copy: (text: string) => {
        const done = (): void => say({ text: W.copied });
        const refused = (): void => say({ text: W.copyRefused });
        try {
          void navigator.clipboard.writeText(text).then(done, refused);
        } catch {
          refused();
        }
      },
    }),
    [deskId, say],
  );

  const showing: { ids: string[]; kind: 'rows' | 'hits' } = search ? { ids: search.hits.map((h) => h.messageId), kind: 'hits' } : { ids: (rows?.rows ?? []).map((r) => r.channelId), kind: 'rows' };

  const moveBy = (delta: 1 | -1): void => {
    if (showing.kind === 'hits' && search) {
      const at = sel?.focus ?? null;
      const id = step(showing.ids, at, delta);
      const hit = search.hits.find((h) => h.messageId === id);
      if (!hit) return;
      if (!narrow) open({ channelId: hit.channelId, lane: hit.lane, focus: hit.messageId });
      listRef.current?.querySelector<HTMLElement>(`[data-message="${hit.messageId}"]`)?.focus();
      return;
    }
    const id = step(showing.ids, sel?.channelId ?? (document.activeElement as HTMLElement | null)?.dataset?.['channel'] ?? null, delta);
    if (!id) return;
    if (!narrow) open({ channelId: id, lane, focus: null });
    listRef.current?.querySelector<HTMLElement>(`[data-channel="${id}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    const typing = t.closest('input, textarea, select, [contenteditable="true"]') !== null;
    if (e.key === 'Escape') {
      if (keys) return;
      if (typing && t === searchRef.current && q) {
        setQ('');
      } else if (narrow && sel) {
        const back = sel.channelId;
        setSel(null);
        window.setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-channel="${back}"]`)?.focus(), 0);
      } else if (setup) {
        setSetup(false);
      } else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (typing || keys) return;
    if (e.key === 'j' || e.key === 'k') moveBy(e.key === 'j' ? 1 : -1);
    else if (e.key === '/') searchRef.current?.focus();
    else if (e.key === '?') setKeys(true);
    else if (e.key === 'r' && sel) composeRef.current?.focus();
    else if (e.key === 'e' && sel && !['requests', 'spam', 'trash'].includes(sel.lane)) {
      const s = sel;
      const title = rowTitle(rowsRef.current.find((r) => r.channelId === s.channelId) ?? { title: '', contacts: [], kind: 'direct' });
      void client.done(s.channelId, s.lane, true).then(
        () => {
          say({ text: `${W.done}: ${title}`, undo: () => void client.done(s.channelId, s.lane, false).then(() => bump('list')) });
          bump('list');
          leave(s.channelId);
        },
        () => say({ text: W.failed }),
      );
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** After a conversation leaves the lane: the next one opens (with columns), or the list comes back (one column). */
  const leave = (channelId: string): void => {
    const ids = rowsRef.current.map((r) => r.channelId);
    const i = ids.indexOf(channelId);
    const next = ids[i + 1] ?? ids[i - 1] ?? null;
    if (narrow || !next || next === channelId) setSel(null);
    else open({ channelId: next, lane, focus: null });
    // The keyboard stays in Courier: on the next conversation's row, else the list.
    window.setTimeout(() => {
      const row = next ? listRef.current?.querySelector<HTMLElement>(`[data-channel="${next}"]`) : null;
      (row ?? listRef.current?.querySelector<HTMLElement>('#courier-lane-h') ?? root.current)?.focus();
    }, 0);
  };

  const words = stateWords(status, error);
  if (words) {
    return (
      <div className="courier-root courier-center" data-testid="courier-body" data-state="refused" ref={root}>
        <div className="courier-empty">
          <h3>{words}</h3>
          {error && error.code !== 'old' && error.code !== 'forbidden' && (
            <button type="button" className="courier-btn" onClick={() => bump('status')}>
              {W.tryAgain}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="courier-root courier-center" data-testid="courier-body" aria-busy="true" ref={root}>
        <p className="courier-quiet">{W.loading}</p>
      </div>
    );
  }

  // This desk in the registry, and the member's other desks (for the shared-stem note).
  const mine = registry?.enabled ? (registry.desks.find((d) => d.deskId === deskId) ?? null) : null;
  const others = registry?.enabled ? registry.desks.filter((d) => d.deskId !== deskId) : [];
  const address: DeskAddress | null = mine?.address ?? null;
  // The first time Courier opens on a desk with no address: one centred card, until the member picks a name or says Later.
  if (mine && registry && !address && (choosing || !later)) {
    return (
        <ChooseAddress
          rootRef={root}
          desk={mine}
          domain={registry.domain}
          others={others}
          narrow={narrow}
          onLater={() => {
            sayLater(deskId);
            setLater(true);
            setChoosing(false);
          }}
          onDone={(a) => {
            setRegistry({ ...registry, desks: registry.desks.map((d) => (d.deskId === deskId ? { ...d, address: a } : d)) });
            setChoosing(false);
            setSetup(false);
            setSel(null);
            setSide({ kind: 'share', after: true });
            say({ text: W.addrDone(a.address) });
          }}
        />
    );
  }

  const showSide = side !== null && !setup;
  const showThread = sel !== null && !setup && !showSide;
  const rightShown = setup || showSide || showThread;
  // Three columns: lanes, list, conversation. Two: the lanes above the list. One: the list, or what's beside it.
  const showList = !narrow || !rightShown;
  const listId = 'courier-list';
  const linked = accounts.filter((a) => a.kind !== 'desk');
  // The line at the foot shows in the pane that acted (the Designer's call 3), or in the one that's there.
  const footIn: 'list' | 'side' | null = !foot ? null : foot.where === 'list' ? (showList ? 'list' : 'side') : rightShown ? 'side' : 'list';
  const footNode = (where: 'list' | 'side') =>
    foot && footIn === where ? (
      <div className="courier-foot-wrap">
        <FootLine foot={foot} onGone={() => setFoot(null)} />
      </div>
    ) : null;
  const linksOn = suggestions !== null;
  const peopleNote = lane === 'people' && !search && suggestions && suggestions.length > 0 ? suggestions : null;

  const lanesNav = (
    <nav className="courier-lanes" aria-label={W.lanesLabel} data-row={cols < 3 || undefined}>
      <ul>
        {LANES.map((l) => {
          const c = status.lanes[l];
          // Only Requests counts (the Designer's call 2, Nov 14); People shows the accent dot when anything is unread.
          const n = l === 'requests' ? c.count : 0;
          const dot = l === 'people' && c.unread > 0;
          return (
            <li key={l}>
              <button type="button" className="courier-lane" aria-current={lane === l && !setup && !showSide ? 'page' : undefined} onClick={() => pickLane(l)}>
                <Icon name={LANE_ICON[l]} />
                <span className="courier-lane-name">
                  {LANE_WORDS[l]}
                  {n > 0 && <span className="courier-sr">{W.requestCount(n)}</span>}
                  {dot && <span className="courier-sr">{W.unreadLane}</span>}
                </span>
                {n > 0 && (
                  <span className="courier-count" aria-hidden="true">
                    {count(n)}
                  </span>
                )}
                {dot && <span className="courier-dot" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="courier-lanes-foot">
        <button type="button" className="courier-lane" aria-current={setup ? 'page' : undefined} onClick={() => {
            setSide(null);
            setSetup(true);
          }}>
          <Icon name="at" />
          <span className="courier-lane-name">{W.accounts}</span>
        </button>
        <button type="button" className="courier-icon-btn" onClick={() => setKeys(true)} aria-label={W.keys} title={W.keys}>
          <Icon name="keys" />
        </button>
      </div>
    </nav>
  );

  const rowsNow = rows?.lane === lane ? rows : null;
  const thePerson = side?.kind === 'person' ? side.contactId : null;
  return (
    <div className="courier-root" data-testid="courier-body" tabIndex={-1} data-cols={cols} data-view={setup ? 'setup' : showSide ? side.kind : showThread ? 'thread' : 'list'} ref={root} onKeyDown={onKeyDown}>
      {cols === 3 && lanesNav}
      {showList && (
        <section className="courier-listpane" aria-labelledby="courier-lane-h" ref={listRef}>
          {cols < 3 && lanesNav}
          <div className="courier-listhead">
            <h2 id="courier-lane-h" tabIndex={-1}>
              {search ? W.search : LANE_WORDS[lane]}
            </h2>
            <div className="courier-search" role="search">
              <Icon name="search" />
              <input
                ref={searchRef}
                type="search"
                aria-label={W.search}
                aria-describedby="courier-search-hint"
                placeholder={W.search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-controls={listId}
              />
              {q && (
                <button type="button" className="courier-icon-btn sm" onClick={() => {
                    setQ('');
                    searchRef.current?.focus();
                  }} aria-label={W.searchClear} title={W.searchClear}>
                  <Icon name="close" />
                </button>
              )}
            </div>
            <p id="courier-search-hint" className="courier-sr">
              {W.searchHint}
            </p>
            {!search && linked.length > 0 && (
              <label className="courier-account-filter">
                <span>{W.accountFilter}</span>
                <select value={account ?? ''} onChange={(e) => setAccount(e.target.value || null)}>
                  <option value="">{W.allAccounts}</option>
                  {accounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.label || a.address}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!search && <p className="courier-lane-line">{LANE_LINE[lane]}</p>}
            {!search && status.pending > 0 && <p className="courier-quiet">{W.pendingCount(status.pending)}</p>}
          </div>
          <div className="courier-list-scroll" id={listId}>
            {peopleNote && (
              <LinkNote
                n={peopleNote.length}
                onReview={() => {
                  setSetup(false);
                  setSel(null);
                  setSide({ kind: 'review' });
                }}
              />
            )}
            {search ? (
              <>
                <p className="courier-quiet" role="status">
                  {search.busy ? W.searching : search.error ?? (search.hits.length ? W.results(search.hits.length, !!search.next) : W.searchNone)}
                </p>
                <ul className="courier-rows" aria-label={W.search}>
                  {search.hits.map((h) => (
                    <HitButton key={h.messageId} hit={h} now={now} selected={sel?.focus === h.messageId} onOpen={() => open({ channelId: h.channelId, lane: h.lane, focus: h.messageId })} />
                  ))}
                </ul>
              </>
            ) : !rowsNow ? (
              <p className="courier-quiet">{W.loading}</p>
            ) : rowsNow.rows.length === 0 ? (
              <p className="courier-empty-line">{EMPTY[lane]}</p>
            ) : lane === 'requests' ? (
              <ul className="courier-requests" aria-label={LANE_WORDS.requests}>
                {rowsNow.rows.map((r) => (
                  <RequestCard
                    key={r.channelId}
                    row={r}
                    now={now}
                    selected={sel?.channelId === r.channelId}
                    onOpen={() => open({ channelId: r.channelId, lane, focus: null })}
                    onDecide={(d) => decide(r, d)}
                    suggestion={suggestionFor(suggestions, personOf(r)?.endpoint)}
                    onLink={(sg) => void linkSuggestion(sg, 'list')}
                    onNot={(sg) => notThem(sg, 'list')}
                    onReport={() => reportRequest(r)}
                  />
                ))}
              </ul>
            ) : (
              <ul className="courier-rows" aria-label={LANE_WORDS[lane]}>
                {rowsNow.rows.map((r) => (
                  <RowButton key={r.channelId} row={r} now={now} selected={sel?.channelId === r.channelId} onOpen={() => open({ channelId: r.channelId, lane, focus: null })} drag={linksOn ? dragFor(r) : undefined} />
                ))}
              </ul>
            )}
            {!search && rowsNow?.next && (
              <button
                type="button"
                className="courier-btn quiet courier-more"
                onClick={() =>
                  void client.list({ lane, accountId: account, before: rowsNow.next }).then(
                    (r) => setRows((o) => (o && o.lane === lane ? { lane, rows: [...o.rows, ...r.rows], next: r.next } : o)),
                    () => say({ text: W.failed }, 'list'),
                  )
                }
              >
                {W.more}
              </button>
            )}
            {!search && lane === 'trash' && rowsNow && rowsNow.rows.length > 0 && (
              <div className="courier-more">
                <ConfirmButton
                  label={W.emptyTrash}
                  ask={W.emptyTrashAsk}
                  onConfirm={() =>
                    void client.emptyTrash().then(
                      () => {
                        say({ text: EMPTY.trash }, 'list');
                        bump('list');
                      },
                      () => say({ text: W.failed }, 'list'),
                    )
                  }
                />
              </div>
            )}
          </div>
          {footNode('list')}
        </section>
      )}
      {setup ? (
        <Setup
          client={client}
          reload={ticks.accounts}
          narrow={narrow}
          onClose={() => setSetup(false)}
          address={registry === undefined ? undefined : registry?.enabled ? { address, onShare: () => {
                setSetup(false);
                setSide({ kind: 'share', after: false });
              }, onChoose: () => setChoosing(true) } : null}
          onChanged={(f) => {
            say(f);
            bump('accounts');
            bump('status');
            bump('list');
          }}
          foot={footNode('side')}
        />
      ) : showSide && side.kind === 'share' && address ? (
        <ShareAddress
          address={address}
          fingerprint={fingerprint}
          displayName={displayName}
          narrow={narrow}
          after={side.after}
          onBack={() => {
            setSide(null);
            if (!side.after) setSetup(true);
          }}
          onDone={() => setSide(null)}
          say={(f) => say(f)}
          foot={footNode('side')}
        />
      ) : showSide && side.kind === 'invite' ? (
        <InviteCard
          key={side.problem?.kind ?? 'add'}
          invite={side.invite}
          domain={registry?.domain ?? null}
          deskName={mine?.name || useDeskStore.getState().desks.find((d) => d.id === deskId)?.name || ''}
          problem={side.problem ?? null}
          client={client}
          onNotNow={() => setSide(null)}
          onAdd={(n) => addInvited(side.invite, n)}
          onCompare={compareInvited}
          onChecked={(f) => {
            // The new key is checked: the Add goes through now, and their conversation opens.
            say(f);
            addInvited(side.invite, side.displayName ?? side.invite.displayName);
          }}
          copy={(t) => copyText(t, W.copied, (f) => say(f))}
          foot={footNode('side')}
        />
      ) : showSide && side.kind === 'review' ? (
        <LinkReview
          list={suggestions ?? []}
          onBack={() => setSide(null)}
          onLink={(sg) => void linkSuggestion(sg)}
          onNot={(sg) => notThem(sg)}
          onLinkCards={(list) => {
            // One press for the rows a contact card backs; each is its own link, so each is its own row in the desk's record.
            void Promise.all(list.map((sg) => client.link({ into: sg.into.contactId, endpoint: sg.endpoint }).then(() => true, () => false))).then((done) => {
              const n = done.filter(Boolean).length;
              say({ text: n === list.length ? W.linkDone(list.map((x) => x.into.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')) : W.failed });
              bump('all');
            });
          }}
          foot={footNode('side')}
        />
      ) : showSide && thePerson ? (
        <PersonPane
          key={thePerson}
          client={client}
          contactId={thePerson}
          domain={registry?.domain ?? null}
          reload={ticks.list + ticks.thread}
          linksOn={linksOn}
          now={now}
          onBack={() => setSide(null)}
          onKeys={(f) => {
            say(f);
            bump('all');
          }}
          copy={(t) => copyText(t, W.copied, (f) => say(f))}
          onAdd={(person: Person, e: Endpoint) =>
            client.link({ into: person.contactId, endpoint: e }).then(
              (r) => {
                const name = person.name.trim() || person.endpoints[0]?.value || '';
                say({ text: W.linkDone(name), ...(r.linkId ? { undo: () => void client.undoLink(r.linkId!).then(() => bump('all'), () => say({ text: W.failed })) } : {}) });
                if (sel) setJustLinked((s) => new Set(s).add(sel.channelId));
                bump('all');
                return true;
              },
              (err) => {
                failLink(err);
                return false;
              },
            )
          }
          onUnlink={(person: Person, e: Endpoint) =>
            void client.unlink(e).then(
              () => {
                // One press; the line at the foot gives it back (p13). Nothing is deleted.
                say({ text: W.unlinked(e.value), undo: () => void client.link({ into: person.contactId, endpoint: e }).then(() => bump('all'), () => say({ text: W.failed })) });
                bump('all');
              },
              (err) => failLink(err),
            )
          }
          foot={footNode('side')}
        />
      ) : showThread && sel ? (
        <ThreadPane
          key={sel.channelId}
          client={client}
          channelId={sel.channelId}
          lane={sel.lane}
          reload={ticks.thread}
          focusMessageId={sel.focus}
          now={now}
          narrow={narrow}
          offline={offline}
          links={links}
          composeRef={composeRef}
          foot={footNode('side')}
          suggestions={suggestions}
          justLinked={justLinked.has(sel.channelId)}
          onSent={() => setJustLinked((s) => {
              if (!s.has(sel.channelId)) return s;
              const n = new Set(s);
              n.delete(sel.channelId);
              return n;
            })}
          onLinkSuggestion={(sg) => void linkSuggestion(sg)}
          onNotThem={(sg) => notThem(sg)}
          onOpenPerson={(contactId) => setSide({ kind: 'person', contactId })}
          copy={(t) => copyText(t, W.copied, (f) => say(f))}
          onLinkTo={linksOn ? (title, contactId) => setSheet({ title, contactId, channelId: sel.channelId }) : undefined}
          dropping={dragFrom !== null && dragFrom.channelId !== sel.channelId ? dragFrom : null}
          onDropPerson={(into) => {
            const from = dragFrom ? personOf(dragFrom) : null;
            const fromChannel = dragFrom?.channelId ?? null;
            setDragFrom(null);
            setDropOn(null);
            if (from && from.contactId !== into.contactId) linkPerson({ contactId: from.contactId, channelId: fromChannel }, into, 'side');
          }}
          onBack={() => {
            const back = sel.channelId;
            setSel(null);
            window.setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-channel="${back}"]`)?.focus(), 0);
          }}
          onChanged={(f) => {
            if (f) say(f);
            bump('list');
            bump('status');
            bump('thread');
          }}
          onLeft={() => leave(sel.channelId)}
        />
      ) : (
        !narrow && (
          <div className="courier-thread courier-center" data-testid="courier-pick">
            <p className="courier-quiet">{W.pick}</p>
            {footNode('side')}
          </div>
        )
      )}
      {sheet && (
        <LinkSheet
          client={client}
          title={sheet.title}
          exclude={sheet.contactId}
          narrow={narrow}
          onClose={() => setSheet(null)}
          onPick={(p) => {
            const s0 = sheet;
            setSheet(null);
            linkPerson({ contactId: s0.contactId, channelId: s0.channelId }, { contactId: p.contactId, name: p.name.trim() || p.endpoints[0]?.value || '' }, rightShown ? 'side' : 'list');
          }}
        />
      )}
      {keys && <KeysHelp onClose={() => setKeys(false)} />}
    </div>
  );
}
