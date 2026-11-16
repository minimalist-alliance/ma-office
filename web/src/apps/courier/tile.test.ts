// Courier's tile (Wave 3.4): People's unread plus Requests' new senders, and up to three first names of people the member knows,
// never a stranger's display name, an address or a subject; the platform's waiting count while a desk sleeps.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import { MockCourierDesk } from '../../desk/mockDeskCourier';
import { namesLine, tileOf, watchCourierTile } from './tile';

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

const contact = (name: string, value: string, known = true) => ({ contactId: 'c', name, endpoint: { kind: 'email', value }, known });
const row = (id: string, unread: number, c: ReturnType<typeof contact>, kind = 'direct') => ({ channelId: id.padEnd(26, '0'), kind, title: '', contacts: [c], lane: 'people', lastAt: 1, count: 1, unread, done: false, medium: 'email', last: null });

describe('the tile', () => {
  it('counts People’s unread and Requests’ new senders, and names up to three people the member knows', () => {
    const status = { state: 'on', lanes: { people: { count: 6, unread: 4 }, requests: { count: 2, unread: 2 } } };
    const people = {
      rows: [
        row('01A', 2, contact('Dana Ortiz', 'dana@ortiz.example')),
        row('01B', 0, contact('Sam Lee', 'sam@lee.example')),
        row('01C', 1, contact('', '+17205550142')),
        row('01D', 1, contact('Prize Team', 'win@prizes.example', false)),
        row('01E', 1, contact('Priya Shah', 'priya@shah.example')),
        row('01F', 1, contact('Kim Park', 'kim@park.example')),
        row('01G', 1, contact('Ola Berg', 'ola@berg.example')),
      ],
    };
    expect(tileOf(status, people)).toEqual({ badge: 6, names: ['Dana', 'Priya', 'Kim'] });
    expect(tileOf({ state: 'off' }, people)).toEqual({ badge: 0, names: [] });
    expect(namesLine(['Dana'])).toBe('Dana');
    expect(namesLine(['Dana', 'Sam'])).toBe('Dana and Sam');
    expect(namesLine(['Dana', 'Sam', 'Priya'])).toBe('Dana, Sam and Priya');
  });

  it('reads the desk again on each change, and never a subject', async () => {
    const desk = new MockCourierDesk('d-personal-tile');
    desk.seed('personal');
    const link = {
      deskId: desk.deskId,
      call: (m: string, p: Record<string, unknown> = {}) => desk.answer(m, p),
      subscribe: (_t: string, fn: () => void) => {
        queueMicrotask(fn);
        return desk.subscribe(() => fn());
      },
    } as unknown as DeskLink;
    const seen: { badge: number; widget?: { title: string } }[] = [];
    const stop = watchCourierTile(link, (_d, app, t) => {
      expect(app).toBe('courier');
      seen.push(t);
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const first = seen[seen.length - 1]!;
    expect(first.badge).toBeGreaterThan(0);
    expect(first.widget?.title).toBe('Sam, Dana and Priya');
    desk.deliver({ name: 'Ada Quinn', address: 'ada@quinn.example', subject: 'Secret plans', text: 'x' });
    await vi.waitFor(() => expect(seen[seen.length - 1]!.widget?.title).toMatch(/^Ada, /));
    expect(JSON.stringify(seen)).not.toContain('Secret plans');
    stop();
  });
});
