// The context menu's keyboard (src/ui/menu/nav.ts): what each key does from where focus is.
import { describe, expect, it } from 'vitest';
import { gridCells, initialIndex, isMenuKey, navKey, openStack, type NavNode } from '../../src/ui/menu/nav.ts';

const swatches = (checked?: number): NavNode[] => [
  { label: 'None', wide: true, checked: checked === 0 },
  ...['Slate', 'Blue', 'Teal', 'Green', 'Yellow', 'Amber', 'Rose', 'Violet'].map((label, i) => ({ label, checked: checked === i + 1 })),
];

const menu: NavNode[] = [
  { label: 'Highlight', children: swatches(2), columns: 4 },
  { label: 'Text color', children: swatches(), columns: 4, disabled: true },
  { label: 'Clear formatting' },
  { label: '', inert: true },
  { label: 'Cut' },
  { label: 'Copy' },
  { label: 'Paste' },
  { label: '', inert: true },
  { label: 'Turn into', children: [{ label: 'Title' }, { label: 'Heading', checked: true }, { label: 'Body' }] },
];

describe('menu keyboard: a list', () => {
  it('opens on the first item that can take focus', () => {
    expect(openStack(menu)).toEqual([0]);
    expect(openStack([{ label: 'x', inert: true }, { label: 'y', disabled: true }, { label: 'z' }])).toEqual([2]);
    expect(openStack([{ label: 'x', inert: true }])).toEqual([]);
  });

  it('moves down and up past headings, separators and disabled items, and wraps', () => {
    expect(navKey(menu, [0], 'ArrowDown').stack).toEqual([2]); // skips the disabled Text color
    expect(navKey(menu, [2], 'ArrowDown').stack).toEqual([4]); // skips the separator
    expect(navKey(menu, [8], 'ArrowDown').stack).toEqual([0]); // wraps
    expect(navKey(menu, [0], 'ArrowUp').stack).toEqual([8]);
    expect(navKey(menu, [4], 'ArrowUp').stack).toEqual([2]);
  });

  it('Home and End go to the ends', () => {
    expect(navKey(menu, [5], 'Home').stack).toEqual([0]);
    expect(navKey(menu, [0], 'End').stack).toEqual([8]);
  });

  it('a letter jumps to the next item that starts with it, case aside, and wraps', () => {
    expect(navKey(menu, [0], 'c').stack).toEqual([2]); // Clear formatting
    expect(navKey(menu, [2], 'c').stack).toEqual([4]); // Cut
    expect(navKey(menu, [4], 'C').stack).toEqual([5]); // Copy
    expect(navKey(menu, [5], 'c').stack).toEqual([2]); // back round
    expect(navKey(menu, [5], 'q').stack).toEqual([5]); // nothing starts with q
  });

  it('Enter and Space choose an item; the path says which', () => {
    expect(navKey(menu, [5], 'Enter').effect).toEqual({ type: 'activate', path: [5] });
    expect(navKey(menu, [6], ' ').effect).toEqual({ type: 'activate', path: [6] });
  });

  it('Escape and Tab close the menu and send focus back', () => {
    expect(navKey(menu, [4], 'Escape').effect).toEqual({ type: 'close', refocus: true });
    expect(navKey(menu, [4], 'Tab').effect).toEqual({ type: 'close', refocus: true });
    expect(navKey(menu, [4], 'Tab').handled).toBe(true);
  });

  it('leaves keys that are not its own to the page', () => {
    expect(navKey(menu, [4], 'F5').handled).toBe(false);
    expect(navKey(menu, [4], 'ArrowLeft')).toMatchObject({ stack: [4], handled: true }); // nothing to go back to
  });
});

describe('menu keyboard: submenus', () => {
  it('Right, Enter or Space opens a submenu on its checked item, else its first', () => {
    expect(navKey(menu, [8], 'ArrowRight').stack).toEqual([8, 1]); // Heading is checked
    expect(navKey(menu, [8], 'Enter').stack).toEqual([8, 1]);
    expect(navKey(menu, [0], ' ').stack).toEqual([0, 2]); // Blue is checked
    expect(navKey(menu, [8], 'Enter').effect.type).toBe('none');
  });

  it('Left and Escape close only the submenu, back on the item that opened it', () => {
    expect(navKey(menu, [8, 2], 'ArrowLeft').stack).toEqual([8]);
    const esc = navKey(menu, [8, 2], 'Escape');
    expect(esc.stack).toEqual([8]);
    expect(esc.effect.type).toBe('none');
  });

  it('Tab from a submenu closes the whole menu', () => {
    expect(navKey(menu, [8, 0], 'Tab').effect).toEqual({ type: 'close', refocus: true });
  });

  it('choosing in a submenu gives the full path', () => {
    expect(navKey(menu, [8, 2], 'Enter').effect).toEqual({ type: 'activate', path: [8, 2] });
  });

  it('opening a submenu with nothing focusable in it stays put', () => {
    const m: NavNode[] = [{ label: 'Empty', children: [{ label: 'x', inert: true }] }];
    expect(navKey(m, [0], 'ArrowRight').stack).toEqual([0]);
  });
});

