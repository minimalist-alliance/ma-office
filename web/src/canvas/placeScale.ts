// How the office frames a desk on this screen, for the tiles it places itself (`agentTiles.ts` `withNewTile`): `Shell` sets it
// once (`shell/actions.ts` `deskScaleFor`, the camera's own fit), and the watchers that place tiles (Files and To-do, agents,
// installed apps) read it, so none of them needs the camera. Unset (tests, before the shell), it says nothing: a full desk then
// grows downward as it always did.
import type { DeskScale } from './agentTiles';

let current: DeskScale | null = null;

export const setPlaceScale = (scale: DeskScale | null): void => {
  current = scale;
};

export const placeScale: DeskScale = (w, h) => (current ? current(w, h) : null);
