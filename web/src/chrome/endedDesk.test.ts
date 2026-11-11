import { describe, expect, it } from 'vitest';
import { endedWords } from './endedDesk';
import { toDeskInfo } from '../state/deskStore';

describe('the stopped Work desk, in words', () => {
  it('says the spec\'s snapshot words with a date to keep it to', () => {
    expect(endedWords({ stoppedAt: '2026-12-01T18:04:00Z', retainedUntil: '2026-12-31T00:00:00Z' }, 'Alliance Member')).toEqual({
      title: 'Your Work desk stopped on December 1',
      body: "It isn't part of Alliance Member. We keep a snapshot of it until December 31, 2026, and you can download everything on it until then.",
    });
  });
  it('says it is kept until the member moves back up when no snapshot date exists', () => {
    expect(endedWords({ stoppedAt: '2026-12-01T18:04:00Z', retainedUntil: null }, 'Alliance Member').body).toBe(
      "It isn't part of Alliance Member. It's kept, with its files, tabs and sign-ins, until you move back up, and you can download everything on it.",
    );
  });
  it('names nothing it does not know', () => {
    expect(endedWords({ stoppedAt: null, retainedUntil: null }, null)).toEqual({
      title: 'Your Work desk has stopped',
      body: "It isn't part of your membership now. It's kept, with its files, tabs and sign-ins, until you move back up, and you can download everything on it.",
    });
  });
});

describe('which desk is an ended one', () => {
  const work = { deskId: 'd-w', kind: 'work', name: 'Work', state: 'stopped' };
  it('is a Work desk with notInPlan', () => {
    expect(toDeskInfo({ ...work, notInPlan: true, allowedActions: ['export'], stateChangedAt: '2026-12-01T18:04:00Z' }).ended).toEqual({ stoppedAt: '2026-12-01T18:04:00Z', retainedUntil: null });
  });
  it('is a retained Work desk that offers export alone, with its dates', () => {
    const d = toDeskInfo({ ...work, state: 'retained', allowedActions: ['export'], endsAt: '2026-12-01T18:04:00Z', retainedUntil: '2026-12-31T00:00:00Z' });
    expect(d.ended).toEqual({ stoppedAt: '2026-12-01T18:04:00Z', retainedUntil: '2026-12-31T00:00:00Z' });
    expect(d.vm).toBe('stopped');
    expect(d.endsAt).toBeUndefined();
  });
  it('is no other desk', () => {
    expect(toDeskInfo({ ...work, notInPlan: true, kind: 'personal' }).ended).toBeUndefined();
    expect(toDeskInfo({ ...work, state: 'retained', allowedActions: ['export'], kind: 'guild' }).ended).toBeUndefined();
    expect(toDeskInfo({ ...work, state: 'running', allowedActions: ['connect', 'stop'] }).ended).toBeUndefined();
    expect(toDeskInfo({ ...work, notInPlan: true, stateChangedAt: 'nonsense' }).ended).toEqual({ stoppedAt: null, retainedUntil: null });
  });
});