describe('menu keyboard: a grid of swatches', () => {
  // None on its own row, then Slate Blue Teal Green / Yellow Amber Rose Violet.
  it('lays None on a row of its own, then four across', () => {
    const cells = gridCells(swatches(), 4);
    expect(cells[0]).toEqual({ row: 0, col: 0 });
    expect(cells[1]).toEqual({ row: 1, col: 0 });
    expect(cells[4]).toEqual({ row: 1, col: 3 });
    expect(cells[5]).toEqual({ row: 2, col: 0 });
    expect(cells[8]).toEqual({ row: 2, col: 3 });
  });

  it('Right and Left move along a row and stop at its ends', () => {
    expect(navKey(menu, [0, 1], 'ArrowRight').stack).toEqual([0, 2]);
    expect(navKey(menu, [0, 4], 'ArrowRight').stack).toEqual([0, 4]);
    expect(navKey(menu, [0, 3], 'ArrowLeft').stack).toEqual([0, 2]);
  });

  it('Left from a row start goes back to the menu', () => {
    expect(navKey(menu, [0, 5], 'ArrowLeft').stack).toEqual([0]);
    expect(navKey(menu, [0, 0], 'ArrowLeft').stack).toEqual([0]);
  });

  it('Down and Up keep the column, take the nearest one in a shorter row, and wrap', () => {
    expect(navKey(menu, [0, 2], 'ArrowDown').stack).toEqual([0, 6]); // Blue to Amber
    expect(navKey(menu, [0, 6], 'ArrowDown').stack).toEqual([0, 0]); // to None, the only one in its row
    expect(navKey(menu, [0, 0], 'ArrowDown').stack).toEqual([0, 1]); // None to Slate
    expect(navKey(menu, [0, 0], 'ArrowUp').stack).toEqual([0, 5]); // wraps to the last row
    expect(navKey(menu, [0, 7], 'ArrowUp').stack).toEqual([0, 3]); // Rose to Teal
  });

  it('a letter does nothing in a grid', () => {
    expect(navKey(menu, [0, 1], 'b').stack).toEqual([0, 1]);
    expect(navKey(menu, [0, 1], 'b').handled).toBe(false);
  });

  it('Enter picks a swatch', () => {
    expect(navKey(menu, [0, 6], 'Enter').effect).toEqual({ type: 'activate', path: [0, 6] });
  });

  it('starts on the checked swatch', () => {
    expect(initialIndex(swatches(7))).toBe(7);
    expect(initialIndex(swatches())).toBe(0);
  });
});

describe('the last color used, and an item that acts and has a row', () => {
  it('a row starts on the item marked to start on, before the checked one', () => {
    const row: NavNode[] = [{ label: 'Amber' }, { label: 'Blue', start: true }, { label: 'None', checked: true }];
    expect(initialIndex(row)).toBe(1);
    expect(initialIndex([{ label: 'Amber' }, { label: 'Blue', start: true, disabled: true }, { label: 'None', checked: true }])).toBe(2);
  });

  it('Enter on Turn into callout acts (the caller then opens its row); Right only opens the row', () => {
    const m: NavNode[] = [{ label: 'Turn into callout', action: true, columns: 7, children: swatches() }];
    expect(navKey(m, [0], 'Enter')).toMatchObject({ stack: [0], effect: { type: 'activate', path: [0] } });
    expect(navKey(m, [0], ' ').effect).toEqual({ type: 'activate', path: [0] });
    expect(navKey(m, [0], 'ArrowRight')).toMatchObject({ stack: [0, 0], effect: { type: 'none' } });
  });
});

describe('what opens a menu from the keyboard', () => {
  it('is Shift+F10 or the menu key, with no other modifier', () => {
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });
});
