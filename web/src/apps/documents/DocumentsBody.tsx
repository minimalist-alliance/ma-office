// The Documents window's lazy chunk (the documents concept, Part 1 and §6.4, §10, §20; deskd API.md §25). One calm column: the
// places Needs you (with Maybe under its divider), Read later, Records and Working on, each item one line in code's words
// (`{who} · {what} · {reason}`), the desk's own order, and its "That's all for now." at the end. Chips teach the desk (Not now ·
// Not important · Sooner next time · Done), each with Undo. One question at a time. Search, then "Look inside documents", or the
// words handed to Maia. "All desks" puts the member's desks' lists together here in the browser, never on a server. An item
// opens the viewer in this window. Nothing here wakes a desk by itself.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HostedBodyProps } from '../../agent/AgentWindow';
import { useDeskLink, useLive, wakeDesk } from '../../desk/liveStore';
import { isGuildPanel } from '../../guild/panel';
import { askAgent, useAskableAgents } from '../../agent/ask';
import { AskAgent } from './AskAgent';
import { useLayoutPrefs } from '../../shell/layoutPrefs';
import { useDeskStore } from '../../state/deskStore';
import { toDocsError, type DocsClient } from './client';
import { useDocsFeed, type Feed } from './feed';
import { byPerson, CHIP_WORDS, chipsFor, itemParts, mergeHits, mergeLists, noteFor, placeCount, type Located } from './model';
import { takeDocTarget, useDocTargets } from './target';
import type { Chip, Doc, ListView, Place, Rule, TidyPreview } from './types';
import { Viewer } from './Viewer';
import { emptyWords, PLACES, placeLabel, W } from './words';
import './documents.css';

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
function DeskFeed({ deskId, idem, place, view, onFeed }: { deskId: string; idem: () => string; place: Place; view: ListView | null; onFeed(f: Feed): void }) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const want = useMemo(() => ({ place, view }), [place, view]);
  const feed = useDocsFeed(deskId, link, live.link === 'open' && link !== null, idem, want);
  const report = useRef(onFeed);
  report.current = onFeed;
  useEffect(() => {
    report.current(feed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.state, feed.client, feed.items, feed.counts, feed.end, feed.question, feed.changed]);
  return null;
}

/** A sleeping desk in All desks: one line, and the member's own press to open it. */
function AsleepLine({ deskId, name }: { deskId: string; name: string }) {
  const live = useLive(deskId);
  if (live.link === 'open') return null;
  return (
    <p className="docs-asleep" data-desk={deskId}>
      <span>{W.asleep(name)}</span>
      <button type="button" className="docs-link" onClick={() => wakeDesk(deskId)}>
        {W.openIt}
      </button>
    </p>
  );
}

function Icon({ name }: { name: 'search' | 'more' | 'close' }) {
  return (
    <svg className="docs-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'search' ? (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" />
        </>
      ) : name === 'more' ? (
        <>
          <circle cx="6" cy="12" r=".9" />
          <circle cx="12" cy="12" r=".9" />
          <circle cx="18" cy="12" r=".9" />
        </>
      ) : (
        <path d="M6 6l12 12M18 6L6 18" />
      )}
    </svg>
  );
}

interface ToastState {
  key: number;
  text: string;
  undo?: () => void;
}

function Toast({ t, onGone }: { t: ToastState; onGone(): void }) {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const timer = window.setTimeout(() => gone.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [t.key]);
  return (
    <div className="docs-toast" data-testid="docs-toast">
      <span>{t.text}</span>
      {t.undo && (
        <button
          type="button"
          className="docs-toast-undo"
          onClick={() => {
            t.undo?.();
            onGone();
          }}
        >
          {W.undo}
        </button>
      )}
    </div>
  );
}

