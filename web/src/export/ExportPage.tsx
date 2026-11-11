// `/export` on office.: "Download your data", and "Move a desk to your own computer" (draft ADR "data export and transfer",
// decisions 1, 2, 6, 9 and 10). Shown only when client-config says `export.enabled`, and loaded as its own chunk.
//
// The files come from each desk over its own session, straight into this computer: the office's ordinary owner
// session for an active member, or an export-only one for a closed account whose data is still kept. The archive is
// written in place in the browser's private storage with a journal beside it, so a reload or a closed tab can carry
// on, and then copied into the file the member chose, or offered from there.
import { closedLine, closedMembership } from './closed';
import { useEffect, useRef, useState } from 'react';
import { createDeskLink, type DeskLink } from '../desk/deskLink';
import { keepOpen, linkOf, wakeDesk } from '../desk/liveStore';
import { api, getDesks, type PlatformDesk } from '../platform/api';
import { currentMember } from '../platform/auth';
import { siblingUrl } from '../platform/hosts';
import { accountUrl, SUPPORT_ADDRESS, type ClientConfig } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { useCloseHold } from '../shell/closeGuard';
import { useDeskStore } from '../state/deskStore';
import { deskFolders, exportFileName } from './archive';
import { encryptedName } from './passphrase';
import { PassphraseFields, passOk, type Pass } from './PassphraseFields';
import { Cancelled } from './copier';
import { formatBytes, formatCount } from './format';
import { dropExport, exportOwnerTag } from '../platform/exportSweep';
import { freshMeta, type JournalEntry, type JournalMeta } from './journal';
import { MovePanel } from './MovePanel';
import { CantCarryOn, runExport, type DeskRunState, type OpenedDesk, type RunControl, type RunState } from './run';
import { canPickFile, canResume, mayWrite, pickHandle } from './sink';
import { findPartial, oneGo, resumeWorking, startWorking, type Finished, type Working } from './working';
import './export.css';

declare const __MA_VERSION__: string;

type Loaded<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed' };

type View =
  | { kind: 'choose' }
  | { kind: 'offer'; meta: JournalMeta; entries: JournalEntry[] }
  | { kind: 'running'; state: RunState | null; note: string | null }
  | { kind: 'saving' }
  | { kind: 'done'; state: RunState; name: string; url: string | null; clear: (() => Promise<void>) | null }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string };

const CANT_CARRY_ON = "That download can't carry on from here. Start again when you're ready.";
const ANOTHER_TAB = 'This download is carrying on in another tab.';
const inAnotherTab = (err: unknown): boolean => err instanceof DOMException && (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError');

const SETTING_UP = new Set(['requested', 'provisioning']);
const ASLEEP = new Set(['stopped', 'retained']);
/** Not reached yet: after this long, the member may leave the desk out and let the others finish. */
const STUCK = new Set(['waking', 'connecting', 'reconnecting']);
const STUCK_MS = 30_000;
/**
 * A closed account's desk that stopped under its download is woken again: up to this many times in a row without
 * opening, after 1 s, 2 s, 4 s and so on. Each wait stays under the copier's `GONE_MS`, so the desk isn't given up on
 * meanwhile, and opening starts the count again, so a download can outlast any number of export windows.
 */
const REWAKES = 8;
const REWAKE_MAX_MS = 15_000;

/** Whose a download is: a tag of the signed-in member's id, or null while that can't be known. */
async function ownerNow(): Promise<string | null> {
  const sub = await currentMember();
  return sub ? exportOwnerTag(sub) : null;
}

/**
 * The Platform app's `/self-hosted` page (task 31), which sets up a desk on the member's own computer: client-config's
 * own link if it gives one, or else on the account link's host.
 */
function selfHostingGuide(config: ClientConfig): string | null {
  const given = siblingUrl(config.links?.['selfHosted'], window.location.hostname);
  if (given) return given.href;
  const account = accountUrl(config);
  return account ? new URL('/self-hosted', account).href : null;
}

/** A desk that can't be opened says so, and isn't offered. */
function deskNote(d: PlatformDesk): { note: string | null; can: boolean } {
  if (SETTING_UP.has(d.state)) return { note: 'Still being set up.', can: false };
  if (Array.isArray(d.allowedActions) && d.allowedActions.length === 0) return { note: `Can't be opened right now. Write to ${SUPPORT_ADDRESS}.`, can: false };
  // A retained guild desk can't be woken, only restored or exported by a route this page doesn't use yet.
  if (d.state === 'retained' && d.hosting !== 'self') return { note: 'Kept for you. Not in downloads yet.', can: false };
  // A desk on the member's own computer can't be woken from here: it's there when that computer is on (desks.md 0.3.13).
  if (d.hosting === 'self') return ASLEEP.has(d.state) ? { note: 'Offline. Turn on its computer to include it.', can: false } : { note: 'On your own computer.', can: true };
  if (ASLEEP.has(d.state)) return { note: 'Asleep. It wakes for the download.', can: true };
  return { note: null, can: true };
}

function failureMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'QuotaExceededError') return "There isn't enough free space for the download. Make some room, then try again.";
  if (name === 'NotAllowedError') return 'This browser stopped the download from saving. Try again, and allow it to save the file.';
  return "The download stopped before it finished, and nothing was saved. Try again in a minute.";
}

