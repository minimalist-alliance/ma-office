// Accounts: this desk's own address first, the linked mailboxes with their state, and "Add an account" with a short guide per
// provider. A sign-in is entered only here, in the member's own session, and goes once to their desk (`courier.accounts.add`,
// write-only, API.md §21): the password field is uncontrolled, read once at the press, and emptied whatever the answer, so it
// lives in no React state, no store, no log and no error. The desk checks it with the provider, seals it, and never sends it
// back: the office only ever shows "Signed in as …".
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { DeskAddress } from './address';
import { toCourierError, type CourierClient } from './client';
import { Icon, type Foot } from './parts';
import type { Account, AccountInput, Block, MacSync } from './types';
import { W } from './words';

type ProviderId = 'gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'other' | 'outlook' | 'imessage';
interface Provider {
  id: ProviderId;
  name: string;
  guide: string;
  /** Comes later: no form, the reason instead. */
  later?: boolean;
}

export const PROVIDERS: Provider[] = [
  { id: 'gmail', name: 'Gmail', guide: 'Gmail asks for an app password. Turn on 2-Step Verification in your Google Account, make an app password under Security, and paste it here.' },
  { id: 'icloud', name: 'iCloud Mail', guide: 'iCloud Mail asks for an app-specific password. Make one in your Apple Account, under Sign-In and Security, and paste it here.' },
  { id: 'outlook', name: 'Outlook and Microsoft 365', guide: 'These sign in with Microsoft, which comes in a later update.', later: true },
  { id: 'fastmail', name: 'Fastmail', guide: 'Fastmail asks for an app password with mail access. Make one under Settings, Privacy and Security, and paste it here.' },
  { id: 'yahoo', name: 'Yahoo Mail', guide: 'Yahoo Mail asks for an app password. Make one under Account security, and paste it here.' },
  { id: 'other', name: 'Other mailbox (IMAP)', guide: "Any mailbox that offers IMAP. Your provider’s help pages list its servers and whether it asks for an app password." },
  { id: 'imessage', name: 'iMessage on your Mac', guide: 'Through MA Connector on your own Mac.' },
];

/** How long ago, in the member's words: "a moment", "5 minutes", "2 hours", "3 days". */
export function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'a moment';
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

/** The Mac account's line under its name, and whether it needs the member (API.md §21 `sync` for `path: connector`). */
export function macLine(sync: MacSync | null | undefined, now: number): { text: string; needsYou: boolean; quiet: string | null; check: string | null } {
  return { ...macState(sync, now), check: sync?.check ? W.mac.check(sync.check) : null };
}

function macState(sync: MacSync | null | undefined, now: number): { text: string; needsYou: boolean; quiet: string | null } {
  if (!sync) return { text: W.mac.waiting, needsYou: false, quiet: null };
  if (sync.state === 'off') return { text: W.mac.off, needsYou: false, quiet: null };
  if (sync.reason === 'unpaired' || sync.reason === 'signed_out') return { text: W.mac.unpaired, needsYou: true, quiet: null };
  if (sync.reason === 'full_disk') return { text: W.mac.fullDisk, needsYou: true, quiet: null };
  if (sync.reason === 'automation') return { text: W.mac.automation, needsYou: true, quiet: null };
  const checked = sync.checkedAt ? W.mac.checked(ago(now - sync.checkedAt)) : null;
  if (sync.reason === 'paused') return { text: W.mac.paused, needsYou: false, quiet: checked };
  if (sync.state === 'live') return { text: W.mac.live, needsYou: false, quiet: checked };
  if (sync.reason === 'mac' && !sync.checkedAt) return { text: W.mac.pressConnect, needsYou: false, quiet: null };
  return { text: W.mac.waiting, needsYou: false, quiet: checked };
}

