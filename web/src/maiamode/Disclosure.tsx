// The disclosure, accepted once to turn Maia Mode on (CONCEPT.md §9's draft, for the Sales Engineer to finalise; on the sheet,
// `stills/X-desk-light-discl.png`). A modal dialog over the office: the office is `inert` behind it, focus starts on its title,
// Tab stays inside, Esc and "Not now" change nothing and put the focus back. "Turn on Maia Mode" asks for the box first.
import { useEffect, useRef, useState } from 'react';
import maiaDark from '../assets/maia/maia-dark-md.svg';
import maiaDusk from '../assets/maia/maia-dusk-md.svg';
import maiaLight from '../assets/maia/maia-light-md.svg';
import { accept, decline } from './ui';
import { DISCLOSURE } from './words';

export function Disclosure() {
  const [read, setRead] = useState(false);
  const [nudge, setNudge] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);

  return (
    <div className="mm-discl-wrap">
      <div className="mm-scrim" aria-hidden="true" onClick={decline} />
      <div
        ref={box}
        className="mm-discl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-discl-t"
        aria-describedby="mm-discl-lead"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            decline();
            return;
          }
          if (e.key !== 'Tab') return;
          // Tab and Shift+Tab stay inside.
          const all = [...(box.current?.querySelectorAll<HTMLElement>('button, input, [tabindex="-1"]#mm-discl-t') ?? [])];
          const first = all[0];
          const last = all[all.length - 1];
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        }}
      >
        <div className="mm-discl-hd">
          <img className="mm-discl-maia mm-th on-light" src={maiaLight} alt="" />
          <img className="mm-discl-maia mm-th on-zen" src={maiaDusk} alt="" />
          <img className="mm-discl-maia mm-th on-dark" src={maiaDark} alt="" />
          <div>
            <h2 id="mm-discl-t" ref={title} tabIndex={-1}>
              {DISCLOSURE.title}
            </h2>
            <p id="mm-discl-lead" className="mm-discl-lead">{DISCLOSURE.lead}</p>
          </div>
        </div>
        <div className="mm-discl-body">
          {DISCLOSURE.sections.map(([h, p]) => (
            <section key={h}>
              <h3>{h}</h3>
              <p>{p}</p>
            </section>
          ))}
        </div>
        <label className="mm-discl-agree">
          <input
            type="checkbox"
            checked={read}
            onChange={(e) => {
              setRead(e.target.checked);
              setNudge(false);
            }}
          />
          <span>{DISCLOSURE.agree}</span>
        </label>
        {nudge && (
          <p className="mm-discl-nudge" role="status">
            Tick “{DISCLOSURE.agree}” first.
          </p>
        )}
        <div className="mm-discl-acts">
          <button type="button" className="mm-btn" onClick={decline}>
            {DISCLOSURE.notNow}
          </button>
          <button
            type="button"
            className="mm-btn primary"
            aria-disabled={!read}
            onClick={() => {
              if (read) accept();
              else setNudge(true);
            }}
          >
            {DISCLOSURE.turnOn}
          </button>
        </div>
      </div>
    </div>
  );
}