/** A ready link from the office's own list, which the session makes once `GET /v1/desks` has answered. */
async function officeLink(deskId: string): Promise<DeskLink> {
  for (let i = 0; i < 150; i += 1) {
    const link = linkOf(deskId);
    if (link) return link;
    await new Promise((r) => window.setTimeout(r, 200));
  }
  throw new Error(`no link for ${deskId}`);
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.5 6.2 2.3 2.3 4.7-4.9" />
    </svg>
  );
}

function progressLine(d: DeskRunState): string {
  const files = d.files ? `${formatCount(d.filesDone)} of ${formatCount(d.files)} files` : '';
  const bytes = d.bytes ? `${formatBytes(Math.min(d.bytesDone, d.bytes))} of ${formatBytes(d.bytes)}` : '';
  const both = [files, bytes].filter(Boolean).join(' · ');
  switch (d.phase) {
    case 'waiting':
      return 'Waiting';
    case 'waking':
      return `Waking ${d.name}…`;
    case 'connecting':
      return `Connecting to ${d.name}…`;
    case 'listing':
      return `Looking through ${d.name}…`;
    case 'copying':
      return both || 'Copying…';
    case 'reconnecting':
      return both ? `Reconnecting… ${both}` : 'Reconnecting…';
    case 'done': {
      const done = [`${formatCount(d.filesDone - d.notCopied)} files`, d.bytesDone ? formatBytes(d.bytesDone) : ''].filter(Boolean).join(' · ');
      return d.notCopied ? `Done · ${done} · ${formatCount(d.notCopied)} couldn't be copied` : `Done · ${done}`;
    }
    case 'unavailable':
      return "The download isn't available on this desk yet.";
    case 'refused':
      return "This desk can't be opened for a download right now.";
    case 'stopped':
      return 'This desk stopped before everything was copied.';
    case 'left':
      return 'Left out of this download.';
    default:
      return "This desk couldn't be read.";
  }
}

