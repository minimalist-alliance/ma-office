// The info circle after "pass through us" (the owner, Nov 10). A toggletip: a press or tap opens and closes it, focus from the
// keyboard opens it, Esc closes it (and only it: Maia stays open), and so does focus or a press going elsewhere. The words
// are in a live region, so a screen reader reads them as they open.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MaiaIcon } from './icons';
import { KEPT_INFO_LABEL, keptInfo } from './keptLine';

export function useKeptInfo(retentionDays: number | null) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t && (buttonRef.current?.contains(t) || tipRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape' && open) {
      // Only the tip: the panel's own Esc hides Maia.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className="maia-kept-info"
      aria-label={KEPT_INFO_LABEL}
      aria-expanded={open}
      aria-controls={id}
      data-testid="maia-kept-info"
      onClick={() => setOpen((v) => !v)}
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) setOpen(true);
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <MaiaIcon name="info" size={14} />
    </button>
  );

  const tip = (
    // A press inside the words keeps focus on the circle, so it stays open.
    <div ref={tipRef} id={id} className="maia-kept-tip" role="status" data-testid="maia-kept-tip" onMouseDown={(e) => e.preventDefault()}>
      {open ? keptInfo(retentionDays) : null}
    </div>
  );

  return { button, tip, open };
}
