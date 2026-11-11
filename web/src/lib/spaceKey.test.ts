import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { spaceKey } from './spaceKey';

const ev = (key: string) => {
  const click = vi.fn();
  const preventDefault = vi.fn();
  return { e: { key, preventDefault, currentTarget: { click } } as unknown as KeyboardEvent<HTMLAnchorElement>, click, preventDefault };
};

describe('spaceKey, a link styled as a button', () => {
  it('Space is held on the way down and presses the link on its release', () => {
    const down = ev(' ');
    spaceKey.onKeyDown(down.e);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(down.click).not.toHaveBeenCalled();
    const up = ev(' ');
    spaceKey.onKeyUp(up.e);
    expect(up.click).toHaveBeenCalledTimes(1);
  });
  it('leaves Enter and every other key to the link', () => {
    for (const key of ['Enter', 'a', 'Tab']) {
      const down = ev(key);
      const up = ev(key);
      spaceKey.onKeyDown(down.e);
      spaceKey.onKeyUp(up.e);
      expect(down.preventDefault).not.toHaveBeenCalled();
      expect(up.click).not.toHaveBeenCalled();
    }
  });
});
