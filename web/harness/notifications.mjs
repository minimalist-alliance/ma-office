// The member's notifications, as ma-platform's `services/notifications` answers them (ADR 0125, contract
// notifications.md 0.3.72 §2): the list, the count with its ETag, read and seen. serve.mjs calls this for every
// signed-in call, and it answers only `/v1/me/notifications…`.
//
// Steered through POST /__harness, as `notifications`. A reset leaves an empty list, so the bell shows with no count.
//   notifications.items   [Item]: { id, type, title, body?, link, actor?, count?, critical?, createdAt, updatedAt, readAt? }
//   notifications.paused  true: every route answers 503 notifications_paused (the kill switch)
//   notifications.absent  true: every route answers 404 (an office released ahead of the platform's service)
//   notifications.unreadExtra  unread items beyond those listed, as a list cut by `limit` has
//   notificationPosts     read back: every POST's { path, body }, in order
import { createHash } from 'node:crypto';

const unreadOf = (n) => (n.items ?? []).filter((it) => !it.readAt).length + (n.unreadExtra ?? 0);

export async function notifications(req, res, path, state, { json, readBody, envelope }) {
  if (!path.startsWith('/v1/me/notifications')) return false;
  const n = state.notifications ?? { items: [] };
  if (n.absent) {
    json(res, 404, envelope('not_found', 'Not found.', false));
    return true;
  }
  if (n.paused) {
    json(res, 503, envelope('notifications_paused', 'Notifications are paused for a moment.', true));
    return true;
  }
  if (path === '/v1/me/notifications/unread' && req.method === 'GET') {
    const body = { unread: unreadOf(n) };
    const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === tag) {
      state.log.push('unread 304');
      res.writeHead(304, { ETag: tag, 'X-Request-Id': 'r-harness' });
      res.end();
      return true;
    }
    json(res, 200, body, { ETag: tag });
    return true;
  }
  if (path === '/v1/me/notifications' && req.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(new URL(req.url, 'http://localhost').searchParams.get('limit')) || 50));
    const items = [...(n.items ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
    json(res, 200, { items, unread: unreadOf(n), seenAt: n.seenAt ?? null });
    return true;
  }
  if (req.method === 'POST' && (path === '/v1/me/notifications/read' || path === '/v1/me/notifications/seen')) {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.notificationPosts.push({ path, body });
    if (path === '/v1/me/notifications/seen') {
      n.seenAt = new Date().toISOString();
      json(res, 200, { seenAt: n.seenAt });
      return true;
    }
    const at = new Date().toISOString();
    const ids = body.all === true ? null : new Set(Array.isArray(body.ids) ? body.ids : []);
    n.items = (n.items ?? []).map((it) => (it.readAt || (ids && !ids.has(it.id)) ? it : { ...it, readAt: at }));
    if (body.all === true) n.unreadExtra = 0;
    state.notifications = n;
    json(res, 200, { unread: unreadOf(n) });
    return true;
  }
  json(res, 404, envelope('not_found', 'Not found.'));
  return true;
}
