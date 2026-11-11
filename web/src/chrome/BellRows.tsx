// The bell's rows (`packages/bell-kit` SPEC.md, vendored from ma-platform): the kit's row model laid out with the
// office's tokens (`.bell-*` in `styles/app.css`). Its own file so a test renders it without the office's stores.
import { type BellRow, type Family } from '../../../packages/bell-kit/model.mjs';
import { Icon, type IconName } from './icons';

/** The kind icon in a row's chip, by the kit's family. Stroke icons, no stars. */
export const FAMILY_ICON: Record<Family, IconName> = { thread: 'thread', card: 'card', desk: 'screen', account: 'account', note: 'note' };

/**
 * The rows, as SPEC.md draws them: a 28 px chip with the kind icon, the title (two lines at most), the second line (one,
 * cut), and on the right the time with an accent dot under it while unread. Each row is a link; `onOpen` runs on the click.
 */
export function BellRows({ rows, onOpen }: { rows: BellRow[]; onOpen?: (row: BellRow) => void }) {
  return (
    <ul className="bell-list">
      {rows.map((row) => (
        <li key={row.id} className={`bell-item${row.unread ? ' unread' : ''}`}>
          <a href={row.link} className="bell-link" onClick={() => onOpen?.(row)} aria-description={row.unread ? 'Unread' : undefined}>
            <span className="bell-chip" aria-hidden="true">
              <Icon name={FAMILY_ICON[row.family]} size={16} />
            </span>
            <span className="bell-text">
              <span className="bell-title">{row.title}</span>
              {row.second && <span className="bell-second">{row.second}</span>}
            </span>
            <span className="bell-side">
              {row.time && <span className="bell-time">{row.time}</span>}
              {row.unread && <span className="bell-dot" aria-hidden="true" />}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
