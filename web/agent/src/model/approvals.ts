// S-14's approvals as the member sees them (the Product Designer's spec, `design-drafts/agent-tools/README.md` sections 0 and 1;
// deskd API.md section 18). Pure: the wire's approval in, the card's words out, so a real desk's messages replace the mock's with
// no change above this file.
//
// The card is this app's own template per tool, filled from the payload, which is what the hash binds (section 18: "Build the
// card from your own template per `tool` and use `title` only for a tool you don't know"). The model's words never make the
// card; the agent's own reason, when a desk sends one, is one quoted line labelled as its own. Every string from a payload, a
// target or `before` came from a model, a page or a file: it renders as text, with hidden characters shown (`shown`).
import type { Agent, Approval, Risk } from '../client/types';
import { canonicalJson, payloadChecks } from './proposals';

/** The four levels a member reads (spec section 0). The desk's seven risks fold into them. */
export type Level = 'read' | 'change' | 'send' | 'spend';

export const LEVEL_WORDS: Record<Level, string> = {
  read: 'Only reads',
  change: 'Changes your desk',
  send: 'Sends outside your desk',
  spend: 'Spends money',
};

export type LevelIcon = 'eye' | 'pencil' | 'out' | 'coin';
export const LEVEL_ICON: Record<Level, LevelIcon> = { read: 'eye', change: 'pencil', send: 'out', spend: 'coin' };

/** `write`, `delete` and `own` change the desk; `send` and `egress` leave it; `spend` spends. Unknown reads as a change, never less. */
export function levelOf(risk: Risk | string | null | undefined): Level {
  if (risk === 'read') return 'read';
  if (risk === 'send' || risk === 'egress') return 'send';
  if (risk === 'spend') return 'spend';
  return 'change';
}

/** Send and Spend get the warn chip, the card's edge and Activity's dot (taste call 1, B). */
export const isWarnLevel = (l: Level): boolean => l === 'send' || l === 'spend';

/** Why a card asks, which picks its note line (spec section 1.2). */
export type Why = 'taint' | 'taint_memory' | 'send' | 'change' | 'spend';

export function whyOf(a: Pick<Approval, 'risk' | 'untrusted'>): Why {
  if (a.risk === 'own') return 'taint_memory';
  const level = levelOf(a.risk);
  if (level === 'spend') return 'spend';
  // The desk raises a Browser call to `egress` when the run holds untrusted content and the member's data (the Rule of Two).
  if (a.risk === 'egress' && a.untrusted) return 'taint';
  if (level === 'send') return 'send';
  return 'change';
}

/** Approve ignores a press for this long after the card renders, its payload changes or the window regains focus (spec 1.8). */
export const ARM_MS = 500;

// ------------------------------------------------------------------ untrusted text

const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]/gu;

/**
 * Untrusted text as it will run, with nothing hidden: a bidi override, a zero-width or a control character shows as its code
 * point, so a card can't read one way and run another (Security's read of section 18: the card shows what will actually run).
 * New lines and tabs stay.
 */
