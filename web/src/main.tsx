// Entry. `./theme/boot` must stay first: it sets data-theme before anything paints.
import './theme/boot';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jost/600.css';
// Both are SIL OFL 1.1. Their licences ship beside the font files, as assets/inter-OFL.txt and assets/jost-OFL.txt
// (from public/assets/, copied from each package's LICENSE). A new font, or a new version, brings its own.
import 'virtual:ma-themes.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { prefetchBrowser } from './apps/registry';
import { prefetchRtcLink } from './desk/deskLink';
import { startExportSweep } from './platform/exportSweep';
import { bootSession } from './platform/session';
import './theme/themeStore';

const el = document.getElementById('ma-root');
if (!el) throw new Error('#ma-root is missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void bootSession();
startExportSweep();
// Once the page is idle, fetch the code a desk needs next (its link, the Browser window), so opening one doesn't wait for it.
const prefetch = (): void => {
  prefetchRtcLink();
  prefetchBrowser();
};
if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 3000 });
else setTimeout(prefetch, 1500);