function DeskProgress({ d, onLeaveOut }: { d: DeskRunState; onLeaveOut?: (() => void) | undefined }) {
  const share = d.phase === 'done' ? 1 : d.bytes ? Math.min(1, d.bytesDone / d.bytes) : d.files ? Math.min(1, d.filesDone / d.files) : 0;
  const quiet = d.phase === 'waiting';
  // A desk that hasn't been reached for a while can be left out, so the others needn't wait for it.
  const stuck = !!onLeaveOut && STUCK.has(d.phase);
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!stuck) return undefined;
    const t = window.setTimeout(() => setLong(true), STUCK_MS);
    return () => window.clearTimeout(t);
  }, [stuck]);
  return (
    <li className={`xp-row${quiet ? ' quiet' : ''}`} data-testid={`progress-${d.deskId}`} data-phase={d.phase}>
      <div className="xp-row-text">
        <span className="xp-desk-name">{d.name}</span>
        <span className="xp-row-note">
          {progressLine(d)}
          {stuck && long && (
            <>
              {' · '}
              <span data-testid={`not-answering-${d.deskId}`}>Not answering yet.</span>{' '}
              <button type="button" className="xp-inline" onClick={onLeaveOut} aria-label={`Leave ${d.name} out`} data-testid={`leave-out-${d.deskId}`}>
                Leave out
              </button>
            </>
          )}
        </span>
      </div>
      <div className="xp-bar" role="progressbar" aria-label={`${d.name} copied`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span style={{ transform: `scaleX(${share})` }} />
      </div>
    </li>
  );
}

/**
 * "Download your data". On `/export` it's the whole page; in the office it's Account settings' "Your data" section
 * (`inOffice`, ADR 0052), told through `onHolding` while a download needs it to stay: running, saving, or finished and
 * not yet saved. The office keeps it mounted then, out of sight, so closing Account settings never stops a download.
 */
