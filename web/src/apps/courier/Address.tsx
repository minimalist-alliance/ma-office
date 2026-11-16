// This desk's address: choosing it (the Designer's flow 1, stills 01, 02 and p01) and sharing it (flow 2, stills 03 and p02).
// The registry is Platform's (`address.ts`); the fingerprint is this desk's own (`courier.keys`). Nothing here is a secret:
// the address is an email address, and the fingerprint is a public key's digest. The link's fragment never reaches a server.
import { useEffect, useId, useRef, useState } from 'react';
import { askName, checkShape, inviteLink, linkFingerprint, linkShown, sharedStem, shownFingerprint, siteOrigin, takeName, type CourierDesk, type DeskAddress, type Verdict } from './address';
import type { CourierClient } from './client';
import type { Invite } from './invite';
import { KeyChanged } from './Keys';
import { Icon, type Foot } from './parts';
import { W } from './words';

type Line = { kind: 'ok' | 'no'; text: string } | null;

function verdictLine(v: Verdict | 'checking' | null): Line {
  switch (v) {
    case 'free':
      return { kind: 'ok', text: W.addrFree };
    case 'taken':
      return { kind: 'no', text: W.addrTaken };
    case 'reserved':
      return { kind: 'no', text: W.addrReserved };
    case 'chars':
      return { kind: 'no', text: W.addrChars };
    case 'length':
      return { kind: 'no', text: W.addrLength };
    case 'failed':
      return { kind: 'no', text: W.failed };
    default:
      return null;
  }
}

/**
 * The one centred card, the first time Courier opens on a desk with no address (the window's ground behind it, no lanes).
 * "Later" closes it, and Courier works with linked mailboxes and iMessage; Accounts then offers "Choose an address".
 */
export function ChooseAddress({ desk, domain, others, narrow, onDone, onLater, rootRef }: { desk: CourierDesk; domain: string; others: CourierDesk[]; narrow: boolean; onDone(a: DeskAddress): void; onLater(): void; rootRef: React.RefObject<HTMLDivElement | null> }) {
  const [name, setName] = useState('');
  const [verdict, setVerdict] = useState<Verdict | 'checking' | null>(null);
  const [how, setHow] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const ids = { title: useId(), field: useId(), line: useId(), help: useId(), how: useId(), stem: useId() };
  useEffect(() => field.current?.focus(), []);

  // 300 ms after the last key: the shape here first, then the registry's word.
  useEffect(() => {
    const n = name.trim();
    if (!n) {
      setVerdict(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      const shape = checkShape(n);
      if (shape !== 'ok') return setVerdict(shape);
      setVerdict('checking');
      void askName(n, ctl.signal).then((v) => !ctl.signal.aborted && setVerdict(v));
    }, 300);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [name]);

  const stemDesk = name.trim() && verdict !== 'taken' && verdict !== 'reserved' ? sharedStem(name.trim(), others) : null;
  const refusedStem = verdict === 'shares_stem';
  const line = verdictLine(verdict);
  const ready = verdict === 'free' && !busy;

  const use = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    const r = await takeName(desk.deskId, name.trim());
    setBusy(false);
    if ('address' in r) onDone(r.address);
    else {
      setVerdict(r.verdict);
      field.current?.focus();
    }
  };

  return (
    <div className="courier-root courier-center courier-ground" data-testid="courier-body" data-state="address" data-cols={narrow ? 1 : 3} ref={rootRef}>
      <form
        className="courier-addr-card"
        aria-labelledby={ids.title}
        data-testid="courier-address-card"
        onSubmit={(e) => {
          e.preventDefault();
          void use();
        }}
      >
        <span className="courier-tag">{W.addrDeskTag(desk.name || 'This')}</span>
        <h2 id={ids.title}>{W.addrTitle}</h2>
        <p className="courier-addr-lead">{W.addrLead}</p>
        <label htmlFor={ids.field} className="courier-sr">
          {W.addrName}
        </label>
        <div className="courier-addr-field" data-narrow={narrow || undefined}>
          <input
            ref={field}
            id={ids.field}
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value.replace(/\s/g, ''))}
            aria-invalid={line?.kind === 'no' || refusedStem || undefined}
            aria-describedby={`${ids.line} ${ids.help}${stemDesk || refusedStem ? ` ${ids.stem}` : ''}`}
          />
          <span className="courier-addr-domain" aria-hidden="true">
            @{domain}
          </span>
        </div>
        <p id={ids.line} className={`courier-addr-line${line?.kind === 'ok' ? ' ok' : ''}`} role="status">
          {verdict === 'checking' ? W.addrChecking : line ? (
            <>
              <Icon name={line.kind === 'ok' ? 'check' : 'info'} />
              <span>{line.text}</span>
            </>
          ) : null}
        </p>
        {(stemDesk || refusedStem) && (
          <div className="courier-note" role="note" id={ids.stem} data-testid="courier-stem">
            <Icon name="info" />
            <div>
              <strong>{W.addrStemHead(stemDesk ?? others.find((o) => o.address)?.name ?? '')}</strong>
              <span>{refusedStem ? W.addrStemRefused : W.addrStemBody}</span>
            </div>
          </div>
        )}
        <p id={ids.help} className="courier-addr-help">
          {W.addrHelp}
        </p>
        <button type="button" className="courier-btn quiet courier-disclose" aria-expanded={how} aria-controls={ids.how} onClick={() => setHow(!how)}>
          <Icon name="back" className={`courier-chev${how ? " open" : ""}`} />
          <span>{W.addrHow}</span>
        </button>
        {how && (
          <p id={ids.how} className="courier-addr-how">
            {W.addrHowBody}
          </p>
        )}
        <div className="courier-addr-btns">
          <button type="button" className="courier-btn quiet" onClick={onLater}>
            {W.addrLater}
          </button>
          <button type="submit" className="courier-btn primary" disabled={!ready} aria-disabled={!ready || undefined}>
            {W.addrUse}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Copies to the clipboard and says so at the pane's foot. */
