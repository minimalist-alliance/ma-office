// Send to my desk (#9, S-141): the sheet over the office that asks which desk opens a link, and the line in the office's
// notices stack while it opens and once it's done. Its own chunk, fetched only once a link has come (`door.tsx`). Every
// address shown is untrusted text: the host from `new URL().hostname` (punycode for an IDN), the address through
// `displayText`, never as markup and never inside our own sentence's words.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { displayText } from '../browser/address';
import { LinkBox } from '../chrome/CalmScreen';
import { Icon } from '../chrome/icons';
import { deskClosed, getLive, linkOf, useLiveStore, wakeDesk } from '../desk/liveStore';
import { openItem } from '../shell/actions';
import { announce } from '../shell/announce';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { setLayoutPref } from '../shell/layoutSync';
import { ownDesks, useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { mutate } from '../browser/mutate';
import { closeIncoming, useOpen } from './intent';
import { deskStateWords, DONE_SHOWN_MS, endSend, firstChoice, retrySend, sendableDesks, startSend, useSends, wakeWords, type Send, type SendDeps } from './sendToDesk';
import './open.css';

/** The layout pref for the desk chosen last (design 9.4), so the sheet starts there. */
const LAST_KEY = 'sendToDeskLast';

const browserItem = (deskId: string): string | null => useLayoutStore.getState().desks[deskId]?.items.find((i) => i.app === 'browser')?.id ?? null;

/** The office's side of the runner. */
const officeDeps: SendDeps = {
  desk: (deskId) => useDeskStore.getState().desks.find((d) => d.id === deskId),
  link: linkOf,
  linkOpen: (deskId) => getLive(deskId).link === 'open',
  wake: wakeDesk,
  openBrowserWindow: (deskId) => {
    const item = browserItem(deskId);
    if (item) openItem(deskId, item);
  },
  waitFor: (test, ms, stop) =>
    new Promise((resolve) => {
      if (test()) {
        resolve(true);
        return;
      }
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        offLive();
        offDesks();
        resolve(ok);
      };
      const check = (): void => {
        if (stop()) finish(false);
        else if (test()) finish(true);
      };
      const timer = window.setTimeout(() => finish(test()), ms);
      const offLive = useLiveStore.subscribe(check);
      const offDesks = useDeskStore.subscribe(check);
    }),
};

function useSendableDesks(): DeskInfo[] {
  useDeskStore((s) => s.desks); // renders again when the list changes
  const layouts = useLayoutStore((s) => s.desks);
  useLiveStore((s) => s.desks); // a closed desk (membership, data guard) leaves
  return sendableDesks(ownDesks(), layouts, deskClosed);
}

/** Esc puts the sheet away wherever focus is, before the office's own Esc hears it. */
function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}

