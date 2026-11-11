import { describe, expect, it } from 'vitest';
import { HANDOFF_INPUT_MS, HANDOFF_STALE_MS, HANDOFF_WORDS, HandoffWatch, parseLinkOut } from './handoff';
import { handoffScheme, HANDOFF_SCHEMES } from './openOnDevice';

const ev = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  type: 'linkOut',
  url: 'mailto:hello@example.com?subject=Hi%20there',
  scheme: 'mailto',
  displayText: 'mailto:hello@example.com?subject=Hi there',
  reason: 'externalScheme',
  at: '2026-11-11T10:00:00Z',
  tabId: 'T1',
  ...over,
});

describe('handoffScheme', () => {
  it('knows exactly the spec’s schemes, and needs something after the colon', () => {
    expect([...HANDOFF_SCHEMES]).toEqual(['mailto', 'tel', 'sms', 'zoommtg', 'zoomus', 'msteams', 'webcal']);
    expect(handoffScheme('TEL:+15550100')).toBe('tel');
    expect(handoffScheme('zoommtg://zoom.us/join?confno=1')).toBe('zoommtg');
    for (const bad of ['mailto:', 'facetime:+1555', 'https://example.com/', 'javascript:alert(1)', 'ms-msdt:/id', 'search-ms:query=x', 'file:///etc/passwd', 'tel:+1 555', 'tel:‮123', 42]) {
      expect(handoffScheme(bad)).toBeNull();
    }
  });
});

describe('parseLinkOut', () => {
  it('takes deskd’s linkOut, with its displayText cleaned again, and counts its age from now', () => {
    const h = parseLinkOut(ev(), 5000)!;
    expect(h).toMatchObject({ url: 'mailto:hello@example.com?subject=Hi%20there', scheme: 'mailto', shown: 'mailto:hello@example.com?subject=Hi there', at: 5000 });
    expect(HANDOFF_WORDS[h.scheme].say).toBe('This page wants to start an email.');
    // Without displayText, the URL itself.
    expect(parseLinkOut(ev({ displayText: undefined }), 1)?.shown).toBe('mailto:hello@example.com?subject=Hi%20there');
    // Bidi and control characters in deskd's text go, as for any untrusted text.
    expect(parseLinkOut(ev({ displayText: 'mailto:a‮@example.com' }), 1)?.shown).toBe('mailto:a@example.com');
  });
  it('drops what isn’t a listed link: another type or reason, another scheme, or a scheme word that disagrees', () => {
    expect(parseLinkOut(ev({ type: 'other' }))).toBeNull();
    expect(parseLinkOut(ev({ reason: 'later' }))).toBeNull();
    expect(parseLinkOut(ev({ url: 'facetime:+15550100', scheme: 'facetime' }))).toBeNull();
    expect(parseLinkOut(ev({ url: 'https://example.com/', scheme: 'https' }))).toBeNull();
    expect(parseLinkOut(ev({ url: 'javascript:alert(1)', scheme: 'mailto' }))).toBeNull();
    expect(parseLinkOut(ev({ scheme: 'tel' }))).toBeNull();
    expect(parseLinkOut(null)).toBeNull();
    expect(parseLinkOut(ev({ url: 42 }))).toBeNull();
  });
  it('gives each its own id', () => {
    expect(parseLinkOut(ev())!.id).not.toBe(parseLinkOut(ev())!.id);
  });
});

describe('HandoffWatch', () => {
  it('shows a hand-off only on the device that sent input to the stream just now', () => {
    const w = new HandoffWatch();
    expect(w.take(parseLinkOut(ev(), 10_000), 10_000 - HANDOFF_INPUT_MS - 1, 10_000)).toBe(false);
    expect(w.card(10_000)).toBeNull();
    expect(w.take(parseLinkOut(ev(), 10_000), -Infinity, 10_000)).toBe(false);
    expect(w.take(parseLinkOut(ev(), 10_000), 9_000, 10_000)).toBe(true);
    expect(w.card(10_000)).not.toBeNull();
  });
  it('the newest wins, an answered one never shows again, and one past 2 minutes is gone', () => {
    const w = new HandoffWatch();
    const a = parseLinkOut(ev(), 0)!;
    const b = parseLinkOut(ev({ url: 'tel:+15550100', scheme: 'tel', displayText: 'tel:+15550100' }), 100)!;
    w.take(a, 0, 0);
    w.take(b, 100, 100);
    expect(w.card(100)?.id).toBe(b.id);
    w.answer(b.id);
    expect(w.card(100)).toBeNull();
    // The page asks again: a new event, a new card.
    const c = parseLinkOut(ev({ url: 'tel:+15550100', scheme: 'tel' }), 200)!;
    w.take(c, 200, 200);
    expect(w.card(200)?.id).toBe(c.id);
    expect(w.card(200 + HANDOFF_STALE_MS + 1)).toBeNull();
  });
});
