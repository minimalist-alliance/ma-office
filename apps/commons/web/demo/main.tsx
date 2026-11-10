// The standalone page: one Commons window on a desk-like ground, joined to the stand-in guild
// server that serves this page (`../server -dev`, `npm run demo`). URL options: ?name=Ana,
// ?theme=light|dusk|dark, ?frame=0 (no window frame), ?guild=<the guild's name on screen>, and who
// the stand-in deskd says you are: ?role=lead|officer|member, ?grants=moderate,manage_spaces,
// ?badge=officer|lead, ?member=<id>. ?link=channel (the default) goes the way a guild desk does,
// through a stand-in for deskd's relay; ?link=ws is the plain -dev WebSocket (?room=<id> picks a room).
import { THEME_KEY, savedTheme, type DemoTheme } from './boot.ts';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'virtual:ma-desk-themes.css';
import 'virtual:ma-commons-themes.css';
import '../src/ui/commons.css';
import './demo.css';
import { Commons } from '../src/ui/Commons.tsx';
import { RoomClient } from '../src/room/client.ts';
import { WebSocketLink, type CommonsLink } from '../src/net/link.ts';
import { DataChannelLink, WebSocketChannel } from '../src/net/channelLink.ts';
import type { BoardEngine } from '../src/board/engine.ts';
import { putItem, type Item } from '../src/board/model.ts';
import { LOCAL } from '../src/room/client.ts';

const NAME_KEY = 'ma.commons-demo.name';
const q = new URLSearchParams(location.search);

declare global {
  interface Window {
    commons?: {
      client: RoomClient;
      engine: BoardEngine | null;
      channel: WebSocketChannel | null;
      /** For the screenshot script: puts items on the board that's up, as this member. */
      put: (items: (Omit<Item, 'id' | 'p'> & { p?: number[] })[]) => void;
    };
  }
}

function savedName(): string {
  const n = q.get('name');
  if (n) return n;
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<DemoTheme>(savedTheme());
  const pick = (t: DemoTheme) => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // Not remembered.
    }
  };
  return (
    <div className="demo-themes" role="radiogroup" aria-label="Theme">
      {(['light', 'dusk', 'dark'] as DemoTheme[]).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} onClick={() => pick(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

function Room({ name }: { name: string }) {
  const [client] = useState(() => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const who = new URLSearchParams({ name });
    for (const k of ['role', 'grants', 'badge', 'member']) {
      const v = q.get(k);
      if (v) who.set(k, v);
    }
    let link: CommonsLink;
    let channel: WebSocketChannel | null = null;
    if (q.get('link') === 'ws') {
      who.set('room', q.get('room') ?? 'commons');
      link = new WebSocketLink(`${scheme}://${location.host}/ws?${who}`);
    } else {
      channel = new WebSocketChannel(`${scheme}://${location.host}/dev/channel?${who}`);
      link = new DataChannelLink(channel);
    }
    const c = new RoomClient(link, { name });
    // For tests and the perf scripts. Set here, before Commons' own effects hand over the engine.
    const put = (items: (Omit<Item, 'id' | 'p'> & { p?: number[] })[]) =>
      c.doc?.transact(() => {
        for (const it of items) putItem(c.doc!, { ...it, ...(it.p ? { p: new Float32Array(it.p) } : {}) } as Omit<Item, 'id'>);
      }, LOCAL);
    window.commons = { client: c, engine: null, channel, put };
    return c;
  });
  useEffect(() => {
    const t = setInterval(() => client.ping(), 2000);
    return () => clearInterval(t);
  }, [client]);
  return (
    <Commons
      client={client}
      title={q.get('guild') ?? 'Commons'}
      channelsOpen={q.get('channels') !== '0'}
      chatOpen={q.get('chat') !== '0'}
      onEngine={(e) => {
        if (window.commons) window.commons.engine = e;
      }}
    />
  );
}

function NameForm({ onName }: { onName: (n: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form
      className="demo-name"
      onSubmit={(e) => {
        e.preventDefault();
        const n = v.trim();
        if (!n) return;
        try {
          localStorage.setItem(NAME_KEY, n);
        } catch {
          // Asked again next time.
        }
        onName(n);
      }}
    >
      <h1>Commons</h1>
      <p>The demo has no sign-in. What should the room call you?</p>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="Your name" maxLength={40} aria-label="Your name" />
      <button type="submit" disabled={!v.trim()}>
        Continue
      </button>
    </form>
  );
}

function Demo() {
  const [name, setName] = useState(savedName());
  const framed = q.get('frame') !== '0';
  const body = name ? <Room name={name} /> : <NameForm onName={setName} />;
  if (!framed) return <div className="demo-bare">{body}</div>;
  return (
    <div className="demo-ground">
      <div className="demo-window">
        <div className="demo-titlebar">
          <span className="demo-title">Commons</span>
          <ThemeSwitch />
        </div>
        <div className="demo-content">{body}</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
