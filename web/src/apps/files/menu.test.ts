import { describe, expect, it } from 'vitest';
import { menuItems, menuTypeAhead, place, selectForMenu, type MenuWorld } from './menu';
import { EMPTY_SEL } from './selection';

const world: MenuWorld = { mode: 'folder', locked: false, rowCount: 3 };
const file = { type: 'file' as const };
const dir = { type: 'dir' as const };
const ids = (w: MenuWorld, rows: Parameters<typeof menuItems>[1]): string[] => menuItems(w, rows).map((i) => i.label);

describe('menu items: destructive last', () => {
  const flags = (w: MenuWorld, rows: Parameters<typeof menuItems>[1]) => menuItems(w, rows).map((i) => [i.label, !!i.danger, !!i.separatorBefore]);
  it('Delete is last, danger, after a separator', () => {
    expect(flags(world, [file])).toEqual([['Download', false, false], ['Rename', false, false], ['Move to…', false, false], ['Delete', true, true]]);
    expect(flags(world, [file, dir]).at(-1)).toEqual(['Delete', true, true]);
  });
  it('the trash item menu ends with Delete forever, danger, after a separator', () => {
    expect(flags({ ...world, mode: 'trash' }, [file])).toEqual([['Restore', false, false], ['Delete forever', true, true]]);
  });
  it('Empty trash alone is danger with no separator', () => {
    expect(flags({ ...world, mode: 'trash' }, null)).toEqual([['Empty trash', true, false]]);
  });
  it('nothing else is danger or separated', () => {
    const all = [menuItems(world, null), menuItems(world, [dir]), menuItems({ ...world, mode: 'search' }, [file])].flat();
    expect(all.filter((i) => i.danger).map((i) => i.id)).toEqual(['delete', 'delete']);
    expect(menuItems(world, null).some((i) => i.separatorBefore)).toBe(false);
  });
});

describe('menu items', () => {
  it('a file has the bar in its order and words', () => {
    expect(ids(world, [file])).toEqual(['Download', 'Rename', 'Move to…', 'Delete']);
  });
  it('a folder adds Open, first', () => {
    expect(ids(world, [dir])).toEqual(['Open', 'Download', 'Rename', 'Move to…', 'Delete']);
  });
  it('a multi-selection leaves out what is for one item', () => {
    expect(ids(world, [file, file])).toEqual(['Move to…', 'Delete']);
    expect(ids(world, [dir, file])).toEqual(['Move to…', 'Delete']);
  });
  it('empty space has the uploads and New folder, as the bar does', () => {
    expect(ids(world, null)).toEqual(['Upload files', 'Upload folder', 'New folder']);
  });
  it('search results are rows with the folder actions, with nothing for empty space', () => {
    const s: MenuWorld = { ...world, mode: 'search' };
    expect(ids(s, [file])).toEqual(['Download', 'Rename', 'Move to…', 'Delete']);
    expect(ids(s, null)).toEqual([]);
  });
  it('the trash has its own actions', () => {
    const t: MenuWorld = { ...world, mode: 'trash' };
    expect(ids(t, [file])).toEqual(['Restore', 'Delete forever']);
    expect(ids(t, [file, dir])).toEqual(['Restore', 'Delete forever']);
    expect(ids(t, null)).toEqual(['Empty trash']);
    expect(ids({ ...t, rowCount: 0 }, null)).toEqual([]);
  });
  it('a desk that cannot answer offers nothing', () => {
    expect(ids({ ...world, locked: true }, [file])).toEqual([]);
    expect(ids({ ...world, locked: true }, null)).toEqual([]);
  });
});

describe('right click selection', () => {
  const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  it('outside the selection, the selection becomes that row', () => {
    expect(selectForMenu(rows, { keys: ['a', 'b'], active: 0, anchor: 0 }, 2)).toEqual({ keys: ['c'], active: 2, anchor: 2 });
    expect(selectForMenu(rows, EMPTY_SEL, 1)).toEqual({ keys: ['b'], active: 1, anchor: 1 });
  });
  it('inside a multi-selection, it is kept', () => {
    const sel = { keys: ['a', 'b'], active: 0, anchor: 0 };
    expect(selectForMenu(rows, sel, 1)).toEqual({ keys: ['a', 'b'], active: 1, anchor: 0 });
  });
  it('a row that is not there changes nothing', () => {
    const sel = { keys: ['a'], active: 0, anchor: 0 };
    expect(selectForMenu(rows, sel, 9)).toBe(sel);
  });
});

describe('type-ahead and placement', () => {
  it('finds the next label that starts with the letters, wrapping', () => {
    const labels = ['Download', 'Rename', 'Move to…', 'Delete'];
    expect(menuTypeAhead(labels, 0, 'd')).toBe(3);
    expect(menuTypeAhead(labels, 3, 'd')).toBe(0);
    expect(menuTypeAhead(labels, 0, 'mo')).toBe(2);
    expect(menuTypeAhead(labels, 0, 'x')).toBe(-1);
  });
  it('flips at the right and bottom edges, and shifts in when it fits neither way', () => {
    expect(place(10, 10, 100, 80, 400, 300)).toEqual({ left: 10, top: 10 });
    expect(place(390, 290, 100, 80, 400, 300)).toEqual({ left: 290, top: 210 });
    expect(place(50, 50, 100, 80, 120, 60)).toEqual({ left: 6, top: 6 });
  });
});
