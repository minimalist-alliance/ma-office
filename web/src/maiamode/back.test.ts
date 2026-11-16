// Back (the focus shield; CONCEPT.md §7.3): the working set kept at a card's first sight, and the plan that puts it back exactly:
// the camera, the windows the one thing opened closed, the ones it closed opened again at their places, the stacking, the active one.
import { describe, expect, it } from 'vitest';
import { restorePlan, Snapshots, takeSnapshot, type WinNow } from './back';

const win = (key: string, z: number, patch: Partial<WinNow> = {}): WinNow => ({ key, deskId: key.split(':')[0]!, app: key.split(':')[1]!, itemId: `t-${key}`, mode: 'window', rect: { x: 10 * z, y: 80, w: 600, h: 400 }, z, closing: false, ...patch });

describe('the snapshot', () => {
  it('keeps the camera, the desk, every open window lowest first and the active one, never a closing window', () => {
    const s = takeSnapshot({ cardId: 'mc-1', at: 5, surface: 'desk', camera: 'desk', deskId: 'd-w', windows: [win('d-w:notebook', 7), win('d-w:files', 3), win('d-w:todo', 9, { closing: true })], active: 'd-w:notebook', item: { kind: 'page', id: 'pg-1' } });
    expect(s.windows.map((w) => w.key)).toEqual(['d-w:files', 'd-w:notebook']);
    expect(s).toMatchObject({ cardId: 'mc-1', camera: 'desk', deskId: 'd-w', active: 'd-w:notebook', item: { kind: 'page', id: 'pg-1' }, viewport: null });
    expect(takeSnapshot({ cardId: 'x', at: 1, surface: 'desk', camera: 'desk', deskId: 'd-w', windows: [], active: 'gone', item: null }).active).toBeNull();
  });
});

describe('the restore plan', () => {
  const snap = takeSnapshot({ cardId: 'mc-1', at: 5, surface: 'desk', camera: 'desk', deskId: 'd-w', windows: [win('d-w:files', 3), win('d-w:notebook', 7)], active: 'd-w:notebook', item: null });

  it('closes what the one thing opened, opens what it closed, puts places back and restacks in order', () => {
    const now = [win('d-w:files', 3, { rect: { x: 0, y: 72, w: 900, h: 700 } }), win('d-p:agent', 12)];
    const p = restorePlan(snap, now, { camera: 'desk', deskId: 'd-p' });
    expect(p.camera).toEqual({ mode: 'desk', deskId: 'd-w' });
    expect(p.close).toEqual(['d-p:agent']);
    expect(p.open.map((w) => w.key)).toEqual(['d-w:notebook']);
    expect(p.places.map((x) => x.key)).toEqual(['d-w:files', 'd-w:notebook']);
    expect(p.places[0]?.rect).toEqual({ x: 30, y: 80, w: 600, h: 400 });
    expect(p.raise).toEqual(['d-w:files', 'd-w:notebook']);
    expect(p.active).toBe('d-w:notebook');
  });
  it('leaves the camera and the places alone when they’re already as they were', () => {
    // Stacked otherwise (the notebook under the files now), but every place as it was.
    const p = restorePlan(snap, [win('d-w:files', 3), win('d-w:notebook', 1, { rect: { x: 70, y: 80, w: 600, h: 400 } })], { camera: 'desk', deskId: 'd-w' });
    expect(p.camera).toBeNull();
    expect(p.close).toEqual([]);
    expect(p.open).toEqual([]);
    expect(p.places).toEqual([]);
    expect(p.raise).toEqual(['d-w:files', 'd-w:notebook']);
  });
  it('goes back to the overview when that’s where the member was', () => {
    const over = takeSnapshot({ cardId: 'mc-2', at: 5, surface: 'overview', camera: 'overview', deskId: 'd-w', windows: [], active: null, item: null });
    expect(restorePlan(over, [], { camera: 'desk', deskId: 'd-w' }).camera).toEqual({ mode: 'overview' });
    expect(restorePlan(over, [], { camera: 'overview', deskId: 'd-w' }).camera).toBeNull();
  });
});

describe('the snapshots this page keeps', () => {
  it('keeps the first sight of each card, the last 10, in memory', () => {
    const s = new Snapshots(10);
    const at = (cardId: string, n: number) => takeSnapshot({ cardId, at: n, surface: 'desk', camera: 'desk', deskId: 'd-w', windows: [], active: null, item: null });
    s.put(at('mc-1', 1));
    s.put(at('mc-1', 2));
    expect(s.get('mc-1')?.at).toBe(1);
    for (let n = 2; n <= 11; n += 1) s.put(at(`mc-${n}`, n));
    expect(s.get('mc-1')).toBeNull();
    expect(s.get('mc-11')?.at).toBe(11);
    s.drop('mc-11');
    expect(s.get('mc-11')).toBeNull();
    s.clear();
    expect(s.get('mc-5')).toBeNull();
  });
});
