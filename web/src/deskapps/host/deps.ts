// What the host borrows from the first load (`../door.ts` `HostDeps`), set once by `index.ts` `start`.
import type { HostDeps } from '../door';

export let shared: HostDeps = null as unknown as HostDeps;
export const setShared = (d: HostDeps): void => {
  shared = d;
};
