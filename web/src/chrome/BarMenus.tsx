// The bars' two menu buttons in short-viewport mode (the accessibility audit's finding 6, the Product Designer's spec; under
// 400 CSS px high, `useIsShort`): the scope switch folded into one button that names the current scope (`TopBar.tsx`), and
// the zoom folded into one button that shows the level (`BottomBar.tsx`, which writes the level as it writes the zoom
// group's). Only the button is in the first load: what an open one does (its panel, its keys, a press outside, Esc, the
// keyboard's way back) is the top bar's popovers chunk's (`BarPanels.tsx`), fetched at idle, so a panel opened sooner shows
// as the chunk lands, with the keyboard in it. Above 400 px the bars keep the segmented switch and the zoom group.
import { useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { useOnDemand } from '../lib/onDemand';
import { popovers } from './popoversChunk';

export interface PanelProps {
  btn: RefObject<HTMLButtonElement | null>;
  shut: () => void;
}

/**
 * The scope's (`ScopeList`, a menu, in `.scope-menu`) or the zoom's (`ZoomPanel`, a dialog, in `.zoom-menu`). Its words are
 * its name (`children`); every other prop goes to the panel, which takes the keyboard as it opens.
 */
export function BarMenu({ panel, children, ...more }: { panel: 'ScopeList' | 'ZoomPanel'; children: ReactNode; [prop: string]: unknown }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const Panel = useOnDemand(popovers, open && 'open')?.[panel] as ComponentType<PanelProps> | undefined;
  const zoom = panel === 'ZoomPanel';
  return (
    <div className={zoom ? 'menu-wrap zoom-menu' : 'menu-wrap scope-menu'}>
      <button ref={btn} type="button" className="chip-btn" aria-haspopup={zoom ? 'dialog' : 'menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open && Panel && <Panel btn={btn} shut={() => setOpen(false)} {...more} />}
    </div>
  );
}
