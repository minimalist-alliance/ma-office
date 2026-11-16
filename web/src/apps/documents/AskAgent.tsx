// "Ask Lead" (the owner, Nov 15: Documents' ask "should really be ask desk agent, which should default to the primary agent"):
// one button that asks the desk's lead (ADR 0047), and beside it, when the desk has other agents, a small arrow with a menu to
// ask one of them instead. The agent's name is the desk's own text, shown as text.
import { useEffect, useId, useRef, useState } from 'react';
import type { RosterAgent } from '../../agent/roster';
import { W } from './words';

export function AskAgent({ agents, label, className, onAsk, up = false }: {
  /** The desk's agents, the lead first (`askableAgents`). */
  agents: readonly RosterAgent[];
  label(name: string): string;
  className: string;
  onAsk(agentId: string): void;
  /** The menu opens above (a bar at the foot), else below. */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const lead = agents[0];
  if (!lead) return null;
  const others = agents.slice(1);
  return (
    <span
      className="docs-ask"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className={className} data-testid="docs-ask" data-agent={lead.id} onClick={() => onAsk(lead.id)}>
        {label(lead.name)}
      </button>
      {others.length > 0 && (
        <button type="button" className={`${className} docs-ask-pick`} aria-label={W.askAnother} title={W.askAnother} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} data-testid="docs-ask-pick" onClick={() => setOpen(!open)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}
      {open && (
        <div id={menuId} className={`docs-ask-menu${up ? ' up' : ''}`} role="menu" aria-label={W.askAnother}>
          {others.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              data-agent={a.id}
              onClick={() => {
                setOpen(false);
                onAsk(a.id);
              }}
            >
              {label(a.name)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