export function shown(text: string): string {
  return text.replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const quote = (v: string): string => `“${v}”`;

/** An address's host, or the text itself when it isn't one. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? address;
  }
}

/** For Activity and the strip: an address is its host and path, without its query (the full address stays on the card). */
export function shortAddress(address: string): string {
  try {
    const u = new URL(address);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return address;
  }
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

// ------------------------------------------------------------------ the templates

/** One row of a card's details. `long` folds past 120 characters, as a proposal's rows do; `mono` is an address or a path. */
export interface CardField {
  label: string;
  value: string;
  mono?: boolean;
  long?: boolean;
}

type P = Record<string, unknown>;

interface ToolWords {
  app: string;
  /** The Tool row: "Browser · Open a page". */
  name: string;
  /** The strip's label while it runs, when the desk doesn't send its own. */
  doing: string;
  /** Activity and the thread's chip, after: "Opened a web page". */
  done: string;
  /** Activity's "Wanted to …" and "Declined: …": the tool's verb phrase, lower case. */
  asked: string;
  /** The card's title, in the imperative, with its target, from the payload. */
  title: (p: P, a: Pick<Approval, 'before' | 'target'>) => string;
  /** Under an approved card: "Opening a page on shop.example.com", then "Opened a page on shop.example.com". */
  running?: (p: P, a: Pick<Approval, 'before' | 'target'>) => string;
  finished?: (p: P, a: Pick<Approval, 'before' | 'target'>) => string;
  fields: (p: P, a: Pick<Approval, 'before' | 'target'>) => CardField[];
  /**
   * The way back, for a change: a sentence; null for one that can't be undone ("This can’t be undone."); absent says nothing,
   * as for a new file, which the member can simply delete.
   */
  undo?: (p: P) => string | null | undefined;
}

const pageTitle = (a: Pick<Approval, 'before' | 'target'>): string | null => str(a.before?.['title']) ?? (a.target?.kind === 'page' ? a.target.title : null);
const elementName = (p: P): string => {
  const label = str(p['label']);
  const role = str(p['role']);
  return label ? `${quote(label)}${role ? ` (${role})` : ''}` : (role ?? 'something');
};

function readOnly(app: string, name: string, doing: string, done: string, asked: string): ToolWords {
  return { app, name, doing, done, asked, title: () => name, fields: () => [] };
}

/** The launch tools that can ask (API.md section 18, "Payloads by tool"), and the memory runner's. */
const TOOLS: Record<string, ToolWords> = {
  files_write: {
    app: 'Files',
    name: 'Save a file',
    doing: 'Saving a file',
    done: 'Saved a file',
    asked: 'save a file',
    title: (p) => (p['replace'] === true ? `Replace ${quote(str(p['path']) ?? '')} in your Files` : `Save ${quote(str(p['path']) ?? '')} in your Files`),
    fields: (p, a) => {
      const rows: CardField[] = [{ label: 'File', value: str(p['path']) ?? '', mono: true }];
      const bytes = Number(a.before?.['bytes']);
      if (p['replace'] === true) rows.push({ label: 'Replaces', value: Number.isFinite(bytes) ? `The file there now (${bytesWords(bytes)})` : 'The file there now' });
      rows.push({ label: 'Text', value: str(p['text']) ?? '', long: true });
      return rows;
    },
    undo: (p) => (p['replace'] === true ? null : undefined),
  },
  files_mkdir: {
    app: 'Files',
    name: 'Make a folder',
    doing: 'Making a folder',
    done: 'Made a folder',
    asked: 'make a folder',
    title: (p) => `Make the folder ${quote(str(p['path']) ?? '')} in your Files`,
    fields: (p) => [{ label: 'Folder', value: str(p['path']) ?? '', mono: true }],
  },
  files_move: {
    app: 'Files',
    name: 'Move a file',
    doing: 'Moving a file',
    done: 'Moved a file',
    asked: 'move a file',
    title: (p) => `Move ${quote(str(p['from']) ?? '')} to ${quote(str(p['to']) ?? '')}`,
    fields: (p) => [
      { label: 'From', value: str(p['from']) ?? '', mono: true },
      { label: 'To', value: str(p['to']) ?? '', mono: true },
    ],
  },
  files_trash: {
    app: 'Files',
    name: 'Move a file to Trash',
    doing: 'Moving a file to Trash',
    done: 'Moved a file to Trash',
    asked: 'move a file to Trash',
    title: (p) => `Move ${quote(str(p['path']) ?? '')} to Trash`,
    fields: (p, a) => {
      const rows: CardField[] = [{ label: 'File', value: str(p['path']) ?? '', mono: true }];
      const bytes = Number(a.before?.['bytes']);
      if (a.before?.['dir'] === true) rows.push({ label: 'Holds', value: 'A folder, with everything in it' });
      else if (Number.isFinite(bytes)) rows.push({ label: 'Size', value: bytesWords(bytes) });
      return rows;
    },
    undo: () => 'You can bring it back from the Trash in Files.',
  },
  notebook_write: {
    app: 'Notebook',
    name: 'Write in a page',
    doing: 'Writing in a page',
    done: 'Changed a note',
    asked: 'change a note',
    title: (p, a) => {
      const op = str(p['op']);
      const made = p['new'] && typeof p['new'] === 'object' ? str((p['new'] as P)['title']) : null;
      if (op === 'create') return `Make the page ${quote(made ?? 'Untitled')} in Notebook`;
      const title = pageTitle(a) ?? 'a page';
      return op === 'replace_text' ? `Change text in ${quote(title)}` : `Add to ${quote(title)}`;
    },
    fields: (p, a) => {
      const op = str(p['op']);
      const rows: CardField[] = [];
      if (op !== 'create') rows.push({ label: 'Page', value: pageTitle(a) ?? '(untitled)' });
      if (op === 'replace_text') rows.push({ label: 'Find', value: str(p['find']) ?? '', long: true });
      rows.push({ label: op === 'replace_text' ? 'Replace with' : 'Text', value: str(p['markdown']) ?? '', long: true });
      return rows;
    },
    undo: (p) => (str(p['op']) === 'replace_text' ? null : undefined),
  },
  notebook_trash: {
    app: 'Notebook',
    name: 'Move a page to Trash',
    doing: 'Moving a page to Trash',
    done: 'Moved a page to Trash',
    asked: 'move a page to Trash',
    title: (_p, a) => `Move ${quote(pageTitle(a) ?? 'a page')} to Trash`,
    fields: (_p, a) => [{ label: 'Page', value: pageTitle(a) ?? '(untitled)' }],
    undo: () => 'You can bring it back from Notebook’s Trash.',
  },
  browser_open: {
    app: 'Browser',
    name: 'Open a page',
    doing: 'Opening a page',
    done: 'Opened a web page',
    asked: 'open a web page',
    title: (p) => `Open a page on ${hostOf(str(p['url']) ?? '')}`,
    running: (p) => `Opening a page on ${hostOf(str(p['url']) ?? '')}`,
    finished: (p) => `Opened a page on ${hostOf(str(p['url']) ?? '')}`,
    fields: (p) => [{ label: 'Address', value: str(p['url']) ?? '', mono: true }],
  },
  browser_click: {
    app: 'Browser',
    name: 'Click',
    doing: 'Clicking on a page',
    done: 'Clicked on a page',
    asked: 'click on a page',
    title: (p) => `Click ${elementName(p)} on ${hostOf(str(p['origin']) ?? '')}`,
    fields: (p) => [
      { label: 'What', value: elementName(p) },
      { label: 'Site', value: str(p['origin']) ?? '', mono: true },
    ],
  },
  browser_press: {
    app: 'Browser',
    name: 'Press a key',
    doing: 'Pressing a key',
    done: 'Pressed a key on a page',
    asked: 'press a key on a page',
    title: (p) => `Press ${str(p['key']) ?? 'a key'} in ${elementName(p)} on ${hostOf(str(p['origin']) ?? '')}`,
    fields: (p) => [
      { label: 'Key', value: str(p['key']) ?? '', mono: true },
      { label: 'In', value: elementName(p) },
      { label: 'Site', value: str(p['origin']) ?? '', mono: true },
    ],
  },
  browser_type: {
    app: 'Browser',
    name: 'Type',
    doing: 'Typing on a page',
    done: 'Typed on a page',
    asked: 'type on a page',
    title: (p) => `Type into ${elementName(p)} on ${hostOf(str(p['origin']) ?? '')}`,
    fields: (p) => [
      { label: 'Into', value: elementName(p) },
      { label: 'Text', value: str(p['text']) ?? '', mono: true, long: true },
      { label: 'Site', value: str(p['origin']) ?? '', mono: true },
    ],
  },
  browser_use_my_session: {
    app: 'Browser',
    name: 'Use your signed-in session',
    doing: 'Using your signed-in session',
    done: 'Used your signed-in session',
    asked: 'use your signed-in session',
    title: (p) => `Use your signed-in session on ${str(p['site']) ?? 'a site'}`,
    fields: (p) => [
      { label: 'Site', value: str(p['site']) ?? '', mono: true },
      { label: 'For', value: 'This task only. Every click and every word typed there asks you again.' },
    ],
  },
  follow_up: {
    app: 'Agent',
    name: 'Set a follow-up',
    doing: 'Setting a follow-up',
    done: 'Set a follow-up',
    asked: 'set a follow-up',
    title: (p) => `Come back to this ${futureWhen(Number(p['at']))}`,
    fields: (p) => [
      { label: 'When', value: futureWhen(Number(p['at'])) },
      { label: 'It asks', value: str(p['prompt']) ?? '', long: true },
    ],
  },
  memory_save: {
    app: 'Memory',
    name: 'Save a memory',
    doing: 'Saving a memory',
    done: 'Saved a memory',
    asked: 'save a memory',
    title: () => 'Remember this',
    fields: (p) => [{ label: 'Memory', value: str(p['text']) ?? canonicalJson(p) }],
    undo: () => 'You can delete it in Memory.',
  },
  browser_back: {
    app: 'Browser',
    name: 'Go back a page',
    doing: 'Going back a page',
    done: 'Went back a page',
    asked: 'go back a page',
    title: () => 'Go back a page',
    // The payload is the tab alone; the site it's on is what the desk read, shown as context.
    fields: (_p, a) => (a.target?.kind === 'site' && a.target.origin ? [{ label: 'Now on', value: a.target.origin, mono: true }] : []),
  },
  // Calls that only read never ask, so they have no card: their words are for chips, the strip and Activity
  // (deskd API.md section 18, "The tools").
  browser_read: readOnly('Browser', 'Read a page', 'Reading a web page', 'Read a web page', 'read a web page'),
  browser_tabs: readOnly('Browser', 'List its tabs', 'Looking at its tabs', 'Looked at its tabs', 'look at its tabs'),
  browser_close: readOnly('Browser', 'Close a tab', 'Closing a tab', 'Closed a tab', 'close a tab'),
  files_list: readOnly('Files', 'List a folder', 'Listing a folder', 'Listed a folder', 'list a folder'),
  files_search: readOnly('Files', 'Search', 'Searching your Files', 'Searched your Files', 'search your Files'),
  // The agent's own, which never ask.
  plan_update: readOnly('Agent', 'Update its checklist', 'Updating its checklist', 'Updated its checklist', 'update its checklist'),
  workspace_delete: readOnly('Agent', 'Delete from its workspace', 'Deleting from its workspace', 'Deleted from its workspace', 'delete from its workspace'),
  notebook_read: readOnly('Notebook', 'Read a note', 'Reading your note', 'Read your note', 'read a note'),
  notebook_search: readOnly('Notebook', 'Search', 'Searching your Notebook', 'Searched your Notebook', 'search your Notebook'),
  files_read: readOnly('Files', 'Read a file', 'Reading a file', 'Read a file', 'read a file'),
  memory_forget: {
    app: 'Memory',
    name: 'Forget a memory',
    doing: 'Forgetting a memory',
    done: 'Forgot a memory',
    asked: 'forget a memory',
    title: () => 'Forget a memory',
    fields: () => [],
  },
};

/** The tools that only read, which never ask. */
export const READ_TOOLS: ReadonlySet<string> = new Set(['browser_read', 'browser_tabs', 'browser_close', 'notebook_read', 'notebook_search', 'files_read', 'files_list', 'files_search']);

/** The tool's words, where this app knows the tool. */
export function toolWords(tool: string): ToolWords | null {
  return TOOLS[tool] ?? null;
}

/** Activity's and the chips' past tense, where the desk sent none: the template's, else a plain fallback. */
export function doneWord(tool: string): string {
  return TOOLS[tool]?.done ?? 'Used a tool';
}

export function askedWord(tool: string): string {
  return TOOLS[tool]?.asked ?? 'use a tool';
}

export function doingWord(tool: string): string {
  return TOOLS[tool]?.doing ?? 'Using a tool';
}

function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A time ahead: "14:12", "14:12 tomorrow", "Nov 12, 14:12". */
export function futureWhen(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at)) return 'later';
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at < start + 86_400_000) return hm;
  if (at < start + 2 * 86_400_000) return `${hm} tomorrow`;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${hm}`;
}

// ------------------------------------------------------------------ the card

export interface Leaves {
  host: string;
  parts: { name: string; value: string }[];
}

/** What an address tells the site it goes to: each part of its query, decoded. Null for no query, or not an address. */
export function leavesOf(address: string): Leaves | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  const parts = [...u.searchParams.entries()].map(([name, value]) => ({ name: shown(name), value: shown(value) }));
  return parts.length ? { host: u.host, parts } : null;
}

export interface CardView {
  level: Level;
  why: Why;
  /** The chip's words. */
  chip: string;
  title: string;
  /** "Asked while answering Writer", "From the timer Morning brief", or null for the member's own run. */
  stamp: string | null;
  fields: CardField[];
  leaves: Leaves | null;
  /** The note line, by why it asks; null for Spend, whose foot says it. */
  note: { icon: LevelIcon | 'undo'; text: string } | null;
  /** The draft ADR's warning, on an untrusted card whose note doesn't already say why (section 6). */
  untrustedLine: string | null;
  /** The agent's own words, when the desk sends them (not in section 18 yet). */
  reason: string | null;
  /** Spend's amount, for "Approve $0.32". */
  cost: string | null;
  /** For announcements and the declined line: the title, lower case. */
  asked: string;
  /** Under an approved card. */
  running: string;
  finished: string;
  /** The desk didn't send the payload (over 32 KiB): fetch it before offering Approve. */
  needsPayload: boolean;
}

const STAMP_MAX = 60;

export function originStamp(a: Pick<Approval, 'origin'>, agents: readonly Pick<Agent, 'id' | 'name'>[]): string | null {
  const o = a.origin;
  if (!o || o.kind === 'member') return null;
  if (o.kind === 'timer') return `From the timer ${shown(o.label || 'unnamed').slice(0, STAMP_MAX)}`;
  const name = agents.find((x) => x.id === o.agentId)?.name ?? o.name ?? 'another agent';
  return `Asked while answering ${shown(name).slice(0, STAMP_MAX)}`;
}

export const NOTE_TEXT: Record<Exclude<Why, 'change' | 'spend'>, string> = {
  taint: 'It asks because this task has read your notes and pages from other sites, and an address can carry what it read.',
  taint_memory: 'It asks because this task read a web page, and a page can try to plant a memory.',
  send: 'Once it leaves your desk, it can’t be taken back.',
};
export const CANT_UNDO = 'This can’t be undone.';
/** The draft ADR's line for an untrusted run (section 6), where the note doesn't say it already. */
export const UNTRUSTED_LINE = 'This agent has read web pages, files or messages in this task.';

/** The card's words for an approval, from this app's template for its tool. */
export function cardOf(a: Approval, agents: readonly Pick<Agent, 'id' | 'name'>[]): CardView {
  const level = levelOf(a.risk);
  const why = whyOf(a);
  const words = toolWords(a.tool);
  const payload = (a.payload ?? {}) as P;
  const ctx = { before: a.before, target: a.target };
  let title: string;
  let fields: CardField[];
  if (words) {
    title = shown(words.title(payload, ctx));
    fields = [{ label: 'Tool', value: `${words.app} · ${words.name}` }, ...words.fields(payload, ctx).map((f) => ({ ...f, value: shown(f.value) }))];
  } else {
    // A tool this app doesn't know: the desk's title, and every field of the payload as it is.
    title = shown(a.title || 'Use a tool');
    fields = [
      { label: 'Tool', value: shown(a.tool) },
      ...Object.keys(payload)
        .sort()
        .map((k) => {
          const v = payload[k];
          return { label: shown(k), value: shown(typeof v === 'string' ? v : canonicalJson(v)), long: true };
        }),
    ];
  }
  // The member's signed-in session is part of what runs (the hash covers `context`), so the card says so.
  if (a.context.startsWith('member:')) fields.push({ label: 'Uses', value: `Your signed-in session on ${shown(a.context.slice('member:'.length))}` });
  const url = a.tool === 'browser_open' ? str(payload['url']) : null;
  let note: CardView['note'] = null;
  if (why === 'taint' || why === 'taint_memory') note = { icon: 'eye', text: NOTE_TEXT[why] };
  else if (why === 'send') note = { icon: 'out', text: NOTE_TEXT.send };
  else if (why === 'change') {
    // A sentence is the way back; null can't be undone; nothing said (a new file, a new folder) draws no line.
    const undo = words ? words.undo?.(payload) : null;
    if (typeof undo === 'string') note = { icon: 'undo', text: undo };
    else if (undo === null || a.risk === 'delete') note = { icon: 'pencil', text: CANT_UNDO };
  }
  const asked = lowerFirst(title);
  return {
    level,
    why,
    chip: LEVEL_WORDS[level],
    title,
    stamp: originStamp(a, agents),
    fields,
    leaves: url ? leavesOf(url) : null,
    note,
    untrustedLine: a.untrusted && why !== 'taint' && why !== 'taint_memory' ? UNTRUSTED_LINE : null,
    reason: a.reason ? shown(a.reason).slice(0, 300) : null,
    cost: a.cost && Number.isFinite(a.cost.microUsd) ? `$${(a.cost.microUsd / 1_000_000).toFixed(2)}` : null,
    asked,
    running: words?.running ? shown(words.running(payload, ctx)) : (words?.doing ?? 'Doing it'),
    finished: words?.finished ? shown(words.finished(payload, ctx)) : (words?.done ?? 'Done'),
    needsPayload: !a.payload || a.payloadOmitted === true,
  };
}

/**
 * The card hashes what it shows (section 18, Security's read): `{v: 1, agentId, runId, tool, context, payload}`'s canonical JSON
 * must be its `sha256`. A card that doesn't match offers no Approve. No payload (left out over 32 KiB) is no match, until it's fetched.
 */
export function approvalChecks(a: Approval): Promise<boolean> {
  if (!a.payload || a.payloadOmitted) return Promise.resolve(false);
  return payloadChecks({ v: 1, agentId: a.agentId, runId: a.runId, tool: a.tool, context: a.context, payload: a.payload }, a.sha256);
}

/** Waiting, and not past its time. A card left open past `expiresAt` says so by itself. */
export const approvalOpen = (a: Pick<Approval, 'state' | 'expiresAt'>, now: number): boolean => a.state === 'pending' && a.expiresAt > now;

/** The waiting card's foot (spec 1.2). */
export function answerByText(expiresAt: number, now: number, level: Level): string {
  const tail = level === 'spend' ? 'Nothing is spent until you do.' : 'Nothing happens until you do.';
  const left = expiresAt - now;
  if (left < 60 * 60_000) return `Answer within ${Math.max(1, Math.ceil(left / 60_000))} min. ${tail}`;
  return `Answer by ${futureWhen(expiresAt, now)}. ${tail}`;
}

/** "Done in 2 s", "Done in 1:05". */
export function tookWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : elapsed(s * 1000);
}

/** A running time: "0:42", "12:05", then "1 h 4 min". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 3600) return `${Math.floor(total / 3600)} h ${Math.floor((total % 3600) / 60)} min`;
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** The desk's word for why an approved call didn't finish, in the member's words. */
export function failedWords(error: string | null | undefined): string {
  switch (error) {
    case 'changed':
      return 'It had changed since you approved, so it wasn’t done.';
    case 'gone':
      return 'It wasn’t there any more.';
    case 'off_site':
      return 'The page tried to go to another site, so it was stopped there.';
    case 'exists':
      return 'Something with that name is there already.';
    case 'no_space':
      return 'Your desk has no room for it.';
    case 'timeout':
      return 'The site didn’t answer in time.';
    default:
      return 'Your desk couldn’t do it.';
  }
}

/** An answered card's line (spec 1.7). `kind` picks its icon. */
export interface StateView {
  kind: 'approved' | 'declined' | 'expired' | 'not_needed';
  /** "Approved by you", "Declined by you", "Not answered", "Not needed now". */
  head: string;
  /** After the head: the time, then how it went. */
  meta: string[];
  /** `failed` draws its word in the error color. */
  result: 'running' | 'done' | 'failed' | 'stopped' | null;
  sub: string | null;
  note: string | null;
}

const hourWords = (ms: number): string => {
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return h === 1 ? '1 hour passed' : `${h} hours passed`;
};

export function stateOf(a: Approval, view: Pick<CardView, 'title' | 'running' | 'finished'>, agentName: string, now: number, when: (at: number) => string): StateView | null {
  const at = a.decidedAt ? when(a.decidedAt) : null;
  const approvedMeta = (rest: string): string[] => (at ? [at, rest] : [rest]);
  switch (a.state) {
    case 'pending':
      if (a.expiresAt > now) return null;
      return { kind: 'expired', head: 'Not answered', meta: [hourWords(a.expiresAt - a.createdAt)], result: null, sub: `Nothing was done. ${agentName} was told no one answered.`, note: null };
    case 'approved':
      return { kind: 'approved', head: 'Approved by you', meta: approvedMeta('Running'), result: 'running', sub: view.running, note: null };
    case 'done': {
      const took = a.result?.durationMs;
      return { kind: 'approved', head: 'Approved by you', meta: approvedMeta(typeof took === 'number' ? `Done in ${tookWords(took)}` : 'Done'), result: 'done', sub: view.finished, note: null };
    }
    case 'failed':
      return { kind: 'approved', head: 'Approved by you', meta: approvedMeta('Didn’t finish'), result: 'failed', sub: failedWords(a.result?.error), note: null };
    case 'interrupted':
      return { kind: 'approved', head: 'Approved by you', meta: approvedMeta('Didn’t finish'), result: 'failed', sub: `${agentName} restarted while doing this. It may have happened: check it before you ask again.`, note: null };
    case 'declined':
      return {
        kind: 'declined',
        head: 'Declined by you',
        meta: at ? [at] : [],
        result: null,
        sub: `${view.title}. ${agentName} was told not to do it, or try another way, unless you ask.`,
        note: a.note ? `Your note: ${shown(a.note)}` : null,
      };
    case 'expired':
      if (a.detail === 'timeout' || !a.detail) return { kind: 'expired', head: 'Not answered', meta: [hourWords(a.expiresAt - a.createdAt)], result: null, sub: `Nothing was done. ${agentName} was told no one answered.`, note: null };
      if (a.detail === 'stopped') return { kind: 'not_needed', head: 'Not needed now', meta: [], result: null, sub: 'You stopped this task, so nothing was done.', note: null };
      if (a.detail === 'restart') return { kind: 'not_needed', head: 'Not needed now', meta: [], result: null, sub: `${agentName} restarted, so nothing was done.`, note: null };
      return { kind: 'not_needed', head: 'Not needed now', meta: [], result: null, sub: 'Nothing was done.', note: null };
    default:
      return null;
  }
}

/** What the polite status says when a card arrives (spec 1.8). */
export const arrivedText = (agentName: string, asked: string): string => `${agentName} is asking to ${asked}. It’s in the thread.`;

/** A decision the desk refused, in words (spec 1.7). */
export function decideErrorText(err: { code?: string; reason?: string | null; detail?: string | null } | null, agentName: string): string {
  if (err?.code === 'conflict' && err.reason === 'expired') return 'This expired before your answer reached the desk, so nothing was done.';
  if (err?.code === 'conflict') return 'This was already answered. The card shows how.';
  if (err?.code === 'bad_request' && err.detail === 'sha256') return mismatchText(agentName);
  if (err?.code === 'forbidden') return 'Only the desk’s owner can answer this.';
  return 'The desk couldn’t take your answer just now. Try again.';
}

export const mismatchText = (agentName: string): string => `This card doesn’t match what ${agentName} asked for, so it can’t be approved here. Ask ${agentName} again.`;

/** "1 request waiting", "3 requests waiting". */
export const waitingText = (n: number): string => `${n} ${n === 1 ? 'request' : 'requests'} waiting`;

/** The rail's count's name: "1 request waiting, 2 new replies". */
export function countLabel(waiting: number, unseen: number): string {
  const parts: string[] = [];
  if (waiting > 0) parts.push(waitingText(waiting));
  if (unseen > 0) parts.push(`${unseen} new ${unseen === 1 ? 'reply' : 'replies'}`);
  return parts.join(', ');
}

/**
 * An agent as the app reads it: a desk's `approvalsPending` (section 18, which says `working` with `awaiting_approval`) is the
 * app's `needs_you`. The same object back when nothing changes, so a render costs nothing.
 */
export function withApprovals(a: Agent): Agent {
  const waiting = a.approvalsPending ?? 0;
  if (waiting > 0 && a.status !== 'needs_you' && a.status !== 'paused') return { ...a, status: 'needs_you' };
  return a;
}

// ------------------------------------------------------------------ what the agent is told (the desk's words; the mock's)

/** Spec 1.3: the tool's result the model reads. The desk writes these; the mock uses them. */
export const TOLD = {
  declined: (asked: string): string => `The member declined this: ${asked}. Don't do it, and don't try another way to get the same result, unless they ask you to.`,
  note: (note: string): string => `Their note: "${note}"`,
  expired: 'No one answered within 24 hours, so this wasn\'t done. Don\'t try it again unless the member asks.',
  stopped: 'The member stopped this before it finished. Don\'t start it again unless they ask.',
} as const;

/**
 * Security's read of section 18: low-bandwidth leaks (which link, when) are a residual of approving each send, so a Send card says
 * how many times this task has already sent something outside the desk (the reply's `egressCount`).
 */
export function egressText(n: number): string {
  return n === 1 ? 'This task has already sent something outside your desk once.' : `This task has already sent something outside your desk ${n} times.`;
}
