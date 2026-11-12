// The bottom bar while a desk or an app is moved or resized (a11y 2.5.7, the Product Designer's spec): a way that's no
// drag. The row is a quiet label naming what's edited ("Moving Personal", "Resizing Notebook"), which names the group too,
// then six buttons: four arrows that step the tile by one grid cell (`G.pitch`), then Keep and Restore, the hint's own
// verbs, which do what Enter and Esc do. Moving, the arrows move it; resizing, they move its bottom-right corner. It's in
// the popovers chunk (fetched at idle), so the first load keeps only the bar's switch to it. The keyboard comes to the
// first arrow as it shows and goes back to the tile as it goes; the keys stay the edit's own (`editKey`): the arrows step
// 8 units, Shift 40, Enter keeps, Esc restores, Tab keeps, and Space presses the button it's on.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { appLabel, focusBack } from '../shell/actions';
import { G } from '../canvas/layout';
import { finishEdit, step, type EditKind } from '../shell/arrange';
import { useDeskStore } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView } from '../state/viewStore';
import { Icon, type IconName } from './icons';

type Arrow = readonly [label: string, icon: IconName, dx: -1 | 0 | 1, dy: -1 | 0 | 1];
const ARROWS: Record<EditKind, readonly Arrow[]> = {
  move: [['Move left', 'chevronLeft', -1, 0], ['Move up', 'chevronUp', 0, -1], ['Move down', 'chevronDown', 0, 1], ['Move right', 'chevronRight', 1, 0]],
  resize: [['Narrower', 'chevronLeft', -1, 0], ['Shorter', 'chevronUp', 0, -1], ['Taller', 'chevronDown', 0, 1], ['Wider', 'chevronRight', 1, 0]],
};

/** What's edited, as the member knows it: a desk's own name, or an app's (`appLabel`, an agent's name included). */
function nameOf(id: string): string {
  const { desks } = useLayoutStore.getState();
  if (desks[id]) return useDeskStore.getState().desks.find((d) => d.id === id)?.name ?? 'desk';
  const desk = Object.values(desks).find((d) => d.items.some((i) => i.id === id));
  const item = desk?.items.find((i) => i.id === id);
  return desk && item ? appLabel(item.app, desk.id) : '';
}

export function EditBar({ kind }: { kind: EditKind }) {
  const ref = useRef<HTMLDivElement>(null);
  const labelId = useId();
  // The tile is the one the keyboard was on as the edit began.
  const [tile] = useState(() => getView().kbFocus ?? '');
  useLayoutEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    // Going while it has the keyboard (Keep, Restore, Enter, Esc, Tab), the keyboard goes back to the tile.
    return () => {
      if (el?.contains(document.activeElement)) focusBack(tile);
    };
  }, [tile]);
  return (
    <div ref={ref} className="edit-bar" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="edit-name">{`${kind === 'move' ? 'Moving' : 'Resizing'} ${nameOf(tile)}`}</span>
      {ARROWS[kind].map(([label, icon, dx, dy]) => (
        <button key={label} type="button" className="icon-btn chrome" aria-label={label} title={label} onClick={() => step(dx, dy, G.pitch)}>
          <Icon name={icon} />
        </button>
      ))}
      <button type="button" className="chip-btn edit-keep" onClick={() => finishEdit(true)}>Keep</button>
      <button type="button" className="chip-btn edit-restore" onClick={() => finishEdit(false)}>Restore</button>
    </div>
  );
}
