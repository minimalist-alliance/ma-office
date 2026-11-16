// The mock's setup gate behaves as desk-agent's (draft ADR "the Agent's tools and approvals", section 16), so the screen's demo
// and the shell specs see what a desk does: no run before the save, the first save whole, a switch needing its app, grants to
// other desks offered and stopped, every agent made here waiting for its screen, and agents made before the screen upgraded.
import { describe, expect, it } from 'vitest';
import { AgentError, newIdem } from '../client/agentClient';
import { KeySecret } from '../client/keySecret';
import { actionText, toolRow } from '../ui/Activity';
import { MockAgentClient } from './mockAgentClient';

const m = () => ({ idem: newIdem() });
const ALL_APPS = { notebook: true, files: true, browser: true, courier: false, todos: true };
const AUTO_OFF = { notebook: null, files: null, todos: false };

async function refusal(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('not refused');
}

describe('mock: the setup gate', () => {
  it('lets no run start before the member saves the screen, and adds nothing to the thread', async () => {
    const c = new MockAgentClient({ fixture: 'ready', setup: 'new', latencyMs: 0, streamMs: 0 });
    const lead = (await c.listAgents()).find((a) => a.lead)!;
    expect(lead.setup).toBe('new');
    const e = await refusal(c.sendMessage(lead.id, 'Hello', m()));
    expect(e.code).toBe('precondition_failed');
    expect(e.reason).toBe('setup');
    const before = (await c.getThread(lead.id)).messages.length;
    await c.setAccess(lead.id, { apps: ALL_APPS, auto: AUTO_OFF }, m());
    expect((await c.getAgent(lead.id)).setup).toBeNull();
    await c.sendMessage(lead.id, 'Hello', m());
    expect((await c.getThread(lead.id)).messages.length).toBeGreaterThan(before);
  });

  it('says no_key before setup for an agent with neither', async () => {
    const c = new MockAgentClient({ fixture: 'fresh', setup: 'new', latencyMs: 0, streamMs: 0 });
    const lead = (await c.listAgents())[0]!;
    expect((await refusal(c.sendMessage(lead.id, 'Hi', m()))).reason).toBe('no_key');
    const key = await c.addKey({ provider: 'anthropic', label: 'Main', secret: KeySecret.fromText('sk-ant-TEST-not-a-real-key-0000-SETUP') }, m());
    const models = await c.listModels(key.keyId);
    await c.bindAgent(lead.id, { keyId: key.keyId, model: models[0]!.id }, m());
    expect((await refusal(c.sendMessage(lead.id, 'Hi', m()))).reason).toBe('setup');
  });

  it('needs every app and every switch on the first save, and only what changed after', async () => {
    const c = new MockAgentClient({ fixture: 'ready', setup: 'new', latencyMs: 0, streamMs: 0 });
    const id = (await c.listAgents())[0]!.id;
    expect((await refusal(c.setAccess(id, { apps: ALL_APPS }, m()))).detail).toBe('auto');
    expect((await refusal(c.setAccess(id, { apps: { notebook: true }, auto: AUTO_OFF }, m()))).reason).toBe('required');
    await c.setAccess(id, { apps: ALL_APPS, auto: AUTO_OFF }, m());
    const later = await c.setAccess(id, { apps: { courier: true } }, m());
    expect(later.apps).toEqual({ ...ALL_APPS, courier: true });
    expect(later.chosen).toBe(true);
  });

  it('refuses a switch for an app that’s off, and an app switched off takes its switch', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0 });
    const id = (await c.listAgents())[0]!.id;
    expect((await refusal(c.setAccess(id, { apps: { files: false }, auto: { files: { folder: 'Lead' } } }, m()))).reason).toBe('app_off');
    await c.setAccess(id, { auto: { files: { folder: 'Lead' }, todos: true } }, m());
    const off = await c.setAccess(id, { apps: { files: false, todos: false } }, m());
    expect(off.auto).toEqual(AUTO_OFF);
  });

  it('offers a grant to another desk, offered until that desk allows it, and stops it', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0 });
    const id = (await c.listAgents())[0]!.id;
    expect((await refusal(c.setAccess(id, { desks: [{ deskId: 'd-work', on: true }] }, m()))).reason).toBe('name');
    const offered = await c.setAccess(id, { desks: [{ deskId: 'd-work', deskName: 'Work', on: true }] }, m());
    expect(offered.desks).toEqual([expect.objectContaining({ toDeskId: 'd-work', toDeskName: 'Work', state: 'offered' })]);
    const stopped = await c.revokeDeskGrant(offered.desks[0]!.grantId, m());
    expect(stopped.access.desks).toEqual([]);
    expect((await refusal(c.revokeDeskGrant(offered.desks[0]!.grantId, m()))).code).toBe('not_found');
    const actions = (await c.listAudit()).entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['access.set', 'desks.offer', 'desks.revoke']));
  });

  it('has every agent made here wait for its screen, and an agent made before the screen start from what it had', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0 });
    const key = (await c.listKeys())[0]!;
    const made = await c.createAgent({ name: 'Planner', keyId: key.keyId, model: (await c.listModels(key.keyId))[0]!.id }, m());
    expect((await c.getAgent(made.id)).setup).toBe('new');
    expect((await c.getAccess(made.id)).apps).toEqual(ALL_APPS);
    const upgraded = new MockAgentClient({ fixture: 'ready', setup: 'upgrade', latencyMs: 0, streamMs: 0 });
    const lead = (await upgraded.listAgents())[0]!;
    expect(lead.setup).toBe('upgrade');
    expect((await upgraded.getAccess(lead.id)).apps).toEqual({ notebook: true, files: true, browser: true, courier: false, todos: false });
  });

  it('can be told to ask again, keeping the choices, as when the desk lost its own copy', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0 });
    const id = (await c.listAgents())[0]!.id;
    await c.setAccess(id, { apps: { browser: false } }, m());
    c.needsSetup(id, 'confirm');
    const access = await c.getAccess(id);
    expect(access).toMatchObject({ chosen: false, setup: 'confirm' });
    expect(access.apps.browser).toBe(false);
  });
});

describe('Activity: what the setup screen did', () => {
  it('reads each row in plain words, naming the agent and never a place', () => {
    const agents = [{ id: 'manager', name: 'Lead' }];
    const row = (action: string, decision: string) =>
      toolRow({ seq: 1, atMs: 1, actor: 'user', action, target: 'agent:manager files:on courier:off', payloadSha256: null, decision, hash: 'h', costMicroUsd: null }, agents);
    expect(row('access.set', 'setup')).toMatchObject({ what: 'Set up what it can use', onWhat: 'Lead', who: 'You' });
    expect(row('access.set', 'ok')?.what).toBe('Changed what it can use');
    expect(row('access.confirm', 'hello')).toMatchObject({ what: 'Waits for you to confirm what it can use', who: 'Your desk' });
    expect(row('desks.offer', 'ok')?.what).toBe('Let it message another of your desks');
    expect(row('desks.revoke', 'deleted')).toMatchObject({ what: 'Stopped its messages to another desk when it was deleted', who: 'Your desk' });
    expect(row('access.tampered', 'ok')?.what).toBe('Its choices couldn’t be checked, so it waits for you');
    expect(actionText({ action: 'access.set', decision: 'ok' })).toBeTruthy();
  });
});
