// To-do as a sheet (the focus shield; CONCEPT.md §5.6): a tap on the held line in the desk view opens it, the phone's sheet from the
// bottom on a phone and a panel at the right on a larger screen. What takes a visible place in To-do now, then **All held**
// (`agent.maia.reach.held`, newest first, grouped by desk, filtered by desk and by kind), and "Open Maia's room" at its foot. Held
// items are listed, never hidden: nothing she holds is lost.
// Its look is the brand pass's tray (`design-drafts/maia-shield-brand/DIRECTION.md`): Maia at the head beside the office's switcher,
// each row the kind's glyph in its chip, the words, and one pill at the right; held items grouped under their desk's etched name;
// pill selects; sized to what it holds; a light veil under it, not a grey wash; on a phone it rises from the bottom with a grabber.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { wakeDesk } from '../../desk/liveStore';
import { useDeskStore } from '../../state/deskStore';
import { readRoom } from '../deskSource';
import { enterMaiaMode } from '../door';
import { reachCall, useReach } from '../focusSource';
import { fromAttention, plain, type ColumnItem } from '../model';
import { heldByDesk, readHeld, type HeldItem } from '../reach';
import { R } from '../words';
import { nameOf, openApp } from './actions';
import { Dot, KindChip, MaiaHalo, Source } from './Maia';
import { useShieldUi } from './state';
import { chipWords, fillName, type Paper } from '../tray';
import { Stack } from './Tray';
import { QuickReply, ReplyButton, useCanReply, useReplyGesture } from './QuickReply';

function goItem(item: ColumnItem): void {
  const go = item.go;
  if (go.kind === 'view') openApp(item.deskId, go.app);
  else if (go.kind === 'wake') wakeDesk(item.deskId);
  else if (go.kind === 'chat') enterMaiaMode(null);
}

