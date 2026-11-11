import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceUrl, openOnDevice } from './openOnDevice';
import { protectedFailureOf, ProtectedWatch, resetProtectedDismissals } from './protectedPlayback';

import type { BrowserTab } from '../desk/deskLink';

const tab = (tabId: string, url: string, over: Partial<BrowserTab> = {}): BrowserTab => ({ tabId, url, title: '', loading: false, active: true, canGoBack: false, canGoForward: false, protectedMedia: { at: '2026-11-11T09:30:00Z', keySystem: 'com.widevine.alpha' }, ...over });

describe('protectedFailureOf', () => {
  it('reads tab, url, origin and when', () => {
    expect(protectedFailureOf(tab('t1', 'https://video.example.com/watch?v=1'))).toEqual({ tabId: 't1', url: 'https://video.example.com/watch?v=1', origin: 'https://video.example.com', at: '2026-11-11T09:30:00Z' });
  });
  it('is null for a tab without the field, or anything malformed or not http(s)', () => {
    expect(protectedFailureOf(tab('t1', 'https://a.test/', { protectedMedia: undefined }))).toBeNull();
    expect(protectedFailureOf(null)).toBeNull();
    expect(protectedFailureOf(tab('t1', 'https://a.test/', { protectedMedia: {} as never }))).toBeNull();
    expect(protectedFailureOf(tab('t1', 'not a url'))).toBeNull();
    expect(protectedFailureOf(tab('t1', 'file:///etc/passwd'))).toBeNull();
    expect(protectedFailureOf(tab('t1', 'javascript:alert(1)'))).toBeNull();
  });
});

describe('ProtectedWatch', () => {
  beforeEach(() => resetProtectedDismissals());

  it('shows the note only for the active tab', () => {
    const w = new ProtectedWatch('d1');
    expect(w.noteFor([tab('t1', 'https://a.test/x', { active: false }), tab('t2', 'https://b.test/', { active: true, protectedMedia: undefined })])).toBeNull();
    expect(w.noteFor([tab('t1', 'https://a.test/x'), tab('t2', 'https://b.test/', { active: false })])?.tabId).toBe('t1');
    expect(w.noteFor([])).toBeNull();
  });

  it('shows no more for a site once dismissed, in any tab, but still for other sites', () => {
    const w = new ProtectedWatch('d1');
    w.dismiss('https://a.test');
    expect(w.noteFor([tab('t1', 'https://a.test/z')])).toBeNull();
    expect(w.noteFor([tab('t3', 'https://a.test/other')])).toBeNull();
    expect(w.noteFor([tab('t3', 'https://b.test/z')])).not.toBeNull();
  });

  it('remembers the dismissal across windows of the same desk, not across desks', () => {
    new ProtectedWatch('d1').dismiss('https://a.test');
    expect(new ProtectedWatch('d1').noteFor([tab('t1', 'https://a.test/')])).toBeNull();
    expect(new ProtectedWatch('d2').noteFor([tab('t1', 'https://a.test/')])).not.toBeNull();
  });
});

describe('openOnDevice', () => {
  it('opens http(s) in a new tab with noopener, and nothing else', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    expect(openOnDevice('https://a.test/p')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://a.test/p', '_blank', 'noopener');
    expect(openOnDevice('javascript:alert(1)')).toBe(false);
    expect(deviceUrl('data:text/html,x')).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
