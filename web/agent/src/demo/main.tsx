// The demo page: the Agent app on the mock, inside a frame like the Desk's app window, with the Desk's three
// themes. Nothing here touches the network or the browser's storage. `?fixture=fresh|ready|limit`,
// `?theme=light|dusk|dark`, `?size=wide|small`, `?speed=fast` (the tests).
import '@fontsource-variable/inter/wght.css';
import 'virtual:ma-themes.css';
import './demo.css';
import '../ui/agent.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentApp } from '../ui/AgentApp';
import { MockAgentClient } from '../mock/mockAgentClient';
import { LookSheet } from './LookSheet';
import { accountFromQuery, capsFromQuery, FIXTURES, type FixtureName } from '../mock/fixtures';

type Theme = 'light' | 'dusk' | 'dark';
const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'dark', label: 'Dark' },
];
const FIXTURE_LABEL: Record<FixtureName, string> = { fresh: 'New desk', ready: 'In use', limit: 'At its limit', tools: 'Tools and approvals' };

const params = new URLSearchParams(location.search);
const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const v = params.get(name) as T | null;
  return v && allowed.includes(v) ? v : fallback;
};
const fixture = pick<FixtureName>('fixture', FIXTURES, 'ready');
const fast = params.get('speed') === 'fast';
const initialTheme = pick<Theme>('theme', ['light', 'dusk', 'dark'], matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset['theme'] = initialTheme;

const SUGGESTIONS = ['Set up two agents', 'What can you do?', 'Show me a long reply', 'How do my limits work?'];

// `?keysLast=1`: a desk from ADR 0042 and 0043, whose limits layer desk, account, default; `accountDay`, `accountMonth` (dollars, or
// `none`) and `accountZone` say what the account sets. `?zoneAudit=1`: a `desk-agent` that audits a zone-only set as `limits.timezone`.
const account = accountFromQuery(params);
// `?agentCap=3` and the other caps (multi-agent.md section 2): the tier's values, to reach a cap in the demo.
const caps = capsFromQuery(params);
const client = new MockAgentClient({ fixture, keysLast: params.get('keysLast') === '1', zoneAudit: params.get('zoneAudit') === '1', ...(account ? { account } : {}), ...(caps ? { caps } : {}), ...(fast ? { latencyMs: 15, streamMs: 8 } : {}) });
// `?focus=researcher`: one agent's own window, as the Desk opens it from that agent's tile.
const focus = params.get('focus');
// For the tests: they search what the mock holds for a key that mustn't be there.
(window as unknown as { __maAgentMock: MockAgentClient }).__maAgentMock = client;

function go(next: Record<string, string>): void {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(next)) p.set(k, v);
  location.search = p.toString();
}

function Demo() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [showBadges, setShowBadges] = useState(true);
  const [size, setSize] = useState(params.get('size') === 'small' ? 'small' : 'wide');
  const choose = (t: Theme): void => {
    document.documentElement.dataset['theme'] = t;
    setTheme(t);
  };
  return (
    <div className="demo">
      <header className="demo-bar">
        <div className="demo-title">
          <b>Agent app</b>
          <span>Demo on a mock desk. No network, no model, no real keys.</span>
        </div>
        <div className="demo-controls">
          <div className="demo-seg" role="radiogroup" aria-label="Demo desk">
            {FIXTURES.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={f === fixture} className={f === fixture ? 'on' : ''} onClick={() => go({ fixture: f })}>
                {FIXTURE_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="demo-seg" role="radiogroup" aria-label="View">
            {(['app', 'look'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={(params.get('view') === 'look') === (v === 'look')} className={(params.get('view') === 'look') === (v === 'look') ? 'on' : ''} onClick={() => go({ view: v })}>
                {v === 'app' ? 'Agent' : 'Look'}
              </button>
            ))}
          </div>
          <div className="demo-seg" role="radiogroup" aria-label="Window size">
            {(['wide', 'small'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={s === size} className={s === size ? 'on' : ''} onClick={() => setSize(s)}>
                {s === 'wide' ? 'Wide' : 'Small'}
              </button>
            ))}
          </div>
          <div className="demo-seg" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={t.id === theme} className={t.id === theme ? 'on' : ''} onClick={() => choose(t.id)} data-testid={`theme-${t.id}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {params.get('view') === 'look' ? (
        <main className="demo-stage">
          <LookSheet theme={theme} />
        </main>
      ) : (
      <main className="demo-stage">
        <div className={`demo-window ${size}`} role="dialog" aria-label="Agent, Personal desk">
          <div className="demo-window-head">
            <span className="demo-glyph" aria-hidden="true" />
            <span className="demo-window-title">
              Agent <span>{client.deskName} desk</span>
            </span>
          </div>
          <div className="demo-window-body">
            <AgentApp client={client} deskName={client.deskName} showBadges={showBadges} onShowBadgesChange={setShowBadges} suggestions={SUGGESTIONS} focusAgentId={focus} theme={theme} />
          </div>
        </div>
      </main>
      )}
    </div>
  );
}

const el = document.getElementById('ma-root');
if (!el) throw new Error('#ma-root is missing');
createRoot(el).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
