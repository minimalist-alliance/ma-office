// The member's MA credits in the Agent app (deskd API.md §24): the picker's option, the Keys list's line, and a helper's failed
// reply on them, in credits and never money.
import { describe, expect, it } from 'vitest';
import { errorText } from './agents';
import { creditsLine, creditsOption } from '../ui/Keys';
import { isCreditsKey, type KeyMeta } from '../client/types';

const row = (credits: KeyMeta['credits']): KeyMeta => ({ keyId: 'ma-credits', provider: 'ma-credits', providerName: 'Minimalist Alliance', label: 'MA credits', last4: '', createdAt: 0, createdByDesk: '', available: true, credits });

describe('MA credits', () => {
  it('is its own row, with no last four and no money', () => {
    expect(isCreditsKey(row(null))).toBe(true);
    expect(isCreditsKey({ keyId: 'k-1' })).toBe(false);
    expect(creditsOption(row({ left: 1262, starting: 262, topUp: 1000, lighter: false }))).toBe('MA credits · 1,262 left');
    expect(creditsOption(row(null))).toBe('MA credits');
    for (const line of [
      creditsLine(row({ left: 262, starting: 262, topUp: 0, lighter: false })),
      creditsLine(row({ left: 1262, starting: 262, topUp: 1000, lighter: false })),
      creditsLine(row({ left: 0, starting: 0, topUp: 0, lighter: true, lighterLeft: 5 })),
      creditsLine(row({ left: 0, starting: 0, topUp: 0, lighter: false })),
      creditsLine(row(null)),
    ]) {
      expect(line).not.toMatch(/\$|····/);
    }
    expect(creditsLine(row({ left: 1262, starting: 262, topUp: 1000, lighter: false }))).toBe('1,262 credits left, 1,000 from top-ups. Your agents run on Minimalist Alliance.');
    expect(creditsLine(row({ left: 0, starting: 0, topUp: 0, lighter: true }))).toBe('Your credits are used up, so your agents use a lighter model for now.');
    expect(creditsLine(row(null))).toBe('Your agents run on Minimalist Alliance. No key needed.');
  });

  it('says what a helper on credits ran into, in plain words', () => {
    expect(errorText('provider_error', 'limit', 'ma-credits')).toBe('Your MA credits are used up for now. Give this agent your own key to keep going.');
    expect(errorText('provider_error', 'forbidden', 'ma-credits')).toBe('MA credits aren’t available on this desk. Give this agent your own key.');
    // Anything else is the generic line, as for every provider.
    expect(errorText('provider_error', 'unavailable', 'ma-credits')).toBe(errorText('provider_error', 'unavailable', 'anthropic'));
  });
});
