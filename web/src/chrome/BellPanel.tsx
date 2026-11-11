// The bell's panel (`Bell.tsx` is its button, its count and the list's fetch): the rows in the kit's words (`packages/bell-kit`
// SPEC.md), Mark all read and All notifications. Shut, it draws nothing, so it's in the top bar's popovers chunk
// (`popoversChunk.ts`), fetched once the page is idle.
import type { Dispatch, SetStateAction } from 'react';
import { rowsOf, type BellRow } from '../../../packages/bell-kit/model.mjs';
import { accountUrl } from '../platform/clientConfig';
import { postRead, setUnread, type NotificationItem } from '../platform/notifications';
import { useSession } from '../platform/session';
import { BellRows } from './BellRows';

export type BellList = { items: NotificationItem[] } | 'loading' | 'failed';

/** Where "All notifications" goes: the account site's page, from client-config's `links.account` (its origin only). */
function allNotificationsUrl(account: string | null): string | null {
  if (!account) return null;
  try {
    return `${new URL(account).origin}/notifications`;
  } catch {
    return null;
  }
}

export function BellPanel({ list, setList, count, now }: { list: BellList; setList: Dispatch<SetStateAction<BellList>>; count: number; now: number }) {
  const config = useSession((s) => s.config);
  const items = typeof list === 'object' ? list.items : [];
  const rows = rowsOf(items, now);
  const unreadHere = items.filter((it) => !it.readAt).length;

  /** The row's link opens in this tab; the read goes first, with `keepalive`, and the count drops at once. */
  const readOne = (row: BellRow): void => {
    if (!row.unread) return;
    void postRead({ ids: [row.id] }, true).catch(() => {});
    const at = new Date().toISOString();
    setList((l) => (typeof l === 'object' ? { items: l.items.map((it) => (it.id === row.id ? { ...it, readAt: at } : it)) } : l));
    setUnread(Math.max(0, count - 1));
  };

  const readAll = (): void => {
    const at = new Date().toISOString();
    setList((l) => (typeof l === 'object' ? { items: l.items.map((it) => (it.readAt ? it : { ...it, readAt: at })) } : l));
    setUnread(0);
    postRead({ all: true })
      .then((r) => {
        if (typeof r.data?.unread === 'number') setUnread(r.data.unread);
      })
      .catch(() => {});
  };

  const all = allNotificationsUrl(config ? accountUrl(config) : null);

  return (
    <div className="menu bell-panel" id="bell-panel" role="dialog" aria-label="Notifications">
      {/* The header is there only while something is unread (SPEC.md). */}
      {(unreadHere > 0 || count > 0) && (
        <div className="bell-head">
          <p className="bell-head-title">Notifications</p>
          <button type="button" className="bell-text-link" onClick={readAll} data-testid="bell-read-all">
            Mark all read
          </button>
        </div>
      )}
      {list === 'failed' && <p className="bell-empty">Can't reach your notifications right now.</p>}
      {typeof list === 'object' && rows.length === 0 && <p className="bell-empty">Nothing new.</p>}
      {rows.length > 0 && <BellRows rows={rows} onOpen={readOne} />}
      {all && (
        <div className="bell-foot">
          <a className="bell-text-link" href={all} data-testid="bell-all">
            All notifications
          </a>
        </div>
      )}
    </div>
  );
}
