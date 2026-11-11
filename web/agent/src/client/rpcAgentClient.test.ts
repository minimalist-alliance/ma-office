import { describe, expect, it, vi } from 'vitest';
import { AgentError, newIdem } from './agentClient';
import { KeySecret } from './keySecret';
import { RpcAgentClient, toAgentError, type DeskTransport, type TopicEvent } from './rpcAgentClient';

const KEY = 'sk-ant-TEST-not-a-real-key-0000-RPC';

function fakeLink(answer: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {
  const calls: { method: string; params: Record<string, unknown>; json: string; options: unknown }[] = [];
  const subs: { topic: string; fn: (m: TopicEvent) => void }[] = [];
  const link: DeskTransport = {
    call: vi.fn(async (method: string, params: Record<string, unknown> = {}, options?: unknown) => {
      // What a link puts on the wire is the JSON of params, at this moment.
      calls.push({ method, params, json: JSON.stringify(params), options });
      const r = answer(method, params);
      if (r instanceof Error) throw r;
      return r;
    }),
    subscribe: vi.fn((topic, fn) => {
      subs.push({ topic, fn });
      return () => undefined;
    }),
  };
  return { link, calls, subs };
}

describe('RpcAgentClient: the key', () => {
  it('goes in agent.key.add params once, and only there', async () => {
    const { link, calls } = fakeLink((m) => (m === 'agent.key.add' ? { key: { keyId: 'k1', last4: 'RPC' } } : { agents: [], keys: [] }));
    const c = new RpcAgentClient(link);
    const secret = KeySecret.fromText(KEY);
    await c.listAgents();
    const key = await c.addKey({ provider: 'anthropic', label: 'Mine', secret }, { idem: newIdem() });
    await c.listKeys();
    expect(key.keyId).toBe('k1');
    const withKey = calls.filter((x) => x.json.includes(KEY));
    expect(withKey.map((x) => x.method)).toEqual(['agent.key.add']);
    expect(calls.find((x) => x.method === 'agent.key.add')?.json).toBe(JSON.stringify({ provider: 'anthropic', label: 'Mine', secret: KEY }));
  });

  it('blanks its own params object once the call settles, success or not', async () => {
    const { link, calls } = fakeLink(() => new Error('lost'));
    const c = new RpcAgentClient(link);
    await expect(c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText(KEY) }, { idem: newIdem() })).rejects.toThrow();
    expect(calls[0]?.params['secret']).toBe('');
  });

  it('sends the mutation key and a longer deadline for the key check', async () => {
    const { link, calls } = fakeLink(() => ({ key: {} }));
    const idem = newIdem();
    await new RpcAgentClient(link).addKey({ provider: 'openai', label: '', secret: KeySecret.fromText('sk-0000000000') }, { idem });
    expect(calls[0]?.options).toEqual({ idem, deadlineMs: 30_000 });
  });

  it('refuses to send a wiped secret', async () => {
    const { link, calls } = fakeLink();
    const s = KeySecret.fromText(KEY);
    s.wipe();
    await expect(new RpcAgentClient(link).addKey({ provider: 'anthropic', label: '', secret: s }, { idem: newIdem() })).rejects.toThrow(/wiped/);
    expect(calls).toHaveLength(0);
  });
});