export function copyText(text: string, ok: string, say: (f: Foot) => void): void {
  const refused = (): void => say({ text: W.copyRefused });
  try {
    void navigator.clipboard.writeText(text).then(() => say({ text: ok }), refused);
  } catch {
    refused();
  }
}

/**
 * Share: the address, the invite link and the fingerprint, each with its line (flow 2). The fingerprint is text, never a
 * button: a screen reader reads each group as its own. On a phone, Share link (the system's sheet) comes first.
 */
export function ShareAddress({ address, fingerprint, displayName, narrow, after, onBack, onDone, say, foot }: { address: DeskAddress; fingerprint: string | null; displayName: string | null; narrow: boolean; after: boolean; onBack(): void; onDone(): void; say(f: Foot): void; foot: React.ReactNode }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  const link = inviteLink(siteOrigin(), address.name, fingerprint, displayName);
  // The code shown is read back out of the link itself whenever there is one, so it can never be other than what the link
  // carries and the receiving desk checks (the Designer's call; a mismatch would be a security bug).
  const groups = shownFingerprint(linkFingerprint(link) ?? fingerprint);
  const canShare = narrow && typeof navigator.share === 'function';
  const shareLink = (): void => {
    if (!link) return;
    void navigator.share({ url: link }).catch(() => undefined);
  };
  return (
    <div className="courier-setup courier-share" data-testid="courier-share">
      <div className="courier-setup-head">
        <button type="button" className="courier-icon-btn" onClick={onBack} aria-label={W.back} title={W.back}>
          <Icon name="back" />
        </button>
        <h2 ref={head} tabIndex={-1}>
          {W.shareTitle}
        </h2>
      </div>
      <div className="courier-setup-scroll">
        <section className="courier-share-row" aria-labelledby="courier-share-addr">
          <h3 id="courier-share-addr">{W.shareAddr}</h3>
          <div className="courier-share-box">
            <span className="courier-share-value" data-testid="courier-share-address">
              {address.address}
            </span>
            <button type="button" className="courier-btn" onClick={() => copyText(address.address, W.addrCopied, say)} aria-label={`${W.copy}: ${W.shareAddr}`}>
              <Icon name="copy" />
              <span>{W.copy}</span>
            </button>
          </div>
          <p className="courier-quiet">{W.shareAddrLine}</p>
        </section>
        {link && (
          <section className="courier-share-row" aria-labelledby="courier-share-link">
            <h3 id="courier-share-link">{W.shareLink}</h3>
            <div className="courier-share-box" data-narrow={narrow || undefined}>
              <span className="courier-share-value courier-share-url" data-testid="courier-share-link">
                {linkShown(link)}
              </span>
              <div className="courier-share-btns">
                {canShare && (
                  <button type="button" className="courier-btn primary" onClick={shareLink}>
                    <Icon name="open" />
                    <span>{W.shareLinkBtn}</span>
                  </button>
                )}
                <button type="button" className={`courier-btn${canShare ? '' : ' primary'}`} onClick={() => copyText(link, W.linkCopied, say)}>
                  <Icon name="copy" />
                  <span>{W.copyLink}</span>
                </button>
              </div>
            </div>
            <p className="courier-quiet">{W.shareLinkLine}</p>
          </section>
        )}
        {groups && (
          <section className="courier-share-row" aria-labelledby="courier-share-fp">
            <h3 id="courier-share-fp">{W.shareFp}</h3>
            <p className="courier-fp" data-testid="courier-fingerprint">
              {groups.map((g, i) => (
                <span key={i} aria-label={`${W.fpGroup(i + 1, groups.length)}: ${g.split('').join(' ')}`}>
                  {g}
                </span>
              ))}
            </p>
            <p className="courier-quiet">{W.shareFpLine}</p>
          </section>
        )}
        {after && (
          <div className="courier-share-done">
            <button type="button" className="courier-btn primary" onClick={onDone}>
              {W.done}
            </button>
          </div>
        )}
      </div>
      {foot}
    </div>
  );
}

