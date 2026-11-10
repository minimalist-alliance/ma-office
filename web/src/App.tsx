import { lazy, Suspense } from 'react';
import { RefusalScreen, SignInScreen } from './chrome/CalmScreen';
import { useSession } from './platform/session';
import { Shell } from './shell/Shell';

// Its own chunk: the ZIP writer, the hashing and the page stay out of the main bundle (budget, design 2.2).
const ExportPage = lazy(() => import('./export/ExportPage'));
const ON_EXPORT = /^\/export\/?$/.test(window.location.pathname);

export function App() {
  const status = useSession((s) => s.status);
  // Only where client-config says it's on: anywhere else, and with it off or unreadable, `/export` is the office.
  const exportPage = useSession((s) => (!ON_EXPORT ? false : s.config ? s.config.export?.enabled === true : s.configFailed ? false : null));
  if (status === 'booting') return null; // a few ms of IndexedDB; the ground color is already painted
  if (status === 'signedOut') return <SignInScreen />;
  if (status === 'refused') return <RefusalScreen />;
  if (exportPage === null) return null; // client-config is on its way
  if (exportPage) {
    return (
      <Suspense fallback={null}>
        <ExportPage />
      </Suspense>
    );
  }
  return <Shell />;
}
