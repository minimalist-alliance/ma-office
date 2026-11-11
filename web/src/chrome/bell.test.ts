// The bell's rows render the kit's model (`packages/bell-kit` SPEC.md): one row a visible item, the kit's title and
// second line and time, the kind icon by family, the dot while unread, and nothing for a hidden `system.quiet`.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { rowsOf, type BellItem } from '../../../packages/bell-kit/model.mjs';
import { BellRows, FAMILY_ICON } from './BellRows';

// The real icons file reaches the canvas stores, which want a window; here an icon is an `<svg>` that says its name.
vi.mock('./icons', () => ({ Icon: ({ name, size }: { name: string; size: number }) => createElement('svg', { 'data-icon': name, width: size, height: size }) }));

const now = Date.parse('2026-11-10T18:00:00Z');
const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();

const items: BellItem[] = [
  { id: 'a', type: 'forums.thread', title: 'New reply in Community Forums', body: 'Quiet mornings', link: 'https://forums.example/t/1', actor: { name: 'Ada' }, count: 3, updatedAt: at(4), readAt: null },
  { id: 'b', type: 'forums.reply', title: 'New reply to your thread', body: 'Low-noise notifications', link: 'https://forums.example/t/2', actor: { name: 'lio' }, count: 3, updatedAt: at(30), readAt: null },
  { id: 'c', type: 'billing.card_expiring', title: 'Your card expires this month', body: 'Update it before the next renewal.', link: 'https://platform.example/billing', updatedAt: at(95), readAt: null },
  { id: 'd', type: 'desk.storage', title: 'Work desk is low on space', body: '2 GB left of 20 GB.', link: 'https://office.example/', updatedAt: at(3_000), readAt: at(2_000) },
  { id: 'e', type: 'system.quiet', title: 'More on the account site', link: 'https://platform.example/notifications', updatedAt: at(1), readAt: null },
];

const html = (list: BellItem[]): string => renderToStaticMarkup(createElement(BellRows, { rows: rowsOf(list, now) }));
const texts = (markup: string, cls: string): string[] => Array.from(markup.matchAll(new RegExp(`class="${cls}">([^<]*)<`, 'g')), (m) => m[1]!);

describe('the rows', () => {
  it('render the kit\'s words: who first, the thing under, the time on the right', () => {
    const out = html(items);
    expect(texts(out, 'bell-title')).toEqual(['Ada and 2 others replied in Quiet mornings', 'lio and 2 others replied to your thread', 'Your card expires this month', 'Work desk is low on space']);
    expect(texts(out, 'bell-second')).toEqual(['Community Forums', 'Low-noise notifications', 'Update it before the next renewal.', '2 GB left of 20 GB.']);
    expect(texts(out, 'bell-time')).toEqual(['4 min', '30 min', '1 h', '2 d']);
    expect(out).not.toContain('and 2 more');
    expect(out).not.toContain('ago');
  });
  it('leave a hidden row out, and mark the unread ones with the dot and a description', () => {
    const out = html(items);
    expect(out).not.toContain('More on the account site');
    expect((out.match(/class="bell-item unread"/g) ?? []).length).toBe(3);
    expect((out.match(/class="bell-dot"/g) ?? []).length).toBe(3);
    expect((out.match(/aria-description="Unread"/g) ?? []).length).toBe(3);
    expect(out).toContain('href="https://forums.example/t/1"');
  });
  it('put the 16 px kind icon of the family in each chip, and have an icon for every family', () => {
    const out = html(items);
    expect(Array.from(out.matchAll(/<span class="bell-chip" aria-hidden="true"><svg data-icon="(\w+)" width="16" height="16">/g), (m) => m[1])).toEqual(['thread', 'thread', 'card', 'screen']);
    expect(FAMILY_ICON).toEqual({ thread: 'thread', card: 'card', desk: 'screen', account: 'account', note: 'note' });
  });
  it('render nothing for an empty list', () => {
    expect(html([])).toBe('<ul class="bell-list"></ul>');
  });
});

describe('the billing launch types (the Product Designer billing spec, stills 13, 33, 38)', () => {
  // New types Platform hasn't registered yet: the kit's `billing.*` family is the card, so they draw with nothing new here.
  const billing: BellItem[] = [
    { id: 'm', type: 'billing.change', title: 'Your membership changes on Dec 1', body: 'To Alliance Member. Undo it until then.', link: 'https://platform.example/billing', updatedAt: at(2), readAt: null },
    { id: 'r', type: 'billing.renewal', title: 'Your yearly membership renews on Dec 1', body: 'At $1,000. Nothing to do to keep it.', link: 'https://platform.example/billing', updatedAt: at(60), readAt: null },
    { id: 'x', type: 'billing.card_expiring', title: 'Your card expires before your next charge', body: 'Update it before your charge on Dec 1.', link: 'https://platform.example/billing', updatedAt: at(120), readAt: null },
  ];
  it('render with the card icon, the server words and their link', () => {
    const out = html(billing);
    expect(texts(out, 'bell-title')).toEqual(['Your membership changes on Dec 1', 'Your yearly membership renews on Dec 1', 'Your card expires before your next charge']);
    expect(texts(out, 'bell-second')).toEqual(['To Alliance Member. Undo it until then.', 'At $1,000. Nothing to do to keep it.', 'Update it before your charge on Dec 1.']);
    expect((out.match(/data-icon="card"/g) ?? []).length).toBe(3);
    expect((out.match(/href="https:\/\/platform\.example\/billing"/g) ?? []).length).toBe(3);
  });
});
