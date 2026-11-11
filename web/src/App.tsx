import { lazy, Suspense } from 'react';
import { RefusalScreen, SignInScreen } from './chrome/CalmScreen';
import { takeOpenFromLocation } from './open/intent';
import { useSession } from './platform/session';
import { Shell } from './shell/Shell';

// Its own chunk: the ZIP writer, the hashing and the page stay out of the main bundle (budget, design 2.2).
const ExportPage = lazy(() => import('./export/ExportPage'));
const ON_EXPORT = /^\/export\/?$/.test(window.location.pathname);
// Where OpenRouter sends its window back (agent-free-key spec §2.2): its own small chunk, before the session, as it needs none.
const ConnectCallback = lazy(() => import('./agent/connectCallback'));
export const ON_CONNECT = window.location.pathname === '/connect/openrouter';
// Send to my desk (#9): `/open` reads its link and takes it out of the address bar now, before the session reads the
// location for a sign-in's `return`. The office then shows the sheet (`open/door.tsx`).
takeOpenFromLocation();

export function App() {
  if (ON_CONNECT) {
    return (
      <Suspense fallback={null}>
        <ConnectCallback />
      </Suspense>
    );
  }
  return <Office />;
}

function Office() {
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