function TodoList({ onDone }: { onDone: () => void }) {
  const room = useReach((s) => s.room);
  const desks = useDeskStore((s) => s.desks);
  const items = useMemo(() => {
    const r = room ? readRoom(room) : null;
    const name = (id: string): string | null => {
      const d = desks.find((x) => x.id === id && x.kind !== 'guild');
      return d ? plain(d.name, 40) || 'Desk' : null;
    };
    return r ? fromAttention(r.attention, name) : [];
  }, [room, desks]);
  if (!items.length) return <p className="sh-empty">{R.nothingNow}</p>;
  return (
    <ul className="sh-list" aria-label={R.todo}>
      {items.map((i) => (
        <li key={i.id} className={`sh-list-item${i.urgency === 'now' ? ' now' : ''}`}>
          <KindChip kind={i.go.kind === 'wake' ? 'wake' : i.label === 'Review' ? 'approval' : 'result'} />
          <div className="sh-list-text">
            <p className="sh-source">
              <span className="sh-etch">{i.deskName}</span>
            </p>
            <p className="sh-list-what">
              {i.urgency === 'now' && <Dot />}
              {i.title}
            </p>
            {i.meta && <p className="sh-why-text">{i.meta}</p>}
          </div>
          {i.label && (
            <button
              type="button"
              className={`sh-btn${i.urgency === 'now' ? ' primary' : ' soft'}`}
              aria-label={`${i.label}: ${i.title}`}
              onClick={() => {
                goItem(i);
                onDone();
              }}
            >
              {i.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A held row; a person's message has the reply arrow (a long press or a drag down too), and its reply opens under it. */
function HeldRow({ i, onReplied }: { i: HeldItem; onReplied: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    let live = true;
    void nameOf(i.who ?? null).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [i.who]);
  const target = useCanReply(i.kind === 'message' && i.who && i.channelId && i.deskId ? { deskId: i.deskId, channelId: i.channelId, who: i.who } : null);
  useReplyGesture(row, row, target && !replying ? () => setReplying(true) : null);
  return (
    <li
      ref={row}
      className={`sh-list-item${replying ? ' replying' : ''}`}
      onKeyDown={(e) => {
        if (target && !replying && (e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as Element).closest('input, textarea')) {
          e.preventDefault();
          setReplying(true);
        }
      }}
    >
      <KindChip kind={i.kind} />
      <div className="sh-list-text">
        <p className="sh-list-what">{fillName(i.title, name)}</p>
        {i.reason && <p className="sh-why-text">{i.reason}</p>}
      </div>
      {target && !replying && <ReplyButton name={name ?? 'them'} onClick={() => setReplying(true)} />}
      {replying && target && (
        <QuickReply
          className="sh-row-reply"
          target={target}
          name={name}
          onClose={() => setReplying(false)}
          onDone={(r) => {
            if (r !== 'sent') return;
            void reachCall('agent.maia.reach.answer', { itemId: i.itemId, answer: 'replied' }).catch(() => undefined);
            onReplied();
          }}
        />
      )}
    </li>
  );
}

const KIND_CHIP: Record<Paper['kind'], string> = { approval: 'approval', report: 'result', doc: 'notes', reply: 'message', todo: 'todo' };

function PaperRow({ p, onOpen }: { p: Paper; onOpen: () => void }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void nameOf(p.asker.who).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [p.asker.who]);
  const chip = chipWords(p, Date.now());
  return (
    <li className="sh-list-item sh-paper-row">
      <KindChip kind={KIND_CHIP[p.kind]} />
      <div className="sh-list-text">
        <Source text={fillName(p.asker.label, name)} className="small" />
        <p className="sh-list-what">{fillName(p.title, name)}</p>
        {chip && <p className="sh-why-text">{chip}</p>}
      </div>
      <button type="button" className="sh-btn soft" aria-label={`${R.goThrough}: ${fillName(p.title, name)}`} onClick={onOpen}>
        {p.kind === 'approval' ? 'Review' : 'Open'}
      </button>
    </li>
  );
}

/**
 * Needs you, first in To-do (the decision tray §8.2): one row per paper; a tap opens that paper here, and "Go through them"
 * opens the stack. Answering returns to the list.
 */
function NeedsYou() {
  const tray = useReach((s) => s.reach?.tray ?? null);
  const [going, setGoing] = useState<readonly string[] | 'all' | null>(null);
  if (!tray || (!tray.papers.length && !going)) return null;
  if (going) {
    return (
      <section className="sh-needs" aria-label={R.needsYou}>
        <Stack tray={tray} only={going === 'all' ? undefined : going} />
        <button type="button" className="sh-btn quiet sh-needs-back" onClick={() => setGoing(null)}>
          {R.backToTodo}
        </button>
      </section>
    );
  }
  return (
    <section className="sh-needs" aria-label={R.needsYou} data-testid="tray-needs">
      <div className="sh-needs-head">
        <h3 className="sh-group-label">
          {R.needsYou}
          <span className="sh-count">{tray.count}</span>
        </h3>
        {tray.papers.length > 1 && (
          <button type="button" className="sh-btn quiet" onClick={() => setGoing('all')}>
            {R.goThrough}
          </button>
        )}
      </div>
      <ul className="sh-list">
        {tray.papers.slice(0, 7).map((p) => (
          <PaperRow key={p.paperId} p={p} onOpen={() => setGoing([p.paperId])} />
        ))}
      </ul>
    </section>
  );
}

function AllHeld() {
  const desks = useDeskStore((s) => s.desks).filter((d) => d.kind !== 'guild');
  const [desk, setDesk] = useState('');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<HeldItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setFailed(false);
    void reachCall('agent.maia.reach.held', { ...(desk ? { deskId: desk } : {}), ...(kind ? { kind } : {}), limit: 100 }, true).then(
      (r) => {
        if (!live) return;
        const list = readHeld(r);
        setItems(list);
        if (!desk && !kind) setKinds([...new Set(list.map((i) => i.kind))].sort());
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [desk, kind]);
  const groups = items ? heldByDesk(items) : [];
  return (
    <div className="sh-held">
      <div className="sh-filters">
        <label className="sh-filter">
          <span className="sr-only">{R.filterDesk}</span>
          <select value={desk} onChange={(e) => setDesk(e.target.value)}>
            <option value="">{R.allDesks}</option>
            {desks.map((d) => (
              <option key={d.id} value={d.id}>
                {plain(d.name, 40) || 'Desk'}
              </option>
            ))}
          </select>
        </label>
        <label className="sh-filter">
          <span className="sr-only">{R.filterKind}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{R.allKinds}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failed ? (
        <p className="sh-empty" role="status">
          {R.heldFailed}
        </p>
      ) : !items ? (
        <p className="sh-empty">{R.heldLoading}</p>
      ) : !items.length ? (
        <p className="sh-empty">{R.nothingHeld}</p>
      ) : (
        groups.map((g) => (
          <section key={g.deskId ?? g.deskName} className="sh-held-desk" aria-label={g.deskName}>
            <h3 className="sh-desk-label">
              <span className="sh-etch">{g.deskName}</span>
            </h3>
            <ul className="sh-list">
              {g.items.map((i) => (
                <HeldRow key={i.itemId} i={i} onReplied={() => setItems((all) => (all ?? []).filter((x) => x.itemId !== i.itemId))} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function Sheet({ back }: { back: () => void }) {
  const view = useShieldUi((s) => s.sheet);
  const box = useRef<HTMLDivElement>(null);
  const close = (): void => {
    useShieldUi.setState({ sheet: null });
    back();
  };
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true });
  }, []);
  if (!view) return null;
  return createPortal(
    <div className="sh-layer">
      <div className="sh-scrim" onClick={close} aria-hidden="true" />
      <div
        ref={box}
        className="sh-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={view === 'held' ? R.allHeld : R.todo}
        data-testid="shield-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <span className="sh-grab" aria-hidden="true" />
        <div className="sh-sheet-head">
          <MaiaHalo size="md" />
          <div className="segmented sh-tabs" role="tablist" aria-label={R.todo}>
            <button type="button" role="tab" aria-selected={view === 'todo'} className={view === 'todo' ? 'on' : ''} onClick={() => useShieldUi.setState({ sheet: 'todo' })}>
              <span>{R.todo}</span>
            </button>
            <button type="button" role="tab" aria-selected={view === 'held'} className={view === 'held' ? 'on' : ''} onClick={() => useShieldUi.setState({ sheet: 'held' })}>
              <span>{R.allHeld}</span>
            </button>
          </div>
          <button type="button" className="sh-icon-btn" aria-label={R.closeTodo} onClick={close}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
              <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
            </svg>
          </button>
        </div>
        <div className="sh-sheet-body">
          {view === 'held' ? (
            <AllHeld />
          ) : (
            <>
              <NeedsYou />
              <TodoList onDone={close} />
            </>
          )}
        </div>
        <div className="sh-sheet-foot">
          <button
            type="button"
            className="sh-btn soft"
            onClick={() => {
              useShieldUi.setState({ sheet: null });
              enterMaiaMode(null);
            }}
          >
            {R.openRoom}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
