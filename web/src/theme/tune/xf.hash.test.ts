// `xf.ts` is shared, byte for byte, with ma-platform `web/forums/src/tune/xf.ts` (the Forums' theme sliders): one setting for
// the account, so the same position must give the same colours in both. A change to either is made to both, and both pins
// move together.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const PIN = '2c1ab1a59fdef409de0323dbe56829339ef2dc5d004a26e9c5b18fb046553547';

it('xf.ts is the shared file (the same pin as the Forums copy)', () => {
  const sha = createHash('sha256').update(readFileSync(new URL('./xf.ts', import.meta.url))).digest('hex');
  expect(sha).toBe(PIN);
});
