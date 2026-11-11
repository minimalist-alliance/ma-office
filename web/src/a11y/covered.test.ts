import { describe, expect, it } from 'vitest';
import { coveredTiles } from './covered';
import type { AppWindowState } from '../state/windowStore';

const win = (itemId: string, over: Partial<AppWindowState> = {}): AppWindowState =>
  ({ key: `d1:${itemId}`, deskId: 'd1', app: 'notebook', itemId, mode: 'window', rect: { x: 100, y: 100, w: 400, h: 300 }, z: 1, closing: false, ...over }) as AppWindowState;
const tiles = [
  { id: 'a', rect: { x: 150, y: 150, w: 76, h: 76 } },
  { id: 'b', rect: { x: 800, y: 150, w: 76, h: 76 } },
];
const cam = { x: 0, y: 0, s: 1 };
const vp = { w: 1280, h: 800 };

describe('coveredTiles', () => {
  it('lists a tile its own open window sits over', () => {
    expect(coveredTiles('d1', tiles, [win('a')], cam, vp, false)).toEqual(['a']);
  });
  it('leaves a tile whose window is somewhere else, closing, or another desk\'s', () => {
    expect(coveredTiles('d1', tiles, [win('b')], cam, vp, false)).toEqual([]);
    expect(coveredTiles('d1', tiles, [win('a', { closing: true })], cam, vp, false)).toEqual([]);
    expect(coveredTiles('d1', tiles, [win('a', { deskId: 'd2' })], cam, vp, false)).toEqual([]);
  });
  it('follows the window when it moves, and the camera', () => {
    expect(coveredTiles('d1', tiles, [win('a', { rect: { x: 600, y: 400, w: 300, h: 300 } })], cam, vp, false)).toEqual([]);
    expect(coveredTiles('d1', tiles, [win('a')], { x: 700, y: 0, s: 1 }, vp, false)).toEqual([]);
  });
  it('counts a full window as the whole screen', () => {
    expect(coveredTiles('d1', tiles, [win('b', { mode: 'full' })], cam, vp, false)).toEqual(['b']);
    expect(coveredTiles('d1', tiles, [win('b')], cam, vp, true)).toEqual(['b']);
  });
});
