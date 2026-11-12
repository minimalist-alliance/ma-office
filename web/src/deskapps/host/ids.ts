// An installed app's id (`app:<manifest id>`, `canvas/layout.ts` `isDeskApp`) to and from its manifest id, for the host.
import { isDeskApp, type DeskAppId } from '../../canvas/layout';

export const deskApp = (id: string): DeskAppId => `app:${id}`;
export const deskAppIdOf = (app: string): string | null => (isDeskApp(app) ? app.slice(4) : null);

/**
 * The desk app contract's samples (`com.minimalistalliance.sample.*`: today Tally, `spikes/app-contract-sample`) are a
 * developer's, never a member's. A production build drops them from all a desk says, catalog and installed alike, whatever a
 * catalog lists (`wire.ts` `parseCatalog`, `store.ts` `appRecord`); dev, the tests and the shell harness's mock keep them.
 */
export const isSampleApp = (id: string): boolean => id.startsWith('com.minimalistalliance.sample.');
/** Read when used, so a test can stand in for a production build (`vi.stubEnv('MODE', 'production')`). */
export const hidesSamples = (): boolean => import.meta.env.MODE === 'production';
