// The room's sources: the viewport's closed enum, the honest waiting source, and the mock's contract with the room (what the
// shell specs drive): choices answered by a tap, as "Other" or ignored, notes undone, an item snoozed, Maia Mode on and off.
import { describe, expect, it, vi } from 'vitest';
import { viewApp, waitingSource } from './source';

vi.stubGlobal('window', {});
const { MockRoomSource } = await import('./mockSource');

describe('viewApp', () => {
  it('takes the core apps, an agent’s and a desk app’s id, and nothing else', () => {
    for (const app of ['notebook', 'files', 'agent', 'browser', 'todo', 'agent:a-1', 'app:com.minimalistalliance.bible']) expect(viewApp(app)).toBe(app);
    for (const bad of ['https://example.org', 'javascript:alert(1)', 'courier', 'commons', 'app:', 'agent:../x', 'app:a b', '', 7, null, `app:${'x'.repeat(120)}`]) expect(viewApp(bad)).toBeNull();
  });
});

describe('waitingSource', () => {
  it('says it’s connecting and does nothing with what it’s asked', () => {
    const s = waitingSource();
    expect(s.get().link).toBe('connecting');
    s.send('hello');
    expect(s.get().messages).toEqual([]);
  });
});

describe('the mock', () => {
  const desks = () => [{ id: 'd-p', name: 'Personal' }, { id: 'd-w', name: 'Work' }];
  it('starts with her conversation, a Now, the status and the foot line', () => {
    const s = MockRoomSource(desks);
    const st = s.get();
    expect(st.link).toBe('ready');
    expect(st.attention.filter((a) => a.urgency === 'now')).toHaveLength(1);
    expect(st.status?.desks).toBe(2);
    expect(st.messages.at(-1)?.choices?.options.length).toBeGreaterThanOrEqual(2);
  });
  it('answers a tap on her choice, and the member’s line reads the choice', () => {
    vi.useFakeTimers();
    const s = MockRoomSource(desks);
    const last = s.get().messages.at(-1)!;
    s.choose(last.id, 'o2');
    const after = s.get().messages;
    expect(after.find((m) => m.id === last.id)?.choices?.answered).toEqual({ kind: 'option', id: 'o2' });
    expect(after.at(-1)).toMatchObject({ from: 'member', text: 'After the newsletter' });
    vi.runAllTimers();
    expect(s.get().messages.at(-1)?.from).toBe('maia');
    vi.useRealTimers();
  });
  it('hears a typed reply as "Other" or as choices ignored', () => {
    const s = MockRoomSource(desks);
    const set = s.get().messages.at(-1)!.choices!;
    s.send('Tonight', { choices: set.id, as: 'other' });
    expect(s.get().messages.find((m) => m.choices?.id === set.id)?.choices?.answered).toEqual({ kind: 'other', text: 'Tonight' });
    const log = (window as unknown as { __maMaiaModeMock: { log: { method: string; args: unknown[] }[] } }).__maMaiaModeMock.log;
    expect(log.at(-1)).toEqual({ method: 'send', args: ['Tonight', { choices: set.id, as: 'other' }] });
  });
  it('undoes a note, snoozes an item, and hears Maia Mode turned off', () => {
    const s = MockRoomSource(desks);
    s.undoNote('ap-work');
    expect(s.get().messages.flatMap((m) => m.notes ?? []).find((n) => n.id === 'n-work')?.state).toBe('undone');
    s.snooze('writer-form');
    expect(s.get().attention.find((a) => a.id === 'writer-form')?.urgency).toBe('later');
    s.setOn(false);
    const log = (window as unknown as { __maMaiaModeMock: { log: { method: string }[] } }).__maMaiaModeMock.log;
    expect(log.at(-1)?.method).toBe('setOn');
  });
});
