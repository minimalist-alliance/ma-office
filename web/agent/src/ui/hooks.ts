// Reading the client into React. Streams batch to one render per display frame, so a fast reply costs at most
// 60 renders a second, each touching only the message that changed (model/conversation.ts).
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps, ConversationEvent, KeyMeta, LimitsView } from '../client/types';
import type { LookTheme } from '../look/tones';
import { fromBase64 } from '../model/png';
import { retryDelayMs } from '../model/agents';
import { applyEvents, EMPTY_THREAD, type Thread } from '../model/conversation';

/**
 * What a draft or a form holds that closing the page would lose, told to the app (`AgentAppProps.onUnsaved`), which tells its
 * host. Outside the app it goes nowhere.
 */
export const UnsavedContext = createContext<(key: string, on: boolean) => void>(() => undefined);

/** Says this holds something unsaved while `on`, and lets go when it unmounts. */
export function useUnsaved(on: boolean): void {
  const report = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    report(id, on);
  }, [report, id, on]);
  useEffect(() => () => report(id, false), [report, id]);
}

/**
 * The desk's agents: the topic for every change, and one read for the start. The read is what says desk-agent isn't running,
 * since a subscription made then stays quiet until it's back, and a second listener on a link gets no first event.
 */
export function useAgents(client: AgentClient): { value: Agent[] | null; caps: AgentCaps | null; error: unknown; reload: () => void } {
  const [value, setValue] = useState<Agent[] | null>(null);
  const [caps, setCaps] = useState<AgentCaps | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      client.watchAgents((agents, nextCaps) => {
        setValue(agents);
        if (nextCaps) setCaps(nextCaps);
        setError(null);
      }),
    [client],
  );
  useEffect(() => {
    let live = true;
    client.listAgents().then(
      (agents) => {
        if (!live) return;
        setValue((cur) => cur ?? agents); // the topic's word is newer
        setError(null);
      },
      (e: unknown) => {
        if (live) setError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [client, tick]);
  // The list came and `agent.state` carried no caps: ask once. A desk from before task 49 has neither, and says `not_found`.
  const askedCaps = useRef<AgentClient | null>(null);
  const needCaps = value !== null && caps === null;
  useEffect(() => {
    if (!needCaps || askedCaps.current === client) return undefined;
    askedCaps.current = client;
    let live = true;
    client.caps().then(
      (c) => live && setCaps((cur) => cur ?? c),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, needCaps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { value, caps, error, reload };
}

/** While `active`, `retry` every so often at a calm and growing pace, and not while the tab is hidden. */
export function useCalmRetry(active: boolean, retry: () => void): void {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (!active) return undefined;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      if (!document.hidden) retryRef.current();
      attempt += 1;
      timer = setTimeout(tick, retryDelayMs(attempt));
    };
    timer = setTimeout(tick, retryDelayMs(0));
    return () => clearTimeout(timer);
  }, [active]);
}

const frame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const t = setTimeout(fn, 16);
  return () => clearTimeout(t);
};

/** `parked`: the window can't be seen, so what arrives waits, and costs no render until it can. */
export function useThread(client: AgentClient, agentId: string | null, parked = false): Thread & { loaded: boolean } {
  const [state, setState] = useState<{ agentId: string | null; thread: Thread; loaded: boolean }>({ agentId, thread: EMPTY_THREAD, loaded: false });
  const parkedRef = useRef(parked);
  parkedRef.current = parked;
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!agentId) return undefined;
    let pending: ConversationEvent[] = [];
    let cancel: (() => void) | null = null;
    const flush = (): void => {
      cancel = null;
      const events = pending;
      pending = [];
      setState((s) => ({ agentId, thread: applyEvents(s.agentId === agentId ? s.thread : EMPTY_THREAD, events), loaded: true }));
    };
    const schedule = (): void => {
      if (!parkedRef.current) cancel ??= frame(flush);
    };
    resume.current = () => {
      if (pending.length) schedule();
    };
    const off = client.watchConversation(agentId, (e) => {
      if (e.type === 'snapshot') pending = []; // it replaces all that came before it
      pending.push(e);
      schedule();
    });
    return () => {
      off();
      cancel?.();
      resume.current = null;
    };
  }, [client, agentId]);
  useEffect(() => {
    if (!parked) resume.current?.();
  }, [parked]);
  const current = state.agentId === agentId ? state : { thread: EMPTY_THREAD, loaded: false };
  return { ...current.thread, loaded: current.loaded };
}

/** A read that's done again when `deps` change or `reload()` is called. Keeps the last value while reloading. */
export function useRead<T>(read: () => Promise<T>, deps: unknown[]): { value: T | null; error: unknown; reload: () => void; set: (v: T) => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let live = true;
    readRef.current().then(
      (v) => live && (setValue(v), setError(null)),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { value, error, reload, set: setValue };
}

export function useKeys(client: AgentClient) {
  return useRead<KeyMeta[]>(() => client.listKeys(), [client]);
}

export function useLimits(client: AgentClient, agentId: string | null, version: unknown) {
  return useRead<LimitsView | null>(() => (agentId ? client.getLimits(agentId) : Promise.resolve(null)), [client, agentId, version]);
}

const THEMES: readonly LookTheme[] = ['light', 'dusk', 'dark'];

/** The theme the marks are drawn for: `<html data-theme>`, which the Desk and the demo both set, or Light. */
export function useLookTheme(): LookTheme {
  const read = (): LookTheme => {
    const t = typeof document === 'undefined' ? null : document.documentElement.dataset['theme'];
    return THEMES.includes(t as LookTheme) ? (t as LookTheme) : 'light';
  };
  const [theme, setTheme] = useState<LookTheme>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * An uploaded icon's mask, as a `blob:` URL that lives in this page alone (multi-agent.md section 7: served only to the member).
 * One fetch per agent and version, per client; a new version revokes the old URL.
 */
const masks = new WeakMap<AgentClient, Map<string, { version: number; url: Promise<string | null> }>>();

export function maskUrl(client: AgentClient, agentId: string, version: number): Promise<string | null> {
  let byAgent = masks.get(client);
  if (!byAgent) masks.set(client, (byAgent = new Map()));
  const held = byAgent.get(agentId);
  if (held && held.version === version) return held.url;
  if (held) void held.url.then((u) => u && URL.revokeObjectURL(u));
  const url = client.getIcon(agentId).then(
    (icon) => URL.createObjectURL(new Blob([fromBase64(icon.png).slice()], { type: 'image/png' })),
    () => null,
  );
  byAgent.set(agentId, { version, url });
  return url;
}

export function useMaskUrl(client: AgentClient, agent: Pick<Agent, 'id' | 'look'> | null): string | null {
  const version = agent?.look?.icon === 'png' ? (agent.look.png ?? null) : null;
  const id = agent?.id ?? null;
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${id}:${version}`;
  useEffect(() => {
    if (id === null || version === null) return undefined;
    let live = true;
    void maskUrl(client, id, version).then((url) => live && setState({ key, url }));
    return () => {
      live = false;
    };
  }, [client, id, version, key]);
  return version !== null && state?.key === key ? state.url : null;
}
