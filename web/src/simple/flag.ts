// The simplified view's kill switch, the one part of task 47 in the main bundle: the Browser window reads it as it opens.
import type { ClientConfig } from '../platform/clientConfig';

/**
 * Client-config's `simpleView` block (task 47) is a kill switch, the owner's rule for finished features: absent is on, and
 * only `{ enabled: false }` turns it off. On, a desk whose `deskd` doesn't serve section 14 (`not_found`) or has its own
 * switch off (`unavailable`, `disabled`) shows the real page with no switch, as before. `npm run dev` has no
 * client-config: there `?simple=0` turns it off; no build but the dev server reads that.
 */
export const simpleViewOn = (cfg: ClientConfig | null | undefined): boolean =>
  cfg?.simpleView?.enabled !== false && !(import.meta.env.DEV && new URLSearchParams(window.location.search).get('simple') === '0');
