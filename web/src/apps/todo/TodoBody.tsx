// The To-do window's lazy chunk (look A, Focus, the design's default: one calm column of cards). Needs you opens first: only
// what's overdue, due today or kept there, five at most, then one quiet line for what agents added and what they ask you to
// confirm. All groups every open to-do by its day, with search and a filter by who made it or where it came from; Done is the
// archive, by the day each closed, with Reopen; Trash keeps a deleted to-do 30 days. "All desks" puts the member's desks' lists
// together here in the browser, never on a server. Every change has Undo. Nothing here wakes a desk by itself.
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HostedBodyProps } from '../../agent/AgentWindow';
import { useRosterStore } from '../../agent/roster';
import { isAgentApp } from '../../canvas/layout';
import { useDeskLink, useLive, wakeDesk } from '../../desk/liveStore';
import { isGuildPanel } from '../../guild/panel';
import { openInDeskBrowser } from '../../notebook/openLink';
import { openItem } from '../../shell/actions';
import { useLayoutPrefs } from '../../shell/layoutPrefs';
import { setLayoutPref } from '../../shell/layoutSync';
import { useDeskStore } from '../../state/deskStore';
import { useLayoutStore } from '../../state/layoutStore';
import { reasonOf, toTodoError, type Item, type TodoClient } from './client';
import { useFeed, type Feed } from './feed';
import { ItemSheet, type SheetActions } from './ItemSheet';
import { addDays, agentOf, dayIn, groupDone, groupOpen, longDate, makerName, mergeNeedsYou, snoozeChoices, snoozeUntilDay, type Group } from './model';
import { AddRow, Card, Icon, Menu, Row, UndoLine, type Ctx, type Located, type MenuItem } from './parts';
import { browserZone } from './wire';
import { elseParts, elseWords, footerParts, moreWords, W } from './words';
import { noteFocusEvent, setFocusItem } from '../../state/focusItems';
import './todo.css';

type View = 'needs' | 'all' | 'done' | 'trash';
const VIEWS: { key: Exclude<View, 'trash'>; label: string }[] = [
  { key: 'needs', label: W.needsYou },
  { key: 'all', label: W.all },
  { key: 'done', label: W.done },
];

/** The pref in the layout document's `prefs` that turns the tile's count off (on unless it's `false`). */
export const TILE_COUNT_PREF = 'todoTileCount';

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

