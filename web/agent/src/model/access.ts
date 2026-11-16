// What an agent may use, as its setup screen and its settings show it (draft ADR "the Agent's tools and approvals", sections
// 14 to 16; deskd API.md section 18). Pure: the wire's `access` in, the screen's rows, its draft and the change to send out.
// The words are drafts for the Sales Engineer, from the ADR's section 16; the Product Designer lays the screen out.
import type { AccessApps, AccessChange, AgentAccess, SetupReason } from '../client/types';

export type AppName = keyof AccessApps;

/** The screen's order. */
export const APP_ORDER: readonly AppName[] = ['notebook', 'files', 'browser', 'courier', 'todos'];

/** A new agent's screen: everything on but Courier, which is other people's words and the member's private messages at once. */
export const DEFAULT_APPS: AccessApps = { notebook: true, files: true, browser: true, courier: false, todos: true };
/** A guild member's own agent on a Guild Desk: Notebook alone (section 8). */
export const GUILD_APPS: AccessApps = { notebook: true, files: false, browser: false, courier: false, todos: false };

export const APP_WORDS: Record<AppName, { name: string; line: string }> = {
  notebook: { name: 'Notebook', line: 'Read your pages. It asks before adding or changing anything.' },
  files: { name: 'Files', line: 'Read your files. It asks before saving, moving or removing anything.' },
  browser: { name: 'Browser', line: 'Browse the web on its own, signed out. It asks before it uses your sign-ins, sends a form or buys anything.' },
  courier: { name: 'Courier', line: 'Read your messages and email. It can’t send anything.' },
  todos: { name: 'To-dos', line: 'See your list and add to it. It asks first.' },
};

export const setupTitle = (name: string): string => `What can ${name} use?`;
export const setupIntro = (name: string): string =>
  `${name} asks you before it changes, sends or buys anything, unless you say otherwise below. You can change this any time in its settings.`;

/** The line above the rows, for why the screen shows; null for a new agent, which the title says enough for. */
export function reasonLine(reason: SetupReason | null | undefined, name: string): string | null {
  if (reason === 'upgrade') return `This is new. Until now ${name} could use Notebook, Files and Browser. Choose what it uses from here on.`;
  if (reason === 'confirm') return `Your desk needs you to confirm these again before ${name} can work.`;
  return null;
}

/** Where the thread says why the composer waits, after Back. */
export const waitingLine = (name: string): string => `${name} is waiting for you to set it up.`;

export const DESKS_TITLE = 'Other desks';
export const desksLead = (name: string): string => `Let ${name} message agents on your other desks.`;
export const deskLine = (name: string, desk: string): string =>
  `${name} can send what it’s working on to ${desk}, and ${desk}’s agent can answer from what it finds there. It asks first whenever that includes something private. You’ll confirm on ${desk} too.`;
export const deskOffered = (desk: string): string => `Waiting for you to confirm on ${desk}.`;

export const AUTO_TITLE = 'Without asking';
export const autoLead = (name: string): string => `Let ${name} do these without asking. You can undo each one.`;
export const AUTO_ALWAYS =
  'It never deletes, sends, buys, uses your sign-ins or changes what you wrote without asking. After it reads a web page, a file or a message, it asks again for everything except adding to-dos.';
export const AUTO_WORDS = {
  notebook: 'Add pages and notes in one Notebook tab',
  files: 'Save new files in one folder',
  todos: 'Add to-dos, and tick off ones it added',
} as const;
export type AutoName = keyof typeof AUTO_WORDS;

/** The app a switch needs. */
export const AUTO_APP: Record<AutoName, AppName> = { notebook: 'notebook', files: 'files', todos: 'todos' };
export const turnOnFirst = (app: AppName): string => `Turn on ${APP_WORDS[app].name} first`;

/** Where a switch's additions go: a new tab or folder named after the agent, made when the member saves, or one there now. */
export type Place = { kind: 'new'; name: string } | { kind: 'existing'; id: string; label: string };

/** The screen's state while the member chooses. Nothing applies before Save. */
export interface AccessDraft {
  apps: AccessApps;
  auto: { notebook: Place | null; files: Place | null; todos: boolean };
  /** The member's other desks this agent may message, by id: on or off. */
  desks: Record<string, boolean>;
}

/** One of the member's other desks the screen offers, never this one or a Guild Desk. */
export interface OtherDesk {
  deskId: string;
  name: string;
}

/** From the office's desk list: the member's desks but this one, Guild Desks and any they've left. */
export function otherDesksOf(desks: readonly { id: string; name: string; kind: string; removed?: boolean }[], thisDeskId: string | undefined): OtherDesk[] {
  return desks.filter((d) => d.id !== thisDeskId && d.kind !== 'guild' && !d.removed).map((d) => ({ deskId: d.id, name: d.name }));
}

/** A folder named after the agent, as Files takes a name: no slashes, no leading dots, never empty. */
export function folderName(agentName: string): string {
  const cleaned = agentName.replace(/[\\/]+/g, ' ').replace(/^[.\s]+/, '').trim();
  return cleaned || 'Agent';
}

