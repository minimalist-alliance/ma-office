// A link in a guild page (task 48): which of the member's own desks opens it. Its own chunk (`GuildLayer.tsx` fetches it
// when a link is pressed), out of the first load since `sub/mm-js-budget`.
import { useEffect, useRef } from 'react';
import { displayText } from '../browser/address';
import { openInDeskBrowser } from '../notebook/openLink';
import { ownDesks, useDeskStore } from '../state/deskStore';
import { clearLinkChoice } from './guildStore';
import { useEscape } from './useEscape';
import { OPEN_ON } from './words';

/** A link in a guild page: which of the member's own desks opens it. Only their Personal and Work desks are offered. */
export default function LinkChoice({ href }: { href: string }) {
  useDeskStore((s) => s.desks); // renders again when the list changes
  const own = ownDesks().filter((d) => (d.kind === 'personal' || d.kind === 'work') && d.vm !== 'held' && d.vm !== 'setting-up');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEscape(clearLinkChoice);
  const pick = (deskId: string): void => {
    clearLinkChoice();
    openInDeskBrowser(deskId, href);
  };
  return (
    <div className="guild-modal-away" onClick={clearLinkChoice}>
      <div
        className="guild-modal guild-link-choice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guild-link-title"
        data-testid="guild-link-choice"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="guild-link-title">Open this link on one of your desks</h2>
        <p className="guild-link-url">{displayText(href)}</p>
        <p className="guild-quiet-note">The Guild Desk has no Browser. The link opens in that desk's Browser, with its own sign-ins.</p>
        <div className="guild-modal-actions">
          {own.length === 0 && <p className="guild-quiet-note">You have no Personal or Work desk to open it on.</p>}
          {own.map((d, i) => (
            <button key={d.id} ref={i === 0 ? first : undefined} type="button" className="btn primary" onClick={() => pick(d.id)}>
              {d.kind === 'work' ? OPEN_ON.work : OPEN_ON.personal}
              {own.filter((o) => o.kind === d.kind).length > 1 ? ` (${d.name})` : ''}
            </button>
          ))}
          <button type="button" className="btn" onClick={clearLinkChoice}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
