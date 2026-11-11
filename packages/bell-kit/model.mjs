// The one row model for every bell (SPEC.md). Framework-free; no tokens, no DOM.

export const KIT = 1;

const FAMILY = [
  [/^forums\./, 'thread'],
  [/^chat\./, 'thread'],
  [/^billing\./, 'card'],
  [/^desk\./, 'desk'],
  [/^account\./, 'account'],
  [/^age\./, 'account'],
  [/^guild\./, 'account'],
  [/^maia\./, 'note'],
];

/** The icon family for a type: thread | card | desk | account | note. */
export function familyOf(type) {
  for (const [re, fam] of FAMILY) if (re.test(String(type ?? ''))) return fam;
  return 'note';
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "now", "5 min", "1 h", "2 d", then "Nov 1" (with the year when it isn't this year). Never "ago", "hr" or "5m". */
export function timeLabel(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(String(at ?? ''));
  const n = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((n - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d`;
  const date = new Date(t);
  const then = new Date(n);
  const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === then.getUTCFullYear() ? label : `${label}, ${date.getUTCFullYear()}`;
}

/** "Notifications" at 0, else "Notifications, N unread". */
export const bellLabel = (unread) => (unread > 0 ? `Notifications, ${unread} unread` : 'Notifications');

/** Nothing at 0, the number to 9, then "9+". */
export const countLabel = (unread) => (unread > 0 ? (unread > 9 ? '9+' : String(unread)) : '');

const others = (count) => {
  const n = Math.max(0, (Number(count) || 1) - 1);
  return n === 0 ? '' : n === 1 ? ' and 1 other' : ` and ${n} others`;
};

const FORUMS = 'Community Forums';

/**
 * The row for one item: `{ id, title, second, time, unread, family, link, hidden }`.
 * `hidden` is true for rows the panel doesn't show (`system.quiet`).
 */
export function rowOf(item, now = Date.now()) {
  const type = String(item?.type ?? '');
  const actor = item?.actor?.name ? String(item.actor.name) : '';
  const body = item?.body ? String(item.body) : '';
  let title = item?.title ? String(item.title) : '';
  let second = body;
  if (actor) {
    if (type === 'forums.reply') {
      title = `${actor}${others(item.count)} replied to your thread`;
      second = body;
    } else if (type === 'forums.thread') {
      title = body ? `${actor}${others(item.count)} replied in ${body}` : `${actor}${others(item.count)} replied in a thread you follow`;
      second = FORUMS;
    } else if (type === 'forums.mention') {
      title = `${actor} mentioned you`;
      second = body;
    }
  }
  if (type === 'forums.notice') {
    title = title || `A notice from ${FORUMS}`;
    second = body;
  }
  return {
    id: String(item?.id ?? ''),
    title,
    second,
    time: timeLabel(item?.updatedAt ?? item?.createdAt, now),
    unread: !item?.readAt,
    family: familyOf(type),
    link: String(item?.link ?? ''),
    hidden: type === 'system.quiet',
  };
}

/** The rows the panel shows, in the order given (the server already sorts newest change first). */
export const rowsOf = (items, now = Date.now()) => (Array.isArray(items) ? items : []).map((i) => rowOf(i, now)).filter((r) => !r.hidden);
