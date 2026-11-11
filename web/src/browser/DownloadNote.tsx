// The Browser window's quiet line about downloads (LS-31, ADR 0092): "Downloading report.pdf 42%", then "Saved report.pdf on
// your desk" for a few seconds. Kiosk Chromium shows nothing of a download, so this is the member's only sign of one. It sits
// at the picture's bottom left, takes no keys and no pointer but its one button, and renders only when its words change,
// never per progress tick beyond the desk's own pace (at most two a second). Start and end are said through the shell's
// polite region; the line itself isn't live, so nothing is said twice. "Show in Files" opens the desk's Files window, the
// same as its tile, and only for a file the desk says landed in Files, which no image does yet (ADR 0092).
import { useEffect, useState } from 'react';
import type { DeskLink } from '../desk/deskLink';
import { openItem } from '../shell/actions';
import { announce } from '../shell/announce';
import { useLayoutStore } from '../state/layoutStore';
import { linksOn } from '../open/intent';
import { useSession } from '../platform/session';
import { DownloadWatch, type DownloadLine } from './downloads';
import { openOnDevice } from './openOnDevice';
import './downloads.css';

function sameLine(a: DownloadLine | null, b: DownloadLine | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.kind === b.kind && a.text === b.text && a.percent === b.percent && a.filesPath === b.filesPath && a.deviceUrl === b.deviceUrl;
}

export function DownloadNote({ deskId, link, hidden }: { deskId: string; link: DeskLink | null; hidden: boolean }) {
  const [watch] = useState(() => new DownloadWatch());
  // "Get it on this device" (#9) is behind Links in and out's kill switch.
  const linksAllowed = useSession((s) => linksOn(s.config));
  const [line, setLine] = useState<DownloadLine | null>(null);
  const filesItem = useLayoutStore((s) => s.desks[deskId]?.items.find((i) => i.app === 'files')?.id ?? null);

  useEffect(() => {
    if (!link) return undefined;
    let timer = 0;
    const show = (): void => {
      window.clearTimeout(timer);
      const now = Date.now();
      const next = watch.line(now);
      setLine((last) => (sameLine(last, next) ? last : next));
      const at = watch.nextChangeAt(now);
      if (at !== null) timer = window.setTimeout(show, at - now + 1);
    };
    // A deskd before downloads refuses the SUB with not_found: then there's simply never a line.
    const off = link.subscribe('browser.downloads', (m) => {
      const say = watch.take(m.downloads, Date.now());
      if (say) announce(say);
      show();
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [link, watch]);

  if (!line || hidden) return null;
  return (
    <div className={`br-dl ${line.kind}`} data-testid="browser-download" data-kind={line.kind}>
      <svg className="br-dl-icon" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
      </svg>
      <span className="br-dl-text">{line.text}</span>
      {line.percent !== null && <span className="br-dl-pct">{line.percent}%</span>}
      {line.kind === 'saved' && line.filesPath && filesItem && (
        <button type="button" className="br-dl-show" onClick={() => openItem(deskId, filesItem)}>
          Show in Files
        </button>
      )}
      {line.kind === 'saved' && line.deviceUrl && linksAllowed && (
        // The download's own address, opened in this device's browser, which downloads it again (new, for Sales).
        <button type="button" className="br-dl-show" data-testid="browser-download-here" onClick={() => openOnDevice(line.deviceUrl)}>
          Get it on this device
        </button>
      )}
    </div>
  );
}