function Item({ d, desk, onOpen, onTap, chips = true }: { d: Located; desk: string | null; onOpen(d: Located): void; onTap(d: Located, c: Chip): void; chips?: boolean }) {
  const p = itemParts(d);
  const note = noteFor(d);
  const line = [p.who, p.what].filter(Boolean).join(' · ');
  return (
    <li className="docs-item" data-doc={d.id} data-desk={d.deskId} data-new={d.state === 'new' || undefined}>
      <button type="button" className="docs-open" onClick={() => onOpen(d)}>
        <span className="docs-line">
          {p.who && <b>{p.who}</b>}
          {p.who && ' · '}
          <span>{p.what}</span>
          {p.reason && <span className="docs-why"> · {p.reason}</span>}
        </span>
        {(desk || d.matchedText) && (
          <span className="docs-meta">
            {desk && <span className="docs-desk">{W.onDesk(desk)}</span>}
            {d.matchedText && <span className="docs-inside">{W.matchedInside}</span>}
          </span>
        )}
        {note && (note.kind === 'sensitive' ? <span className="docs-note">{note.text}</span> : (
          <span className="docs-note docs-her-note">
            <span className="docs-her-mark" aria-hidden="true" />
            <span className="sr-only">{W.maiaNote} </span>
            <i>{note.text}</i>
          </span>
        ))}
      </button>
      {chips && (
        <span className="docs-chips" role="group" aria-label={line}>
          {chipsFor(d).map((c) => (
            <button key={c} type="button" className="docs-chip" data-chip={c} aria-label={`${CHIP_WORDS[c]}: ${line}`} onClick={() => onTap(d, c)}>
              {CHIP_WORDS[c]}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

function Menu({ anchor, items, onClose }: { anchor: HTMLElement; items: { key: string; label: string; onPick(): void }[]; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node) && e.target !== anchor) onClose();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [anchor, onClose]);
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };
  return (
    <div ref={box} className="docs-menu" role="menu" aria-label={W.more} onKeyDown={keys}>
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            i.onPick();
          }}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

interface Open {
  deskId: string;
  docId: string;
  page: number | null;
  changes: boolean;
}

export default function DocumentsBody({ deskId, deskName, offline, shell }: HostedBodyProps) {
  const phone = usePhone();
  const allDesks = useDeskStore((s) => s.desks);
  const ownDesks = useMemo(() => allDesks.filter((d) => !isGuildPanel(d.id) && d.kind !== 'guild').map((d) => ({ id: d.id, name: d.name })), [allDesks]);
  const [scope, setScope] = useState<'desk' | 'all'>('desk');
  const multi = ownDesks.length > 1 && ownDesks.some((d) => d.id === deskId);
  const inScope = useMemo(() => (scope === 'all' && multi ? [{ id: deskId, name: deskName }, ...ownDesks.filter((d) => d.id !== deskId)] : [{ id: deskId, name: deskName }]), [scope, multi, ownDesks, deskId, deskName]);
  const [place, setPlace] = useState<Place>('needs');
  const [view, setView] = useState<ListView | null>(null);
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [q, setQ] = useState('');
  const [inText, setInText] = useState(false);
  const [hits, setHits] = useState<Located[] | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<'rules' | 'tidy' | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [tidy, setTidy] = useState<TidyPreview | null>(null);
  const maiaOn = useLayoutPrefs((s) => {
    const p = s['maiaMode'];
    return !!p && typeof p === 'object' && (p as { on?: unknown }).on === true;
  });
  // Asking goes to this desk's own agents, its lead first (the owner, Nov 15); none on a desk without them (a teen's, say).
  const agents = useAskableAgents(deskId);
  const searchWords = agents[0] ? W.search(agents[0].name) : W.searchNoAgent;
  const tabsId = useId();
  const { announce, idem } = shell;

  // A desk's new list ends what was leaving there: the desk has it where it now belongs.
  const lastItems = useRef(new Map<string, unknown>());
  const onFeed = useCallback((f: Feed) => {
    if (lastItems.current.get(f.deskId) !== f.items) {
      lastItems.current.set(f.deskId, f.items);
      setLeaving((s) => (s.size ? new Set([...s].filter((k) => !k.startsWith(`${f.deskId}|`))) : s));
    }
    setFeeds((all) => (all[f.deskId] === f ? all : { ...all, [f.deskId]: f }));
  }, []);
  const clientOf = useCallback((id: string): DocsClient | null => feeds[id]?.client ?? null, [feeds]);
  const nameOf = (id: string): string => ownDesks.find((d) => d.id === id)?.name ?? deskName;
  const own = feeds[deskId];

  const say = useCallback(
    (text: string, undo?: () => void) => {
      announce(text);
      setToast({ key: Date.now(), text, ...(undo ? { undo } : {}) });
    },
    [announce],
  );
  const failed = useCallback((e: unknown) => {
    const code = toDocsError(e).code;
    say(code === 'offline' ? W.waiting : code === 'gone' ? W.gone : code === 'old' ? W.oldDesk : W.failed);
  }, [say]);

  // Asked from elsewhere: Files' View, Maia's handover card, her `office_show`.
  const target = useDocTargets((s) => s[deskId]);
  useEffect(() => {
    if (!target) return;
    setOpen({ deskId, docId: target.docId, page: target.page, changes: target.changes });
    takeDocTarget(deskId, target.seq);
  }, [target, deskId]);

  const undo = useCallback(
    async (id: string, token: string): Promise<void> => {
      const c = clientOf(id);
      if (!c) return say(W.waiting);
      try {
        const r = await c.undo(token);
        if (r.note) say(r.note);
        feeds[id]?.refresh();
      } catch (e) {
        failed(e);
      }
    },
    [clientOf, feeds, say, failed],
  );

  const tap = useCallback(
    async (id: string, d: Doc, chip: Chip): Promise<void> => {
      const c = clientOf(id);
      if (!c) return say(W.waiting);
      const key = `${id}|${d.id}`;
      const goes = chip !== 'sooner' || d.place !== 'needs' || d.maybe;
      if (goes) setLeaving((s) => new Set([...s, key]));
      try {
        const r = await c.tap(d.id, chip);
        const token = r.toast?.undo ?? null;
        say(r.toast?.text ?? CHIP_WORDS[chip], token ? () => void undo(id, token) : undefined);
        feeds[id]?.refresh();
      } catch (e) {
        setLeaving((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
        failed(e);
      }
    },
    [clientOf, feeds, say, failed, undo],
  );

  // ---- search: the same code search on each desk in scope, from the browser
  const needle = q.trim();
  const scopeKey = inScope.map((d) => `${d.id}:${feeds[d.id]?.client ? 1 : 0}`).join(',');
  useEffect(() => {
    if (!needle) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      void Promise.all(
        inScope.map(async (d) => {
          const c = clientOf(d.id);
          if (!c) return { deskId: d.id, items: [] as Doc[] };
          try {
            return { deskId: d.id, items: (await c.search(needle, inText)).items };
          } catch {
            return { deskId: d.id, items: [] as Doc[] };
          }
        }),
      ).then((r) => !stale && setHits(mergeHits(r)));
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, inText, scopeKey]);
  useEffect(() => setInText(false), [needle]);

  // ---- what's shown
  const merged = useMemo(
    () => mergeLists(inScope.map((d) => ({ deskId: d.id, items: (feeds[d.id]?.items ?? []).filter((x) => !leaving.has(`${d.id}|${x.id}`)), counts: feeds[d.id]?.counts ?? null, end: feeds[d.id]?.end ?? null, more: feeds[d.id]?.more ?? false })), place),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feeds, scopeKey, leaving, place],
  );
  const shownPlace = place;
  const allItems = [...merged.sure, ...merged.maybe];
  const question = inScope.map((d) => feeds[d.id]?.question).find((x) => x && !answered.has(x.id)) ?? null;
  const questionDesk = question ? (inScope.find((d) => feeds[d.id]?.question?.id === question.id)?.id ?? deskId) : deskId;
  const state = own?.state ?? 'idle';
  const deskLabel = (id: string): string | null => (scope === 'all' && multi ? nameOf(id) : null);

  const answer = async (choice: string): Promise<void> => {
    if (!question) return;
    const c = clientOf(questionDesk);
    if (!c) return say(W.waiting);
    setAnswered((s) => new Set([...s, question.id]));
    try {
      await c.answer(question.id, choice);
      if (question.id === 'q_firstsort' && choice === 'show') setPlace('needs');
      feeds[questionDesk]?.refresh();
    } catch (e) {
      setAnswered((s) => {
        const n = new Set(s);
        n.delete(question.id);
        return n;
      });
      failed(e);
    }
  };

  const openRules = async (): Promise<void> => {
    setPanel('rules');
    setRules(null);
    const c = clientOf(deskId);
    if (!c) return;
    try {
      setRules(await c.rules());
    } catch (e) {
      setRules([]);
      failed(e);
    }
  };
  const removeRule = async (r: Rule): Promise<void> => {
    const c = clientOf(deskId);
    if (!c) return;
    try {
      await c.ruleRemove(r.id);
      announce(`${W.remove}: ${r.text}`);
      setRules(await c.rules());
      own?.refresh();
    } catch (e) {
      failed(e);
    }
  };
  const openTidy = async (): Promise<void> => {
    setPanel('tidy');
    setTidy(null);
    const c = clientOf(deskId);
    if (!c) return;
    try {
      setTidy(await c.tidy());
    } catch (e) {
      setPanel(null);
      failed(e);
    }
  };
  const applyTidy = async (): Promise<void> => {
    const c = clientOf(deskId);
    if (!c) return;
    setPanel(null);
    try {
      const t = await c.tidyApply();
      const token = t?.undo ?? null;
      say(t?.text ?? W.tidy, token ? () => void undo(deskId, token) : undefined);
      own?.refresh();
    } catch (e) {
      failed(e);
    }
  };

  const tabKeys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const keys = PLACES.map((p) => p.key);
    const at = keys.indexOf(place);
    const go = (n: number): void => {
      const next = keys[(n + keys.length) % keys.length]!;
      setPlace(next);
      (e.currentTarget.querySelector(`[data-place="${next}"]`) as HTMLElement | null)?.focus();
    };
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(keys.length - 1);
    else return;
    e.preventDefault();
  };

  const openDoc = (d: Located): void => setOpen({ deskId: d.deskId, docId: d.id, page: null, changes: false });
  const onTap = (d: Located, c: Chip): void => void tap(d.deskId, d, c);

  const renderItems = (items: Located[]) =>
    view === 'people' ? (
      byPerson(items).map((g) => (
        <section key={g.key || 'none'} className="docs-group" aria-label={g.name || W.records}>
          {g.name && <h3 className="docs-h3">{g.name}</h3>}
          <ul className="docs-items">
            {g.items.map((d) => (
              <Item key={`${d.deskId}|${d.id}`} d={d} desk={deskLabel(d.deskId)} onOpen={openDoc} onTap={onTap} />
            ))}
          </ul>
        </section>
      ))
    ) : (
      <ul className="docs-items">
        {items.map((d) => (
          <Item key={`${d.deskId}|${d.id}`} d={d} desk={deskLabel(d.deskId)} onOpen={openDoc} onTap={onTap} />
        ))}
      </ul>
    );

  if (open) {
    const f = feeds[open.deskId];
    return (
      <div className="docs-root" data-testid="documents-body" data-phone={phone || undefined}>
        {inScope.map((d) => (
          <DeskFeed key={d.id} deskId={d.id} idem={idem} place={place} view={view} onFeed={onFeed} />
        ))}
        <Viewer
          key={`${open.deskId}|${open.docId}|${open.page ?? ''}|${open.changes}`}
          deskId={open.deskId}
          client={f?.client ?? null}
          docId={open.docId}
          askedPage={open.page}
          withChanges={open.changes}
          offline={offline && open.deskId === deskId}
          phone={phone}
          maiaOn={maiaOn}
          changed={f?.changed ?? { ids: null, n: 0 }}
          shell={shell}
          onClose={() => setOpen(null)}
          say={say}
          onTap={(id, d, c) => {
            setOpen(null);
            void tap(id, d, c);
          }}
        />
        {toast && <Toast key={toast.key} t={toast} onGone={() => setToast(null)} />}
      </div>
    );
  }

  const panelId = `${tabsId}-panel`;
  const counts = merged.counts;
  return (
    <div className="docs-root" data-testid="documents-body" data-place={place} data-phone={phone || undefined}>
      {inScope.map((d) => (
        <DeskFeed key={d.id} deskId={d.id} idem={idem} place={place} view={view} onFeed={onFeed} />
      ))}
      <div className="docs-top">
        <div className="docs-places" role="tablist" aria-label={W.name} onKeyDown={tabKeys}>
          {PLACES.map((p) => {
            const n = placeCount(counts, p.key);
            return (
              <button
                key={p.key}
                type="button"
                role="tab"
                id={`${tabsId}-${p.key}`}
                data-place={p.key}
                aria-selected={place === p.key}
                aria-controls={panelId}
                tabIndex={place === p.key ? 0 : -1}
                className={place === p.key ? 'on' : undefined}
                onClick={() => {
                  setPlace(p.key);
                  setPanel(null);
                }}
              >
                {p.label}
                {n > 0 && <span className={p.key === 'needs' ? 'docs-count hot' : 'docs-count'}>{n}</span>}
              </button>
            );
          })}
        </div>
        <span className="docs-top-end">
          {multi && (
            <select className="docs-scope" aria-label="Which desks" value={scope} onChange={(e) => setScope(e.target.value as 'desk' | 'all')}>
              <option value="desk">{W.thisDesk}</option>
              <option value="all">{W.allDesks}</option>
            </select>
          )}
          <button type="button" className="docs-icon-btn" aria-label={W.more} aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
            <Icon name="more" />
          </button>
        </span>
      </div>

      <div className="docs-find">
        <span className="docs-search">
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
            placeholder={searchWords}
            aria-label={searchWords}
            maxLength={200}
          />
        </span>
        {!needle && (
          <span className="docs-views" role="group" aria-label="Show">
            {(['people', 'week'] as const).map((v) => (
              <button key={v} type="button" className="docs-view" aria-pressed={view === v} onClick={() => setView(view === v ? null : v)}>
                {v === 'people' ? W.people : W.week}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="docs-scroll" role="tabpanel" id={panelId} aria-labelledby={`${tabsId}-${place}`} tabIndex={-1}>
        {state === 'old' && <p className="docs-line-quiet">{W.oldDesk}</p>}
        {state === 'off' && <p className="docs-line-quiet">{W.switchedOff}</p>}
        {state === 'error' && (
          <p className="docs-line-quiet" role="alert">
            {W.failed}{' '}
            <button type="button" className="docs-link" onClick={() => own?.reload()}>
              {W.tryAgain}
            </button>
          </p>
        )}

        {panel === 'rules' && (
          <section className="docs-card" aria-labelledby={`${tabsId}-rules`}>
            <div className="docs-card-head">
              <h2 id={`${tabsId}-rules`} className="docs-h2">{W.rules}</h2>
              <button type="button" className="docs-icon-btn" aria-label={`${W.close} ${W.rules}`} onClick={() => setPanel(null)}>
                <Icon name="close" />
              </button>
            </div>
            {rules === null ? null : rules.length === 0 ? (
              <p className="docs-quiet">{W.noRules}</p>
            ) : (
              <ul className="docs-rules">
                {rules.map((r) => (
                  <li key={r.id}>
                    <span>{r.text}</span>
                    <button type="button" className="docs-btn" aria-label={`${W.remove}: ${r.text}`} onClick={() => void removeRule(r)}>
                      {W.remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {panel === 'tidy' && (
          <section className="docs-card" aria-label={W.tidy}>
            {tidy === null ? null : tidy.text ? (
              <>
                <p>{tidy.text}</p>
                <div className="docs-card-acts">
                  <button type="button" className="docs-btn primary" onClick={() => void applyTidy()}>
                    {W.tidy}
                  </button>
                  <button type="button" className="docs-btn" onClick={() => setPanel(null)}>
                    {W.notNow}
                  </button>
                </div>
              </>
            ) : (
              <p className="docs-quiet">
                {W.tidyNothing}{' '}
                <button type="button" className="docs-link" onClick={() => setPanel(null)}>
                  {W.close}
                </button>
              </p>
            )}
          </section>
        )}

        {question && !needle && (
          <section className="docs-card docs-question" aria-label={question.text} data-testid="docs-question">
            <p>{question.text}</p>
            <div className="docs-card-acts">
              {question.choices.map((c, i) => (
                <button key={c.id} type="button" className={`docs-btn${i === 0 ? ' primary' : ''}`} onClick={() => void answer(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {needle ? (
          <section className="docs-results" aria-label={searchWords} data-testid="docs-results">
            {hits && hits.length > 0 && renderItems(hits)}
            {hits && hits.length === 0 && <p className="docs-empty">{W.findEmpty}</p>}
            {hits && (
              <p className="docs-further">
                {!inText && (
                  <button type="button" className="docs-btn" onClick={() => setInText(true)}>
                    {W.lookInside}
                  </button>
                )}
                <AskAgent agents={agents} label={W.askAgent} className="docs-btn" onAsk={(agentId) => void (askAgent(deskId, agentId, needle) || say(W.askNoWindow))} />
              </p>
            )}
          </section>
        ) : (
          <section className="docs-list" aria-label={placeLabel(shownPlace)} data-testid="docs-list">
            {merged.sure.length > 0 && renderItems(merged.sure)}
            {merged.maybe.length > 0 && (
              <>
                <h3 className="docs-divider" data-testid="docs-maybe">
                  <span>{W.maybe}</span>
                </h3>
                {renderItems(merged.maybe)}
              </>
            )}
            {allItems.length === 0 && state === 'ready' && <p className="docs-empty">{emptyWords(place)}</p>}
            {allItems.length > 0 && merged.end && <p className="docs-end">{merged.end}</p>}
          </section>
        )}

        {scope === 'all' && multi && ownDesks.filter((d) => d.id !== deskId).map((d) => <AsleepLine key={d.id} deskId={d.id} name={d.name} />)}
      </div>

      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { key: 'rules', label: W.rules, onPick: () => void openRules() },
            { key: 'tidy', label: W.tidy, onPick: () => void openTidy() },
          ]}
        />
      )}
      {toast && <Toast key={toast.key} t={toast} onGone={() => setToast(null)} />}
    </div>
  );
}
