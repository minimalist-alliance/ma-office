// The shield's small pieces of brand (the Product Designer's brand pass, `design-drafts/maia-shield-brand/DIRECTION.md`): Maia's
// still in her soft field at the head of what she hands over, the desk's etched name as a source, and the kinds' line glyphs in
// the Lounge's rounded chips. Maia is the kit's still, unchanged; each theme's own file shows (the others never load: lazy and
// hidden). No stars or sparkles.
import maiaDark from '../../assets/maia/maia-dark-md.svg';
import maiaDusk from '../../assets/maia/maia-dusk-md.svg';
import maiaLight from '../../assets/maia/maia-light-md.svg';

/** Maia's still in her field: `sm` on the card, `md` on the catch-up, the sheet and What reaches you, `xs` beside her line on a paper. */
export function MaiaHalo({ size = 'sm' }: { size?: 'xs' | 'sm' | 'md' }) {
  return (
    <span className={`sh-maia ${size}`} aria-hidden="true">
      <img className="sh-th on-light" src={maiaLight} alt="" loading="lazy" draggable={false} />
      <img className="sh-th on-zen" src={maiaDusk} alt="" loading="lazy" draggable={false} />
      <img className="sh-th on-dark" src={maiaDark} alt="" loading="lazy" draggable={false} />
    </span>
  );
}

/** "Work · Writer": the desk's name as it's etched on the desk, then the rest. One part only: all of it as the desk's. */
export function Source({ text, className = '' }: { text: string; className?: string }) {
  const at = text.indexOf(' · ');
  const desk = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? '' : text.slice(at + 3);
  return (
    <p className={`sh-source ${className}`}>
      <span className="sh-etch">{desk}</span>
      {rest && <span className="sh-source-rest">{rest}</span>}
    </p>
  );
}

/** "6 held · nothing urgent": the first part carries the line, the rest is quieter. */
export function splitLine(text: string): [string, string] {
  const at = text.indexOf(' · ');
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 3)];
}

const PATHS: Record<string, string> = {
  // a tick in a circle: something waiting for the member's OK (not a shield: that's the Privacy shield's button)
  approval: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM8.6 12.2l2.3 2.3 4.5-4.6',
  // a page with lines: a result, a write-up, notes
  result: 'M7 3.5h7l3.5 3.5v13.5H7V3.5ZM14 3.5V7h3.5M9.5 11h5M9.5 14h5M9.5 17h3',
  notes: 'M7 3.5h7l3.5 3.5v13.5H7V3.5ZM14 3.5V7h3.5M9.5 11h5M9.5 14h5M9.5 17h3',
  // a speech bubble: messages
  message: 'M6.5 4.5h11a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H11l-4.5 3.5V16a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z',
  // a box with a tick: a to-do
  todo: 'M5 5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-13ZM8.5 12.2l2.4 2.4 4.6-4.8',
  // a clock: a reminder, something due
  due: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.4l2.8 1.8',
  // a moon: wake a sleeping desk
  wake: 'M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9Z',
};

/** A kind's glyph in its rounded chip (the welcome's "Here's what I heard" rows). Unknown kinds take the page. */
export function KindChip({ kind }: { kind: string }) {
  const d = PATHS[kind] ?? PATHS['result']!;
  return (
    <span className="sh-kind" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="sh-ico">
        <path d={d} />
      </svg>
    </span>
  );
}

/** The accent dot: only where something gets through (the line's, a let-through card's time). */
export function Dot() {
  return <span className="sh-dot" aria-hidden="true" />;
}