function DeskRows({ desks, chosen, onChoose, labelId }: { desks: DeskInfo[]; chosen: string; onChoose: (id: string) => void; labelId: string }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const i = desks.findIndex((d) => d.id === chosen);
    const by = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    const next = desks[(i + by + desks.length) % desks.length];
    if (!next) return;
    onChoose(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div className="op-desks" role="radiogroup" aria-labelledby={labelId} onKeyDown={move}>
      {desks.map((d) => {
        const on = d.id === chosen;
        const state = deskStateWords(d.vm);
        return (
          <button
            key={d.id}
            ref={(el) => {
              if (el) refs.current.set(d.id, el);
              else refs.current.delete(d.id);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="op-desk"
            data-desk={d.id}
            onClick={() => onChoose(d.id)}
          >
            <span className="op-dot" aria-hidden="true" />
            <span className="op-desk-text">
              <span className="op-desk-name">{displayText(d.name)}</span>
              {state && <span className="op-desk-state">{state}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function LinkSheet({ url }: { url: string }) {
  const desks = useSendableDesks();
  const last = useLayoutPrefs((s) => s[LAST_KEY]);
  const [chosen, setChosen] = useState<string | null>(null);
  const desk = desks.find((d) => d.id === chosen) ?? firstChoice(desks, last);
  const titleId = useId();
  const labelId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const cancel = useCallback(() => closeIncoming(), []);
  useEscape(cancel);

  // Focus: the chosen desk, or the one button there is.
  useEffect(() => {
    const el = sheetRef.current;
    el?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], .btn.primary, .btn')?.focus({ preventScroll: true });
  }, [desks.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (): void => {
    if (!desk) return;
    if (last !== desk.id) setLayoutPref({ [LAST_KEY]: desk.id });
    closeIncoming();
    useOpen.setState({ sending: true });
    startSend(desk.id, url, officeDeps);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Enter opens, from a desk's row too; the buttons keep their own.
    if (e.key !== 'Enter' || (e.target instanceof HTMLButtonElement && e.target.getAttribute('role') !== 'radio')) return;
    e.preventDefault();
    open();
  };

  const one = desks.length === 1 ? desks[0] : null;
  return (
    <div className="guild-modal-away op-away" onClick={cancel}>
      <div ref={sheetRef} className="guild-modal op-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="open-sheet" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId}>Open this link on a desk</h2>
        <LinkBox url={url} />
        {desks.length === 0 ? (
          <p className="op-one">You don’t have a desk that can open links right now.</p>
        ) : one ? (
          <p className="op-one" data-testid="open-one">
            Opens on <strong>{displayText(one.name)}</strong>
            {one.vm === 'stopped' ? ', which is asleep and wakes to open it.' : '.'}
          </p>
        ) : (
          <>
            <p className="op-label" id={labelId}>Which desk</p>
            <DeskRows desks={desks} chosen={desk?.id ?? ''} onChoose={setChosen} labelId={labelId} />
          </>
        )}
        {desk && <p className="guild-quiet-note op-quiet">It opens in a new tab in that desk’s Browser, with that desk’s sign-ins.</p>}
        <div className="guild-modal-actions">
          {desk ? (
            <>
              <button type="button" className="btn" onClick={cancel}>Cancel</button>
              <button type="button" className="btn primary" data-testid="open-go" onClick={open}>
                Open on {displayText(desk.name)}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={cancel}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

function NoLinkSheet({ text }: { text: string }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => closeIncoming(), []);
  useEscape(close);
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), []);
  return (
    <div className="guild-modal-away op-away" onClick={close}>
      <div className="guild-modal op-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="open-sheet" data-kind="none" onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId}>There’s no web link here</h2>
        <p className="op-one">Only addresses that start with http or https can open on a desk. This is what came in:</p>
        <div className="op-link">
          <div className="op-addr">{displayText(text)}</div>
        </div>
        <div className="guild-modal-actions">
          <button ref={closeRef} type="button" className="btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** The sheet, once the desk list is known, so "no desk" is never said too soon. */
export function OpenSheet() {
  const incoming = useOpen((s) => s.incoming);
  const listKnown = useDeskStore((s) => s.status !== 'loading');
  if (!incoming) return null;
  if (incoming.kind === 'none') return <NoLinkSheet text={incoming.text} />;
  return listKnown ? <LinkSheet url={incoming.url} /> : null;
}

const nameOf = (deskId: string): string => displayText(useDeskStore.getState().desks.find((d) => d.id === deskId)?.name ?? 'your desk');

/** The words of a send's line, as plain text: what the polite region says too. */
export function sendWords(s: Send, desk: DeskInfo | undefined, name: string): string {
  if (s.phase === 'waking') return `Opening ${s.host} on ${name} · ${wakeWords(desk)}`;
  if (s.phase === 'opening') return `Opening ${s.host} on ${name}…`;
  if (s.phase === 'done') return `${s.host} is open in a new tab on ${name}.`;
  if (s.why === 'wake') return `${name} couldn’t wake to open ${s.host}.`;
  if (s.why === 'blocked') return `${s.host} can’t open on ${name}: its Browser blocks this site.`;
  return `${s.host} didn’t open on ${name}.`;
}

/** The same words, with the host in bold. */
function SendText({ s, desk, name }: { s: Send; desk: DeskInfo | undefined; name: string }) {
  const host = <b>{s.host}</b>;
  if (s.phase === 'waking') return <>Opening {host} on {name} · {wakeWords(desk)}</>;
  if (s.phase === 'opening') return <>Opening {host} on {name}…</>;
  if (s.phase === 'done') return <>{host} is open in a new tab on {name}.</>;
  if (s.why === 'wake') return <>{name} couldn’t wake to open {host}.</>;
  if (s.why === 'blocked') return <>{host} can’t open on {name}: its Browser blocks this site.</>;
  return <>{host} didn’t open on {name}.</>;
}

function showMe(s: Send): void {
  const item = browserItem(s.deskId);
  endSend(s.id);
  if (!item) return;
  openItem(s.deskId, item);
  const link = linkOf(s.deskId);
  const tabId = s.tabId;
  if (!link || !tabId) return;
  void mutate((idem) => link.call('browser.tab.activate', { tabId }, { idem })).catch(() => {
    // The window shows whatever tab is on screen; the new one is there among them.
  });
}

function SendLine({ s }: { s: Send }) {
  const desk = useDeskStore((st) => st.desks.find((d) => d.id === s.deskId));
  const name = displayText(desk?.name ?? nameOf(s.deskId));
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const words = sendWords(s, desk, name);
  const ended = s.phase === 'done' || s.phase === 'failed';
  useEffect(() => {
    if (ended) announce(words);
    // Said once, as it ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, s.phase, s.why]);
  useEffect(() => {
    if (s.phase !== 'done' || held) return undefined;
    const timer = window.setTimeout(() => endSend(s.id), DONE_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [s.phase, s.id, held]);
  return (
    <div
      className="notice op-notice"
      role="group"
      aria-label={words}
      data-testid="open-notice"
      data-phase={s.phase}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFocused(false);
      }}
    >
      {(s.phase === 'waking' || s.phase === 'opening') && <span className="op-spin" aria-hidden="true" />}
      {s.phase === 'done' && (
        <svg className="op-ok" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5.5 12.5 4.2 4.2 8.8-9.2" />
        </svg>
      )}
      <span className="op-notice-text">
        <SendText s={s} desk={desk} name={name} />
      </span>
      {s.phase === 'done' && (
        <button type="button" className="new-version-reload" onClick={() => showMe(s)}>Show me</button>
      )}
      {s.phase === 'failed' && (
        <button type="button" className="new-version-reload" onClick={() => retrySend(s.id)}>Try again</button>
      )}
      <button type="button" className="icon-btn sm new-version-dismiss" aria-label={ended ? 'Dismiss' : 'Stop'} title={ended ? 'Dismiss' : 'Stop'} onClick={() => endSend(s.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Each send's line, in the office's notices stack, above the bottom bar. */
export function OpenNotices() {
  const sends = useSends((s) => s.sends);
  return (
    <>
      {sends.map((s) => (
        <SendLine key={s.id} s={s} />
      ))}
    </>
  );
}
