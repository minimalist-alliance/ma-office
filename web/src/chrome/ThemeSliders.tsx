// The account menu's two theme sliders, under the theme picker (the owner, Nov 14: "a blue adjuster slider and a contrast
// slider", in place of the old "Plain background"; his pick of the Designer's sheet: blue from grey to today's, and the
// sheet's contrast range). One setting for the account, shared with the Forums (ma-platform contract appearance.md).
// Each works in Light, Zen and Dark; the default is today's office exactly. The colour math and the save are their own
// chunk (`theme/tune/engine.ts`), fetched when this panel opens; this file only draws the controls: the two sliders, and
// "Reset" beside the Theme label while either is off its default (on that line, so nothing below it moves).
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { onTuneTarget, tuneTarget } from '../theme/tune/apply';

type Engine = typeof import('../theme/tune/engine');

let loading: Promise<Engine> | null = null;
const load = (): Promise<Engine> => (loading ??= import('../theme/tune/engine'));

function useEngine(): Engine | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((m) => live && setEngine(m));
    return () => {
      live = false;
    };
  }, []);
  return engine;
}

const useTune = (): { blue: number; contrast: number } => useSyncExternalStore(onTuneTarget, tuneTarget);

const blueWords = (v: number): string => (v === 100 ? '100 percent, the default' : v === 0 ? '0 percent, grey' : `${v} percent`);
const contrastWords = (v: number): string => (v === 50 ? '50 percent, the default' : v < 50 ? `${v} percent, softer` : `${v} percent, sharper`);
const at = (v: number): CSSProperties => ({ '--ma-range-at': v / 100 }) as CSSProperties;

/** "Reset", for the Theme label's line: both sliders back to today's, eased. */
export function ThemeTuneReset() {
  const tune = useTune();
  const engine = useEngine();
  if (tune.blue === 100 && tune.contrast === 50) return null;
  return (
    <button type="button" className="theme-tune-reset" disabled={!engine} aria-label="Reset blue and contrast" onClick={() => engine?.change({ blue: 100, contrast: 50 }, true)}>
      Reset
    </button>
  );
}

export function ThemeSliders() {
  const tune = useTune();
  const engine = useEngine();
  return (
    <div className="theme-tune" data-testid="theme-tune">
      <label className="theme-tune-row">
        <span className="theme-tune-name">Blue</span>
        <input
          id="theme-tune-blue"
          type="range"
          className="ma-range theme-tune-slider"
          style={at(tune.blue)}
          min={0}
          max={100}
          step={1}
          value={tune.blue}
          disabled={!engine}
          aria-valuetext={blueWords(tune.blue)}
          onChange={(e) => engine?.change({ blue: Number(e.currentTarget.value) })}
        />
      </label>
      <label className="theme-tune-row">
        <span className="theme-tune-name">Contrast</span>
        <input
          id="theme-tune-contrast"
          type="range"
          className="ma-range theme-tune-slider"
          style={at(tune.contrast)}
          min={0}
          max={100}
          step={1}
          value={tune.contrast}
          disabled={!engine}
          aria-valuetext={contrastWords(tune.contrast)}
          onChange={(e) => engine?.change({ contrast: Number(e.currentTarget.value) })}
        />
      </label>
    </div>
  );
}
