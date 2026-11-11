// A guild member's picture in presence (acct-picture): only deskd's verified caller can set it, and only Platform's checked route.
import { describe, expect, it } from 'vitest';
import { parseCaller } from '../src/caller.ts';
import { sanitizeAwareness } from '../src/collab.ts';

const ok = 'https://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2';
const base = { kind: 'guild_member', memberId: 'gm-aaa', role: 'member', grants: [], name: 'Ana Lee' };

describe('avatarUrl', () => {
  it('is kept from the caller frame only when it is Platform’s checked route', () => {
    expect(parseCaller({ ...base, avatarUrl: ok })).toMatchObject({ avatarUrl: ok });
    for (const bad of ['http://x.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2', 'https://x.test/a.png', 5, '']) expect(parseCaller({ ...base, avatarUrl: bad })).toMatchObject({ avatarUrl: null });
  });
  it('goes into presence from the caller, never from the client', () => {
    const caller = parseCaller({ ...base, avatarUrl: ok })!;
    const s: Record<string, unknown> = { user: { color: '#abc', avatarUrl: 'https://evil.test/x.png' } };
    sanitizeAwareness(s, caller);
    expect((s['user'] as Record<string, unknown>)['avatarUrl']).toBe(ok);
    const none = parseCaller(base)!;
    const t: Record<string, unknown> = { user: { avatarUrl: 'https://evil.test/x.png' } };
    sanitizeAwareness(t, none);
    expect((t['user'] as Record<string, unknown>)['avatarUrl']).toBeUndefined();
  });
});
