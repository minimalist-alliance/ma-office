// "Background" in the account menu (ADR 0094), under Theme: None, then every scene in the manifest as a 16:9 swatch from
// its placeholder, the one on show checked, and its name on a line under the row. Choosing saves `prefs.background` in the
// layout document (it follows the member) and shows at once; no Undo, since the next pick is one. A lazy chunk beside
// `theme/backdrop.ts`, so the menu's code in the initial bundle is a label's worth.
//
// Keys: one radiogroup of radios with a roving tabindex: Left, Right, Up and Down move along it, Home and End to its ends,
// Enter or Space chooses. Each radio's accessible name is "Background: <scene>", so no test or assistive query for a theme
// ("Light", "Dark") lands on "Mountain light" or "Dark lake"; its title is the plain name. Shown only in a theme where a scene can show (`BACKGROUNDS_IN`) and once the manifest has been read.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { chooseBackground, loadScenes, useBackdrop } from '../theme/backdrop';
import { BACKGROUNDS_IN, NONE } from '../theme/backgrounds';
import { useTheme } from '../theme/themeStore';

export function BackgroundPicker() {
  const theme = useTheme((s) => s.resolved);
  const scenes = useBackdrop((s) => s.scenes);
  const shown = useBackdrop((s) => s.shown);
  const rowRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const options = [{ id: NONE, name: 'None', placeholder: '' }, ...(scenes ?? [])];
  const chosen = shown ?? NONE;
  // The row's one tab stop: the swatch last focused, the chosen one until then (the manifest may arrive after the first render).
  const [focused, setAt] = useState<number | null>(null);
  const at = focused ?? Math.max(0, options.findIndex((o) => o.id === chosen));

  useEffect(() => {
    void loadScenes();
  }, []);

  if (!scenes || !BACKGROUNDS_IN.includes(theme)) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = options.length - 1;
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    const to = forward ? Math.min(last, at + 1) : back ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    setAt(to);
    rowRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  const current = options.find((o) => o.id === chosen) ?? options[0]!;
  return (
    <div className="bg-picker" data-testid="background-picker">
      <p className="menu-label" id={labelId}>Background</p>
      <div ref={rowRef} className="bg-picker-row" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKey}>
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.id === chosen}
            aria-label={`Background: ${o.name}`}
            title={o.name}
            tabIndex={i === at ? 0 : -1}
            className="bg-swatch"
            data-background={o.id}
            style={o.placeholder ? { backgroundImage: `url("${o.placeholder}")` } : undefined}
            onFocus={() => setAt(i)}
            onClick={() => chooseBackground(o.id)}
          />
        ))}
      </div>
      <p className="bg-picker-name" data-testid="background-name">{current.name}</p>
    </div>
  );
}
