// Courier's id in what's stored (`storedIds.ts`): `chat` read as `courier`, and written as `STORED_COURIER`.
import { describe, expect, it } from 'vitest';
import { appFromStored, appToStored, COURIER, keyFromStored, keyToStored, OLD_COURIER, recordFromStored, recordToStored, STORED_COURIER } from './storedIds';

describe('Courier as stored', () => {
  it('is still written as `chat` during the transition: release 19 and earlier drop an app they do not know', () => {
    // The flip to `courier` is its own release, once no rollback can reach a build that only reads `chat`
    // (docs/sub-status/courier-id.md, "Removal"). This test changes with it.
    expect(STORED_COURIER).toBe(OLD_COURIER);
    expect(OLD_COURIER).toBe('chat');
  });

  it('reads either id as Courier, and nothing else changes', () => {
    expect(appFromStored('chat')).toBe(COURIER);
    expect(appFromStored('courier')).toBe(COURIER);
    for (const other of ['notebook', 'browser', 'agent', 'commons', 'files', 'agent:ag-0123456789ab', 'app:org.example.chat', 'Chat', 'chats', 7, null, undefined]) {
      expect(appFromStored(other)).toBe(other);
    }
  });

  it('writes Courier as the transition says, or as asked, and nothing else changes', () => {
    expect(appToStored('courier')).toBe('chat');
    expect(appToStored('courier', 'courier')).toBe('courier');
    for (const other of ['notebook', 'browser', 'agent', 'commons', 'files', 'agent:ag-0123456789ab', 'app:org.example.courier', 'chat']) {
      expect(appToStored(other)).toBe(other);
      expect(appToStored(other, 'courier')).toBe(other);
    }
  });

  it('maps only a `<desk>:<app>` key whose app is Courier', () => {
    expect(keyFromStored('d-test5i2qpxdh:chat')).toBe('d-test5i2qpxdh:courier');
    expect(keyFromStored('guild-g1:chat')).toBe('guild-g1:courier');
    expect(keyToStored('d-test5i2qpxdh:courier')).toBe('d-test5i2qpxdh:chat');
    expect(keyToStored('d-test5i2qpxdh:courier', 'courier')).toBe('d-test5i2qpxdh:courier');
    // An agent whose id happens to be `chat`, an installed app's, a bare id, a key with more than one colon: as they are.
    for (const key of ['d-1:agent:chat', 'd-1:app:org.example.chat', 'chat', ':chat', 'd-1:chats', 'd-1:notebook', 'a', 'd-1:chat:x']) {
      expect(keyFromStored(key)).toBe(key);
    }
    for (const key of ['d-1:agent:courier', 'courier', ':courier', 'd-1:notebook']) expect(keyToStored(key)).toBe(key);
  });

  it('turns a stored record round and back, the same record, and never folds two keys into one', () => {
    const stored = { 'd-1:chat': 1, 'd-1:notebook': 2, 'd-2:chat': 3 };
    const mine = recordFromStored(stored);
    expect(mine).toEqual({ 'd-1:courier': 1, 'd-1:notebook': 2, 'd-2:courier': 3 });
    expect(recordToStored(mine)).toEqual(stored);
    // Both spellings at once (two builds wrote one cache): each keeps its own value.
    const both = recordFromStored({ 'd-1:chat': 1, 'd-1:courier': 2 });
    expect(Object.keys(both)).toHaveLength(2);
    expect(both['d-1:courier']).toBe(2);
    // By app (the zoom's keys).
    const byApp = (k: string): string => appFromStored(k) as string;
    expect(recordFromStored({ chat: 150, notebook: 80 }, byApp)).toEqual({ courier: 150, notebook: 80 });
    expect(recordToStored({ courier: 150, notebook: 80 }, (k) => appToStored(k))).toEqual({ chat: 150, notebook: 80 });
  });
});
