// What the office shows for guilds outside their windows (task 48): the one privacy line on a member's first Guild Desk, a
// notice for a guild they're no longer in, the choice of desk for a guild page's link, and the door to the guild settings
// sheet, which loads lazily. Notices go in the shell's stack (`.notices`), never in a bar.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { displayText } from '../browser/address';
import { Icon } from '../chrome/icons';
import { openInDeskBrowser } from '../notebook/openLink';
import { useTierNames } from '../platform/useTiers';
import { ownDesks, useDeskStore } from '../state/deskStore';
import { layoutMirrorWritable } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';
import { clearLinkChoice, useGuildStore } from './guildStore';
import { putAway } from './GuildWindow';
import { guildPanelId, isGuildPanel } from './panel';
import { useEscape } from './useEscape';
import { OPEN_ON } from './words';

const loadSheet = (): Promise<typeof import('./GuildSheet')> => import('./GuildSheet');
const GuildSheet = lazy(loadSheet);

export const PRIVACY_KEY = 'ma.guild.privacy.v1';

function privacySeen(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_KEY) === '1';
  } catch {
    return false;
  }
}

/** The line, with the tiers' names from the owner's setting, each on its own (`platform/tiers.ts`). */
export function privacyLine(lead: string, officer: string): string {
  return `The Guild Desk sees your connection's address, like any server. No member sees it, ${lead} and ${officer} included, and your agent conversations stay yours.`;
}

/** Once, on the first Guild Desk the member opens, until they put it away. Remembered in this browser. */
export function GuildPrivacy() {
  const names = useTierNames();
  const onGuild = useViewStore((s) => s.mode !== 'overview' && !!s.activeDesk && isGuildPanel(s.activeDesk));
  const guildWindow = useWindowStore((s) => Object.values(s.windows).some((w) => !w.closing && isGuildPanel(w.deskId)));
  const [seen, setSeen] = useState(privacySeen);
  if (seen || !(onGuild || guildWindow)) return null;
  const dismiss = (): void => {
    try {
      // Never after another tab signed this browser out (ISS-89 wipes the key there): the dismissal then lasts this page only.
      if (layoutMirrorWritable()) window.localStorage.setItem(PRIVACY_KEY, '1');
    } catch {
      // Private browsing: it goes for this page, and comes back on the next.
    }
    setSeen(true);
  };
  return (
    <div className="notice guild-privacy" role="status" data-testid="guild-privacy">
      <span className="guild-privacy-text">{privacyLine(names.lead, names.officer)}</span>
      <button type="button" className="icon-btn sm guild-privacy-dismiss" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** A guild the member was in on this page and isn't now. Calm, and theirs to put away. */
export function GuildRemovedNotices() {
  const removed = useGuildStore((s) => s.removed);
  return (
    <>
      {Object.entries(removed).map(([guildId, name]) => (
        <div key={guildId} className="notice guild-removed-notice" role="status" data-testid="guild-removed-notice">
          <span>
            You're no longer in <span className="guild-name">{name}</span>.
          </span>
          <button type="button" className="new-version-reload" onClick={() => putAway(guildPanelId(guildId))}>
            Put it away
          </button>
        </div>
      ))}
    </>
  );
}

/** A link in a guild page: which of the member's own desks opens it. Only their Personal and Work desks are offered. */
function LinkChoice({ href }: { href: string }) {
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

export function GuildLayer() {
  const sheet = useGuildStore((s) => s.sheet);
  const linkChoice = useGuildStore((s) => s.linkChoice);
  return (
    <>
      {linkChoice !== null && <LinkChoice href={linkChoice} />}
      {sheet && (
        <Suspense fallback={null}>
          <GuildSheet guildId={sheet.guildId} view={sheet.view} />
        </Suspense>
      )}
    </>
  );
}
