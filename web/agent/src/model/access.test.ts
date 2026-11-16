// The setup screen's rules (draft ADR "the Agent's tools and approvals", section 16), pure: the defaults, a draft from what the
// desk holds, an app switched off taking its switch, the change a Save sends (every app and switch the first time, only what
// changed after), the other desks offered, and the words.
import { describe, expect, it } from 'vitest';
import { RpcAgentClient, type DeskTransport } from '../client/rpcAgentClient';
import type { AgentAccess } from '../client/types';
import { statusDot, statusWord } from './agents';
import {
  accessErrorText,
  changeOf,
  DEFAULT_APPS,
  draftOf,
  folderName,
  forGuild,
  GUILD_APPS,
  hasChanges,
  otherDesksOf,
  placesToMake,
  reasonLine,
  setupIntro,
  setupTitle,
  withApp,
  type AccessDraft,
} from './access';

const fresh = (): AgentAccess => ({ chosen: false, setup: 'new', apps: { ...DEFAULT_APPS }, auto: { notebook: null, files: null, todos: false }, desks: [], incoming: [], updatedAt: null });
const chosen = (over: Partial<AgentAccess> = {}): AgentAccess => ({ ...fresh(), chosen: true, setup: null, updatedAt: 1, ...over });
const WORK = { deskId: 'd-work', name: 'Work' };
const HOME = { deskId: 'd-home', name: 'Home' };

describe('access: the screen starts from the defaults', () => {
  it('has Notebook, Files, Browser and To-dos on, and Courier, every switch and every desk off', () => {
    const d = draftOf(fresh());
    expect(d.apps).toEqual({ notebook: true, files: true, browser: true, courier: false, todos: true });
    expect(d.auto).toEqual({ notebook: null, files: null, todos: false });
    expect(d.desks).toEqual({});
  });

  it('starts from what the desk holds for an agent already set up, its places and its live grants', () => {
    const d = draftOf(chosen({ auto: { notebook: { tabId: 't1' }, files: { folder: 'Scout' }, todos: true }, desks: [
      { grantId: 'dg-1', agentId: 'a', toDeskId: 'd-work', toDeskName: 'Work', toKey: null, state: 'offered', createdAt: 1, lastUsedAt: null, count: 0 },
      { grantId: 'dg-2', agentId: 'a', toDeskId: 'd-old', toDeskName: 'Old', toKey: null, state: 'revoked', createdAt: 1, lastUsedAt: null, count: 0 },
    ] }));
    expect(d.auto.notebook).toEqual({ kind: 'existing', id: 't1', label: 'The tab it uses now' });
    expect(d.auto.files).toEqual({ kind: 'existing', id: 'Scout', label: 'Scout' });
    expect(d.desks).toEqual({ 'd-work': true });
  });

  it('gives a guild member’s own agent Notebook alone, whatever the draft says', () => {
    const d = forGuild({ apps: { ...DEFAULT_APPS, courier: true }, auto: { notebook: { kind: 'new', name: 'x' }, files: null, todos: true }, desks: { 'd-work': true } });
    expect(d.apps).toEqual(GUILD_APPS);
    expect(d.auto).toEqual({ notebook: null, files: null, todos: false });
    expect(d.desks).toEqual({});
  });
});

describe('access: an app switched off takes its switch', () => {
  it('clears the Notebook, Files and to-dos switches with their apps, and leaves the rest', () => {
    const on: AccessDraft = { apps: { ...DEFAULT_APPS }, auto: { notebook: { kind: 'new', name: 'S' }, files: { kind: 'new', name: 'S' }, todos: true }, desks: {} };
    expect(withApp(on, 'notebook', false).auto).toEqual({ notebook: null, files: { kind: 'new', name: 'S' }, todos: true });
    expect(withApp(on, 'files', false).auto.files).toBeNull();
    expect(withApp(on, 'todos', false).auto.todos).toBe(false);
    expect(withApp(on, 'browser', false).auto).toEqual(on.auto);
    // Switching it back on doesn't bring the switch back: that's the member's choice again.
    expect(withApp(withApp(on, 'notebook', false), 'notebook', true).auto.notebook).toBeNull();
  });
});

