import { describe, expect, it } from 'vitest';
import { RESTORE_REFUSED, restoreRefusal } from '../../src/ui/refusals';

describe('restoreRefusal', () => {
  it('says who can restore when the desk answers forbidden', () => {
    expect(restoreRefusal(Object.assign(new Error('x'), { code: 'forbidden' }))).toBe(RESTORE_REFUSED);
    expect(RESTORE_REFUSED).toBe('Only the person who deleted this page, or a moderator, can restore it.');
  });
  it('says nothing for any other failure', () => {
    for (const e of [new Error('x'), null, undefined, { code: 'not_found' }, { code: 'bad_request' }]) expect(restoreRefusal(e)).toBeNull();
  });
});
