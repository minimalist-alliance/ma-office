import test from 'node:test';
import assert from 'node:assert/strict';
import { timeLabel, rowOf, rowsOf, countLabel, bellLabel, familyOf } from '../model.mjs';

const now = Date.parse('2026-11-10T20:00:00Z');
const ago = (s) => new Date(now - s * 1000).toISOString();

test('time labels', () => {
  assert.equal(timeLabel(ago(10), now), 'now');
  assert.equal(timeLabel(ago(5 * 60), now), '5 min');
  assert.equal(timeLabel(ago(3600), now), '1 h');
  assert.equal(timeLabel(ago(2 * 86400), now), '2 d');
  assert.equal(timeLabel('2026-11-01T12:00:00Z', now), 'Nov 1');
  assert.equal(timeLabel('2025-12-24T12:00:00Z', now), 'Dec 24, 2025');
  assert.equal(timeLabel(undefined, now), '');
});

test('counts and the label', () => {
  assert.equal(countLabel(0), '');
  assert.equal(countLabel(9), '9');
  assert.equal(countLabel(10), '9+');
  assert.equal(bellLabel(0), 'Notifications');
  assert.equal(bellLabel(3), 'Notifications, 3 unread');
});

test('a reply, alone and as a group', () => {
  const one = rowOf({ id: 'a', type: 'forums.reply', title: 'lio replied to your thread', body: 'Quiet mornings', actor: { name: 'lio' }, count: 1, updatedAt: ago(300), link: 'https://forums.example/t/1' }, now);
  assert.equal(one.title, 'lio replied to your thread');
  assert.equal(one.second, 'Quiet mornings');
  assert.equal(one.time, '5 min');
  assert.equal(one.unread, true);
  assert.equal(one.family, 'thread');
  const group = rowOf({ id: 'a', type: 'forums.reply', body: 'Quiet mornings', actor: { name: 'lio' }, count: 3, readAt: ago(1) }, now);
  assert.equal(group.title, 'lio and 2 others replied to your thread');
  assert.equal(group.unread, false);
  assert.equal(rowOf({ type: 'forums.reply', body: 'x', actor: { name: 'lio' }, count: 2 }, now).title, 'lio and 1 other replied to your thread');
});

test('a followed thread names the thread, Community Forums second', () => {
  const r = rowOf({ type: 'forums.thread', body: 'Quiet mornings', actor: { name: 'Ada' }, count: 3 }, now);
  assert.equal(r.title, 'Ada and 2 others replied in Quiet mornings');
  assert.equal(r.second, 'Community Forums');
});

test('a mention, a notice, and anything else', () => {
  assert.equal(rowOf({ type: 'forums.mention', body: 'Quiet mornings', actor: { name: 'kestrel' } }, now).title, 'kestrel mentioned you');
  const n = rowOf({ type: 'forums.notice', title: 'A notice from Community Forums', body: 'Off topic' }, now);
  assert.equal(n.second, 'Off topic');
  const c = rowOf({ type: 'billing.card_expiring', title: 'Your card is about to expire', body: 'Update it on your account page.' }, now);
  assert.equal(c.title, 'Your card is about to expire');
  assert.equal(c.family, 'card');
  assert.equal(familyOf('desk.storage'), 'desk');
  assert.equal(familyOf('account.security'), 'account');
  assert.equal(familyOf('maia.note'), 'note');
});

test('the quiet row is hidden', () => {
  const rows = rowsOf([{ id: 'q', type: 'system.quiet', title: 'More happened than we show here' }, { id: 'b', type: 'forums.reply', actor: { name: 'lio' }, body: 't' }], now);
  assert.deepEqual(rows.map((r) => r.id), ['b']);
});