/** What a refusal of `courier.imsg.pair` says. */
export function pairWords(e: unknown): string {
  const err = toCourierError(e);
  const r = err.reason;
  if (err.code === 'offline') return W.offline;
  if (err.code === 'bad_request' && r === 'code') return W.mac.err.code;
  if (err.code === 'not_found') return W.mac.err.notWaiting;
  if (err.code === 'conflict') return W.mac.err.tooMany;
  if (err.code === 'rate_limited') return W.mac.err.rate;
  if (err.code === 'unavailable' && r === 'paused') return W.mac.err.paused;
  if (err.code === 'unavailable' && r === 'switched_off') return W.mac.off;
  if (err.code === 'unavailable' && r === 'unreachable') return W.mac.err.unreachable;
  return W.failed;
}

/** The code as the member types it: 8 letters from the Mac's code, shown as two groups of 4. */
export function normalCode(v: string): string {
  const c = v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * MA Connector for Mac (the draft ADR "Courier's Mac connector"): the code the Mac shows, typed here, claimed by this desk.
 * The member's own office is where they confirm: the Mac never signs in to their account.
 */
function MacForm({ client, onDone, onBack }: { client: CourierClient; onDone(check: string): void; onBack(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { code: useId(), problem: useId() };
  const ready = code.replace('-', '').length === 8;
  return (
    <form
      className="courier-signin courier-mac"
      data-testid="courier-mac-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setProblem(null);
        client.pairMac(code).then(
          (r) => {
            setBusy(false);
            onDone(r.check);
          },
          (err) => {
            setBusy(false);
            setProblem(pairWords(err));
          },
        );
      }}
    >
      <div className="courier-signin-head">
        <button type="button" className="courier-btn quiet" onClick={onBack}>
          {W.backToProviders}
        </button>
        <h4>{W.mac.title}</h4>
      </div>
      <p>{W.mac.lead}</p>
      <ol className="courier-mac-steps">
        <li>{W.mac.step1}</li>
        <li>{W.mac.step2}</li>
      </ol>
      <label className="courier-field" htmlFor={ids.code}>
        <span>{W.mac.code}</span>
        <input
          id={ids.code}
          className="courier-mac-code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={9}
          placeholder="XXXX-XXXX"
          value={code}
          aria-describedby={problem ? ids.problem : undefined}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setCode(normalCode(e.target.value))}
        />
      </label>
      <p className="courier-quiet">{W.mac.own}</p>
      <div className="courier-sealed">
        <Icon name="shield" />
        <p>{W.mac.sms}</p>
      </div>
      {problem && (
        <p className="courier-note" role="alert" id={ids.problem}>
          <Icon name="info" />
          <span>{problem}</span>
        </p>
      )}
      <button type="submit" className="courier-btn primary" disabled={busy || !ready}>
        {busy ? W.mac.connecting : W.mac.connect}
      </button>
    </form>
  );
}

/** What a refusal of `courier.accounts.add` says, and which field it's about. */
export function signInWords(e: unknown): { text: string; field: 'address' | 'secret' | 'server' | 'username' | null } {
  const err = toCourierError(e);
  const r = err.reason;
  if (err.code === 'unavailable') {
    if (r === 'provider') return { text: W.err.provider, field: 'server' };
    if (r === 'storage') return { text: W.err.storage, field: null };
    if (r === 'switched_off') return { text: W.err.switchedOff, field: null };
    return { text: W.err.medium, field: null };
  }
  if (err.code === 'forbidden' && r === 'sign_in') return { text: W.err.signIn(err.provider), field: 'secret' };
  if (err.code === 'conflict' && r === 'too_many') return { text: W.err.tooMany, field: null };
  if (err.code === 'conflict' && r === 'exists') return { text: W.err.exists, field: 'address' };
  if (err.code === 'bad_request') {
    if (r === 'address') return { text: W.err.address, field: 'address' };
    if (r === 'secret') return { text: W.err.secret, field: 'secret' };
    if (r === 'server') return { text: W.err.server, field: 'server' };
    if (r === 'username') return { text: W.err.username, field: 'username' };
    if (r === 'auth') return { text: W.err.auth, field: null };
    if (r === 'kind') return { text: W.err.kind, field: null };
  }
  if (err.code === 'offline') return { text: W.offline, field: null };
  return { text: W.failed, field: null };
}

