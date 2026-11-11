// The setup circle's chunk (S-121), fetched by `door.ts` once the member holds a tier: the circle and its panel, the
// account menu's switch, the watchers that notice a step being used.
import { useSetupDoor } from './door';
import { SetupCircle, SetupMenuItems } from './SetupCircle';
import { watchSetup } from './signals';

let opened = false;

export function open(): void {
  if (opened) return;
  opened = true;
  watchSetup();
  useSetupDoor.setState({ Circle: SetupCircle, MenuItems: SetupMenuItems });
}
