// What goes in the archive and under which names (draft ADR "data export and transfer", decision 2). Pure but for
// the README's line for the Agent, so the layout is tested on its own.
import { currentBand } from '../platform/age';
import { SUPPORT_ADDRESS } from '../platform/clientConfig';

/** The parts' friendly names, as the guide says them. An unknown part keeps its directory name. */
const PART_LABELS: Record<string, string> = {
  browser: 'Browser',
  'browser-readable': 'Browser, readable',
  desk: 'Desk settings, Notebook and Chat',
  agent: 'Agent',
  apps: 'Apps',
  files: 'Files',
};
export const partLabel = (part: string, given?: string): string => PART_LABELS[part] ?? (given || part);

const pad = (n: number): string => String(n).padStart(2, '0');
/** `minimalist-alliance-export-YYYY-MM-DD.zip`, by the member's own calendar. */
export const exportFileName = (d: Date): string => `minimalist-alliance-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A desk's name as a folder every computer can make: no separators or characters Windows refuses, not too long. */
export function folderName(name: string, fallback: string): string {
  let s = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if ([...s].length > 64) s = [...s].slice(0, 64).join('').trim();
  if (!s || s === '.' || s === '..') s = fallback;
  return RESERVED.test(s) ? `${s} desk` : s;
}

/** One folder per desk, and two desks with one name get two folders. */
export function deskFolders(desks: readonly { deskId: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const d of desks) {
    const base = folderName(d.name, d.deskId);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    out.set(d.deskId, name);
  }
  return out;
}

/**
 * A path from the desk, if an archive can hold it safely: relative, `/`-separated, with no empty, `.` or `..` part,
 * no backslash and no NUL, so nothing in it can climb out of its folder when it's unpacked. Null otherwise.
 */
export function safePath(path: string): string | null {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  return path.split('/').every((c) => c !== '' && c !== '.' && c !== '..') ? path : null;
}

/** The order an unzip lists things in: the README, the manifest, the account, then the desks. */
export function archiveOrder(a: string, b: string): number {
  const rank = (n: string): number => (n === 'README.txt' ? 0 : n === 'manifest.json' ? 1 : n.startsWith('account/') ? 2 : n.startsWith('desks/') ? 3 : 4);
  return rank(a) - rank(b);
}

/**
 * More of the account, when `GET /v1/me/export` holds it (ma-platform contract desks.md 0.3.43, EXP-4): each is its own
 * file under `account/`, only if the answer has it. `activity` and `signInFactors` are inside `account` there, and
 * move out to their own files so `account.json` stays short and each can be read alone.
 */
const EXTRA_ACCOUNT_FILES: { from: 'top' | 'account'; key: string; file: string; says: string }[] = [
  { from: 'top', key: 'maiaChats', file: 'account/maia-chats.json', says: 'Your conversations with Maia, the assistant, from the last 30 days.' },
  { from: 'account', key: 'activity', file: 'account/activity-log.json', says: 'What your account recorded: sign-outs, changes to how you sign in, and the like.' },
  { from: 'top', key: 'supportTickets', file: 'account/support-tickets.json', says: 'Your conversations with support.' },
  { from: 'account', key: 'signInFactors', file: 'account/sign-in-factors.json', says: 'How you sign in, including the phone number you use for codes, if any.' },
];

/** `GET /v1/me/export` as the files of `account/` (ma-platform draft, section 2): five always, and more when it has them. A missing field is `null`. */
export function accountFiles(exp: unknown): [string, string][] {
  const o = (exp && typeof exp === 'object' ? exp : {}) as Record<string, unknown>;
  const json = (v: unknown): string => `${JSON.stringify(v ?? null, null, 2)}\n`;
  const account = o['account'] && typeof o['account'] === 'object' && !Array.isArray(o['account']) ? (o['account'] as Record<string, unknown>) : null;
  const moved = new Set(EXTRA_ACCOUNT_FILES.filter((x) => x.from === 'account' && account && x.key in account).map((x) => x.key));
  const rest = account ? Object.fromEntries(Object.entries(account).filter(([k]) => !moved.has(k))) : o['account'];
  return [
    ['account/account.json', json(rest)],
    ['account/membership.json', json(o['membership'])],
    ['account/billing-history.json', json(o['billingHistory'])],
    ['account/maia-memories.json', json(o['maiaMemories'])],
    ['account/desks.json', json(o['desks'])],
    ...EXTRA_ACCOUNT_FILES.flatMap((x): [string, string][] => {
      const src = x.from === 'top' ? o : account;
      return src && x.key in src ? [[x.file, json(src[x.key])]] : [];
    }),
  ];
}

export interface ReadmeInput {
  madeAt: Date;
  desks: readonly string[];
  notCopied: number;
  /** A line for each desk that couldn't give everything, such as "Work: the download isn't available on this desk yet." */
  incomplete?: readonly string[];
  /** The account files in this archive, so the README lists the extra ones that came. */
  accountNames?: readonly string[];
  /** The download was protected with a passphrase: README.txt, inside, says how that file is built and opened. */
  encrypted?: boolean;
}

/** README.txt: calm, plain and short. */
export function readme({ madeAt, desks, notCopied, incomplete = [], accountNames = [], encrypted = false }: ReadmeInput): string {
  const day = madeAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const from = desks.length ? `your account and ${desks.length === 1 ? 'this desk' : 'these desks'}: ${desks.join(', ')}` : 'your account';
  const teen = currentBand() === 'teen'; // a teen has no Agent, so no agent/ and no keys
  const lines = [
    'Your Minimalist Alliance data',
    '',
    `Made on ${day}, from ${from}.`,
    '',
    'Your desks sent their files straight to you, encrypted. If your connection needed our relay,',
    "they passed through it still encrypted, and the relay couldn't read them. We keep no copy of",
    'this archive. The account folder is what we hold about you, as your account shows it.',
    '',
    '',
    'WHAT EACH FOLDER HOLDS',
    '',
    'account/',
    '  account.json           Your name, email, how you sign in, and when you joined.',
    '  membership.json        Your membership: its tier, its status and its dates.',
    '  billing-history.json   The charges, refunds and invoices we hold for you.',
    '  maia-memories.json     Everything Maia remembers about you.',
    '  desks.json             Your desks: their names, kinds, and whether each is in the cloud',
    '                         or on your own computer.',
    ...EXTRA_ACCOUNT_FILES.filter((x) => accountNames.includes(x.file)).map((x) => `  ${x.file.slice('account/'.length).padEnd(22)} ${x.says}`),
    '',
    'desks/<desk name>/       One folder for each desk.',
    "  browser/               The Browser's whole profile, exactly as Chromium keeps it.",
    '  browser-readable/      Your bookmarks and history, in files any computer can open.',
    '  desk/                  Desk settings, Notebook and Chat.',
    ...(teen ? [] : ['  agent/                 The Agent.']),
    "  apps/                  Each app's own data.",
    '  files/                 Your files, as they are on the desk.',
    '  Any other folder is a part of the desk, kept under its own name.',
    '',
    '',
    'YOUR BROWSER PROFILE',
    '',
    'Most people need only two files. They are in browser-readable/, in a folder for each',
    'Browser profile (usually Default):',
    '  bookmarks.html   Import it into any browser: look for "Import bookmarks" in its settings.',
    '  history.csv      Open it in any spreadsheet: when you visited, the title and the address,',
    '                   newest first.',
    '',
    'browser/ is the full profile, for Chromium or Google Chrome. To open it as it is, start',
    'Chromium with --user-data-dir set to the profile folder inside it.',
    '',
    'The profile holds your saved passwords and sign-ins, so keep this file somewhere safe,',
    'as you would your own computer.',
    '',
    '',
    // ADR 0042: the sealed keys travel with master.key beside them, so they open anywhere.
    ...(teen
      ? []
      : [
          'YOUR AI KEYS',
          '',
          "agent/keys/ in each desk's folder holds the AI keys you added to that desk, and they work:",
          'anyone with this file can use them. Keep it somewhere safe. If you lose it, revoke those',
          'keys at their provider and add new ones to your desks.',
          '',
          '',
        ]),
    'CHECKING THE FILES',
    '',
    'manifest.json lists every other file in this archive with its size and SHA-256, the desks',
    'they came from, and when the archive was made. Any SHA-256 tool can check a file against it.',
  ];
  if (encrypted) {
    lines.push(
      '',
      '',
      'THE PASSPHRASE',
      '',
      'You protected the download with a passphrase, so the file you saved ended in .zip.enc and',
      'this is the archive inside it. We never saw the passphrase and cannot recover it. Keep it',
      'with the file, or you cannot open the file again.',
      '',
      'To open a .zip.enc file with Node 18 or newer, run: node decrypt.mjs <file>.zip.enc',
      "(tools/export-decrypt/decrypt.mjs in Minimalist Alliance's Desk app source), or write your",
      'own from this description. The file is:',
      '  - 40 header bytes: "MAEXPORT", the format version 1, key derivation 1 (PBKDF2-HMAC-SHA-256),',
      '    cipher 1 (AES-256-GCM), a zero byte, the PBKDF2 iteration count (4 bytes, big-endian), a',
      '    16-byte salt, the record size (4 bytes, big-endian, 1048576) and a 4-byte nonce prefix;',
      '  - then records, back to back. Each is the AES-256-GCM encryption of up to one record size of',
      '    the ZIP, followed by its 16-byte tag. The key is the passphrase (Unicode NFC, as UTF-8)',
      '    run through PBKDF2-HMAC-SHA-256 with the salt, for 32 bytes. The IV is the nonce prefix and',
      "    the record's number (from 0) as 8 big-endian bytes. The additional data is the 40 header",
      "    bytes, the record's number as 8 big-endian bytes, and one byte that is 1 on the last record",
      '    and 0 on the others.',
    );
  }
  if (notCopied > 0) {
    lines.push(
      '',
      `${notCopied === 1 ? "1 file couldn't" : `${notCopied.toLocaleString('en-US')} files couldn't`} be copied, such as a file removed while the download ran.`,
      'manifest.json lists each one under "notCopied".',
    );
  }
  if (incomplete.length) lines.push('', 'Not everything could be copied from every desk:', ...incomplete.map((l) => `  ${l}`));
  lines.push('', '', `Questions: ${SUPPORT_ADDRESS}`, '');
  return lines.join('\n');
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestDesk {
  deskId: string;
  name: string;
  folder: string;
  /** False when the desk couldn't give everything, with `note` saying why. */
  complete: boolean;
  note?: string;
  parts: { part: string; label: string; files: number; bytes: number }[];
}

export interface Manifest {
  format: 1;
  madeAt: string;
  madeBy: string;
  desks: ManifestDesk[];
  files: ManifestFile[];
  links: { path: string; target: string }[];
  notCopied: { path: string; reason: string }[];
}
