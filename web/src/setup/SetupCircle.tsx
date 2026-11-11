// The setup circle (S-121): in the bottom bar just left of the usage circle, the same size and look, so the two read as a
// pair; where there's no usage circle it takes that place. One segment per step, filled as each is done or skipped; a
// small checklist glyph in the middle. After setup it holds What's new (a plain dot) and the upgrade offer (an up-arrow), or
// it isn't there. It never opens by itself, speaks or moves but once, when a step fills (300 ms). All of it is in the
// setup chunk (`core.ts`, fetched by `door.ts`). Under 360 px the bar has no room for it, so the account menu's row takes its place.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTierNames } from '../platform/useTiers';
import { Icon } from '../chrome/icons';
import { Switch } from '../chrome/Segmented';
import { MENU_AFTER, MENU_SETUP, offerTitle, SHOW_CIRCLE, WHATS_NEW } from './labels';
import { useSetupAvailable, useSetupModel, type SetupModel } from './model';
import { readHidden, setCircleHidden, useMirrorTick } from './prefs';
import { setupLabel, type Circle } from './steps';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import './setup.css';

import SetupPanel from './SetupPanel';

/** Narrower than this, the bottom row has no room for a second circle (the bars rule, 320 px). */
const NARROW = '(max-width: 359px)';
function useNarrow(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener('change', on);
      return () => m.removeEventListener('change', on);
    },
    () => window.matchMedia(NARROW).matches,
  );
}

/** 2 px between segments, on a ring of radius 9 in a 24 px box: in `pathLength` 100 units. */
const GAP = (2 / (2 * Math.PI * 9)) * 100;

function Glyph({ kind }: { kind: 'setup' | 'new' | 'offer' }) {
  if (kind === 'new') return <circle className="su-glyph-dot" cx="12" cy="12" r="2.5" />;
  if (kind === 'offer') return <path className="su-glyph-line" d="M12 15.5V8.7M9.2 11.3 12 8.5l2.8 2.8" />;
  return <path className="su-glyph-line" d="M8.6 9.6l.9.9 1.6-1.7M12.9 9.8h2.7M8.6 13.9l.9.9 1.6-1.7M12.9 14.1h2.7" />;
}

/** One segment per step; `filled[i]` is step i done or skipped. */
export function SetupRing({ filled, glyph }: { filled: readonly boolean[] | null; glyph: 'setup' | 'new' | 'offer' }) {
  const n = filled?.length ?? 0;
  const seg = n ? (100 - n * GAP) / n : 100;
  return (
    <svg className="su-ring" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <g transform="rotate(-90 12 12)">
        {n === 0 && <circle className="su-track" cx="12" cy="12" r="9" pathLength={100} />}
        {filled?.map((on, i) => {
          const offset = -(GAP / 2 + i * (seg + GAP));
          return (
            <g key={i}>
              <circle className="su-track" cx="12" cy="12" r="9" pathLength={100} strokeDasharray={`${seg} ${100 - seg}`} strokeDashoffset={offset} />
              <circle className="su-seg" cx="12" cy="12" r="9" pathLength={100} strokeDasharray={`${on ? seg : 0} 100`} strokeDashoffset={offset} data-on={on || undefined} />
            </g>
          );
        })}
      </g>
      <Glyph kind={glyph} />
    </svg>
  );
}

function ringOf(circle: Circle, model: SetupModel): { filled: boolean[] | null; glyph: 'setup' | 'new' | 'offer' } {
  if (circle.kind === 'setup' || !model.progress || circle.kind === 'none') {
    const p = model.progress;
    return { filled: p ? p.steps.map((id) => model.prefs.done.includes(id) || model.prefs.skipped.includes(id)) : null, glyph: 'setup' };
  }
  return { filled: null, glyph: circle.whatsNew ? 'new' : 'offer' };
}