describe('RpcAgentClient: wire mapping', () => {
  it('reads agent.state snapshots', () => {
    const { link, subs } = fakeLink();
    const seen: unknown[] = [];
    new RpcAgentClient(link).watchAgents((a) => seen.push(a));
    expect(subs[0]?.topic).toBe('agent.state');
    subs[0]?.fn({ seq: 7, type: 'snapshot', agents: [{ id: 'manager' }] });
    subs[0]?.fn({ seq: 8, type: 'error', code: 'forbidden' });
    expect(seen).toEqual([[{ id: 'manager' }]]);
  });

  it('maps each method to its agent.* name and params', async () => {
    const { link, calls } = fakeLink(() => ({ agents: [], agent: {}, keys: [], models: [], providers: [] }));
    const c = new RpcAgentClient(link);
    const m = { idem: newIdem() };
    await c.providers();
    await c.createAgent({ name: 'Scribe' }, m);
    await c.updateAgent('a1', { badgeHidden: true }, m);
    await c.bindAgent('a1', { keyId: 'k1', model: 'x' }, m);
    await c.getThread('a1');
    await c.sendMessage('a1', 'hi', m);
    await c.stopRun('r1', m);
    await c.markSeen('a1');
    await c.deleteKey('k1', m);
    await c.listModels('k1');
    await c.getLimits('a1');
    await c.setLimits('a1', { policy: { runMaxSteps: 5 } as never }, m);
    await c.setLimits('a1', { timeZone: null }, m);
    await c.setLimits('a1', { policy: { runMaxSteps: 5, deskMonth: null } as never, timeZone: 'Europe/Paris' }, m);
    await c.listAudit({ limit: 10 });
    expect(calls.map((x) => `${x.method} ${x.json}`)).toEqual([
      'agent.providers {}',
      'agent.create {"name":"Scribe"}',
      'agent.update {"agentId":"a1","badgeHidden":true}',
      'agent.bind {"agentId":"a1","keyId":"k1","model":"x"}',
      'agent.thread.get {"agentId":"a1"}',
      'agent.message.send {"agentId":"a1","text":"hi"}',
      'agent.run.stop {"runId":"r1"}',
      'agent.seen {"agentId":"a1"}',
      'agent.key.delete {"keyId":"k1"}',
      'agent.key.models {"keyId":"k1"}',
      'agent.limits.get {"agentId":"a1"}',
      'agent.limits.set {"agentId":"a1","policy":{"runMaxSteps":5}}',
      // Absent and null differ (API.md section 11): a null goes as null, and what isn't there isn't sent.
      'agent.limits.set {"agentId":"a1","timeZone":null}',
      'agent.limits.set {"agentId":"a1","policy":{"runMaxSteps":5,"deskMonth":null},"timeZone":"Europe/Paris"}',
      'agent.audit.list {"limit":10}',
    ]);
    // Mutations carry idem; reads don't.
    expect(calls.filter((x) => (x.options as { idem?: string }).idem).map((x) => x.method)).toEqual([
      'agent.create',
      'agent.update',
      'agent.bind',
      'agent.message.send',
      'agent.run.stop',
      'agent.key.delete',
      'agent.limits.set',
      'agent.limits.set',
      'agent.limits.set',
    ]);
  });

  it('turns a link error with deskd details into an AgentError', async () => {
    const err = Object.assign(new Error('x'), { code: 'precondition_failed', details: { reason: 'limit_reached', scope: 'agent_day' } });
    const { link } = fakeLink(() => err);
    const e = await new RpcAgentClient(link).sendMessage('a1', 'hi', { idem: newIdem() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect(e).toMatchObject({ code: 'precondition_failed', reason: 'limit_reached', scope: 'agent_day', mayHaveApplied: false });
    expect(toAgentError(new Error('plain'))).toBeInstanceOf(Error);
    expect(toAgentError(Object.assign(new Error(), { code: 'unavailable', details: { mayHaveApplied: true } }))).toMatchObject({ mayHaveApplied: true });
  });

  it('reads the conversation topic per agent, and passes snapshot, message and delta through', () => {
    const { link, subs } = fakeLink();
    const events: unknown[] = [];
    new RpcAgentClient(link).watchConversation('a1', (e) => events.push(e));
    expect(subs[0]?.topic).toBe('agent.conversation:a1');
    const fn = subs[0]?.fn ?? (() => undefined);
    // As the Desk's link delivers them: data spread out, with type and seq.
    fn({ seq: 1, type: 'snapshot', messages: [] });
    fn({ seq: 2, type: 'message', message: { id: 'm1' } });
    fn({ seq: 3, type: 'delta', messageId: 'm1', runId: 'r1', text: 'Hi' });
    fn({ seq: 4, type: 'resync' });
    expect(events).toEqual([
      { type: 'snapshot', seq: 1, messages: [] },
      { type: 'message', seq: 2, message: { id: 'm1' } },
      { type: 'delta', seq: 3, messageId: 'm1', runId: 'r1', text: 'Hi' },
    ]);
  });
});

describe('RpcAgentClient: task 49 (multi-agent.md)', () => {
  it('maps every new method to its wire name and params, with idem on each mutation', async () => {
    const { link, calls } = fakeLink((method) => {
      if (method === 'agent.icon.upload') return {};
      return { agent: { id: 'ag-1' }, caps: { agentCap: 24 }, proposal: { id: 'pr-1' }, timer: { id: 'tm-1' }, messages: [], older: false, usedBytes: 3, png: 'AA==', version: 2 };
    });
    const c = new RpcAgentClient(link);
    const m = { idem: newIdem() };
    await c.getAgent('ag-1');
    await c.createAgent({ name: 'Scout', purpose: 'p', icon: 'compass', tone: 'sage', solo: true, workspaceMb: 50 }, m);
    await c.updateAgent('ag-1', { purpose: 'q', tone: 'plum', solo: false, workspaceMb: 10 }, m);
    await c.deleteAgent('ag-1', m);
    await c.setLinks('ag-1', { solo: false, links: [{ to: 'ag-2', rules: 'Be brief.' }, { to: 'ag-3' }] }, m);
    expect(await c.caps()).toEqual({ agentCap: 24 });
    expect(await c.answerProposal('pr-1', true, 'ab12', m)).toEqual({ id: 'pr-1' });
    await c.listA2a();
    await c.listA2a({ agentId: 'ag-1', before: 1700 });
    await c.getWorkspace('ag-1');
    await c.getWorkspace('ag-1', 'notes');
    await c.readWorkspace('ag-1', 'notes/a.md');
    await c.readWorkspace('ag-1', 'notes/a.md', { offset: 131072, length: 500 });
    await c.createAgent({ name: 'Plain' }, m);
    expect(await c.deleteWorkspaceEntry('ag-1', 'notes/a.md', m)).toMatchObject({ usedBytes: 3 });
    await c.shareWorkspace('ag-1', ['ag-2'], m);
    await c.listTimers('ag-1');
    expect(await c.setTimer('ag-1', { label: 'Brief', kind: 'repeat', days: [1, 2], time: '08:00', prompt: 'Go' }, m)).toEqual({ id: 'tm-1' });
    await c.deleteTimer('ag-1', 'tm-1', m);
    expect(await c.uploadIcon('ag-1', 'iVBO', m)).toBeNull();
    expect(await c.getIcon('ag-1')).toMatchObject({ png: 'AA==', version: 2 });
    expect(calls.map((x) => `${x.method} ${x.json}`)).toEqual([
      'agent.get {"agentId":"ag-1"}',
      'agent.create {"name":"Scout","purpose":"p","icon":"compass","tone":"sage","solo":true,"workspaceMb":50}',
      'agent.update {"agentId":"ag-1","purpose":"q","tone":"plum","solo":false,"workspaceMb":10}',
      'agent.delete {"agentId":"ag-1"}',
      // A link always goes with its rules, even empty, so the desk refuses it rather than guessing.
      'agent.links.set {"agentId":"ag-1","solo":false,"links":[{"to":"ag-2","rules":"Be brief."},{"to":"ag-3","rules":""}]}',
      'agent.caps {}',
      'agent.proposal.answer {"proposalId":"pr-1","accept":true,"sha256":"ab12"}',
      'agent.a2a.list {}',
      'agent.a2a.list {"agentId":"ag-1","before":1700}',
      'agent.workspace.get {"agentId":"ag-1"}',
      'agent.workspace.get {"agentId":"ag-1","path":"notes"}',
      'agent.workspace.read {"agentId":"ag-1","path":"notes/a.md"}',
      'agent.workspace.read {"agentId":"ag-1","path":"notes/a.md","offset":131072,"length":500}',
      'agent.create {"name":"Plain"}',
      'agent.workspace.delete {"agentId":"ag-1","path":"notes/a.md"}',
      'agent.workspace.share {"agentId":"ag-1","with":["ag-2"]}',
      'agent.timer.list {"agentId":"ag-1"}',
      'agent.timer.set {"agentId":"ag-1","timer":{"label":"Brief","kind":"repeat","days":[1,2],"time":"08:00","prompt":"Go"}}',
      'agent.timer.delete {"agentId":"ag-1","timerId":"tm-1"}',
      'agent.icon.upload {"agentId":"ag-1","png":"iVBO"}',
      'agent.icon.get {"agentId":"ag-1"}',
    ]);
    expect(calls.filter((x) => (x.options as { idem?: string }).idem).map((x) => x.method)).toEqual([
      'agent.create',
      'agent.update',
      'agent.delete',
      'agent.links.set',
      'agent.proposal.answer',
      'agent.create',
      'agent.workspace.delete',
      'agent.workspace.share',
      'agent.timer.set',
      'agent.timer.delete',
      'agent.icon.upload',
    ]);
  });

  it('passes agent.state\'s caps along with the agents, and null where a desk sends none', () => {
    const { link, subs } = fakeLink();
    const seen: unknown[] = [];
    new RpcAgentClient(link).watchAgents((agents, caps) => seen.push({ n: agents.length, caps }));
    subs[0]!.fn({ seq: 1, type: 'snapshot', agents: [{ id: 'manager' }], caps: { agentCap: 3 } });
    subs[0]!.fn({ seq: 2, type: 'snapshot', agents: [] });
    expect(seen).toEqual([{ n: 1, caps: { agentCap: 3 } }, { n: 0, caps: null }]);
  });

  it('answers an upload with the agent where the desk sends one', async () => {
    const { link } = fakeLink(() => ({ agent: { id: 'ag-1', look: { icon: 'png', tone: 'sage', png: 1 } } }));
    expect(await new RpcAgentClient(link).uploadIcon('ag-1', 'iVBO', { idem: newIdem() })).toMatchObject({ id: 'ag-1' });
  });

  it('carries a refusal\'s reason and detail, such as a PNG that is too large', async () => {
    const err = Object.assign(new Error('x'), { code: 'bad_request', details: { detail: 'png', reason: 'too_large' } });
    const { link } = fakeLink(() => err);
    const e = await new RpcAgentClient(link).uploadIcon('ag-1', 'x', { idem: newIdem() }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'bad_request', reason: 'too_large', detail: 'png' });
  });
});

describe('RpcAgentClient: threads longer than one event', () => {
  const msg = (id: string, over: Record<string, unknown> = {}) => ({ id, role: 'assistant', text: id, at: 1, ...over });

  it('a snapshot with older messages left out asks for the whole thread, and a short one does not', async () => {
    const { link, subs, calls } = fakeLink(() => ({ agentId: 'a', messages: [msg('old'), msg('new')], seq: 99 }));
    const c = new RpcAgentClient(link);
    const events: { type: string; seq: number; messages?: unknown[] }[] = [];
    c.watchConversation('a', (e) => events.push(e as never));
    subs[0]!.fn({ type: 'snapshot', seq: 7, messages: [msg('new')] });
    expect(calls.filter((x) => x.method === 'agent.thread.get')).toHaveLength(0);
    subs[0]!.fn({ type: 'snapshot', seq: 8, messages: [msg('new')], omitted: 1 });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(calls.filter((x) => x.method === 'agent.thread.get')).toHaveLength(1);
    // The last event's seq, not the read's: what follows on the topic must still land.
    expect(events[2]).toMatchObject({ type: 'snapshot', seq: 8 });
    expect(events[2]!.messages).toHaveLength(2);
  });

  it('a long message that came cut does the same, and nothing arrives once it\'s unsubscribed', async () => {
    const { link, subs, calls } = fakeLink(() => ({ agentId: 'a', messages: [msg('long', { text: 'all of it' })], seq: 3 }));
    const c = new RpcAgentClient(link);
    const events: unknown[] = [];
    const off = c.watchConversation('a', (e) => events.push(e));
    subs[0]!.fn({ type: 'message', seq: 2, message: msg('long', { truncated: true }) });
    off();
    await vi.waitFor(() => expect(calls.filter((x) => x.method === 'agent.thread.get')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
  });
});

describe('RpcAgentClient: deadlines', () => {
  it('the two calls that reach the provider get deskd\'s 30 s', async () => {
    const { link, calls } = fakeLink(() => ({ models: [] }));
    await new RpcAgentClient(link).listModels('k');
    expect(calls[0]!.options).toEqual({ deadlineMs: 30_000 });
  });
});


describe('RpcAgentClient: files on a message (ADR 0049)', () => {
  const file = (n: number) => new File([new Uint8Array(n).fill(65) as BlobPart], 'doc.txt');

  it('sends a file as 512 KiB chunks, one call each, in order, each with its own key', async () => {
    const { link, calls } = fakeLink(() => ({ uploadId: 'u', received: 1, complete: true }));
    const c = new RpcAgentClient(link);
    await c.attachFile('a1', 'upload-id-1', file(1024 * 1024 + 10));
    expect(calls.map((x) => x.method)).toEqual(['agent.attach.put', 'agent.attach.put', 'agent.attach.put']);
    expect(calls.map((x) => (x.params as { index: number }).index)).toEqual([0, 1, 2]);
    expect(calls[0]?.params).toMatchObject({ agentId: 'a1', uploadId: 'upload-id-1', name: 'doc.txt', size: 1024 * 1024 + 10 });
    expect(Buffer.from(String(calls[0]?.params['data']), 'base64')).toHaveLength(512 * 1024);
    expect(Buffer.from(String(calls[2]?.params['data']), 'base64')).toHaveLength(10);
    const idems = calls.map((x) => (x.options as { idem: string }).idem);
    expect(new Set(idems).size).toBe(3);
    // Under deskd's 1 MiB request limit with room for the rest of the frame.
    for (const x of calls) expect(x.json.length).toBeLessThan(1024 * 1024);
  });

  it('retries one chunk with the same key when its answer never came, and not otherwise', async () => {
    let n = 0;
    const lost = Object.assign(new Error('lost'), { code: 'deadline_exceeded', details: {} });
    const { link, calls } = fakeLink(() => (n++ === 0 ? lost : { uploadId: 'u' }));
    await new RpcAgentClient(link).attachFile('a1', 'upload-id-1', file(10));
    expect(calls).toHaveLength(2);
    expect((calls[0]!.options as { idem: string }).idem).toBe((calls[1]!.options as { idem: string }).idem);

    const refused = Object.assign(new Error('no'), { code: 'bad_request', details: { reason: 'bad_upload' } });
    const second = fakeLink(() => refused);
    await expect(new RpcAgentClient(second.link).attachFile('a1', 'upload-id-1', file(10))).rejects.toMatchObject({ reason: 'bad_upload' });
    expect(second.calls).toHaveLength(1);
  });

  it('adds attachments to agent.message.send only when there are some, and text may be empty', async () => {
    const { link, calls } = fakeLink(() => ({ messageId: 'm', runId: 'r' }));
    const c = new RpcAgentClient(link);
    await c.sendMessage('a1', 'hello', { idem: newIdem() });
    await c.sendMessage('a1', '', { idem: newIdem() }, ['u1', 'u2']);
    expect(calls[0]?.params).toEqual({ agentId: 'a1', text: 'hello' });
    expect(calls[1]?.params).toEqual({ agentId: 'a1', text: '', attachments: ['u1', 'u2'] });
  });

  it('remove, caps and caps.set map onto their methods; a smaller chunkBytes from the desk is honoured', async () => {
    const { link, calls } = fakeLink((m) => (m === 'agent.attach.caps' ? { caps: {}, ceiling: {}, chunkBytes: 1000 } : {}));
    const c = new RpcAgentClient(link);
    await c.removeAttachment('a1', 'u1', { idem: 'k' });
    await c.setAttachCaps({ maxFiles: 3 }, { idem: 'k2' });
    await c.attachCaps('a1');
    await c.attachFile('a1', 'upload-id-1', file(2500));
    expect(calls.slice(0, 3).map((x) => [x.method, x.params])).toEqual([
      ['agent.attach.remove', { agentId: 'a1', uploadId: 'u1' }],
      ['agent.attach.caps.set', { maxFiles: 3 }],
      ['agent.attach.caps', { agentId: 'a1' }],
    ]);
    expect(calls.filter((x) => x.method === 'agent.attach.put')).toHaveLength(3);
  });

  it('reads a refusal\'s file name and limit', () => {
    const e = toAgentError({ code: 'too_large', details: { reason: 'too_large', name: 'big.pdf', limit: 8388608 } });
    expect(e).toMatchObject({ reason: 'too_large', file: 'big.pdf', limit: 8388608 });
  });
});

describe('RpcAgentClient: S-14 on the wire (API.md section 18, desk-agent memory, the spec’s agent.tools)', () => {
  it('decides with only what section 18 takes: a note only with a no, and the mutation key', async () => {
    const { link, calls } = fakeLink(() => ({ approval: { id: 'ap-1', state: 'declined' } }));
    const c = new RpcAgentClient(link);
    const idem = newIdem();
    await c.decideApproval('ap-1', { approve: true, sha256: 'ab', note: 'ignored with a yes' }, { idem });
    await c.decideApproval('ap-1', { approve: false, sha256: 'ab', note: 'Not today' }, { idem: newIdem() });
    expect(calls.map((x) => [x.method, x.params])).toEqual([
      ['agent.approval.decide', { approvalId: 'ap-1', approve: true, sha256: 'ab' }],
      ['agent.approval.decide', { approvalId: 'ap-1', approve: false, sha256: 'ab', note: 'Not today' }],
    ]);
    expect(calls[0]?.options).toEqual({ idem, deadlineMs: 15_000 });
  });

  it('lists and gets approvals by their wire names', async () => {
    const { link, calls } = fakeLink((m) => (m === 'agent.approval.get' ? { approval: { id: 'ap-2' } } : { approvals: [], older: false }));
    const c = new RpcAgentClient(link);
    await c.listApprovals({ agentId: 'scout', state: 'all' });
    expect((await c.getApproval('ap-2')).id).toBe('ap-2');
    expect(calls.map((x) => [x.method, x.params])).toEqual([
      ['agent.approvals.list', { agentId: 'scout', state: 'all' }],
      ['agent.approval.get', { approvalId: 'ap-2' }],
    ]);
  });

  it('carries a snapshot’s approvals and each approval event', () => {
    const { link, subs } = fakeLink();
    const got: unknown[] = [];
    new RpcAgentClient(link).watchConversation('scout', (e) => got.push(e));
    const fn = subs[0]!.fn;
    fn({ seq: 1, type: 'snapshot', messages: [], approvals: [{ id: 'ap-1' }] });
    fn({ seq: 2, type: 'approval', approval: { id: 'ap-1', state: 'approved' } });
    expect(got).toEqual([
      { type: 'snapshot', seq: 1, messages: [], approvals: [{ id: 'ap-1' }] },
      { type: 'approval', seq: 2, approval: { id: 'ap-1', state: 'approved' } },
    ]);
  });

  it('reads agent.tools, and a desk that doesn’t serve it is nothing running', () => {
    let refuse: ((code: string) => void) | undefined;
    const subs: { topic: string; fn: (m: TopicEvent) => void }[] = [];
    const link: DeskTransport = {
      call: vi.fn(async () => ({})),
      subscribe: vi.fn((topic, fn, onRefused) => {
        subs.push({ topic, fn });
        refuse = onRefused;
        return () => undefined;
      }),
    };
    const got: unknown[] = [];
    let absent = 0;
    new RpcAgentClient(link).watchTools((e) => got.push(e), () => (absent += 1));
    expect(subs[0]?.topic).toBe('agent.tools');
    const call = { callId: 'c1', agentId: 'scout' };
    subs[0]!.fn({ seq: 1, type: 'snapshot', serverNow: 5, calls: [call] });
    subs[0]!.fn({ seq: 2, type: 'call', call });
    subs[0]!.fn({ seq: 3, type: 'end', callId: 'c1', agentId: 'scout', result: 'stopped' });
    expect(got).toEqual([
      { type: 'snapshot', serverNow: 5, calls: [call] },
      { type: 'call', call },
      { type: 'end', callId: 'c1', agentId: 'scout', result: 'stopped' },
    ]);
    refuse?.('not_found');
    expect(absent).toBe(1);
  });

  it('reads and deletes memory with desk-agent’s methods', async () => {
    const { link, calls } = fakeLink((m) => (m === 'agent.memory.clear' ? { deleted: 3 } : m === 'agent.memory.list' ? { agentId: 'scout', memories: [], summary: null, limits: { items: 50, chars: 300 } } : { deleted: true }));
    const c = new RpcAgentClient(link);
    await c.listMemories('scout');
    await c.deleteMemory('scout', 'mem-1', { idem: newIdem() });
    expect(await c.clearMemories('scout', { idem: newIdem() })).toEqual({ deleted: 3 });
    expect(calls.map((x) => [x.method, x.params])).toEqual([
      ['agent.memory.list', { agentId: 'scout' }],
      ['agent.memory.delete', { agentId: 'scout', memoryId: 'mem-1' }],
      ['agent.memory.clear', { agentId: 'scout' }],
    ]);
  });
});
