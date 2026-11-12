// The mock desk's side of site sign-ins (#11), as deskd API.md section 10 "Signing in" has it, on a small scale: the
// three password managers' list, an installed one's page in a tab of its own (no active member tab while it's on screen),
// a missing one's Web Store page as the member's own tab, and a passwords file's bytes on `bulk` into memory between
// `begin` and `finish`. The file's content is never kept: only its size, how it came (frames and their sizes), and its
// row count, then the buffer is zeroed, as deskd's is. `browser.passwords.count` and `clear` (the spec's Stop, asked of
// the Desk Engineer, not in deskd yet) answer only with `stopServed`, as a deskd that has them would.
import type { BrowserTab, RpcOptions } from './deskLink';
import type { MockBulk } from './mockDeskData';

type Ext = { id: string; name: string; state: 'installed' | 'off' | 'missing'; open: boolean };

export interface MockSignInsControl {
  /** deskd serves #11. Off is a deskd before it: every method is "No such method". */
  serves: boolean;
  /** The list as `browser.extensions.list` answers it, in the allowlist's order. */
  extensions: Ext[];
  /** The member clicked Add on the Web Store page: that one is installed. Nothing tells the office. */
  install(id: string): void;
  /** deskd has the Stop section's count and clear. */
  stopServed: boolean;
  /** Passwords saved in the desk's Chromium, as `browser.passwords.count` says. */
  saved: number;
  /** Each passwords file the desk took: its size, its frames' sizes, the rows it had. Never its content. */
  imports: { size: number; frames: number[]; rows: number; zeroed: boolean }[];
  /** How many rows of a file the desk already has, for `alreadySaved`. */
  alreadySaved: number;
  /** Hold `browser.import.finish`'s answer until `releaseFinish`, to see "Adding…". */
  holdFinish: boolean;
  releaseFinish(): void;
}

const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb';
const ONEPASSWORD = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const PROTON = 'ghmbeldphafepmbegfdlkpapadhbakde';
const MAX = 2 * 1024 * 1024;

const query = new URLSearchParams(window.location.search);
const held: (() => void)[] = [];

type Tabs = { get: () => BrowserTab[]; set: (tabs: BrowserTab[]) => void };
/** The member's tab before an extension's page came to the front. */
let wasActive: string | null = null;

export const signInsControl: MockSignInsControl = {
  serves: query.get('signIns') !== 'old',
  extensions: [
    { id: BITWARDEN, name: 'Bitwarden', state: query.get('signIns') === 'bitwarden' ? 'installed' : 'missing', open: false },
    { id: ONEPASSWORD, name: '1Password', state: 'missing', open: false },
    { id: PROTON, name: 'Proton Pass', state: 'missing', open: false },
  ],
  install: (id) => {
    // Nothing else changes: an install may open no tab, so the office has to ask (`SignIns.watchInstall`).
    signInsControl.extensions = signInsControl.extensions.map((e) => (e.id === id ? { ...e, state: 'installed' } : e));
  },
  stopServed: query.get('signInsStop') === '1',
  saved: 12,
  imports: [],
  alreadySaved: 0,
  holdFinish: false,
  releaseFinish: () => {
    for (const go of held.splice(0)) go();
  },
};

