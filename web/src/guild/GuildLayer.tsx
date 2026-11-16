// What the office shows for guilds outside their windows (task 48): the one privacy line on a member's first Guild Desk, a
// notice for a guild they're no longer in, the choice of desk for a guild page's link, and the door to the guild settings
// sheet, which loads lazily. Notices go in the shell's stack (`.notices`), never in a bar.
import { lazy, Suspense, useState } from 'react';
import { Icon } from '../chrome/icons';
import { useTierNames } from '../platform/useTiers';
import { layoutMirrorWritable } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';
import { putAway, useGuildStore } from './guildStore';
import { guildPanelId, isGuildPanel } from './panel';
// Kept in the first load though only the lazy parts below use them here: each is also another chunk's (the guild sheet's
// Esc, the windows' words, the Notebook's, To-do's and Courier's way to a desk's Browser), so no chunk imports it from another.
import './useEscape';
import './words';
import '../notebook/openLink';

const loadSheet = (): Promise<typeof import('./GuildSheet')> => import('./GuildSheet');
const GuildSheet = lazy(loadSheet);
// The choice of desk for a guild page's link (`LinkChoice.tsx`): its own chunk, fetched when a link is pressed.
const LinkChoice = lazy(() => import('./LinkChoice'));

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
    <div className="notice guild-privacy ma-glass" role="status" data-testid="guild-privacy">
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
        <div key={guildId} className="notice guild-removed-notice ma-glass" role="status" data-testid="guild-removed-notice">
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

export function GuildLayer() {
  const sheet = useGuildStore((s) => s.sheet);
  const linkChoice = useGuildStore((s) => s.linkChoice);
  return (
    <>
      {linkChoice !== null && (
        <Suspense fallback={null}>
          <LinkChoice href={linkChoice} />
        </Suspense>
      )}
      {sheet && (
        <Suspense fallback={null}>
          <GuildSheet guildId={sheet.guildId} view={sheet.view} />
        </Suspense>
      )}
    </>
  );
}
