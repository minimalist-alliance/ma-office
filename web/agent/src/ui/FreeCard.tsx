// "Try free models" (agent-free-key spec §1.2 to §1.5, §2): the card that connects the member's own OpenRouter account, and its
// states. The press opens OpenRouter in a window of its own, the office tab waits for its own page to relay the code, trades it
// for a key at OpenRouter (`connect/openrouter.ts`) and hands the key to the desk like a pasted one. The title, lead, facts and
// privacy line stay in every state, because they're what the member agreed to: only the foot changes.
import { useEffect, useId, useRef, useState } from 'react';
import { newIdem, type AgentClient } from '../client/agentClient';
import type { KeySecret } from '../client/keySecret';
import type { Agent, KeyMeta } from '../client/types';
import {
  authUrl,
  awakeText,
  claim,
  clearPending,
  CONNECT_MS,
  CONNECT_WORDS,
  ConnectError,
  deskFailure,
  exchange,
  judge,
  KEY_LABEL,
  listen,
  OPENROUTER,
  prepare,
  readPending,
  savePending,
  type Prepared,
} from '../connect/openrouter';
import { Icon } from './icons';

type FreeState =
  | { kind: 'idle' }
  | { kind: 'waiting'; state: string }
  | { kind: 'blocked'; state: string; url: string }
  | { kind: 'checking' }
  | { kind: 'failed'; text: string };

/** A Connect this tab started for this agent and hasn't finished, as the card finds it on opening (a reload, the window reopened). */
function resume(deskId: string, agentId: string): FreeState {
  const p = readPending();
  if (!p || p.deskId !== deskId || p.agentId !== agentId) return { kind: 'idle' };
  if (Date.now() - p.startedAt > CONNECT_MS) {
    clearPending(p.state);
    return { kind: 'failed', text: CONNECT_WORDS.expired };
  }
  return { kind: 'waiting', state: p.state };
}

/** Phones and touch screens open OpenRouter as a tab; elsewhere it's a window. */
const where = (): 'tab' | 'window' => (typeof matchMedia === 'function' && matchMedia('(max-width: 599px), (pointer: coarse)').matches ? 'tab' : 'window');

