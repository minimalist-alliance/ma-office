// The page probe's guards, in Node with a fake page and a fake desk: nothing outside Harness is ever sent or handed back, an
// agent answer gives only its time, and the app's own calls are read for names and ids, never values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HARNESS_DIR, HARNESS_TAB, INJECT } from './pure.mjs';
import { toolsProbe } from './page-probe.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const frame = (kind, id, body, flags = 0) => {
  const payload = enc.encode(JSON.stringify(body));
  const out = new Uint8Array(12 + payload.length);
  const v = new DataView(out.buffer);
  out[0] = 1;
  out[1] = kind;
  out[2] = flags;
  v.setUint32(4, id);
  out.set(payload, 12);
  return out.buffer;
};
const read = (bytes) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { kind: b[1], id: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4), body: JSON.parse(dec.decode(b.subarray(12))) };
};

/** A page with the probe in it, a session's `rpc` and `events`, and a desk answering by `answer(method, params)`. */
function page(answer) {
  const sent = [];
  class FakeChannel extends EventTarget {
    constructor(label) {
      super();
      this.label = label;
      this.readyState = 'open';
    }
    send(d) {
      sent.push({ label: this.label, d });
      if (this.label !== 'rpc') return;
      const f = read(d);
      if (f.kind !== 7) return;
      const a = answer(f.body.m, f.body.p, f.body);
      if (a === undefined) return;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: a.error ? frame(9, f.id, a.error) : frame(8, f.id, a) })));
    }
  }
  class FakePeer {
    createDataChannel(label) {
      return new FakeChannel(label);
    }
  }
  Object.assign(globalThis, {
    window: globalThis,
    RTCDataChannel: FakeChannel,
    RTCPeerConnection: FakePeer,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
  });
  delete globalThis.__rtTools;
  toolsProbe({ allow: INJECT, dir: HARNESS_DIR, tab: HARNESS_TAB });
  const pc = new globalThis.RTCPeerConnection();
  const rpc = pc.createDataChannel('rpc');
  const events = pc.createDataChannel('events');
  rpc.binaryType = 'arraybuffer';
  return { tools: globalThis.__rtTools, rpc, events, sent };
}

test('a Files call outside Harness is refused before anything is sent', async () => {
  const { tools, sent } = page(() => ({ entries: [], next: null }));
  for (const [m, p] of [
    ['files.list', { path: 'Documents' }],
    ['files.list', { path: 'Harness/../Documents' }],
    ['files.delete', { paths: ['Harness/a.md', 'Photos/b.jpg'] }],
    ['files.delete', { paths: ['Harness/a.md'], permanent: true }],
    ['files.read', { path: 'Harnessy/a.md' }],
    ['files.mkdir', {}],
    ['files.trash.empty', {}],
    ['files.rename', { from: 'Harness/a', to: 'Harness/b' }],
  ]) {
    const r = await tools.call(m, p);
    assert.equal(r.code, 'refused_by_harness', `${m} ${JSON.stringify(p)}`);
  }
  assert.equal(sent.length, 0);
});

