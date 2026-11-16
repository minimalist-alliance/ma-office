// The phone's thumb row: which apps keep a tab and which go under the "+" (`thumbs.ts`).
import { describe, expect, it } from 'vitest';
import type { AppId } from '../canvas/layout';
import { PLUS_W, ROW_FIXED, splitThumbs, THUMB_MIN } from './thumbs';

const SIX: AppId[] = ['courier', 'notebook', 'browser', 'agent', 'files', 'todo'];
const courierLater = (a: AppId): boolean => a === 'courier';
const never = (): boolean => false;

describe('the thumb row at a phone width', () => {
  it('at 360 px holds six 44 px tabs beside its own parts, or five and the "+"', () => {
    expect(Math.floor((360 - ROW_FIXED) / THUMB_MIN)).toBe(6);
    expect(Math.floor((360 - ROW_FIXED - PLUS_W) / THUMB_MIN)).toBe(5);
  });

  it('gives every app a tab when they fit, the "+" included, and puts nothing under it', () => {
    expect(splitThumbs(SIX, 'notebook', 360, false, courierLater)).toEqual({ row: SIX, under: [] });
    expect(splitThumbs(SIX, 'notebook', 412, true, courierLater)).toEqual({ row: SIX, under: [] });
  });

  it('at 360 px with the Apps row: Courier, coming later, goes under the "+", and To-do keeps its tab', () => {
    expect(splitThumbs(SIX, 'notebook', 360, true, courierLater)).toEqual({ row: ['notebook', 'browser', 'agent', 'files', 'todo'], under: ['courier'] });
    expect(splitThumbs(SIX, 'notebook', 390, true, courierLater).under).toEqual(['courier']);
  });

  it('with nothing coming later, the last in the desk\'s order goes under first', () => {
    expect(splitThumbs(SIX, 'notebook', 360, true, never)).toEqual({ row: ['courier', 'notebook', 'browser', 'agent', 'files'], under: ['todo'] });
  });

  it('the shown app always keeps its tab, in its own place in the order', () => {
    expect(splitThumbs(SIX, 'courier', 360, true, courierLater)).toEqual({ row: ['courier', 'notebook', 'browser', 'agent', 'files'], under: ['todo'] });
    expect(splitThumbs(SIX, 'todo', 360, true, never)).toEqual({ row: ['courier', 'notebook', 'browser', 'agent', 'todo'], under: ['files'] });
  });

  it('a long list (agents and installed apps) keeps what fits and the rest go under, in order', () => {
    const many: AppId[] = [...SIX, 'agent:ag-aaaaaaaaaaaa', 'agent:ag-bbbbbbbbbbbb', 'app:com.example.tally'];
    const s = splitThumbs(many, 'browser', 360, false, courierLater);
    expect(s.row).toEqual(['notebook', 'browser', 'agent', 'files', 'todo']);
    expect(s.under).toEqual(['courier', 'agent:ag-aaaaaaaaaaaa', 'agent:ag-bbbbbbbbbbbb', 'app:com.example.tally']);
    expect([...s.row, ...s.under].sort()).toEqual([...many].sort());
  });

  it('keeps the shown app\'s tab however narrow', () => {
    expect(splitThumbs(SIX, 'browser', 120, false, never)).toEqual({ row: ['browser'], under: ['courier', 'notebook', 'agent', 'files', 'todo'] });
  });
});
