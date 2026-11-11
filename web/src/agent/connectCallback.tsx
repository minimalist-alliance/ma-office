// `/connect/openrouter`: where OpenRouter sends its window back after the member signs in (agent-free-key spec §2.2). A lazy
// chunk, routed before the session in `App.tsx`, with no desk connection, no store and no sign-in. It never holds a verifier and
// exchanges nothing: it takes `code` and `state` out of the address at once, relays them to the office tab that started the
// Connect over a BroadcastChannel, and stops once that tab says it has them. Only that tab, holding the verifier for that state,
// can turn the code into a key, so a stray or forged visit adds nothing anywhere. Nothing here logs or stores anything.
import { useEffect, useState } from 'react';
import { CALLBACK_PATH, CHANNEL, CONNECT_MS, isText, parseGot } from '../../agent/src/connect/channel';

/** What OpenRouter sent, taken once as the chunk loads, and the address cleared of it before anything else runs. */
function takeFromAddress(): { code: string | null; state: string | null } {
  const q = new URLSearchParams(window.location.search);
  const code = q.get('code');
  const state = q.get('state');
  if (window.location.search || window.location.hash) window.history.replaceState(null, '', CALLBACK_PATH);
  return { code: isText(code, 2048) ? code : null, state: isText(state) ? state : null };
}
const sent = takeFromAddress();

/** How often it says it again, for an office tab that was asleep (a phone) and wakes later. */
const EVERY_MS = 1000;
/** After this long with no answer, the office tab is asleep or closed: the page says go back to it. */
const QUIET_MS = 2000;

type Phase = 'handing' | 'connected' | 'asleep' | 'declined' | 'nothing';

const WORDS: Record<Phase, { title: string; line: string }> = {
  handing: { title: 'Connecting to your desk…', line: 'Keep this page open for a moment.' },
  connected: { title: 'Connected', line: 'You can close this page and go back to your office.' },
  asleep: { title: 'Go back to your office to finish', line: 'Keep this page open until it says connected.' },
  declined: { title: 'OpenRouter didn’t connect', line: 'Nothing was added. You can close this page.' },
  nothing: { title: 'Nothing was waiting for this', line: 'Nothing was added. You can close this page.' },
};

export default function ConnectCallback() {
  const [phase, setPhase] = useState<Phase>(sent.code ? 'handing' : 'declined');

  useEffect(() => {
    if (typeof BroadcastChannel !== 'function') {
      setPhase(sent.code ? 'nothing' : 'declined');
      return;
    }
    const ch = new BroadcastChannel(CHANNEL);
    const message = sent.code ? { code: sent.code, state: sent.state } : { state: sent.state, error: true };
    const started = Date.now();
    let done = false;
    const stop = (): void => {
      done = true;
      clearInterval(again);
      ch.close();
    };
    ch.onmessage = (e: MessageEvent) => {
      const got = parseGot(e.data);
      if (done || !got || got.got !== sent.state) return;
      stop();
      if (!sent.code) return;
      setPhase('connected');
      // Closes a window the office opened; a tab the member opened stays, saying it's connected.
      window.close();
    };
    const say = (): void => {
      if (done) return;
      const waited = Date.now() - started;
      if (waited >= CONNECT_MS) {
        stop();
        if (sent.code) setPhase('nothing');
        return;
      }
      if (sent.code && waited >= QUIET_MS) setPhase((p) => (p === 'handing' ? 'asleep' : p));
      ch.postMessage(message);
    };
    const again = setInterval(say, EVERY_MS);
    say();
    return stop;
  }, []);

  const words = WORDS[phase];
  return (
    <main className="calm-screen">
      <section className="or-cb" role="status" aria-live="polite" data-testid="connect-callback" data-phase={phase}>
        <p className="or-cb-brand">Minimalist Alliance</p>
        <h1>{words.title}</h1>
        <p>{words.line}</p>
      </section>
    </main>
  );
}
