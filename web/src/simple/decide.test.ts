import { describe, expect, it } from 'vitest';
import { decideView, fallbackReason, pageLine, switchTitles, type FallbackReason, type ViewInput } from './decide';

const input = (p: Partial<ViewInput>): ViewInput => ({ supported: true, choice: null, override: null, status: { kind: 'ready' }, ...p });

describe('decideView', () => {
  it('is simplified by default, and while the page is on its way', () => {
    expect(decideView(input({}))).toMatchObject({ view: 'simple', canSwitch: true, why: 'ready' });
    expect(decideView(input({ status: { kind: 'waiting' } }))).toMatchObject({ view: 'simple', why: 'waiting' });
  });

  it("is the real page, with no switch, on a desk that can't simplify", () => {
    expect(decideView(input({ supported: false }))).toEqual({ view: 'full', canSwitch: false, why: 'unsupported' });
  });

  it("follows the member's choice for the site, and a page-only override", () => {
    expect(decideView(input({ choice: 'full' }))).toMatchObject({ view: 'full', canSwitch: true, why: 'choice' });
    expect(decideView(input({ override: 'full' }))).toMatchObject({ view: 'full', why: 'override' });
  });

  it('lets the switch undo the site memory, but never a private or broken page', () => {
    expect(decideView(input({ status: { kind: 'fallback', reason: 'member_choice' } }))).toMatchObject({ view: 'full', canSwitch: true, why: 'choice' });
    expect(decideView(input({ status: { kind: 'fallback', reason: 'remembered' } }))).toMatchObject({ view: 'full', canSwitch: true, why: 'remembered' });
    expect(decideView(input({ status: { kind: 'fallback', reason: 'member_choice' }, choice: 'simple' }))).toMatchObject({ view: 'simple' });
    for (const reason of ['sensitive_site', 'http_auth', 'canvas_app', 'person_check', 'sign_in', 'payment', 'terms_wall', 'distiller_error'] as const) {
      expect(decideView(input({ status: { kind: 'fallback', reason }, choice: 'simple', override: 'simple' })), reason).toMatchObject({ view: 'full', canSwitch: false, why: 'fallback', reason });
    }
  });

  it('shows the real page when nothing came in time, and the switch asks again', () => {
    expect(decideView(input({ status: { kind: 'slow' } }))).toMatchObject({ view: 'full', canSwitch: true, why: 'slow' });
  });
});

describe('fallbackReason', () => {
  it("takes section 14's names, and anything else as the distiller failing", () => {
    expect(fallbackReason('canvas_app')).toBe('canvas_app');
    expect(fallbackReason('terms_wall')).toBe('terms_wall');
    expect(fallbackReason('http_error')).toBe('http_error');
    // A challenge is read by its cause (section 14 at d0561b4); one with no cause known here is a person check.
    expect(fallbackReason('challenge', 'person_check')).toBe('person_check');
    expect(fallbackReason('challenge', 'sign_in')).toBe('sign_in');
    expect(fallbackReason('challenge', 'payment')).toBe('payment');
    expect(fallbackReason('challenge', 'constructor')).toBe('person_check');
    expect(fallbackReason('challenge')).toBe('person_check');
    // A cause is never a reason by itself.
    expect(fallbackReason('person_check')).toBe('distiller_error');
    expect(fallbackReason('sensitive')).toBe('distiller_error');
    expect(fallbackReason('constructor')).toBe('distiller_error');
    expect(fallbackReason(7)).toBe('distiller_error');
  });
});

describe("the bar's one line (the spec's section 7)", () => {
  const fb = (reason: FallbackReason) => decideView(input({ status: { kind: 'fallback', reason } }));

  it('says nothing when the page shows as the member left it', () => {
    expect(pageLine(decideView(input({})), null)).toBeNull();
    expect(pageLine(decideView(input({ choice: 'full' })), null)).toBeNull();
    expect(pageLine(fb('member_choice'), null)).toBeNull();
    expect(pageLine(fb('not_page'), null)).toBeNull();
    // The site's own error page, as it made it.
    expect(pageLine(fb('http_error'), null)).toBeNull();
  });

  it('says why when the page chose for the member', () => {
    expect(pageLine(fb('http_auth'), null)).toEqual({ icon: 'lock', text: 'Sign-in is always the real page' });
    expect(pageLine(fb('sensitive_site'), null)).toEqual({ icon: 'lock', text: 'This site is always the real page' });
    expect(pageLine(fb('canvas_app'), null)?.text).toBe('This page works best as the real page');
    expect(pageLine(fb('person_check'), null)?.text).toBe("The site wants to check you're human");
    expect(pageLine(fb('sign_in'), null)).toEqual({ icon: 'lock', text: 'Sign-in is always the real page' });
    expect(pageLine(fb('payment'), null)).toEqual({ icon: 'lock', text: 'Payment is always the real page' });
    expect(pageLine(fb('terms_wall'), null)).toEqual({ icon: 'info', text: 'The site asks you to agree to its terms' });
    expect(pageLine(fb('timeout'), null)).toEqual({ icon: 'info', text: "Couldn't simplify this page", action: 'retry' });
    // A desk still answering past 1.5 s is the real page with no line; the words wait for the desk's no (Nov 9 re-review).
    expect(pageLine(decideView(input({ status: { kind: 'slow' } })), null)).toBeNull();
    expect(pageLine(fb('distiller_error'), null)).toEqual({ icon: 'info', text: "Couldn't simplify this page", action: 'retry' });
  });

  it("names the member's own last step for a while", () => {
    expect(pageLine(decideView(input({ choice: 'full' })), 'picked')).toEqual({ icon: null, text: 'Real page here from now on', action: 'undo' });
    expect(pageLine(decideView(input({ override: 'full' })), 'signin')?.text).toBe('Sign-in is always the real page');
    expect(pageLine(decideView(input({ override: 'full' })), 'video')?.text).toBe('This video plays on the real page');
    expect(pageLine(decideView(input({ override: 'full' })), 'pay')?.text).toBe('Payment is always the real page');
    expect(pageLine(decideView(input({})), 'refused')).toEqual({ icon: 'info', text: "That didn't work here", action: 'full' });
    // A step's line only while its view shows.
    expect(pageLine(decideView(input({})), 'picked')).toBeNull();
  });
});

describe('switchTitles', () => {
  it('says what a press does, and that the site keeps it', () => {
    expect(switchTitles('shop.example', decideView(input({})))).toEqual({ simple: 'Simplified', full: 'Show shop.example as the real page. Remembered for this site.' });
    expect(switchTitles('shop.example', decideView(input({ choice: 'full' }))).simple).toBe('Show shop.example simplified. Remembered for this site.');
    const fixed = switchTitles('bank.example', decideView(input({ status: { kind: 'fallback', reason: 'sensitive_site' } })));
    expect(fixed).toEqual({ simple: 'This site is always the real page', full: 'This site is always the real page' });
  });
});
