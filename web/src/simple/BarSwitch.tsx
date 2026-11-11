// The Browser bar's part of the simplified view (task 47): the switch and its one line. It loads with the view's chunk
// (`SimpleLayer.tsx` re-exports it), so a desk of today's bar carries none of it in the main bundle.
import { useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { switchTitles } from './decide';
import type { PageLine } from './decide';
import type { SimpleUi } from './ui';

/** The line's two glyphs (the Product Designer's spec, section 7), drawn as the office's icons are. */
const LINE_ICONS: Record<NonNullable<PageLine['icon']>, string> = {
  lock: 'M7 10.5h10a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 17 20H7a1.5 1.5 0 0 1-1.5-1.5V12A1.5 1.5 0 0 1 7 10.5ZM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.75v.5',
};

/**
 * The simplified view's switch (task 47; the Product Designer's spec, section 7): two words, right of the address,
 * per site and remembered on the desk. The one line beside it shows only when the page chose for the member.
 */
export function BarSwitch({ ui }: { ui: SimpleUi }) {
  const s = useSyncExternalStore(ui.subscribe, ui.get);
  const group = useRef<HTMLDivElement>(null);
  if (!s.available) return null;
  const on = s.decision.view === 'simple';
  const can = s.decision.canSwitch;
  const titles = switchTitles(s.host, s.decision);
  const line = s.line;
  // A radiogroup (the spec's section 12): one stop, the arrows choose, and focus follows the choice.
  const choose = (view: 'simple' | 'full'): void => {
    if (!can || (view === 'simple') === on) return;
    ui.choose(view);
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') choose('simple');
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') choose('full');
    else return;
    e.preventDefault();
  };
  return (
    <>
      {/* Where a link in the view goes, while it's pointed at or focused (the Designer's section 13), when no line shows. */}
      {!line && s.linkHost && (
        <span className="br-note br-linkhost" aria-hidden="true" data-testid="browser-simple-link-host">
          {s.linkHost}
        </span>
      )}
      {/* Present from the start, so a line written into it is announced once (WCAG 4.1.3); its leaving isn't. */}
      <span
        className={`br-note br-line${line ? '' : ' empty'}`}
        role="status"
        aria-live="polite"
        data-testid="browser-simple-line-box"
        title={line?.text}
        onPointerEnter={() => ui.holdLine(true)}
        onPointerLeave={() => ui.holdLine(false)}
        onFocus={() => ui.holdLine(true)}
        onBlur={() => ui.holdLine(false)}
      >
        {line && (
          <span className="br-line-in" data-testid="browser-simple-line">
            {line.icon && (
              <svg className="icon" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={LINE_ICONS[line.icon]} />
              </svg>
            )}
            {/* The dot before the action is the sentence's, so it goes with it: hidden with the words on a phone, and cut
                first by the ellipsis on a short screen. On its own it was a lone "· Undo". */}
            <span className="br-line-text">
              {line.text}
              {line.action && <span className="br-line-sep" aria-hidden="true">{' · '}</span>}
            </span>
            {line.action && (
              <button type="button" className="br-line-action" data-testid="browser-simple-line-action" onClick={() => ui.lineAction()}>
                {line.action === 'undo' ? 'Undo' : line.action === 'retry' ? 'Try again' : 'Use the real page'}
              </button>
            )}
          </span>
        )}
      </span>
      <div ref={group} className="br-mode" role="radiogroup" aria-label="View" data-testid="browser-simple" onKeyDown={onKeyDown}>
        <button
          type="button"
          role="radio"
          className={on ? 'on' : undefined}
          aria-checked={on}
          aria-disabled={!on && !can ? true : undefined}
          tabIndex={on ? 0 : -1}
          title={titles.simple}
          data-testid="browser-simple-on"
          onClick={() => choose('simple')}
        >
          Simplified
        </button>
        <button
          type="button"
          role="radio"
          className={on ? undefined : 'on'}
          aria-checked={!on}
          aria-disabled={on && !can ? true : undefined}
          tabIndex={on ? -1 : 0}
          title={titles.full}
          data-testid="browser-simple-off"
          onClick={() => choose('full')}
        >
          Real page
        </button>
      </div>
    </>
  );
}