export function ExportPanel({ inOffice = false, onHolding }: { inOffice?: boolean; onHolding?: (holding: boolean) => void } = {}) {
  const config = useSession((s) => s.config);
  const me = useSession((s) => s.me);
  const [account, setAccount] = useState<Loaded<unknown>>({ status: 'loading' });
  const [desks, setDesks] = useState<Loaded<{ desks: PlatformDesk[]; status: string | null }>>({ status: 'loading' });
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>({ kind: 'choose' });
  const abort = useRef<AbortController | null>(null);
  const [protect, setProtect] = useState(false);
  // The browser's save window is open (LS-15): it can sit behind the page or be blocked, so the page says it's waiting.
  const [picking, setPicking] = useState(false);
  const [pass, setPass] = useState<Pass>({ value: '', again: '' });
  // Held only here, only while a download runs: never stored, and gone when it ends.
  const secret = useRef<string | null>(null);
  const control = useRef<RunControl | null>(null);
  /** A finished archive offered from this browser: its url goes when the page does. */
  const finished = useRef<Finished | null>(null);

  const loadAccount = (): void => {
    setAccount({ status: 'loading' });
    api<unknown>('/v1/me/export').then(
      (r) => setAccount(r.data ? { status: 'ready', data: r.data } : { status: 'failed' }),
      () => setAccount({ status: 'failed' }),
    );
  };
  const loadDesks = (): void => {
    getDesks().then(
      (r) => setDesks({ status: 'ready', data: { desks: r.data?.desks ?? [], status: r.data?.membership?.status ?? null } }),
      () => setDesks({ status: 'failed' }),
    );
  };
  const lookForJournal = (): void => {
    if (!canResume()) return;
    // Only the member's own: one of anyone else's is deleted, never offered.
    ownerNow()
      .then((owner) => (owner ? findPartial(owner) : null))
      .then(
        (j) => j && setView((v) => (v.kind === 'choose' ? { kind: 'offer', meta: j.meta, entries: j.entries } : v)),
        () => {}, // nothing to carry on
      );
  };
  useEffect(() => {
    if (!inOffice) document.title = 'Your data · Minimalist Alliance'; // in the office, the office's own title stays
  }, [inOffice]);
  useEffect(() => {
    loadAccount();
    loadDesks();
    lookForJournal();
  }, []);

  // A download in progress asks before the page goes, quietly, with the browser's own words. It can carry on if they go.
  const busy = view.kind === 'running' || view.kind === 'saving';
  const holding = busy || (view.kind === 'done' && view.url !== null);
  useEffect(() => {
    onHolding?.(holding);
  }, [holding, onHolding]);
  useEffect(() => () => onHolding?.(false), [onHolding]);
  useCloseHold(busy);

  // And keeps the screen on while it runs, where the browser allows it: a sleeping computer drops the desks.
  useEffect(() => {
    if (!busy || !navigator.wakeLock) return undefined;
    let lock: WakeLockSentinel | null = null;
    let over = false;
    const take = (): void => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      navigator.wakeLock.request('screen').then(
        (l) => {
          if (over) void l.release();
          else lock = l;
        },
        () => {},
      );
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      over = true;
      document.removeEventListener('visibilitychange', take);
      lock?.release().catch(() => {});
    };
  }, [busy]);

  // Leaving the page by the app (not a reload, which stops everything anyway) leaves the download to carry on later.
  // A finished archive's url goes with it, as at a sign-out: the sealed copy stays to come back for.
  useEffect(
    () => () => {
      abort.current?.abort('leaving');
      finished.current?.close();
    },
    [],
  );

  const list = desks.status === 'ready' ? desks.data.desks : [];
  const status = me?.membership?.status ?? (desks.status === 'ready' ? desks.data.status : null);
  // An ended membership and a suspended one get the same: the export-only session and the move. A safety suspension
  // looks like any other here (the client isn't told why); the server refuses its export `connect`, and that shows as
  // the desk's calm "can't be opened" line, with nothing asked again.
  const ended = closedMembership(status);
  const offered = list.filter((d) => deskNote(d).can);
  const chosen = offered.filter((d) => !off[d.deskId]);
  const saveWay = canResume() ? 'browser' : canPickFile() ? 'file' : null;
  const ready = account.status === 'ready' && desks.status === 'ready' && saveWay !== null;
  const deleteAt = (() => {
    const m = account.status === 'ready' ? ((account.data as { membership?: Record<string, unknown> } | null)?.membership ?? null) : null;
    const raw = m?.['dataDeleteAt'] ?? m?.['deleteAt'];
    const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
  })();

  const opener = (closed: boolean) => async (deskId: string): Promise<OpenedDesk> => {
    if (closed) {
      // A closed account: an export-only session of its own, which wakes the desk (ma-platform draft, section 3). A
      // download can outlast the desk's export window, so a desk stopped under it is asked to wake again, a few times.
      // The link itself waits out a desk that's stopping, at the pace `connect` gives; this wakes one that has
      // stopped, as long as Platform lets it, a little later each time it doesn't open, and never in a burst.
      const link = await createDeskLink(deskId, 'export');
      let over = false;
      let tries = 0;
      let timer = 0;
      const off = link.onStatus((st) => {
        if (st === 'open') tries = 0;
        if (st !== 'idle' || over || timer || tries >= REWAKES) return;
        timer = window.setTimeout(() => {
          timer = 0;
          if (!over && link.status() === 'idle') link.connect();
        }, Math.min(REWAKE_MAX_MS, 1000 * 2 ** tries++));
      });
      link.connect();
      return {
        link,
        waking: true,
        done: () => {
          over = true;
          window.clearTimeout(timer);
          off();
          link.close();
        },
      };
    }
    const link = await officeLink(deskId);
    keepOpen(deskId, true);
    let waking = false;
    if (link.status() === 'resting') link.reopen();
    else if (link.status() !== 'open') {
      const vm = useDeskStore.getState().desks.find((d) => d.id === deskId)?.vm;
      waking = vm === 'stopped' || vm === 'starting';
      wakeDesk(deskId); // the member asked, so a desk that's asleep wakes
    }
    return { link, waking, done: () => keepOpen(deskId, false) };
  };

  /** One download, new or carried on, from its working copy to its end. */
  const go = async (working: Working, meta: JournalMeta, entries: JournalEntry[], note: string | null): Promise<void> => {
    const ac = new AbortController();
    abort.current = ac;
    working.onGone?.(() => ac.abort('gone')); // signed out, or discarded, elsewhere: nothing of it may stay
    setView({ kind: 'running', state: null, note });
    const loaded = account.status === 'ready' ? account.data : null;
    try {
      const state = await runExport(
        { sink: working.sink, journal: working.journal, meta, entries },
        {
          account: () => api<unknown>('/v1/me/export', { signal: AbortSignal.timeout(10_000) }).then((r) => r.data ?? loaded, () => loaded),
          open: opener(meta.ended),
          onState: (st) => setView((v) => (v.kind === 'running' ? { ...v, state: st } : v)),
          version: __MA_VERSION__,
          control: (c) => {
            control.current = c;
          },
          ...(working.sync ? { sync: working.sync } : {}),
        },
        ac.signal,
      );
      const done = await working.finish(
        meta,
        () => setView({ kind: 'saving' }),
        () => {
          finished.current = null;
          setView({ kind: 'choose' }); // deleted from somewhere, a sign-out say: nothing of it is left to save
        },
        secret.current ?? undefined,
      );
      secret.current = null;
      if (ac.signal.aborted) {
        // Deleted while it was being decrypted: the copy just made goes too.
        done.close();
        setView({ kind: 'stopped' });
        return;
      }
      finished.current = done.url ? done : null;
      setView({ kind: 'done', state, name: meta.fileName, url: done.url, clear: done.clear });
    } catch (err) {
      if (ac.signal.aborted && ac.signal.reason === 'leaving') {
        await working.release();
      } else if (err instanceof Cancelled || ac.signal.aborted) {
        await working.discard();
        setView({ kind: 'stopped' });
      } else if (err instanceof CantCarryOn) {
        await working.discard();
        setView({ kind: 'failed', message: CANT_CARRY_ON });
      } else {
        await working.release();
        setView({ kind: 'failed', message: failureMessage(err) });
      }
    } finally {
      abort.current = null;
      secret.current = null;
      control.current = null;
    }
  };

  const start = async (): Promise<void> => {
    if (!ready || view.kind === 'running') return;
    const locked = protect && canResume();
    if (locked && !passOk(pass)) return;
    const name = locked ? encryptedName(exportFileName(new Date())) : exportFileName(new Date());
    let handle: FileSystemFileHandle | null | undefined;
    try {
      // Straight from the click: the picker needs it.
      setPicking(true);
      handle = await pickHandle(name, locked);
    } catch {
      setView({ kind: 'failed', message: "This browser couldn't open a file to save to. Try again." });
      return;
    } finally {
      setPicking(false);
    }
    if (handle === null) return; // they chose not to
    const owner = await ownerNow();
    if (!owner) {
      setView({ kind: 'failed', message: "The download stopped before it finished, and nothing was saved. Try again in a minute." });
      return;
    }
    const folders = deskFolders(chosen.map((d) => ({ deskId: d.deskId, name: d.name })));
    const plan = chosen.map((d) => ({ deskId: d.deskId, name: d.name, folder: folders.get(d.deskId) ?? d.deskId }));
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
    // The name they gave it in the picker, which needn't be the one suggested.
    const meta = freshMeta({ id, madeAt: new Date().toISOString(), fileName: handle?.name || name, target: handle ? 'file' : 'browser', ...(handle ? { handle } : {}), ended, desks: plan, ...(locked ? { encrypted: true } : {}) });
    secret.current = locked ? pass.value : null;
    setPass({ value: '', again: '' });
    let working: Working | null = null;
    try {
      if (canResume()) working = await startWorking(handle ?? undefined, owner).catch((err: unknown) => (inAnotherTab(err) ? Promise.reject(err as Error) : null));
      if (!working && handle) working = await oneGo(handle); // no worker storage: straight into their file, for this visit only
    } catch (err) {
      if (inAnotherTab(err)) {
        setView({ kind: 'failed', message: ANOTHER_TAB });
        return;
      }
      working = null;
    }
    if (!working) {
      setView({ kind: 'failed', message: "This browser couldn't open a file to save to. Try again." });
      return;
    }
    await go(working, meta, [], null);
  };

  /** "Carry on": the journal's download, from where it stopped, into its working copy as it is. */
  const carryOn = async (offer: { meta: JournalMeta; entries: JournalEntry[] }): Promise<void> => {
    if (offer.meta.encrypted) {
      if (!passOk(pass)) return;
      secret.current = pass.value; // typed again: it was never kept
      setPass({ value: '', again: '' });
    }
    let meta = offer.meta;
    let note: string | null = null;
    if (meta.target === 'file' && meta.handle && !(await mayWrite(meta.handle))) {
      meta = { ...meta, target: 'browser' };
      delete meta.handle;
      note = "This browser didn't allow saving to the same file again, so you'll save it from here when it's done.";
    }
    let working: Working;
    try {
      const owner = await ownerNow();
      if (!owner) throw new DOMException("who's signed in isn't known", 'NotFoundError');
      working = await resumeWorking(meta, owner);
    } catch (err) {
      if (inAnotherTab(err)) {
        setView({ kind: 'failed', message: ANOTHER_TAB });
        return;
      }
      await dropExport();
      setView({ kind: 'failed', message: CANT_CARRY_ON });
      return;
    }
    await go(working, meta, offer.entries, note);
  };

  /** "Discard": the partial download, its journal and its key all go, and the page is as for a fresh start. */
  const discard = async (): Promise<void> => {
    await dropExport();
    setView({ kind: 'choose' });
  };

  const reset = (): void => {
    if (view.kind === 'done') void view.clear?.();
    finished.current = null;
    setView({ kind: 'choose' });
    lookForJournal();
  };

  const guide = config ? selfHostingGuide(config) : null;
  const running = view.kind === 'running' ? view.state : null;

  const Head = inOffice ? 'div' : 'header';
  const body = (
    <>
        {/* In the office it's a section of Account settings, under the office's own banner, so not a second one. */}
        <Head className="xp-head">
          {!inOffice && (
            <>
              <a className="xp-back" href="/">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14.5 6 8.5 12l6 6" />
                </svg>
                Your office
              </a>
              <p className="calm-brand">Minimalist Alliance</p>
              <h1>Your data</h1>
            </>
          )}
          <p className="xp-lede">
            Download everything on your desks and in your account, as one ZIP file. Your desks send their files straight to you over an encrypted connection. If your connection needs our relay, they pass through it still encrypted, and in normal operation our services don't see them.
          </p>
          {ended && (
            <p className="xp-lede" data-testid="export-ended">
              {closedLine(deleteAt)}
            </p>
          )}
        </Head>

        <section className="xp-card" aria-labelledby="xp-download-title">
          <h2 id="xp-download-title">Download your data</h2>

          {view.kind === 'choose' && (
            <>
              {desks.status === 'loading' && <p className="xp-text">Finding your desks…</p>}
              {desks.status === 'failed' && (
                <p className="xp-text" role="alert">
                  Your desks can't be reached right now.{' '}
                  <button type="button" className="xp-inline" onClick={loadDesks}>Try again</button>
                </p>
              )}
              {desks.status === 'ready' && list.length > 0 && (
                <fieldset className="xp-desks">
                  <legend className="xp-label">Desks to include</legend>
                  {list.map((d) => {
                    const { note, can } = deskNote(d);
                    return (
                      <label key={d.deskId} className={`xp-row xp-choice${can ? '' : ' disabled'}`} data-testid={`choose-${d.deskId}`}>
                        <input type="checkbox" checked={can && !off[d.deskId]} disabled={!can} onChange={(e) => setOff((o) => ({ ...o, [d.deskId]: !e.target.checked }))} />
                        <span className="xp-check" aria-hidden="true"><Check /></span>
                        <span className="xp-row-text">
                          <span className="xp-desk-name">{d.name}</span>
                          {note && <span className="xp-row-note">{note}</span>}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
              <p className="xp-text">Your account comes too: your membership, billing history, and what Maia remembers.</p>
              {account.status === 'failed' && (
                <p className="xp-text" role="alert">
                  Your account details can't be reached right now.{' '}
                  <button type="button" className="xp-inline" onClick={loadAccount}>Try again</button>
                </p>
              )}
              {saveWay !== null && canResume() && (
                <div className="xp-stack">
                  <label className="xp-row xp-choice" data-testid="protect-choice">
                    <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
                    <span className="xp-check" aria-hidden="true"><Check /></span>
                    <span className="xp-row-text">
                      <span className="xp-desk-name">Protect the file with a passphrase</span>
                      <span className="xp-row-note">Optional. Nobody can open the file without it, so it's safe to keep or move.</span>
                    </span>
                  </label>
                  {protect && <PassphraseFields pass={pass} onChange={setPass} intro="Choose a passphrase you'll remember. You'll need it each time you open the file." />}
                </div>
              )}
              {saveWay === null ? (
                <p className="xp-text xp-warn" data-testid="export-no-save">This browser can't save a download this size as it arrives. Open this page in a recent Chrome, Edge or Firefox.</p>
              ) : (
                <div className="xp-actions">
                  <button type="button" className="btn primary" disabled={picking || !ready || (protect && canResume() && !passOk(pass))} onClick={() => void start()} data-testid="export-start">
                    Download your data
                  </button>
                </div>
              )}
              {picking && <p className="xp-fine" role="status" data-testid="export-picking">Choose where to save it in the window your browser opened.</p>}
              <p className="xp-fine">It's free, and it doesn't count toward your bandwidth.</p>
            </>
          )}

          {view.kind === 'offer' && (
            <div className="xp-stack" data-testid="export-offer">
              <p className="xp-text">Your last download stopped before it finished.</p>
              {view.meta.totalBytes > 0 && (
                <p className="xp-fine">
                  <span className="xp-nowrap">{formatBytes(view.meta.doneBytes)}</span> of <span className="xp-nowrap">{formatBytes(view.meta.totalBytes)}</span> is already saved, and it carries on from there.
                </p>
              )}
              {view.meta.encrypted && <PassphraseFields pass={pass} onChange={setPass} intro="This download is protected with a passphrase. Type it again to carry on; it isn't kept anywhere." />}
              <div className="xp-actions">
                <button type="button" className="btn primary" disabled={!!view.meta.encrypted && !passOk(pass)} onClick={() => void carryOn(view)} data-testid="export-carry-on">Carry on</button>
                <button type="button" className="btn" onClick={() => void discard()} data-testid="export-discard">Discard</button>
              </div>
            </div>
          )}

          {view.kind === 'saving' && (
            <p className="xp-text" role="status" data-testid="export-saving">Saving your file…</p>
          )}

          {view.kind === 'running' && (
            <>
              <p className="xp-text" role="status">
                {running?.phase === 'finishing' ? 'Finishing…' : inOffice ? 'Copying straight from your desks to this computer. Keep your office open until it’s done.' : 'Copying straight from your desks to this computer. Keep this page open until it’s done.'}
              </p>
              {view.note && <p className="xp-fine">{view.note}</p>}
              {running && running.total > 0 && running.phase === 'running' && (
                <p className="xp-text xp-num" data-testid="export-overall">
                  <span className="xp-nowrap">{formatBytes(running.done)}</span> of <span className="xp-nowrap">{formatBytes(running.total)}</span>
                  {running.timeLeft && <span className="xp-muted"> · {running.timeLeft}</span>}
                </p>
              )}
              {running && running.desks.length > 0 && (
                <ul className="xp-desks xp-progress" aria-label="Progress">
                  {running.desks.map((d) => (
                    <DeskProgress key={d.deskId} d={d} onLeaveOut={running.phase === 'running' ? () => control.current?.leaveOut(d.deskId) : undefined} />
                  ))}
                </ul>
              )}
              <div className="xp-actions">
                <button type="button" className="btn" onClick={() => abort.current?.abort('member')} data-testid="export-stop">Stop</button>
              </div>
            </>
          )}

          {view.kind === 'done' && (
            <div className="xp-stack" data-testid="export-done">
              {view.state.desks.length > 0 && (
                <ul className="xp-desks xp-progress" aria-label="What was copied">
                  {view.state.desks.map((d) => (
                    <DeskProgress key={d.deskId} d={d} />
                  ))}
                </ul>
              )}
              {view.url ? (
                <>
                  <p className="xp-text" role="status">
                    Your data is ready (<span className="xp-nowrap">{formatBytes(view.state.size)}</span>). Save it to your computer.
                  </p>
                  <div className="xp-actions">
                    <a
                      className="btn primary"
                      href={view.url}
                      download={view.name}
                      role="button"
                      onKeyDown={(e) => {
                        // A button answers Space as well as Enter (LS-16).
                        if (e.key === ' ') {
                          e.preventDefault();
                          e.currentTarget.click();
                        }
                      }}
                      data-testid="export-save"
                    >{view.name.endsWith('.enc') ? 'Save the protected file' : 'Save the ZIP'}</a>
                    <button type="button" className="btn" onClick={reset}>Done</button>
                  </div>
                  <p className="xp-fine">A copy stays in this browser's storage until you choose Done.</p>
                </>
              ) : (
                <>
                  <p className="xp-text" role="status">
                    Your data is saved as {view.name} (<span className="xp-nowrap">{formatBytes(view.state.size)}</span>).
                  </p>
                  <div className="xp-actions">
                    <button type="button" className="btn" onClick={reset}>Download again</button>
                  </div>
                </>
              )}
              {view.name.endsWith('.enc') && (
                <p className="xp-fine" data-testid="export-protected">
                  The file is protected with your passphrase, which we never saw and can't recover. To open it, use the small tool in <span className="xp-nowrap">tools/export-decrypt</span> of the Desk app's source: <span className="xp-nowrap">node decrypt.mjs {view.name}</span>.
                </p>
              )}
              <p className="xp-fine">
                The file holds your Browser's saved passwords and sign-ins and your AI keys, so keep it somewhere safe.{' '}
                {view.state.notCopied
                  ? `${formatCount(view.state.notCopied)} ${view.state.notCopied === 1 ? "file couldn't" : "files couldn't"} be copied. manifest.json inside says which, and lists every other file with a fingerprint.`
                  : 'manifest.json inside lists every file with a fingerprint, so you can check nothing changed on the way.'}
              </p>
            </div>
          )}

          {view.kind === 'stopped' && (
            <>
              <p className="xp-text" role="status" data-testid="export-stopped">Stopped. The download wasn't saved.</p>
              <div className="xp-actions">
                <button type="button" className="btn" onClick={reset}>Start again</button>
              </div>
            </>
          )}

          {view.kind === 'failed' && (
            <>
              <p className="xp-text" role="alert" data-testid="export-failed">{view.message}</p>
              <div className="xp-actions">
                <button type="button" className="btn" onClick={reset}>Try again</button>
              </div>
            </>
          )}
        </section>

        {config?.export?.moves === true && desks.status === 'ready' && <MovePanel desks={list} guideUrl={guide} />}
    </>
  );
  if (inOffice) {
    return (
      <div className="xp-column xp-in-office" data-testid="export-panel">
        {body}
      </div>
    );
  }
  return (
    <main className="xp-page" data-testid="export-page">
      <div className="xp-column">{body}</div>
    </main>
  );
}

export default function ExportPage() {
  return <ExportPanel />;
}
