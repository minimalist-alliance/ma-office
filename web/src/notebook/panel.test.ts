import { describe, expect, it } from 'vitest';
import type { BrowserPanel } from '../browser/panel';
import { browserUrl } from './openLink.url';
import { deskPanel, isClosed, notebookLine, type DeskInput } from './panel';

const desk = (p: Partial<DeskInput> = {}): DeskInput => ({ vm: 'running', phase: null, queuePosition: null, link: 'open', unreachable: false, refusal: null, ...p });
const line = (panel: BrowserPanel, p: { unsaved?: boolean; hasUnsavedText?: boolean; full?: boolean; tooLarge?: boolean; problem?: boolean } = {}) =>
  notebookLine({ panel, unsaved: false, hasUnsavedText: false, full: false, tooLarge: false, problem: false, ...p });

describe('deskPanel', () => {
  it('a session up is the Notebook to say', () => {
    expect(deskPanel(desk()).kind).toBe('playing');
  });

  it('never needs video or a frame', () => {
    expect(deskPanel(desk({ link: 'open' }))).toEqual({ kind: 'playing' });
  });

  it.each([
    [{ vm: 'setting-up' } as const, 'settingUp'],
    [{ vm: 'held' } as const, 'support'],
    [{ refusal: { kind: 'unavailable', billingUrl: null } } as const, 'support'],
    [{ refusal: { kind: 'suspended', billingUrl: null } } as const, 'membership'],
    [{ vm: 'stopped' } as const, 'asleep'],
    [{ vm: 'stopping' } as const, 'stopping'],
    [{ vm: 'starting', phase: 'booting' } as const, 'waking'],
    [{ link: 'retrying' } as const, 'reconnecting'],
    [{ link: 'retrying', unreachable: true } as const, 'unreachable'],
    [{ link: 'resting' } as const, 'resting'],
    [{ link: 'denied' } as const, 'denied'],
    [{ link: 'connecting' } as const, 'opening'],
  ])('%j is %s', (input, kind) => {
    expect(deskPanel(desk(input)).kind).toBe(kind);
  });

  it('only what can never open is closed', () => {
    for (const kind of ['settingUp', 'support', 'denied'] as const) expect(isClosed({ kind })).toBe(true);
    expect(isClosed({ kind: 'membership', billingUrl: null })).toBe(true);
    for (const kind of ['asleep', 'reconnecting', 'unreachable', 'opening', 'playing'] as const) expect(isClosed({ kind })).toBe(false);
  });
});

describe('the quiet line', () => {
  it('says nothing while all is well', () => {
    expect(line({ kind: 'playing' })).toBeNull();
    expect(line({ kind: 'playing' }, { hasUnsavedText: true })).toBeNull(); // typing, within moments of the desk's word
  });

  it('says "Not saved yet" only once the desk has been quiet a while', () => {
    expect(line({ kind: 'playing' }, { unsaved: true, hasUnsavedText: true })?.text).toBe('Not saved yet.');
  });

  it('a dropped link says what it is, and what is not saved', () => {
    expect(line({ kind: 'reconnecting' })?.text).toBe('Reconnecting…');
    expect(line({ kind: 'reconnecting' }, { hasUnsavedText: true })?.text).toBe('Not saved yet. Reconnecting…');
    expect(line({ kind: 'unreachable' }, { hasUnsavedText: true })?.text).toBe("Not saved yet. Can't reach this desk. Still trying.");
  });

  it('only asleep and failed offer to wake', () => {
    expect(line({ kind: 'asleep' })).toEqual({ text: 'This desk is asleep.', wake: true });
    expect(line({ kind: 'failed' }, { hasUnsavedText: true })).toEqual({ text: "Not saved yet. Couldn't wake this desk.", wake: true });
    expect(line({ kind: 'reconnecting' })?.wake).toBe(false);
    expect(line({ kind: 'waking', step: 1 })?.text).toBe('Waking this desk…');
    expect(line({ kind: 'stopping' })?.text).toBe('This desk is going to sleep.');
    expect(line({ kind: 'resting' })?.text).toBe('Paused. Click to pick it back up.');
  });

  it('a full page says so first, plainly, and whether its last words are saved', () => {
    expect(line({ kind: 'playing' }, { full: true })?.text).toBe('This page is full. Start a new page to keep writing.');
    expect(line({ kind: 'reconnecting' }, { full: true, hasUnsavedText: true })?.text).toBe("This page is full, so what you typed last isn't saved. Copy it to a new page.");
  });

  it('too much to send at once says so', () => {
    expect(line({ kind: 'playing' }, { tooLarge: true, hasUnsavedText: true })?.text).toBe("That's too much to save at once, so it isn't saved yet. Copy it to a new page in parts.");
  });

  it('a change with no answer says so last', () => {
    expect(line({ kind: 'playing' }, { problem: true })?.text).toBe("This desk didn't confirm that. Try again if it isn't there.");
    expect(line({ kind: 'playing' }, { problem: true, unsaved: true })?.text).toBe('Not saved yet.');
  });
});

describe('links go to the desk\'s Browser', () => {
  it('only http and https', () => {
    expect(browserUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(browserUrl('http://example.org')).toBe('http://example.org/');
    for (const bad of ['mailto:a@example.org', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url', '']) expect(browserUrl(bad)).toBeNull();
  });
});
