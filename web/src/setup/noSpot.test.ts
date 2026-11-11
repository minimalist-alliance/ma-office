// A Founder with no guild sees no Guild Desk placeholder (the owner, Nov 10): the setup circle hangs only the circle and
// the account menu's items on the door, and `goOverview` frames nothing but real desks.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./signals', () => ({ watchSetup: vi.fn() }));
vi.mock('../platform/session', () => ({ useSession: () => null }));
vi.mock('../state/deskStore', () => ({ useDeskStore: () => null }));
vi.mock('./SetupCircle', () => ({ SetupCircle: () => null, SetupMenuItems: () => null }));

describe('no empty Guild Desk spot', () => {
  it('opening the circle puts only the circle and the menu items on the door', async () => {
    const { open } = await import('./core');
    const { useSetupDoor } = await import('./door');
    open();
    expect(Object.keys(useSetupDoor.getState()).sort()).toEqual(['Circle', 'MenuItems']);
  });
});