/** Where the keyboard goes when the circle itself goes: the usage circle beside it, else the account button. */
function focusAfterGone(): void {
  const next = document.querySelector<HTMLElement>('[data-testid="bandwidth-button"]') ?? document.querySelector<HTMLElement>('.account-btn');
  next?.focus({ preventScroll: true });
}

/** What the panel shows while open: what it opened on, so a last step settling says "Your office is set up." first. */
function usePanelView(open: boolean, circle: Circle): 'setup' | 'after' | null {
  const [held, setHeld] = useState<'setup' | 'after' | null>(null);
  const live = circle.kind === 'setup' ? 'setup' : circle.kind === 'after' ? 'after' : null;
  useEffect(() => {
    if (!open) setHeld(null);
    else if (held === null) setHeld(live);
  }, [open, live, held]);
  return open ? (held ?? live) : null;
}

export function SetupCircle() {
  const model = useSetupModel();
  const names = useTierNames();
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const view = usePanelView(open, model.circle);
  const shows = model.circle.kind !== 'none' || (open && view === 'setup' && !model.hidden && !!model.progress);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  if (narrow || !shows) return null;
  const circle = model.circle;
  const ring = view === 'setup' ? ringOf({ kind: 'setup', progress: model.progress! }, model) : ringOf(circle, model);
  const label = circle.kind === 'after' ? (circle.whatsNew ? WHATS_NEW : circle.offer ? offerTitle(circle.offer, names) : WHATS_NEW) : model.progress ? setupLabel(model.progress) : '';

  const close = ({ back, gone }: { back?: boolean; gone?: boolean }): void => {
    setOpen(false);
    if (gone) requestAnimationFrame(focusAfterGone);
    else if (back) btnRef.current?.focus();
  };

  return (
    <div
      ref={wrapRef}
      className="setup-circle"
      data-testid="setup-circle"
      data-kind={view ?? circle.kind}
      onKeyDown={(e) => {
        // The office's own keys act on Enter and Space outside its bars; here they're the controls'.
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close({ back: true });
        }
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className="su-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="setup-button"
        onClick={() => setOpen((o) => !o)}
      >
        <SetupRing filled={ring.filled} glyph={ring.glyph} />
      </button>
      {open && view && <SetupPanel model={model} view={view} onClose={close} id={panelId} />}
    </div>
  );
}

/**
 * In the account menu: "Show setup and what's new", on by default, for anyone with a tier where the circle is on. Off is
 * the circle hidden, everywhere the member signs in. Under 360 px, a row above it opens the same panel in the menu.
 */
export function SetupMenuItems() {
  const available = useSetupAvailable();
  const doc = useLayoutPrefs();
  useMirrorTick((s) => s.n);
  const hidden = readHidden(doc);
  const narrow = useNarrow();
  if (!available) return null;
  return (
    <>
      {narrow && !hidden && <SetupMenuRow />}
      <Switch id="pref-setup-circle" label={SHOW_CIRCLE} checked={!hidden} onChange={(v) => setCircleHidden(!v)} />
    </>
  );
}

function SetupMenuRow() {
  const model = useSetupModel();
  const [open, setOpen] = useState(false);
  const view = usePanelView(open, model.circle);
  const panelId = useId();
  if (model.circle.kind === 'none' && !(open && view === 'setup' && model.progress)) return null;
  return (
    <>
      <button
        type="button"
        className="menu-item menu-disclosure"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="menu-setup"
        onClick={() => setOpen((o) => !o)}
      >
        {model.circle.kind === 'after' ? MENU_AFTER : MENU_SETUP}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      </button>
      {open && view && (
        <div className="su-in-menu">
            <SetupPanel
              model={model}
              view={view}
              id={panelId}
              onClose={({ gone }) => {
                setOpen(false);
                // The row goes with the circle: the keyboard stays in the menu, on the switch that brings it back.
                if (gone) requestAnimationFrame(() => document.getElementById('pref-setup-circle')?.focus());
              }}
            />
        </div>
      )}
    </>
  );
}