test('a Files call inside Harness goes, as a REQ with an idem when it changes something', async () => {
  const { tools, sent } = page((m) => (m === 'files.list' ? { entries: [{ name: 'a.md', type: 'file' }], next: null } : { created: true }));
  const r = await tools.call('files.list', { path: 'Harness' });
  assert.deepEqual(r.result.entries, [{ name: 'a.md', type: 'file' }]);
  await tools.call('files.mkdir', { path: 'Harness/dir', parents: true });
  const reqs = sent.map((s) => read(s.d).body);
  assert.deepEqual(
    reqs.map((b) => [b.m, Boolean(b.idem)]),
    [
      ['files.list', false],
      ['files.mkdir', true],
    ],
  );
  assert.match(reqs[1].idem, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the trash comes back with Harness’s items only', async () => {
  const { tools } = page(() => ({
    items: [
      { id: 't1', name: 'a.md', originalPath: 'Harness/a.md', type: 'file', deletedAt: 1 },
      { id: 't2', name: 'tax.pdf', originalPath: 'Documents/tax.pdf', type: 'file', deletedAt: 2 },
    ],
    next: null,
  }));
  const r = await tools.call('files.trash.list', {});
  assert.deepEqual(
    r.result.items.map((x) => x.name),
    ['a.md'],
  );
});

test('the Notebook: only the Harness tab’s pages are named, read or changed', async () => {
  const { tools } = page((m, p) => {
    if (m === 'notebook.tree')
      return {
        rev: 1,
        next: null,
        notebooks: [{ id: 'n1', title: 'Mine', sortKey: 1 }],
        tabs: [
          { id: 'tH', notebookId: 'n1', title: 'Harness' },
          { id: 'tW', notebookId: 'n1', title: 'Work' },
        ],
        pages: [
          { id: 'p1', tabId: 'tH', title: 'Plan', snippet: 'secret-ish', deletedAt: null },
          { id: 'p2', tabId: 'tW', title: 'Salary review', snippet: 'private', deletedAt: null },
        ],
      };
    if (m === 'notebook.page.content') return { part: JSON.stringify({ type: 'doc', content: [] }), next: null, asked: p.pageId };
    return {};
  });
  const t = await tools.harnessTree();
  assert.deepEqual(t.tabs, [{ id: 'tH', notebookId: 'n1', title: 'Harness' }]);
  assert.deepEqual(
    t.pages.map((x) => x.id),
    ['p1'],
  );
  assert.ok(!JSON.stringify(t).includes('Salary') && !JSON.stringify(t).includes('Mine') && !JSON.stringify(t).includes('snippet'));
  assert.equal((await tools.call('notebook.page.content', { pageId: 'p1' })).ok, true);
  assert.equal((await tools.call('notebook.page.content', { pageId: 'p2' })).code, 'refused_by_harness');
  assert.equal((await tools.call('notebook.page.trash', { pageId: 'p2' })).code, 'refused_by_harness');
  assert.equal((await tools.call('notebook.page.import', { tabId: 'tW', doc: {} })).code, 'refused_by_harness');
  assert.equal((await tools.call('notebook.tab.create', { notebookId: 'n1', title: 'Other' })).code, 'refused_by_harness');
  assert.equal((await tools.call('notebook.page.agentUndo', { editId: 'e9' })).code, 'refused_by_harness');
});

test('an agent method: timing only, never its answer, and never in full', async () => {
  const { tools } = page(() => ({ approvals: [{ id: 'a1', payload: { text: 'private' } }] }));
  const r = await tools.call('agent.approvals.list', { state: 'pending' }, { mode: 'timing' });
  assert.deepEqual(Object.keys(r).sort(), ['code', 'ms', 'ok']);
  assert.equal(r.ok, true);
  assert.equal((await tools.call('agent.approvals.list', {})).code, 'refused_by_harness');
  assert.equal((await tools.call('agent.approval.decide', { approvalId: 'a1', approve: true }, { mode: 'timing' })).code, 'refused_by_harness');
});

test('the app’s own calls and events: names, ids, states and hashes; no text, payload or title', async () => {
  const { tools, rpc, events } = page(() => undefined);
  const id = 41;
  // The app subscribes, then asks for a run and gets its ids.
  rpc.send(frame(10, 40, { topic: 'agent.conversation:ag1', params: {} }));
  rpc.dispatchEvent(new MessageEvent('message', { data: frame(8, 40, { subId: 7 }) }));
  rpc.send(frame(7, id, { m: 'agent.message.send', p: { agentId: 'ag1', text: 'my private words' }, idem: 'x' }));
  rpc.dispatchEvent(new MessageEvent('message', { data: frame(8, id, { runId: 'run1', messageId: 'm1' }) }));
  rpc.send(frame(7, 42, { m: 'agent.key.add', p: { provider: 'anthropic', key: 'sk-made-up-key-value-000' } }));
  rpc.dispatchEvent(new MessageEvent('message', { data: frame(8, 42, { key: { keyId: 'k1', label: 'L', last4: '0000' } }) }));
  events.dispatchEvent(
    new MessageEvent('message', {
      data: frame(12, 7, {
        type: 'approval',
        approval: { id: 'ap1', agentId: 'ag1', runId: 'run1', tool: 'files_write', risk: 'write', state: 'pending', untrusted: true, sha256: 'a'.repeat(64), title: 'Save “Harness/secret.md”', payload: { path: 'Harness/secret.md', text: 'payload words' }, context: 'agent', createdAt: 1000 },
      }),
    }),
  );
  events.dispatchEvent(new MessageEvent('message', { data: frame(12, 7, { type: 'message', message: { id: 'm2', role: 'assistant', runId: 'run1', state: 'done', text: 'reply words', untrusted: true, tools: [{ name: 'files_write', ok: true, summary: 'Saved', path: 'Harness/secret.md', session: 'agent', approval: { id: 'ap1', decision: 'approved' } }] } }) }));
  await new Promise((r) => setTimeout(r, 0));
  const s = tools.snapshot();
  assert.deepEqual(s.sends.map((x) => x.runId), ['run1']);
  assert.deepEqual(s.keys.map((x) => x.keyId), ['k1']);
  assert.equal(s.approvals.ap1.tool, 'files_write');
  assert.equal(s.approvals.ap1.untrusted, true);
  assert.equal(s.messages.m2.tools[0].approvalId, 'ap1');
  assert.equal(s.messages.m2.tools[0].session, 'agent');
  const all = JSON.stringify(s);
  for (const word of ['my private words', 'sk-made-up', 'payload words', 'reply words', 'secret.md', 'Saved', 'last4']) assert.ok(!all.includes(word), word);
  assert.deepEqual(
    s.calls.map((c) => c.m),
    ['agent.message.send', 'agent.key.add'],
  );
});

test('audit rows: ids only, and whether a row holds the canary', async () => {
  const { tools, rpc } = page(() => undefined);
  tools.setCanaries(['mmcanary-0123456789abcdef']);
  rpc.send(frame(7, 50, { m: 'agent.audit.list', p: { limit: 30 } }));
  rpc.dispatchEvent(
    new MessageEvent('message', {
      data: frame(8, 50, {
        headHash: 'f'.repeat(64),
        entries: [
          { seq: 9, atMs: 5, actor: 'agent:ag1', action: 'tool.call', target: 'ap1', decision: 'ok', payloadSha256: 'a'.repeat(64), hash: 'b'.repeat(64) },
          { seq: 10, atMs: 6, actor: 'agent:ag1', action: 'tool.call', target: 'Harness/a file with mmcanary-0123456789abcdef', decision: 'ok', payloadSha256: null, hash: 'c'.repeat(64) },
        ],
      }),
    }),
  );
  const s = tools.snapshot();
  assert.deepEqual(
    s.audit.entries.map((e) => [e.seq, e.target, e.canaryHit]),
    [
      [9, 'ap1', false],
      [10, '(text)', true],
    ],
  );
  assert.equal(s.audit.headHash, 'f'.repeat(64));
});