describe('access: what a Save sends', () => {
  it('sends every app and every switch the first time, even unchanged, as the desk requires', () => {
    expect(changeOf(fresh(), draftOf(fresh()), [])).toEqual({
      apps: { notebook: true, files: true, browser: true, courier: false, todos: true },
      auto: { notebook: null, files: null, todos: false },
    });
  });

  it('sends only what changed after, and nothing for nothing', () => {
    const now = chosen();
    const d = withApp(draftOf(now), 'courier', true);
    expect(changeOf(now, d, [])).toEqual({ apps: { courier: true } });
    expect(hasChanges(now, draftOf(now), [WORK])).toBe(false);
    expect(hasChanges(now, d, [])).toBe(true);
    // A first save always counts: it's what sets the agent up.
    expect(hasChanges(fresh(), draftOf(fresh()), [])).toBe(true);
  });

  it('makes a new place first and sends its id; an existing one goes as it is', () => {
    const d: AccessDraft = { ...draftOf(fresh()), auto: { notebook: { kind: 'new', name: 'Scout' }, files: { kind: 'existing', id: 'Research', label: 'Research' }, todos: true } };
    expect(placesToMake(d)).toEqual({ notebook: 'Scout', files: null });
    expect(changeOf(fresh(), d, [], { notebook: 'tab-9' }).auto).toEqual({ notebook: { tabId: 'tab-9' }, files: { folder: 'Research' }, todos: true });
  });

  it('switches a desk on with its name and off by id, and leaves a desk that didn’t change out', () => {
    const now = chosen({ desks: [{ grantId: 'dg-1', agentId: 'a', toDeskId: 'd-home', toDeskName: 'Home', toKey: null, state: 'active', createdAt: 1, lastUsedAt: 2, count: 3 }] });
    const d = { ...draftOf(now), desks: { 'd-work': true, 'd-home': false } };
    expect(changeOf(now, d, [WORK, HOME]).desks).toEqual([{ deskId: 'd-work', deskName: 'Work', on: true }, { deskId: 'd-home', on: false }]);
    expect(changeOf(now, draftOf(now), [WORK, HOME]).desks).toBeUndefined();
  });

  it('goes on the wire as `agent.access.set` with only the sections given', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const link: DeskTransport = {
      call: async (method, params = {}) => {
        calls.push({ method, params });
        return method === 'agent.desks.revoke' ? { agentId: 'a', access: chosen() } : { access: chosen() };
      },
      subscribe: () => () => undefined,
    };
    const c = new RpcAgentClient(link);
    await c.getAccess('a');
    await c.setAccess('a', { apps: { courier: true } }, { idem: 'k1' });
    await c.setAccess('a', { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }, { deskId: 'd-home', on: false }] }, { idem: 'k2' });
    const r = await c.revokeDeskGrant('dg-1', { idem: 'k3' });
    expect(calls).toEqual([
      { method: 'agent.access.get', params: { agentId: 'a' } },
      { method: 'agent.access.set', params: { agentId: 'a', apps: { courier: true } } },
      { method: 'agent.access.set', params: { agentId: 'a', desks: [{ deskId: 'd-work', on: true, deskName: 'Work' }, { deskId: 'd-home', on: false }] } },
      { method: 'agent.desks.revoke', params: { grantId: 'dg-1' } },
    ]);
    expect(r.agentId).toBe('a');
  });
});

describe('access: other desks and the words', () => {
  it('offers the member’s desks but this one, a Guild Desk and one they left', () => {
    expect(otherDesksOf([
      { id: 'd-1', name: 'Personal', kind: 'personal' },
      { id: 'd-2', name: 'Work', kind: 'work' },
      { id: 'g-1', name: 'Readers', kind: 'guild' },
      { id: 'd-3', name: 'Gone', kind: 'custom', removed: true },
      { id: 'd-4', name: 'Lab', kind: 'custom' },
    ], 'd-1')).toEqual([{ deskId: 'd-2', name: 'Work' }, { deskId: 'd-4', name: 'Lab' }]);
  });

  it('names a new folder after the agent as Files takes a name', () => {
    expect(folderName('Scout')).toBe('Scout');
    expect(folderName('A/B\\C')).toBe('A B C');
    expect(folderName('..hidden')).toBe('hidden');
    expect(folderName('  ')).toBe('Agent');
  });

  it('says what the screen is, and why it shows again', () => {
    expect(setupTitle('Scout')).toBe('What can Scout use?');
    expect(setupIntro('Scout')).toBe('Scout asks you before it changes, sends or buys anything, unless you say otherwise below. You can change this any time in its settings.');
    expect(reasonLine('new', 'Scout')).toBeNull();
    expect(reasonLine('upgrade', 'Scout')).toContain('Until now Scout could use Notebook, Files and Browser');
    expect(reasonLine('confirm', 'Scout')).toBe('Your desk needs you to confirm these again before Scout can work.');
    expect(accessErrorText('app_off', 'auto.files')).toBe('Turn on Files first.');
    expect(accessErrorText('folder', 'auto.files')).toContain('inside your Files');
    expect(accessErrorText('self', 'desks')).toContain('not this one');
    expect(accessErrorText(null, null)).toBe('This couldn’t be saved just now. Try again.');
  });
});

describe('access: the status while it waits', () => {
  it('says "set up first" with a hollow dot for an agent with a key waiting for its screen, and as before otherwise', () => {
    const binding = { keyId: 'k', provider: 'anthropic', providerName: 'Anthropic', model: 'm' };
    expect(statusWord({ status: 'online', binding, setup: 'new' })).toBe('set up first');
    expect(statusDot({ status: 'online', setup: 'upgrade' })).toBe('hollow');
    expect(statusWord({ status: 'online', binding, setup: null })).toBe('online');
    expect(statusDot({ status: 'online', setup: null })).toBe('online');
    expect(statusWord({ status: 'no_key', binding: null, setup: 'new' })).toBe('no key');
    expect(statusWord({ status: 'working', binding, setup: 'confirm' })).toBe('working');
  });
});