function usePhone(): boolean {
  const q = '(max-width: 599.98px)';
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(q);
    const on = (): void => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

/** One desk's feed, reported up. A component per desk, so each has its own hooks however many desks there are. */
function DeskFeed({ deskId, idem, wants, onFeed }: { deskId: string; idem: () => string; wants: { done: boolean; trash: boolean }; onFeed(f: Feed): void }) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const feed = useFeed(deskId, link, live.link === 'open' && link !== null, idem, wants);
  const report = useRef(onFeed);
  report.current = onFeed;
  useEffect(() => {
    report.current(feed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.state, feed.client, feed.needs, feed.open, feed.summary, feed.done, feed.trash]);
  return null;
}

/** A sleeping desk in All desks: one line, and the member's own press to open it. */
function AsleepLine({ deskId, name }: { deskId: string; name: string }) {
  const live = useLive(deskId);
  if (live.link === 'open') return null;
  return (
    <p className="todo-asleep" data-desk={deskId}>
      <span>{W.asleep(name)}</span>
      <button type="button" className="todo-link" onClick={() => wakeDesk(deskId)}>
        {W.openIt}
      </button>
    </p>
  );
}

/** Snooze to a day the member picks: a small labelled form at the foot, 9 am that day in the desk's zone. */
function PickDay({ min, title, onPick, onCancel }: { min: string; title: string; onPick(day: string): void; onCancel(): void }) {
  const [day, setDay] = useState('');
  const id = useId();
  return (
    <form
      className="todo-pickday"
      aria-label={`${W.snooze}: ${title}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (day) onPick(day);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label htmlFor={id}>Snooze until</label>
      <input id={id} type="date" className="todo-field todo-date" min={min} value={day} onChange={(e) => setDay(e.target.value)} autoFocus />
      <button type="submit" className="todo-btn primary" disabled={!day}>
        {W.snooze}
      </button>
      <button type="button" className="todo-btn" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

interface Toast {
  key: number;
  text: string;
  undo?: () => void;
}

export default function TodoBody({ deskId, deskName, link, offline, shell }: HostedBodyProps) {
  const phone = usePhone();
  const now = useNow(60_000);
  const allDesksList = useDeskStore((s) => s.desks);
  const ownDesks = useMemo(() => allDesksList.filter((d) => !isGuildPanel(d.id) && d.kind !== 'guild').map((d) => ({ id: d.id, name: d.name })), [allDesksList]);
  const [scope, setScope] = useState<'desk' | 'all'>('desk');
  const multi = ownDesks.length > 1 && ownDesks.some((d) => d.id === deskId);
  const inScope = scope === 'all' && multi ? ownDesks : [{ id: deskId, name: deskName }];
  const [view, setView] = useState<View>('needs');
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [sheet, setSheet] = useState<{ deskId: string; id: string } | null>(null);
  const [menu, setMenu] = useState<{ kind: 'snooze' | 'more'; anchor: HTMLElement; deskId?: string; item?: Item } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('everyone');
  const [addTo, setAddTo] = useState(deskId);
  const [adding, setAdding] = useState(false);
  const [foldSnoozed, setFoldSnoozed] = useState(true);
  const tileCount = useLayoutPrefs((s) => s[TILE_COUNT_PREF] !== false);
  const roster = useRosterStore((s) => s.desks);
  const tabsId = useId();
  const [pickFor, setPickFor] = useState<{ deskId: string; item: Item } | null>(null);
  const { announce, idem } = shell;
  void link;

  const onFeed = useCallback((f: Feed) => setFeeds((all) => (all[f.deskId] === f ? all : { ...all, [f.deskId]: f })), []);
  const wants = useMemo(() => ({ done: view === 'done', trash: view === 'trash' }), [view]);

  const feedsIn = inScope.map((d) => feeds[d.id]).filter((f): f is Feed => !!f);
  const own = feeds[deskId];
  const tzOf = useCallback((id: string): string => feeds[id]?.summary?.zone ?? feeds[id]?.needs?.zone ?? browserZone(), [feeds]);
  const todayOf = useCallback((id: string): string => feeds[id]?.needs?.today || feeds[id]?.summary?.today || dayIn(now, tzOf(id)), [feeds, now, tzOf]);
  const clientOf = (id: string): TodoClient | null => feeds[id]?.client ?? null;

  // Unseen when this window first showed them: they keep their "New" for as long as it's open.
  const fresh = useRef(new Set<string>());
  const seenAsked = useRef(new Set<string>());

  const say = useCallback(
    (text: string, undo?: () => void) => {
      announce(text);
      setToast({ key: Date.now(), text, ...(undo ? { undo } : {}) });
    },
    [announce],
  );

  const failed = useCallback(
    (e: unknown) => {
      const x = toTodoError(e);
      const r = reasonOf(x);
      say(x.code === 'cap' ? W.cap : x.code === 'not_found' ? W.gone : x.code === 'bad_request' && r === 'title' ? W.tooLong : x.code === 'conflict' && r === 'changed' ? W.changedSince : x.code === 'old' ? W.oldDesk : W.failed);
    },
    [say],
  );

  const run = useCallback(
    async (id: string, fn: (c: TodoClient) => Promise<unknown>, done?: { text: string; undo?: (c: TodoClient) => Promise<unknown> }): Promise<boolean> => {
      const c = clientOf(id);
      if (!c) {
        say(W.waiting);
        return false;
      }
      try {
        await fn(c);
        if (done) say(done.text, done.undo ? () => void done.undo!(c).catch(failed) : undefined);
        return true;
      } catch (e) {
        failed(e);
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feeds, say, failed],
  );

  const markDone = useCallback(
    (id: string, item: Item, as: 'done' | 'not_needed' = 'done') => {
      // A to-do checked: a completed action (the focus shield's fine break, once 5 s pass with no input after it).
      if (as === 'done') noteFocusEvent('todo_checked');
      setClosing((s) => new Set([...s, item.id]));
      void run(id, (c) => c.close(item.id, as), { text: `${as === 'done' ? 'Done' : 'Not needed'}: ${item.title}`, undo: (c) => c.reopen(item.id) }).finally(() =>
        setClosing((s) => {
          const n = new Set(s);
          n.delete(item.id);
          return n;
        }),
      );
    },
    [run],
  );

  const openSource = useCallback((id: string, item: Item) => {
    const ref = item.source.ref ?? {};
    const tiles = useLayoutStore.getState().desks[id]?.items ?? [];
    const tile = (app: string): string | undefined => tiles.find((t) => t.app === app)?.id;
    switch (item.source.kind) {
      case 'browser':
        if (typeof ref['url'] === 'string') openInDeskBrowser(id, ref['url']);
        return;
      case 'agent_chat': {
        const agent = typeof ref['agentId'] === 'string' ? ref['agentId'] : null;
        const t = tiles.find((x) => isAgentApp(x.app) && x.app === `agent:${agent}`)?.id ?? tile('agent');
        if (t) openItem(id, t);
        return;
      }
      case 'desk': {
        // A message from another of the member's desks lives in an agent's thread here; its ref doesn't say which.
        const t = tile('agent') ?? tiles.find((x) => isAgentApp(x.app))?.id;
        if (t) openItem(id, t);
        return;
      }
      default: {
        const t = tile(item.source.kind);
        if (t) openItem(id, t);
      }
    }
  }, []);

  const pin = useCallback((id: string, item: Item, on: boolean) => void run(id, (c) => c.pin(item.id, on), { text: on ? `Kept in Needs you: ${item.title}` : `Out of Needs you: ${item.title}`, undo: (c) => c.pin(item.id, !on) }), [run]);
  const snoozeTo = useCallback(
    (id: string, item: Item, until: number | null, label: string) => void run(id, (c) => c.snooze(item.id, until), { text: until ? `Snoozed until ${label}: ${item.title}` : `Back on your list: ${item.title}`, undo: (c) => c.snooze(item.id, null) }),
    [run],
  );

  const ctx: Ctx = useMemo(
    () => ({
      today: todayOf,
      tz: tzOf,
      now,
      phone,
      closing,
      deskLabel: (id) => (scope === 'all' && multi ? (ownDesks.find((d) => d.id === id)?.name ?? null) : null),
      maker: (id, item) => makerName(item.by, (roster[id] ?? []).find((a) => a.id === agentOf(item.by))?.name ?? null, item.byName),
      who: (id, item, actor) => makerName(actor, (roster[id] ?? []).find((a) => a.id === agentOf(actor))?.name ?? null, actor === item.by ? item.byName : null),
      isNew: (id) => fresh.current.has(id),
      onDone: (id, item) => markDone(id, item),
      onOpen: (id, item) => setSheet({ deskId: id, id: item.id }),
      onOpenSource: openSource,
      onSnooze: (id, item, at) => setMenu({ kind: 'snooze', anchor: at, deskId: id, item }),
      onAnswer: (id, item, accept) => void run(id, (c) => c.answer(item.id, accept), accept ? { text: `${item.suggestion?.as === 'not_needed' ? 'Not needed' : 'Done'}: ${item.title}`, undo: (c) => c.reopen(item.id) } : { text: `Kept on your list: ${item.title}` }),
    }),
    [todayOf, tzOf, now, phone, closing, scope, multi, ownDesks, roster, markDone, openSource, run],
  );

  // What's shown.
  const needs = useMemo(
    () => mergeNeedsYou(feedsIn.filter((f) => f.needs).map((f) => ({ deskId: f.deskId, items: f.needs!.items.filter((i) => !closing.has(i.id)), more: f.needs!.more, newFromAgents: f.needs!.newFromAgents, toConfirm: f.needs!.toConfirm, today: todayOf(f.deskId) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feeds, scope, closing, todayOf],
  );
  const openItems: Located[] = useMemo(() => feedsIn.flatMap((f) => (f.open ?? []).map((i) => ({ ...i, deskId: f.deskId }))), [feeds, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  // The counts: Needs you and open from each desk's summary; the rest from the open list's groups (deskd's `group`).
  const sum = useMemo(() => {
    const s = { needsYou: 0, open: 0, comingUp: 0, noDate: 0, snoozed: 0 };
    for (const f of feedsIn) {
      s.needsYou += f.summary?.needsYou ?? 0;
      s.open += f.summary?.open ?? f.open?.length ?? 0;
      for (const i of f.open ?? []) {
        if (i.group === 'upcoming') s.comingUp += 1;
        else if (i.group === 'snoozed') s.snoozed += 1;
        else if (i.group === 'no_date' && !i.pinned) s.noDate += 1;
      }
    }
    return s;
  }, [feeds, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const toConfirm = openItems.filter((i) => i.suggestion && !closing.has(i.id));
  const shownIds = new Set(needs.items.map((i) => i.id));
  const newItems = openItems.filter((i) => i.by !== 'member' && !i.seen && !shownIds.has(i.id) && !closing.has(i.id) && !(i.snoozedUntil && i.snoozedUntil > now));

  // Agents that made something here, for the All view's filter.
  const makers = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of openItems) if (i.by !== 'member') m.set(i.by, ctx.maker(i.deskId, i));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [openItems, ctx]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return openItems.filter((i) => {
      if (closing.has(i.id)) return false;
      if (filter === 'courier' && i.source.kind !== 'courier') return false;
      if (filter === 'member' && i.by !== 'member') return false;
      if (filter.startsWith('agent:') && i.by !== filter) return false;
      return !needle || i.title.toLowerCase().includes(needle) || (i.note ?? '').toLowerCase().includes(needle) || i.source.label.toLowerCase().includes(needle);
    });
  }, [openItems, q, filter, closing]);
  const ownToday = todayOf(deskId);
  const groups: Group<Located>[] = useMemo(() => groupOpen(filtered, ownToday, now, tzOf(deskId)), [filtered, ownToday, now, tzOf, deskId]);
  const doneItems: Located[] = feedsIn.flatMap((f) => (f.done ?? []).map((i) => ({ ...i, deskId: f.deskId })));
  const trashItems: Located[] = feedsIn.flatMap((f) => (f.trash ?? []).map((i) => ({ ...i, deskId: f.deskId })));

  // An agent's day, under its filter: what it added, changed and asked to close today.
  const agentDay = useMemo(() => {
    if (!filter.startsWith('agent:')) return null;
    const on = (ms: number | null, id: string): boolean => !!ms && dayIn(ms, tzOf(id)) === todayOf(id);
    return {
      added: openItems.filter((i) => i.by === filter && on(i.createdAt, i.deskId)).length,
      asked: openItems.filter((i) => i.suggestion?.by === filter && on(i.suggestion.at, i.deskId)).length,
    };
  }, [filter, openItems, tzOf, todayOf]);

  // "New": noted when first shown, then told to the desk a moment later (the design's `seen_at`).
  const visible: Located[] = view === 'needs' ? [...needs.items, ...(showNew ? newItems : []), ...toConfirm] : view === 'all' ? filtered : [];
  for (const i of visible) if (i.by !== 'member' && !i.seen) fresh.current.add(i.id);
  const unseenKey = visible
    .filter((i) => i.by !== 'member' && !i.seen && !seenAsked.current.has(i.id))
    .map((i) => `${i.deskId}|${i.id}`)
    .join(',');
  useEffect(() => {
    if (!unseenKey || offline) return;
    const t = window.setTimeout(() => {
      const byDesk = new Map<string, string[]>();
      for (const k of unseenKey.split(',')) {
        const [d = '', id = ''] = k.split('|');
        seenAsked.current.add(id);
        byDesk.set(d, [...(byDesk.get(d) ?? []), id]);
      }
      for (const [d, ids] of byDesk) void clientOf(d)?.seen(ids);
    }, 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenKey, offline]);

  const add = async (title: string, day: 'today' | 'tomorrow' | null): Promise<boolean> => {
    const target = scope === 'all' && multi ? addTo : deskId;
    const t = title.replace(/[\r\n\t]+/g, ' ').trim();
    if (!t) return false;
    setAdding(true);
    const today = todayOf(target);
    const due = day === 'today' ? { date: today } : day === 'tomorrow' ? { date: addDays(today, 1) } : null;
    const ok = await run(target, (c) => c.add(t, due), { text: `Added: ${t}` });
    setAdding(false);
    return ok;
  };

  const exportAs = async (format: 'md' | 'json'): Promise<void> => {
    const c = clientOf(deskId);
    if (!c) return say(W.waiting);
    try {
      const f = await c.exportFile(format);
      const url = URL.createObjectURL(new Blob([f.bytes.slice().buffer], { type: f.type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `To-do ${deskName.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'desk'}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say(W.exported);
    } catch {
      say(W.exportFailed);
    }
  };

  const tabKeys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const keys = VIEWS.map((v) => v.key);
    const at = keys.indexOf(view === 'trash' ? 'done' : view);
    const go = (n: number): void => {
      const next = keys[(n + keys.length) % keys.length]!;
      setView(next);
      (e.currentTarget.querySelector(`[data-view="${next}"]`) as HTMLElement | null)?.focus();
    };
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(keys.length - 1);
    else return;
    e.preventDefault();
  };

  // The to-do open in its sheet, for Desk Maia's model of now (the focus shield): its id only, under this window's desk.
  const openId = sheet?.id ?? null;
  useEffect(() => {
    setFocusItem(deskId, 'todo', openId ? { kind: 'todo', id: openId } : null);
    return () => setFocusItem(deskId, 'todo', null);
  }, [deskId, openId]);
  const state = own?.state ?? 'idle';
  const sheetFeed = sheet ? feeds[sheet.deskId] : null;
  const sheetItem = sheet ? ([...(sheetFeed?.open ?? []), ...(sheetFeed?.done ?? []), ...(sheetFeed?.trash ?? []), ...(sheetFeed?.needs?.items ?? [])].find((i) => i.id === sheet.id) ?? null) : null;
  const sheetActions: SheetActions | null = sheet
    ? {
        done: (it, as) => {
          setSheet(null);
          markDone(sheet.deskId, it, as);
        },
        reopen: (it) => void run(sheet.deskId, (c) => c.reopen(it.id), { text: `Reopened: ${it.title}`, undo: (c) => c.close(it.id, it.state === 'not_needed' ? 'not_needed' : 'done') }),
        trash: (it) => {
          setSheet(null);
          void run(sheet.deskId, (c) => c.trash(it.id), { text: `Deleted: ${it.title}`, undo: (c) => c.restore(it.id) });
        },
        restore: (it) => void run(sheet.deskId, (c) => c.restore(it.id), { text: `Restored: ${it.title}`, undo: (c) => c.trash(it.id) }),
        snooze: (it, at) => setMenu({ kind: 'snooze', anchor: at, deskId: sheet.deskId, item: it }),
        unsnooze: (it) => snoozeTo(sheet.deskId, it, null, ''),
        pin: (it, on) => pin(sheet.deskId, it, on),
        answer: (it, accept) => ctx.onAnswer(sheet.deskId, it, accept),
        openSource: (it) => openSource(sheet.deskId, it),
        say: (t) => say(t),
      }
    : null;

  const moreItems: MenuItem[] = [
    { key: 'md', label: W.exportMd, onPick: () => void exportAs('md') },
    { key: 'json', label: W.exportJson, onPick: () => void exportAs('json') },
    { key: 'count', label: W.tileCount, checked: tileCount, onPick: () => setLayoutPref({ [TILE_COUNT_PREF]: !tileCount }) },
    { key: 'trash', label: W.trash, onPick: () => setView('trash') },
  ];
  const snoozeItems: MenuItem[] =
    menu?.kind === 'snooze' && menu.item && menu.deskId
      ? [
          ...snoozeChoices(now, tzOf(menu.deskId)).map((c) => ({ key: c.key, label: c.label, onPick: () => snoozeTo(menu.deskId!, menu.item!, c.until, c.label.replace(/^Later today, /, '')) })),
          {
            key: 'pick',
            label: `${W.pickDay}…`,
            onPick: () => setPickFor({ deskId: menu.deskId!, item: menu.item! }),
          },
        ]
      : [];

  const panelId = `${tabsId}-panel`;
  const viewKey = view === 'trash' ? 'done' : view;
  const fmt = (n: number): string => (n > 0 ? ` ${n}` : '');

  return (
    <div className="todo-root" data-testid="todo-body" data-view={view} data-phone={phone || undefined}>
      {inScope.map((d) => (
        <DeskFeed key={d.id} deskId={d.id} idem={idem} wants={wants} onFeed={onFeed} />
      ))}
      <div className="todo-top">
        <div className="todo-views" role="tablist" aria-label={W.name} onKeyDown={tabKeys}>
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              id={`${tabsId}-${v.key}`}
              data-view={v.key}
              aria-selected={viewKey === v.key}
              aria-controls={panelId}
              tabIndex={viewKey === v.key ? 0 : -1}
              className={viewKey === v.key ? 'on' : undefined}
              onClick={() => setView(v.key)}
            >
              {v.label}
              {v.key === 'needs' && sum.needsYou > 0 && <b>{sum.needsYou}</b>}
              {v.key === 'all' && <span className="todo-count">{fmt(sum.open)}</span>}
            </button>
          ))}
        </div>
        <span className="todo-top-end">
          {multi && (
            <select className="todo-scope" aria-label="Which desks" value={scope} onChange={(e) => setScope(e.target.value as 'desk' | 'all')}>
              <option value="desk">{W.thisDesk}</option>
              <option value="all">{W.allDesks}</option>
            </select>
          )}
          <button type="button" className="todo-icon-btn" aria-label={W.more} aria-haspopup="menu" aria-expanded={menu?.kind === 'more'} onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget })}>
            <Icon name="more" />
          </button>
        </span>
      </div>

      <AddRow onAdd={add} desks={scope === 'all' && multi ? ownDesks : []} deskId={addTo} onDesk={setAddTo} busy={adding || offline} />

      <div className="todo-scroll" role="tabpanel" id={panelId} aria-labelledby={`${tabsId}-${viewKey}`} tabIndex={-1}>
        {state === 'old' && <p className="todo-line">{W.oldDesk}</p>}
        {state === 'error' && (
          <p className="todo-line" role="alert">
            {W.readFailed}{' '}
            <button type="button" className="todo-link" onClick={() => own?.reload()}>
              {W.tryAgain}
            </button>
          </p>
        )}

        {view === 'needs' && (
          <section className="todo-needs" aria-labelledby={`${tabsId}-h`}>
            <h2 id={`${tabsId}-h`} className="todo-h2">
              {W.needsYou}
            </h2>
            <p className="todo-dateline">
              {longDate(ownToday)}
              {!phone && ` · ${W.needsYouLine}`}
            </p>
            {needs.items.length > 0 ? (
              <ul className="todo-cards" aria-label={W.needsYou}>
                {needs.items.map((i) => (
                  <Card key={i.id} item={i} deskId={i.deskId} ctx={ctx} />
                ))}
              </ul>
            ) : (
              state === 'ready' && <p className="todo-empty">{W.nothing}</p>
            )}
            {needs.more > 0 && (
              <button type="button" className="todo-link todo-more" onClick={() => setView('all')}>
                {moreWords(needs.more)}
              </button>
            )}
            {(newItems.length > 0 || toConfirm.length > 0) && (
              <div className="todo-quiet" data-testid="todo-quiet">
                <span className="todo-dot" aria-hidden="true" />
                <span>
                  {footerParts(newItems.length, toConfirm.length).map(([bold, rest], n) => (
                    <Fragment key={rest}>
                      {n > 0 && ' · '}
                      <b>{bold}</b>
                      {rest}
                    </Fragment>
                  ))}
                </span>
                {newItems.length > 0 && (
                  <button type="button" className="todo-link" aria-expanded={showNew} onClick={() => setShowNew(!showNew)}>
                    {showNew ? W.hide : W.show}
                    <span className="sr-only"> {W.newFromAgents.toLowerCase()}</span>
                  </button>
                )}
              </div>
            )}
            {showNew && newItems.length > 0 && (
              <section className="todo-sec" aria-labelledby={`${tabsId}-new`}>
                <h3 id={`${tabsId}-new`}>{W.newFromAgents}</h3>
                <ul className="todo-rows">
                  {newItems.map((i) => (
                    <Row key={i.id} item={i} deskId={i.deskId} ctx={ctx} />
                  ))}
                </ul>
              </section>
            )}
            {toConfirm.length > 0 && (
              <section className="todo-sec" aria-labelledby={`${tabsId}-confirm`}>
                <h3 id={`${tabsId}-confirm`}>{W.toConfirm}</h3>
                <ul className="todo-rows">
                  {toConfirm.map((i) => (
                    <Row key={i.id} item={i} deskId={i.deskId} ctx={ctx} />
                  ))}
                </ul>
              </section>
            )}
            {elseWords(sum) && (
              <p className="todo-else">
                <span>
                  {W.everythingElse}:{' '}
                  {elseParts(sum).map(([bold, rest], n) => (
                    <Fragment key={rest}>
                      {n > 0 && ' · '}
                      <span className="todo-else-n">
                        <b>{bold}</b>
                        {rest}
                      </span>
                    </Fragment>
                  ))}
                </span>
                <button type="button" className="todo-link" onClick={() => setView('all')}>
                  {W.all}
                  {fmt(sum.open)}
                </button>
              </p>
            )}
          </section>
        )}

        {view === 'all' && (
          <section className="todo-all" aria-label={W.all}>
            <div className="todo-tools">
              <span className="todo-search">
                <Icon name="search" />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && q) {
                      e.preventDefault();
                      setQ('');
                    }
                  }}
                  placeholder={W.search}
                  aria-label={W.search}
                />
              </span>
              <span className="todo-filters" role="group" aria-label="Show">
                {[
                  ['everyone', W.everyone],
                  ['courier', W.fromCourier],
                  ['member', 'You'],
                  ...makers,
                ].map(([k, label]) => (
                  <button key={k} type="button" className="todo-chip" aria-pressed={filter === k} onClick={() => setFilter(k!)}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
            {agentDay && (
              <p className="todo-agent-day" data-testid="todo-agent-day">
                Today: {agentDay.added} added · {agentDay.asked} asked to close
              </p>
            )}
            {groups.length === 0 && state === 'ready' && <p className="todo-empty">{q || filter !== 'everyone' ? W.nothingFound : W.nothingOpen}</p>}
            {groups.map((g) => (
              <section key={g.key} className="todo-sec" aria-labelledby={`${tabsId}-${g.key}`}>
                {g.folded ? (
                  <h3 id={`${tabsId}-${g.key}`}>
                    <button type="button" className="todo-fold" aria-expanded={!foldSnoozed} onClick={() => setFoldSnoozed(!foldSnoozed)}>
                      <Icon name="down" className={foldSnoozed ? 'folded' : undefined} />
                      {g.title} · {g.items.length}
                    </button>
                  </h3>
                ) : (
                  <h3 id={`${tabsId}-${g.key}`} className={g.key === 'overdue' || g.key === 'today' ? 'hot' : undefined}>
                    {g.title}
                  </h3>
                )}
                {!(g.folded && foldSnoozed) && (
                  <ul className="todo-rows">
                    {g.items.map((i) => (
                      <Row key={i.id} item={i} deskId={i.deskId} ctx={ctx} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </section>
        )}

        {view === 'done' && (
          <section className="todo-done" aria-label={W.done}>
            {doneItems.length === 0 && feedsIn.every((f) => f.done !== null) && <p className="todo-empty">{W.nothingDone}</p>}
            {groupDone(doneItems, ownToday, tzOf(deskId)).map((g) => (
              <section key={g.key} className="todo-sec" aria-labelledby={`${tabsId}-${g.key}`}>
                <h3 id={`${tabsId}-${g.key}`}>{g.title}</h3>
                <ul className="todo-rows">
                  {g.items.map((i) => (
                    <Row
                      key={i.id}
                      item={i}
                      deskId={i.deskId}
                      ctx={ctx}
                      right={
                        <span className="todo-row-end">
                          <span className="todo-closed-by">
                            {i.state === 'done' ? 'Done' : 'Not needed'}
                            {i.closed && i.closed.by !== 'member' ? ` · ${ctx.who(i.deskId, i, i.closed.by)}` : ''}
                          </span>
                          <button type="button" className="todo-btn" aria-label={`${W.reopen}: ${i.title}`} onClick={() => void run(i.deskId, (c) => c.reopen(i.id), { text: `Reopened: ${i.title}`, undo: (c) => c.close(i.id, i.state === 'not_needed' ? 'not_needed' : 'done') })}>
                            {W.reopen}
                          </button>
                        </span>
                      }
                    />
                  ))}
                </ul>
              </section>
            ))}
            <p className="todo-else">
              <button type="button" className="todo-link" onClick={() => setView('trash')}>
                <Icon name="trash" />
                {W.trash}
                {fmt(trashItems.length)}
              </button>
            </p>
          </section>
        )}

        {view === 'trash' && (
          <section className="todo-trash" aria-labelledby={`${tabsId}-trash`}>
            <h2 id={`${tabsId}-trash`} className="todo-h2">
              {W.trash}
            </h2>
            <p className="todo-dateline">{W.trashNote}</p>
            {trashItems.length === 0 && feedsIn.every((f) => f.trash !== null) && <p className="todo-empty">{W.nothingTrash}</p>}
            <ul className="todo-rows">
              {trashItems.map((i) => (
                <Row
                  key={i.id}
                  item={i}
                  deskId={i.deskId}
                  ctx={ctx}
                  right={
                    <button type="button" className="todo-btn" aria-label={`${W.restore}: ${i.title}`} onClick={() => void run(i.deskId, (c) => c.restore(i.id), { text: `Restored: ${i.title}`, undo: (c) => c.trash(i.id) })}>
                      {W.restore}
                    </button>
                  }
                />
              ))}
            </ul>
          </section>
        )}

        {scope === 'all' && multi && ownDesks.filter((d) => d.id !== deskId).map((d) => <AsleepLine key={d.id} deskId={d.id} name={d.name} />)}
      </div>

      {pickFor && <PickDay min={addDays(todayOf(pickFor.deskId), 1)} title={pickFor.item.title} onPick={(v) => (snoozeTo(pickFor.deskId, pickFor.item, snoozeUntilDay(v, tzOf(pickFor.deskId)), longDate(v)), setPickFor(null))} onCancel={() => setPickFor(null)} />}

      {toast && <UndoLine key={toast.key} text={toast.text} {...(toast.undo ? { onUndo: toast.undo } : {})} onGone={() => setToast(null)} />}

      {menu && <Menu items={menu.kind === 'more' ? moreItems : snoozeItems} anchor={menu.anchor} label={menu.kind === 'more' ? W.more : W.snooze} onClose={() => setMenu(null)} />}

      {sheet && sheetActions && <ItemSheet key={`${sheet.deskId}|${sheet.id}`} deskId={sheet.deskId} id={sheet.id} initial={sheetItem} client={clientOf(sheet.deskId)} ctx={ctx} actions={sheetActions} onClose={() => setSheet(null)} />}
    </div>
  );
}