function AccountRow({ a, onRemove, onSignIn }: { a: Account; onRemove(keepMail: boolean): Promise<void>; onSignIn(): void }) {
  const [asking, setAsking] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const keepId = useId();
  const mac = a.kind === 'imessage';
  const linked = a.kind === 'imap' || a.kind === 'jmap' || mac;
  const line = mac ? macLine(a.mac, Date.now()) : null;
  return (
    <li className="courier-account" data-kind={a.kind} data-needs-you={line?.needsYou || undefined}>
      <div className="courier-account-main">
        <span className="courier-account-label">{a.kind === 'desk' ? a.address : mac ? W.mac.row : a.label || a.address}</span>
        {line ? (
          <>
            <span className="courier-account-line">{line.text}</span>
            {line.quiet && <span className="courier-quiet">{line.quiet}</span>}
            {line.check && <span className="courier-quiet">{line.check}</span>}
          </>
        ) : (
          <>
            {a.kind !== 'desk' && <span className="courier-account-line">{a.signedIn === false ? W.needsYou : W.signedInAs(a.address)}</span>}
            <span className="courier-quiet">{a.sending ? W.canSend : W.receives}</span>
          </>
        )}
      </div>
      {linked && (
        <div className="courier-account-acts">
          {a.signedIn === false && !mac && (
            <button type="button" className="courier-btn primary" onClick={onSignIn}>
              {W.signInAgain}
            </button>
          )}
          {!asking && (
            <button type="button" className="courier-btn quiet" onClick={() => setAsking(true)} aria-label={`${W.removeAccount} ${mac ? W.mac.row : a.address}`}>
              {W.removeAccount}
            </button>
          )}
        </div>
      )}
      {asking && (
        <div className="courier-confirm" role="group" aria-label={mac ? W.mac.removeAsk : W.removeAsk(a.address)}>
          <p>{mac ? W.mac.removeAsk : W.removeAsk(a.address)}</p>
          <label className="courier-check" htmlFor={keepId}>
            <input id={keepId} type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>{mac ? W.mac.keepMessages : W.keepMail}</span>
          </label>
          <p className="courier-quiet">{mac ? W.mac.removeLine : W.revoke}</p>
          <div className="courier-confirm-btns">
            <button
              type="button"
              className="courier-btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onRemove(keep).finally(() => {
                  setBusy(false);
                  setAsking(false);
                });
              }}
            >
              {mac ? W.mac.removeConfirm : W.removeConfirm}
            </button>
            <button type="button" className="courier-btn" onClick={() => setAsking(false)}>
              {W.cancel}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function SignInForm({ provider, address: startAddress, client, onDone, onBack }: { provider: Provider; address: string; client: CourierClient; onDone(address: string): void; onBack(): void }) {
  const [address, setAddress] = useState(startAddress);
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState(false);
  const [server, setServer] = useState({ imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465', security: 'tls' as 'tls' | 'starttls' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; field: string | null } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const ids = { address: useId(), secret: useId(), label: useId(), problem: useId(), guide: useId() };
  const other = provider.id === 'other';
  useEffect(() => {
    first.current?.focus();
  }, []);
  // Whatever happens, the password leaves the page as the form does.
  useEffect(
    () => () => {
      if (secret.current) secret.current.value = '';
    },
    [],
  );

  const submit = async (): Promise<void> => {
    const field = secret.current;
    const value = field?.value ?? '';
    if (field) field.value = '';
    if (!value) {
      setProblem({ text: W.err.secret, field: 'secret' });
      field?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    const input: AccountInput = {
      address: address.trim(),
      auth: other && accountPassword ? 'password' : 'app_password',
      secret: value,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(other && username.trim() ? { username: username.trim() } : {}),
      // A named tile sends its provider, so a Workspace or own-domain address needs no guess; only Other sends servers, the
      // member's own words: the desk's transport knows the named providers' own.
      ...(other ? {} : { provider: provider.id }),
      ...(other ? { server: { imapHost: server.imapHost.trim(), imapPort: Number(server.imapPort), smtpHost: server.smtpHost.trim(), smtpPort: Number(server.smtpPort), security: server.security } } : {}),
    };
    try {
      await client.addAccount(input);
      onDone(input.address);
    } catch (e) {
      const p = signInWords(e);
      setProblem(p);
      if (p.field === 'secret') secret.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const bad = (f: string): boolean => problem?.field === f;
  return (
    <form
      className="courier-signin"
      aria-labelledby={`${ids.guide}-h`}
      aria-describedby={ids.guide}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <button type="button" className="courier-btn quiet courier-back" onClick={onBack}>
        <Icon name="back" />
        <span>{W.backToProviders}</span>
      </button>
      <h3 id={`${ids.guide}-h`}>{provider.name}</h3>
      <p id={ids.guide}>{provider.guide}</p>
      <label className="courier-field" htmlFor={ids.address}>
        <span>{W.address}</span>
        <input ref={first} id={ids.address} type="email" autoComplete="email" spellCheck={false} required value={address} onChange={(e) => setAddress(e.target.value)} aria-invalid={bad('address') || undefined} aria-describedby={bad('address') ? ids.problem : undefined} />
      </label>
      <label className="courier-field" htmlFor={ids.secret}>
        <span>{other && accountPassword ? W.accountPassword : W.password}</span>
        <input ref={secret} id={ids.secret} type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" maxLength={8192} aria-invalid={bad('secret') || undefined} aria-describedby={bad('secret') ? ids.problem : undefined} data-testid="courier-secret" />
      </label>
      {other && (
        <>
          <label className="courier-check">
            <input type="checkbox" checked={accountPassword} onChange={(e) => setAccountPassword(e.target.checked)} />
            <span>{W.usePassword}</span>
          </label>
          <label className="courier-field">
            <span>{W.username}</span>
            <input type="text" autoComplete="username" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} aria-invalid={bad('username') || undefined} />
          </label>
          <fieldset className="courier-servers" aria-invalid={bad('server') || undefined}>
            <legend className="courier-sr">{W.imapHost}</legend>
            <label className="courier-field grow">
              <span>{W.imapHost}</span>
              <input type="text" spellCheck={false} required value={server.imapHost} onChange={(e) => setServer({ ...server, imapHost: e.target.value })} placeholder="imap.example.com" />
            </label>
            <label className="courier-field port">
              <span>{W.imapPort}</span>
              <input type="number" inputMode="numeric" min={1} max={65535} required value={server.imapPort} onChange={(e) => setServer({ ...server, imapPort: e.target.value })} />
            </label>
            <label className="courier-field grow">
              <span>{W.smtpHost}</span>
              <input type="text" spellCheck={false} required value={server.smtpHost} onChange={(e) => setServer({ ...server, smtpHost: e.target.value })} placeholder="smtp.example.com" />
            </label>
            <label className="courier-field port">
              <span>{W.smtpPort}</span>
              <input type="number" inputMode="numeric" min={1} max={65535} required value={server.smtpPort} onChange={(e) => setServer({ ...server, smtpPort: e.target.value })} />
            </label>
            <label className="courier-field">
              <span>{W.security}</span>
              <select value={server.security} onChange={(e) => setServer({ ...server, security: e.target.value === 'starttls' ? 'starttls' : 'tls' })}>
                <option value="tls">{W.tls}</option>
                <option value="starttls">{W.starttls}</option>
              </select>
            </label>
          </fieldset>
        </>
      )}
      <label className="courier-field" htmlFor={ids.label}>
        <span>{W.label}</span>
        <input id={ids.label} type="text" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="courier-sealed">
        <Icon name="shield" />
        <p>
          {W.sealed} {W.sealedLimit}
        </p>
      </div>
      {problem && (
        <p className="courier-note" role="alert" id={ids.problem}>
          <Icon name="info" />
          <span>{problem.text}</span>
        </p>
      )}
      <button type="submit" className="courier-btn primary" disabled={busy}>
        {busy ? W.linking : W.link}
      </button>
    </form>
  );
}

/**
 * This desk's address as the registry has it (flow 1 and 11's Accounts): the address with Share, or Choose an address. Undefined
 * while the registry is asked, null where there is none to ask (then the desk's own account row shows, as before).
 */
export type AddressRow = { address: DeskAddress | null; onShare(): void; onChoose(): void } | null | undefined;

export function Setup({ client, reload, onClose, onChanged, narrow, address, foot }: { client: CourierClient; reload: number; onClose(): void; onChanged(foot: Foot | null): void; narrow: boolean; address?: AddressRow; foot?: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<{ provider: Provider; address: string } | null>(null);
  const [macForm, setMacForm] = useState(false);
  const [later, setLater] = useState<Provider | null>(null);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  // Blocked senders (Wave 3.2), each with Unblock: it ends exactly that block (API.md §21).
  useEffect(() => {
    let gone = false;
    client.blocks().then(
      (b) => !gone && setBlocks(b),
      () => !gone && setBlocks(null),
    );
    return () => {
      gone = true;
    };
  }, [client, reload]);
  useEffect(() => {
    let gone = false;
    client.accounts().then(
      (a) => {
        if (gone) return;
        setAccounts(a);
        setFailed(false);
      },
      () => !gone && setFailed(true),
    );
    return () => {
      gone = true;
    };
  }, [client, reload]);
  useEffect(() => {
    head.current?.focus();
  }, []);

  const desk = accounts?.filter((a) => a.kind === 'desk') ?? [];
  const linked = accounts?.filter((a) => a.kind !== 'desk') ?? [];
  const providerFor = (a: Account): Provider => {
    // The desk says which provider its servers are (a Workspace address is Gmail's); else the address's own domain.
    const known = PROVIDERS.find((p) => p.id === a.provider && !p.later);
    if (known) return known;
    const d = a.address.slice(a.address.lastIndexOf('@') + 1).toLowerCase();
    return PROVIDERS.find((p) => (p.id === 'gmail' && /^(gmail|googlemail)\./.test(d)) || (p.id === 'icloud' && /^(icloud|me|mac)\./.test(d)) || (p.id === 'yahoo' && /^yahoo\./.test(d)) || (p.id === 'fastmail' && /^fastmail\./.test(d))) ?? PROVIDERS.find((p) => p.id === 'other')!;
  };

  return (
    <div className="courier-setup" data-testid="courier-setup">
      <div className="courier-setup-head">
        <button type="button" className="courier-icon-btn" onClick={onClose} aria-label={W.back} title={W.back}>
          <Icon name="back" />
        </button>
        <h2 ref={head} tabIndex={-1}>
          {W.accounts}
        </h2>
      </div>
      <div className="courier-setup-scroll" data-narrow={narrow || undefined}>
        {failed && <p className="courier-note">{W.failed}</p>}
        {address && (
          <section aria-labelledby="courier-desk-h" data-testid="courier-desk-address">
            <h3 id="courier-desk-h">{W.deskAddress}</h3>
            <ul className="courier-accounts">
              <li className="courier-account" data-kind="desk">
                {address.address ? (
                  <>
                    <div className="courier-account-main">
                      <span className="courier-account-label">{address.address.address}</span>
                    </div>
                    <div className="courier-account-acts">
                      <button type="button" className="courier-btn" onClick={address.onShare}>
                        {W.share}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="courier-account-acts">
                    <button type="button" className="courier-btn primary" onClick={address.onChoose}>
                      {W.addrChooseLater}
                    </button>
                  </div>
                )}
              </li>
            </ul>
          </section>
        )}
        {!address && desk.length > 0 && (
          <section aria-labelledby="courier-desk-h">
            <h3 id="courier-desk-h">{W.deskAddress}</h3>
            <ul className="courier-accounts">
              {desk.map((a) => (
                <AccountRow key={a.accountId} a={a} onRemove={async () => undefined} onSignIn={() => undefined} />
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="courier-linked-h">
          <h3 id="courier-linked-h">{W.linked}</h3>
          {accounts && linked.length === 0 && <p className="courier-quiet">{W.noAccounts}</p>}
          <ul className="courier-accounts">
            {linked.map((a) => (
              <AccountRow
                key={a.accountId}
                a={a}
                onSignIn={() => setForm({ provider: providerFor(a), address: a.address })}
                onRemove={async (keepMail) => {
                  try {
                    await client.removeAccount(a.accountId, keepMail);
                    onChanged({ text: a.kind === 'imessage' ? W.mac.removed : W.removed(a.address) });
                  } catch (e) {
                    onChanged({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed });
                  }
                }}
              />
            ))}
          </ul>
        </section>
        {blocks && (
          <section aria-labelledby="courier-blocked-h" data-testid="courier-blocked">
            <h3 id="courier-blocked-h">{W.blockedHead}</h3>
            {blocks.length === 0 ? (
              <p className="courier-quiet">{W.blockedNone}</p>
            ) : (
              <ul className="courier-accounts">
                {blocks.map((b) => {
                  const label = b.kind === 'domain' ? W.blockedDomain(b.value) : b.value;
                  return (
                    <li key={`${b.kind}:${b.value}`} className="courier-account">
                      <div className="courier-account-main">
                        <span className="courier-account-label">{label}</span>
                      </div>
                      <div className="courier-account-acts">
                        <button
                          type="button"
                          className="courier-btn quiet"
                          aria-label={`${W.unblock}: ${label}`}
                          onClick={() =>
                            void client.unblock(b.kind, b.value).then(
                              () => {
                                setBlocks((all) => (all ?? []).filter((x) => x !== b));
                                onChanged({ text: W.unblocked(label) });
                              },
                              (e) => onChanged({ text: toCourierError(e).code === 'offline' ? W.offline : W.failed }),
                            )
                          }
                        >
                          {W.unblock}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        <section aria-labelledby="courier-add-h" className="courier-add">
          <h3 id="courier-add-h">{W.setupTitle}</h3>
          {macForm ? (
            <MacForm
              client={client}
              onBack={() => setMacForm(false)}
              onDone={(check) => {
                setMacForm(false);
                onChanged(check ? { text: W.mac.confirmOnMac(check), wrap: true, ms: 30000 } : { text: W.mac.done });
              }}
            />
          ) : form ? (
            <SignInForm
              provider={form.provider}
              address={form.address}
              client={client}
              onBack={() => setForm(null)}
              onDone={(address) => {
                setForm(null);
                onChanged({ text: W.linkedDone(address) });
              }}
            />
          ) : (
            <>
              <p>{W.setupLead}</p>
              <ul className="courier-providers" aria-label={W.chooseProvider}>
                {PROVIDERS.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="courier-provider" aria-describedby={p.later ? `courier-later-${p.id}` : undefined} onClick={() => (p.later ? setLater(later?.id === p.id ? null : p) : p.id === 'imessage' ? setMacForm(true) : setForm({ provider: p, address: '' }))} aria-expanded={p.later ? later?.id === p.id : undefined}>
                      <span>{p.name}</span>
                      {p.later && (
                        <span className="courier-quiet" id={`courier-later-${p.id}`}>
                          {W.later}
                        </span>
                      )}
                    </button>
                    {later?.id === p.id && <p className="courier-quiet courier-provider-later">{p.guide}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
      {foot}
    </div>
  );
}
