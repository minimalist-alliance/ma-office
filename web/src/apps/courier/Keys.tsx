// Members' keys in the office (the Designer's flows 4, 5 and 6; API.md §21, "The desk's address and members' messages"): the
// safety number, shown as text so a screen reader reads it, and its check; a contact's changed key, which holds private
// messages both ways until the member answers. The spike's Q-C4 rule: block, and offer no default, so the two answers are
// equal buttons and nothing is pinned until the member presses one. The desk does every check; this only asks it.
import { useId, useState } from 'react';
import { toCourierError, type CourierClient } from './client';
import { dayWords, sameNumber } from './model';
import { Icon, type Foot } from './parts';
import type { MemberKey } from './types';
import { W } from './words';

/** The 60 digits in 12 groups of 5, in 3 rows of 4. Each group is its own span, labelled "Group {n} of 12". */
export function SafetyDigits({ number, testId }: { number: string; testId?: string }) {
  const groups = number.split(' ');
  return (
    <p className="courier-sn" data-testid={testId}>
      {groups.map((g, i) => (
        <span key={i} aria-label={`${W.fpGroup(i + 1, groups.length)}: ${g.split('').join(' ')}`}>
          {g}
        </span>
      ))}
    </p>
  );
}

/**
 * A contact's changed key (07, p07): the new safety number and two equal answers, then a quiet Copy. "Numbers match" pins the
 * new key on the desk, and what it held comes in; "They don't match" keeps everything held.
 */
export function KeyChanged({ client, address, number, first, copy, onChanged }: { client: CourierClient; address: string; number: string; first: string; copy(text: string): void; onChanged(foot: Foot): void }) {
  // "They don't match" holds for as long as the card is shown: opened again, it asks again, so a mistaken press isn't for good
  // (Security's CK-I1). Nothing is sent either way until Numbers match.
  const [no, setNo] = useState(false);
  const [busy, setBusy] = useState(false);
  const head = useId();
  return (
    <section className="courier-keycard" aria-labelledby={head} data-testid="courier-key-changed">
      <Icon name="key" />
      <div className="courier-keycard-main">
        <h3 id={head}>{W.keyTitle(first)}</h3>
        {no ? (
          <p role="status">{W.keyStillHeld(first)}</p>
        ) : (
          <>
            <p>{W.keyBody(first)}</p>
            <SafetyDigits number={number} testId="courier-key-number" />
            <div className="courier-keycard-btns">
              <button
                type="button"
                className="courier-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void client.verifyKey(address, number).then(
                    () => onChanged({ text: W.keyMatched(first) }),
                    (e) => {
                      setBusy(false);
                      onChanged({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed });
                    },
                  );
                }}
              >
                {W.keyMatch}
              </button>
              <button
                type="button"
                className="courier-btn"
                disabled={busy}
                onClick={() => setNo(true)}
              >
                {W.keyNoMatch}
              </button>
              <button type="button" className="courier-btn quiet" onClick={() => copy(number)} aria-label={`${W.copy}: ${W.snTitle}`}>
                <Icon name="copy" />
                <span>{W.copy}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The safety number in the person view (06, p06), for a person with a member address: what it's for, the number, whether it's
 * checked, Copy, "Compare safety numbers" (paste what they sent; a match marks it checked) and Mark as checked (quiet, for a
 * comparison done aloud), which goes once it's checked.
 */
export function SafetyNumber({ client, k, first, now, copy, onChanged }: { client: CourierClient; k: MemberKey; first: string; now: number; copy(text: string): void; onChanged(foot: Foot): void }) {
  const [comparing, setComparing] = useState(false);
  const [typed, setTyped] = useState('');
  const [matched, setMatched] = useState<number | null>(null);
  const ids = { head: useId(), field: useId(), line: useId() };
  if (k.state === 'changed' && k.newSafetyNumber) {
    return <KeyChanged client={client} address={k.address} number={k.newSafetyNumber} first={first} copy={copy} onChanged={onChanged} />;
  }
  const number = k.safetyNumber;
  if (!number) return null;
  const checked = k.state === 'verified' || matched !== null;
  const mark = (then: () => void): void =>
    void client.verifyKey(k.address, number).then(then, (e) => onChanged({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed }));
  const digits = typed.replace(/\s+/g, '');
  const verdict = comparing && digits.length >= 60 ? (sameNumber(typed, number) ? 'match' : 'no') : null;
  return (
    <section className="courier-safety" aria-labelledby={ids.head} data-testid="courier-safety">
      <h3 id={ids.head}>{W.snTitle}</h3>
      <p className="courier-quiet">{W.snLine(first)}</p>
      <SafetyDigits number={number} testId="courier-sn" />
      {matched === null && <p className="courier-quiet">{k.state !== 'verified' ? W.snNotYet : k.source !== 'invite' && k.verifiedAt ? W.snChecked(dayWords(k.verifiedAt, now)) : W.snByInvite}</p>}
      <div className="courier-keycard-btns">
        <button type="button" className="courier-btn" onClick={() => copy(number)} aria-label={`${W.copy}: ${W.snTitle}`}>
          <Icon name="copy" />
          <span>{W.copy}</span>
        </button>
        {!checked && (
          <button type="button" className="courier-btn" aria-expanded={comparing} aria-controls={ids.field} onClick={() => setComparing((c) => !c)}>
            {W.snCompare}
          </button>
        )}
        {!checked && (
          <button type="button" className="courier-btn quiet" onClick={() => mark(() => onChanged({ text: W.snChecked(dayWords(Date.now(), now)) }))}>
            {W.snMark}
          </button>
        )}
      </div>
      {comparing && (
        <>
          <textarea
            id={ids.field}
            className="courier-sn-paste"
            rows={2}
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
            placeholder={W.snPaste}
            aria-label={W.snPaste}
            aria-describedby={ids.line}
            value={typed}
            readOnly={matched !== null}
            onChange={(e) => {
              const v = e.target.value.slice(0, 200);
              setTyped(v);
              // A match marks it checked on the desk at once; the desk checks the number again itself.
              if (matched === null && sameNumber(v, number)) mark(() => setMatched(Date.now()));
            }}
          />
          <p id={ids.line} role="status" className="courier-sn-verdict">
            {matched !== null ? (
              <>
                <Icon name="check" />
                <span>{W.snMatch(dayWords(matched, now))}</span>
              </>
            ) : verdict === 'no' ? (
              <span>{W.snNoMatch(first)}</span>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The state under a member's name (flow 4), after "Private between desks": from the first member address that says. `check`
 * makes it a way into the person view's safety number.
 */
export function memberLine(keys: readonly MemberKey[], now: number): { state: string; changed: boolean; check: boolean } | null {
  if (keys.some((k) => k.state === 'changed')) return { state: W.keySub, changed: true, check: false };
  const k = keys.find((x) => x.state === 'verified') ?? keys.find((x) => x.state === 'unverified');
  if (!k) return null;
  if (k.state === 'unverified') return { state: W.subCheck, changed: false, check: true };
  return { state: k.source !== 'invite' && k.verifiedAt ? W.subChecked(dayWords(k.verifiedAt, now)) : W.subByInvite, changed: false, check: false };
}