/** The screen's starting point from what the desk holds. Courier, every switch and every desk start off on a new agent's. */
export function draftOf(access: AgentAccess): AccessDraft {
  return {
    apps: { ...access.apps },
    auto: {
      notebook: access.auto.notebook ? { kind: 'existing', id: access.auto.notebook.tabId, label: 'The tab it uses now' } : null,
      files: access.auto.files ? { kind: 'existing', id: access.auto.files.folder, label: access.auto.files.folder } : null,
      todos: access.auto.todos,
    },
    desks: Object.fromEntries(access.desks.filter((d) => d.state !== 'revoked').map((d) => [d.toDeskId, true])),
  };
}

/** A switch with its app off is off: switching an app off takes its switch with it. */
export function withApp(draft: AccessDraft, app: AppName, on: boolean): AccessDraft {
  const apps = { ...draft.apps, [app]: on };
  const auto = { ...draft.auto };
  if (!on) {
    if (app === 'notebook') auto.notebook = null;
    if (app === 'files') auto.files = null;
    if (app === 'todos') auto.todos = false;
  }
  return { ...draft, apps, auto };
}

/** Whether a switch can be on: its app is. */
export const autoAllowed = (draft: AccessDraft, name: AutoName): boolean => draft.apps[AUTO_APP[name]];

/** Places a Save has to make first: a new tab and a new folder. */
export function placesToMake(draft: AccessDraft): { notebook: string | null; files: string | null } {
  return {
    notebook: draft.auto.notebook?.kind === 'new' ? draft.auto.notebook.name : null,
    files: draft.auto.files?.kind === 'new' ? draft.auto.files.name : null,
  };
}

/**
 * The change for `agent.access.set`. The first save (not `chosen`) sends every app and every switch, as the desk requires; a
 * later one only what differs. `made` is the tab id and folder a Save just made for a new place. Desks go by id, with their
 * name for one being switched on.
 */
export function changeOf(access: AgentAccess, draft: AccessDraft, otherDesks: readonly OtherDesk[], made: { notebook?: string; files?: string } = {}): AccessChange {
  const first = !access.chosen;
  const tab = draft.auto.notebook ? (draft.auto.notebook.kind === 'existing' ? draft.auto.notebook.id : made.notebook ?? null) : null;
  const folder = draft.auto.files ? (draft.auto.files.kind === 'existing' ? draft.auto.files.id : made.files ?? null) : null;
  const auto = { notebook: tab ? { tabId: tab } : null, files: folder ? { folder } : null, todos: draft.auto.todos };
  const change: AccessChange = {};
  if (first) {
    change.apps = { ...draft.apps };
    change.auto = auto;
  } else {
    const apps: Partial<AccessApps> = {};
    for (const app of APP_ORDER) if (draft.apps[app] !== access.apps[app]) apps[app] = draft.apps[app];
    if (Object.keys(apps).length) change.apps = apps;
    const autoChange: AccessChange['auto'] = {};
    if ((access.auto.notebook?.tabId ?? null) !== (auto.notebook?.tabId ?? null)) autoChange.notebook = auto.notebook;
    if ((access.auto.files?.folder ?? null) !== (auto.files?.folder ?? null)) autoChange.files = auto.files;
    if (access.auto.todos !== auto.todos) autoChange.todos = auto.todos;
    if (Object.keys(autoChange).length) change.auto = autoChange;
  }
  const held = new Set(access.desks.filter((d) => d.state !== 'revoked').map((d) => d.toDeskId));
  const desks: NonNullable<AccessChange['desks']> = [];
  for (const desk of otherDesks) {
    const on = draft.desks[desk.deskId] === true;
    if (on && !held.has(desk.deskId)) desks.push({ deskId: desk.deskId, deskName: desk.name, on: true });
    if (!on && held.has(desk.deskId)) desks.push({ deskId: desk.deskId, on: false });
  }
  if (desks.length) change.desks = desks;
  return change;
}

/** Whether a later save would change anything. The first save always does: it's what sets the agent up. */
export function hasChanges(access: AgentAccess, draft: AccessDraft, otherDesks: readonly OtherDesk[]): boolean {
  if (!access.chosen) return true;
  const c = changeOf(access, draft, otherDesks, { notebook: 'new', files: 'new' });
  return c.apps !== undefined || c.auto !== undefined || c.desks !== undefined;
}

/** A guild member's own agent: only what a Guild Desk gives it, whatever the desk's record or the draft says. */
export function forGuild(draft: AccessDraft): AccessDraft {
  return { apps: { ...GUILD_APPS, notebook: draft.apps.notebook }, auto: { notebook: null, files: null, todos: false }, desks: {} };
}

/** The desk's refusal of a save, in the member's words. */
export function accessErrorText(reason: string | null | undefined, detail: string | null | undefined): string {
  if (reason === 'app_off' && detail?.startsWith('auto.')) {
    const name = detail.slice(5) as AutoName;
    return name in AUTO_APP ? `${turnOnFirst(AUTO_APP[name])}.` : 'Turn its app on first.';
  }
  if (reason === 'folder') return 'Pick a folder inside your Files, not the top of it or the trash.';
  if (reason === 'name') return 'That desk’s name can’t be used here.';
  if (reason === 'self') return 'An agent messages your other desks, not this one.';
  if (reason === 'guild') return 'A Guild Desk gives its agents Notebook only.';
  return 'This couldn’t be saved just now. Try again.';
}
