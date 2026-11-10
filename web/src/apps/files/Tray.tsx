// The transfers, one line each: its words, a progress bar with the speed and the time left, and what the member can do with it.
// Each progress bar is a real `progressbar` with its words in `aria-valuetext`; starts and ends are announced by the engine
// into the polite live region, so a screen reader hears "3 uploaded" once, not every percent. Reduced motion: no easing.
import { useState } from 'react';
import { formatBytes } from '../../export/format';
import type { TransferEngine, JobView } from './engine';
import { BROWSER_ON_SCREEN } from './words';

function Line({ v, engine }: { v: JobView; engine: TransferEngine }) {
  const pct = v.size > 0 ? Math.min(100, Math.floor((v.done / v.size) * 100)) : v.state === 'done' ? 100 : 0;
  const live = v.state === 'sending' || v.state === 'finishing';
  const showBar = live || v.state === 'paused' || (v.state === 'queued' && v.done > 0);
  const detail = [live && v.size > 0 ? `${formatBytes(v.done)} of ${formatBytes(v.size)}` : null, v.speed, v.left].filter(Boolean).join(' · ');
  return (
    <li className={`files-xfer ${v.state}`} data-testid="files-xfer" data-state={v.state} data-name={v.name}>
      <div className="files-xfer-top">
        <span className="files-xfer-kind" aria-hidden="true">
          {v.kind === 'upload' ? '↑' : '↓'}
        </span>
        <span className="files-name" title={v.name}>
          {v.name}
        </span>
        <span className="files-xfer-actions">
          {v.state === 'failed' && v.retry && (
            <button type="button" className="link-btn" onClick={() => engine.retry(v.id)}>
              Try again
            </button>
          )}
          {(v.state === 'done' || v.state === 'failed' || v.state === 'rejected' || v.state === 'cancelled') && (
            <button type="button" className="link-btn" onClick={() => engine.dismiss(v.id)} aria-label={`Dismiss ${v.name}`}>
              Dismiss
            </button>
          )}
          {(v.state === 'queued' || v.state === 'checking' || v.state === 'sending' || v.state === 'finishing' || v.state === 'paused') && (
            <button type="button" className="link-btn" onClick={() => engine.cancel(v.id)} aria-label={`Cancel ${v.kind} of ${v.name}`}>
              Cancel
            </button>
          )}
        </span>
      </div>
      {showBar && (
        <div className="files-bar" role="progressbar" aria-label={`${v.kind === 'upload' ? 'Upload' : 'Download'} of ${v.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%, ${v.words}${detail ? `, ${detail}` : ''}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className={`files-xfer-words${v.state === 'failed' ? ' bad' : ''}`}>
        {v.words}
        {detail && showBar && <span className="files-quiet"> {detail}</span>}
      </p>
    </li>
  );
}

export function Tray({ views, engine, browserOnScreen }: { views: readonly JobView[]; engine: TransferEngine; browserOnScreen: boolean }) {
  const [open, setOpen] = useState(true);
  if (!views.length) return null;
  const live = views.filter((v) => v.state !== 'done' && v.state !== 'cancelled' && v.state !== 'failed' && v.state !== 'rejected').length;
  const done = views.filter((v) => v.state === 'done' || v.state === 'cancelled').length;
  const slow = browserOnScreen && views.some((v) => v.kind === 'download' && (v.state === 'sending' || v.state === 'queued'));
  const title = live ? `${live} transfer${live === 1 ? '' : 's'} going` : 'Transfers';
  return (
    <section className="files-tray" aria-label="Transfers" data-testid="files-tray">
      <div className="files-tray-head">
        <button type="button" className="files-tray-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>{title}</span>
          <span className="files-quiet">{open ? 'Hide' : 'Show'}</span>
        </button>
        {done > 0 && (
          <button type="button" className="link-btn" onClick={() => engine.clearFinished()}>
            Clear finished
          </button>
        )}
      </div>
      {open && (
        <>
          {slow && <p className="files-note">{BROWSER_ON_SCREEN}</p>}
          <ul className="files-xfers">
            {views.map((v) => (
              <Line key={v.id} v={v} engine={engine} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
