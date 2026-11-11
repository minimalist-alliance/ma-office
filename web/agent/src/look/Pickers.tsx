// The two pickers. Both are radio groups with one tab stop (roving tabindex) and arrow keys, so a keyboard moves and chooses
// with the same keys.
import { useRef, type KeyboardEvent } from 'react';
import { AgentMark, IconPaths } from './AgentMark';
import { AGENT_ICONS, GRID, STROKE, currentIcon } from './icons';
import { FOREGROUND } from './foreground';
import { TONES, currentTone, toneColor, type LookTheme } from './tones';

/** Arrow keys, Home and End over `count` radios; returns the index to move to, or null. */
export function nextIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

function useRoving(count: number, ids: readonly string[], onChange: (id: string) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number): void => {
    const to = nextIndex(e.key, index, count);
    if (to === null) return;
    e.preventDefault();
    const id = ids[to];
    if (id !== undefined) onChange(id);
    refs.current[to]?.focus();
  };
  return { refs, onKeyDown };
}

export function IconPicker({ value: stored, onChange }: { value: string; onChange(id: string): void }) {
  const value = currentIcon(stored);
  const ids = AGENT_ICONS.map((i) => i.id);
  const { refs, onKeyDown } = useRoving(ids.length, ids, onChange);
  // An id outside the set (an uploaded picture, say) leaves the first icon as the tab stop.
  const stop = ids.includes(value) ? value : ids[0];
  return (
    <div className="ag-look-icons" role="radiogroup" aria-label="Icon">
      {AGENT_ICONS.map((icon, i) => (
        <button
          key={icon.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={icon.id === value}
          aria-label={icon.label}
          title={icon.label}
          tabIndex={icon.id === stop ? 0 : -1}
          className="ag-look-icon"
          onClick={() => onChange(icon.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <svg width={22} height={22} viewBox={`0 0 ${GRID} ${GRID}`} fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
            <IconPaths icon={icon.id} />
          </svg>
        </button>
      ))}
    </div>
  );
}

const WHEEL = 168;
const SWATCH = 28;

export function ToneWheel({ value: stored, theme, onChange }: { value: string; theme: LookTheme; onChange(id: string): void }) {
  const value = currentTone(stored);
  const ids = TONES.map((t) => t.id);
  const { refs, onKeyDown } = useRoving(ids.length, ids, onChange);
  const stop = ids.includes(value) ? value : ids[0];
  const r = (WHEEL - SWATCH) / 2;
  return (
    <div className="ag-look-wheel" role="radiogroup" aria-label="Color" style={{ width: WHEEL, height: WHEEL }}>
      {TONES.map((tone, i) => {
        const angle = (i / TONES.length) * 2 * Math.PI - Math.PI / 2;
        const left = WHEEL / 2 + r * Math.cos(angle) - SWATCH / 2;
        const top = WHEEL / 2 + r * Math.sin(angle) - SWATCH / 2;
        return (
          <button
            key={tone.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={tone.id === value}
            aria-label={tone.label}
            title={tone.label}
            tabIndex={tone.id === stop ? 0 : -1}
            className="ag-look-tone"
            style={{ left, top, width: SWATCH, height: SWATCH, background: toneColor(tone.id, theme), color: FOREGROUND }}
            onClick={() => onChange(tone.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {tone.id === value ? (
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            ) : null}
          </button>
        );
      })}
      <div className="ag-look-wheel-preview" aria-hidden="true">
        <AgentMark icon="nodes" tone={value} theme={theme} size={44} />
      </div>
    </div>
  );
}