/**
 * An invite link's Add, arrived in the office (flow 3): asked here again before anything is added, since a link can reach the
 * office without the account page's press (Security's CU-L1). With the link's fingerprint the desk checks the key as it adds
 * them; a link without one says what letting them in trusts (flow 7's words, CU-L2).
 */
/**
 * What the desk answered an Add it couldn't make (CT-I7): the link's fingerprint doesn't match the desk's keys (`pinned`: this
 * desk already has a key for the address, so its safety number can settle it); a key the member checked changed, with the new
 * safety number to compare; or the address is closed.
 */
export type InviteProblem = { kind: 'mismatch'; pinned: boolean } | { kind: 'changed'; number: string } | { kind: 'closed' };

export function InviteCard({ invite, domain, deskName, problem, client, onAdd, onNotNow, onCompare, onChecked, copy, foot }: { invite: Invite; domain: string | null; deskName: string; problem: InviteProblem | null; client: CourierClient; onAdd(displayName: string): void; onNotNow(): void; onCompare(address: string): void; onChecked(foot: Foot): void; copy(text: string): void; foot: React.ReactNode }) {
  const [name, setName] = useState(invite.displayName);
  const [busy, setBusy] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  const ids = { name: useId(), fp: useId() };
  useEffect(() => head.current?.focus(), []);
  const address = domain ? `${invite.name}@${domain}` : invite.name;
  const who = name.trim() || invite.displayName || address;
  const first = (invite.displayName || name).trim().split(/\s+/)[0] || invite.name;
  const groups = shownFingerprint(invite.fingerprint);
  if (problem) {
    return (
      <div className="courier-setup courier-share" data-testid="courier-invite" data-problem={problem.kind}>
        <div className="courier-setup-head">
          <button type="button" className="courier-icon-btn" onClick={onNotNow} aria-label={W.back} title={W.back}>
            <Icon name="back" />
          </button>
          <h2 ref={head} tabIndex={-1}>
            {W.inviteTitle(who)}
          </h2>
        </div>
        <div className="courier-setup-scroll">
          <p className="courier-share-value">{address}</p>
          {problem.kind === 'changed' && domain ? (
            <KeyChanged client={client} address={address} number={problem.number} first={first} copy={copy} onChanged={onChecked} />
          ) : (
            <div className="courier-note" role="note" data-testid="courier-invite-problem">
              <Icon name="info" />
              <span>{problem.kind === 'closed' ? W.inviteClosed : W.inviteMismatch(first)}</span>
            </div>
          )}
          <div className="courier-addr-btns">
            <button type="button" className="courier-btn" onClick={onNotNow}>
              {W.inviteNotNow}
            </button>
            {problem.kind === 'mismatch' && problem.pinned && domain && (
              <button type="button" className="courier-btn" onClick={() => onCompare(address)}>
                {W.snCompare}
              </button>
            )}
          </div>
        </div>
        {foot}
      </div>
    );
  }
  return (
    <div className="courier-setup courier-share" data-testid="courier-invite">
      <div className="courier-setup-head">
        <button type="button" className="courier-icon-btn" onClick={onNotNow} aria-label={W.back} title={W.back}>
          <Icon name="back" />
        </button>
        <h2 ref={head} tabIndex={-1}>
          {W.inviteTitle(who)}
        </h2>
      </div>
      <form
        className="courier-setup-scroll"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          onAdd(name.trim());
        }}
      >
        <p className="courier-share-value">{address}</p>
        {groups ? (
          <section className="courier-share-row" aria-labelledby={ids.fp}>
            <h3 id={ids.fp}>{W.shareFp}</h3>
            <p className="courier-fp" data-testid="courier-invite-fp">
              {groups.map((g, i) => (
                <span key={i} aria-label={`${W.fpGroup(i + 1, groups.length)}: ${g.split('').join(' ')}`}>
                  {g}
                </span>
              ))}
            </p>
            <p className="courier-quiet">{W.inviteFpLine(first)}</p>
          </section>
        ) : (
          <div className="courier-note" role="note" data-testid="courier-invite-nofp">
            <Icon name="info" />
            <span>{W.inviteNoFp(first)}</span>
          </div>
        )}
        <label className="courier-way-add" htmlFor={ids.name}>
          <span>{W.inviteName}</span>
          <span className="courier-way-add-row">
            <input id={ids.name} type="text" maxLength={40} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <div className="courier-addr-btns">
          <button type="button" className="courier-btn quiet" onClick={onNotNow}>
            {W.inviteNotNow}
          </button>
          <button type="submit" className="courier-btn primary" disabled={busy}>
            {W.inviteAdd(deskName)}
          </button>
        </div>
      </form>
      {foot}
    </div>
  );
}
