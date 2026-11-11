// A member's picture in Commons: only Platform's checked-avatar route is ever drawn; anything else is initials.
import { describe, expect, it } from 'vitest';
import { builtRecipeOf, pictureOf } from '../../src/ui/names.ts';

const ok = 'https://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2';

describe('pictureOf', () => {
  it('takes exactly the public avatar route over https', () => {
    expect(pictureOf(ok)).toBe(ok);
  });
  it('refuses every other address', () => {
    for (const bad of [undefined, null, 5, '', 'http://x.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxy2', 'https://x.test/a.png', `${ok}?x=1`, 'javascript:alert(1)', 'blob:https://x.test/1', 'data:image/png;base64,AAAA'])
      expect(pictureOf(bad)).toBeNull();
  });
});

describe('builtRecipeOf', () => {
  const r = { kind: 'built', kit: 1, skin: 4, face: 'smile' };
  it('takes a plain built kit-1 recipe', () => {
    expect(builtRecipeOf(r)).toEqual(r);
  });
  it('refuses everything else, so the initials show', () => {
    for (const bad of [undefined, null, 'x', 5, [], [r], { ...r, kind: 'upload' }, { ...r, kit: 2 }, { ...r, kit: '1' }, { skin: 4 }, { ...r, face: 'x'.repeat(600) }, Object.create(r)])
      expect(builtRecipeOf(bad)).toBeNull();
  });
});
