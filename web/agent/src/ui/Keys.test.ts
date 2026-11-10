import { describe, expect, it } from 'vitest';
import { AgentError } from '../client/agentClient';
import { keyFailure } from './Keys';

describe('what a key that didn\'t land says', () => {
  it('the desk\'s `provider_mismatch` says the form\'s own line, without a name it can\'t know', () => {
    const err = new AgentError('bad_request', { reason: 'key_malformed', detail: 'provider_mismatch' });
    expect(keyFailure(err)).toBe('That’s a key from another provider. Pick its provider above and paste it again.');
  });
  it('a refused key, and a malformed one, keep their words', () => {
    expect(keyFailure(new AgentError('precondition_failed', { reason: 'key_refused', detail: 'auth' }))).toBe('The provider refused this key. Check it in the provider’s console, then paste it again.');
    expect(keyFailure(new AgentError('bad_request', { reason: 'key_malformed', detail: 'format' }))).toBe('That doesn’t look like a key from this provider.');
  });
});
