// "Desk style" in a desk's menu (the owner's desk textures): a swatch per style in the current theme, the desk's own
// checked, the default until the member picks another. Choosing one saves it at once, in the desk's layout (which
// follows the member, `shell/layoutSync.ts`), redraws the desk behind the menu, and says a quiet "Saved" for 1.5 s in place of the
// chosen style's name, which sits on the right of the label in secondary text. The menu stays open, so a member can try another. Shown only when there are two styles or more.
//
// Keys: the row is one stop for the menu's Up and Down, on the swatch last focused, the checked one to begin with.
// Left and Right move along it, Home and End go to its ends, and Enter or Space chooses. Each swatch is a
// `menuitemradio` named for its style, in a group named "Desk style".
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { deskStyleOf, deskStyles, type DeskStyleLook } from '../theme/deskStyles';
import { useTheme } from '../theme/themeStore';
import { setDeskStyle } from '../state/layoutStore';

/** How long "Saved" stays. */
const SAID_MS = 1500;

/** A swatch shows the style as a desk at 100 % has it: one desk unit to a CSS pixel. */
function swatchLook(look: DeskStyleLook): CSSProperties {
  const tex = look.texture;
  if (!tex) return { backgroundColor: look.base };
  return {
    backgroundColor: look.base,
    backgroundImage: `url("${tex.src}")`,
    backgroundSize: `${tex.width / tex.density}px ${tex.height / tex.density}px`,
  };
}

export function DeskStylePicker({ deskId, stored }: { deskId: string; stored: string | undefined }) {
  const theme = useTheme((s) => s.resolved);
  const styles = deskStyles();
  const chosen = deskStyleOf(stored).id;
  const [at, setAt] = useState(() => Math.max(0, styles.findIndex((s) => s.id === chosen)));
  const [said, setSaid] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    if (!said) return undefined;
    const timer = window.setTimeout(() => setSaid(0), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [said]);

  const choose = (id: string): void => {
    if (!setDeskStyle(deskId, id)) return;
    // A second choice inside the 2 s clears the line first, so it's said again.
    setSaid(0);
    requestAnimationFrame(() => setSaid((n) => n + 1));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = styles.length - 1;
    const to = e.key === 'ArrowRight' ? Math.min(last, at + 1) : e.key === 'ArrowLeft' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (to < 0) return;
    // Home and End are the row's here: the menu leaves them to it (`DeskMenu.tsx`).
    e.preventDefault();
    setAt(to);
    rowRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[to]?.focus();
  };

  return (
    <div className="desk-style" role="group" aria-labelledby={labelId}>
      <div className="desk-style-head">
        <span id={labelId}>Desk style</span>
        {/* The chosen style's name, and "Saved" in its place for a moment after a pick. The status is there before it has
            anything to say, so a screen reader hears "Saved" arrive and never the name. */}
        <span className="desk-style-saved">
          <span role="status" data-testid="desk-style-status">{said ? 'Saved' : ''}</span>
          {!said && <span data-testid="desk-style-name">{deskStyleOf(stored).name}</span>}
        </span>
      </div>
      <div ref={rowRef} className="desk-style-row" onKeyDown={onKey}>
        {styles.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="menuitemradio"
            aria-checked={s.id === chosen}
            aria-label={s.name}
            title={s.name}
            tabIndex={-1}
            className="desk-style-swatch"
            data-style={s.id}
            {...(i === at ? { 'data-current': '' } : {})}
            style={swatchLook(s.looks[theme])}
            onFocus={() => setAt(i)}
            onClick={() => choose(s.id)}
          />
        ))}
      </div>
    </div>
  );
}
