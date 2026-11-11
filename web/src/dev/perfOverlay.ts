// `?perf=1` on the dev server: a tiny frames-per-second and long-task readout in a corner (TD-73). Dev only: main.tsx
// reaches it behind `import.meta.env.DEV`, so a production build drops the import and this file with it, and
// `scripts/perf-pr.mjs` fails if the release bundle holds its marker. It reads nothing from the desk.
export const PERF_OVERLAY_MARKER = 'ma-dev-perf-overlay';

export function startPerfOverlay(): void {
  if (document.getElementById(PERF_OVERLAY_MARKER)) return;
  const box = document.createElement('div');
  box.id = PERF_OVERLAY_MARKER;
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, {
    position: 'fixed', right: '8px', bottom: '8px', zIndex: '2147483647', padding: '2px 6px', borderRadius: '4px',
    font: '11px/1.4 ui-monospace, monospace', pointerEvents: 'none', whiteSpace: 'pre',
    background: 'var(--ma-surface-chrome)', color: 'var(--ma-text-primary)', border: '1px solid var(--ma-border)',
  });
  document.body.appendChild(box);

  let frames = 0;
  let last = performance.now();
  let longTasks = 0;
  let longMs = 0;
  let worst = 0;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks += 1;
        longMs += e.duration;
        worst = Math.max(worst, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  }
  const tick = (t: number): void => {
    frames += 1;
    if (t - last >= 1000) {
      box.textContent = `${Math.round((frames * 1000) / (t - last))} fps\nlong tasks ${longTasks} (${Math.round(longMs)} ms, worst ${Math.round(worst)})`;
      frames = 0;
      last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
