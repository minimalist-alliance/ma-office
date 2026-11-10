// The optional passphrase on the download (`passphrase.ts`). It lives only in this page's memory: never stored, never sent.
import { useId } from 'react';
import { MIN_PASSPHRASE, passphraseProblem } from './passphrase';

export interface Pass {
  value: string;
  again: string;
}

/** Whether what's typed can protect a download: long enough and typed twice the same. */
export const passOk = (p: Pass): boolean => passphraseProblem(p.value, p.again) === null;

export function PassphraseFields({ pass, onChange, intro }: { pass: Pass; onChange: (p: Pass) => void; intro: string }) {
  const id = useId();
  const problem = pass.again ? passphraseProblem(pass.value, pass.again) : pass.value && [...pass.value].length < MIN_PASSPHRASE ? passphraseProblem(pass.value, pass.value) : null;
  return (
    <div className="xp-pass" data-testid="pass-fields">
      <p className="xp-text">{intro}</p>
      <div className="xp-pickers">
        <label className="xp-field" htmlFor={`${id}-a`}>
          <span className="xp-label">Passphrase</span>
          <input id={`${id}-a`} className="xp-input" type="password" autoComplete="new-password" spellCheck={false} value={pass.value} onChange={(e) => onChange({ ...pass, value: e.target.value })} data-testid="pass-1" />
        </label>
        <label className="xp-field" htmlFor={`${id}-b`}>
          <span className="xp-label">Again</span>
          <input id={`${id}-b`} className="xp-input" type="password" autoComplete="new-password" spellCheck={false} value={pass.again} onChange={(e) => onChange({ ...pass, again: e.target.value })} data-testid="pass-2" />
        </label>
      </div>
      <p className={`xp-fine${problem ? ' xp-warn' : ''}`} role={problem ? 'status' : undefined} data-testid="pass-note">
        {problem ?? `At least ${MIN_PASSPHRASE} characters. It stays in your browser, so we can't recover it if you forget it.`}
      </p>
    </div>
  );
}