export function FreeCard({ client, agent, deskId, deskName, onAdded, onActive, onKeysChanged, announce }: {
  client: AgentClient;
  agent: Pick<Agent, 'id' | 'name'>;
  /** Which desk this is, so a Connect resumes only where it started. */
  deskId: string;
  deskName: string;
  /** What happens once the desk has the key: true if the agent now runs on it. A throw is the spec's "couldn't start on it yet". */
  onAdded: (key: KeyMeta) => Promise<boolean>;
  /** Whether a Connect is under way or its outcome is showing, so the card stays drawn while the desk's keys change under it. */
  onActive?: (active: boolean) => void;
  onKeysChanged?: () => void;
  announce?: (text: string) => void;
}) {
  const ids = useId();
  const [st, setSt] = useState<FreeState>(() => resume(deskId, agent.id));
  const prepared = useRef<Prepared | null>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const span = where();

  useEffect(() => {
    onActive?.(st.kind !== 'idle');
  }, [st.kind, onActive]);
  useEffect(() => () => onActive?.(false), [onActive]);

  // A fresh verifier and state, ready before the press, so `window.open` runs in the press itself and the browser allows it.
  useEffect(() => {
    if (st.kind !== 'idle' && st.kind !== 'failed') return;
    let live = true;
    prepared.current = null;
    void prepare().then((p) => {
      if (live) prepared.current = p;
    });
    return () => {
      live = false;
    };
  }, [st.kind]);

  // Waiting: focus to Cancel, and the status said once. Failed: back to Connect again, and the error said (`role="alert"`).
  useEffect(() => {
    if (st.kind === 'waiting' || st.kind === 'blocked') cancelRef.current?.focus();
    else if (st.kind === 'failed') connectRef.current?.focus();
  }, [st.kind]);

  const finish = async (code: string, verifier: string): Promise<void> => {
    let secret: KeySecret;
    try {
      secret = await exchange(code, verifier);
    } catch (err) {
      setSt({ kind: 'failed', text: err instanceof ConnectError && err.why === 'unreachable' ? CONNECT_WORDS.unreachable : CONNECT_WORDS.declined });
      return;
    }
    let key: KeyMeta;
    try {
      key = await client.addKey({ provider: OPENROUTER, label: KEY_LABEL, secret }, { idem: newIdem() });
    } catch (err) {
      setSt({ kind: 'failed', text: deskFailure(err) });
      onKeysChanged?.();
      return;
    } finally {
      secret.wipe();
    }
    try {
      const woke = await onAdded(key);
      setSt({ kind: 'idle' });
      if (woke) announce?.(awakeText(agent.name));
    } catch {
      setSt({ kind: 'failed', text: CONNECT_WORDS.unbound });
    }
  };

  // While it waits: the page's relay, for this card's own state only, and 10 minutes at most.
  useEffect(() => {
    if (st.kind !== 'waiting' && st.kind !== 'blocked') return;
    const mine = st.state;
    const pending = readPending();
    const left = pending?.state === mine ? pending.startedAt + CONNECT_MS - Date.now() : CONNECT_MS;
    const timer = setTimeout(() => {
      clearPending(mine);
      setSt({ kind: 'failed', text: CONNECT_WORDS.expired });
    }, Math.max(0, left));
    const off = listen((answer, reply) => {
      const verdict = judge(answer, mine, readPending(), Date.now());
      if (verdict.act === 'ignore') return;
      if (verdict.act === 'fail') {
        // A "didn't match" leaves whatever newer Connect is pending; it isn't this card's to clear, nor its page's to end.
        if (verdict.why !== 'mismatch') {
          clearPending(mine);
          reply(answer.state);
        }
        setSt({ kind: 'failed', text: CONNECT_WORDS[verdict.why] });
        return;
      }
      // The key screen and the Keys tab can both be waiting on the same Connect: the first takes it, the other steps back.
      if (!claim(mine)) {
        setSt({ kind: 'idle' });
        return;
      }
      clearPending(mine);
      reply(mine);
      setSt({ kind: 'checking' });
      void finish(verdict.code, verdict.verifier);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
    // `finish` reads only props that don't change while it waits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const open = (p: Prepared): void => {
    prepared.current = null;
    savePending({ verifier: p.verifier, state: p.state, deskId, agentId: agent.id, startedAt: Date.now() });
    const url = authUrl({ origin: window.location.origin, challenge: p.challenge, state: p.state, deskName });
    let win: Window | null = null;
    try {
      win = window.open(url, 'ma-openrouter', 'popup,width=520,height=720');
    } catch {
      win = null;
    }
    setSt(win ? { kind: 'waiting', state: p.state } : { kind: 'blocked', state: p.state, url });
  };

  const connect = (): void => {
    const p = prepared.current;
    if (p) open(p);
    else void prepare().then(open);
  };

  const cancel = (): void => {
    if (st.kind === 'waiting' || st.kind === 'blocked') clearPending(st.state);
    setSt({ kind: 'idle' });
  };

  const connectButton = (label: string) => (
    <div className="ag-free-actions">
      <button ref={connectRef} type="button" className="ag-btn primary" onClick={connect} data-testid="free-connect">
        {label}
      </button>
      <small>Opens openrouter.ai in a new {span}</small>
    </div>
  );

  return (
    <section className="ag-free" aria-labelledby={`${ids}-title`} data-state={st.kind} data-testid="free-card">
      <h4 className="ag-setup-title" id={`${ids}-title`}>
        Try free models
      </h4>
      <p className="ag-free-lead">Connect OpenRouter, and {agent.name} uses its free models. You sign in or make an account there, and it doesn’t ask for a card.</p>
      <ul className="ag-free-facts">
        <li>Slower than paid models, with a limited number of requests each day.</li>
        <li>Some chat only: they can’t use tools on your desk.</li>
        <li>The key is yours, from your OpenRouter account, and comes straight to this desk.</li>
      </ul>
      <p className="ag-free-privacy" data-testid="free-privacy">
        <Icon name="eye" size={14} />
        <span>Free models are run by other companies, which may keep what you send and learn from it. Your privacy settings at OpenRouter decide which ones you use.</span>
      </p>
      {st.kind === 'idle' && connectButton('Connect OpenRouter')}
      {st.kind === 'waiting' && (
        <div className="ag-free-wait" role="status" data-testid="free-wait">
          <Icon name="hourglass" />
          <span>
            <b>Waiting for OpenRouter…</b>Finish in the OpenRouter {span}, then come back here. Nothing is added until you do.
          </span>
          <button ref={cancelRef} type="button" className="ag-text-btn" onClick={cancel} data-testid="free-cancel">
            Cancel
          </button>
        </div>
      )}
      {st.kind === 'blocked' && (
        <>
          <div className="ag-free-wait" role="status" data-testid="free-wait">
            <Icon name="out" />
            <span>
              <b>Your browser kept the OpenRouter {span} from opening.</b>Open it from here instead.
            </span>
            <button ref={cancelRef} type="button" className="ag-text-btn" onClick={cancel} data-testid="free-cancel">
              Cancel
            </button>
          </div>
          <div className="ag-free-actions">
            {/* The same address, as a real link the browser opens on the member's own click. */}
            <a className="ag-btn primary" href={st.url} target="_blank" rel="noopener" onClick={() => {
                // After the browser has followed it: the link stays in the page for its own click.
                const state = st.state;
                setTimeout(() => setSt({ kind: 'waiting', state }), 0);
              }}
              data-testid="free-open"
            >
              Open OpenRouter
            </a>
          </div>
        </>
      )}
      {st.kind === 'checking' && (
        <div className="ag-free-wait" role="status" data-testid="free-wait">
          <Icon name="key" />
          <span>
            <b>Checking the key…</b>OpenRouter made a key for this desk, and your desk is checking it.
          </span>
        </div>
      )}
      {st.kind === 'failed' && (
        <>
          <p className="ag-error" role="alert" data-testid="free-error">
            {st.text}
          </p>
          {connectButton('Connect again')}
        </>
      )}
    </section>
  );
}