const err = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock sign-ins: ${code}`), { code, details });

/** One file on its way in: deskd's memory-only sink. */
type Upload = { uploadId: string; transferId: number; size: number; buf: Uint8Array; got: number; next: number; frames: number[]; broken: boolean };
const uploads = new Map<string, Upload>();
let uploadSeq = 0;

/** Rows in a CSV with a header that names an address and a password column; null if it isn't one (deskd's `format`). */
function rowsOf(buf: Uint8Array): number | null {
  // The mock reads the file only to count its lines, as deskd's parser would; nothing of it is kept.
  const lines = new TextDecoder().decode(buf).split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = (lines[0] ?? '').toLowerCase();
  if (!/(^|,)"?(url|website|origin|hostname|login_uri)"?(,|$)/.test(head) || !/(^|,)"?(password|login_password)"?(,|$)/.test(head)) return null;
  return lines.length - 1;
}

/** The sign-ins methods, or undefined for any other. */
export function answerSignIns(method: string, params: Record<string, unknown>, options: RpcOptions | undefined, bulk: MockBulk | null, tabsOf: Tabs): Promise<unknown> | undefined {
  if (!method.startsWith('browser.extension') && !method.startsWith('browser.import') && !method.startsWith('browser.passwords.')) return undefined;
  const ctl = signInsControl;
  if (!ctl.serves || (method.startsWith('browser.passwords.') && !ctl.stopServed)) return Promise.reject(err('not_found'));
  const mutation = method !== 'browser.extensions.list' && method !== 'browser.passwords.count';
  if (mutation && !options?.idem) return Promise.reject(err('bad_request'));
  const ext = (): Ext => {
    const id = params['id'];
    const e = ctl.extensions.find((x) => x.id === id);
    if (!e) throw err('forbidden', { reason: 'extension' });
    return e;
  };
  try {
    switch (method) {
      case 'browser.extensions.list':
        return Promise.resolve({ extensions: ctl.extensions.map((e) => ({ ...e })) });
      case 'browser.extension.open': {
        const e = ext();
        if (e.state === 'off') throw err('unavailable', { reason: 'extension_off' });
        const all = tabsOf.get();
        if (e.state === 'missing') {
          const tabId = `store-${e.id.slice(0, 6)}`;
          tabsOf.set([...all.map((t) => ({ ...t, active: false })), { tabId, url: `https://chromewebstore.google.com/detail/${e.id}`, title: `${e.name} - Chrome Web Store`, loading: false, active: true, canGoBack: false, canGoForward: false }]);
          return Promise.resolve({ tabId, page: 'store' });
        }
        // Its page is in a tab browser.tabs never lists, so while it's on screen there's no active member tab.
        if (!e.open) wasActive = all.find((t) => t.active)?.tabId ?? wasActive;
        ctl.extensions = ctl.extensions.map((x) => (x.id === e.id ? { ...x, open: true } : x));
        tabsOf.set(all.map((t) => ({ ...t, active: false })));
        return Promise.resolve({ tabId: `ext-${e.id.slice(0, 6)}`, page: 'extension' });
      }
      case 'browser.extension.close': {
        const e = ext();
        const closed = e.open ? 1 : 0;
        ctl.extensions = ctl.extensions.map((x) => (x.id === e.id ? { ...x, open: false } : x));
        if (closed) {
          const all = tabsOf.get();
          const back = all.find((t) => t.tabId === wasActive) ?? all[0];
          tabsOf.set(all.map((t) => ({ ...t, active: t === back })));
        }
        return Promise.resolve({ closed });
      }
      case 'browser.import': {
        if (params['kind'] === 'passwords') throw err('bad_request', { reason: 'use_upload' });
        throw err('not_found');
      }
      case 'browser.import.begin': {
        const size = params['size'];
        if (params['kind'] !== 'passwords') throw err('bad_request', { reason: 'kind' });
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw err('bad_request', { reason: 'size' });
        if (size > MAX) throw err('too_large', { limit: MAX });
        if (!bulk) throw err('unavailable', {});
        uploadSeq += 1;
        const up: Upload = { uploadId: `up${String(uploadSeq).padStart(20, '0')}`, transferId: bulk.newTransferId(), size, buf: new Uint8Array(size), got: 0, next: 0, frames: [], broken: false };
        uploads.set(up.uploadId, up);
        bulk.attachUpload(up.transferId, (seq, payload) => {
          if (seq !== up.next || up.got + payload.length > size) up.broken = true;
          else {
            up.buf.set(payload, up.got);
            up.got += payload.length;
            up.next += 1;
            up.frames.push(payload.length);
          }
          payload.fill(0);
        });
        return Promise.resolve({ uploadId: up.uploadId, transferId: up.transferId, window: size, size });
      }
      case 'browser.import.finish': {
        const up = uploads.get(params['uploadId'] as string);
        if (!up) throw err('not_found', { reason: 'upload' });
        uploads.delete(up.uploadId);
        bulk?.detachUpload(up.transferId);
        const done = (): unknown => {
          const rows = up.broken || up.got !== up.size ? null : rowsOf(up.buf);
          up.buf.fill(0);
          ctl.imports.push({ size: up.size, frames: up.frames, rows: rows ?? 0, zeroed: up.buf.every((b) => b === 0) });
          if (up.broken || up.got !== up.size) throw err('conflict', { reason: 'incomplete', committed: up.got });
          if (rows === null) throw err('bad_request', { reason: 'format' });
          const already = Math.min(rows, ctl.alreadySaved);
          ctl.saved += rows - already;
          return { kind: 'passwords', found: rows, added: rows - already, alreadySaved: already, refused: 0, notAdded: [] };
        };
        if (!ctl.holdFinish) return Promise.resolve().then(done);
        return new Promise((resolve, reject) => {
          held.push(() => {
            try {
              resolve(done());
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
      }
      case 'browser.import.abort': {
        const up = uploads.get(params['uploadId'] as string);
        if (up) {
          up.buf.fill(0);
          uploads.delete(up.uploadId);
          bulk?.detachUpload(up.transferId);
        }
        return Promise.resolve({});
      }
      case 'browser.passwords.count':
        return Promise.resolve({ saved: ctl.saved });
      case 'browser.passwords.clear': {
        const deleted = ctl.saved;
        ctl.saved = 0;
        return Promise.resolve({ deleted });
      }
      default:
        throw err('not_found');
    }
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
