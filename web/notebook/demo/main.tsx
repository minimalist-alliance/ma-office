// The demo page: the Notebook in a window like the prototype's, on fake notes, in this browser only.
//   ?fixture=long[&words=150000&pages=300]  the perf fixture (its own database)
//   ?theme=light|dusk|dark                   start in a theme
//   ?fresh=1                                 start from a clean database
import { THEME_KEY, savedTheme, type DemoTheme } from './boot.ts';
import '@fontsource-variable/nunito/wght.css';
import 'virtual:ma-brand-themes.css';
import 'virtual:ma-notebook-themes.css';
import '../src/ui/notebook.css';
import './demo.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalBackend } from '../src/local/localBackend.ts';
import { NotebookGlyph, Icon } from '../src/ui/icons.tsx';
import { Notebook } from '../src/ui/Notebook.tsx';
import { seedDemo, seedLong } from './seed.ts';

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') === 'long' ? 'long' : 'demo';
const DB = fixture === 'long' ? 'ma-notebook-perf' : 'ma-notebook-demo';
const STATE_KEY = `ma.notebook-demo.ui.${fixture}`;

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

async function start(): Promise<LocalBackend> {
  if (params.get('fresh') === '1') {
    await deleteDb(DB);
    try {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(COLOR_KEY);
    } catch {
      // nothing to forget
    }
  }
  const backend = new LocalBackend({ dbName: DB });
  await backend.ready();
  if (!backend.tree().notebooks.length) {
    if (fixture === 'long') await seedLong(backend, Number(params.get('words') ?? 150_000), Number(params.get('pages') ?? 300));
    else await seedDemo(backend);
  }
  // Closing the tab ends the editing session, as design 5.3 has it.
  addEventListener('pagehide', () => void backend.flush());
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void backend.flush();
  });
  (window as unknown as { __nb: LocalBackend }).__nb = backend;
  return backend;
}

const THEMES: { id: DemoTheme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'dark', label: 'Dark' },
];

/** The color last used in a menu: the Desk app keeps it in the member's prefs; the demo, in this browser. */
const COLOR_KEY = 'ma.notebook-demo.color';
function savedColor(): string | null {
  try {
    return localStorage.getItem(COLOR_KEY);
  } catch {
    return null;
  }
}

function Demo({ backend }: { backend: LocalBackend }) {
  const [theme, setTheme] = useState<DemoTheme>(savedTheme());
  const [lastColor, setLastColor] = useState<string | null>(savedColor);
  const rememberColor = (id: string) => {
    setLastColor(id);
    try {
      localStorage.setItem(COLOR_KEY, id);
    } catch {
      // Not remembered, still used.
    }
  };
  const choose = (t: DemoTheme) => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // Not remembered, still applied.
    }
  };
  const reset = async () => {
    await backend.close();
    await deleteDb(DB);
    try {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(COLOR_KEY);
    } catch {
      // nothing to forget
    }
    location.reload();
  };
  return (
    <div className="demo-ground">
      <div className="demo-top">
        <span className="demo-brand">Notebook demo</span>
        <div className="nb-seg ma-nb-portal" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className={theme === t.id ? 'on' : ''} onClick={() => choose(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="demo-window" role="dialog" aria-label="Notebook, Personal desk">
        <Notebook
          backend={backend}
          stateKey={STATE_KEY}
          lastColor={lastColor}
          onLastColorChange={rememberColor}
          headerStart={
            <h2 className="demo-title">
              <NotebookGlyph />
              Notebook
              <span className="demo-desk">Personal desk</span>
            </h2>
          }
          headerEnd={
            <button type="button" className="nb-icon-btn demo-close" aria-label="Close Notebook" title="The demo has nowhere to close to">
              <Icon name="close" />
            </button>
          }
        />
      </div>
      <p className="demo-foot">
        Fake notes, kept only in this browser. Nothing is sent anywhere.{' '}
        <button type="button" className="nb-text-btn" onClick={() => void reset()}>
          Reset the demo
        </button>
      </p>
    </div>
  );
}

void start().then((backend) => {
  const el = document.getElementById('root');
  if (!el) throw new Error('#root is missing');
  createRoot(el).render(
    <StrictMode>
      <Demo backend={backend} />
    </StrictMode>,
  );
});
