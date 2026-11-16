import { describe, expect, it } from 'vitest';
import { defaultDesk, overlaps, type LayoutDesk } from '../canvas/layout';
import { isUntouched, type LayoutDoc } from '../canvas/layoutDoc';
import { fitDeskToApp, fitDeskToFiles } from './tiles';

describe('the Files tile', () => {
  it('goes on a desk that has none, at a free place, on top, and only once', () => {
    const desk = defaultDesk('d-a', 0, 0);
    expect(desk.items.some((i) => i.app === 'files')).toBe(false);
    const withFiles = fitDeskToFiles(desk, true);
    const tile = withFiles.items.find((i) => i.app === 'files')!;
    expect(tile.id).toBe('d-a:files');
    expect(withFiles.items.filter((i) => overlaps(i, tile))).toEqual([tile]);
    expect(fitDeskToFiles(withFiles, true)).toBe(withFiles);
  });

  it('the kill switch takes it away again, and a desk with none stays the same object', () => {
    const desk = defaultDesk('d-a', 0, 0);
    expect(fitDeskToFiles(desk, false)).toBe(desk);
    const gone = fitDeskToFiles(fitDeskToFiles(desk, true), false);
    expect(gone.items.map((i) => i.app)).toEqual(desk.items.map((i) => i.app));
  });

  it('does not make a desk "arranged": nobody has touched it, so there is nothing to send for it', () => {
    const doc: LayoutDoc = { desks: { 'd-a': fitDeskToFiles(defaultDesk('d-a', 0, 0), true) }, z: ['d-a'] };
    expect(isUntouched(doc, ['d-a'])).toBe(true);
  });
});

describe('the Documents tile (on by default, draft ADR "Documents")', () => {
  it('goes on beside Files and To-do at its own free place, with id `<desk>:documents`, once; its switch takes only it away', () => {
    const desk = fitDeskToApp(fitDeskToApp(fitDeskToApp(defaultDesk('d-a', 0, 0), 'files', true), 'todo', true), 'documents', true);
    const docs = desk.items.find((i) => i.app === 'documents')!;
    expect(docs.id).toBe('d-a:documents');
    expect(desk.items.filter((i) => overlaps(i, docs))).toEqual([docs]);
    expect(fitDeskToApp(desk, 'documents', true)).toBe(desk);
    const off = fitDeskToApp(desk, 'documents', false);
    expect(off.items.map((i) => i.app)).not.toContain('documents');
    expect(off.items.map((i) => i.app)).toContain('todo');
    expect(isUntouched({ desks: { 'd-a': desk }, z: ['d-a'] }, ['d-a'])).toBe(true);
  });
});

describe('the To-do tile (on by default, the VISION)', () => {
  it('goes on beside Files, each at its own free place, with id `<desk>:todo`, and only once', () => {
    const desk = fitDeskToApp(fitDeskToApp(defaultDesk('d-a', 0, 0), 'files', true), 'todo', true);
    const todo = desk.items.find((i) => i.app === 'todo')!;
    expect(todo.id).toBe('d-a:todo');
    expect(desk.items.filter((i) => overlaps(i, todo))).toEqual([todo]);
    expect(fitDeskToApp(desk, 'todo', true)).toBe(desk);
    expect(desk.stack?.at(-1) ?? desk.items.at(-1)?.id).toBe('d-a:todo');
  });

  it('on a desk an open Notebook fills across, goes beside it rather than growing the desk (E2E-RED, staging Nov 14)', () => {
    // fleet-officer's desk: six columns, the Notebook open across all of them. Placed by the grid alone, To-do went to a new
    // row and the desk grew to 604, so at 1280 x 720 the Notebook fell under the 480 px a live tile needs.
    const desk: LayoutDesk = { id: 'd-a', x: 0, y: 0, w: 664, h: 512, items: [{ id: 'd-a:notebook', app: 'notebook', x: 8, y: 24, w: 540, h: 444 }] };
    const laptop = (w: number, h: number): number => Math.min(1280 / (w + 96), 584 / (h + 96));
    const next = fitDeskToApp(desk, 'todo', true, laptop);
    expect(next.items.find((i) => i.app === 'todo')).toMatchObject({ x: 564, y: 24, w: 76, h: 76 });
    expect({ w: next.w, h: next.h }).toEqual({ w: 664, h: 512 });
    expect(540 * laptop(next.w, next.h)).toBeGreaterThanOrEqual(480);
  });

  it('its kill switch takes only its own tile away', () => {
    const both = fitDeskToApp(fitDeskToApp(defaultDesk('d-a', 0, 0), 'files', true), 'todo', true);
    const off = fitDeskToApp(both, 'todo', false);
    expect(off.items.some((i) => i.app === 'todo')).toBe(false);
    expect(off.items.some((i) => i.app === 'files')).toBe(true);
  });

  it('does not make a desk "arranged"', () => {
    const doc: LayoutDoc = { desks: { 'd-a': fitDeskToApp(fitDeskToApp(defaultDesk('d-a', 0, 0), 'files', true), 'todo', true) }, z: ['d-a'] };
    expect(isUntouched(doc, ['d-a'])).toBe(true);
  });
});
